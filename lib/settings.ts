import { Types } from "mongoose";
import { config } from "@/lib/config";
import { connectDB } from "@/lib/db";
import {
  DEFAULT_PRINT_TEMPLATE,
  printTemplate,
  type PrintTemplate,
} from "@/lib/print-templates";
import { invalidateTtl, onceTtl } from "@/lib/ttl-cache";
import { Branch } from "@/models/Branch";
import { Pharmacy } from "@/models/Pharmacy";
import { Setting } from "@/models/Setting";
import type { SettingsInput } from "@/lib/validation";

/**
 * One pharmacy's own details.
 *
 * One record per pharmacy, read on nearly every page - the bill header, the
 * letterhead on an exported report, the browser title, the sign-in card for
 * staff who already know which shop they are in - so it is cached for a few
 * seconds rather than fetched each time, and the cache is dropped the moment
 * someone saves.
 *
 * Reads never throw. The settings record is decoration on most screens and the
 * legally-required header on one; a Mongo hiccup should degrade the first and
 * be visible on the second, not return a 500 for the whole application. When
 * the database cannot be reached the environment defaults are used, which is
 * exactly where these values lived before this record existed.
 *
 * Superadmin and the public login screen have no pharmacy, so they see the
 * platform defaults rather than any one shop's identity.
 */

const CACHE_MS = 15_000;

function cacheKey(pharmacyId: string): string {
  return `business-settings:${pharmacyId}`;
}

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
  /** Shop-defined medicine categories, on top of the built-in list. */
  medicineCategories: string[];
}

/**
 * The fields the shop may read but not write.
 *
 * The business's registered identity: the names a bill is headed with, the
 * tax numbers it is filed under, and the licences that make it lawful to
 * dispense. Superadmin sets them on the pharmacy record; `getSettings`
 * overlays them here so the bill header, the PDF and every preview go on
 * reading `settings.pan` as they always have.
 *
 * Kept as a list so the Settings screen and the tests can both ask which
 * fields are locked, rather than each keeping its own copy of the answer.
 */
export const PLATFORM_IDENTITY_FIELDS = [
  "businessName",
  "legalName",
  "pan",
  "vatNumber",
  "vatRegistered",
  "registrationNo",
  "drugLicenceNo",
] as const;

export type PlatformIdentityField = (typeof PLATFORM_IDENTITY_FIELDS)[number];

/** Just the locked fields, as the platform holds them. */
export type PlatformIdentity = Pick<BusinessSettings, PlatformIdentityField>;

/** The locked half of a settings record, for a screen that shows it read-only. */
export function platformIdentity(settings: BusinessSettings): PlatformIdentity {
  return {
    businessName: settings.businessName,
    legalName: settings.legalName,
    pan: settings.pan,
    vatNumber: settings.vatNumber,
    vatRegistered: settings.vatRegistered,
    registrationNo: settings.registrationNo,
    drugLicenceNo: settings.drugLicenceNo,
  };
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
  medicineCategories: [],
};

type SettingsShape = Partial<Record<keyof BusinessSettings, unknown>>;

/**
 * The platform's record of one shop, as the overlay reads it.
 *
 * `name` rather than `businessName`: this is the Pharmacy document, where the
 * trading name is the account's name.
 */
interface PlatformShape {
  name?: unknown;
  legalName?: unknown;
  pan?: unknown;
  vatNumber?: unknown;
  vatRegistered?: unknown;
  registrationNo?: unknown;
  drugLicenceNo?: unknown;
}

/**
 * Fill every field, so a record saved before a field existed still reads.
 *
 * `platform` wins outright over the shop's own record wherever it is given.
 * It is not a fallback for a blank: superadmin clearing a licence that has
 * lapsed has to actually clear it, and a stale value left behind in the
 * Setting document would quietly keep printing it.
 */
function hydrate(
  doc: SettingsShape | null,
  fallbackName?: string | null,
  platform?: PlatformShape | null,
): BusinessSettings {
  const str = (value: unknown, fallback = ""): string =>
    typeof value === "string" ? value : fallback;

  // A pharmacy with no settings row must still wear its own name, never the
  // platform default - that is how one vendor would see "Mantra Pharmacy"
  // on another shop's door.
  const defaultName = fallbackName?.trim() || "";

  const identity: PlatformIdentity | null = platform
    ? {
        businessName: str(platform.name, defaultName),
        legalName: str(platform.legalName),
        pan: str(platform.pan),
        vatNumber: str(platform.vatNumber),
        vatRegistered: platform.vatRegistered !== false,
        registrationNo: str(platform.registrationNo),
        drugLicenceNo: str(platform.drugLicenceNo),
      }
    : null;

  if (!doc) {
    return {
      ...DEFAULT_SETTINGS,
      businessName: defaultName,
      ...identity,
    };
  }

  return {
    businessName: str(doc.businessName, defaultName || DEFAULT_SETTINGS.businessName),
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
    billTerms: str(doc.billTerms, DEFAULT_SETTINGS.billTerms),
    billFooterNote: str(doc.billFooterNote, DEFAULT_SETTINGS.billFooterNote),
    medicineCategories: Array.isArray(doc.medicineCategories)
      ? doc.medicineCategories
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
      : [],
    ...identity,
  };
}

function asObjectId(pharmacyId: string | Types.ObjectId): Types.ObjectId {
  return typeof pharmacyId === "string"
    ? new Types.ObjectId(pharmacyId)
    : pharmacyId;
}

async function loadSettings(
  pharmacyId: string | Types.ObjectId,
  fallbackName?: string | null,
): Promise<BusinessSettings> {
  await connectDB();
  const id = asObjectId(pharmacyId);

  // Two documents, one object. The shop owns its address, its wording and
  // its categories; the platform owns the names, tax numbers and licences a
  // tax invoice is judged on. Everything downstream - the bill header, the
  // PDF, the previews - reads the merged result and does not need to know
  // which half a field came from.
  const [doc, platform] = await Promise.all([
    Setting.findOne({ pharmacyId: id, key: "business" }).lean(),
    Pharmacy.findById(id)
      .select("name legalName pan vatNumber vatRegistered registrationNo drugLicenceNo")
      .lean(),
  ]);

  return hydrate(
    doc as SettingsShape | null,
    fallbackName,
    platform as PlatformShape | null,
  );
}

/**
 * One pharmacy's details. Pass no id for the platform defaults (login screen,
 * superadmin, or Mongo unreachable).
 *
 * `fallbackName` is the pharmacy's own name from the session, so a missing
 * settings record still brands the shop as itself rather than the platform.
 */
export async function getSettings(
  pharmacyId?: string | Types.ObjectId | null,
  fallbackName?: string | null,
): Promise<BusinessSettings> {
  if (!pharmacyId) {
    return {
      ...DEFAULT_SETTINGS,
      ...(fallbackName?.trim() ? { businessName: fallbackName.trim() } : {}),
    };
  }

  try {
    return await onceTtl(cacheKey(String(pharmacyId)), CACHE_MS, () =>
      loadSettings(pharmacyId, fallbackName),
    );
  } catch {
    return {
      ...DEFAULT_SETTINGS,
      businessName: fallbackName?.trim() || "",
    };
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
  pharmacyId: string | Types.ObjectId,
): Promise<BusinessSettings> {
  await connectDB();

  // The form asks for a percentage because that is how people say it; the
  // record stores a fraction because that is how the VAT maths uses it.
  const { vatRate, ...rest } = input;
  const id = asObjectId(pharmacyId);

  /*
    `rest` cannot contain a name, a PAN, a VAT number or a licence: those are
    not in `settingsSchema`, so the parser drops them before this function is
    reached. That is the whole guarantee - nothing here has to remember to
    strip them, and a request that invents them gets nowhere.
  */
  await Setting.findOneAndUpdate(
    { pharmacyId: id, key: "business" },
    {
      $set: { ...rest, vatRate: round4(vatRate / 100) },
      $setOnInsert: { pharmacyId: id, key: "business" },
    },
    { new: true, upsert: true, runValidators: true },
  ).lean();

  invalidateTtl(cacheKey(String(pharmacyId)));
  invalidateTtl(`active-branch-count:${String(pharmacyId)}`);

  // Re-read rather than hydrating the write: what comes back has to carry
  // the platform's half of the record too, and that half was not part of
  // this save.
  return loadSettings(id);
}

/**
 * Drop a pharmacy's cached details after superadmin has changed its identity.
 *
 * Without this, a corrected PAN would sit unused for up to fifteen seconds
 * while bills went on printing the old one.
 */
export function invalidateSettings(pharmacyId: string | Types.ObjectId): void {
  invalidateTtl(cacheKey(String(pharmacyId)));
}

/** Percentage for display, from the stored fraction. */
export function vatPercent(settings: BusinessSettings): number {
  return round4(settings.vatRate * 100);
}

function templateCacheKey(pharmacyId: string): string {
  return `print-template:${pharmacyId}`;
}

/**
 * The bill layout this pharmacy's printer can produce.
 *
 * Lives on the platform's pharmacy record rather than in Settings, because it
 * describes the hardware on the counter and only superadmin sets it. Read on
 * every printed bill, credit note and downloaded invoice, so it is cached
 * beside the shop's own details and for the same few seconds.
 *
 * Like `getSettings`, this never throws: an unreachable database gives back
 * the 80mm roll, which is what every pharmacy could print before templates
 * existed. Paper that is the wrong size beats a bill that will not render.
 */
export async function getPrintTemplate(
  pharmacyId?: string | Types.ObjectId | null,
): Promise<PrintTemplate> {
  if (!pharmacyId) return printTemplate(DEFAULT_PRINT_TEMPLATE);

  try {
    const id = await onceTtl(templateCacheKey(String(pharmacyId)), CACHE_MS, async () => {
      await connectDB();
      const doc = await Pharmacy.findById(asObjectId(pharmacyId))
        .select("printTemplate")
        .lean();
      return doc?.printTemplate ?? DEFAULT_PRINT_TEMPLATE;
    });
    return printTemplate(id);
  } catch {
    return printTemplate(DEFAULT_PRINT_TEMPLATE);
  }
}

/** Drop the cached layout after superadmin has changed it. */
export function invalidatePrintTemplate(pharmacyId: string | Types.ObjectId): void {
  invalidateTtl(templateCacheKey(String(pharmacyId)));
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
  pharmacyId?: string | Types.ObjectId | null,
): Promise<Issuer> {
  if (!branchId) return issuerFor(settings, null);

  try {
    if ((await activeBranchCount(pharmacyId)) <= 1) return issuerFor(settings, null);

    await connectDB();
    const filter: Record<string, unknown> = { _id: branchId };
    if (pharmacyId) filter.pharmacyId = asObjectId(pharmacyId);
    const branch = await Branch.findOne(filter).select("name address phone panNo").lean();
    return issuerFor(settings, branch);
  } catch {
    // A bill that prints the shop's own header beats one that fails to print.
    return issuerFor(settings, null);
  }
}

function activeBranchCount(
  pharmacyId?: string | Types.ObjectId | null,
): Promise<number> {
  const key = `active-branch-count:${pharmacyId ? String(pharmacyId) : "none"}`;
  return onceTtl(key, CACHE_MS, async () => {
    await connectDB();
    const filter: Record<string, unknown> = { isActive: true };
    if (pharmacyId) filter.pharmacyId = asObjectId(pharmacyId);
    return Branch.countDocuments(filter);
  });
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
