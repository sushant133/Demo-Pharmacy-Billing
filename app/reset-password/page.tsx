import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/auth/AuthShell";
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";
import { passwordResetIsValid } from "@/lib/password-reset";

export const metadata: Metadata = { title: "Set a new password" };
export const dynamic = "force-dynamic";

/**
 * Choose a new password against an emailed link.
 *
 * The token is checked on the server before the form is drawn, so somebody
 * arriving with a link they sat on for a day is told immediately rather than
 * after typing a password twice. It is checked again when the form is
 * submitted - this pass is a courtesy, not the guard, since a link can expire
 * in the seconds between the two.
 *
 * Expired, spent and unknown all look identical here on purpose. Telling them
 * apart would confirm that a token was once real, and the useful next step is
 * the same for all three.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const usable = token ? await passwordResetIsValid(token) : false;

  if (!usable) {
    return (
      <AuthShell
        title="This link has expired"
        subtitle="Reset links work once and last an hour. Ask for a fresh one and it will arrive in a moment."
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm leading-relaxed text-amber-800">
            Nothing has changed on your account, and your current password
            still works.
          </div>
          <Link href="/forgot-password" className="btn-primary w-full py-3">
            Send me a new link
          </Link>
          <Link
            href="/login"
            className="block text-center text-sm font-medium text-slate-500 hover:text-brand-700"
          >
            Back to sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Set a new password"
      subtitle="Choose something you have not used here before. You will sign in with it straight away."
    >
      <ResetPasswordForm token={token as string} />
    </AuthShell>
  );
}
