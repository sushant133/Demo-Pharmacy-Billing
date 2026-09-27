"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { isNativeApp } from "@/lib/native";

/**
 * Switches on stock/expiry notifications in the Android app.
 *
 * The checking itself is native (AlertNotifyPlugin + AlertCheckWorker), since
 * the WebView's JavaScript stops running once the app is in the background.
 * This asks the plugin to start once a user who can see alerts is signed in,
 * binding the device to that account, and - while the app is on screen -
 * shows new alerts as an in-page popup instead of a system banner. In a
 * browser, or an older APK without the plugin, it does nothing.
 */

interface PluginListenerHandle {
  remove: () => Promise<void>;
}

export interface AlertsEvent {
  total: number;
  title: string;
  body: string;
  path: string;
}

interface AlertNotifyPlugin {
  enable: (options: { accountKey: string }) => Promise<{ granted: boolean }>;
  disable: () => Promise<void>;
  checkNow?: () => Promise<void>;
  consumePendingOpen?: () => Promise<{ path?: string | null }>;
  /**
   * Read straight off `window.Capacitor.Plugins`, this is the native bridge's
   * own addListener, which returns the handle itself - not a promise, as the
   * `@capacitor/core` wrapper does. Always go through `listen()`.
   */
  addListener?: (
    event: "alerts" | "open",
    handler: (data: AlertsEvent & { path: string }) => void,
  ) => PluginListenerHandle | Promise<PluginListenerHandle>;
}

/**
 * Subscribe to a plugin event whichever shape addListener returns. Never
 * throws: a notification listener must not be able to take a screen down.
 */
export function listen(
  plugin: AlertNotifyPlugin,
  event: "alerts" | "open",
  handler: (data: AlertsEvent & { path: string }) => void,
): Promise<PluginListenerHandle | null> {
  try {
    if (!plugin.addListener) return Promise.resolve(null);
    return Promise.resolve(plugin.addListener(event, handler)).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

export function alertNotifyPlugin(): AlertNotifyPlugin | undefined {
  if (typeof window === "undefined" || !isNativeApp()) return undefined;
  const plugins = (window as Window & { Capacitor?: { Plugins?: Record<string, unknown> } })
    .Capacitor?.Plugins;
  return plugins?.AlertNotify as AlertNotifyPlugin | undefined;
}

/** Called on sign-out so a shared till stops showing the last user's alerts. */
export async function disableAlertNotifications(): Promise<void> {
  try {
    await alertNotifyPlugin()?.disable();
  } catch {
    // Never let this hold up signing out; the worker clears itself on a 401.
  }
}

/** While on screen, look again this often rather than waiting on WorkManager's 15 minutes. */
const FOREGROUND_CHECK_MS = 5 * 60 * 1000;
/** How long the in-page popup stays before tucking itself away. */
const POPUP_MS = 10_000;

export function AlertNotifications({ accountKey }: { accountKey: string }) {
  const router = useRouter();
  const [popup, setPopup] = useState<AlertsEvent | null>(null);

  useEffect(() => {
    const plugin = alertNotifyPlugin();
    if (!plugin) return;

    let cancelled = false;
    const cleanups: Array<() => void> = [];

    // Notifications are a convenience; the Alerts screen still works without them.
    void Promise.resolve()
      .then(() => plugin.enable({ accountKey }))
      .catch(() => {});

    // An older APK never sends this event; enable() alone keeps its 15-minute schedule.
    void listen(plugin, "alerts", (data) => setPopup(data)).then((handle) => {
      if (!handle) return;
      if (cancelled) void handle.remove();
      else cleanups.push(() => void handle.remove());
    });

    // Older APKs have no checkNow at all.
    if (typeof plugin.checkNow === "function") {
      const check = () => {
        if (document.visibilityState !== "visible") return;
        void Promise.resolve()
          .then(() => plugin.checkNow?.())
          .catch(() => {});
      };
      const timer = window.setInterval(check, FOREGROUND_CHECK_MS);
      document.addEventListener("visibilitychange", check);
      cleanups.push(() => {
        window.clearInterval(timer);
        document.removeEventListener("visibilitychange", check);
      });
    }

    return () => {
      cancelled = true;
      for (const cleanup of cleanups) cleanup();
    };
  }, [accountKey]);

  useEffect(() => {
    if (!popup) return;
    const timer = window.setTimeout(() => setPopup(null), POPUP_MS);
    return () => window.clearTimeout(timer);
  }, [popup]);

  if (!popup) return null;

  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-[80] flex justify-center px-3 pt-[calc(0.75rem+var(--safe-top))] print:hidden"
    >
      <div className="flex w-full max-w-md items-start gap-3 rounded-2xl border border-amber-200 bg-white p-4 shadow-xl">
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-600"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.9}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2a2 2 0 01-.6 1.4L4 17h5m6 0a3 3 0 11-6 0"
            />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-900">{popup.title}</p>
          <p className="mt-0.5 text-xs text-slate-600">{popup.body}</p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => {
                const path = popup.path;
                setPopup(null);
                router.push(path);
              }}
              className="btn-primary px-3 py-1.5 text-xs"
            >
              View alerts
            </button>
            <button
              type="button"
              onClick={() => setPopup(null)}
              className="btn-secondary px-3 py-1.5 text-xs"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
