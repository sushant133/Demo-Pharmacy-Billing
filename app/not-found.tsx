import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 pt-[var(--safe-top)] pb-[var(--safe-bottom)]">
      <div className="text-center">
        <p className="text-sm font-semibold text-brand-700">404</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
          We couldn&rsquo;t find that page
        </h1>
        <p className="mt-2 text-sm text-slate-500">
          The link may be out of date, or the record may have been removed.
        </p>
        <Link href="/dashboard" className="btn-primary mt-6">
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
