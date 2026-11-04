import { ApiError, ok, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { billFileKind, sheetToBill, unitsPerPack, type BillReading } from "@/lib/bill-import";
import { connectDB } from "@/lib/db";
import { xlsxToCsv } from "@/lib/medicine-import-xlsx";
import { readImageText } from "@/lib/medicine-ocr-engine";
import { detectUnit, matchCatalogue, readBill, readerWarning, type CatalogueEntry } from "@/lib/medicine-ocr";
import { resolveUnitsPerStrip } from "@/lib/pack";
import { pharmacyFilter } from "@/lib/tenant";
import { Medicine } from "@/models/Medicine";
import { Supplier } from "@/models/Supplier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Reading a photographed bill takes several seconds per page.
export const maxDuration = 120;

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * POST /api/purchases/import - read a supplier's bill for a new purchase.
 *
 * The body is the file itself: a photo of the bill (image/*), the supplier's
 * Excel export (.xlsx) or a CSV. `?name=` carries the file name for browsers
 * that send no type. Nothing is written: the reply is the bill's lines - item,
 * pack, batch, expiry, quantity, free, rate, amount, MRP - each matched to a
 * medicine in this pharmacy's catalogue where one is close enough, plus the
 * invoice number, date and the supplier when the bill names one we know. The
 * purchase form shows them for checking; only saving the purchase writes.
 */
export const POST = withRoute(async (req) => {
  const user = await requirePermission("purchase:write");

  const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const name = (new URL(req.url).searchParams.get("name") ?? "").toLowerCase();
  const raw = await req.arrayBuffer();
  const data = Buffer.from(raw);
  if (data.byteLength === 0) throw ApiError.badRequest("That file is empty.");
  if (data.byteLength > MAX_BYTES) throw ApiError.badRequest("That file is too large. Use one under 5 MB.");

  let bill: BillReading;
  let source: "photo" | "sheet";
  if (type.startsWith("image/")) {
    source = "photo";
    let lines;
    try {
      lines = await readImageText(data, "list");
    } catch (error) {
      console.error("[purchase-import] OCR failed", error);
      throw ApiError.badRequest("That photo could not be read. Try a clearer JPG or PNG photo.");
    }
    const read = readBill(lines);
    if (!read || read.lines.length === 0) {
      throw ApiError.badRequest(
        "No bill table was found in that photo. Photograph the whole bill flat, in good light, with the item rows in view.",
      );
    }
    bill = { ...read, note: [readerWarning(lines), read.note].filter(Boolean).join(" ") };
  } else if (billFileKind(type, name) === "workbook") {
    source = "sheet";
    try {
      bill = sheetToBill((await xlsxToCsv(raw)).csv);
    } catch (error) {
      throw ApiError.badRequest(error instanceof Error ? error.message : "That workbook could not be read.");
    }
  } else if (billFileKind(type, name) === "text") {
    source = "sheet";
    try {
      bill = sheetToBill(data.toString("utf8"));
    } catch (error) {
      throw ApiError.badRequest(error instanceof Error ? error.message : "That file could not be read.");
    }
  } else {
    throw ApiError.badRequest("Upload a photo of the bill, or the supplier's Excel (.xlsx) or CSV file.");
  }
  if (bill.lines.length === 0) throw ApiError.badRequest(bill.note || "No item lines were found.");

  await connectDB();
  const [medicines, suppliers] = await Promise.all([
    Medicine.find({ isActive: { $ne: false }, ...pharmacyFilter(user) })
      .select("name unit packSize unitsPerStrip manufacturer genericName")
      .limit(20000)
      .lean(),
    Supplier.find({ isActive: { $ne: false }, ...pharmacyFilter(user) })
      .select("name")
      .limit(2000)
      .lean(),
  ]);

  // A name typed identically wins outright; otherwise the closest catalogue
  // name, allowing for OCR slips (lib/medicine-ocr.ts matchCatalogue).
  const catalogue: CatalogueEntry[] = medicines.map((medicine) => ({ id: String(medicine._id), name: medicine.name }));
  const byName = new Map(medicines.map((medicine) => [medicine.name.trim().toLowerCase(), medicine]));
  const byId = new Map(medicines.map((medicine) => [String(medicine._id), medicine]));

  const lines = bill.lines.map((line) => {
    const exact = byName.get(line.description.trim().toLowerCase());
    const match = exact ?? byId.get(matchCatalogue(line.description, catalogue)?.id ?? "");
    const unit = match?.unit ?? (detectUnit(line.description) || "unit");
    return {
      ...line,
      medicineId: match ? String(match._id) : null,
      medicineName: match?.name ?? null,
      /** Pieces per billed pack: the catalogue's strip size when known, else read from the pack. */
      unitsPerPack: match
        ? resolveUnitsPerStrip(match.unit ?? "unit", match.packSize ?? "", match.unitsPerStrip)
        : unitsPerPack(line.pack, unit),
      unit,
    };
  });

  // The supplier's name is in the letterhead of nearly every bill.
  const supplierCatalogue = suppliers.map((supplier) => ({ id: String(supplier._id), name: supplier.name }));
  let supplierId: string | null = null;
  for (const text of bill.letterhead) {
    const found = matchCatalogue(text, supplierCatalogue);
    if (found?.id) {
      supplierId = found.id;
      break;
    }
  }

  return ok({
    source,
    lines,
    invoiceNo: bill.invoiceNo,
    invoiceDate: bill.invoiceDate,
    supplierId,
    note: bill.note,
  });
});
