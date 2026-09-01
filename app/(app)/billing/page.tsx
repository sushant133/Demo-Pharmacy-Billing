import type { Metadata } from "next";
import { requirePagePermission } from "@/lib/auth";
import { withDbRead } from "@/lib/db";
import { branchForWrite } from "@/lib/branches";
import { BillingScreen } from "@/components/billing/BillingScreen";

export const metadata: Metadata = { title: "New sale" };
export const dynamic = "force-dynamic";

/**
 * Server component wrapper: it resolves the session and outlet, then hands
 * off to the one genuinely interactive part of the app.
 */
export default async function BillingPage() {
  const user = await requirePagePermission("sale:create");
  const outlet = await withDbRead(() => branchForWrite(user));

  return <BillingScreen cashierName={user.name} outletName={outlet.name} />;
}
