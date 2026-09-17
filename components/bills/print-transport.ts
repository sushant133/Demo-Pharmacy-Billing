"use client";

import { isNativeApp } from "@/lib/native";
import { canUseBluetoothPrinter, printViaBluetooth } from "@/components/bills/print-bluetooth";

/**
 * One printing API for both shells.
 *
 * Browser: Web Bluetooth for the roll, `window.print()` for the system sheet.
 * Android app: the BLE plugin for the roll, and a bridge to Android's
 * PrintManager for the sheet - the WebView implements neither of the web
 * APIs, so calling them there fails silently, which on a till looks exactly
 * like a printer that has stopped working.
 */

interface SystemPrintPlugin {
  print: (options: { name: string }) => Promise<void>;
}

function systemPrintPlugin(): SystemPrintPlugin | undefined {
  if (typeof window === "undefined") return undefined;
  const plugins = (window as Window & { Capacitor?: { Plugins?: Record<string, unknown> } })
    .Capacitor?.Plugins;
  return plugins?.SystemPrint as SystemPrintPlugin | undefined;
}

/** Is a direct-to-roll Bluetooth printer reachable from here at all? */
export function canPrintToRoll(): boolean {
  return isNativeApp() ? true : canUseBluetoothPrinter();
}

/** Send raw ESC/POS bytes straight to an 80mm roll. */
export async function printToRoll(bytes: Uint8Array): Promise<void> {
  if (isNativeApp()) {
    const { printViaNativeBluetooth } = await import(
      "@/components/bills/print-bluetooth-native"
    );
    return printViaNativeBluetooth(bytes);
  }
  return printViaBluetooth(bytes);
}

/**
 * Open the system print sheet for the page as rendered.
 *
 * Returns false when there was no way to raise a sheet, so the caller can say
 * so instead of leaving the cashier waiting on paper that will never come.
 */
export function openPrintSheet(documentName: string): boolean {
  if (isNativeApp()) {
    const plugin = systemPrintPlugin();
    if (!plugin) return false;
    void plugin.print({ name: documentName });
    return true;
  }
  window.print();
  return true;
}
