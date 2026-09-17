import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { requirePageSession } from "@/lib/auth";
import { resolveViewScope, switchableBranches } from "@/lib/branch-scope";
import { withDbRead } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { getAlertOverview } from "@/lib/alerts";

/**
 * Layout for every authenticated screen.
 *
 * The session is resolved here once, on the server, and handed down to the
 * shell. Middleware has already rejected anonymous traffic; this second check
 * is what actually gives the pages a typed user.
 *
 * This is the first server component to run on every authenticated request,
 * and both lookups below can reach Mongo - `switchableBranches` only when its
 * short cache has expired, which is exactly the request that used to fall over
 * on a container whose pool had died. Opening the connection here, through the
 * retrying reader, means the shell is never the thing that fails the page.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requirePageSession();
  if (user.role === "superadmin") redirect("/superadmin");

  const [scope, branches, settings] = await withDbRead(() =>
    Promise.all([
      resolveViewScope(user),
      user.role === "admin" ? switchableBranches(user) : Promise.resolve([]),
      getSettings(user.pharmacyId, user.pharmacyName),
    ]),
  );

  // The count on the Alerts badge. Its own read, behind the 15s cache in
  // getAlertOverview and a catch: a counter that cannot be computed must not
  // take the whole shell - and with it every screen - down with it.
  const alertCount = await withDbRead(() => getAlertOverview(scope))
    .then((overview) => overview.actionableCount)
    .catch(() => 0);

  const pharmacyName =
    settings.businessName.trim() || user.pharmacyName.trim() || "Pharmacy";

  return (
    <AppShell
      user={{
        name: user.name,
        email: user.email,
        role: user.role,
        branchName: user.branchName || scope.label,
        pharmacyName,
      }}
      scope={{
        code: scope.code,
        label: scope.label,
        switchable: scope.switchable,
      }}
      branches={branches}
      alertCount={alertCount}
    >
      {children}
    </AppShell>
  );
}
