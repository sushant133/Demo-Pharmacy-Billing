import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { withDbRead } from "@/lib/db";
import { listPlatformEvents } from "@/lib/platform-events";
import { PLATFORM_ACTION_LABELS } from "@/lib/platform-events";
import { PLATFORM_ACTIONS, type PlatformAction } from "@/models/PlatformEvent";
import { PlatformEventList } from "@/components/pharmacies/PlatformEventList";
import { Card, PageHeader, Pagination, cx } from "@/components/ui";

export const metadata: Metadata = { title: "Platform activity" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 40;

/**
 * Everything the platform side has done, newest first.
 *
 * The shop-facing equivalent (lib/activity-log.ts) reconstructs history from
 * the documents each action left behind. Nothing on this side leaves one -
 * suspending a shop flips a field, deleting one removes the evidence - so
 * this screen reads a written log instead. It is append-only: there is no
 * edit and no delete, deliberately.
 */
export default async function PlatformActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; page?: string }>;
}) {
  await requirePagePermission("pharmacy:manage");
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);

  const action = (PLATFORM_ACTIONS as readonly string[]).includes(
    params.action ?? "",
  )
    ? (params.action as PlatformAction)
    : "all";

  const { rows, total } = await withDbRead(() =>
    listPlatformEvents({ action, page, pageSize: PAGE_SIZE }),
  );

  const baseQuery = new URLSearchParams();
  if (action !== "all") baseQuery.set("action", action);

  const filters: Array<{ value: string; label: string }> = [
    { value: "all", label: "Everything" },
    ...PLATFORM_ACTIONS.map((value) => ({
      value,
      label: PLATFORM_ACTION_LABELS[value],
    })),
  ];

  return (
    <>
      <PageHeader
        title="Platform activity"
        subtitle="Every action taken from these screens, in the order it happened. Nothing here can be edited."
      />

      <div className="mb-4 flex flex-wrap gap-1">
        {filters.map((filter) => {
          const query = new URLSearchParams();
          if (filter.value !== "all") query.set("action", filter.value);
          const active = action === filter.value;
          return (
            <Link
              key={filter.value}
              href={`/superadmin/activity${query.toString() ? `?${query}` : ""}`}
              className={cx(
                "rounded-lg px-3 py-1.5 text-sm font-medium",
                active
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-slate-100",
              )}
            >
              {filter.label}
            </Link>
          );
        })}
      </div>

      <Card className="px-5 py-2 sm:px-6">
        <PlatformEventList rows={rows} />
      </Card>

      <Pagination
        page={page}
        totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))}
        total={total}
        baseHref={`/superadmin/activity?${baseQuery.toString()}`}
      />
    </>
  );
}
