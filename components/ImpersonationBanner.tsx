"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/client";

/**
 * "A platform administrator is in this shop."
 *
 * Sticky, above everything, and not dismissible. That is the deal that makes
 * impersonation acceptable at all: support can see exactly what the owner
 * sees, and the shop can see that support is there. A banner somebody can
 * close is a banner that is closed thirty seconds in.
 *
 * It is also the way out, so it renders on every screen the session can
 * reach - there is no platform sidebar while the session belongs to the shop.
 */
export function ImpersonationBanner({
  platformUser,
  actingAs,
  pharmacyName,
}: {
  platformUser: string;
  actingAs: string;
  pharmacyName: string;
}) {
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function stop() {
    setLeaving(true);
    setError(null);
    const result = await apiFetch<{ next: string }>("/api/auth/stop-impersonation", {
      method: "POST",
    });
    if (!result.ok) {
      setLeaving(false);
      setError(result.message);
      return;
    }
    // Full navigation: the session cookie has just been swapped back.
    window.location.href = result.data.next;
  }

  return (
    <div className="sticky top-0 z-50 bg-rose-700 pt-[var(--safe-top)] pr-[var(--safe-right)] pl-[var(--safe-left)] text-white">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm sm:px-6">
        <p>
          <span className="font-semibold">{platformUser}</span> (platform
          support) is signed in as{" "}
          <span className="font-semibold">{actingAs}</span> at {pharmacyName}.
          Everything done here is recorded.
        </p>
        <div className="flex items-center gap-3">
          {error ? <span className="text-rose-100">{error}</span> : null}
          <button
            type="button"
            onClick={stop}
            disabled={leaving}
            className="rounded-lg bg-white/15 px-3 py-1 font-medium hover:bg-white/25 disabled:opacity-60"
          >
            {leaving ? "Leaving…" : "Return to platform"}
          </button>
        </div>
      </div>
    </div>
  );
}
