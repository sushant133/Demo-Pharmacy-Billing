import { config } from "@/lib/config";
import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { withDbRead } from "@/lib/db";
import { toDateInputValue } from "@/lib/dates";
import { latestBatchPrices } from "@/lib/purchases";
import { can } from "@/lib/roles";
import { getSettings } from "@/lib/settings";
import { pharmacyFilter, pharmacyObjectId } from "@/lib/tenant";
import { resolveUnitsPerStrip } from "@/lib/pack";
import { objectIdSchema } from "@/lib/validation";
import { Medicine } from "@/models/Medicine";
import { Supplier } from "@/models/Supplier";
import { EmptyState, PageHeader } from "@/components/ui";
import { PurchaseForm } from "@/components/purchases/PurchaseForm";

export const metadata: Metadata = { title: "New purchase" };
export const dynamic = "force-dynamic";

/**
 * Record a delivery.
 *
 * Server component: it loads the supplier and medicine pickers on the server
 * and hands them to the one interactive part. Since Phase 2 this is the only
 * route into stock, so it also has to explain itself when the shop has no
 * suppliers yet.
 */
export default async function NewPurchasePage({
  searchParams,
}: {
  searchParams: Promise<{ medicineId?: string }>;
}) {
  const user = await requirePagePermission("purchase:write");
  const params = await searchParams;
  const pharmacyId = pharmacyObjectId(user);

  const [suppliers, medicines, lastPrices, settings] = await withDbRead(() =>
    Promise.all([
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
      latestBatchPrices(pharmacyId),
      getSettings(user.pharmacyId, user.pharmacyName),
    ]),
  );

  if (suppliers.length === 0) {
    return (
      <>
        <PageHeader title="New purchase" />
        <div className="card">
          <EmptyState
            title="Add a supplier first"
            description="Stock enters the shop through a purchase, and every purchase belongs to a supplier. Create one and come straight back."
            action={
              <Link href="/suppliers?new=1" className="btn-primary">
                Add supplier
              </Link>
            }
          />
        </div>
      </>
    );
  }

  if (medicines.length === 0) {
    return (
      <>
        <PageHeader title="New purchase" />
        <div className="card">
          <EmptyState
            title="The catalogue is empty"
            description="Add the medicines you stock before recording a delivery - a purchase line has to point at a catalogue entry."
            action={
              <Link href="/medicines?new=1" className="btn-primary">
                Add medicine
              </Link>
            }
          />
        </div>
      </>
    );
  }

  const medicineOptions = medicines.map((medicine) => {
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
  });

  const wantedId = objectIdSchema.safeParse(params.medicineId ?? "").success
    ? params.medicineId
    : null;
  const presetMedicine = wantedId
    ? medicineOptions.find((medicine) => medicine.id === wantedId)
    : null;
  const last = presetMedicine ? lastPrices.get(presetMedicine.id) : null;

  return (
    <>
      <PageHeader
        title={presetMedicine ? `Add stock · ${presetMedicine.name}` : "New purchase"}
        subtitle={
          presetMedicine
            ? "This medicine is already on the delivery. Fill the batch, expiry, quantity and prices."
            : "Type the supplier's invoice. Posting it creates the batches and puts the stock on the shelf."
        }
        actions={
          <Link href="/purchases" className="btn-secondary">
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
        medicines={medicineOptions}
        defaultVatRate={settings.vatRate}
        expiryAlertDays={config.expiryAlertDays}
        today={toDateInputValue()}
        purchase={null}
        canPost={can(user.role, "purchase:post")}
        preset={
          presetMedicine
            ? {
                medicineId: presetMedicine.id,
                medicineName: presetMedicine.name,
                manufacturer: presetMedicine.manufacturer,
                genericName: presetMedicine.genericName,
                packSize: presetMedicine.packSize,
                unit: presetMedicine.unit,
                unitsPerStrip: presetMedicine.unitsPerStrip,
                lastCostPrice: last?.costPrice ?? null,
                lastSalePrice: last?.salePrice ?? null,
                lastSupplierId: last?.supplierId ?? null,
              }
            : null
        }
      />
    </>
  );
}
