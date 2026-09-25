import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePagePermission } from "@/lib/auth";
import { assertVisibleInScope, resolveViewScope } from "@/lib/branch-scope";
import { withDbRead } from "@/lib/db";
import { formatDate, formatDateTime, integer } from "@/lib/format";
import {
  isExpiredOn,
  prescriptionStatus,
  remainingOnLine,
} from "@/lib/prescription-status";
import { can } from "@/lib/roles";
import { pharmacyFilter } from "@/lib/tenant";
import { objectIdSchema } from "@/lib/validation";
import { Prescription } from "@/models/Prescription";
import {
  CancelPrescriptionAction,
  DispensePanel,
} from "@/components/prescriptions/DispenseActions";
import { Badge, Card, PageHeader, TableWrap } from "@/components/ui";

export const metadata: Metadata = { title: "Prescription" };
export const dynamic = "force-dynamic";

/**
 * One prescription: what was written, what has gone out, and what is left.
 *
 * The dispense log is shown in full rather than summarised. A pharmacist asked
 * six months later why a controlled line went out in three parts needs the
 * dates and the names, not a running total.
 */
export default async function PrescriptionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePagePermission("sale:read");
  const { id } = await params;

  const script = await withDbRead(async () => {
    if (!objectIdSchema.safeParse(id).success) notFound();

    const doc = await Prescription.findOne({
      _id: id,
      ...pharmacyFilter(user),
    }).lean();
    if (!doc) notFound();

    const scope = await resolveViewScope(user);
    try {
      assertVisibleInScope(doc.branchId, scope);
    } catch {
      notFound();
    }
    return doc;
  });

  const state = prescriptionStatus(script);
  const canDispense = can(user.role, "sale:create") && state.dispensable;
  const canCancel = can(user.role, "sale:void") && !script.cancelledAt;
  const dispenses = script.dispenses ?? [];
  const lapsed = isExpiredOn(script.validUntil);

  const lines = script.items.map((item, lineIndex) => ({
    lineIndex,
    medicineName: item.medicineName,
    dosage: item.dosage ?? "",
    prescribed: item.quantityPrescribed,
    dispensed: item.quantityDispensed,
    remaining: remainingOnLine(item),
  }));

  return (
    <>
      <PageHeader
        title={script.rxNo}
        subtitle={`${script.patientName} · written ${formatDate(script.issuedOn as unknown as Date)} by ${script.doctorName}`}
        actions={
          <Link href="/prescriptions" className="btn-secondary">
            Back
          </Link>
        }
      />

      {script.cancelledAt ? (
        <div
          role="status"
          className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3"
        >
          <p className="text-sm font-semibold text-rose-800">
            Cancelled on {formatDateTime(script.cancelledAt as unknown as Date)}
            {script.cancelledByName ? ` by ${script.cancelledByName}` : ""}.
          </p>
          <p className="mt-1 text-xs text-rose-700">
            Nothing further can be dispensed against it. What was already handed
            over stays on the record.
            {script.cancelReason ? ` Reason: ${script.cancelReason}` : ""}
          </p>
        </div>
      ) : lapsed && state.outstanding > 0 ? (
        <div
          role="status"
          className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3"
        >
          <p className="text-sm font-semibold text-amber-900">
            This prescription expired on{" "}
            {formatDate(script.validUntil as unknown as Date)}.
          </p>
          <p className="mt-1 text-xs text-amber-800">
            {integer(state.outstanding)} unit
            {state.outstanding === 1 ? "" : "s"} were never dispensed. The patient
            needs a fresh script before anything else goes out.
          </p>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card className="overflow-hidden">
            <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">
              Prescribed
            </h2>

            <TableWrap minWidth="32rem" pinFirst>
              <thead>
                <tr>
                  <th className="th">Medicine</th>
                  <th className="th">Dosage</th>
                  <th className="th text-right">Prescribed</th>
                  <th className="th text-right">Dispensed</th>
                  <th className="th text-right">Left</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {script.items.map((item, index) => {
                  const remaining = remainingOnLine(item);
                  return (
                    <tr key={index}>
                      <td className="td font-medium text-slate-900">
                        {item.medicineName}
                        {item.requiresPrescription ? (
                          <Badge tone="amber" className="ml-2">
                            Rx
                          </Badge>
                        ) : null}
                      </td>
                      <td className="td text-slate-600">
                        {item.dosage || "—"}
                      </td>
                      <td className="td tnum text-right">
                        {integer(item.quantityPrescribed)}
                      </td>
                      <td className="td tnum text-right text-slate-600">
                        {integer(item.quantityDispensed)}
                      </td>
                      <td className="td tnum text-right font-semibold">
                        {remaining > 0 ? (
                          <span className="text-amber-700">{integer(remaining)}</span>
                        ) : (
                          <span className="text-emerald-700">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </TableWrap>
          </Card>

          {dispenses.length > 0 ? (
            <Card className="p-4">
              <h2 className="text-sm font-semibold text-slate-900">
                Dispense history
              </h2>
              <ul className="mt-3 space-y-3">
                {dispenses.map((entry, index) => (
                  <li
                    key={`${String(entry.dispensedAt)}-${index}`}
                    className="border-t border-slate-100 pt-3 first:border-0 first:pt-0"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="text-xs font-medium text-slate-900">
                        {integer(entry.units)} unit{entry.units === 1 ? "" : "s"}
                      </p>
                      {entry.billNo ? (
                        <span className="font-mono text-[11px] text-slate-500">
                          {entry.billNo}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {formatDateTime(entry.dispensedAt as unknown as Date)}
                      {entry.dispensedByName ? ` · ${entry.dispensedByName}` : ""}
                    </p>
                    <ul className="mt-1 text-[11px] text-slate-600">
                      {entry.items.map((item, itemIndex) => (
                        <li key={itemIndex}>
                          {integer(item.quantity)} × {item.medicineName}
                        </li>
                      ))}
                    </ul>
                    {entry.note ? (
                      <p className="mt-1 text-xs text-slate-600">{entry.note}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          <Card className="p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-slate-900">Status</h2>
              <Badge tone={state.tone}>{state.label}</Badge>
            </div>
            <dl className="mt-3 space-y-2 text-sm">
              <Row label="Prescribed" value={integer(script.prescribedUnits)} />
              <Row label="Dispensed" value={integer(script.dispensedUnits)} />
              <div className="flex justify-between gap-3 border-t border-slate-100 pt-2">
                <dt className="font-medium text-slate-900">Outstanding</dt>
                <dd className="tnum font-semibold text-amber-700">
                  {integer(state.outstanding)}
                </dd>
              </div>
            </dl>
          </Card>

          {canDispense ? (
            <DispensePanel
              prescriptionId={String(script._id)}
              rxNo={script.rxNo}
              lines={lines}
            />
          ) : null}

          <Card className="p-4">
            <h2 className="text-sm font-semibold text-slate-900">Patient</h2>
            <dl className="mt-3 space-y-2.5 text-sm">
              <Row label="Name" value={script.patientName} />
              <Row label="Phone" value={script.patientPhone || "—"} />
              <Row label="Age" value={script.patientAge || "—"} />
              <Row
                label="Sex"
                value={
                  script.patientGender
                    ? script.patientGender[0]!.toUpperCase() +
                      script.patientGender.slice(1)
                    : "—"
                }
              />
            </dl>
            {script.customerId ? (
              <Link
                href={`/invoices?q=${encodeURIComponent(script.patientPhone || script.patientName)}`}
                className="mt-3 inline-block text-xs font-medium text-brand-700 hover:underline"
              >
                Their invoices
              </Link>
            ) : null}
          </Card>

          <Card className="p-4">
            <h2 className="text-sm font-semibold text-slate-900">Prescriber</h2>
            <dl className="mt-3 space-y-2.5 text-sm">
              <Row label="Doctor" value={script.doctorName} />
              <Row label="NMC reg." value={script.doctorRegNo || "—"} />
              <Row label="Hospital" value={script.hospital || "—"} />
              <Row
                label="Written on"
                value={formatDate(script.issuedOn as unknown as Date)}
              />
              <Row
                label="Valid until"
                value={
                  script.validUntil
                    ? formatDate(script.validUntil as unknown as Date)
                    : "No expiry given"
                }
              />
            </dl>
          </Card>

          <Card className="p-4">
            <h2 className="text-sm font-semibold text-slate-900">Filing</h2>
            <dl className="mt-3 space-y-2.5 text-sm">
              <Row
                label="Copy held"
                value={script.copyHeld ? "Yes, at the counter" : "No"}
              />
              <Row label="Filed by" value={script.createdByName || "—"} />
              <Row label="Branch" value={script.branchName || "—"} />
            </dl>
            {script.notes ? (
              <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-600">
                {script.notes}
              </p>
            ) : null}

            {canCancel ? (
              <div className="mt-3 border-t border-slate-100 pt-3">
                <CancelPrescriptionAction
                  prescriptionId={String(script._id)}
                  rxNo={script.rxNo}
                  outstanding={state.outstanding}
                />
              </div>
            ) : null}
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-600">{label}</dt>
      <dd className="tnum text-right font-medium text-slate-900">{value}</dd>
    </div>
  );
}
