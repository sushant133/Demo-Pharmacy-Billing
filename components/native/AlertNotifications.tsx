"use client";

import { useEffect } from "react";
import { isNativeApp } from "@/lib/native";

/**
 * Switches on stock/expiry notifications in the Android app.
 *
 * The checking itself is native (AlertNotifyPlugin + AlertCheckWorker), since
 * the WebView's JavaScript stops running once the app is in the background.
 * This only asks the plugin to start once a user who can see alerts is signed
 * in. In a browser, or an older APK without the plugin, it does nothing.
 */

interface AlertNotifyPlugin {
  enable: () => Promise<{ granted: boolean }>;
  disable: () => Promise<void>;
}

function alertNotifyPlugin(): AlertNotifyPlugin | undefined {
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

export function AlertNotifications() {
  useEffect(() => {
    const plugin = alertNotifyPlugin();
    if (!plugin) return;
    void plugin.enable().catch(() => {
      // Notifications are a convenience; the Alerts screen still works without them.
    });
  }, []);

  return null;
}
