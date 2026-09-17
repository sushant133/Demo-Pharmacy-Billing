import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/auth";
import { config } from "@/lib/config";
import { withDbRead } from "@/lib/db";
import { dateInputValue, toDateInputValue } from "@/lib/dates";
import { latestBatchPrices } from "@/lib/purchases";
import { can } from "@/lib/roles";
import { Medicine } from "@/models/Medicine";
import { Purchase } from "@/models/Purchase";
import { Supplier } from "@/models/Supplier";
import { pharmacyFilter, pharmacyObjectId } from "@/lib/tenant";
import { resolveUnitsPerStrip } from "@/lib/pack";
import { objectIdSchema } from "@/lib/validation";
import { PageHeader } from "@/components/ui";
import { PurchaseForm } from "@/components/purchases/PurchaseForm";

export const metadata: Metadata = { title: "Edit purchase" };
export const dynamic = "force-dynamic";

/** Date input values want YYYY-MM-DD; stored dates are instants. */
function dateInput(value: Date | null | undefined): string {
  return dateInputValue(value);
}

/**
 * Edit a draft purchase.
 *
 * Only drafts are editable. A posted GRN has already created stock, so it is
 * an accounting record from that point on and is corrected by cancelling, not
 * by rewriting.
 */
export default async function EditPurchasePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePagePermission("purchase:write");
  const { id } = await params;

  const purchaseId = objectIdSchema.safeParse(id);
  if (!purchaseId.success) notFound();

  const { purchase, suppliers, medicines, lastPrices } = await withDbRead(
    async () => {
    const purchase = await Purchase.findOne({
      _id: purchaseId.data,
      ...pharmacyFilter(user),
    }).lean();
    if (!purchase) notFound();

    // Anything already posted or cancelled is immutable - send them to the
    // detail view rather than showing a form that could not be saved.
    if (purchase.status !== "draft") redirect(`/purchases/${String(purchase._id)}`);

    const [suppliers, medicines, lastPrices] = await Promise.all([
      Supplier.find({ isActive: { $ne: false }, ...pharmacyFilter(user) })
        .sort({ name: 1 })
        .select("name paymentTermsDays")
        .limit(500)
        .lean(),
      Medicine.find({ isActive: { $ne: false }, ...pharmacyFilter(user) })
        .sort({ name: 1 })
        .select("name unit manufacturer genericName packSize unitsPerStrip")
        .limit(1000)
        .lean(),
      latestBatchPrices(pharmacyObjectId(user)),
    ]);

    return { purchase, suppliers, medicines, lastPrices };
  });

  return (
    <>
      <PageHeader
        title={`Edit ${purchase.grnNo}`}
        subtitle="Still a draft, so nothing on the shelf changes until you post it."
        actions={
          <Link href={`/purchases/${String(purchase._id)}`} className="btn-secondary">
            Cancel
          </Link>
        }
      />

      <PurchaseForm
        suppliers={suppliers.map((supplier) => ({
          id: String(supplier._id),
          name: supplier.name,
          paymentTermsDays: supplier.paymentTermsDays ?? 0,
        }))}
        medicines={medicines.map((medicine) => {
          const last = lastPrices.get(String(medicine._id));
          return {
            id: String(medicine._id),
            name: medicine.name,
            unit: medicine.unit ?? "unit",
            manufacturer: medicine.manufacturer ?? "",
            genericName: medicine.genericName ?? "",
            packSize: medicine.packSize ?? "",
            unitsPerStrip: resolveUnitsPerStrip(
              medicine.unit ?? "unit",
              medicine.packSize ?? "",
              medicine.unitsPerStrip,
            ),
            lastCostPrice: last?.costPrice ?? null,
            lastSalePrice: last?.salePrice ?? null,
          };
        })}
        defaultVatRate={config.vatRate}
        expiryAlertDays={config.expiryAlertDays}
        today={toDateInputValue()}
        canPost={can(user.role, "purchase:post")}
        purchase={{
          id: String(purchase._id),
          supplierId: String(purchase.supplierId),
          invoiceNo: purchase.invoiceNo ?? "",
          invoiceDate: dateInput(purchase.invoiceDate),
          receivedDate: dateInput(purchase.receivedDate),
          discount: purchase.discount,
          otherCharges: purchase.otherCharges,
          vatRate: purchase.vatRate,
          notes: purchase.notes ?? "",
          items: purchase.items.map((item) => ({
            medicineId: String(item.medicineId),
            batchNumber: item.batchNumber,
            mfgDate: dateInput(item.mfgDate),
            expiryDate: dateInput(item.expiryDate),
            quantity: item.quantity,
            freeQuantity: item.freeQuantity,
            costPrice: item.costPrice,
            salePrice: item.salePrice,
            discount: item.discount,
            applySalePriceToStock: Boolean(item.applySalePriceToStock),
          })),
        }}
      />
    </>
  );
}
