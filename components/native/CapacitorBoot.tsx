"use client";

import { useEffect, useRef, useState } from "react";
import { isNativeApp } from "@/lib/native";

/**
 * Everything the Android shell needs on launch, and nothing the web needs.
 *
 * Mounted from the root layout. On the web every branch below short-circuits
 * on `isNativeApp()` and the component renders null, so the browser build is
 * unaffected and the Capacitor packages are never even fetched - each one is
 * behind a dynamic import.
 *
 * Three jobs:
 *   1. Hide the splash once the remote page is actually up. (The inline
 *      script in app/layout.tsx usually beats this to it; this is the
 *      fallback.)
 *   2. Make the hardware back button walk history instead of killing the app.
 *   3. Prompt when a newer build is out - checked on launch and again every
 *      time the app comes back to the foreground, because a till is opened
 *      once in the morning and left running all day.
 */

interface Release {
  versionCode: number;
  versionName: string;
  minimumVersionCode: number;
  storeUrl: string;
  notes?: string;
}

interface UpdatePrompt {
  /** Null when only Play knows about the build (no server manifest ahead). */
  release: Release | null;
  forced: boolean;
  /** Play reports the update and allows the in-app, no-store-trip flow. */
  inApp: boolean;
}

/** Enough to tell a till left open over lunch that something shipped. */
const RECHECK_AFTER_MS = 10 * 60 * 1000;

/** Play's `AppUpdateAvailability.UPDATE_AVAILABLE`. */
const PLAY_UPDATE_AVAILABLE = 2;
/** Play's `AppUpdateResultCode.OK`. */
const PLAY_RESULT_OK = 0;

/**
 * What Play says about this install.
 *
 * Play is the source of truth for "is there a newer build for this device",
 * with no version file to keep in step. It only answers for an install that
 * came from Play (a sideloaded APK gets UNKNOWN), and builds older than the
 * one that added the plugin reject the call - both are treated as "Play
 * doesn't know" and the server manifest decides alone.
 */
async function playUpdate(): Promise<{ available: boolean; inApp: boolean }> {
  try {
    const { AppUpdate } = await import("@capawesome/capacitor-app-update");
    const info = await AppUpdate.getAppUpdateInfo();
    const available = info.updateAvailability === PLAY_UPDATE_AVAILABLE;
    return { available, inApp: available && info.immediateUpdateAllowed === true };
  } catch {
    return { available: false, inApp: false };
  }
}

/**
 * The server's own manifest, /android-app-version.json (lib/android-release.ts).
 * It is what can *force* an update, via `minimumVersionCode`, and it works
 * for installs Play cannot see.
 */
async function manifestUpdate(): Promise<{ release: Release; installed: number } | null> {
  const { App } = await import("@capacitor/app");
  const info = await App.getInfo();
  // Android reports versionCode as `build`.
  const installed = Number(info.build);
  if (!Number.isFinite(installed)) return null;

  const response = await fetch("/android-app-version.json", { cache: "no-store" });
  if (!response.ok) return null;

  return { release: (await response.json()) as Release, installed };
}

export function CapacitorBoot() {
  const [update, setUpdate] = useState<UpdatePrompt | null>(null);
  const [updating, setUpdating] = useState(false);
  // "Later" holds for the rest of this run of the app, not just this check -
  // otherwise every return to the foreground would nag again.
  const dismissed = useRef(false);

  useEffect(() => {
    if (!isNativeApp()) return;

    let cancelled = false;
    let lastCheck = 0;
    const cleanups: Array<() => void> = [];

    async function hideSplash() {
      const { SplashScreen } = await import("@capacitor/splash-screen");
      await SplashScreen.hide();
    }

    async function ownBackButton() {
      const { App } = await import("@capacitor/app");
      // Without this the back button closes the app from any screen, which on
      // a till means losing a half-entered sale.
      const handle = await App.addListener("backButton", ({ canGoBack }) => {
        if (canGoBack) {
          window.history.back();
        } else {
          void App.exitApp();
        }
      });
      if (cancelled) {
        void handle.remove();
        return;
      }
      cleanups.push(() => void handle.remove());
    }

    async function checkForUpdate() {
      lastCheck = Date.now();

      const [play, manifest] = await Promise.all([
        playUpdate(),
        manifestUpdate().catch(() => null),
      ]);
      if (cancelled) return;

      const manifestAhead =
        manifest !== null && manifest.installed < manifest.release.versionCode;
      const forced =
        manifest !== null && manifest.installed < manifest.release.minimumVersionCode;

      if (!play.available && !manifestAhead) return;
      if (dismissed.current && !forced) return;

      setUpdate({
        release: manifestAhead ? manifest.release : null,
        forced,
        inApp: play.inApp,
      });
    }

    async function recheckOnResume() {
      const { App } = await import("@capacitor/app");
      const handle = await App.addListener("resume", () => {
        if (Date.now() - lastCheck < RECHECK_AFTER_MS) return;
        void checkForUpdate().catch(() => {});
      });
      if (cancelled) {
        void handle.remove();
        return;
      }
      cleanups.push(() => void handle.remove());
    }

    // Each is independent: a failed version check must not leave the splash up
    // or the back button unowned.
    void hideSplash().catch(() => {});
    void ownBackButton().catch(() => {});
    void checkForUpdate().catch(() => {
      // A version check is never worth blocking the counter over.
    });
    void recheckOnResume().catch(() => {});

    return () => {
      cancelled = true;
      for (const cleanup of cleanups) cleanup();
    };
  }, []);

  if (!update) return null;

  const { release, forced, inApp } = update;

  async function startUpdate() {
    setUpdating(true);
    try {
      if (inApp) {
        // Play's own full-screen flow: downloads, installs and restarts the
        // app without a trip to the store listing.
        const { AppUpdate } = await import("@capawesome/capacitor-app-update");
        const result = await AppUpdate.performImmediateUpdate();
        if (result.code === PLAY_RESULT_OK) return;
      }
      await openStore();
    } catch {
      await openStore();
    } finally {
      setUpdating(false);
    }
  }

  async function openStore() {
    try {
      const { AppUpdate } = await import("@capawesome/capacitor-app-update");
      await AppUpdate.openAppStore();
    } catch {
      // Builds without the plugin: Capacitor sends navigations outside
      // `server.url` to the system browser, and Android hands a Play URL to
      // the Play app.
      window.open(
        release?.storeUrl ?? "https://play.google.com/store/apps/details?id=tech.mantramed",
        "_blank",
      );
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-title"
      className="fixed inset-0 z-[100] flex items-end justify-center bg-slate-900/50 p-4 pb-[calc(1rem+var(--safe-bottom))] sm:items-center"
    >
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.9}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"
              />
            </svg>
          </span>
          <div className="min-w-0">
            <h2 id="update-title" className="text-base font-semibold text-slate-900">
              {forced ? "Update required" : "Update available"}
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              {release
                ? `Version ${release.versionName} of MantraMed is ready.`
                : "A new version of MantraMed is ready."}{" "}
              {forced
                ? "This version is needed to keep billing in step with the server."
                : "You can keep working and update later."}
            </p>
            {release?.notes ? (
              <p className="mt-2 text-xs text-slate-500">{release.notes}</p>
            ) : null}
          </div>
        </div>
        <div className="mt-4 flex gap-2">
          {forced ? null : (
            <button
              type="button"
              onClick={() => {
                dismissed.current = true;
                setUpdate(null);
              }}
              className="btn-secondary w-full"
            >
              Later
            </button>
          )}
          <button
            type="button"
            onClick={() => void startUpdate()}
            disabled={updating}
            className="btn-primary w-full"
          >
            {updating ? "Opening…" : "Update now"}
          </button>
        </div>
      </div>
    </div>
  );
}
