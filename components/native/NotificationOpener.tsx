"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BrandLoading } from "@/components/BrandLoading";
import { alertNotifyPlugin } from "@/components/native/AlertNotifications";

/**
 * Opens the screen a tapped notification points at.
 *
 * Mounted from the root layout, so it is listening whether or not anyone is
 * signed in. Navigation is client-side - the WebView is never reloaded, which
 * is what used to leave a white screen - and the MantraMed logo covers the
 * page until the target screen is up. Two ways in:
 *   - a warm app: the plugin's `open` event;
 *   - a cold start from the notification: the tap happened before this page
 *     existed, so the path is collected with `consumePendingOpen()`.
 */

/** Never leave the logo up for good if the navigation stalls. */
const OVERLAY_CEILING_MS = 10_000;

/** Same-origin app paths only. */
function isAppPath(path: unknown): path is string {
  return typeof path === "string" && path.startsWith("/") && !path.startsWith("//");
}

export function NotificationOpener() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = `${pathname}${searchParams.size ? `?${searchParams.toString()}` : ""}`;

  // Where we were when the tap came in; the overlay lifts once that changes.
  const [openingFrom, setOpeningFrom] = useState<string | null>(null);
  const currentRef = useRef(current);
  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  useEffect(() => {
    const plugin = alertNotifyPlugin();
    if (!plugin?.addListener || !plugin.consumePendingOpen) return;

    let cancelled = false;
    let handle: { remove: () => Promise<void> } | null = null;

    function open(path: unknown) {
      if (cancelled || !isAppPath(path)) return;
      if (path === currentRef.current) {
        // Already there: fetch fresh counts rather than showing a stale list.
        router.refresh();
        return;
      }
      setOpeningFrom(currentRef.current);
      router.push(path);
    }

    // Listen first, then collect: a tap landing between the two is still caught.
    void plugin
      .addListener("open", (data) => open(data.path))
      .then((h) => {
        if (cancelled) void h.remove();
        else handle = h;
        return plugin.consumePendingOpen?.();
      })
      .then((pending) => open(pending?.path))
      .catch(() => {});

    return () => {
      cancelled = true;
      void handle?.remove();
    };
  }, [router]);

  useEffect(() => {
    if (openingFrom !== null && current !== openingFrom) setOpeningFrom(null);
  }, [current, openingFrom]);

  useEffect(() => {
    if (openingFrom === null) return;
    const timer = window.setTimeout(() => setOpeningFrom(null), OVERLAY_CEILING_MS);
    return () => window.clearTimeout(timer);
  }, [openingFrom]);

  return openingFrom !== null ? <BrandLoading overlay /> : null;
}
