/**
 * GATT service UUIDs used by common 80mm ESC/POS roll printers.
 *
 * Shared by both transports: Web Bluetooth in a mobile browser and the native
 * BLE plugin inside the Android app. Android requires every service the app
 * may touch to be declared up front, so this list is also what gets passed as
 * `optionalServices` when the device picker opens.
 */
export const PRINTER_SERVICES = [
  "000018f0-0000-1000-8000-00805f9b34fb",
  "0000ff00-0000-1000-8000-00805f9b34fb",
  "0000ae30-0000-1000-8000-00805f9b34fb",
  "e7810a71-73ae-499d-8c15-faa9aef0c3f2",
  "49535343-fe7d-4ae5-8fa9-9fafd205e455",
];
