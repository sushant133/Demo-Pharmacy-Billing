/**
 * Short-lived in-process cache with in-flight de-duplication.
 *
 * Dashboard and alerts re-run the same sale aggregations on every navigation.
 * Holding the result for a few seconds means clicking between sections does
 * not wait on Mongo twice, while still staying fresh enough for a live till.
 */

type Entry<T> = {
  at: number;
  value?: T;
  inflight?: Promise<T>;
};

const store = new Map<string, Entry<unknown>>();

export async function onceTtl<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;

  if (hit?.value !== undefined && now - hit.at < ttlMs) return hit.value;
  if (hit?.inflight) return hit.inflight;

  const inflight = fn()
    .then((value) => {
      store.set(key, { at: Date.now(), value });
      return value;
    })
    .catch((error: unknown) => {
      store.delete(key);
      throw error;
    });

  store.set(key, { at: 0, inflight });
  return inflight;
}

export function scopeCacheKey(
  scope?: { code?: string | null; branchId?: unknown; pharmacyId?: unknown } | null,
): string {
  const pharmacy =
    scope && "pharmacyId" in scope && scope.pharmacyId
      ? String(scope.pharmacyId)
      : "none";
  if (!scope) return `${pharmacy}:all`;
  if (scope.code) return `${pharmacy}:${scope.code}`;
  if (scope.branchId) return `${pharmacy}:${String(scope.branchId)}`;
  return `${pharmacy}:all`;
}

/**
 * Drop a cached entry so the next read goes back to the source.
 *
 * Used after a write that the user expects to see immediately - saving the
 * shop's details and finding the old PAN still on the next bill would be a
 * bug, not a cache. Only clears this process: another Node worker keeps its
 * copy until the TTL expires, which is why the TTLs here stay short.
 */
export function invalidateTtl(key: string): void {
  store.delete(key);
}
