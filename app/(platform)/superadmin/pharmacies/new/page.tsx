import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { CreatePharmacyForm } from "@/components/pharmacies/CreatePharmacyForm";
import { PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "New pharmacy" };
export const dynamic = "force-dynamic";

export default async function NewPharmacyPage() {
  await requirePagePermission("pharmacy:manage");

  return (
    <>
      <PageHeader
        title="New pharmacy"
        subtitle="Creates the shop, its default outlet, and the owner login you will hand over."
        actions={
          <Link href="/superadmin/pharmacies" className="btn-secondary">
            Cancel
          </Link>
        }
      />
      <CreatePharmacyForm />
    </>
  );
}
