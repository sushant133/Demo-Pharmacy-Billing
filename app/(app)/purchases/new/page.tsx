import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { config } from "@/lib/config";
import { withDbRead } from "@/lib/db";
import { toDateInputValue } from "@/lib/dates";
import { can } from "@/lib/roles";
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
export default async function NewPurchasePage() {
  const user = await requirePagePermission("purchase:write");

  const [suppliers, medicines] = await withDbRead(() =>
    Promise.all([
      Supplier.find({ isActive: { $ne: false } })
        .sort({ name: 1 })
        .select("name paymentTermsDays")
        .limit(500)
        .lean(),
      Medicine.find({ isActive: { $ne: false } })
        .sort({ name: 1 })
        .select("name unit manufacturer")
        .limit(1000)
        .lean(),
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

  return (
    <>
      <PageHeader
        title="New purchase"
        subtitle="Type the supplier's invoice. Posting it creates the batches and puts the stock on the shelf."
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
        medicines={medicines.map((medicine) => ({
          id: String(medicine._id),
          name: medicine.name,
          unit: medicine.unit ?? "unit",
          manufacturer: medicine.manufacturer ?? "",
        }))}
        defaultVatRate={config.vatRate}
        today={toDateInputValue()}
        purchase={null}
        canPost={can(user.role, "purchase:post")}
      />
    </>
  );
}
