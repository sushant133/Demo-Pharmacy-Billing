import { ApiError, withRoute } from "@/lib/api";
import { requirePermission } from "@/lib/auth";
import { assertVisibleInScope, resolveViewScope } from "@/lib/branch-scope";
import { adToBs, formatBs, formatBsIso } from "@/lib/bs-date";
import { connectDB } from "@/lib/db";
import { localParts } from "@/lib/dates";
import { formatExpiry } from "@/lib/format";
import { getPrintTemplate, getSettings, printedIssuer } from "@/lib/settings";
import { INVOICE_CONTENT_TYPE, toInvoicePdf } from "@/lib/export/invoice-pdf";
import { displayBillNo } from "@/models/Counter";
import { Sale } from "@/models/Sale";
import type { PaymentMode } from "@/lib/constants";
import { pharmacyFilter } from "@/lib/tenant";
import { objectIdSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/sales/:id/invoice - the bill as a PDF.
 *
 * What "Download invoice" fetches at the end of a sale, and what a customer
 * gets when a link is shared with them. /bills/:id is the page the counter
 * prints; this is the file that gets emailed or filed. Both follow the
 * pharmacy's assigned template, so the copy in somebody's records is the same
 * shape as the one they were handed.
 *
 * Read-only: unlike printing, downloading does not consume a copy number, so
 * fetching it twice does not turn the original into "Copy of Original – 1".
 */
export const GET = withRoute<Ctx>(async (_req, ctx) => {
  const user = await requirePermission("sale:read");
  const { id } = await ctx.params;
  await connectDB();

  const query = objectIdSchema.safeParse(id).success
    ? { _id: id, ...pharmacyFilter(user) }
    : { billNo: decodeURIComponent(id).toUpperCase(), ...pharmacyFilter(user) };

  const sale = await Sale.findOne(query).lean();
  if (!sale) throw ApiError.notFound("No bill found with that number.");

  const scope = await resolveViewScope(user);
  assertVisibleInScope(sale.branchId, scope, "No bill found with that number.");

  const settings = await getSettings(user.pharmacyId, user.pharmacyName);
  // The downloaded copy is laid out on the same paper the counter prints on,
  // so the file a customer is emailed and the slip they were handed are the
  // same document rather than two shapes of the same numbers.
  const [issuer, template] = await Promise.all([
    printedIssuer(settings, sale.branchId, user.pharmacyId),
    getPrintTemplate(user.pharmacyId),
  ]);

  const issuedAt = (sale.createdAt as unknown as Date) ?? new Date();
  let bsDate = "";
  try {
    const local = localParts(issuedAt);
    const bs = adToBs(local.year, local.month, local.day);
    bsDate = `${formatBsIso(bs)} (${formatBs(bs)})`;
  } catch {
    // An AD-only invoice is still a valid one; the BS line is a courtesy.
  }

  const pdf = await toInvoicePdf({
    billNo: displayBillNo(sale.billNo),
    issuedAt,
    bsDate,
    fiscalYear: sale.fiscalYear?.replace("-", "/") ?? "",
    issuer: {
      name: issuer.name,
      address: issuer.address,
      phone: issuer.phone,
      pan: issuer.pan,
      vatNumber: settings.vatRegistered ? settings.vatNumber : "",
      email: settings.email,
    },
    buyer: {
      name: sale.customerName ?? "",
      address: sale.customerAddress ?? "",
      phone: sale.customerPhone ?? "",
      pan: sale.customerPan ?? "",
    },
    items: sale.items.map((item) => ({
      medicineName: item.medicineName,
      batchNumber: item.batchNumber,
      expiryDate: formatExpiry(item.expiryDate as unknown as Date),
      quantity: item.quantity,
      unit: item.unit ?? "unit",
      unitPrice: item.unitPrice,
      subtotal: item.subtotal,
    })),
    subtotal: sale.subtotal,
    discount: sale.discount,
    discountPercent: sale.discountPercent ?? 0,
    taxableAmount: sale.taxableAmount,
    vatRate: sale.vatRate ?? 0.13,
    vatAmount: sale.vatAmount,
    totalAmount: sale.totalAmount,
    amountReceived: sale.amountReceived ?? 0,
    paymentMode: (sale.paymentMode ?? "cash") as PaymentMode,
    soldByName: sale.soldByName ?? "",
    branchName: sale.branchName ?? "",
    note: sale.note ?? "",
    terms: settings.billTerms,
    footerNote: settings.billFooterNote,
    voided: Boolean(sale.voidedAt),
    reprintCount: sale.reprintCount ?? 0,
  }, template.id);

  const fileName = `invoice-${displayBillNo(sale.billNo).replace(/[^\w.-]+/g, "-")}.pdf`;

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": INVOICE_CONTENT_TYPE,
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Content-Length": String(pdf.byteLength),
      "Cache-Control": "no-store",
    },
  });
});
