import type { Metadata } from "next";
import { requirePagePermission } from "@/lib/auth";
import { can } from "@/lib/roles";
import { MovementScreen, type MovementScreenParams } from "../movement-page";

export const metadata: Metadata = { title: "Stock adjustment" };
export const dynamic = "force-dynamic";

/**
 * Correcting a lot's count when the shelf and the system disagree.
 *
 * Both directions, because a count can be wrong either way and a screen that
 * showed only the shortfalls would hide half of what a stock-take found.
 */
export default async function AdjustmentsPage({
  searchParams,
}: {
  searchParams: Promise<MovementScreenParams>;
}) {
  const user = await requirePagePermission("batch:read");
  const canWrite = can(user.role, "batch:write");

  return MovementScreen({
    title: "Stock adjustment",
    subtitle: "Correcting a lot's count when the shelf and the system disagree.",
    active: "/inventory/adjustments",
    direction: "both",
    kinds: ["adjustment"],
    mode: "adjust",
    params: await searchParams,
    /*
      "Kinds" is the shared word across all five movement screens, where it
      covers receipts, dispensing and transfers alike. Here the list is only
      ever adjustments, so the tile says what it is actually counting.
    */
    statLabels: { units: "Units adjusted", kinds: "Adjustment types" },
    /*
      The form is already open above the ledger for anyone who may write, so
      this jumps to it rather than opening a second one. An anchor rather than
      a button: no state, no JavaScript, and it survives a page refresh.
    */
    actions: canWrite ? (
      <a href="#record" className="btn-primary">
        <svg
          className="h-4.5 w-4.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.9}
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path strokeLinecap="round" d="M12 8.5v7M8.5 12h7" />
        </svg>
        New adjustment
      </a>
    ) : null,
    emptyTitle: "No corrections in this range",
    emptyDescription:
      "Counts only change here when somebody corrects one, and every correction keeps its reason and its author.",
  });
}
