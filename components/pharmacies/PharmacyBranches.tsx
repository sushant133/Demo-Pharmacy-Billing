"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client";
import { Badge } from "@/components/ui";
import { integer } from "@/lib/format";
import { branchSchema } from "@/lib/validation";

export interface PharmacyBranchRow {
  id: string;
  code: string;
  name: string;
  address: string;
  isDefault: boolean;
  isActive: boolean;
  unitCount: number;
  staffCount: number;
  /**
   * What stands between this outlet and deletion, already worded: "12 bills",
   * "3 lots of stock". Empty means nothing points at it and it can go.
   */
  blockedBy: string[];
}

const EMPTY = {
  code: "",
  name: "",
  address: "",
  phone: "",
  panNo: "",
  notes: "",
};

/**
 * Outlets of one pharmacy, from the platform side.
 *
 * A shop cannot open its own outlet: an outlet prints its own name and PAN on
 * a VAT invoice and splits the shop's stock in two, so it is opened here,
 * against the pharmacy that asked for it. Once it exists the shop runs it -
 * renaming it, making it the default, closing it - from its own Branches
 * screen, which is why none of those buttons are here.
 *
 * Deleting one is here for the same reason opening one is. It undoes a
 * mistake - the wrong code, the wrong pharmacy - and nothing else: an outlet
 * that has taken a single bill can only be closed, and the row says so
 * instead of offering a button that would fail.
 */
export function PharmacyBranches({
  pharmacyId,
  pharmacyName,
  branches,
}: {
  pharmacyId: string;
  pharmacyName: string;
  branches: PharmacyBranchRow[];
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [openedName, setOpenedName] = useState<string | null>(null);

  // Which row is armed for deletion, and the code typed into it so far. One
  // at a time: arming a second row disarms the first, so there is never more
  // than one branch a stray Enter could remove.
  const [armedId, setArmedId] = useState<string | null>(null);
  const [confirmCode, setConfirmCode] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletedName, setDeletedName] = useState<string | null>(null);

  function set<K extends keyof typeof values>(key: K, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function arm(branchId: string) {
    setArmedId(branchId);
    setConfirmCode("");
    setDeleteError(null);
    setDeletedName(null);
  }

  function disarm() {
    setArmedId(null);
    setConfirmCode("");
    setDeleteError(null);
  }

  async function destroy(branch: PharmacyBranchRow) {
    setDeleteError(null);
    setDeleting(true);

    const result = await apiFetch(
      `/api/pharmacies/${pharmacyId}/branches/${branch.id}`,
      { method: "DELETE", json: { confirm: confirmCode } },
    );

    setDeleting(false);
    if (!result.ok) {
      setDeleteError(result.message);
      return;
    }

    setDeletedName(branch.name);
    disarm();
    router.refresh();
  }

  function startAdding() {
    setValues(EMPTY);
    setErrors({});
    setFormError(null);
    setOpenedName(null);
    setAdding(true);
  }

  async function create() {
    setFormError(null);
    const parsed = branchSchema.safeParse(values);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "_form");
        fieldErrors[key] ??= issue.message;
      }
      setErrors(fieldErrors);
      return;
    }

    setErrors({});
    setSaving(true);

    const result = await apiFetch<{ name: string }>(
      `/api/pharmacies/${pharmacyId}/branches`,
      { method: "POST", json: parsed.data },
    );

    setSaving(false);
    if (!result.ok) {
      setFormError(result.message);
      return;
    }

    setOpenedName(result.data.name);
    setValues(EMPTY);
    setAdding(false);
    router.refresh();
  }

  return (
    <div className="card p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Branches</h2>
          <p className="mt-1 text-sm text-slate-500">
            Outlets of {pharmacyName}. Only the platform opens or deletes one;
            the shop renames, defaults and closes its own.
          </p>
        </div>
        {adding ? null : (
          <button type="button" onClick={startAdding} className="btn-primary">
            Add branch
          </button>
        )}
      </div>

      {openedName ? (
        <p className="mt-3 text-sm text-emerald-700">
          {openedName} is open. The shop sees it straight away.
        </p>
      ) : null}

      {deletedName ? (
        <p className="mt-3 text-sm text-emerald-700">
          {deletedName} has been deleted.
        </p>
      ) : null}

      {deleteError ? (
        <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-800">
          {deleteError}
        </div>
      ) : null}

      {branches.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">
          This pharmacy has no outlet yet, so it cannot bill or receive stock.
          Open one.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-sm">
            <thead>
              <tr>
                <th className="th">Branch</th>
                <th className="th text-right">Units</th>
                <th className="th text-right">Staff</th>
                <th className="th text-right">Delete</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {branches.map((branch) => (
                <tr key={branch.id}>
                  <td className="td">
                    <p className="font-medium text-slate-900">{branch.name}</p>
                    <p className="text-xs text-slate-500">
                      {branch.code}
                      {branch.address ? ` · ${branch.address}` : ""}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {branch.isDefault ? <Badge tone="brand">Default</Badge> : null}
                      {branch.isActive ? null : <Badge tone="slate">Closed</Badge>}
                    </div>

                    {armedId === branch.id ? (
                      <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3">
                        <p className="text-xs text-rose-900">
                          Type{" "}
                          <span className="font-mono font-semibold">
                            {branch.code}
                          </span>{" "}
                          to delete {branch.name} for good. Nothing points at it,
                          so nothing else is lost.
                        </p>
                        <input
                          className="input mt-2"
                          value={confirmCode}
                          onChange={(event) => setConfirmCode(event.target.value)}
                          placeholder={branch.code}
                          autoComplete="off"
                          aria-label={`Type ${branch.code} to confirm`}
                        />
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={
                              deleting ||
                              confirmCode.trim().toLowerCase() !==
                                branch.code.toLowerCase()
                            }
                            onClick={() => void destroy(branch)}
                            className="btn-danger"
                          >
                            {deleting ? "Deleting…" : "Delete branch"}
                          </button>
                          <button
                            type="button"
                            onClick={disarm}
                            className="btn-secondary"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </td>
                  <td className="td tnum text-right align-top">
                    {integer(branch.unitCount)}
                  </td>
                  <td className="td tnum text-right align-top">
                    {integer(branch.staffCount)}
                  </td>
                  <td className="td text-right align-top">
                    <DeleteCell
                      branch={branch}
                      armed={armedId === branch.id}
                      onArm={() => arm(branch.id)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding ? (
        <div className="mt-5 space-y-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
          {formError ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-800">
              {formError}
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="branch-code" className="label">
                Code
              </label>
              <input
                id="branch-code"
                className="input"
                value={values.code}
                onChange={(event) => set("code", event.target.value)}
                placeholder="pokhara"
                autoComplete="off"
              />
              <p className="mt-1.5 text-xs text-slate-500">
                Lowercase letters, numbers and hyphens. It appears in URLs and
                cannot be changed later.
              </p>
              {errors.code ? (
                <p className="mt-1.5 text-xs text-rose-600">{errors.code}</p>
              ) : null}
            </div>
            <div>
              <label htmlFor="branch-name" className="label">
                Name
              </label>
              <input
                id="branch-name"
                className="input"
                value={values.name}
                onChange={(event) => set("name", event.target.value)}
                placeholder="Pokhara branch"
              />
              <p className="mt-1.5 text-xs text-slate-500">
                Printed on this outlet&rsquo;s own bills.
              </p>
              {errors.name ? (
                <p className="mt-1.5 text-xs text-rose-600">{errors.name}</p>
              ) : null}
            </div>
            <div>
              <label htmlFor="branch-phone" className="label">
                Phone <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <input
                id="branch-phone"
                className="input"
                value={values.phone}
                onChange={(event) => set("phone", event.target.value)}
              />
            </div>
            <div>
              <label htmlFor="branch-pan" className="label">
                PAN <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <input
                id="branch-pan"
                className="input"
                value={values.panNo}
                onChange={(event) => set("panNo", event.target.value)}
              />
              <p className="mt-1.5 text-xs text-slate-500">
                Blank prints the company PAN on this outlet&rsquo;s bills.
              </p>
              {errors.panNo ? (
                <p className="mt-1.5 text-xs text-rose-600">{errors.panNo}</p>
              ) : null}
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="branch-address" className="label">
                Address
              </label>
              <textarea
                id="branch-address"
                className="input min-h-[4rem]"
                value={values.address}
                onChange={(event) => set("address", event.target.value)}
              />
              {errors.address ? (
                <p className="mt-1.5 text-xs text-rose-600">{errors.address}</p>
              ) : null}
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="branch-notes" className="label">
                Notes <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <textarea
                id="branch-notes"
                className="input min-h-[3.5rem]"
                value={values.notes}
                onChange={(event) => set("notes", event.target.value)}
                placeholder="Who asked for this outlet, and when."
              />
              {errors.notes ? (
                <p className="mt-1.5 text-xs text-rose-600">{errors.notes}</p>
              ) : null}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={create}
              disabled={saving}
              className="btn-primary"
            >
              {saving ? "Opening…" : "Open branch"}
            </button>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="btn-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Delete column for one row.
 *
 * Three states, and the middle one is the point: an outlet that has traded
 * shows what is in the way rather than a button that would be refused. The
 * server checks the same thing again - this is the courtesy, not the guard -
 * so a bill rung up since the page loaded still stops the deletion.
 */
function DeleteCell({
  branch,
  armed,
  onArm,
}: {
  branch: PharmacyBranchRow;
  armed: boolean;
  onArm: () => void;
}) {
  if (branch.isDefault) {
    return (
      <span className="text-xs text-slate-400">
        Default outlet — make another the default first
      </span>
    );
  }

  if (branch.blockedBy.length > 0) {
    return (
      <span className="text-xs text-slate-400">
        Has {branch.blockedBy.join(", ")} — close it instead
      </span>
    );
  }

  if (armed) {
    return <span className="text-xs text-rose-600">Confirming…</span>;
  }

  return (
    <button
      type="button"
      onClick={onArm}
      className="text-xs font-medium text-rose-600 hover:text-rose-700 hover:underline"
    >
      Delete
    </button>
  );
}
