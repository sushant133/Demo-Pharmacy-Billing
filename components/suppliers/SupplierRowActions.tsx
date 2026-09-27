"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ActionBar, ActionIcon } from "@/components/action-icons";
import { apiFetch } from "@/lib/client";

/**
 * View / Edit / Delete for one row of the suppliers table.
 *
 * Delete asks first, in the page rather than a browser dialog. The API
 * decides what actually happens: a supplier with purchases or batches on
 * record is marked inactive instead, so stock provenance stays intact, and
 * the message it returns says which it was.
 */
export function SupplierRowActions({
  id,
  name,
  isActive,
  editHref,
  canWrite,
  canDelete,
}: {
  id: string;
  name: string;
  isActive: boolean;
  editHref: string;
  canWrite: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function remove() {
    setBusy(true);
    setMessage(null);
    const result = await apiFetch<{ message: string }>(`/api/suppliers/${id}`, { method: "DELETE" });
    setBusy(false);
    if (!result.ok) {
      setMessage({ tone: "error", text: result.message });
      return;
    }
    setConfirming(false);
    setMessage({ tone: "ok", text: result.data.message });
    router.refresh();
  }

  return (
    <>
      <ActionBar>
        <ActionIcon label="View" icon="view" href={`/suppliers/${id}`} tone="primary" />
        {canWrite ? <ActionIcon label="Edit" icon="edit" href={editHref} /> : null}
        {canDelete && isActive ? (
          <ActionIcon
            label="Delete / deactivate"
            icon="delete"
            tone="danger"
            onClick={() => {
              setMessage(null);
              setConfirming(true);
            }}
          />
        ) : null}
      </ActionBar>

      {message && !confirming ? (
        <p
          role="status"
          className={`mt-1 max-w-56 whitespace-normal text-right text-[11px] ${
            message.tone === "ok" ? "text-emerald-700" : "text-rose-600"
          }`}
        >
          {message.text}
        </p>
      ) : null}

      {confirming ? (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={`del-${id}-title`}
          className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-4 pb-[calc(1rem+var(--safe-bottom))] sm:items-center"
          onClick={() => !busy && setConfirming(false)}
        >
          <div
            className="w-full max-w-sm whitespace-normal rounded-2xl bg-white p-5 text-left shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id={`del-${id}-title`} className="text-base font-semibold text-slate-900">
              Delete {name}?
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              If this supplier has purchases or batches on record, they will be
              marked <span className="font-medium">inactive</span> instead, so
              stock history stays intact. Otherwise they are deleted for good.
            </p>
            {message?.tone === "error" ? (
              <p role="alert" className="mt-2 text-sm text-rose-600">
                {message.text}
              </p>
            ) : null}
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="btn-secondary w-full"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void remove()}
                disabled={busy}
                className="btn-danger w-full"
              >
                {busy ? "Working…" : "Delete / deactivate"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
