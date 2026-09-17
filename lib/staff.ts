import { Types } from "mongoose";
import { ApiError } from "@/lib/api";
import { hashPassword } from "@/lib/auth";
import { connectDB } from "@/lib/db";
import {
  ROLE_LABELS,
  ROLE_SCHEME_VERSION,
  isAssignableRole,
  assignableRoleOf,
  type AssignableRole,
} from "@/lib/roles";
import { pharmacyFilter } from "@/lib/tenant";
import { Branch } from "@/models/Branch";
import { User } from "@/models/User";
import type { SessionUser } from "@/lib/session";
import type { StaffInput, StaffUpdateInput } from "@/lib/validation";

/**
 * Staff accounts, managed by the pharmacy rather than by the platform.
 *
 * Issuing logins used to sit with the platform administrator because getting
 * it wrong locks a working pharmacist out mid-shift. What made that safe to
 * hand over is not a confirmation dialog - it is these five rules, enforced
 * here rather than in the form:
 *
 *   1. An account belongs to exactly one pharmacy, and only that pharmacy's
 *      owner can touch it. Every query is scoped, so a guessed id from
 *      another shop reads as "no such account".
 *   2. Nobody can disable or delete themselves. Locking yourself out of your
 *      own shop at 9pm is not a mistake software should let you make.
 *   3. The last account that can still *administer* the shop cannot be
 *      disabled or deleted. Counted in owners rather than in logins: a
 *      pharmacy whose only remaining account is a cashier cannot reach its own
 *      staff screen, settings or figures, which is as locked out as having no
 *      login at all - and getting back needs the platform administrator, the
 *      exact dependency this was meant to remove.
 *   4. An account that has done anything - billed, received stock - is
 *      disabled rather than deleted, so the name on those records still
 *      resolves.
 *   5. A role is chosen from `ASSIGNABLE_ROLES` and never taken as a free
 *      string, so no request can name `superadmin` and walk out of the tenant.
 *      Nobody may demote themselves, for the same reason they may not disable
 *      themselves.
 */

export interface StaffSummary {
  id: string;
  name: string;
  email: string;
  role: AssignableRole;
  roleLabel: string;
  branchId: string | null;
  isActive: boolean;
}

function summarise(doc: {
  _id: unknown;
  name: string;
  email: string;
  role?: unknown;
  roleVersion?: unknown;
  branchId?: unknown;
  isActive?: boolean;
}): StaffSummary {
  const role = assignableRoleOf(doc);
  return {
    id: String(doc._id),
    name: doc.name,
    email: doc.email,
    role,
    roleLabel: ROLE_LABELS[role],
    branchId: doc.branchId ? String(doc.branchId) : null,
    isActive: doc.isActive !== false,
  };
}

/** The branch a staff member is being attached to, checked against this shop. */
async function resolveBranch(
  user: SessionUser,
  branchId: string | null,
): Promise<Types.ObjectId | null> {
  if (!branchId) return null;

  const branch = await Branch.findOne({
    _id: branchId,
    ...pharmacyFilter(user),
    isActive: true,
  })
    .select("_id")
    .lean();

  if (!branch) throw ApiError.badRequest("That branch is not open at this pharmacy.");
  return branch._id;
}

/**
 * How many accounts could still administer this pharmacy if this one stopped.
 *
 * Asked before every disable, delete and demotion. Counted rather than
 * assumed, because "there is surely another admin" is exactly the assumption
 * that ends with a shop locked out of its own till.
 *
 * Only owners count. Once roles are narrower than "everybody can do
 * everything", a shop whose last remaining login is a cashier cannot reach
 * its own staff screen, settings or figures - that is locked out, even though
 * somebody can still sign in. A row that predates the narrower roles has no
 * `roleVersion` and is read under its old meaning, which is why this asks
 * `assignableRoleOf` rather than matching `role: "admin"` in the query.
 */
async function otherActiveOwnerCount(
  user: SessionUser,
  excludingId: string,
): Promise<number> {
  const candidates = await User.find({
    ...pharmacyFilter(user),
    _id: { $ne: new Types.ObjectId(excludingId) },
    isActive: { $ne: false },
  })
    .select("role roleVersion")
    .lean();

  return candidates.filter((doc) => assignableRoleOf(doc) === "admin").length;
}

function assertNotSelf(user: SessionUser, id: string, action: string): void {
  if (String(user.id) === String(id)) {
    throw ApiError.badRequest(
      `You cannot ${action} your own account - you would be locked out of this pharmacy.`,
    );
  }
}

export async function createStaff(
  user: SessionUser,
  input: StaffInput,
): Promise<StaffSummary> {
  await connectDB();

  const email = input.email.trim().toLowerCase();

  // Emails are unique across the whole platform, not per pharmacy: one address
  // is one person, and two shops both claiming it would make sign-in ambiguous.
  // Checked here so the message names the field rather than surfacing as a
  // bare index conflict.
  const taken = await User.findOne({ email }).select("_id").lean();
  if (taken) {
    throw ApiError.conflict(
      "That email address already has an account. Ask them to sign in with it, or use a different address.",
    );
  }

  const branchId = await resolveBranch(user, input.branchId);

  // Re-checked here rather than trusted from the schema alone: this is the
  // one place a client-supplied string becomes a permission set, and the
  // value that must never get through is "superadmin".
  if (!isAssignableRole(input.role)) {
    throw ApiError.badRequest("Choose a role for this account.");
  }

  const created = await User.create({
    name: input.name,
    email,
    passwordHash: await hashPassword(input.password),
    role: input.role,
    roleVersion: ROLE_SCHEME_VERSION,
    pharmacyId: new Types.ObjectId(user.pharmacyId),
    branchId,
    isActive: true,
  });

  return summarise(created.toObject());
}

/** Edit a colleague's name, email, role or home branch. */
export async function updateStaff(
  user: SessionUser,
  id: string,
  input: StaffUpdateInput,
): Promise<StaffSummary> {
  await connectDB();

  const update: Record<string, unknown> = {};
  if (input.name !== undefined) update.name = input.name;

  if (input.role !== undefined) {
    if (!isAssignableRole(input.role)) {
      throw ApiError.badRequest("That is not a role this pharmacy can assign.");
    }

    // Demoting yourself is the quiet way to lock a shop out: an owner who
    // makes themselves a cashier cannot reach this screen to undo it.
    if (String(user.id) === String(id) && input.role !== "admin") {
      throw ApiError.badRequest(
        "You cannot change your own role - you would lose access to this screen. Ask another owner to do it.",
      );
    }

    /*
      No "last owner" check is needed here, unlike on disable and delete.
      Only an owner reaches this code at all (user:manage), self-demotion is
      refused just above, and disabling yourself is refused elsewhere - so
      whoever is demoting somebody else is themselves an active owner who
      remains one afterwards. The shop always has a way back in.
    */
    update.role = input.role;
    // Stamped alongside the role: from here on this row says exactly what it
    // means, whatever it meant before.
    update.roleVersion = ROLE_SCHEME_VERSION;
  }

  if (input.email !== undefined) {
    const email = input.email.trim().toLowerCase();
    const taken = await User.findOne({ email, _id: { $ne: id } })
      .select("_id")
      .lean();
    if (taken) {
      throw ApiError.conflict("That email address already has an account.");
    }
    update.email = email;
  }

  if (input.branchId !== undefined) {
    update.branchId = await resolveBranch(user, input.branchId);
  }

  if (Object.keys(update).length === 0) {
    throw ApiError.badRequest("Nothing to change.");
  }

  const updated = await User.findOneAndUpdate(
    { _id: id, ...pharmacyFilter(user) },
    { $set: update },
    { new: true, runValidators: true },
  ).lean();

  if (!updated) throw ApiError.notFound("That account no longer exists.");
  return summarise(updated);
}

/**
 * Turn an account on or off.
 *
 * Disabling ends that person's next sign-in, not their current session - the
 * token they already hold stays valid until it expires. Said plainly in the
 * result so nobody believes a disable is an instant lock-out.
 */
export async function setStaffActive(
  user: SessionUser,
  id: string,
  isActive: boolean,
): Promise<StaffSummary> {
  await connectDB();

  if (!isActive) {
    assertNotSelf(user, id, "disable");

    if ((await otherActiveOwnerCount(user, id)) === 0) {
      throw ApiError.badRequest(
        "This is the only account that can still administer this pharmacy. Make someone else an owner first.",
      );
    }
  }

  const updated = await User.findOneAndUpdate(
    { _id: id, ...pharmacyFilter(user) },
    { $set: { isActive } },
    { new: true },
  ).lean();

  if (!updated) throw ApiError.notFound("That account no longer exists.");
  return summarise(updated);
}

/**
 * Set a colleague's password.
 *
 * The old one is not asked for: this is an owner resetting an account for
 * somebody who has forgotten theirs, which is the only reason a shop needs
 * this at all. Changing your *own* password is a different act and deserves
 * the current-password check it does not have here yet.
 */
export async function resetStaffPassword(
  user: SessionUser,
  id: string,
  password: string,
): Promise<StaffSummary> {
  await connectDB();

  const updated = await User.findOneAndUpdate(
    { _id: id, ...pharmacyFilter(user) },
    { $set: { passwordHash: await hashPassword(password) } },
    { new: true },
  ).lean();

  if (!updated) throw ApiError.notFound("That account no longer exists.");
  return summarise(updated);
}

/**
 * Remove an account.
 *
 * Only ever a real delete for a login that was issued and never used. The
 * moment somebody has billed, received stock or posted a purchase, their name
 * is on those records, and deleting the account would leave a shop's history
 * pointing at nobody. Those are disabled instead, and the caller is told which
 * happened rather than left to guess.
 */
export async function removeStaff(
  user: SessionUser,
  id: string,
): Promise<{ deleted: boolean; disabled: boolean; message: string }> {
  await connectDB();

  assertNotSelf(user, id, "delete");

  const account = await User.findOne({ _id: id, ...pharmacyFilter(user) }).lean();
  if (!account) throw ApiError.notFound("That account no longer exists.");

  if (account.isActive !== false && (await otherActiveOwnerCount(user, id)) === 0) {
    throw ApiError.badRequest(
      "This is the only account that can still administer this pharmacy.",
    );
  }

  // Never signed in, so nothing can carry their name. Anything else is kept.
  if (!account.lastLoginAt) {
    await User.deleteOne({ _id: id, ...pharmacyFilter(user) });
    return {
      deleted: true,
      disabled: false,
      message: `${account.name} was removed. The account had never been used.`,
    };
  }

  await User.updateOne(
    { _id: id, ...pharmacyFilter(user) },
    { $set: { isActive: false } },
  );

  return {
    deleted: false,
    disabled: true,
    message: `${account.name} has signed in before, so the account was disabled rather than deleted - their name still has to resolve on the bills and purchases they raised.`,
  };
}
