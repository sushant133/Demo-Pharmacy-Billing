"use client";

import { useEffect } from "react";
import { isNativeApp } from "@/lib/native";

/**
 * Registers the service worker (public/sw.js) that makes the site installable.
 *
 * Browser production builds only. Skipped in development, where a worker
 * outlives restarts and confuses hot reload; inside the Android app, whose
 * shell has its own offline page; and inside the desktop app, which is
 * already installed.
 */
export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    if (isNativeApp() || "mantramedDesktop" in window) return;

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .catch(() => {
          // Installability is a convenience; the site works the same without it.
        });
    };

    // After load, so registering never competes with the page for bandwidth.
    if (document.readyState === "complete") register();
    else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
