import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePagePermission } from "@/lib/auth";
import { branchDeletionBlockers, listBranchesForPharmacy } from "@/lib/branches";
import { withDbRead } from "@/lib/db";
import { formatDate, formatDateTime, integer, money } from "@/lib/format";
import { getPharmacy, pharmacyStats } from "@/lib/pharmacies";
import { listPlatformEvents } from "@/lib/platform-events";
import { BackupDownload } from "@/components/pharmacies/BackupDownload";
import { PharmacyActions } from "@/components/pharmacies/PharmacyActions";
import { PharmacyBranches } from "@/components/pharmacies/PharmacyBranches";
import { PharmacyPrintTemplate } from "@/components/pharmacies/PharmacyPrintTemplate";
import { PharmacyProfileForm } from "@/components/pharmacies/PharmacyProfileForm";
import { PlatformEventList } from "@/components/pharmacies/PlatformEventList";
import { Badge, Card, PageHeader, StatCard } from "@/components/ui";
import { objectIdSchema } from "@/lib/validation";

export const metadata: Metadata = { title: "Pharmacy" };
export const dynamic = "force-dynamic";

/** What <input type="date"> wants, from what Mongo gives back. */
function dateInput(value: Date | null): string {
  return value ? new Date(value).toISOString().slice(0, 10) : "";
}

export default async function PharmacyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePagePermission("pharmacy:manage");
  const { id } = await params;
  if (!objectIdSchema.safeParse(id).success) notFound();

  let pharmacy;
  try {
    pharmacy = await getPharmacy(id);
  } catch {
    notFound();
  }

  // Closed outlets included: the shop can close one, and the platform needs
  // to see that before opening a replacement with the same code.
  const [stats, branches, blockers, history] = await withDbRead(() =>
    Promise.all([
      pharmacyStats(id),
      listBranchesForPharmacy(id, true),
      // What would be orphaned by deleting each outlet, so the row can offer
      // Delete only where it would work and say why where it would not.
      branchDeletionBlockers(id),
      listPlatformEvents({ pharmacyId: id, pageSize: 12 }),
    ]),
  );

  const licenceExpiry = pharmacy.licenceExpiry
    ? new Date(pharmacy.licenceExpiry)
    : null;
  const licenceDays = licenceExpiry
    ? Math.ceil((licenceExpiry.getTime() - Date.now()) / 86_400_000)
    : null;

  return (
    <>
      <PageHeader
        title={pharmacy.name}
        subtitle="This shop's catalogue, stock and bills are sealed from every other pharmacy."
        actions={
          <Link href="/superadmin/pharmacies" className="btn-secondary">
            All pharmacies
          </Link>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Badge tone={pharmacy.status === "active" ? "green" : "amber"}>
          {pharmacy.status === "active" ? "Active" : "Suspended"}
        </Badge>
        <span className="text-sm text-slate-500">{pharmacy.slug}</span>
        {licenceDays !== null && licenceDays <= 30 ? (
          <Badge tone={licenceDays < 0 ? "rose" : "amber"}>
            {licenceDays < 0
              ? `Licence expired ${formatDate(licenceExpiry)}`
              : `Licence expires in ${licenceDays} day(s)`}
          </Badge>
        ) : null}
        <span className="text-sm text-slate-500">
          Created {pharmacy.createdAt ? formatDateTime(pharmacy.createdAt) : "—"}
          <span className="mx-1.5 text-slate-300">·</span>
          Owner last signed in{" "}
          {pharmacy.lastLoginAt ? formatDateTime(pharmacy.lastLoginAt) : "never"}
        </span>
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Bills (30 days)"
          value={integer(stats.billsLast30)}
          tone={stats.billsLast30 > 0 ? "brand" : "default"}
        />
        <StatCard label="Revenue (30 days)" value={money(stats.revenueLast30)} />
        <StatCard label="Stock at cost" value={money(stats.stockValue)} />
        <StatCard
          label="Staff logins"
          value={`${integer(stats.activeUsers)} / ${integer(stats.users)}`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-6">
          <PharmacyProfileForm
            pharmacyId={pharmacy.id}
            initial={{
              name: pharmacy.name,
              legalName: pharmacy.legalName,
              pan: pharmacy.pan,
              vatNumber: pharmacy.vatNumber,
              vatRegistered: pharmacy.vatRegistered,
              registrationNo: pharmacy.registrationNo,
              drugLicenceNo: pharmacy.drugLicenceNo,
              licenceExpiry: dateInput(pharmacy.licenceExpiry),
              address: pharmacy.address,
              city: pharmacy.city,
              phone: pharmacy.phone,
              email: pharmacy.email,
              ownerPhone: pharmacy.ownerPhone,
              ownerCitizenshipNo: pharmacy.ownerCitizenshipNo,
              notes: pharmacy.notes,
            }}
          />

          <PharmacyPrintTemplate
            pharmacyId={pharmacy.id}
            pharmacyName={pharmacy.name}
            current={pharmacy.printTemplate}
          />

          <Card className="p-5 sm:p-6">
            <h2 className="text-sm font-semibold text-slate-900">Usage</h2>
            <p className="mt-1 text-sm text-slate-500">
              Counts only. Reading this shop&rsquo;s actual records means a
              backup file, or signing in as the owner — which is recorded.
            </p>
            <dl className="mt-4 grid gap-4 sm:grid-cols-3">
              <Figure label="Outlets" value={`${stats.activeBranches} / ${stats.branches}`} />
              <Figure label="Medicines" value={integer(stats.medicines)} />
              <Figure label="Lots in stock" value={integer(stats.lots)} />
              <Figure label="Customers" value={integer(stats.customers)} />
              <Figure label="Suppliers" value={integer(stats.suppliers)} />
              <Figure label="Posted purchases" value={integer(stats.purchases)} />
              <Figure label="Bills (all time)" value={integer(stats.bills)} />
              <Figure label="Revenue (all time)" value={money(stats.revenue)} />
              <Figure
                label="Last bill"
                value={stats.lastSaleAt ? formatDateTime(stats.lastSaleAt) : "Never"}
              />
            </dl>
          </Card>

          <PharmacyBranches
            pharmacyId={pharmacy.id}
            pharmacyName={pharmacy.name}
            branches={branches.map((branch) => ({
              id: branch.id,
              code: branch.code,
              name: branch.name,
              address: branch.address,
              isDefault: branch.isDefault,
              isActive: branch.isActive,
              unitCount: branch.unitCount,
              staffCount: branch.staffCount,
              blockedBy: (blockers.get(branch.id) ?? []).map((block) => block.text),
            }))}
          />

          <Card className="p-5 sm:p-6">
            <h2 className="text-sm font-semibold text-slate-900">Platform history</h2>
            <p className="mt-1 text-sm text-slate-500">
              What the platform has done to this account. The shop&rsquo;s own
              activity is in its books, not here.
            </p>
            <div className="mt-4">
              <PlatformEventList rows={history.rows} showPharmacy={false} />
            </div>
          </Card>
        </div>

        <div className="space-y-5">
          <BackupDownload pharmacyId={pharmacy.id} pharmacyName={pharmacy.name} />
          <PharmacyActions
            id={pharmacy.id}
            pharmacyName={pharmacy.name}
            slug={pharmacy.slug}
            status={pharmacy.status}
            statusReason={pharmacy.statusReason}
            ownerName={pharmacy.ownerName}
            ownerEmail={pharmacy.ownerEmail}
          />
        </div>
      </div>
    </>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">
        {label}
      </dt>
      <dd className="mt-1 text-sm text-slate-900 tnum">{value}</dd>
    </div>
  );
}
