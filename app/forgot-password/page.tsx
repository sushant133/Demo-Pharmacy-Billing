import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/AuthShell";
import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";

export const metadata: Metadata = { title: "Forgot password" };

/**
 * Ask for a reset link.
 *
 * Public and unauthenticated, by definition - the person cannot sign in.
 * Nothing on this page reveals whether an address has an account; see
 * lib/password-reset.ts for why that matters on a platform whose users are
 * named businesses.
 */
export default function ForgotPasswordPage() {
  return (
    <AuthShell
      title="Forgot your password?"
      subtitle="Type the email your account was opened with and we will send you a link to choose a new password."
    >
      <ForgotPasswordForm />
    </AuthShell>
  );
}
