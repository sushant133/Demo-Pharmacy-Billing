"use client";

import { useEffect, useRef } from "react";
import {
  LAST_ACTIVITY_KEY,
  browserIsIdle,
  heartbeatMs,
  shouldShareActivity,
} from "@/lib/request-rules";

const EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

/** Storage can be blocked, as in some private windows. This tab then judges alone. */
function readSharedActivity(): number | null {
  try {
    const value = Number(window.localStorage.getItem(LAST_ACTIVITY_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function shareActivity(now: number): void {
  try {
    window.localStorage.setItem(LAST_ACTIVITY_KEY, String(now));
  } catch {
    // See readSharedActivity.
  }
}

/**
 * Signs the user out after a stretch with no keyboard, mouse or touch in any tab.
 *
 * Middleware enforces the same limit on the next request, but a screen left
 * open shows whatever it last loaded - a till's takings, a customer's dues -
 * to whoever walks up. This clears it from the browser side as well.
 *
 * While someone is working it also pings the server now and then, so a long
 * form filled in without a single request does not find the session gone the
 * moment it is submitted.
 */
export function IdleSignOut({ timeoutSeconds }: { timeoutSeconds: number }) {
  const lastActivity = useRef(Date.now());
  const lastHeartbeat = useRef(Date.now());
  const lastShared = useRef(0);

  useEffect(() => {
    if (!timeoutSeconds || timeoutSeconds <= 0) return;
    const limitMs = timeoutSeconds * 1000;
    const pingEvery = heartbeatMs(timeoutSeconds);

    const onActivity = () => {
      const now = Date.now();
      lastActivity.current = now;
      if (shouldShareActivity(now, lastShared.current)) {
        lastShared.current = now;
        shareActivity(now);
      }
      if (now - lastHeartbeat.current > pingEvery) {
        lastHeartbeat.current = now;
        void fetch("/api/auth/activity", { method: "POST" }).catch(() => {});
      }
    };

    const check = () => {
      if (!browserIsIdle(Date.now(), lastActivity.current, readSharedActivity(), limitMs)) return;
      window.clearInterval(timer);
      const next = window.location.pathname + window.location.search;
      void fetch("/api/auth/logout", { method: "POST" })
        .catch(() => {})
        .finally(() => {
          window.location.href = `/login?expired=1&next=${encodeURIComponent(next)}`;
        });
    };

    // A tab opened during a session counts as somebody being here.
    shareActivity(lastActivity.current);

    for (const event of EVENTS) {
      window.addEventListener(event, onActivity, { passive: true });
    }
    // A phone that slept through the limit is checked the moment it wakes.
    document.addEventListener("visibilitychange", check);
    const timer = window.setInterval(check, 15_000);

    return () => {
      for (const event of EVENTS) window.removeEventListener(event, onActivity);
      document.removeEventListener("visibilitychange", check);
      window.clearInterval(timer);
    };
  }, [timeoutSeconds]);

  return null;
}
