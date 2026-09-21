import { Types } from "mongoose";
import { ApiError } from "@/lib/api";
import { hashPassword } from "@/lib/auth";
import { ROLE_SCHEME_VERSION } from "@/lib/roles";
import { connectDB } from "@/lib/db";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { printTemplate, type PrintTemplateId } from "@/lib/print-templates";
import { slugifyPharmacyName } from "@/lib/tenant";
import { sessionOption, withTransaction } from "@/lib/transaction";
import type {
  CreatePharmacyInput,
  UpdateOwnerInput,
  UpdatePharmacyInput,
} from "@/lib/validation";
import type { SessionUser } from "@/lib/session";
import { Batch } from "@/models/Batch";
import { Branch } from "@/models/Branch";
import { Counter } from "@/models/Counter";
import { Customer } from "@/models/Customer";
import { Expense } from "@/models/Expense";
import { Medicine } from "@/models/Medicine";
import { Pharmacy } from "@/models/Pharmacy";
import { Prescription } from "@/models/Prescription";
import { Purchase } from "@/models/Purchase";
import { Sale } from "@/models/Sale";
import { Setting } from "@/models/Setting";
import { StockMovement } from "@/models/StockMovement";
import { Supplier } from "@/models/Supplier";
import { SupplierPayment } from "@/models/SupplierPayment";
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
  /** Why access was last changed, and when. Blank on a shop nobody has touched. */
  statusReason: string;
  statusChangedAt: Date | null;
  pan: string;
  vatNumber: string;
  vatRegistered: boolean;
  registrationNo: string;
  drugLicenceNo: string;
  licenceExpiry: Date | null;
  address: string;
  city: string;
  phone: string;
  email: string;
  ownerName: string;
  ownerEmail: string;
  ownerPhone: string;
  ownerCitizenshipNo: string;
  notes: string;
  /** Which bill layout this shop prints. See lib/print-templates.ts. */
  printTemplate: PrintTemplateId;
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

/**
 * A stored pharmacy as the platform screens read it.
 *
 * Every optional field collapses to "" or null here rather than reaching a
 * component as undefined: a shop created before a field existed and one that
 * simply left it blank are the same thing to anyone reading the screen, and
 * the alternative is a dozen `?? ""` at each call site.
 */
function toSummary(
  doc: {
    _id: unknown;
    name: string;
    slug: string;
    legalName?: string | null;
    status?: string | null;
    statusReason?: string | null;
    statusChangedAt?: Date | null;
    pan?: string | null;
    vatNumber?: string | null;
    vatRegistered?: boolean | null;
    registrationNo?: string | null;
    drugLicenceNo?: string | null;
    licenceExpiry?: Date | null;
    address?: string | null;
    city?: string | null;
    phone?: string | null;
    email?: string | null;
    ownerName?: string | null;
    ownerEmail?: string | null;
    ownerPhone?: string | null;
    ownerCitizenshipNo?: string | null;
    notes?: string | null;
    printTemplate?: string | null;
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
    statusReason: doc.statusReason ?? "",
    statusChangedAt: doc.statusChangedAt ?? null,
    pan: doc.pan ?? "",
    vatNumber: doc.vatNumber ?? "",
    vatRegistered: doc.vatRegistered !== false,
    registrationNo: doc.registrationNo ?? "",
    drugLicenceNo: doc.drugLicenceNo ?? "",
    licenceExpiry: doc.licenceExpiry ?? null,
    address: doc.address ?? "",
    city: doc.city ?? "",
    phone: doc.phone ?? "",
    email: doc.email ?? "",
    ownerName: doc.ownerName ?? "",
    ownerEmail: doc.ownerEmail ?? "",
    ownerPhone: doc.ownerPhone ?? "",
    ownerCitizenshipNo: doc.ownerCitizenshipNo ?? "",
    notes: doc.notes ?? "",
    printTemplate: printTemplate(doc.printTemplate).id,
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
    // Support calls arrive quoting whatever the caller has to hand: the shop's
    // name, the owner's email, a PAN off a bill, a phone number.
    filter.$or = [
      { name: pattern },
      { slug: pattern },
      { legalName: pattern },
      { ownerName: pattern },
      { ownerEmail: pattern },
      { ownerPhone: pattern },
      { phone: pattern },
      { pan: pattern },
      { registrationNo: pattern },
      { drugLicenceNo: pattern },
      { city: pattern },
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
 *
 * Each step registers its undo. On a replica set the transaction's abort does
 * that; on a standalone MongoDB - which lib/transaction.ts exists to support,
 * and which a plain VPS install is - there is no abort, so without these a
 * duplicate owner email racing in after the pre-check left a pharmacy, its
 * settings and its outlet behind with no account able to sign in to them, and
 * the slug taken. Exactly the half-provisioned shop above.
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

  // Twelve bcrypt rounds, hashed before the unit of work opens rather than
  // inside it: it held a Mongo transaction open for the duration, and a write
  // conflict retried the whole function and paid for it again.
  const passwordHash = await hashPassword(input.ownerPassword);

  return withTransaction(async ({ session, onRollback }) => {
    const [pharmacy] = await Pharmacy.create(
      [
        {
          name: input.name,
          slug,
          legalName: input.legalName,
          status: "active",
          pan: input.pan,
          vatNumber: input.vatNumber || input.pan,
          vatRegistered: input.vatRegistered,
          registrationNo: input.registrationNo,
          drugLicenceNo: input.drugLicenceNo,
          licenceExpiry: input.licenceExpiry,
          address: input.address,
          city: input.city,
          phone: input.phone,
          email: input.email,
          ownerName: input.ownerName,
          ownerEmail: email,
          ownerPhone: input.ownerPhone,
          ownerCitizenshipNo: input.ownerCitizenshipNo,
          notes: input.notes,
          printTemplate: input.printTemplate,
          createdBy: new Types.ObjectId(actor.id),
          createdByName: actor.name,
        },
      ],
      sessionOption(session),
    );
    if (!pharmacy) throw new Error("Pharmacy was not created.");
    onRollback(() => Pharmacy.deleteOne({ _id: pharmacy._id }).exec());

    /*
      The shop's half of the record, seeded with the contact details the
      platform was told so the first printed bill is not blank. From here
      these are the shop's to correct from its own Settings screen.

      The names, PAN, VAT number and licences are deliberately absent. They
      live on the pharmacy document above and `getSettings` overlays them,
      so writing a second copy here would only create a stale one - the copy
      that keeps printing a licence number after superadmin has corrected it.
    */
    const [setting] = await Setting.create(
      [
        {
          pharmacyId: pharmacy._id,
          key: "business",
          ...DEFAULT_SETTINGS,
          businessName: input.name,
          address: input.address,
          city: input.city,
          phone: input.phone,
          email: input.email,
        },
      ],
      sessionOption(session),
    );
    if (setting) {
      onRollback(() => Setting.deleteOne({ _id: setting._id }).exec());
    }

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
    onRollback(() => Branch.deleteOne({ _id: branch._id }).exec());

    const [owner] = await User.create(
      [
        {
          name: input.ownerName,
          email,
          passwordHash,
          role: "admin",
          roleVersion: ROLE_SCHEME_VERSION,
          pharmacyId: pharmacy._id,
          branchId: branch._id,
          isActive: true,
        },
      ],
      sessionOption(session),
    );
    if (!owner) throw new Error("Owner account was not created.");
    onRollback(() => User.deleteOne({ _id: owner._id }).exec());

    pharmacy.ownerUserId = owner._id;
    await pharmacy.save({ session: session ?? undefined });

    return toSummary(pharmacy.toObject());
  });
}

/**
 * Correct the platform's record of a shop.
 *
 * This is the bill header. The trading name, registered name, PAN, VAT
 * number, company registration and drug licence written here are what every
 * future invoice prints, what the owner sees in their sidebar, and what the
 * Settings screen shows them read-only. The shop keeps its address, its
 * phone, its terms and its footer line.
 *
 * The split is deliberate: a pharmacy that can type its own PAN is a
 * pharmacy that can issue tax invoices under a number nobody verified, and
 * the platform is the one being asked to vouch for it.
 *
 * Callers must drop the cached settings afterwards - see
 * `invalidateSettings` - or bills keep printing the old details for the few
 * seconds the cache lives.
 */
export async function updatePharmacy(
  id: string,
  input: UpdatePharmacyInput,
): Promise<PharmacySummary> {
  await connectDB();

  const pharmacy = await Pharmacy.findById(id);
  if (!pharmacy) throw ApiError.notFound("That pharmacy no longer exists.");

  pharmacy.name = input.name;
  pharmacy.legalName = input.legalName;
  pharmacy.pan = input.pan;
  pharmacy.vatNumber = input.vatNumber;
  pharmacy.vatRegistered = input.vatRegistered;
  pharmacy.registrationNo = input.registrationNo;
  pharmacy.drugLicenceNo = input.drugLicenceNo;
  pharmacy.licenceExpiry = input.licenceExpiry;
  pharmacy.address = input.address;
  pharmacy.city = input.city;
  pharmacy.phone = input.phone;
  pharmacy.email = input.email;
  pharmacy.ownerPhone = input.ownerPhone;
  pharmacy.ownerCitizenshipNo = input.ownerCitizenshipNo;
  pharmacy.notes = input.notes;
  await pharmacy.save();

  return toSummary(pharmacy.toObject());
}

/**
 * How many pharmacies print on each template.
 *
 * Shown in the gallery so a layout nobody uses is visibly a layout nobody
 * uses, and so the effect of withdrawing one can be seen before it is
 * withdrawn. Counts only - this reads no shop's records.
 */
export async function countPharmaciesByTemplate(): Promise<
  Partial<Record<PrintTemplateId, number>>
> {
  await connectDB();
  const rows = await Pharmacy.aggregate<{ _id: string | null; count: number }>([
    { $group: { _id: "$printTemplate", count: { $sum: 1 } } },
  ]);

  const counts: Partial<Record<PrintTemplateId, number>> = {};
  for (const row of rows) {
    // A record written before this field existed still prints on the
    // default, so it is counted against the default.
    const id = printTemplate(row._id).id;
    counts[id] = (counts[id] ?? 0) + row.count;
  }
  return counts;
}

/**
 * Point a pharmacy at a different bill layout.
 *
 * Separate from `updatePharmacy` because it is a different kind of decision:
 * the profile form records what the platform knows about a business, this
 * records what its printer can physically produce. Mixing them would mean a
 * stray keystroke in an address field could also be the moment a shop's bills
 * started coming out cut in half.
 *
 * Takes effect on the next bill printed. Bills already issued are unchanged -
 * they were printed on the paper that was in the machine at the time, and
 * re-rendering history to match today's hardware would be a lie.
 */
export async function setPharmacyPrintTemplate(
  id: string,
  templateId: PrintTemplateId,
): Promise<PharmacySummary> {
  await connectDB();

  const pharmacy = await Pharmacy.findById(id);
  if (!pharmacy) throw ApiError.notFound("That pharmacy no longer exists.");

  pharmacy.printTemplate = templateId;
  await pharmacy.save();

  return toSummary(pharmacy.toObject());
}

/**
 * Move the owner login to a different person or address.
 *
 * Both records move together. The `User` row is what the login screen checks
 * and the `Pharmacy` row is what every platform screen displays, so updating
 * one without the other leaves a panel confidently showing an address that
 * cannot sign in.
 */
export async function updatePharmacyOwner(
  id: string,
  input: UpdateOwnerInput,
): Promise<PharmacySummary> {
  await connectDB();

  const pharmacy = await Pharmacy.findById(id);
  if (!pharmacy) throw ApiError.notFound("That pharmacy no longer exists.");
  if (!pharmacy.ownerUserId) {
    throw ApiError.conflict(
      `${pharmacy.name} has no owner account to change. Create a new pharmacy instead.`,
    );
  }

  const owner = await User.findById(pharmacy.ownerUserId);
  if (!owner) {
    throw ApiError.conflict(
      `${pharmacy.name}'s owner account is missing. Create a new pharmacy instead.`,
    );
  }

  // Checked before writing so the caller gets "that email is taken" rather
  // than a duplicate-key error naming an index.
  if (input.ownerEmail !== owner.email) {
    const clash = await User.findOne({ email: input.ownerEmail })
      .select("_id")
      .lean();
    if (clash) {
      throw ApiError.conflict("That email is already used by another account.");
    }
  }

  owner.name = input.ownerName;
  owner.email = input.ownerEmail;
  await owner.save();

  pharmacy.ownerName = input.ownerName;
  pharmacy.ownerEmail = input.ownerEmail;
  await pharmacy.save();

  return toSummary(pharmacy.toObject());
}

export async function setPharmacyStatus(
  id: string,
  status: "active" | "suspended",
  reason = "",
): Promise<PharmacySummary> {
  await connectDB();

  const pharmacy = await Pharmacy.findById(id);
  if (!pharmacy) throw ApiError.notFound("That pharmacy no longer exists.");

  pharmacy.status = status;
  pharmacy.statusReason = reason;
  pharmacy.statusChangedAt = new Date();
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

// ---------------------------------------------------------------------------
// What a shop is actually doing
// ---------------------------------------------------------------------------

export interface PharmacyStats {
  branches: number;
  activeBranches: number;
  users: number;
  activeUsers: number;
  medicines: number;
  customers: number;
  suppliers: number;
  /** Lots in stock and what they are worth at cost. */
  lots: number;
  stockValue: number;
  bills: number;
  /** Revenue net of returns, over the whole life of the account. */
  revenue: number;
  billsLast30: number;
  revenueLast30: number;
  purchases: number;
  lastSaleAt: Date | null;
}

/**
 * The health of one account, in the figures a platform operator asks about.
 *
 * Deliberately all counts and sums, never rows: this is "is this shop using
 * the system, and how heavily", not a window into their books. A superadmin
 * who needs the detail has two honest routes - a backup file, or signing in
 * as the owner, which is recorded.
 */
export async function pharmacyStats(
  id: string | Types.ObjectId,
): Promise<PharmacyStats> {
  await connectDB();
  const pharmacyId = new Types.ObjectId(String(id));
  const tenant = { pharmacyId };
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [
    branches,
    activeBranches,
    users,
    activeUsers,
    medicines,
    customers,
    suppliers,
    stock,
    sales,
    recent,
    purchases,
    lastSale,
  ] = await Promise.all([
    Branch.countDocuments(tenant),
    Branch.countDocuments({ ...tenant, isActive: { $ne: false } }),
    User.countDocuments(tenant),
    User.countDocuments({ ...tenant, isActive: { $ne: false } }),
    Medicine.countDocuments(tenant),
    Customer.countDocuments(tenant),
    Supplier.countDocuments(tenant),
    Batch.aggregate<{ lots: number; value: number }>([
      { $match: { ...tenant, quantity: { $gt: 0 } } },
      {
        $group: {
          _id: null,
          lots: { $sum: 1 },
          value: { $sum: { $multiply: ["$quantity", "$costPrice"] } },
        },
      },
    ]),
    Sale.aggregate<{ bills: number; revenue: number }>([
      { $match: { ...tenant, voidedAt: null } },
      {
        $group: {
          _id: null,
          bills: { $sum: 1 },
          revenue: {
            $sum: {
              $subtract: ["$taxableAmount", { $ifNull: ["$returnedTaxable", 0] }],
            },
          },
        },
      },
    ]),
    Sale.aggregate<{ bills: number; revenue: number }>([
      { $match: { ...tenant, voidedAt: null, createdAt: { $gte: since } } },
      {
        $group: {
          _id: null,
          bills: { $sum: 1 },
          revenue: {
            $sum: {
              $subtract: ["$taxableAmount", { $ifNull: ["$returnedTaxable", 0] }],
            },
          },
        },
      },
    ]),
    Purchase.countDocuments({ ...tenant, status: "posted" }),
    Sale.findOne(tenant).sort({ createdAt: -1 }).select("createdAt").lean(),
  ]);

  const round = (value: number) => Math.round(value * 100) / 100;

  return {
    branches,
    activeBranches,
    users,
    activeUsers,
    medicines,
    customers,
    suppliers,
    lots: stock[0]?.lots ?? 0,
    stockValue: round(stock[0]?.value ?? 0),
    bills: sales[0]?.bills ?? 0,
    revenue: round(sales[0]?.revenue ?? 0),
    billsLast30: recent[0]?.bills ?? 0,
    revenueLast30: round(recent[0]?.revenue ?? 0),
    purchases,
    lastSaleAt: lastSale?.createdAt ?? null,
  };
}

export interface PlatformOverview {
  pharmacies: number;
  active: number;
  suspended: number;
  branches: number;
  users: number;
  /** Shops that have rung up a bill in the last 30 days. */
  tradingLast30: number;
  billsLast30: number;
  revenueLast30: number;
  /** Licences that have run out, or run out within 30 days. */
  licencesExpiring: number;
}

/**
 * The platform in one line of figures.
 *
 * `tradingLast30` is the number worth watching: an account can be active,
 * paid for and completely unused, and only a count of shops that actually
 * billed something tells those apart.
 */
export async function platformOverview(): Promise<PlatformOverview> {
  await connectDB();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const soon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const [pharmacies, active, suspended, branches, users, recent, licences] =
    await Promise.all([
      Pharmacy.countDocuments(),
      Pharmacy.countDocuments({ status: "active" }),
      Pharmacy.countDocuments({ status: "suspended" }),
      Branch.countDocuments({ isActive: { $ne: false } }),
      User.countDocuments({ pharmacyId: { $ne: null } }),
      Sale.aggregate<{ _id: Types.ObjectId; bills: number; revenue: number }>([
        { $match: { voidedAt: null, createdAt: { $gte: since } } },
        {
          $group: {
            _id: "$pharmacyId",
            bills: { $sum: 1 },
            revenue: {
              $sum: {
                $subtract: ["$taxableAmount", { $ifNull: ["$returnedTaxable", 0] }],
              },
            },
          },
        },
      ]),
      Pharmacy.countDocuments({
        licenceExpiry: { $ne: null, $lte: soon },
      }),
    ]);

  return {
    pharmacies,
    active,
    suspended,
    branches,
    users,
    tradingLast30: recent.length,
    billsLast30: recent.reduce((sum, row) => sum + row.bills, 0),
    revenueLast30:
      Math.round(recent.reduce((sum, row) => sum + row.revenue, 0) * 100) / 100,
    licencesExpiring: licences,
  };
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

/**
 * Every collection a pharmacy owns, and the field that ties it to the tenant.
 *
 * Counters are keyed `<pharmacyId>:<sequence>` rather than carrying a field,
 * so they are removed by prefix below. Anything added to the system that
 * carries a `pharmacyId` belongs in this list, or deleting a shop will leave
 * its rows behind under an id nothing points at any more.
 */
const TENANT_MODELS = [
  ["sales", Sale],
  ["purchases", Purchase],
  ["payments", SupplierPayment],
  ["prescriptions", Prescription],
  ["movements", StockMovement],
  ["expenses", Expense],
  ["batches", Batch],
  ["medicines", Medicine],
  ["customers", Customer],
  ["suppliers", Supplier],
  ["branches", Branch],
  ["settings", Setting],
  ["users", User],
] as const;

export type DeletedCounts = Record<string, number>;

/**
 * Structural rather than `Model<T>`: thirteen models with thirteen different
 * document types have thirteen incompatible `deleteMany` signatures, and the
 * union of them cannot be called. Only the shape matters here. Same trick as
 * `loadAll` in lib/pharmacy-backup.ts, for the same reason.
 */
type Deletable = {
  deleteMany: (filter: object) => { exec: () => Promise<{ deletedCount?: number }> };
};

async function purge(model: Deletable, filter: object): Promise<number> {
  const result = await model.deleteMany(filter).exec();
  return result.deletedCount ?? 0;
}

/**
 * Delete a pharmacy and everything it owns. There is no undo.
 *
 * Only a suspended shop can be deleted. That is not ceremony: suspending
 * first proves somebody deliberately took this account out of service, and it
 * gives whoever objects a window in which their data still exists. A shop
 * that is trading at this moment cannot be removed by one click.
 *
 * Deliberately not wrapped in a transaction. On a standalone MongoDB - which
 * this system supports and a plain VPS install is - there is none to roll
 * back, and a half-deleted shop is not a state worth pretending to avoid: the
 * operation is re-runnable, and running it twice finishes the job. The
 * pharmacy document itself goes last, so an interrupted delete leaves an
 * account that is still visible on this screen and can simply be deleted
 * again, rather than orphaned rows under an id nothing names.
 */
export async function deletePharmacy(
  id: string,
  confirm: string,
): Promise<{ name: string; slug: string; deleted: DeletedCounts }> {
  await connectDB();

  const pharmacy = await Pharmacy.findById(id);
  if (!pharmacy) throw ApiError.notFound("That pharmacy no longer exists.");

  if (pharmacy.status !== "suspended") {
    throw ApiError.conflict(
      `${pharmacy.name} is still active. Suspend it first, so nobody is cut off mid-shift by a deletion.`,
    );
  }
  if (confirm.trim().toLowerCase() !== pharmacy.slug) {
    throw ApiError.badRequest(
      `Type the short code (${pharmacy.slug}) exactly to confirm this deletion.`,
    );
  }

  const pharmacyId = pharmacy._id;
  const deleted: DeletedCounts = {};

  for (const [label, model] of TENANT_MODELS) {
    deleted[label] = await purge(model, { pharmacyId });
  }

  deleted.counters = await purge(Counter, {
    _id: { $regex: `^${String(pharmacyId)}:` },
  });

  await Pharmacy.deleteOne({ _id: pharmacyId });

  return { name: pharmacy.name, slug: pharmacy.slug, deleted };
}
