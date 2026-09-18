import type { Metadata } from "next";
import Link from "next/link";
import { Types } from "mongoose";
import { requirePagePermission } from "@/lib/auth";
import { connectDB } from "@/lib/db";
import { formatDate, money } from "@/lib/format";
import {
  PURCHASE_INELIGIBLE_LABELS,
  purchaseLineEligibility,
} from "@/lib/purchase-return";
import { can } from "@/lib/roles";
import { pharmacyFilter } from "@/lib/tenant";
import { Batch } from "@/models/Batch";
import { Purchase } from "@/models/Purchase";
import { Badge, Card, EmptyState, PageHeader, TableWrap } from "@/components/ui";
import {
  PurchaseReturnWorkflow,
  type ReturnablePurchaseLine,
} from "@/components/purchases/PurchaseReturnWorkflow";

export const metadata: Metadata = { title: "Purchase returns" };
export const dynamic = "force-dynamic";

/**
 * Goods going back to the supplier, end to end on one screen.
 *
 * Find the delivery, pick what is going back, say why, read the credit,
 * confirm. The mirror of /sales/returns, deliberately - a storekeeper holding
 * a crushed carton and a cashier holding a returned strip are doing the same
 * shape of job, and the two screens should not need learning separately.
 *
 * Only *posted* deliveries can be returned against. A draft has no stock
 * behind it, and a cancelled GRN already gave its stock back - neither has
 * anything to send anywhere, which is why both are refused by
 * `purchaseLineEligibility` rather than filtered out silently here.
 */
export default async function PurchaseReturnsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const user = await requirePagePermission("purchase:read");
  const params = await searchParams;
  await connectDB();

  const q = params.q?.trim() ?? "";
  const tenant = pharmacyFilter(user);
  const canRecord = can(user.role, "purchase:post");

  const purchase = q
    ? await Purchase.findOne(
        Types.ObjectId.isValid(q)
          ? { _id: q, ...tenant }
          : {
              ...tenant,
              $or: [
                { grnNo: new RegExp(`^${escapeRegex(q)}$`, "i") },
                { invoiceNo: new RegExp(`^${escapeRegex(q)}$`, "i") },
              ],
            },
      ).lean()
    : null;

  // What the lots physically hold now, which is the binding limit. Read here
  // as well as in the service so the screen offers a number the server will
  // actually honour rather than one it is about to refuse.
  const batchIds =
    purchase?.items
      .map((item) => item.batchId)
      .filter((id): id is Types.ObjectId => Boolean(id)) ?? [];

  const lots =
    batchIds.length > 0
      ? await Batch.find({ _id: { $in: batchIds }, ...tenant })
          .select("_id quantity")
          .lean()
      : [];
  const onHand = new Map(lots.map((lot) => [String(lot._id), lot.quantity]));

  const lines: ReturnablePurchaseLine[] =
    purchase?.items.map((item, lineIndex) => {
      const received = item.quantity + (item.freeQuantity ?? 0);
      const held = item.batchId ? (onHand.get(String(item.batchId)) ?? 0) : 0;

      const eligibility = purchaseLineEligibility(
        {
          receivedQuantity: received,
          returnedQuantity: item.returnedQuantity ?? 0,
          onHandQuantity: held,
          effectiveUnitCost: item.effectiveUnitCost ?? 0,
          medicineId: String(item.medicineId),
          medicineName: item.medicineName,
          batchId: item.batchId ? String(item.batchId) : null,
          batchNumber: item.batchNumber,
        },
        purchase.status,
      );

      return {
        lineIndex,
        medicineName: item.medicineName,
        batchNumber: item.batchNumber,
        receivedQuantity: received,
        alreadyReturned: item.returnedQuantity ?? 0,
        onHandQuantity: held,
        unitCost: item.effectiveUnitCost ?? 0,
        returnable: eligibility.returnable,
        ineligibleReason: eligibility.reason,
        ineligibleLabel: eligibility.reason
          ? PURCHASE_INELIGIBLE_LABELS[eligibility.reason]
          : "",
      };
    }) ?? [];

  const previous = purchase?.returns ?? [];

  return (
    <>
      <PageHeader
        title="Purchase returns"
        subtitle="Send goods back to a supplier and reduce what you owe them."
        actions={
          <Link href="/purchases" className="btn-secondary">
            All deliveries
          </Link>
        }
      />

      <Card className="mb-4 p-4 sm:p-5">
        <form method="get" className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor="grn-search" className="label">
              Find the delivery
            </label>
            <input
              id="grn-search"
              name="q"
              defaultValue={q}
              placeholder="GRN number or the supplier's invoice number"
              className="input"
            />
          </div>
          <button type="submit" className="btn-primary">
            Find
          </button>
        </form>
      </Card>

      {!q ? (
        <Card>
          <EmptyState
            title="Which delivery are the goods from?"
            description="Search by GRN number, or by the supplier's own invoice number if that is what is printed on the paperwork in front of you."
          />
        </Card>
      ) : !purchase ? (
        <Card>
          <EmptyState
            title={`Nothing found for "${q}"`}
            description="Check the number, or open the purchase register and find the delivery there."
            action={
              <Link href="/purchases" className="btn-primary">
                Open purchases
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          <Card className="mb-4 p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-slate-900">
                    {purchase.grnNo}
                  </p>
                  <Badge
                    tone={
                      purchase.status === "posted"
                        ? "green"
                        : purchase.status === "cancelled"
                          ? "rose"
                          : "amber"
                    }
                  >
                    {purchase.status}
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-slate-600">
                  {purchase.supplierName}
                  {purchase.invoiceNo ? ` · invoice ${purchase.invoiceNo}` : ""}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  Received {formatDate(purchase.receivedDate as unknown as Date)}
                  {purchase.branchName ? ` · ${purchase.branchName}` : ""}
                </p>
              </div>

              <div className="text-right">
                <p className="text-xs text-slate-500">Invoice total</p>
                <p className="tnum text-lg font-semibold text-slate-900">
                  {money(purchase.totalAmount)}
                </p>
                {(purchase.returnedTotal ?? 0) > 0 ? (
                  <p className="tnum mt-0.5 text-xs text-amber-700">
                    less {money(purchase.returnedTotal)} returned
                  </p>
                ) : null}
              </div>
            </div>
          </Card>

          <PurchaseReturnWorkflow
            purchaseId={String(purchase._id)}
            grnNo={purchase.grnNo}
            supplierName={purchase.supplierName}
            lines={lines}
            canRecord={canRecord}
          />

          {previous.length > 0 ? (
            <Card className="mt-4 overflow-hidden">
              <div className="border-b border-slate-100 px-4 py-3 sm:px-5">
                <p className="text-sm font-semibold text-slate-900">
                  Already sent back
                </p>
              </div>
              <TableWrap minWidth="36rem" pinFirst>
                <thead>
                  <tr>
                    <th className="th">When</th>
                    <th className="th">Reason</th>
                    <th className="th">Credit note</th>
                    <th className="th text-right">Units</th>
                    <th className="th text-right">Credit</th>
                    <th className="th text-right">By</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {previous.map((entry, index) => (
                    <tr key={index} className="hover:bg-slate-50">
                      <td className="td text-slate-600">
                        {formatDate(entry.returnedAt as unknown as Date)}
                      </td>
                      <td className="td text-slate-700">{entry.reason}</td>
                      <td className="td font-mono text-xs text-slate-500">
                        {entry.creditNoteNo || "—"}
                      </td>
                      <td className="td tnum text-right text-slate-700">
                        {entry.units}
                      </td>
                      <td className="td tnum text-right font-medium text-slate-900">
                        {money(entry.totalAmount)}
                      </td>
                      <td className="td text-right text-slate-500">
                        {entry.returnedByName}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            </Card>
          ) : null}
        </>
      )}
    </>
  );
}

/** A typed GRN number is a literal, not a pattern. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
