/**
 * Which shell is the UI running in?
 *
 * The same build serves three places: a desktop browser, a phone browser and
 * the Capacitor Android app. A handful of features - printing above all -
 * have to take a different route inside the app, because the Android WebView
 * implements neither `window.print()` nor Web Bluetooth.
 *
 * Read through the injected global rather than importing `@capacitor/core`,
 * so server rendering and the plain web bundle stay untouched.
 */

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

function capacitor(): CapacitorGlobal | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { Capacitor?: CapacitorGlobal }).Capacitor;
}

/** True only inside the Android (or future iOS) app shell. */
export function isNativeApp(): boolean {
  return capacitor()?.isNativePlatform?.() === true;
}

export function nativePlatform(): string {
  return capacitor()?.getPlatform?.() ?? "web";
}
