/**
 * Small rules about requests and idle time, shared by middleware and the browser.
 *
 * Kept free of Node-only imports, because middleware runs on the Edge runtime
 * and a client component imports this too.
 */

/**
 * Requests that happen on their own, without anyone at the keyboard. They must
 * not count as activity, or a phone left on the counter would never sign out.
 */
export const BACKGROUND_PATHS = ["/api/reports/alerts", "/api/auth/me"];

/**
 * Whether the idle limit applies to this request.
 *
 * Android's background alert check runs every 15 minutes with nobody there, so
 * it outlives the idle limit by design. It treats a 401 as "the till has changed
 * hands" and removes its own schedule, so answering it with one would stop expiry
 * and low-stock notifications for anyone who put their phone down for half an
 * hour. It still stops when the session itself ends, and it never extends it.
 */
export function idleLimitApplies(pathname: string): boolean {
  return pathname !== "/api/reports/alerts";
}

/**
 * The only writes a read-only auditor may make: leaving, replacing their own
 * password, printing a copy (which is counted on the bill, as it should be), and
 * the POSTs that change nothing on record: the idle heartbeat, the alert check
 * and which branch they are looking at.
 */
export function auditorMayWrite(pathname: string): boolean {
  return (
    pathname === "/api/auth/logout" ||
    pathname === "/api/auth/change-password" ||
    pathname === "/api/auth/activity" ||
    pathname === "/api/reports/alerts" ||
    pathname === "/api/branches/scope" ||
    /^\/api\/sales\/[^/]+\/print$/.test(pathname)
  );
}

/** Where tabs share the time of the last keypress or click. */
export const LAST_ACTIVITY_KEY = "mp_last_activity";

/** Longest a tab waits before telling the other tabs it is in use. */
const SHARE_ACTIVITY_MS = 5_000;

export function shouldShareActivity(now: number, lastShared: number): boolean {
  return now - lastShared >= SHARE_ACTIVITY_MS;
}

/**
 * Whether this browser has been idle past the limit.
 *
 * Idle means no tab has been touched. The session cookie is shared by every tab,
 * so judging by one tab alone would let a forgotten reports tab sign out a
 * cashier who is halfway through a bill in another.
 */
export function browserIsIdle(
  now: number,
  thisTab: number,
  otherTabs: number | null,
  limitMs: number,
): boolean {
  return now - Math.max(thisTab, otherTabs ?? 0) >= limitMs;
}

/** Longest gap between "still here" pings: a few per idle period, and never over five minutes. */
export function heartbeatMs(timeoutSeconds: number): number {
  return Math.min(5 * 60 * 1000, (timeoutSeconds * 1000) / 3);
}
