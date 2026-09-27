/**
 * The browser's own "Install app" prompt, held for the sign-in page's
 * install button (components/DesktopDownloadLink.tsx).
 *
 * Chrome and Edge fire `beforeinstallprompt` once, when the site first
 * qualifies - often before any particular component has mounted - and the
 * event can be used to open the install dialog exactly once. So it is caught
 * here, at module load, and kept. This module is imported by PwaRegister in
 * the root layout, which puts the listener on every page from the first
 * hydration.
 *
 * Client-only; every entry point checks for `window`.
 */

export interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export type InstallState =
  /** Nothing from the browser yet: not qualified, already installed, or unsupported. */
  | "unavailable"
  /** The browser will show its install dialog on request. */
  | "ready"
  /** Installed during this visit. */
  | "installed";

let deferred: InstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    // On Windows the sign-in page offers its own button, so hold the
    // browser's banner back there. Elsewhere the browser behaves as before.
    if (/Windows/i.test(navigator.userAgent)) event.preventDefault();
    deferred = event as InstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installed = true;
    emit();
  });
}

export function installState(): InstallState {
  if (installed) return "installed";
  return deferred ? "ready" : "unavailable";
}

export function subscribeInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Open the browser's install dialog. Resolves with what the user chose. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const event = deferred;
  if (!event) return "unavailable";
  // Single use: the browser refuses a second prompt() on the same event.
  deferred = null;
  emit();
  await event.prompt();
  const { outcome } = await event.userChoice;
  if (outcome === "accepted") installed = true;
  emit();
  return outcome;
}

/** Running as the installed app window rather than in a browser tab. */
export function runningInstalled(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.matchMedia?.("(display-mode: minimal-ui)").matches ||
    window.matchMedia?.("(display-mode: window-controls-overlay)").matches
  );
}

/**
 * Whether this computer already has the app installed, where the browser can
 * say (Chrome/Edge, via the manifest's `related_applications`). False when it
 * cannot tell.
 */
export async function alreadyInstalled(): Promise<boolean> {
  try {
    const nav = navigator as Navigator & {
      getInstalledRelatedApps?: () => Promise<Array<{ platform: string }>>;
    };
    if (typeof nav.getInstalledRelatedApps !== "function") return false;
    const apps = await nav.getInstalledRelatedApps();
    return apps.some((app) => app.platform === "webapp");
  } catch {
    return false;
  }
}
