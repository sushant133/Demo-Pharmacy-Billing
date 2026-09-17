import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { can } from "@/lib/roles";
import { MovementScreen, type MovementScreenParams } from "../movement-page";

export const metadata: Metadata = { title: "Stock in" };
export const dynamic = "force-dynamic";

/**
 * Everything that put units on the shelf.
 *
 * Read from the documents that already record it - posted GRNs and customer
 * returns - folded together with the adjustments and transfers this system
 * writes itself. Nothing was copied into a second ledger, so the list is
 * correct for stock received long before this screen existed.
 */
export default async function StockInPage({
  searchParams,
}: {
  searchParams: Promise<MovementScreenParams>;
}) {
  const user = await requirePagePermission("batch:read");

  return MovementScreen({
    title: "Stock in",
    subtitle: "Every receipt that added units to the shelf.",
    active: "/inventory/stock-in",
    direction: "in",
    kinds: ["purchase", "sale-return", "transfer-in", "adjustment"],
    params: await searchParams,
    /*
      The action this screen exists to lead to.

      Receiving is not something this page can do itself - stock enters only
      through a posted GRN, which is the rule the whole inventory model rests
      on - so the button goes to the purchase form rather than opening a
      shortcut that would quietly become a second way for stock to appear.
    */
    actions: can(user.role, "purchase:write") ? (
      <Link href="/purchases/new" className="btn-primary">
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
        Receive stock
      </Link>
    ) : null,
    statLabels: { units: "Units received", kinds: "Movement types" },
    emptyTitle: "Nothing came in over this range",
    emptyDescription:
      "Widen the dates, or clear the search. Units arrive when a purchase is posted, a customer returns something, or a transfer lands.",
  });
}
