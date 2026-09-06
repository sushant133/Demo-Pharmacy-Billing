import { Types } from "mongoose";
import { ApiError } from "@/lib/api";
import type { SessionUser } from "@/lib/session";

/**
 * Tenant (pharmacy) isolation.
 *
 * Every shop document carries `pharmacyId`. These helpers are what stop one
 * pharmacy reading another's catalogue, stock or bills. An empty filter is
 * never returned for a live request: that is how two vendors would mix.
 */

export function isSuperAdmin(user: SessionUser): boolean {
  return user.role === "superadmin";
}

/** The pharmacy this session belongs to. Superadmin has none. */
export function pharmacyObjectId(user: SessionUser): Types.ObjectId {
  if (!user.pharmacyId || !Types.ObjectId.isValid(user.pharmacyId)) {
    throw ApiError.forbidden(
      "This action is only available inside a pharmacy account.",
    );
  }
  return new Types.ObjectId(user.pharmacyId);
}

/** Spread into a Mongoose filter so a query cannot leave this pharmacy. */
export function pharmacyFilter(user: SessionUser): { pharmacyId: Types.ObjectId } {
  return { pharmacyId: pharmacyObjectId(user) };
}

/**
 * Pharmacy clause taken from a viewing scope.
 *
 * A missing pharmacy id matches nothing rather than everything: forgetting
 * to stamp the tenant on a report must hide data, not leak it.
 */
export function pharmacyMatch(scope?: { pharmacyId?: Types.ObjectId | null } | null): {
  pharmacyId: Types.ObjectId | { $in: [] };
} {
  if (scope?.pharmacyId) return { pharmacyId: scope.pharmacyId };
  return { pharmacyId: { $in: [] } };
}

/** 404 rather than 403, so a guessed id does not confirm another shop exists. */
export function assertPharmacyOwned(
  docPharmacyId: unknown,
  user: SessionUser,
  message = "That record does not belong to this pharmacy.",
): void {
  if (!docPharmacyId || String(docPharmacyId) !== user.pharmacyId) {
    throw ApiError.notFound(message);
  }
}

/** Lowercase hyphenated slug from a trading name. */
export function slugifyPharmacyName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "pharmacy";
}
