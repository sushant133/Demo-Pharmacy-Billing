import { Types } from "mongoose";
import { cookies } from "next/headers";
import { ApiError } from "@/lib/api";
import { connectDB } from "@/lib/db";
import { onceTtl } from "@/lib/ttl-cache";
import { Branch } from "@/models/Branch";
import { User } from "@/models/User";
import type { SessionUser } from "@/lib/session";

/**
 * Which branch's stock and figures the current request may see.
 *
 * Two separate ideas live here, and conflating them is the bug this module
 * exists to prevent:
 *
 *   - The **viewing** scope is what the screens report on. Staff are pinned to
 *     their own branch; an admin may switch to another, or to "all", to see
 *     the whole business at once.
 *   - The **write** outlet is where stock actually moves. A named viewing
 *     branch is treated as the counter you are standing at — so a solo owner
 *     who switched to Pokhara bills and receives Pokhara stock. "All branches"
 *     is report-only: writes fall back to the user's own outlet.
 *
 * So `resolveViewScope` decides what to show, and `writeBranchId` decides
 * what to move. Read paths take the first; write paths take the second.
 */

/** A resolved viewing scope. `branchId: null` means every branch of this pharmacy. */
export interface BranchScope {
  /** Always set for a pharmacy session. Isolates one vendor from another. */
  pharmacyId: Types.ObjectId | null;
  branchId: Types.ObjectId | null;
  /** Null when the scope is "all branches". */
  code: string | null;
  label: string;
  /** True when the user is allowed to change it. */
  switchable: boolean;
}

export const BRANCH_COOKIE = "mp_branch";
/** The cookie value that means "every branch at once". */
export const ALL_BRANCHES = "all";

/** Only an admin sees across branches; everyone else is pinned to their own. */
export function canSwitchBranch(user: SessionUser): boolean {
  return user.role === "admin";
}

/**
 * The outlet stock moves in or out of, given the current viewing scope.
 *
 * A named branch in the switcher is the counter you are working at. "All
 * branches" never receives a sale or a GRN — that would mix two shops' stock
 * on one bill — so we fall back to the user's own outlet. Null means the
 * caller should use the default branch (admin) or refuse (everyone else).
 */
export function writeBranchId(
  user: SessionUser,
  viewing: BranchScope,
): Types.ObjectId | null {
  if (viewing.branchId) return viewing.branchId;
  if (user.branchId && Types.ObjectId.isValid(user.branchId)) {
    return new Types.ObjectId(user.branchId);
  }
  return null;
}

/**
 * The user's own outlet, ignoring the switcher.
 *
 * Kept for callers that must not follow a viewing scope (for example attaching
 * a new staff account). Prefer `writeBranchId` for sales and purchases.
 */
export function sellingBranchId(user: SessionUser): Types.ObjectId {
  if (!user.branchId) {
    throw ApiError.badRequest(
      "Your account is not attached to a branch, so it cannot record stock movements. Ask an administrator to assign one.",
    );
  }
  return new Types.ObjectId(user.branchId);
}

/**
 * The user's outlet as the database currently has it.
 *
 * The token carries a branch so the common path needs no lookup, but it is a
 * snapshot taken at sign-in. A session signed before an admin assigned the
 * outlet - or before the branch backfill attached one - carries none at all,
 * and would otherwise keep failing until it expired a shift later. So when the
 * token has nothing, ask the database rather than concluding there is nothing.
 */
export async function storedBranchId(
  user: SessionUser,
): Promise<Types.ObjectId | null> {
  if (!user.id || !Types.ObjectId.isValid(user.id)) return null;

  await connectDB();
  const doc = await User.findById(user.id).select("branchId").lean();
  return doc?.branchId ? new Types.ObjectId(String(doc.branchId)) : null;
}

/**
 * The scope of the user's own outlet, ignoring the switcher.
 *
 * Falls back to the stored branch when the token carries none, because the
 * alternative - a null branchId - reads as "all branches" to every filter
 * downstream, and a stale token must never quietly widen one counter into
 * another shop's stock.
 */
function pharmacyIdOf(user: SessionUser): Types.ObjectId | null {
  return user.pharmacyId && Types.ObjectId.isValid(user.pharmacyId)
    ? new Types.ObjectId(user.pharmacyId)
    : null;
}

async function ownScope(user: SessionUser): Promise<BranchScope> {
  const pharmacyId = pharmacyIdOf(user);

  if (user.branchId && Types.ObjectId.isValid(user.branchId)) {
    return {
      pharmacyId,
      branchId: new Types.ObjectId(user.branchId),
      code: user.branchCode || null,
      label: user.branchName || user.branchCode || "Your branch",
      switchable: false,
    };
  }

  const id = await storedBranchId(user);
  if (!id) {
    return {
      pharmacyId,
      branchId: null,
      code: null,
      label: user.role === "admin" ? "All branches" : "No branch assigned",
      switchable: false,
    };
  }

  const branch = await Branch.findById(id).select("code name").lean();
  return {
    pharmacyId,
    branchId: id,
    code: branch?.code ?? null,
    label: branch?.name ?? "Your branch",
    switchable: false,
  };
}

/**
 * The branch cookie, or null when there is no request to read one from.
 *
 * `cookies()` throws outside a request scope, and this module is reached from
 * places that have no request: the seed script and one-off migrations both
 * ring up sales through the same production path, deliberately, so that the
 * sample data is made the way real data is. Losing the switcher's preference
 * there is correct - a script is not standing at any particular counter - but
 * throwing is not.
 */
async function branchCookie(): Promise<string | null> {
  try {
    return (await cookies()).get(BRANCH_COOKIE)?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Work out the viewing scope from the user and their branch cookie.
 *
 * `requested` (a branch code, or "all") overrides the cookie for a single
 * request, which is how a link like `?branch=pokhara` works. A non-admin
 * asking for someone else's branch is not an error - the cookie may simply be
 * stale after a role change - they are quietly returned to their own.
 */
export async function resolveViewScope(
  user: SessionUser,
  requested?: string | null,
): Promise<BranchScope> {
  // A user who cannot switch is pinned to the branch on their token. Hitting
  // Mongo on every sidebar click was the tax that made navigation feel stuck.
  if (!canSwitchBranch(user)) {
    return ownScope(user);
  }

  const wanted = (requested ?? (await branchCookie()) ?? "").trim().toLowerCase();

  const own = await ownScope(user);
  if (!wanted) return { ...own, switchable: true };

  if (wanted === ALL_BRANCHES) {
    return {
      pharmacyId: own.pharmacyId,
      branchId: null,
      code: null,
      label: "All branches",
      switchable: true,
    };
  }

  await connectDB();
  const branch = await Branch.findOne({
    code: wanted,
    isActive: true,
    ...(own.pharmacyId ? { pharmacyId: own.pharmacyId } : {}),
  })
    .select("_id code name")
    .lean();

  // A deleted or deactivated branch in a stale cookie falls back rather than
  // erroring: the admin should land on a working screen, not a dead end.
  if (!branch) return { ...own, switchable: true };

  return {
    pharmacyId: own.pharmacyId,
    branchId: branch._id,
    code: branch.code,
    label: branch.name,
    switchable: true,
  };
}

/**
 * Spread into a Mongoose filter to scope it.
 *
 * A named branch adds `branchId`. "All branches" omits it so one query serves
 * both the per-outlet and whole-pharmacy views — but `pharmacyId` is always
 * applied when the scope has one, so "all branches" never means every vendor.
 */
export function branchFilter(
  scope?: BranchScope | null,
  field = "branchId",
): Record<string, unknown> {
  // Never return an unscoped match. An omitted or untenanted scope must hide
  // every vendor's stock, not mix them.
  if (!scope?.pharmacyId) return { pharmacyId: { $in: [] } };
  const filter: Record<string, unknown> = { pharmacyId: scope.pharmacyId };
  if (scope.branchId) filter[field] = scope.branchId;
  return filter;
}

/** The same thing as an aggregation `$match` stage body. */
export function branchMatch(
  scope?: BranchScope | null,
  field = "branchId",
): Record<string, unknown> {
  return branchFilter(scope, field);
}

/** Viewing scope for an API request, honouring `?branch=`. */
export async function resolveRequestScope(
  user: SessionUser,
  req: Request,
): Promise<BranchScope> {
  return resolveViewScope(user, new URL(req.url).searchParams.get("branch"));
}

/**
 * Refuse a document that belongs to a branch the caller is not looking at.
 *
 * A bookmarked URL from another outlet should see a 404, not another shop's
 * stock or bills. "All branches" is allowed through.
 */
export function assertVisibleInScope(
  docBranchId: unknown,
  scope: BranchScope,
  message = "That record is not at this branch.",
): void {
  if (!scope.branchId) return;
  if (!docBranchId || String(docBranchId) !== String(scope.branchId)) {
    throw ApiError.notFound(message);
  }
}

/**
 * Whether this shop actually runs more than one outlet.
 *
 * What the Branches row, the dashboard tile and the switcher are gated on.
 * Every pharmacy is created with one outlet it never asked for, and it can no
 * longer open a second itself - the platform does that on request - so until
 * one exists those controls offer a screen with a single row and a switcher
 * with a single choice. Reads the same 30s-cached list the switcher does, so
 * asking costs nothing on the common path.
 */
export async function hasMultipleBranches(user: SessionUser): Promise<boolean> {
  return (await switchableBranches(user)).length > 1;
}

/** Every branch a user may view, for the switcher. Empty when they cannot. */
export async function switchableBranches(
  user: SessionUser,
): Promise<Array<{ id: string; code: string; name: string }>> {
  if (!canSwitchBranch(user)) return [];

  const pharmacyId = pharmacyIdOf(user);
  const cacheKey = `switchable-branches:${pharmacyId ?? "none"}`;

  return onceTtl(cacheKey, 30_000, async () => {
    await connectDB();

    const docs = await Branch.find({
      isActive: true,
      ...(pharmacyId ? { pharmacyId } : {}),
    })
      .sort({ name: 1 })
      .select("_id code name")
      .lean();

    return docs.map((doc) => ({
      id: String(doc._id),
      code: doc.code,
      name: doc.name,
    }));
  });
}
