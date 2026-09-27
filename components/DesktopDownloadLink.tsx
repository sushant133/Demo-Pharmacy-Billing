"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { isNativeApp } from "@/lib/native";
import {
  alreadyInstalled,
  installState,
  promptInstall,
  runningInstalled,
  subscribeInstall,
  type InstallState,
} from "@/lib/pwa-install";

/**
 * "Install the desktop app", for people signing in from a Windows browser.
 *
 * Opens the browser's own install dialog - the same one as the Install icon
 * in Chrome's or Edge's address bar - which installs MantraMed with its name
 * and icon from the manifest, a Start-menu and desktop entry, and its own
 * window. Nothing is downloaded and there is no installer to run.
 *
 * Decided after mount because only the browser knows: hidden inside the
 * Electron desktop app (its preload script sets `window.mantramedDesktop`),
 * inside the Android app, in the installed app's own window, and on anything
 * that is not Windows.
 */
export function DesktopDownloadLink() {
  const [show, setShow] = useState(false);
  const [installedHere, setInstalledHere] = useState(false);
  const [help, setHelp] = useState(false);
  const [busy, setBusy] = useState(false);

  const state = useSyncExternalStore<InstallState>(
    subscribeInstall,
    installState,
    () => "unavailable",
  );

  useEffect(() => {
    const inDesktopApp = "mantramedDesktop" in window;
    const onWindows = /Windows/i.test(navigator.userAgent);
    setShow(onWindows && !inDesktopApp && !isNativeApp() && !runningInstalled());
    void alreadyInstalled().then(setInstalledHere);
  }, []);

  if (!show) return null;

  if (state === "installed" || (installedHere && state !== "ready")) {
    return (
      <p className="mt-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-2.5 text-center text-sm text-brand-800">
        MantraMed is installed on this computer. Open it from the Start menu or
        the desktop shortcut.
      </p>
    );
  }

  async function install() {
    if (state !== "ready") {
      // Firefox, or Chrome/Edge before the site has qualified: say how.
      setHelp(true);
      return;
    }
    setBusy(true);
    try {
      const outcome = await promptInstall();
      if (outcome === "unavailable") setHelp(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={() => void install()}
        disabled={busy}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:border-brand-300 hover:text-brand-700 disabled:opacity-60"
      >
        <svg
          className="h-4 w-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14" />
        </svg>
        {busy ? "Opening installer…" : "Install the desktop app for Windows"}
      </button>

      {help ? (
        <p role="status" className="mt-2 text-center text-xs leading-relaxed text-slate-500">
          Open this page in <span className="font-medium text-slate-700">Chrome</span> or{" "}
          <span className="font-medium text-slate-700">Edge</span> and click the{" "}
          <span className="font-medium text-slate-700">Install</span> icon at the right of
          the address bar - or the browser menu &rarr;{" "}
          <span className="font-medium text-slate-700">Install MantraMed</span>. If it is
          already installed, open MantraMed from the Start menu.
        </p>
      ) : null}
    </div>
  );
}
