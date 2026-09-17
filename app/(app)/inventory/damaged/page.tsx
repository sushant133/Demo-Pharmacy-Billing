import type { Metadata } from "next";
import { MovementScreen, type MovementScreenParams } from "../movement-page";

export const metadata: Metadata = { title: "Damaged / expired stock" };
export const dynamic = "force-dynamic";

/**
 * Units written off as broken, spoiled, expired or recalled.
 *
 * Kept apart from adjustments on purpose. An adjustment says the count was
 * wrong; a write-off says the count was right and the stock is gone. They are
 * different lines in a set of accounts, and folding them together would lose
 * the only fact worth keeping about either.
 */
export default async function DamagedPage({
  searchParams,
}: {
  searchParams: Promise<MovementScreenParams>;
}) {
  return MovementScreen({
    title: "Damaged / expired stock",
    subtitle: "Units written off as broken, spoiled, expired or recalled.",
    active: "/inventory/damaged",
    direction: "out",
    kinds: ["damage"],
    mode: "damage",
    params: await searchParams,
    emptyTitle: "Nothing written off in this range",
    emptyDescription:
      "Expired and damaged units leave the shelf from the form above, and the loss is booked at what the stock cost.",
  });
}
