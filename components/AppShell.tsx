"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { cx } from "@/components/ui";
import { initials } from "@/lib/format";
import { ROLE_LABELS, can, type Permission, type Role } from "@/lib/roles";

/**
 * Application chrome: sidebar, mobile drawer and user menu.
 *
 * Client component because the nav needs the current path and a drawer toggle.
 * It receives the session as a prop rather than fetching it, so the server
 * stays the single source of truth for identity.
 */

interface NavItem {
  href: string;
  label: string;
  permission: Permission;
  icon: ReactNode;
  hint?: string;
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
    href: "/dashboard",
    label: "Dashboard",
    permission: "report:read",
    icon: icon("M3 12l9-9 9 9M5 10v10h14V10"),
  },
  {
    href: "/billing",
    label: "New Sale",
    permission: "sale:create",
    hint: "F2",
    icon: icon(
      "M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2 5h14M9 21a1 1 0 100-2 1 1 0 000 2zm8 0a1 1 0 100-2 1 1 0 000 2z",
    ),
  },
  {
    href: "/sales",
    label: "Sales",
    permission: "sale:read",
    icon: icon("M9 17V9m4 8V5m4 12v-6M4 20h16"),
  },
  {
    href: "/alerts",
    label: "Alerts",
    permission: "report:read",
    icon: icon("M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2a2 2 0 01-.6 1.4L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"),
  },
  {
    href: "/reports",
    label: "Reports",
    permission: "report:financial",
    icon: icon("M9 17V9m4 8V5m4 12v-6M4 4v16h16"),
  },
  {
    href: "/purchases",
    label: "Purchases",
    permission: "purchase:read",
    icon: icon("M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.6L19 8.4V19a2 2 0 01-2 2z"),
  },
  {
    href: "/suppliers",
    label: "Suppliers",
    permission: "supplier:read",
    icon: icon("M3 21h18M5 21V7l7-4 7 4v14M9 21v-5h6v5"),
  },
  {
    href: "/medicines",
    label: "Medicines",
    permission: "medicine:read",
    icon: icon(
      "M10.5 20.5a4.95 4.95 0 01-7-7l6-6a4.95 4.95 0 017 7l-6 6zM7 11l6 6",
    ),
  },
  {
    href: "/batches",
    label: "Stock & Batches",
    permission: "batch:read",
    icon: icon("M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"),
  },
  {
    href: "/branches",
    label: "Branches",
    permission: "branch:manage",
    icon: icon("M8 21V9l4-4 4 4v12M3 21h18M10 13h4"),
  },
  {
    href: "/settings",
    label: "Settings",
    permission: "settings:manage",
    icon: icon(
      "M10.3 4.3a1.9 1.9 0 013.4 0l.4.8a1.9 1.9 0 002.2.9l.9-.2a1.9 1.9 0 012.3 2.3l-.2.9a1.9 1.9 0 00.9 2.2l.8.4a1.9 1.9 0 010 3.4l-.8.4a1.9 1.9 0 00-.9 2.2l.2.9a1.9 1.9 0 01-2.3 2.3l-.9-.2a1.9 1.9 0 00-2.2.9l-.4.8a1.9 1.9 0 01-3.4 0l-.4-.8a1.9 1.9 0 00-2.2-.9l-.9.2a1.9 1.9 0 01-2.3-2.3l.2-.9a1.9 1.9 0 00-.9-2.2l-.8-.4a1.9 1.9 0 010-3.4l.8-.4a1.9 1.9 0 00.9-2.2l-.2-.9a1.9 1.9 0 012.3-2.3l.9.2a1.9 1.9 0 002.2-.9l.4-.8zM12 15a3 3 0 100-6 3 3 0 000 6z",
    ),
  },
];

export interface ShellUser {
  name: string;
  email: string;
  role: Role;
  branchName: string;
}

export interface ShellScope {
  code: string | null;
  label: string;
  switchable: boolean;
}

export interface ShellBranch {
  id: string;
  code: string;
  name: string;
}

export function AppShell({
  user,
  scope,
  branches,
  children,
}: {
  user: ShellUser;
  scope: ShellScope;
  branches: ShellBranch[];
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // The href just clicked. Held so the sidebar can move its highlight on the
  // click itself instead of waiting for the server to answer.
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  // Hrefs the pointer or keyboard focus has touched. Hovering upgrades that
  // link to a full prefetch, so the click after it is served from cache.
  const [warm, setWarm] = useState<Record<string, true>>({});

  const items = NAV.filter((item) => can(user.role, item.permission));

  // The route committed, so the optimistic highlight has caught up with reality.
  useEffect(() => {
    setPendingHref(null);
  }, [pathname]);

  const warmUp = useCallback((href: string) => {
    setWarm((current) => (current[href] ? current : { ...current, [href]: true }));
  }, []);

  // F2 jumps straight to billing from anywhere - the one shortcut a busy
  // counter actually uses. Ignored while typing so it can't hijack a field.
  useEffect(() => {
    if (!can(user.role, "sale:create")) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "F2") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      event.preventDefault();
      router.push("/billing");
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router, user.role]);

  const matches = (path: string, href: string) =>
    path === href || path.startsWith(href + "/");

  // `isActive` is the route the browser is actually on and drives aria-current,
  // which must not lie. `isHighlighted` is allowed to run one click ahead of it.
  const isActive = (href: string) => matches(pathname, href);
  const isHighlighted = (href: string) => matches(pendingHref ?? pathname, href);

  const navLinks = (
    <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3">
      {items.map((item) => (
        <NavLink
          key={item.href}
          item={item}
          current={isActive(item.href)}
          highlighted={isHighlighted(item.href)}
          prefetchFull={Boolean(warm[item.href])}
          onWarm={() => warmUp(item.href)}
          onNavigate={() => {
            setPendingHref(item.href);
            setDrawerOpen(false);
          }}
        />
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
          Pharmacy Suite
        </span>
      </span>
    </div>
  );

  return (
    <div className="min-h-dvh lg:flex">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col bg-slate-900 lg:sticky lg:top-0 lg:flex lg:h-dvh">
        {brand}
        {navLinks}
        <UserCard user={user} scope={scope} branches={branches} />
      </aside>

      {/* Mobile drawer */}
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
            <UserCard user={user} scope={scope} branches={branches} />
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="btn-ghost -ml-2 px-2 py-2"
            aria-label="Open navigation"
          >
            <svg
              className="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.8}
            >
              <path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="text-[15px] leading-tight font-semibold text-slate-900">
            MantraSphere
            <span className="block text-[11px] font-normal text-slate-500">
              Pharmacy Suite
            </span>
          </span>
          <span className="ml-auto flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-800">
            {initials(user.name)}
          </span>
        </header>

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}

/**
 * One sidebar entry.
 *
 * Three things decide whether a menu click feels instant, and only one of them
 * is the server:
 *
 *   - The row highlights from the click, not from the committed route, so the
 *     menu answers before the page does.
 *   - `useLinkStatus` swaps the icon for a spinner while that destination is in
 *     flight, which keeps the sidebar honest about what it is doing.
 *   - Hover, focus or first touch upgrades the link to a full prefetch. Every
 *     screen here is `force-dynamic`, so the default prefetch stops at the
 *     loading skeleton; the upgrade pulls the real payload, and the click that
 *     follows is a paint rather than a round trip. Doing it on intent rather
 *     than on sight keeps ten screens from being rendered on every page view.
 *     Next disables prefetching in development, so this only shows up in a
 *     production build.
 */
function NavLink({
  item,
  current,
  highlighted,
  prefetchFull,
  onWarm,
  onNavigate,
}: {
  item: NavItem;
  current: boolean;
  highlighted: boolean;
  prefetchFull: boolean;
  onWarm: () => void;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={item.href}
      prefetch={prefetchFull ? true : undefined}
      onMouseEnter={onWarm}
      onFocus={onWarm}
      onTouchStart={onWarm}
      onClick={onNavigate}
      aria-current={current ? "page" : undefined}
      className={cx(
        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
        highlighted
          ? "bg-brand-600 text-white shadow-sm"
          : "text-slate-300 hover:bg-slate-800 hover:text-white",
      )}
    >
      <NavIcon icon={item.icon} />
      <span className="flex-1">{item.label}</span>
      {item.hint ? (
        <kbd
          className={cx(
            "rounded px-1.5 py-0.5 text-[10px] font-semibold",
            highlighted ? "bg-white/20 text-white" : "bg-slate-800 text-slate-400",
          )}
        >
          {item.hint}
        </kbd>
      ) : null}
    </Link>
  );
}

/**
 * The item's icon, or a spinner in its place while that link is navigating.
 * Same box either way, so nothing shifts.
 */
function NavIcon({ icon }: { icon: ReactNode }) {
  const { pending } = useLinkStatus();

  if (!pending) return <>{icon}</>;

  return (
    <span
      role="status"
      aria-label="Loading"
      className="flex h-5 w-5 shrink-0 items-center justify-center"
    >
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent opacity-70" />
    </span>
  );
}

function UserCard({
  user,
  scope,
  branches,
}: {
  user: ShellUser;
  scope: ShellScope;
  branches: ShellBranch[];
}) {
  return (
    <div className="border-t border-slate-800 p-3">
      <div className="flex items-center gap-3 rounded-lg px-2 py-2">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-500 text-xs font-semibold text-white">
          {initials(user.name)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white">{user.name}</p>
          <p className="truncate text-xs text-slate-400">
            {ROLE_LABELS[user.role]} &middot; {user.branchName}
          </p>
        </div>
      </div>
      {scope.switchable && branches.length > 0 ? (
        <BranchSwitcher current={scope.code ?? "all"} branches={branches} />
      ) : null}
      <div className="mt-1">
        <SignOutButton />
      </div>
    </div>
  );
}

function BranchSwitcher({
  current,
  branches,
}: {
  current: string;
  branches: ShellBranch[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onChange(value: string) {
    setPending(true);
    try {
      await fetch("/api/branches/scope", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: value }),
      });
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <label className="mt-2 block px-2">
      <span className="mb-1 block text-[10px] font-medium tracking-wide text-slate-500 uppercase">
        Working at
      </span>
      <select
        value={current}
        disabled={pending}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200"
      >
        <option value="all">All branches</option>
        {branches.map((branch) => (
          <option key={branch.code} value={branch.code}>
            {branch.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Sign-out posts through fetch so the API can return JSON, then does a hard
 * navigation to /login to guarantee every cached server component is dropped.
 */
function SignOutButton() {
  return (
    <button
      type="button"
      onClick={async () => {
        await fetch("/api/auth/logout", { method: "POST" });
        window.location.href = "/login";
      }}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
    >
      <svg
        className="h-5 w-5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.7}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M15 16l4-4m0 0l-4-4m4 4H9m3 8H6a2 2 0 01-2-2V6a2 2 0 012-2h6"
        />
      </svg>
      Sign out
    </button>
  );
}
