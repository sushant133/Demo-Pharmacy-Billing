import { Types } from "mongoose";
import { ApiError } from "@/lib/api";
import { resolveViewScope, storedBranchId, writeBranchId } from "@/lib/branch-scope";
import { connectDB } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import type { SessionUser } from "@/lib/session";
import { pharmacyFilter, pharmacyObjectId } from "@/lib/tenant";
import { sessionOption, withTransaction } from "@/lib/transaction";
import { Batch } from "@/models/Batch";
import { Branch } from "@/models/Branch";
import { Expense } from "@/models/Expense";
import { Pharmacy } from "@/models/Pharmacy";
import { Prescription } from "@/models/Prescription";
import { Purchase } from "@/models/Purchase";
import { Sale } from "@/models/Sale";
import { StockMovement } from "@/models/StockMovement";
import { User } from "@/models/User";
import type { BranchInput } from "@/lib/validation";

/**
 * Branch registry.
 *
 * Small on purpose: a branch is a name, an address and a PAN. Everything
 * interesting about it - what stock it holds, what it sold - is derived from
 * the documents that point at it, exactly as supplier balances are.
 */

export interface BranchSummary {
  id: string;
  code: string;
  name: string;
  address: string;
  phone: string;
  panNo: string;
  isDefault: boolean;
  isActive: boolean;
  notes: string;
  /** Lots currently held here, and what they are worth at cost. */
  lotCount: number;
  unitCount: number;
  stockValue: number;
  staffCount: number;
}

export async function listBranches(
  user: SessionUser,
  includeInactive = false,
): Promise<BranchSummary[]> {
  return listBranchesForPharmacy(pharmacyObjectId(user), includeInactive);
}

/**
 * The same registry, addressed by pharmacy rather than by session.
 *
 * Superadmin belongs to no shop, so it cannot read one through
 * `pharmacyFilter`. The platform screens name the pharmacy explicitly, which
 * is also the only way an outlet is opened now - see
 * `createBranchForPharmacy`.
 */
export async function listBranchesForPharmacy(
  pharmacyId: string | Types.ObjectId,
  includeInactive = false,
): Promise<BranchSummary[]> {
  await connectDB();

  const tenant =
    typeof pharmacyId === "string" ? new Types.ObjectId(pharmacyId) : pharmacyId;

  const filter: Record<string, unknown> = { pharmacyId: tenant };
  if (!includeInactive) filter.isActive = true;
  const branches = await Branch.find(filter).sort({ name: 1 }).lean();
  if (branches.length === 0) return [];

  const ids = branches.map((branch) => branch._id);

  // One aggregate for every branch rather than one query per branch: a chain
  // with twenty outlets should still be a single round trip.
  const [stock, staff] = await Promise.all([
    Batch.aggregate<{ _id: Types.ObjectId; lots: number; units: number; value: number }>([
      { $match: { branchId: { $in: ids }, quantity: { $gt: 0 } } },
      {
        $group: {
          _id: "$branchId",
          lots: { $sum: 1 },
          units: { $sum: "$quantity" },
          value: { $sum: { $multiply: ["$quantity", "$costPrice"] } },
        },
      },
    ]),
    User.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { branchId: { $in: ids }, isActive: { $ne: false } } },
      { $group: { _id: "$branchId", count: { $sum: 1 } } },
    ]),
  ]);

  const stockByBranch = new Map(stock.map((row) => [String(row._id), row]));
  const staffByBranch = new Map(staff.map((row) => [String(row._id), row.count]));

  return branches.map((branch) => {
    const row = stockByBranch.get(String(branch._id));
    return {
      id: String(branch._id),
      code: branch.code,
      name: branch.name,
      address: branch.address ?? "",
      phone: branch.phone ?? "",
      panNo: branch.panNo ?? "",
      isDefault: Boolean(branch.isDefault),
      isActive: branch.isActive !== false,
      notes: branch.notes ?? "",
      lotCount: row?.lots ?? 0,
      unitCount: row?.units ?? 0,
      stockValue: Math.round((row?.value ?? 0) * 100) / 100,
      staffCount: staffByBranch.get(String(branch._id)) ?? 0,
    };
  });
}

/**
 * Open an outlet for one pharmacy. Superadmin only, and deliberately so.
 *
 * An outlet is a billing identity - it prints its own name, address and PAN
 * on a VAT invoice - and it permanently splits the shop's stock in two. A
 * shop that wants another one asks the platform, and the platform opens it.
 * That is why this takes a pharmacy id rather than a session, and why
 * POST /api/branches no longer exists.
 */
export async function createBranchForPharmacy(
  pharmacyId: string | Types.ObjectId,
  input: BranchInput,
) {
  await connectDB();

  const tenant =
    typeof pharmacyId === "string" ? new Types.ObjectId(pharmacyId) : pharmacyId;

  const shop = await Pharmacy.findById(tenant).select("_id").lean();
  if (!shop) throw ApiError.notFound("That pharmacy no longer exists.");

  return withTransaction(async ({ session }) => {
    const [branch] = await Branch.create(
      [{ ...input, pharmacyId: tenant, isDefault: false }],
      sessionOption(session),
    );
    if (!branch) throw new Error("Branch was not created.");

    // The very first branch has to be the default, or nothing has anywhere to
    // go: new users, the seed and the migration all fall back to it.
    const count = await Branch.countDocuments({ pharmacyId: tenant }).session(
      session,
    );
    if (count === 1) {
      await Branch.updateOne(
        { _id: branch._id },
        { $set: { isDefault: true } },
        sessionOption(session),
      );
      branch.isDefault = true;
    }

    return { id: String(branch._id), code: branch.code, name: branch.name };
  });
}

export async function updateBranch(
  user: SessionUser,
  id: string,
  input: BranchInput,
) {
  await connectDB();

  const branch = await Branch.findOneAndUpdate(
    { _id: id, ...pharmacyFilter(user) },
    { $set: input },
    { new: true, runValidators: true },
  );
  if (!branch) throw ApiError.notFound("That branch no longer exists.");

  return { id: String(branch._id), code: branch.code, name: branch.name };
}

/** Exactly one branch carries the default flag, so setting it clears the rest. */
export async function setDefaultBranch(user: SessionUser, id: string) {
  await connectDB();

  return withTransaction(async ({ session }) => {
    const branch = await Branch.findOne({ _id: id, ...pharmacyFilter(user) }).session(
      session,
    );
    if (!branch) throw ApiError.notFound("That branch no longer exists.");
    if (branch.isActive === false) {
      throw ApiError.conflict(
        `${branch.name} is closed, so it cannot be the default branch.`,
      );
    }

    await Branch.updateMany(
      { pharmacyId: branch.pharmacyId, _id: { $ne: branch._id } },
      { $set: { isDefault: false } },
      sessionOption(session),
    );
    await Branch.updateOne(
      { _id: branch._id },
      { $set: { isDefault: true } },
      sessionOption(session),
    );

    return { id: String(branch._id), name: branch.name, isDefault: true };
  });
}

/**
 * Close a branch.
 *
 * Never a hard delete while anything points at it: its bills must still
 * reprint and its GRNs must still reconcile. Stock and staff have to be moved
 * out first, because a closed branch holding lots is stock nobody is counting.
 */
export async function closeBranch(user: SessionUser, id: string) {
  await connectDB();

  const branch = await Branch.findOne({ _id: id, ...pharmacyFilter(user) });
  if (!branch) throw ApiError.notFound("That branch no longer exists.");

  if (branch.isDefault) {
    throw ApiError.conflict(
      `${branch.name} is the default branch. Make another branch the default before closing this one.`,
    );
  }

  const [units, staff] = await Promise.all([
    Batch.aggregate<{ units: number }>([
      { $match: { branchId: branch._id, quantity: { $gt: 0 } } },
      { $group: { _id: null, units: { $sum: "$quantity" } } },
    ]),
    User.countDocuments({ branchId: branch._id, isActive: { $ne: false } }),
  ]);

  const remaining = units[0]?.units ?? 0;
  if (remaining > 0) {
    throw ApiError.conflict(
      `${branch.name} still holds ${remaining} unit(s) of stock. Transfer them to another branch before closing it.`,
    );
  }
  if (staff > 0) {
    throw ApiError.conflict(
      `${staff} active user(s) still work at ${branch.name}. Move them to another branch before closing it.`,
    );
  }

  branch.isActive = false;
  await branch.save();

  return { id: String(branch._id), name: branch.name, closed: true };
}

/**
 * Everything that would be orphaned by deleting a branch.
 *
 * Deliberately every collection that carries a `branchId`, not just the ones
 * a person would think of. A bill has to reprint, a GRN has to reconcile, a
 * stock movement is the only account of where units went - none of that
 * survives the outlet it points at being removed from under it.
 */
const BRANCH_REFERENCES = [
  ["lot of stock", "lots of stock", Batch],
  ["bill", "bills", Sale],
  ["purchase", "purchases", Purchase],
  ["stock movement", "stock movements", StockMovement],
  ["prescription", "prescriptions", Prescription],
  ["expense", "expenses", Expense],
  ["staff login", "staff logins", User],
] as const;

export interface BranchDeletionBlock {
  count: number;
  /** Worded and ready to read: "1 bill", "12 bills". */
  text: string;
}

/** Worded here so the refusal message and the screen cannot disagree. */
function wordBlock(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * What stands between each of a pharmacy's branches and deletion.
 *
 * Read by the platform screen so it can offer Delete only where it would
 * work, and say what is in the way where it would not. The server checks
 * again before deleting anything - this is the courtesy, not the guard.
 *
 * One query per collection for the whole pharmacy rather than per branch, so
 * a chain with twenty outlets still costs seven round trips, not a hundred
 * and forty.
 */
export async function branchDeletionBlockers(
  pharmacyId: string | Types.ObjectId,
): Promise<Map<string, BranchDeletionBlock[]>> {
  await connectDB();
  const tenant =
    typeof pharmacyId === "string" ? new Types.ObjectId(pharmacyId) : pharmacyId;

  const blockers = new Map<string, BranchDeletionBlock[]>();

  const grouped = await Promise.all(
    BRANCH_REFERENCES.map(async ([singular, plural, model]) => {
      const rows = await (model as { aggregate: typeof Batch.aggregate }).aggregate<{
        _id: Types.ObjectId | null;
        count: number;
      }>([
        { $match: { pharmacyId: tenant, branchId: { $ne: null } } },
        { $group: { _id: "$branchId", count: { $sum: 1 } } },
      ]);
      return { singular, plural, rows };
    }),
  );

  for (const { singular, plural, rows } of grouped) {
    for (const row of rows) {
      if (!row._id || row.count === 0) continue;
      const key = String(row._id);
      const list = blockers.get(key) ?? [];
      list.push({ count: row.count, text: wordBlock(row.count, singular, plural) });
      blockers.set(key, list);
    }
  }

  return blockers;
}

/**
 * Delete an outlet for good. Superadmin only.
 *
 * The shop closes a branch it has finished with - see `closeBranch` - which
 * keeps it, its bills and its history intact and merely stops it trading.
 * This is the other thing: an outlet opened by mistake, with the wrong code
 * or against the wrong pharmacy, that should never have existed. So it is
 * only ever allowed when nothing at all points at the branch. A branch that
 * has traded is a branch that has to be closed, not erased, and this refuses
 * rather than quietly cascading.
 *
 * The default outlet is refused too: a pharmacy with nowhere to bill cannot
 * work, and `ensureDefaultBranch` silently conjuring a replacement would be
 * a worse surprise than being told to nominate one first.
 */
export async function deleteBranchForPharmacy(
  pharmacyId: string | Types.ObjectId,
  branchId: string,
  confirm: string,
): Promise<{ id: string; code: string; name: string }> {
  await connectDB();
  const tenant =
    typeof pharmacyId === "string" ? new Types.ObjectId(pharmacyId) : pharmacyId;

  const branch = await Branch.findOne({ _id: branchId, pharmacyId: tenant });
  if (!branch) throw ApiError.notFound("That branch no longer exists.");

  if (confirm.trim().toLowerCase() !== branch.code.toLowerCase()) {
    throw ApiError.badRequest(
      `Type the branch code (${branch.code}) exactly to confirm this deletion.`,
    );
  }

  if (branch.isDefault) {
    throw ApiError.conflict(
      `${branch.name} is the default outlet. Make another branch the default before deleting this one.`,
    );
  }

  // Counted here rather than trusted from the screen: the list was rendered
  // at some point in the past, and a bill can be rung up in between.
  const counts = await Promise.all(
    BRANCH_REFERENCES.map(async ([singular, plural, model]) => {
      const count = await (
        model as { countDocuments: typeof Batch.countDocuments }
      ).countDocuments({ branchId: branch._id });
      return { count, text: wordBlock(count, singular, plural) };
    }),
  );

  const holding = counts.filter((entry) => entry.count > 0);
  if (holding.length > 0) {
    const what = holding.map((entry) => entry.text).join(", ");
    throw ApiError.conflict(
      `${branch.name} still has ${what}. An outlet that has traded is closed, not deleted, so its bills keep reprinting and its stock stays accounted for.`,
    );
  }

  await Branch.deleteOne({ _id: branch._id });

  return { id: String(branch._id), code: branch.code, name: branch.name };
}

/**
 * The outlet a write will land on.
 *
 * Follows the branch switcher when a named outlet is selected, so an admin
 * working alone can bill and receive at whichever counter they switched to.
 * "All branches" and an unassigned admin fall back to the default outlet
 * rather than refusing — a one-person shop must still be able to sell.
 */
export async function branchForWrite(user: SessionUser) {
  const viewing = await resolveViewScope(user);

  // Candidates in order of authority: the outlet the switcher or token names,
  // then whatever the user document says.
  //
  // A branch id that resolves to nothing is stepped over rather than thrown
  // on. Both of these are snapshots that can outlive what they point at - a
  // token is signed once a shift, and a user's branchId survives the branch
  // being deleted or the database being reseeded - and a counter should not be
  // locked out of billing because a stale id names an outlet that is simply
  // not there any more.
  //
  // A branch that IS there but closed is a different matter and still stops
  // the sale: falling through to another outlet would quietly record the bill,
  // and move the stock, at a shop the customer never visited.
  const candidates = [writeBranchId(user, viewing), await storedBranchId(user)];

  for (const id of candidates) {
    if (!id) continue;

    const branchFilter = user.pharmacyId
      ? { _id: id, pharmacyId: pharmacyObjectId(user) }
      : { _id: id };
    const branch = await Branch.findOne(branchFilter).lean();
    if (!branch) continue;

    if (branch.isActive === false) {
      throw ApiError.conflict(
        `${branch.name} is closed, so it cannot record sales or receive stock. Switch to an open outlet.`,
      );
    }

    return {
      id: branch._id as Types.ObjectId,
      name: branch.name,
      code: branch.code,
    };
  }

  // A shop that has not set its branches up yet still has to be able to sell,
  // so an unattached admin gets the default outlet, creating it if this is the
  // first thing that ever needed one.
  if (user.role === "admin" && user.pharmacyId) {
    const fallback = await ensureDefaultBranch(user.pharmacyId);
    return {
      id: fallback._id as Types.ObjectId,
      name: fallback.name,
      code: fallback.code,
    };
  }

  throw ApiError.badRequest(
    "Your account is not attached to a branch, so it cannot record stock movements. Ask an administrator to assign one.",
  );
}

/**
 * Guarantee a default outlet exists.
 *
 * Used by the seed and the backfill so a shop that has not created branches
 * yet still has somewhere for existing users and lots to belong.
 */
export async function ensureDefaultBranch(pharmacyId: string | Types.ObjectId) {
  await connectDB();
  const id =
    typeof pharmacyId === "string" ? new Types.ObjectId(pharmacyId) : pharmacyId;

  const current =
    (await Branch.findOne({ pharmacyId: id, isDefault: true, isActive: true })) ??
    (await Branch.findOne({ pharmacyId: id, isActive: true }).sort({ createdAt: 1 }));

  if (current) {
    if (!current.isDefault) {
      current.isDefault = true;
      await current.save();
    }
    return current;
  }

  // The first outlet inherits the shop's own details, so a single-branch
  // pharmacy never has to type its name twice.
  const shop = await getSettings(id);
  const [created] = await Branch.create([
    {
      pharmacyId: id,
      code: "main",
      name: shop.businessName,
      address: [shop.address, shop.city].filter(Boolean).join(", "),
      phone: shop.phone,
      panNo: shop.pan,
      isDefault: true,
      isActive: true,
      notes: "Created automatically as the default outlet.",
    },
  ]);
  if (!created) throw new Error("Default branch was not created.");
  return created;
}

/** The fallback branch for anything that did not name one. */
export async function defaultBranch(pharmacyId: string | Types.ObjectId) {
  await connectDB();
  const id =
    typeof pharmacyId === "string" ? new Types.ObjectId(pharmacyId) : pharmacyId;

  const branch =
    (await Branch.findOne({ pharmacyId: id, isDefault: true, isActive: true }).lean()) ??
    (await Branch.findOne({ pharmacyId: id, isActive: true }).sort({ createdAt: 1 }).lean());

  if (!branch) {
    throw ApiError.badRequest(
      "No branch exists yet. Create one before recording stock or sales.",
    );
  }
  return branch;
}

/** Resolve a branch by id, refusing closed ones for write paths. */
export async function requireActiveBranch(
  id: string | Types.ObjectId,
  pharmacyId?: string | Types.ObjectId,
) {
  await connectDB();

  const filter: Record<string, unknown> = { _id: id };
  if (pharmacyId) filter.pharmacyId = pharmacyId;
  const branch = await Branch.findOne(filter).lean();
  if (!branch) throw ApiError.notFound("That branch no longer exists.");
  if (branch.isActive === false) {
    throw ApiError.conflict(`${branch.name} is closed and cannot receive stock.`);
  }
  return branch;
}

/** What one branch has been up to, for its detail screen. */
export async function branchActivity(
  id: string | Types.ObjectId,
  pharmacyId?: string | Types.ObjectId,
) {
  await connectDB();
  const branchId = new Types.ObjectId(String(id));
  const scoped: Record<string, unknown> = { branchId };
  if (pharmacyId) scoped.pharmacyId = pharmacyId;

  const [sales, purchases] = await Promise.all([
    Sale.aggregate<{ bills: number; revenue: number }>([
      { $match: { ...scoped, voidedAt: null } },
      {
        $group: {
          _id: null,
          bills: { $sum: 1 },
          revenue: {
            $sum: {
              $subtract: [
                "$taxableAmount",
                { $ifNull: ["$returnedTaxable", 0] },
              ],
            },
          },
        },
      },
    ]),
    Purchase.countDocuments({ ...scoped, status: "posted" }),
  ]);

  return {
    billCount: sales[0]?.bills ?? 0,
    revenue: Math.round((sales[0]?.revenue ?? 0) * 100) / 100,
    postedPurchases: purchases,
  };
}
