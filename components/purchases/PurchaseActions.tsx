"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client";

/**
 * Post / cancel / delete controls for one purchase.
 *
 * Posting and cancelling both move stock, so each asks for a deliberate
 * confirmation in-place rather than firing on a single click - and cancelling
 * additionally requires a written reason, which the API enforces so the
 * reversal is auditable rather than anonymous.
 */
export function PurchaseActions({
  purchaseId,
  grnNo,
  status,
  canPost,
  canCancel,
  canEdit,
}: {
  purchaseId: string;
  grnNo: string;
  status: string;
  canPost: boolean;
  canCancel: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<null | "post" | "cancel" | "delete">(null);
  const [reason, setReason] = useState("");

  async function run(action: "post" | "cancel" | "delete") {
    setBusy(true);
    setError(null);

    const result =
      action === "post"
        ? await apiFetch(`/api/purchases/${purchaseId}/post`, { method: "POST" })
        : action === "cancel"
          ? await apiFetch(`/api/purchases/${purchaseId}/cancel`, {
              method: "POST",
              json: { reason: reason.trim() },
            })
          : await apiFetch(`/api/purchases/${purchaseId}`, { method: "DELETE" });

    if (!result.ok) {
      setError(result.message);
      setBusy(false);
      return;
    }

    if (action === "delete") {
      router.push("/purchases");
    } else {
      setConfirming(null);
      router.refresh();
    }
    setBusy(false);
  }

  return (
    <div className="space-y-3">
      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700"
        >
          {error}
        </div>
      ) : null}

      {status === "draft" ? (
        <>
          {confirming === "post" ? (
            <div className="rounded-lg border border-brand-200 bg-brand-50 p-3">
              <p className="text-xs text-slate-700">
                Posting {grnNo} creates the batches and puts the stock on the shelf.
                It cannot be edited afterwards.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => run("post")}
                  disabled={busy}
                  className="btn-primary flex-1 py-1.5 text-xs"
                >
                  {busy ? "Posting…" : "Yes, post it"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(null)}
                  className="btn-secondary py-1.5 text-xs"
                >
                  Back
                </button>
              </div>
            </div>
          ) : (
            <>
              {canPost ? (
                <button
                  type="button"
                  onClick={() => setConfirming("post")}
                  className="btn-primary w-full"
                >
                  Post &amp; receive stock
                </button>
              ) : null}
              {canEdit ? (
                <a href={`/purchases/${purchaseId}/edit`} className="btn-secondary w-full">
                  Edit draft
                </a>
              ) : null}
            </>
          )}

          {confirming === "delete" ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
              <p className="text-xs text-rose-800">
                Delete draft {grnNo}? Nothing has been received from it, so nothing
                is lost but the typing.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => run("delete")}
                  disabled={busy}
                  className="btn-danger flex-1 py-1.5 text-xs"
                >
                  {busy ? "Deleting…" : "Delete"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(null)}
                  className="btn-secondary py-1.5 text-xs"
                >
                  Keep
                </button>
              </div>
            </div>
          ) : canEdit && confirming === null ? (
            <button
              type="button"
              onClick={() => setConfirming("delete")}
              className="w-full text-xs font-medium text-rose-600 hover:underline"
            >
              Delete this draft
            </button>
          ) : null}
        </>
      ) : null}

      {status === "posted" && canCancel ? (
        confirming === "cancel" ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
            <p className="text-xs text-rose-800">
              Cancelling {grnNo} removes the stock it brought in. It is refused if
              any of it has already been sold.
            </p>
            <label htmlFor="cancel-reason" className="label mt-3">
              Reason
            </label>
            <input
              id="cancel-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. entered against the wrong supplier"
              className="input text-xs"
            />
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => run("cancel")}
                disabled={busy || reason.trim().length < 3}
                className="btn-danger flex-1 py-1.5 text-xs"
              >
                {busy ? "Cancelling…" : "Cancel GRN"}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(null)}
                className="btn-secondary py-1.5 text-xs"
              >
                Back
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming("cancel")}
            className="w-full text-xs font-medium text-rose-600 hover:underline"
          >
            Cancel this GRN
          </button>
        )
      ) : null}
    </div>
  );
}
