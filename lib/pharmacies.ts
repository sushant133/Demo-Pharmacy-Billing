import { Types } from "mongoose";
import { ApiError } from "@/lib/api";
import { hashPassword } from "@/lib/auth";
import { connectDB } from "@/lib/db";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { slugifyPharmacyName } from "@/lib/tenant";
import { sessionOption, withTransaction } from "@/lib/transaction";
import type { CreatePharmacyInput, UpdatePharmacyInput } from "@/lib/validation";
import type { SessionUser } from "@/lib/session";
import { Branch } from "@/models/Branch";
import { Pharmacy } from "@/models/Pharmacy";
import { Setting } from "@/models/Setting";
import { User } from "@/models/User";

/**
 * Platform pharmacy accounts.
 *
 * Superadmin creates a pharmacy, its default outlet, its settings record and
 * the owner login in one step. From that moment the shop is a sealed tenant:
 * the owner signs in to their own catalogue and till, and never sees another
 * pharmacy's data.
 */

export interface PharmacySummary {
  id: string;
  name: string;
  slug: string;
  legalName: string;
  status: "active" | "suspended";
  ownerName: string;
  ownerEmail: string;
  notes: string;
  createdAt: Date | null;
  lastLoginAt: Date | null;
}

async function uniqueSlug(base: string, excludeId?: Types.ObjectId): Promise<string> {
  let slug = slugifyPharmacyName(base);
  let n = 2;
  for (;;) {
    const clash = await Pharmacy.findOne({
      slug,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    })
      .select("_id")
      .lean();
    if (!clash) return slug;
    const suffix = `-${n}`;
    slug = slugifyPharmacyName(base).slice(0, 40 - suffix.length) + suffix;
    n += 1;
  }
}

function toSummary(
  doc: {
    _id: unknown;
    name: string;
    slug: string;
    legalName?: string | null;
    status?: string | null;
    ownerName?: string | null;
    ownerEmail?: string | null;
    notes?: string | null;
    createdAt?: Date;
  },
  lastLoginAt: Date | null = null,
): PharmacySummary {
  return {
    id: String(doc._id),
    name: doc.name,
    slug: doc.slug,
    legalName: doc.legalName ?? "",
    status: doc.status === "suspended" ? "suspended" : "active",
    ownerName: doc.ownerName ?? "",
    ownerEmail: doc.ownerEmail ?? "",
    notes: doc.notes ?? "",
    createdAt: doc.createdAt ?? null,
    lastLoginAt,
  };
}

export async function listPharmacies(options?: {
  q?: string;
  status?: "all" | "active" | "suspended";
  page?: number;
  pageSize?: number;
}): Promise<{ rows: PharmacySummary[]; total: number }> {
  await connectDB();

  const page = options?.page ?? 1;
  const pageSize = options?.pageSize ?? 25;
  const filter: Record<string, unknown> = {};
  if (options?.status && options.status !== "all") filter.status = options.status;
  if (options?.q?.trim()) {
    const safe = options.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(safe, "i");
    filter.$or = [
      { name: pattern },
      { slug: pattern },
      { ownerName: pattern },
      { ownerEmail: pattern },
    ];
  }

  const [docs, total] = await Promise.all([
    Pharmacy.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    Pharmacy.countDocuments(filter),
  ]);

  const ownerIds = docs
    .map((doc) => doc.ownerUserId)
    .filter((id): id is NonNullable<typeof id> => Boolean(id));
  const owners = ownerIds.length
    ? await User.find({ _id: { $in: ownerIds } })
        .select("lastLoginAt")
        .lean()
    : [];
  const lastLoginByOwner = new Map(
    owners.map((owner) => [String(owner._id), owner.lastLoginAt ?? null]),
  );

  return {
    rows: docs.map((doc) =>
      toSummary(doc, lastLoginByOwner.get(String(doc.ownerUserId)) ?? null),
    ),
    total,
  };
}

export async function pharmacyCounts(): Promise<{
  total: number;
  active: number;
  suspended: number;
}> {
  await connectDB();
  const [total, active, suspended] = await Promise.all([
    Pharmacy.countDocuments(),
    Pharmacy.countDocuments({ status: "active" }),
    Pharmacy.countDocuments({ status: "suspended" }),
  ]);
  return { total, active, suspended };
}

export async function getPharmacy(id: string): Promise<PharmacySummary> {
  await connectDB();
  const doc = await Pharmacy.findById(id).lean();
  if (!doc) throw ApiError.notFound("That pharmacy no longer exists.");

  const owner = doc.ownerUserId
    ? await User.findById(doc.ownerUserId).select("lastLoginAt").lean()
    : null;

  return toSummary(doc, owner?.lastLoginAt ?? null);
}

/**
 * Create a pharmacy, its settings, its default outlet, and the owner login.
 *
 * All four are created together so the owner can sign in immediately and land
 * on an empty but working shop rather than a half-provisioned one.
 */
export async function createPharmacy(
  input: CreatePharmacyInput,
  actor: SessionUser,
): Promise<PharmacySummary> {
  await connectDB();

  const email = input.ownerEmail;
  const existingUser = await User.findOne({ email }).select("_id").lean();
  if (existingUser) {
    throw ApiError.conflict("That email is already used by another account.");
  }

  const slug = await uniqueSlug(input.slug || input.name);

  return withTransaction(async ({ session }) => {
    const [pharmacy] = await Pharmacy.create(
      [
        {
          name: input.name,
          slug,
          legalName: input.legalName,
          status: "active",
          ownerName: input.ownerName,
          ownerEmail: email,
          notes: input.notes,
          createdBy: new Types.ObjectId(actor.id),
          createdByName: actor.name,
        },
      ],
      sessionOption(session),
    );
    if (!pharmacy) throw new Error("Pharmacy was not created.");

    await Setting.create(
      [
        {
          pharmacyId: pharmacy._id,
          key: "business",
          ...DEFAULT_SETTINGS,
          businessName: input.name,
          legalName: input.legalName,
          pan: input.pan,
          vatNumber: input.pan,
          address: input.address,
          city: input.city,
          phone: input.phone,
        },
      ],
      sessionOption(session),
    );

    const [branch] = await Branch.create(
      [
        {
          pharmacyId: pharmacy._id,
          code: "main",
          name: input.name,
          address: [input.address, input.city].filter(Boolean).join(", "),
          phone: input.phone,
          panNo: input.pan,
          isDefault: true,
          isActive: true,
          notes: "Created automatically as the default outlet.",
        },
      ],
      sessionOption(session),
    );
    if (!branch) throw new Error("Default branch was not created.");

    const [owner] = await User.create(
      [
        {
          name: input.ownerName,
          email,
          passwordHash: await hashPassword(input.ownerPassword),
          role: "admin",
          pharmacyId: pharmacy._id,
          branchId: branch._id,
          isActive: true,
        },
      ],
      sessionOption(session),
    );
    if (!owner) throw new Error("Owner account was not created.");

    pharmacy.ownerUserId = owner._id;
    await pharmacy.save({ session: session ?? undefined });

    return toSummary(pharmacy.toObject());
  });
}

export async function updatePharmacy(
  id: string,
  input: UpdatePharmacyInput,
): Promise<PharmacySummary> {
  await connectDB();

  const pharmacy = await Pharmacy.findById(id);
  if (!pharmacy) throw ApiError.notFound("That pharmacy no longer exists.");

  if (input.name !== undefined) pharmacy.name = input.name;
  if (input.legalName !== undefined) pharmacy.legalName = input.legalName;
  if (input.notes !== undefined) pharmacy.notes = input.notes;
  await pharmacy.save();

  return toSummary(pharmacy.toObject());
}

export async function setPharmacyStatus(
  id: string,
  status: "active" | "suspended",
): Promise<PharmacySummary> {
  await connectDB();

  const pharmacy = await Pharmacy.findById(id);
  if (!pharmacy) throw ApiError.notFound("That pharmacy no longer exists.");

  pharmacy.status = status;
  await pharmacy.save();
  return toSummary(pharmacy.toObject());
}

export async function resetOwnerPassword(id: string, password: string): Promise<void> {
  await connectDB();

  const pharmacy = await Pharmacy.findById(id).select("ownerUserId name").lean();
  if (!pharmacy) throw ApiError.notFound("That pharmacy no longer exists.");
  if (!pharmacy.ownerUserId) {
    throw ApiError.conflict(
      `${pharmacy.name} has no owner account to reset. Create a new pharmacy instead.`,
    );
  }

  const owner = await User.findById(pharmacy.ownerUserId);
  if (!owner) {
    throw ApiError.conflict(
      `${pharmacy.name}'s owner account is missing. Create a new pharmacy instead.`,
    );
  }

  owner.passwordHash = await hashPassword(password);
  await owner.save();
}
