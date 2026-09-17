import type { Metadata } from "next";
import { MovementScreen, type MovementScreenParams } from "../movement-page";

export const metadata: Metadata = { title: "Stock transfer" };
export const dynamic = "force-dynamic";

/**
 * Moving lots between this pharmacy's branches.
 *
 * Both halves are listed: a transfer is an out at the source and an in at the
 * destination, sharing one reference, and under an "all branches" scope both
 * are visible on the same screen.
 */
export default async function TransfersPage({
  searchParams,
}: {
  searchParams: Promise<MovementScreenParams>;
}) {
  return MovementScreen({
    title: "Stock transfer",
    subtitle: "Moving lots between this pharmacy's branches.",
    active: "/inventory/transfers",
    direction: "both",
    kinds: ["transfer-out", "transfer-in"],
    mode: "transfer",
    params: await searchParams,
    emptyTitle: "No transfers in this range",
    emptyDescription:
      "Send units from the form above and both halves of the move appear here, sharing one reference.",
  });
}
