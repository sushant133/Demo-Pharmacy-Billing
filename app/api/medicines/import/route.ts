import { Types } from "mongoose";
import { ApiError, ok, parseJson, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { connectDB } from "@/lib/db";
import {
  parseMedicineCsv,
  type ImportPlan,
  type ImportRow,
} from "@/lib/medicine-import";
import { pharmacyObjectId } from "@/lib/tenant";
import { medicineImportSchema } from "@/lib/validation";
import { Medicine } from "@/models/Medicine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Rows above this are refused outright rather than half-processed. */
const MAX_ROWS = 2000;

/** Rows returned for the preview table; the counts always cover the whole file. */
const PREVIEW_ROWS = 300;

/**
 * POST /api/medicines/import - bring in a catalogue from a spreadsheet.
 *
 * Two passes over the same request shape, chosen by `dryRun`:
 *
 *   - `dryRun: true`  reports what would happen and writes nothing. This is
 *     what the panel calls first, and what the user approves.
 *   - `dryRun: false` performs the same checks again and then writes.
 *
 * The checks are deliberately repeated rather than cached between the two
 * calls. A preview is a statement about the catalogue at the moment it was
 * taken, and a colleague may add a medicine in the seconds before Import is
 * pressed - so the write re-reads rather than trusting what the browser sends
 * back. The preview is advice; the second pass is the decision.
 *
 * Existing medicines are never overwritten. A name that is already in the
 * catalogue is skipped and said so, because an import that silently rewrote
 * prices and pack sizes on live rows would be the most destructive button in
 * the application.
 */
export const POST = withRoute(async (req) => {
  const user = await requirePermission("medicine:write");
  const { csv, dryRun } = await parseJson(req, medicineImportSchema);

  let plan: ImportPlan;
  try {
    plan = parseMedicineCsv(csv);
  } catch (error) {
    // Only malformed JSON throws; CSV problems are reported per row.
    throw ApiError.badRequest(
      error instanceof Error ? error.message : "That file could not be read.",
    );
  }

  if (plan.rows.length === 0) {
    throw ApiError.badRequest(
      "No rows found. The first line should be the column headings.",
    );
  }
  if (plan.rows.length > MAX_ROWS) {
    throw ApiError.badRequest(
      `That file has ${plan.rows.length} rows; ${MAX_ROWS} is the most that can be imported at once. Split it and run it again.`,
    );
  }
  if (!plan.columns.includes("name")) {
    throw ApiError.badRequest(
      "No medicine name column found. The first line should be the column headings, one of which is Name.",
    );
  }

  await connectDB();
  const pharmacyId = pharmacyObjectId(user);

  const valid = plan.rows.filter(
    (row): row is ImportRow & { value: Record<string, unknown> } =>
      row.value !== null,
  );

  /*
    Duplicates are decided against the catalogue *and* against the file.

    The unique index is on {pharmacyId, name, manufacturer}, so that pair is
    what a duplicate means here - two "Paracetamol 500mg" from different makers
    are two products, and treating them as one would silently drop a line.
  */
  const key = (name: unknown, manufacturer: unknown) =>
    `${String(name).trim().toLowerCase()}|${String(manufacturer ?? "").trim().toLowerCase()}`;

  const existing = await Medicine.find({ pharmacyId })
    .select("name manufacturer")
    .lean();
  const taken = new Set(
    existing.map((doc) => key(doc.name, doc.manufacturer ?? "")),
  );

  const seenInFile = new Set<string>();
  const toCreate: Array<ImportRow & { value: Record<string, unknown> }> = [];
  const duplicates: Array<{ line: number; name: string; reason: string }> = [];

  for (const row of valid) {
    const rowKey = key(row.value.name, row.value.manufacturer);

    if (taken.has(rowKey)) {
      duplicates.push({
        line: row.line,
        name: row.name,
        reason: "Already in the catalogue.",
      });
      continue;
    }
    if (seenInFile.has(rowKey)) {
      duplicates.push({
        line: row.line,
        name: row.name,
        reason: "Repeated earlier in this file.",
      });
      continue;
    }

    seenInFile.add(rowKey);
    toCreate.push(row);
  }

  const summary = {
    total: plan.rows.length,
    columns: plan.columns,
    mapping: plan.mapping,
    ignored: plan.ignored,
    willCreate: toCreate.length,
    duplicates,
    errors: plan.rows
      .filter((row) => row.error)
      .map((row) => ({ line: row.line, name: row.name, error: row.error! })),
    sample: toCreate.slice(0, 8).map((row) => ({
      line: row.line,
      name: String(row.value.name),
      manufacturer: String(row.value.manufacturer ?? ""),
      category: String(row.value.category ?? ""),
    })),
    /** What will be saved, in file order, for the preview table. */
    preview: toCreate.slice(0, PREVIEW_ROWS).map((row) => ({
      line: row.line,
      name: String(row.value.name),
      genericName: String(row.value.genericName ?? ""),
      manufacturer: String(row.value.manufacturer ?? ""),
      category: String(row.value.category ?? ""),
      unit: String(row.value.unit ?? ""),
      packSize: String(row.value.packSize ?? ""),
      defaultCostPrice: (row.value.defaultCostPrice as number | null) ?? null,
      defaultSalePrice: (row.value.defaultSalePrice as number | null) ?? null,
      requiresPrescription: Boolean(row.value.requiresPrescription),
    })),
  };

  if (dryRun) return ok({ ...summary, created: 0, dryRun: true });

  if (toCreate.length === 0) {
    return ok({ ...summary, created: 0, dryRun: false });
  }

  /*
    `ordered: false` so one row that loses a race with a concurrent create does
    not abandon the rest. The unique index is the real guard - this check
    cannot be atomic across 2000 rows - so a duplicate that slips past the
    in-memory set is caught by the database and counted, not crashed on.
  */
  let created = 0;
  try {
    const docs = await Medicine.insertMany(
      toCreate.map((row) => ({
        ...row.value,
        pharmacyId,
        _id: new Types.ObjectId(),
      })),
      { ordered: false },
    );
    created = docs.length;
  } catch (error) {
    const result = (error as { insertedDocs?: unknown[] }).insertedDocs;
    if (Array.isArray(result)) created = result.length;
    else throw error;
  }

  return ok({
    ...summary,
    created,
    skippedOnWrite: toCreate.length - created,
    dryRun: false,
  });
});
