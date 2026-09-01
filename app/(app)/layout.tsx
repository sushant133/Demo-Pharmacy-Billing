import { AppShell } from "@/components/AppShell";
import { requirePageSession } from "@/lib/auth";
import { resolveViewScope, switchableBranches } from "@/lib/branch-scope";
import { withDbRead } from "@/lib/db";

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
  const [scope, branches] = await withDbRead(() =>
    Promise.all([
      resolveViewScope(user),
      user.role === "admin" ? switchableBranches(user) : Promise.resolve([]),
    ]),
  );

  return (
    <AppShell
      user={{
        name: user.name,
        email: user.email,
        role: user.role,
        branchName: user.branchName || scope.label,
      }}
      scope={{
        code: scope.code,
        label: scope.label,
        switchable: scope.switchable,
      }}
      branches={branches}
    >
      {children}
    </AppShell>
  );
}
