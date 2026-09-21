"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client";

/**
 * Suspend or restore one shop from the list, without opening it.
 *
 * Suspending takes two clicks even here: the first arms it, the second does
 * it. A one-click control in a table row is a control that gets hit while
 * scrolling, and the shop finds out when its counter cannot sign in. Anything
 * with a reason worth recording belongs on the account's own page, which is
 * one click away.
 */
export function PharmacyStatusToggle({
  id,
  name,
  status,
}: {
  id: string;
  name: string;
  status: "active" | "suspended";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go(next: "active" | "suspended") {
    setBusy(true);
    setError(null);
    const result = await apiFetch(
      next === "suspended"
        ? `/api/pharmacies/${id}/suspend`
        : `/api/pharmacies/${id}/activate`,
      { method: "POST", json: {} },
    );
    setBusy(false);
    setArmed(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.refresh();
  }

  if (status === "suspended") {
    return (
      <div className="text-right">
        <button
          type="button"
          disabled={busy}
          onClick={() => go("active")}
          className="text-sm font-medium text-brand-700 hover:text-brand-800 disabled:opacity-50"
        >
          {busy ? "Activating…" : "Activate"}
        </button>
        {error ? <p className="text-xs text-rose-600">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="text-right">
      {armed ? (
        <span className="inline-flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => go("suspended")}
            className="text-sm font-medium text-rose-700 hover:text-rose-800 disabled:opacity-50"
            title={`Suspend ${name}`}
          >
            {busy ? "Suspending…" : "Confirm"}
          </button>
          <button
            type="button"
            onClick={() => setArmed(false)}
            className="text-sm text-slate-500 hover:text-slate-700"
          >
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setArmed(true)}
          className="text-sm font-medium text-slate-600 hover:text-rose-700"
        >
          Suspend
        </button>
      )}
      {error ? <p className="text-xs text-rose-600">{error}</p> : null}
    </div>
  );
}
