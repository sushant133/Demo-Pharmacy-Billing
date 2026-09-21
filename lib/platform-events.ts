import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import {
  PlatformEvent,
  type PlatformAction,
} from "@/models/PlatformEvent";
import type { SessionUser } from "@/lib/session";

/**
 * The platform's own audit trail.
 *
 * Writing one of these must never be the reason an action fails. Suspending a
 * shop that is abusing the service, or resetting a locked-out owner's
 * password, has to go through even if this collection is unwritable - so
 * every recorder swallows its error and the caller is not told. The action
 * itself is already durable by the time we get here.
 */

export interface PlatformEventEntry {
  id: string;
  at: Date;
  action: PlatformAction;
  actorName: string;
  pharmacyId: string | null;
  pharmacyName: string;
  summary: string;
  detail: string;
}

export const PLATFORM_ACTION_LABELS: Record<PlatformAction, string> = {
  "pharmacy.created": "Pharmacy created",
  "pharmacy.updated": "Details changed",
  "pharmacy.print-template": "Bill template changed",
  "pharmacy.suspended": "Suspended",
  "pharmacy.activated": "Activated",
  "pharmacy.deleted": "Deleted",
  "owner.updated": "Owner changed",
  "owner.password-reset": "Password reset",
  "branch.created": "Branch opened",
  "branch.deleted": "Branch deleted",
  "backup.downloaded": "Backup downloaded",
  "impersonation.started": "Signed in as owner",
  "impersonation.ended": "Impersonation ended",
};

export const PLATFORM_ACTION_TONE: Record<
  PlatformAction,
  "slate" | "brand" | "green" | "amber" | "rose"
> = {
  "pharmacy.created": "green",
  "pharmacy.updated": "slate",
  "pharmacy.print-template": "brand",
  "pharmacy.suspended": "amber",
  "pharmacy.activated": "green",
  "pharmacy.deleted": "rose",
  "owner.updated": "slate",
  "owner.password-reset": "amber",
  "branch.created": "brand",
  "branch.deleted": "rose",
  "backup.downloaded": "slate",
  "impersonation.started": "rose",
  "impersonation.ended": "slate",
};

export async function recordPlatformEvent(
  actor: Pick<SessionUser, "id" | "name">,
  action: PlatformAction,
  entry: {
    pharmacyId?: string | Types.ObjectId | null;
    pharmacyName?: string;
    summary: string;
    detail?: string;
  },
): Promise<void> {
  try {
    await connectDB();
    await PlatformEvent.create({
      action,
      actorId:
        actor.id && Types.ObjectId.isValid(actor.id)
          ? new Types.ObjectId(actor.id)
          : null,
      actorName: actor.name,
      pharmacyId: entry.pharmacyId ? new Types.ObjectId(String(entry.pharmacyId)) : null,
      pharmacyName: entry.pharmacyName ?? "",
      summary: entry.summary,
      detail: entry.detail ?? "",
    });
  } catch {
    // Deliberately silent. See the note at the top of this file.
  }
}

export async function listPlatformEvents(options?: {
  pharmacyId?: string | Types.ObjectId | null;
  action?: PlatformAction | "all";
  page?: number;
  pageSize?: number;
}): Promise<{ rows: PlatformEventEntry[]; total: number }> {
  await connectDB();

  const page = options?.page ?? 1;
  const pageSize = options?.pageSize ?? 25;

  const filter: Record<string, unknown> = {};
  if (options?.pharmacyId) {
    filter.pharmacyId = new Types.ObjectId(String(options.pharmacyId));
  }
  if (options?.action && options.action !== "all") filter.action = options.action;

  const [docs, total] = await Promise.all([
    PlatformEvent.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    PlatformEvent.countDocuments(filter),
  ]);

  return {
    rows: docs.map((doc) => ({
      id: String(doc._id),
      at: doc.createdAt ?? new Date(0),
      action: doc.action as PlatformAction,
      actorName: doc.actorName ?? "",
      pharmacyId: doc.pharmacyId ? String(doc.pharmacyId) : null,
      pharmacyName: doc.pharmacyName ?? "",
      summary: doc.summary ?? "",
      detail: doc.detail ?? "",
    })),
    total,
  };
}
