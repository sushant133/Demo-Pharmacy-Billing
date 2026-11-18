import Link from "next/link";
import { cx } from "@/components/ui";
import { nepaliPeriodList } from "@/lib/periods";

/**
 * One-click Nepali periods - this month, last month, this and last fiscal
 * year - for a register filtered by `from` / `to`. Other filters in `keep`
 * travel with the link.
 */
export function PeriodLinks({
  basePath,
  from,
  to,
  keep,
}: {
  basePath: string;
  from: string;
  to: string;
  keep?: Record<string, string | null | undefined>;
}) {
  const periods = nepaliPeriodList();
  if (periods.length === 0) return null;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5">
      {periods.map((period) => {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(keep ?? {})) if (value) query.set(key, value);
        query.set("from", period.from);
        query.set("to", period.to);
        const active = period.from === from && period.to === to;
        return (
          <Link
            key={period.key}
            href={`${basePath}?${query.toString()}`}
            className={cx(
              "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
              active ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200",
            )}
          >
            {period.label}
          </Link>
        );
      })}
    </div>
  );
}
