"use client";

import { useEffect, useState } from "react";
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
 *   1. Hide the splash once the remote page is actually up.
 *   2. Make the hardware back button walk history instead of killing the app.
 *   3. Compare the installed build against /android-app-version.json and
 *      prompt when the till is behind.
 */

interface Release {
  versionCode: number;
  versionName: string;
  minimumVersionCode: number;
  storeUrl: string;
  notes?: string;
}

type UpdateState = { release: Release; forced: boolean } | null;

export function CapacitorBoot() {
  const [update, setUpdate] = useState<UpdateState>(null);

  useEffect(() => {
    if (!isNativeApp()) return;

    let cancelled = false;
    let removeBackButton: (() => void) | undefined;

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
      removeBackButton = () => void handle.remove();
    }

    async function checkVersion() {
      const { App } = await import("@capacitor/app");
      const info = await App.getInfo();
      // Android reports versionCode as `build`.
      const installed = Number(info.build);
      if (!Number.isFinite(installed)) return;

      const response = await fetch("/android-app-version.json", { cache: "no-store" });
      if (!response.ok) return;

      const release = (await response.json()) as Release;
      if (cancelled || installed >= release.versionCode) return;

      setUpdate({ release, forced: installed < release.minimumVersionCode });
    }

    // Each is independent: a failed version check must not leave the splash up
    // or the back button unowned.
    void hideSplash().catch(() => {});
    void ownBackButton().catch(() => {});
    void checkVersion().catch(() => {
      // A version check is never worth blocking the counter over.
    });

    return () => {
      cancelled = true;
      removeBackButton?.();
    };
  }, []);

  if (!update) return null;

  const { release, forced } = update;

  // Capacitor sends navigations outside `server.url` to the system browser,
  // and Android hands a Play URL to the Play app.
  const openStore = () => window.open(release.storeUrl, "_blank");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-title"
      className="fixed inset-0 z-[100] flex items-end justify-center bg-slate-900/50 p-4 sm:items-center"
    >
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
        <h2 id="update-title" className="text-base font-semibold text-slate-900">
          {forced ? "Update required" : "Update available"}
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Version {release.versionName} is ready.{" "}
          {forced
            ? "This version is needed to keep billing in step with the server."
            : "You can keep working and update later."}
        </p>
        {release.notes ? (
          <p className="mt-2 text-xs text-slate-500">{release.notes}</p>
        ) : null}
        <div className="mt-4 flex gap-2">
          {forced ? null : (
            <button
              type="button"
              onClick={() => setUpdate(null)}
              className="btn-secondary w-full"
            >
              Later
            </button>
          )}
          <button type="button" onClick={openStore} className="btn-primary w-full">
            Update
          </button>
        </div>
      </div>
    </div>
  );
}
