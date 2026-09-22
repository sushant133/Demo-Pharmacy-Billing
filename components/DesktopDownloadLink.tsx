"use client";

import { useEffect, useState } from "react";
import { DESKTOP_RELEASE } from "@/lib/desktop-release";
import { isNativeApp } from "@/lib/native";

/**
 * "Download the desktop app", for people signing in from a Windows browser.
 *
 * Decided after mount because only the browser knows: hidden inside the
 * desktop app itself (its preload script sets `window.mantramedDesktop`),
 * inside the Android app, and on anything that is not Windows, where the
 * installer would not run.
 */
export function DesktopDownloadLink() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const inDesktopApp = "mantramedDesktop" in window;
    const onWindows = /Windows/i.test(navigator.userAgent);
    setShow(onWindows && !inDesktopApp && !isNativeApp());
  }, []);

  if (!show) return null;

  return (
    <a
      href={DESKTOP_RELEASE.windowsUrl}
      className="mt-4 flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:border-brand-300 hover:text-brand-700"
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
      Download the desktop app for Windows
    </a>
  );
}
