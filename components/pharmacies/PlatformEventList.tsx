import Link from "next/link";
import { formatDateTime } from "@/lib/format";
import {
  PLATFORM_ACTION_LABELS,
  PLATFORM_ACTION_TONE,
  type PlatformEventEntry,
} from "@/lib/platform-events";
import { Badge } from "@/components/ui";

/**
 * The platform audit trail, rendered.
 *
 * A server component with no state of its own, shared by the account page and
 * the platform-wide Activity screen: the two differ only in whether the shop
 * is worth naming on every row.
 *
 * A deleted pharmacy keeps its rows - that is the point of writing them
 * outside the tenant - so the shop's name is plain text unless it is still
 * there to link to.
 */
export function PlatformEventList({
  rows,
  showPharmacy = true,
  linkPharmacy = true,
}: {
  rows: PlatformEventEntry[];
  showPharmacy?: boolean;
  linkPharmacy?: boolean;
}) {
  if (rows.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-slate-500">
        Nothing recorded yet.
      </p>
    );
  }

  return (
    <ol className="divide-y divide-slate-100">
      {rows.map((row) => (
        <li key={row.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-3">
          <Badge tone={PLATFORM_ACTION_TONE[row.action] ?? "slate"}>
            {PLATFORM_ACTION_LABELS[row.action] ?? row.action}
          </Badge>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-slate-900">{row.summary}</p>
            {row.detail ? (
              <p className="text-xs text-slate-500">{row.detail}</p>
            ) : null}
            <p className="mt-0.5 text-xs text-slate-500">
              {row.actorName || "Unknown"}
              <span className="mx-1.5 text-slate-300">·</span>
              {formatDateTime(row.at)}
              {showPharmacy && row.pharmacyName ? (
                <>
                  <span className="mx-1.5 text-slate-300">·</span>
                  {linkPharmacy && row.pharmacyId ? (
                    <Link
                      href={`/superadmin/pharmacies/${row.pharmacyId}`}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {row.pharmacyName}
                    </Link>
                  ) : (
                    row.pharmacyName
                  )}
                </>
              ) : null}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
