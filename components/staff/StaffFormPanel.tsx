"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { apiFetch } from "@/lib/client";
import {
  ASSIGNABLE_ROLES,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  type AssignableRole,
} from "@/lib/roles";
import { Field, SlideOver } from "@/components/SlideOver";

/**
 * Issue or edit a colleague's login.
 *
 * Issuing logins used to sit with the platform administrator, so this panel is
 * the first place a shop can lock somebody out of its own till. The rules that
 * make that safe live on the server - you cannot disable yourself, you cannot
 * disable the last account that can administer the shop, you cannot demote
 * yourself - and this only tries to make the common case quick and the
 * refusals legible.
 *
 * The role picker shows what each role actually means beneath the dropdown.
 * "Cashier" is not self-explanatory, and an owner picking blind is how a
 * part-time counter assistant ends up able to void bills and read margins.
 */

export interface StaffFormValues {
  id: string;
  name: string;
  email: string;
  role: AssignableRole;
  branchId: string | null;
  isActive: boolean;
  /** Whether they have ever signed in, which decides delete vs disable. */
  used: boolean;
  /** True for the signed-in user's own row. */
  isSelf: boolean;
}

export interface BranchOption {
  id: string;
  name: string;
}

export function StaffFormPanel({
  staff,
  branches,
  returnHref = "/staff",
}: {
  /** Null to issue a new login. */
  staff: StaffFormValues | null;
  branches: BranchOption[];
  returnHref?: string;
}) {
  const router = useRouter();
  const isEdit = Boolean(staff);

  const [name, setName] = useState(staff?.name ?? "");
  const [email, setEmail] = useState(staff?.email ?? "");
  // A new login defaults to the most restricted role, not the widest: the
  // owner should have to choose to hand out more than the till.
  const [role, setRole] = useState<AssignableRole>(staff?.role ?? "cashier");
  const [branchId, setBranchId] = useState(staff?.branchId ?? "");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const inflight = useRef(false);

  const close = useCallback(() => {
    router.push(returnHref);
    router.refresh();
  }, [router, returnHref]);

  async function call<T>(
    url: string,
    init: { method: string; json?: unknown },
  ): Promise<T | null> {
    if (inflight.current) return null;
    inflight.current = true;
    setBusy(true);
    setError(null);

    const result = await apiFetch<T>(url, init);

    inflight.current = false;
    setBusy(false);

    if (!result.ok) {
      setError(result.message);
      return null;
    }
    return result.data;
  }

  async function save() {
    if (isEdit) {
      const done = await call(`/api/staff/${staff!.id}`, {
        method: "PATCH",
        json: {
          name: name.trim(),
          email: email.trim(),
          // Own role is never sent: the server refuses self-demotion, and
          // sending an unchanged value would only turn that into a confusing
          // error on an edit that changed the name.
          ...(staff!.isSelf ? {} : { role }),
          branchId,
        },
      });
      if (done) close();
      return;
    }

    const done = await call("/api/staff", {
      method: "POST",
      json: { name: name.trim(), email: email.trim(), password, role, branchId },
    });
    if (done) close();
  }

  async function resetPassword() {
    const done = await call(`/api/staff/${staff!.id}/password`, {
      method: "POST",
      json: { password },
    });
    if (done) {
      setPassword("");
      setNotice(
        `${staff!.name}'s password has been changed. Tell them the new one - this system cannot email it.`,
      );
    }
  }

  async function setActive(isActive: boolean) {
    const done = await call(`/api/staff/${staff!.id}/status`, {
      method: "POST",
      json: { isActive },
    });
    if (done) {
      router.refresh();
      setNotice(
        isActive
          ? `${staff!.name} can sign in again.`
          : `${staff!.name} cannot sign in from now on. A session they already have open stays valid until it expires.`,
      );
    }
  }

  async function remove() {
    const done = await call<{ message: string }>(`/api/staff/${staff!.id}`, {
      method: "DELETE",
    });
    if (done) {
      setRemoving(false);
      setNotice(done.message);
      router.refresh();
    }
  }

  const passwordValid = password.length === 0 || password.length >= 8;
  const ready =
    name.trim().length >= 2 &&
    /\S+@\S+\.\S+/.test(email.trim()) &&
    (isEdit || password.length >= 8);

  return (
    <SlideOver
      title={isEdit ? staff!.name : "Add a staff member"}
      description={
        isEdit
          ? "Their details, password and access."
          : "Issue a login for somebody who works at this pharmacy."
      }
      onClose={close}
      footer={
        <div className="flex gap-2">
          <button
            type="button"
            onClick={save}
            disabled={busy || !ready}
            className="btn-primary flex-1"
          >
            {busy ? "Saving…" : isEdit ? "Save changes" : "Create login"}
          </button>
          <button type="button" onClick={close} className="btn-secondary">
            Close
          </button>
        </div>
      }
    >
      <div className="space-y-5">
        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
          >
            {error}
          </div>
        ) : null}

        {notice ? (
          <div
            role="status"
            className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
          >
            {notice}
          </div>
        ) : null}

        <fieldset className="space-y-4">
          <legend className="w-full border-b border-slate-100 pb-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Details
          </legend>

          <Field label="Name" htmlFor="staff-name" required>
            <input
              id="staff-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Sunita Karki"
              className="input"
              required
            />
          </Field>

          <Field
            label="Email"
            htmlFor="staff-email"
            required
            hint="What they sign in with. One address is one person across the platform."
          >
            <input
              id="staff-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              className="input"
              required
            />
          </Field>

          <Field
            label="Role"
            htmlFor="staff-role"
            required
            hint={
              isEdit && staff!.isSelf
                ? "This is your own account. You cannot change your own role - you would lose access to this screen. Ask another owner to do it."
                : "What this person is allowed to do. It can be changed later."
            }
          >
            <select
              id="staff-role"
              value={role}
              onChange={(event) =>
                setRole(event.target.value as AssignableRole)
              }
              disabled={isEdit && staff!.isSelf}
              className="input disabled:bg-slate-100 disabled:text-slate-500"
            >
              {ASSIGNABLE_ROLES.map((option) => (
                <option key={option} value={option}>
                  {ROLE_LABELS[option]}
                </option>
              ))}
            </select>

            {/* The dropdown says "Cashier"; this says what a cashier may do.
                Live rather than a static list, so it cannot drift from
                lib/roles.ts. */}
            <p className="mt-1.5 text-xs text-slate-500">
              {ROLE_DESCRIPTIONS[role]}
            </p>

            {role === "admin" ? (
              <p className="mt-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                An owner can do everything you can, including issuing logins,
                voiding bills and reading the shop&apos;s margins.
              </p>
            ) : null}
          </Field>

          <Field
            label="Home branch"
            htmlFor="staff-branch"
            hint="Where their sales and receipts land. Leave blank for somebody who works across every outlet."
          >
            <select
              id="staff-branch"
              value={branchId ?? ""}
              onChange={(event) => setBranchId(event.target.value)}
              className="input"
            >
              <option value="">No fixed branch</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </Field>
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="w-full border-b border-slate-100 pb-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Password
          </legend>

          <Field
            label={isEdit ? "New password" : "Password"}
            htmlFor="staff-password"
            required={!isEdit}
            error={
              password.length > 0 && !passwordValid
                ? "At least 8 characters."
                : undefined
            }
            hint={
              isEdit
                ? "Only filled in to change it. You will have to tell them the new one yourself - this system cannot email it."
                : "At least 8 characters. Tell them what you set; there is no email invite yet."
            }
          >
            <div className="flex gap-2">
              <input
                id="staff-password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                className="input"
              />
              <button
                type="button"
                onClick={() => setShowPassword((current) => !current)}
                className="btn-secondary shrink-0 px-3 text-xs"
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </Field>

          {isEdit ? (
            <button
              type="button"
              onClick={resetPassword}
              disabled={busy || password.length < 8}
              className="btn-secondary w-full"
            >
              Set this password
            </button>
          ) : null}
        </fieldset>

        {isEdit ? (
          <fieldset className="space-y-3">
            <legend className="w-full border-b border-slate-100 pb-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
              Access
            </legend>

            {staff!.isSelf ? (
              <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                This is your own account. You cannot disable or delete it - you
                would be locked out of this pharmacy.
              </p>
            ) : (
              <>
                <p className="text-xs text-slate-600">
                  {staff!.isActive
                    ? "This account can sign in. Disabling it stops the next sign-in; a session already open stays valid until it expires."
                    : "This account cannot sign in."}
                </p>

                <button
                  type="button"
                  onClick={() => setActive(!staff!.isActive)}
                  disabled={busy}
                  className={
                    staff!.isActive ? "btn-secondary w-full" : "btn-primary w-full"
                  }
                >
                  {staff!.isActive ? "Disable this account" : "Enable this account"}
                </button>

                <div className="border-t border-slate-100 pt-3">
                  {removing ? (
                    <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
                      <p className="text-xs text-rose-800">
                        {staff!.used
                          ? `${staff!.name} has signed in before, so the account will be disabled rather than deleted - their name still has to resolve on the bills and purchases they raised.`
                          : `${staff!.name} has never signed in, so the account will be removed for good.`}
                      </p>
                      <div className="mt-3 flex gap-2">
                        <button
                          type="button"
                          onClick={remove}
                          disabled={busy}
                          className="btn-danger flex-1 py-1.5 text-xs"
                        >
                          {busy
                            ? "Working…"
                            : staff!.used
                              ? "Disable account"
                              : "Delete account"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setRemoving(false)}
                          className="btn-secondary py-1.5 text-xs"
                        >
                          Keep it
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setRemoving(true)}
                      className="text-xs font-medium text-rose-600 hover:underline"
                    >
                      Remove this account
                    </button>
                  )}
                </div>
              </>
            )}
          </fieldset>
        ) : null}
      </div>
    </SlideOver>
  );
}
