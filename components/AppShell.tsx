"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { cx } from "@/components/ui";
import { NAV_SECTIONS, type NavChild, type NavItem } from "@/components/nav-items";
import { brandLetter, initials } from "@/lib/format";
import { ROLE_LABELS, can, type Role } from "@/lib/roles";

/**
 * Application chrome: sidebar, mobile drawer and user menu.
 *
 * Client component because the nav needs the current path and a drawer toggle.
 * It receives the session as a prop rather than fetching it, so the server
 * stays the single source of truth for identity.
 *
 * The menu itself lives in components/nav-items.tsx. This file owns only the
 * behaviour around it: which rows the role may see, which sub-menu is open,
 * which row is highlighted, and how a click is made to feel instant.
 */

export interface ShellUser {
  name: string;
  email: string;
  role: Role;
  branchName: string;
  /** Live trading name. The only brand the pharmacy owner should see. */
  pharmacyName: string;
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

/** Remembers which sub-menus the user left open, per browser. */
const OPEN_KEY = "pharma.nav.open";

/** The path part of an href, with any query string dropped. */
function pathOf(href: string): string {
  const index = href.indexOf("?");
  return index === -1 ? href : href.slice(0, index);
}

/**
 * Every menu href that carries a query, such as `/alerts?tab=expiry`.
 *
 * These are filtered views of a screen another row already owns, and the two
 * rows must not light up together. Collected once from the menu rather than
 * hard-coded, so adding a filtered entry needs no change to `matches`.
 */
const FILTERED_HREFS = new Set(
  NAV_SECTIONS.flatMap((section) =>
    section.items.flatMap((item) => [
      ...(item.href.includes("?") ? [item.href] : []),
      ...(item.children ?? [])
        .map((child) => child.href)
        .filter((href) => href.includes("?")),
    ]),
  ),
);

/**
 * Which sub-menus start open, before anything is read back from localStorage.
 *
 * Only *items* collapse now - Inventory and Staff, which own real sub-routes.
 * The five group headings do not, and that is the point: with them collapsible
 * it was possible to arrive at a sidebar showing nothing but five accordion
 * stubs over an empty column, which is what a returning user got as soon as
 * their last session had them closed. Sixteen rows fit in the column without
 * scrolling, so hiding them bought nothing and cost the whole menu.
 *
 * Computed from the path alone so the server and the first client render
 * agree: the sub-menu holding the current route starts open.
 */
function defaultOpenState(path: string): Record<string, boolean> {
  const state: Record<string, boolean> = {};
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      if (item.children) {
        state[`item:${item.href}`] = item.children.some((child) =>
          matches(path, child.href),
        );
      }
    }
  }
  return state;
}

export function AppShell({
  user,
  scope,
  branches,
  alertCount = 0,
  children,
}: {
  user: ShellUser;
  scope: ShellScope;
  branches: ShellBranch[];
  /** Pending alerts - low stock, expired and near-expiry lots. */
  alertCount?: number;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // The href just clicked. Held so the sidebar can move its highlight on the
  // click itself instead of waiting for the server to answer.
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  // Hrefs the pointer or keyboard focus has touched. Hovering upgrades that
  // link to a full prefetch, so the click after it is served from cache.
  const [warm, setWarm] = useState<Record<string, true>>({});

  // Which sub-menus are open. Seeded from the path so the first paint is
  // already right, then merged with what the user left open last time - a
  // pharmacist who lives in Inventory should not reopen it daily.
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    defaultOpenState(pathname),
  );

  // Current URL including its query, so `/alerts?tab=expiry` can highlight
  // separately from plain `/alerts`.
  const currentUrl = useMemo(() => {
    const query = searchParams.toString();
    return query ? `${pathname}?${query}` : pathname;
  }, [pathname, searchParams]);

  // A shop is multi-branch once it has a second outlet. Outlets are opened by
  // the platform on request, so one is the normal state and the rows that only
  // make sense across several stay out of the menu until then.
  const multiBranch = branches.length > 1;

  // Role filter, applied once to the whole tree. A group with nothing left in
  // it disappears rather than showing an empty heading.
  const sections = useMemo(
    () =>
      NAV_SECTIONS.map((section) => ({
        ...section,
        items: section.items
          .filter((item) => can(user.role, item.permission))
          .filter((item) => multiBranch || !item.multiBranchOnly)
          .map((item) => ({
            ...item,
            children: item.children?.filter((child) =>
              can(user.role, child.permission),
            ),
          })),
      })).filter((section) => section.items.length > 0),
    [user.role, multiBranch],
  );

  // Arriving at a sub-route opens the menu that holds it, so the sidebar never
  // hides where you are. Done on the move rather than as a render-time
  // override: otherwise a menu you then close by hand would spring back open
  // and the chevron would look broken.
  useEffect(() => {
    setOpen((current) => {
      let next = current;

      for (const section of NAV_SECTIONS) {
        for (const item of section.items) {
          const key = `item:${item.href}`;
          if (next[key]) continue;
          if (item.children?.some((child) => matches(pathname, child.href))) {
            if (next === current) next = { ...current };
            next[key] = true;
          }
        }
      }
      return next;
    });
  }, [pathname]);

  // localStorage cannot be read while rendering without breaking hydration, so
  // the remembered state is merged in once, after the first paint.
  useEffect(() => {
    let saved: Record<string, boolean>;
    try {
      const raw = window.localStorage.getItem(OPEN_KEY);
      if (!raw) return;
      saved = JSON.parse(raw) as Record<string, boolean>;
    } catch {
      // Private mode, or a corrupt value: the path-based defaults stand.
      return;
    }

    setOpen((current) => {
      const merged = { ...current };
      for (const [key, value] of Object.entries(saved)) {
        // Only keys the menu still has. A renamed section must not linger.
        if (key in merged && typeof value === "boolean") merged[key] = value;
      }
      return merged;
    });
  }, []);

  const toggle = useCallback((key: string) => {
    setOpen((current) => {
      const next = { ...current, [key]: !current[key] };
      try {
        window.localStorage.setItem(OPEN_KEY, JSON.stringify(next));
      } catch {
        // Not being able to remember the menu is not worth an error.
      }
      return next;
    });
  }, []);

  // The route committed, so the optimistic highlight has caught up with reality.
  useEffect(() => {
    setPendingHref(null);
  }, [currentUrl]);

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

  // `isActive` is the route the browser is actually on and drives aria-current,
  // which must not lie. `isHighlighted` is allowed to run one click ahead of it.
  const isActive = (href: string) => matches(currentUrl, href);
  const isHighlighted = (href: string) => matches(pendingHref ?? currentUrl, href);

  const onNavigate = (href: string) => {
    setPendingHref(href);
    setDrawerOpen(false);
  };

  const navLinks = (
    <nav
      aria-label="Pharmacy"
      className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-3"
    >
      {sections.map((section) => (
        <div key={section.title ?? "top"} className={section.title ? "pt-4" : ""}>
          {section.title ? (
            <p className="px-3 pb-1.5 text-[11px] font-semibold tracking-[0.08em] text-slate-400 uppercase">
              {section.title}
            </p>
          ) : null}

          <div className="space-y-0.5">
            {section.items.map((item) => {
              const itemKey = `item:${item.href}`;
              const subOpen =
                Boolean(item.children?.length) && Boolean(open[itemKey]);

              return (
                <div key={item.href}>
                  <NavLink
                    item={item}
                    current={isActive(item.href)}
                    highlighted={isHighlighted(item.href)}
                    badgeCount={item.badge === "alerts" ? alertCount : 0}
                    prefetchFull={Boolean(warm[item.href])}
                    subOpen={subOpen}
                    onToggleSub={
                      item.children?.length ? () => toggle(itemKey) : undefined
                    }
                    onWarm={() => warmUp(item.href)}
                    onNavigate={() => onNavigate(item.href)}
                  />

                  {item.children?.length && subOpen ? (
                    <div className="mt-0.5 mb-1 ml-[1.55rem] space-y-0.5 border-l border-slate-700/70 pl-2.5">
                      {item.children.map((child) => (
                        <SubNavLink
                          key={child.href}
                          child={child}
                          current={isActive(child.href)}
                          highlighted={isHighlighted(child.href)}
                          prefetchFull={Boolean(warm[child.href])}
                          onWarm={() => warmUp(child.href)}
                          onNavigate={() => onNavigate(child.href)}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );

  const shopName = user.pharmacyName.trim() || "Pharmacy";
  const shopMark = brandLetter(shopName);

  const brand = (
    <div className="flex items-center gap-2.5 border-b border-slate-700/60 px-5 py-4">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-400 to-brand-600 text-base font-bold text-white shadow-sm">
        {shopMark}
      </span>
      <span className="min-w-0 truncate text-[15px] leading-tight font-semibold text-white">
        {shopName}
      </span>
    </div>
  );

  return (
    <div className="min-h-dvh lg:flex">
      {/* Desktop sidebar */}
      {/*
        `app-sidebar` carries the dark ground and the focus ring that reads
        correctly on it - see app/globals.css. The hairline on the right
        separates the column from the light content area without a shadow.
      */}
      <aside className="app-sidebar hidden w-64 shrink-0 flex-col border-r border-slate-950/60 lg:sticky lg:top-0 lg:flex lg:h-dvh">
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
            className="absolute inset-0 bg-slate-950/70 backdrop-blur-[2px]"
          />
          <div className="app-sidebar relative flex h-full w-[17rem] max-w-[85vw] flex-col shadow-2xl">
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
            className="btn-ghost relative -ml-2 px-2 py-2"
            aria-label={
              alertCount > 0
                ? `Open navigation, ${alertCount} pending alerts`
                : "Open navigation"
            }
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
            {alertCount > 0 ? (
              <span
                aria-hidden="true"
                className="absolute top-1 right-1 h-2 w-2 rounded-full bg-rose-500 ring-2 ring-white"
              />
            ) : null}
          </button>
          <span className="min-w-0 truncate text-[15px] leading-tight font-semibold text-slate-900">
            {shopName}
          </span>
          <span className="ml-auto flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-800">
            {initials(user.name)}
          </span>
        </header>

        <main
          className={cx(
            "min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8",
            pathname === "/billing" &&
              "px-3 py-3 pb-[calc(5.5rem+env(safe-area-inset-bottom))] sm:px-4 lg:px-8 lg:py-6 lg:pb-6",
          )}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

/**
 * Does `url` (a live path, possibly with a query) belong to `href`?
 *
 * Two wrinkles the plain prefix test gets wrong:
 *
 *   - `/sales` must not swallow `/sales/returns`, which is its own menu row.
 *   - A menu row carrying a query, such as `/alerts?tab=expiry`, is a filtered
 *     view. It matches only that exact view, and the plain row for the same
 *     screen stands down for it - but only for that one view. On
 *     `/alerts?tab=stock`, which no row claims, plain `/alerts` is still the
 *     right answer.
 */
function matches(url: string, href: string): boolean {
  const path = pathOf(url);
  const target = pathOf(href);

  if (href.includes("?")) return url === href;
  if (FILTERED_HREFS.has(url) && path === target) return false;

  if (target === "/sales") {
    return (
      path === "/sales" ||
      (path.startsWith("/sales/") && !path.startsWith("/sales/returns"))
    );
  }
  if (target === "/purchases") {
    // Same shape as /sales above: the register owns its own detail pages, but
    // Purchase Returns is a row in its own right and must not light both.
    return (
      path === "/purchases" ||
      (path.startsWith("/purchases/") && !path.startsWith("/purchases/returns"))
    );
  }
  if (target === "/inventory") {
    // The parent row owns the hub only; its sub-routes light their own rows.
    return path === "/inventory";
  }

  return path === target || path.startsWith(target + "/");
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={cx("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-90")}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2.2}
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
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
 *
 * A row with children carries its own expander button, kept outside the link
 * so opening the sub-menu never navigates.
 */
function NavLink({
  item,
  current,
  highlighted,
  badgeCount,
  prefetchFull,
  subOpen,
  onToggleSub,
  onWarm,
  onNavigate,
}: {
  item: NavItem;
  current: boolean;
  highlighted: boolean;
  badgeCount: number;
  prefetchFull: boolean;
  subOpen: boolean;
  onToggleSub?: () => void;
  onWarm: () => void;
  onNavigate: () => void;
}) {
  // The brand fill means one thing only: this is the screen you are on. It
  // follows the selection and nothing else claims it, so the eye can use it to
  // answer "where am I" without first learning which row is merely advertising
  // itself. The current row also gets a left accent bar - on a dark column a
  // fill alone has to be strong to register, and a 3px rule carries the same
  // message while letting the fill stay quiet enough to read the label against.
  const tone = highlighted
    ? "bg-brand-600 text-white shadow-sm"
    : "text-slate-300 hover:bg-white/5 hover:text-white";

  const filled = highlighted;

  return (
    <div
      className={cx(
        "relative flex items-center gap-1 rounded-lg transition-colors",
        tone,
      )}
    >
      {highlighted ? (
        <span
          aria-hidden="true"
          className="absolute top-1.5 bottom-1.5 -left-3 w-[3px] rounded-r-full bg-brand-300"
        />
      ) : null}
      <Link
        href={item.href}
        prefetch={prefetchFull ? true : undefined}
        onMouseEnter={onWarm}
        onFocus={onWarm}
        onTouchStart={onWarm}
        onClick={onNavigate}
        aria-current={current ? "page" : undefined}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium"
      >
        <NavIcon icon={item.icon} />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>

        {badgeCount > 0 ? (
          <span
            title={`${badgeCount} pending alerts`}
            className={cx(
              "tnum min-w-[1.25rem] rounded-full px-1.5 py-0.5 text-center text-[10px] leading-none font-bold",
              filled ? "bg-white text-brand-700" : "bg-rose-500 text-white",
            )}
          >
            {badgeCount > 99 ? "99+" : badgeCount}
            <span className="sr-only"> pending alerts</span>
          </span>
        ) : null}

        {item.hint ? (
          <kbd
            className={cx(
              "rounded px-1.5 py-0.5 text-[10px] font-semibold",
              filled ? "bg-white/20 text-white" : "bg-white/10 text-slate-300",
            )}
          >
            {item.hint}
          </kbd>
        ) : null}
      </Link>

      {onToggleSub ? (
        <button
          type="button"
          onClick={onToggleSub}
          aria-expanded={subOpen}
          aria-label={`${subOpen ? "Hide" : "Show"} ${item.label} sections`}
          className={cx(
            "mr-1 rounded p-1.5 transition-colors",
            filled ? "hover:bg-white/15" : "text-slate-400 hover:bg-white/5 hover:text-white",
          )}
        >
          <Chevron open={subOpen} />
        </button>
      ) : null}
    </div>
  );
}

/** A row inside an expanded parent. No icon, so the indent carries the nesting. */
function SubNavLink({
  child,
  current,
  highlighted,
  prefetchFull,
  onWarm,
  onNavigate,
}: {
  child: NavChild;
  current: boolean;
  highlighted: boolean;
  prefetchFull: boolean;
  onWarm: () => void;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={child.href}
      prefetch={prefetchFull ? true : undefined}
      onMouseEnter={onWarm}
      onFocus={onWarm}
      onTouchStart={onWarm}
      onClick={onNavigate}
      aria-current={current ? "page" : undefined}
      className={cx(
        "block truncate rounded-md px-3 py-1.5 text-[13px] transition-colors",
        highlighted
          ? "bg-white/10 font-medium text-white"
          : "text-slate-400 hover:bg-white/5 hover:text-white",
      )}
    >
      {child.label}
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
    <div className="border-t border-slate-700/60 p-3">
      {/*
        Two lines, not three. The pharmacy's name is already the largest thing
        in the column, at the top - repeating it here only pushed the branch
        out of its own line and truncated both ("Mantra Pharmacy · Mantra Ph…").
        Who you are and what you may do is what this card is for; where you are
        is the switcher directly below it.
      */}
      <div className="flex items-center gap-3 rounded-lg bg-white/5 px-2.5 py-2">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-500 text-xs font-semibold text-white">
          {initials(user.name)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white">{user.name}</p>
          <p className="truncate text-xs text-slate-400">{ROLE_LABELS[user.role]}</p>
        </div>
      </div>

      {scope.switchable && branches.length > 1 ? (
        <BranchSwitcher current={scope.code ?? "all"} branches={branches} />
      ) : user.branchName ? (
        // No switcher to show where they are, so the card says it instead.
        <p className="mt-2 truncate px-2.5 text-[11px] text-slate-500">
          {user.branchName}
        </p>
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
    <label className="mt-2 block px-0.5">
      <span className="mb-1 block px-2 text-[10px] font-medium tracking-wide text-slate-500 uppercase">
        Working at
      </span>

      {/*
        The native control is kept - it is the right thing on a touch screen at
        a counter, and on Android it opens the platform picker. Only its skin
        is replaced: the default arrow is dropped for one drawn to match the
        sidebar's chevrons, and the box is lifted off the column rather than
        painted the same colour as it, which is what made it look unfinished.
      */}
      <div className="relative">
        <select
          value={current}
          disabled={pending}
          onChange={(event) => onChange(event.target.value)}
          className="w-full appearance-none rounded-lg border border-slate-700/80 bg-slate-800 py-2 pr-8 pl-2.5 text-xs font-medium text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-700 focus:border-brand-500 focus:outline-none disabled:opacity-60"
        >
          <option value="all">All branches</option>
          {branches.map((branch) => (
            <option key={branch.code} value={branch.code}>
              {branch.name}
            </option>
          ))}
        </select>

        <svg
          className="pointer-events-none absolute top-1/2 right-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2.2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
        </svg>
      </div>
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
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-400 transition-colors hover:bg-white/5 hover:text-white"
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
