"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { apiFetch } from "@/lib/client";

/**
 * Everything the platform can do to one account, in one column.
 *
 * Ordered by how easily each is undone. Access and the owner login sit at the
 * top and are reversible in a click; signing in as the owner is recorded and
 * self-expiring; deletion is at the bottom, behind a suspension and a typed
 * short code, because it is the only one with no way back.
 *
 * Suspending asks first and activating does not - the same asymmetry the
 * medicine toggle uses. Shutting a shop out of its own till is the kind of
 * thing that gets clicked by accident on a page whose other buttons are
 * harmless, and the owner finds out by failing to sign in.
 */
export function PharmacyActions({
  id,
  pharmacyName,
  slug,
  status,
  statusReason,
  ownerName,
  ownerEmail,
}: {
  id: string;
  /** Named in the suspend confirmation, so nobody shuts the wrong shop. */
  pharmacyName: string;
  /** Typed by hand to confirm a deletion. */
  slug: string;
  status: "active" | "suspended";
  statusReason: string;
  ownerName: string;
  ownerEmail: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [resetDone, setResetDone] = useState(false);
  const inflight = useRef(false);

  const [owner, setOwner] = useState({ ownerName, ownerEmail });
  const [ownerSaved, setOwnerSaved] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState("");
  const [deleteArmed, setDeleteArmed] = useState(false);

  async function setStatus(next: "active" | "suspended") {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setError(null);
    const path =
      next === "suspended"
        ? `/api/pharmacies/${id}/suspend`
        : `/api/pharmacies/${id}/activate`;
    const result = await apiFetch(path, { method: "POST", json: { reason } });
    inflight.current = false;
    setBusy(false);
    setAsking(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setReason("");
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

  async function saveOwner() {
    setBusy(true);
    setError(null);
    setOwnerSaved(false);
    const result = await apiFetch(`/api/pharmacies/${id}/owner`, {
      method: "PATCH",
      json: owner,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setOwnerSaved(true);
    router.refresh();
  }

  async function impersonate() {
    setBusy(true);
    setError(null);
    const result = await apiFetch(`/api/pharmacies/${id}/impersonate`, {
      method: "POST",
    });
    if (!result.ok) {
      setBusy(false);
      setError(result.message);
      return;
    }
    // A full navigation, not a router push: the session cookie has just been
    // swapped, and every cached server component in this tab belongs to the
    // platform session that no longer exists.
    window.location.href = "/dashboard";
  }

  async function destroy() {
    setBusy(true);
    setError(null);
    const result = await apiFetch(`/api/pharmacies/${id}`, {
      method: "DELETE",
      json: { confirm: confirmDelete },
    });
    if (!result.ok) {
      setBusy(false);
      setError(result.message);
      return;
    }
    window.location.href = "/superadmin/pharmacies";
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
        {statusReason ? (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
            Last reason: {statusReason}
          </p>
        ) : null}
        {status === "active" ? (
          asking ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
              <p className="text-sm text-rose-900">
                Suspend {pharmacyName}? Every login for that shop stops working
                until you activate it again. Nothing is deleted.
              </p>
              <label htmlFor="suspend-reason" className="label mt-3">
                Reason <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <input
                id="suspend-reason"
                className="input"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Unpaid subscription, owner request…"
              />
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setStatus("suspended")}
                  className="btn-danger"
                >
                  {busy ? "Suspending…" : "Yes, suspend"}
                </button>
                <button
                  type="button"
                  onClick={() => setAsking(false)}
                  className="btn-secondary"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => setAsking(true)}
              className="btn-danger"
            >
              Suspend pharmacy
            </button>
          )
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
        <h2 className="text-sm font-semibold text-slate-900">Owner login</h2>
        <p className="text-sm text-slate-500">
          The one account that can run this shop. Changing the email moves the
          login itself, so the old address stops working immediately.
        </p>
        <div>
          <label htmlFor="owner-name" className="label">
            Name
          </label>
          <input
            id="owner-name"
            className="input"
            value={owner.ownerName}
            onChange={(event) => {
              setOwner((current) => ({ ...current, ownerName: event.target.value }));
              setOwnerSaved(false);
            }}
          />
        </div>
        <div>
          <label htmlFor="owner-email" className="label">
            Email
          </label>
          <input
            id="owner-email"
            type="email"
            className="input"
            value={owner.ownerEmail}
            onChange={(event) => {
              setOwner((current) => ({ ...current, ownerEmail: event.target.value }));
              setOwnerSaved(false);
            }}
          />
        </div>
        <button
          type="button"
          disabled={
            busy ||
            (owner.ownerName === ownerName && owner.ownerEmail === ownerEmail)
          }
          onClick={saveOwner}
          className="btn-secondary"
        >
          Save owner
        </button>
        {ownerSaved ? <p className="text-sm text-emerald-700">Owner updated.</p> : null}
      </div>

      <div className="card space-y-3 p-5">
        <h2 className="text-sm font-semibold text-slate-900">Reset owner password</h2>
        <p className="text-sm text-slate-500">
          Sets a new password for <span className="font-medium text-slate-700">{owner.ownerEmail}</span>.
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

      <div className="card space-y-3 p-5">
        <h2 className="text-sm font-semibold text-slate-900">Sign in as owner</h2>
        <p className="text-sm text-slate-500">
          Opens this shop exactly as {owner.ownerName || "the owner"} sees it, for
          half an hour. A banner tells everyone in the shop that you are there,
          and the platform log records it. Anything you do is recorded against
          their name, so read rather than act where you can.
        </p>
        <button
          type="button"
          disabled={busy || status !== "active"}
          onClick={impersonate}
          className="btn-secondary"
        >
          Sign in as owner
        </button>
        {status !== "active" ? (
          <p className="text-xs text-slate-500">
            Suspended shops cannot be entered. Activate it first.
          </p>
        ) : null}
      </div>

      <div className="card space-y-3 border-rose-200 p-5">
        <h2 className="text-sm font-semibold text-rose-900">Delete pharmacy</h2>
        <p className="text-sm text-slate-500">
          Removes {pharmacyName} and every record it owns: bills, stock,
          catalogue, staff logins, settings. This cannot be undone, and the
          nightly backup is not a copy of it. Download a backup first.
        </p>
        {status === "active" ? (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
            Suspend the pharmacy first. A shop that is trading right now cannot
            be deleted in one click.
          </p>
        ) : deleteArmed ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
            <p className="text-sm text-rose-900">
              Type <span className="font-mono font-semibold">{slug}</span> to
              confirm. Everything belonging to this shop is erased.
            </p>
            <input
              className="input mt-3"
              value={confirmDelete}
              onChange={(event) => setConfirmDelete(event.target.value)}
              placeholder={slug}
              autoComplete="off"
            />
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={busy || confirmDelete.trim().toLowerCase() !== slug}
                onClick={destroy}
                className="btn-danger"
              >
                {busy ? "Deleting…" : "Delete for good"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDeleteArmed(false);
                  setConfirmDelete("");
                }}
                className="btn-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => setDeleteArmed(true)}
            className="btn-danger"
          >
            Delete pharmacy
          </button>
        )}
      </div>
    </div>
  );
}
