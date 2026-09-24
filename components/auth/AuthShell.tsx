import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The frame for the auth screens that are not the sign-in page.
 *
 * Sign-in gets the two-column brand panel because it is the front door and
 * has room to sell. Forgetting a password is an errand: the person is not
 * being persuaded of anything, they want one field and a button. So this is
 * a single centred column on the same ground, carrying the same lockup and
 * the same card, and nothing else competing for the eye.
 */
export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="login-counter flex min-h-dvh flex-col justify-center px-4 py-10 sm:px-8">
      <div className="mx-auto w-full max-w-[26rem]">
        <div className="mb-6 flex items-center justify-center gap-3.5">
          <Image
            src="/mantramed-logo.png"
            alt=""
            width={1254}
            height={1254}
            priority
            className="h-[72px] w-[72px] shrink-0 object-contain"
          />
          <span className="min-w-0">
            <span className="block text-[27px] leading-none font-semibold tracking-tight text-slate-900">
              MantraMed
            </span>
            <span className="mt-1.5 block text-[10px] font-semibold tracking-[0.18em] text-brand-700 uppercase">
              Pharmacy Suite
            </span>
          </span>
        </div>

        <div className="login-card px-5 py-6 sm:px-7 sm:py-7">
          <h1 className="text-[22px] leading-tight font-semibold tracking-tight text-slate-900">
            {title}
          </h1>
          <p className="mt-1.5 mb-6 text-sm leading-relaxed text-slate-500">
            {subtitle}
          </p>
          {children}
        </div>

        <p className="mt-6 text-center text-[11px] text-slate-400">
          A product of MantraSphere Innovations Pvt. Ltd.
          <span className="mx-1.5 text-slate-300">&middot;</span>
          <Link href="/privacy" className="underline underline-offset-2 hover:text-slate-600">
            Privacy policy
          </Link>
        </p>
      </div>
    </div>
  );
}
