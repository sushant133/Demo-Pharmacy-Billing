import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/AuthShell";
import { ChangePasswordForm } from "@/components/auth/ChangePasswordForm";
import { requirePageSession } from "@/lib/auth";

export const metadata: Metadata = { title: "Choose your password" };
export const dynamic = "force-dynamic";

/**
 * The forced first-login change.
 *
 * Middleware sends anyone signed in on a temporary password here and keeps
 * them here; everyone else who lands on it is sent back to work. So by the
 * time this renders, the visitor is somebody who must choose a password.
 */
export default async function ChangePasswordPage() {
  const user = await requirePageSession();

  return (
    <AuthShell
      title="Choose your own password"
      subtitle={`Welcome, ${user.name}. You signed in with a temporary password from your email. Set one only you know to continue.`}
    >
      <ChangePasswordForm email={user.email} />
    </AuthShell>
  );
}
