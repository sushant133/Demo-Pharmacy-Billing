import { Types } from "mongoose";
import { ApiError } from "@/lib/api";
import { resolveViewScope, storedBranchId, writeBranchId } from "@/lib/branch-scope";
import { connectDB } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import type { SessionUser } from "@/lib/session";
import { sessionOption, withTransaction } from "@/lib/transaction";
import { Batch } from "@/models/Batch";
import { Branch } from "@/models/Branch";
import { Purchase } from "@/models/Purchase";
import { Sale } from "@/models/Sale";
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
  includeInactive = false,
): Promise<BranchSummary[]> {
  await connectDB();

  const filter = includeInactive ? {} : { isActive: true };
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

export async function createBranch(input: BranchInput) {
  await connectDB();

  return withTransaction(async ({ session }) => {
    const [branch] = await Branch.create(
      [{ ...input, isDefault: false }],
      sessionOption(session),
    );
    if (!branch) throw new Error("Branch was not created.");

    // The very first branch has to be the default, or nothing has anywhere to
    // go: new users, the seed and the migration all fall back to it.
    const count = await Branch.countDocuments().session(session);
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

export async function updateBranch(id: string, input: BranchInput) {
  await connectDB();

  const branch = await Branch.findByIdAndUpdate(
    id,
    { $set: input },
    { new: true, runValidators: true },
  );
  if (!branch) throw ApiError.notFound("That branch no longer exists.");

  return { id: String(branch._id), code: branch.code, name: branch.name };
}

/** Exactly one branch carries the default flag, so setting it clears the rest. */
export async function setDefaultBranch(id: string) {
  await connectDB();

  return withTransaction(async ({ session }) => {
    const branch = await Branch.findById(id).session(session);
    if (!branch) throw ApiError.notFound("That branch no longer exists.");
    if (branch.isActive === false) {
      throw ApiError.conflict(
        `${branch.name} is closed, so it cannot be the default branch.`,
      );
    }

    await Branch.updateMany(
      { _id: { $ne: branch._id } },
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
export async function closeBranch(id: string) {
  await connectDB();

  const branch = await Branch.findById(id);
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

    const branch = await Branch.findById(id).lean();
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
  if (user.role === "admin") {
    const fallback = await ensureDefaultBranch();
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
export async function ensureDefaultBranch() {
  await connectDB();

  const current =
    (await Branch.findOne({ isDefault: true, isActive: true })) ??
    (await Branch.findOne({ isActive: true }).sort({ createdAt: 1 }));

  if (current) {
    if (!current.isDefault) {
      current.isDefault = true;
      await current.save();
    }
    return current;
  }

  // The first outlet inherits the shop's own details, so a single-branch
  // pharmacy never has to type its name twice.
  const shop = await getSettings();
  const [created] = await Branch.create([
    {
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
export async function defaultBranch() {
  await connectDB();

  const branch =
    (await Branch.findOne({ isDefault: true, isActive: true }).lean()) ??
    (await Branch.findOne({ isActive: true }).sort({ createdAt: 1 }).lean());

  if (!branch) {
    throw ApiError.badRequest(
      "No branch exists yet. Create one before recording stock or sales.",
    );
  }
  return branch;
}

/** Resolve a branch by id, refusing closed ones for write paths. */
export async function requireActiveBranch(id: string | Types.ObjectId) {
  await connectDB();

  const branch = await Branch.findById(id).lean();
  if (!branch) throw ApiError.notFound("That branch no longer exists.");
  if (branch.isActive === false) {
    throw ApiError.conflict(`${branch.name} is closed and cannot receive stock.`);
  }
  return branch;
}

/** What one branch has been up to, for its detail screen. */
export async function branchActivity(id: string | Types.ObjectId) {
  await connectDB();
  const branchId = new Types.ObjectId(String(id));

  const [sales, purchases] = await Promise.all([
    Sale.aggregate<{ bills: number; revenue: number }>([
      { $match: { branchId, voidedAt: null } },
      { $group: { _id: null, bills: { $sum: 1 }, revenue: { $sum: "$taxableAmount" } } },
    ]),
    Purchase.countDocuments({ branchId, status: "posted" }),
  ]);

  return {
    billCount: sales[0]?.bills ?? 0,
    revenue: Math.round((sales[0]?.revenue ?? 0) * 100) / 100,
    postedPurchases: purchases,
  };
}
