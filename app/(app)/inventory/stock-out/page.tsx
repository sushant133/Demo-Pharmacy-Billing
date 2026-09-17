import type { Metadata } from "next";
import { MovementScreen, type MovementScreenParams } from "../movement-page";

export const metadata: Metadata = { title: "Stock out" };
export const dynamic = "force-dynamic";

/**
 * Everything that took units off the shelf.
 *
 * Dispensing is read off the bills themselves, so this is the stock-side view
 * of the same events - plus the ones that are not sales, which until now were
 * not recorded anywhere at all. Voided bills are excluded: their units went
 * back, so counting them would report dispensing that did not happen.
 */
export default async function StockOutPage({
  searchParams,
}: {
  searchParams: Promise<MovementScreenParams>;
}) {
  return MovementScreen({
    title: "Stock out",
    subtitle: "Every movement that took units off the shelf.",
    active: "/inventory/stock-out",
    direction: "out",
    kinds: ["sale", "damage", "transfer-out", "adjustment"],
    params: await searchParams,
    emptyTitle: "Nothing went out over this range",
    emptyDescription:
      "Widen the dates, or clear the search. Units leave on a bill, on a transfer, or when they are written off.",
  });
}
