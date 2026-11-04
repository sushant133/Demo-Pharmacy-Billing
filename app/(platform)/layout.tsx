import { redirect } from "next/navigation";
import { SuperAdminShell } from "@/components/SuperAdminShell";
import { IdleSignOut } from "@/components/IdleSignOut";
import { requirePagePermission } from "@/lib/auth";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requirePagePermission("pharmacy:manage");
  if (user.role !== "superadmin") redirect("/dashboard?denied=1");

  return (
    <SuperAdminShell user={{ name: user.name, email: user.email }}>
      {children}
      <IdleSignOut timeoutSeconds={config.idleTimeoutSeconds} />
    </SuperAdminShell>
  );
}
