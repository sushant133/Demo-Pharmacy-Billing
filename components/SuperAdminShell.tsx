"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { cx } from "@/components/ui";
import { initials } from "@/lib/format";

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
}

const icon = (path: string) => (
  <svg
    className="h-5 w-5 shrink-0"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={1.7}
    aria-hidden="true"
  >
    <path strokeLinecap="round" strokeLinejoin="round" d={path} />
  </svg>
);

const NAV: NavItem[] = [
  {
    href: "/superadmin",
    label: "Overview",
    icon: icon("M3 12l9-9 9 9M5 10v10h14V10"),
  },
  {
    href: "/superadmin/pharmacies",
    label: "Pharmacies",
    icon: icon("M3 21h18M5 21V7l7-4 7 4v14M9 21v-5h6v5"),
  },
  {
    href: "/superadmin/backups",
    label: "Backups",
    icon: icon("M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1M12 4v12m0 0l-4-4m4 4l4-4"),
  },
];

export function SuperAdminShell({
  user,
  children,
}: {
  user: { name: string; email: string };
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [warm, setWarm] = useState<Record<string, true>>({});

  useEffect(() => {
    setPendingHref(null);
  }, [pathname]);

  const warmUp = useCallback((href: string) => {
    setWarm((current) => (current[href] ? current : { ...current, [href]: true }));
  }, []);

  const matches = (path: string, href: string) =>
    href === "/superadmin"
      ? path === "/superadmin"
      : path === href || path.startsWith(href + "/");

  const isActive = (href: string) => matches(pathname, href);
  const isHighlighted = (href: string) => matches(pendingHref ?? pathname, href);

  const navLinks = (
    <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3">
      {NAV.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          prefetch={warm[item.href] ? true : undefined}
          onMouseEnter={() => warmUp(item.href)}
          onFocus={() => warmUp(item.href)}
          onClick={() => {
            setPendingHref(item.href);
            setDrawerOpen(false);
          }}
          aria-current={isActive(item.href) ? "page" : undefined}
          className={cx(
            "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
            isHighlighted(item.href)
              ? "bg-brand-600 text-white shadow-sm"
              : "text-slate-300 hover:bg-slate-800 hover:text-white",
          )}
        >
          <NavIcon icon={item.icon} />
          <span>{item.label}</span>
        </Link>
      ))}
    </nav>
  );

  const brand = (
    <div className="flex items-center gap-2.5 px-6 py-5">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-500 text-base font-bold text-white">
        M
      </span>
      <span className="text-[15px] leading-tight font-semibold text-white">
        MantraSphere
        <span className="block text-[11px] font-normal text-slate-400">
          Platform
        </span>
      </span>
    </div>
  );

  return (
    <div className="min-h-dvh lg:flex">
      <aside className="hidden w-60 shrink-0 flex-col bg-slate-900 lg:sticky lg:top-0 lg:flex lg:h-dvh">
        {brand}
        {navLinks}
        <div className="border-t border-slate-800 p-3">
          <div className="flex items-center gap-3 rounded-lg px-2 py-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-500 text-xs font-semibold text-white">
              {initials(user.name)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white">{user.name}</p>
              <p className="truncate text-xs text-slate-400">Super administrator</p>
            </div>
          </div>
          <button
            type="button"
            onClick={async () => {
              await fetch("/api/auth/logout", { method: "POST" });
              window.location.href = "/login";
            }}
            className="mt-1 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
          >
            Sign out
          </button>
        </div>
      </aside>

      {drawerOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-slate-900/60"
          />
          <div className="relative flex h-full w-64 flex-col bg-slate-900">
            {brand}
            {navLinks}
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="btn-ghost -ml-2 px-2 py-2"
            aria-label="Open navigation"
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="text-[15px] leading-tight font-semibold text-slate-900">
            MantraSphere
            <span className="block text-[11px] font-normal text-slate-500">Platform</span>
          </span>
        </header>
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}

function NavIcon({ icon }: { icon: ReactNode }) {
  const { pending } = useLinkStatus();
  if (!pending) return <>{icon}</>;
  return (
    <span role="status" aria-label="Loading" className="flex h-5 w-5 shrink-0 items-center justify-center">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent opacity-70" />
    </span>
  );
}
