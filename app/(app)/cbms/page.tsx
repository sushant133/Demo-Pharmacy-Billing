import type { Metadata } from "next";
import Link from "next/link";
import { Types } from "mongoose";
import { requirePagePermission } from "@/lib/auth";
import { withDbRead } from "@/lib/db";
import { cbmsCounts, cbmsNeverQueuedCount } from "@/lib/cbms";
import { formatDateTime, integer } from "@/lib/format";
import { can } from "@/lib/roles";
import { getSettings } from "@/lib/settings";
import { CbmsSync } from "@/models/CbmsSync";
import {
  Badge,
  Card,
  EmptyState,
  PageHeader,
  StatCard,
  TableWrap,
} from "@/components/ui";
import { SendNowButton } from "@/components/cbms/SendNowButton";

export const metadata: Metadata = { title: "CBMS sync" };
export const dynamic = "force-dynamic";

const KIND_LABELS: Record<string, string> = {
  bill: "Invoice",
  return: "Credit note",
  cancel: "Cancellation",
};

const STATUS: Record<string, { label: string; tone: "amber" | "rose" | "slate" | "green" }> = {
  pending: { label: "Waiting", tone: "amber" },
  failed: { label: "Failed - retrying", tone: "rose" },
  disabled: { label: "CBMS off", tone: "slate" },
  synced: { label: "Accepted", tone: "green" },
};

/**
 * Where this pharmacy stands with IRD's CBMS: how much has been accepted, and
 * every invoice, credit note and cancellation that has not - with IRD's own
 * answer, so a wrong password reads differently from IRD being down.
 */
export default async function CbmsPage() {
  const user = await requirePagePermission("report:export");
  const pharmacyId = new Types.ObjectId(user.pharmacyId);

  const [settings, counts, neverQueued, outstanding, recent] = await withDbRead(() =>
    Promise.all([
      getSettings(user.pharmacyId, user.pharmacyName),
      cbmsCounts(user.pharmacyId),
      cbmsNeverQueuedCount(user.pharmacyId),
      CbmsSync.find({ pharmacyId, status: { $ne: "synced" } })
        .sort({ issuedAt: 1 })
        .limit(500)
        .lean(),
      CbmsSync.find({ pharmacyId, status: "synced" })
        .sort({ syncedAt: -1 })
        .limit(10)
        .lean(),
    ]),
  );

  const canSend = can(user.role, "settings:manage");

  return (
    <>
      <PageHeader
        title="CBMS sync"
        subtitle="Invoices, credit notes and cancellations reported to IRD's Central Billing Monitoring System."
        actions={
          <div className="flex items-start gap-2">
            <a
              href="/api/export?report=cbms-unsynced&format=pdf&from=2000-01-01"
              className="btn-secondary"
            >
              Unsynced report (PDF)
            </a>
            {canSend && settings.cbmsEnabled ? <SendNowButton /> : null}
          </div>
        }
      />

      {!settings.cbmsEnabled ? (
        <Card className="mb-4 border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          CBMS reporting is switched off for this pharmacy. Bills are being kept
          on the queue, not sent to IRD
          {counts.disabled + neverQueued > 0
            ? ` (${integer(counts.disabled + neverQueued)} waiting)`
            : ""}
          . Once it is on, Send now pushes the backlog.{" "}
          {canSend ? (
            <Link href="/settings" className="font-medium underline">
              Turn it on in Settings
            </Link>
          ) : (
            "The owner can turn it on in Settings."
          )}
        </Card>
      ) : null}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Accepted by IRD" value={integer(counts.synced)} tone="brand" />
        <StatCard label="Waiting" value={integer(counts.pending)} hint="Sending shortly" />
        <StatCard label="Failed" value={integer(counts.failed)} hint="Retried automatically" />
        <StatCard
          label="Not sent"
          value={integer(counts.disabled + neverQueued)}
          hint="Raised while CBMS was off. Send now pushes them."
        />
      </div>

      <Card className="overflow-hidden">
        <div className="border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-900">Not yet accepted</h2>
        </div>
        {outstanding.length === 0 ? (
          <EmptyState
            title="Everything has reached IRD"
            description="Every invoice and credit note on the queue has been accepted."
          />
        ) : (
          <TableWrap minWidth="44rem" pinFirst>
            <thead>
              <tr>
                <th className="th">Document</th>
                <th className="th">Issued</th>
                <th className="th">Status</th>
                <th className="th">Attempts</th>
                <th className="th">IRD&apos;s answer</th>
                <th className="th">Next try</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {outstanding.map((row) => {
                const status = STATUS[row.status] ?? STATUS.pending!;
                return (
                  <tr key={String(row._id)} className="align-top">
                    <td className="td">
                      <Link
                        href={`/sales/${String(row.saleId)}`}
                        className="font-mono text-xs text-brand-700 hover:underline"
                      >
                        {row.documentNo}
                      </Link>
                      <span className="block text-xs text-slate-500">
                        {KIND_LABELS[row.kind] ?? row.kind}
                      </span>
                    </td>
                    <td className="td tnum whitespace-nowrap text-slate-600">
                      {formatDateTime(row.issuedAt)}
                    </td>
                    <td className="td">
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </td>
                    <td className="td tnum">{row.attempts}</td>
                    <td className="td max-w-[20rem] text-xs text-slate-600">
                      {row.responseMessage || "—"}
                      {row.responseCode ? (
                        <span className="ml-1 font-mono text-slate-400">({row.responseCode})</span>
                      ) : null}
                    </td>
                    <td className="td tnum whitespace-nowrap text-xs text-slate-500">
                      {row.status === "disabled" || !row.nextAttemptAt
                        ? "—"
                        : formatDateTime(row.nextAttemptAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
        )}
      </Card>

      {recent.length > 0 ? (
        <Card className="mt-4 overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-900">Recently accepted</h2>
          </div>
          <TableWrap minWidth="32rem">
            <tbody className="divide-y divide-slate-100">
              {recent.map((row) => (
                <tr key={String(row._id)}>
                  <td className="td font-mono text-xs">{row.documentNo}</td>
                  <td className="td text-xs text-slate-500">{KIND_LABELS[row.kind] ?? row.kind}</td>
                  <td className="td tnum text-xs text-slate-600">
                    {row.syncedAt ? formatDateTime(row.syncedAt) : "—"}
                  </td>
                  <td className="td text-xs text-slate-500">{row.responseMessage}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </Card>
      ) : null}
    </>
  );
}
