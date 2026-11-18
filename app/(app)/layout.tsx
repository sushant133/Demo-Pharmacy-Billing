import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { ImpersonationBanner } from "@/components/ImpersonationBanner";
import { requirePageSession } from "@/lib/auth";
import { Types } from "mongoose";
import { resolveViewScope, switchableBranches, type BranchScope } from "@/lib/branch-scope";
import { withDbRead } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { alertAccountKey, getAlertOverview } from "@/lib/alerts";
import { can } from "@/lib/roles";
import { AlertNotifications } from "@/components/native/AlertNotifications";
import { IdleSignOut } from "@/components/IdleSignOut";
import { config } from "@/lib/config";

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

  /*
    If the shell's own lookups fail, draw it anyway from what the session
    already says. A throw here would escape to the root error boundary, which
    has no sidebar - the person is left on a bare error page with no way to
    move. With a fallback shell, the page below either loads or fails inside
    its own boundary, and the navigation stays usable either way.
  */
  const [scope, branches, settings] = await withDbRead(() =>
    Promise.all([
      resolveViewScope(user),
      user.role === "admin" ? switchableBranches(user) : Promise.resolve([]),
      getSettings(user.pharmacyId, user.pharmacyName),
    ]),
  ).catch((err: unknown) => {
    console.error("[layout] shell lookups failed, using session fallback", err);
    const fallbackScope: BranchScope = {
      pharmacyId: Types.ObjectId.isValid(user.pharmacyId)
        ? new Types.ObjectId(user.pharmacyId)
        : null,
      branchId:
        user.branchId && Types.ObjectId.isValid(user.branchId)
          ? new Types.ObjectId(user.branchId)
          : null,
      code: user.branchCode || null,
      label: user.branchName || user.branchCode || "Your branch",
      switchable: false,
    };
    return [
      fallbackScope,
      [] as Awaited<ReturnType<typeof switchableBranches>>,
      { businessName: user.pharmacyName },
    ] as const;
  });

  // The count on the Alerts badge. Its own read, behind the 15s cache in
  // getAlertOverview and a catch: a counter that cannot be computed must not
  // take the whole shell - and with it every screen - down with it.
  const alertCount = await withDbRead(() => getAlertOverview(scope))
    .then((overview) => overview.actionableCount)
    .catch(() => 0);

  const pharmacyName =
    settings.businessName.trim() || user.pharmacyName.trim() || "Pharmacy";

  return (
    <>
      {/*
        Outside the shell rather than inside it: the banner has to be the
        first thing on the page on every screen, including the ones that
        render their own chrome, and it must not scroll away with the sidebar.
      */}
      {user.impersonatorId ? (
        <ImpersonationBanner
          platformUser={user.impersonatorName || "A platform administrator"}
          actingAs={user.name}
          pharmacyName={pharmacyName}
        />
      ) : null}
      {/*
        Android app only: the background check reads the same alert roll-up.
        Bound to this pharmacy + user, and not switched on while a platform
        administrator is acting as someone - their phone is not the shop's.
      */}
      {can(user.role, "report:read") && !user.impersonatorId ? (
        <AlertNotifications accountKey={alertAccountKey(user)} />
      ) : null}
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
      <IdleSignOut timeoutSeconds={config.idleTimeoutSeconds} />
    </>
  );
}
