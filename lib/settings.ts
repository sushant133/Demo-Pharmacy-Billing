import { config } from "@/lib/config";
import { connectDB } from "@/lib/db";
import { invalidateTtl, onceTtl } from "@/lib/ttl-cache";
import { Branch } from "@/models/Branch";
import { Setting } from "@/models/Setting";
import type { SettingsInput } from "@/lib/validation";

/**
 * The shop's own details.
 *
 * One record, read on nearly every page - the bill header, the letterhead on
 * an exported report, the browser title, the sign-in card - so it is cached
 * for a few seconds rather than fetched each time, and the cache is dropped
 * the moment someone saves.
 *
 * Reads never throw. The settings record is decoration on most screens and the
 * legally-required header on one; a Mongo hiccup should degrade the first and
 * be visible on the second, not return a 500 for the whole application. When
 * the database cannot be reached the environment defaults are used, which is
 * exactly where these values lived before this record existed.
 */

const CACHE_KEY = "business-settings";
const CACHE_MS = 15_000;

export interface BusinessSettings {
  businessName: string;
  legalName: string;
  pan: string;
  vatRegistered: boolean;
  vatNumber: string;
  /** A fraction, not a percentage: 0.13 is 13%. */
  vatRate: number;
  drugLicenceNo: string;
  registrationNo: string;
  address: string;
  city: string;
  phone: string;
  altPhone: string;
  email: string;
  website: string;
  billTerms: string;
  billFooterNote: string;
}

/**
 * What a pharmacy sees before it has saved anything.
 *
 * Seeded from the environment so an existing install keeps the name and PAN it
 * already prints, and so the bill terms are not blank on day one.
 */
export const DEFAULT_SETTINGS: BusinessSettings = {
  businessName: config.business.name,
  legalName: "",
  pan: config.business.pan,
  vatRegistered: true,
  vatNumber: config.business.pan,
  vatRate: config.vatRate,
  drugLicenceNo: "",
  registrationNo: "",
  address: config.business.address,
  city: "",
  phone: config.business.phone,
  altPhone: "",
  email: "",
  website: "",
  billTerms:
    "Goods once sold are not returnable except as required by law. Keep this tax invoice for your records.",
  billFooterNote: "Thank you.",
};

type SettingsShape = Partial<Record<keyof BusinessSettings, unknown>>;

/** Fill every field, so a record saved before a field existed still reads. */
function hydrate(doc: SettingsShape | null): BusinessSettings {
  if (!doc) return { ...DEFAULT_SETTINGS };

  const str = (value: unknown, fallback = ""): string =>
    typeof value === "string" ? value : fallback;

  return {
    businessName: str(doc.businessName, DEFAULT_SETTINGS.businessName),
    legalName: str(doc.legalName),
    pan: str(doc.pan),
    vatRegistered: doc.vatRegistered !== false,
    vatNumber: str(doc.vatNumber),
    vatRate:
      typeof doc.vatRate === "number" && doc.vatRate >= 0 && doc.vatRate <= 1
        ? doc.vatRate
        : DEFAULT_SETTINGS.vatRate,
    drugLicenceNo: str(doc.drugLicenceNo),
    registrationNo: str(doc.registrationNo),
    address: str(doc.address),
    city: str(doc.city),
    phone: str(doc.phone),
    altPhone: str(doc.altPhone),
    email: str(doc.email),
    website: str(doc.website),
    billTerms: str(doc.billTerms),
    billFooterNote: str(doc.billFooterNote),
  };
}

async function loadSettings(): Promise<BusinessSettings> {
  await connectDB();
  const doc = await Setting.findOne({ key: "business" }).lean();
  return hydrate(doc as SettingsShape | null);
}

/** The shop's details. Falls back to the environment if Mongo is unreachable. */
export async function getSettings(): Promise<BusinessSettings> {
  try {
    return await onceTtl(CACHE_KEY, CACHE_MS, loadSettings);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Write the details and return what was stored.
 *
 * Upserts, because the first save is also the record's creation - a pharmacy
 * should not have to be told to "initialise settings" before it can type its
 * own name in.
 */
export async function saveSettings(
  input: SettingsInput,
): Promise<BusinessSettings> {
  await connectDB();

  // The form asks for a percentage because that is how people say it; the
  // record stores a fraction because that is how the VAT maths uses it.
  const { vatRate, ...rest } = input;

  const doc = await Setting.findOneAndUpdate(
    { key: "business" },
    { $set: { ...rest, vatRate: round4(vatRate / 100) }, $setOnInsert: { key: "business" } },
    { new: true, upsert: true, runValidators: true },
  ).lean();

  invalidateTtl(CACHE_KEY);
  return hydrate(doc as SettingsShape | null);
}

/** Percentage for display, from the stored fraction. */
export function vatPercent(settings: BusinessSettings): number {
  return round4(settings.vatRate * 100);
}

/**
 * The identity to print, given the outlet that issued the document.
 *
 * A branch that has been given its own name, address, phone or PAN prints
 * those - a VAT invoice must carry the issuing outlet's identity. Anything the
 * branch left blank falls through to the shop's own record, which is what a
 * single-outlet pharmacy relies on entirely.
 */
export interface Issuer {
  name: string;
  address: string;
  phone: string;
  pan: string;
}

export function issuerFor(
  settings: BusinessSettings,
  branch?: {
    name?: string | null;
    address?: string | null;
    phone?: string | null;
    panNo?: string | null;
  } | null,
): Issuer {
  return {
    name: branch?.name || settings.businessName,
    address: branch?.address || [settings.address, settings.city].filter(Boolean).join(", "),
    phone: branch?.phone || settings.phone,
    pan: branch?.panNo || settings.pan,
  };
}

/**
 * The identity to print on a document issued by a given outlet.
 *
 * A single-outlet pharmacy - nearly all of them - prints what Settings says,
 * and nothing else gets a vote. Once a second outlet is open, each one's own
 * name, address, phone and PAN take over wherever it has them, because a VAT
 * invoice must carry the identity of the outlet that issued it.
 *
 * The branch count is what makes editing Settings actually change the bill.
 * `ensureDefaultBranch` creates the first outlet by copying the shop's name
 * into it, so treating that copy as an override would mean an owner could
 * rename the pharmacy in Settings, print a receipt, and find the old name
 * still at the top of it.
 */
export async function printedIssuer(
  settings: BusinessSettings,
  branchId?: unknown,
): Promise<Issuer> {
  if (!branchId) return issuerFor(settings, null);

  try {
    if ((await activeBranchCount()) <= 1) return issuerFor(settings, null);

    await connectDB();
    const branch = await Branch.findById(branchId)
      .select("name address phone panNo")
      .lean();
    return issuerFor(settings, branch);
  } catch {
    // A bill that prints the shop's own header beats one that fails to print.
    return issuerFor(settings, null);
  }
}

function activeBranchCount(): Promise<number> {
  return onceTtl("active-branch-count", CACHE_MS, async () => {
    await connectDB();
    return Branch.countDocuments({ isActive: true });
  });
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
