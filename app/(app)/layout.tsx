import { AppShell } from "@/components/AppShell";
import { requirePageSession } from "@/lib/auth";
import { resolveViewScope, switchableBranches } from "@/lib/branch-scope";

/**
 * Layout for every authenticated screen.
 *
 * The session is resolved here once, on the server, and handed down to the
 * shell. Middleware has already rejected anonymous traffic; this second check
 * is what actually gives the pages a typed user.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requirePageSession();
  const [scope, branches] = await Promise.all([
    resolveViewScope(user),
    user.role === "admin" ? switchableBranches(user) : Promise.resolve([]),
  ]);

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
