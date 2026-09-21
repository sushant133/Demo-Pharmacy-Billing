import { ok, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { setPharmacyPrintTemplate } from "@/lib/pharmacies";
import { recordPlatformEvent } from "@/lib/platform-events";
import { printTemplate } from "@/lib/print-templates";
import { invalidatePrintTemplate } from "@/lib/settings";
import { objectIdSchema, printTemplateSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PUT /api/pharmacies/:id/print-template - which paper this shop prints on.
 *
 * Its own route, like suspending an account and unlike editing an address:
 * it is a decision somebody takes about the hardware on a counter, and every
 * bill printed afterwards looks different because of it. Recorded in the
 * platform history naming both layouts, so "why did our bills change shape
 * in Ashwin?" has an answer.
 */
export const PUT = withRoute<Ctx>(async (req, ctx) => {
  const actor = await requirePermission("pharmacy:manage");
  const { id } = await ctx.params;
  const pharmacyId = objectIdSchema.parse(id);

  const input = await parseJson(req, printTemplateSchema);
  const pharmacy = await setPharmacyPrintTemplate(pharmacyId, input.printTemplate);

  // The bill pages read this through a short-lived cache. Without this the
  // next few bills would still come out on the old paper.
  invalidatePrintTemplate(pharmacyId);

  const chosen = printTemplate(pharmacy.printTemplate);
  await recordPlatformEvent(actor, "pharmacy.print-template", {
    pharmacyId: pharmacy.id,
    pharmacyName: pharmacy.name,
    summary: `Set ${pharmacy.name}'s bill template to ${chosen.label}.`,
    detail: `${chosen.printer}. Applies to bills and credit notes printed from now on.`,
  });

  return ok(pharmacy);
});
