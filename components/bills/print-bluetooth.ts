"use client";

/**
 * Send ESC/POS bytes to a Bluetooth thermal printer from a phone (Chrome on
 * Android). iOS has no Web Bluetooth; those shops use the system Print sheet
 * with an AirPrint or Wi-Fi printer.
 */

import { PRINTER_SERVICES } from "@/components/bills/printer-uuids";

type GattChar = {
  properties: { write?: boolean; writeWithoutResponse?: boolean };
  writeValueWithoutResponse?: (data: BufferSource) => Promise<void>;
  writeValue: (data: BufferSource) => Promise<void>;
};

type GattService = {
  getCharacteristics: () => Promise<GattChar[]>;
};

type GattServer = {
  getPrimaryServices: () => Promise<GattService[]>;
  getPrimaryService: (uuid: string) => Promise<GattService>;
};

type BluetoothDeviceLite = {
  gatt?: { connect: () => Promise<GattServer> };
};

export function canUseBluetoothPrinter(): boolean {
  return typeof navigator !== "undefined" && "bluetooth" in navigator;
}

async function findWriter(server: GattServer): Promise<GattChar | null> {
  const tryService = async (service: GattService) => {
    const chars = await service.getCharacteristics();
    return (
      chars.find((char) => char.properties.writeWithoutResponse || char.properties.write) ??
      null
    );
  };

  try {
    const services = await server.getPrimaryServices();
    for (const service of services) {
      const writer = await tryService(service);
      if (writer) return writer;
    }
  } catch {
    // Some stacks only allow services listed in the request.
  }

  for (const uuid of PRINTER_SERVICES) {
    try {
      const service = await server.getPrimaryService(uuid);
      const writer = await tryService(service);
      if (writer) return writer;
    } catch {
      // Try the next known printer UUID.
    }
  }
  return null;
}

async function writeChunks(writer: GattChar, bytes: Uint8Array) {
  const chunk = 100;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.slice(i, i + chunk);
    if (writer.properties.writeWithoutResponse && writer.writeValueWithoutResponse) {
      await writer.writeValueWithoutResponse(slice);
    } else {
      await writer.writeValue(slice);
    }
  }
}

export async function printViaBluetooth(bytes: Uint8Array): Promise<void> {
  const bluetooth = (
    navigator as Navigator & {
      bluetooth?: {
        requestDevice: (options: unknown) => Promise<BluetoothDeviceLite>;
      };
    }
  ).bluetooth;
  if (!bluetooth) {
    throw new Error("This browser cannot talk to a Bluetooth printer. Use Print instead.");
  }

  const device = await bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: PRINTER_SERVICES,
  });
  if (!device.gatt) {
    throw new Error("That device has no Bluetooth printer port.");
  }

  const server = await device.gatt.connect();
  const writer = await findWriter(server);
  if (!writer) {
    throw new Error(
      "Connected, but this printer did not offer a write characteristic. Use Print and pick it in the system sheet.",
    );
  }
  await writeChunks(writer, bytes);
}
