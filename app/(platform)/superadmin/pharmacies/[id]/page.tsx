import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePagePermission } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { getPharmacy } from "@/lib/pharmacies";
import { BackupDownload } from "@/components/pharmacies/BackupDownload";
import { PharmacyActions } from "@/components/pharmacies/PharmacyActions";
import { Badge, Card, PageHeader } from "@/components/ui";
import { objectIdSchema } from "@/lib/validation";

export const metadata: Metadata = { title: "Pharmacy" };
export const dynamic = "force-dynamic";

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

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card className="p-5 sm:p-6">
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                Status
              </dt>
              <dd className="mt-1">
                <Badge tone={pharmacy.status === "active" ? "green" : "amber"}>
                  {pharmacy.status === "active" ? "Active" : "Suspended"}
                </Badge>
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                Short code
              </dt>
              <dd className="mt-1 text-sm text-slate-900">{pharmacy.slug}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                Owner
              </dt>
              <dd className="mt-1 text-sm text-slate-900">{pharmacy.ownerName}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                Owner email
              </dt>
              <dd className="mt-1 text-sm text-slate-900">{pharmacy.ownerEmail}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                Created
              </dt>
              <dd className="mt-1 text-sm text-slate-900">
                {pharmacy.createdAt ? formatDateTime(pharmacy.createdAt) : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                Last sign-in
              </dt>
              <dd className="mt-1 text-sm text-slate-900">
                {pharmacy.lastLoginAt ? formatDateTime(pharmacy.lastLoginAt) : "Never"}
              </dd>
            </div>
            {pharmacy.legalName ? (
              <div className="sm:col-span-2">
                <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                  Registered name
                </dt>
                <dd className="mt-1 text-sm text-slate-900">{pharmacy.legalName}</dd>
              </div>
            ) : null}
            {pharmacy.notes ? (
              <div className="sm:col-span-2">
                <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                  Notes
                </dt>
                <dd className="mt-1 text-sm text-slate-900">{pharmacy.notes}</dd>
              </div>
            ) : null}
          </dl>
        </Card>

        <div className="space-y-5">
          <BackupDownload pharmacyId={pharmacy.id} pharmacyName={pharmacy.name} />
          <PharmacyActions
            id={pharmacy.id}
            status={pharmacy.status}
            ownerEmail={pharmacy.ownerEmail}
          />
        </div>
      </div>
    </>
  );
}
