"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client";

export function PharmacyActions({
  id,
  status,
  ownerEmail,
}: {
  id: string;
  status: "active" | "suspended";
  ownerEmail: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [resetDone, setResetDone] = useState(false);

  async function setStatus(next: "active" | "suspended") {
    setBusy(true);
    setError(null);
    const path =
      next === "suspended"
        ? `/api/pharmacies/${id}/suspend`
        : `/api/pharmacies/${id}/activate`;
    const result = await apiFetch(path, { method: "POST" });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.refresh();
  }

  async function resetPassword() {
    setBusy(true);
    setError(null);
    setResetDone(false);
    const result = await apiFetch(`/api/pharmacies/${id}/owner-password`, {
      method: "POST",
      json: { password },
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setPassword("");
    setResetDone(true);
  }

  return (
    <div className="space-y-5">
      {error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-800">
          {error}
        </div>
      ) : null}

      <div className="card space-y-3 p-5">
        <h2 className="text-sm font-semibold text-slate-900">Access</h2>
        <p className="text-sm text-slate-500">
          {status === "active"
            ? "Suspending a pharmacy blocks every login for that shop. Their data stays put."
            : "This pharmacy is suspended. The owner cannot sign in until you activate it."}
        </p>
        {status === "active" ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => setStatus("suspended")}
            className="btn-danger"
          >
            Suspend pharmacy
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => setStatus("active")}
            className="btn-primary"
          >
            Activate pharmacy
          </button>
        )}
      </div>

      <div className="card space-y-3 p-5">
        <h2 className="text-sm font-semibold text-slate-900">Reset owner password</h2>
        <p className="text-sm text-slate-500">
          Sets a new password for <span className="font-medium text-slate-700">{ownerEmail}</span>.
          Hand it to the owner; it is not emailed.
        </p>
        <div>
          <label htmlFor="new-password" className="label">
            New password
          </label>
          <input
            id="new-password"
            type="text"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setResetDone(false);
            }}
            minLength={8}
            className="input"
            autoComplete="off"
          />
        </div>
        <button
          type="button"
          disabled={busy || password.length < 8}
          onClick={resetPassword}
          className="btn-secondary"
        >
          Set password
        </button>
        {resetDone ? (
          <p className="text-sm text-emerald-700">Password updated.</p>
        ) : null}
      </div>
    </div>
  );
}
