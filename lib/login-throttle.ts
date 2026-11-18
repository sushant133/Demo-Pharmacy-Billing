/**
 * Sign-in throttling.
 *
 * Two layers, because each covers what the other cannot:
 *
 *  - Per account, stored on the User row: after MAX_FAILURES consecutive wrong
 *    passwords the account refuses every attempt (right password included)
 *    for LOCK_MINUTES. Stored in Mongo so it holds across server instances and
 *    restarts, which is what makes it a real limit on guessing one password.
 *  - Per IP, in memory: caps how many attempts one address can make across
 *    many accounts. Best effort only - it resets on restart and is per
 *    instance - but it blunts a spray across every email for free.
 */

export const MAX_FAILURES = 5;
export const LOCK_MINUTES = 15;

const IP_WINDOW_MS = 10 * 60 * 1000;
const IP_MAX_ATTEMPTS = 30;

/** True while an account is locked out. */
export function isLocked(lockedUntil: Date | null | undefined, now = new Date()): boolean {
  return lockedUntil != null && lockedUntil.getTime() > now.getTime();
}

/** Whole minutes left on a lock, at least 1. */
export function minutesLeft(lockedUntil: Date, now = new Date()): number {
  return Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 60000));
}

/** The fields to write after one more wrong password. */
export function afterFailure(
  previousFailures: number,
  now = new Date(),
): { failedLoginCount: number; lockedUntil: Date | null } {
  const count = previousFailures + 1;
  if (count >= MAX_FAILURES) {
    // The counter restarts so the next lock needs another full run of misses.
    return { failedLoginCount: 0, lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60000) };
  }
  return { failedLoginCount: count, lockedUntil: null };
}

const attemptsByIp = new Map<string, number[]>();

/** Records one attempt from `ip`; false when that address is over its limit. */
export function allowIpAttempt(ip: string, now = Date.now()): boolean {
  if (!ip) return true;
  const recent = (attemptsByIp.get(ip) ?? []).filter((at) => now - at < IP_WINDOW_MS);
  if (recent.length >= IP_MAX_ATTEMPTS) {
    attemptsByIp.set(ip, recent);
    return false;
  }
  recent.push(now);
  attemptsByIp.set(ip, recent);
  // Keep the map from growing without bound on a long-lived instance.
  if (attemptsByIp.size > 5000) {
    for (const [key, times] of attemptsByIp) {
      if (times.every((at) => now - at >= IP_WINDOW_MS)) attemptsByIp.delete(key);
    }
  }
  return true;
}
