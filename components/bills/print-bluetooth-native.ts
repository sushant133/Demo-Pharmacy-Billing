"use client";

import { PRINTER_SERVICES } from "@/components/bills/printer-uuids";

/**
 * Send ESC/POS bytes to a Bluetooth printer from inside the Android app.
 *
 * Android's WebView has no Web Bluetooth, so the browser path in
 * `print-bluetooth.ts` cannot work here. This talks to the same class of
 * printer through the native BLE plugin instead; `print-transport.ts` picks
 * between the two at run time.
 *
 * The plugin is imported lazily so the web bundle never pulls it in and
 * server rendering never touches it.
 */

/**
 * BLE writes are capped by the negotiated MTU. 20 bytes is the floor every
 * peripheral supports, and a receipt is only a couple of kilobytes, so we
 * trade a second of speed for working on every printer we might meet.
 */
const CHUNK = 20;

/** Cheap printers drop bytes when the characteristic is hammered. */
const PAUSE_MS = 12;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function printViaNativeBluetooth(bytes: Uint8Array): Promise<void> {
  const { BleClient } = await import("@capacitor-community/bluetooth-le");

  // `androidNeverForLocation` keeps the app off the location permission on
  // Android 12+; a receipt printer is never a beacon we need to place.
  await BleClient.initialize({ androidNeverForLocation: true });

  if (!(await BleClient.isEnabled())) {
    throw new Error("Bluetooth is off. Turn it on and try again.");
  }

  // Opens the system device picker, the same shape of choice the browser
  // dialog offers. Cancelling rejects, which the caller treats as "no error".
  const device = await BleClient.requestDevice({
    optionalServices: PRINTER_SERVICES,
    allowDuplicates: false,
  });

  await BleClient.connect(device.deviceId);
  try {
    const services = await BleClient.getServices(device.deviceId);

    let target: { service: string; characteristic: string; withoutResponse: boolean } | null =
      null;

    for (const service of services) {
      for (const characteristic of service.characteristics) {
        const { write, writeWithoutResponse } = characteristic.properties;
        if (!write && !writeWithoutResponse) continue;
        target = {
          service: service.uuid,
          characteristic: characteristic.uuid,
          withoutResponse: Boolean(writeWithoutResponse),
        };
        // A known printer service outranks whatever else the device exposes.
        if (PRINTER_SERVICES.includes(service.uuid.toLowerCase())) break;
      }
      if (target && PRINTER_SERVICES.includes(target.service.toLowerCase())) break;
    }

    if (!target) {
      throw new Error(
        "Connected, but this printer did not offer a write characteristic. Use Print bill and pick it in the system sheet.",
      );
    }

    for (let i = 0; i < bytes.length; i += CHUNK) {
      // Copy rather than view: a subarray would inherit byteOffset and send
      // the wrong window of the receipt.
      const chunk = bytes.slice(i, i + CHUNK);
      const slice = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      if (target.withoutResponse) {
        await BleClient.writeWithoutResponse(
          device.deviceId,
          target.service,
          target.characteristic,
          slice,
        );
      } else {
        await BleClient.write(device.deviceId, target.service, target.characteristic, slice);
      }
      await wait(PAUSE_MS);
    }
  } finally {
    // Leaving the GATT connection open blocks the next sale's print.
    await BleClient.disconnect(device.deviceId).catch(() => {});
  }
}
