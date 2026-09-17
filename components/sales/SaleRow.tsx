"use client";

import { useRouter } from "next/navigation";
import type { ReactNode, MouseEvent } from "react";
import { cx } from "@/components/ui";

/**
 * A sales row you can click anywhere on to open the bill.
 *
 * A cashier hunting for one bill among twenty-five should not have to land on
 * a ten-pixel link, so the whole row is the target. Three things keep that
 * from becoming a trap:
 *
 *   - A click that started on something else - the bill-number link, the
 *     Print link, a future checkbox - is left alone. Without this, "Print"
 *     would open the detail screen instead of printing.
 *   - The row is *not* focusable and carries no role. The bill number inside
 *     it is a real link, so keyboard and screen-reader users already have a
 *     labelled way through, and adding a second tab stop per row would make
 *     the table 25 stops longer for no new destination.
 *   - Selecting text does not navigate. Reading a phone number off the screen
 *     usually means dragging across it, and a drag that ends in a click event
 *     would otherwise throw the page away mid-read.
 */
export function SaleRow({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  const router = useRouter();

  function onClick(event: MouseEvent<HTMLTableRowElement>) {
    // Let the browser handle modified clicks: ctrl/cmd-click and middle-click
    // are how people open a bill in a new tab, and hijacking them is worse
    // than not having row clicks at all.
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey) {
      return;
    }
    if (event.button !== 0) return;

    const target = event.target as HTMLElement | null;
    if (target?.closest("a, button, input, select, textarea, label")) return;

    // A drag that selected text is a read, not a click.
    if (window.getSelection()?.toString()) return;

    router.push(href);
  }

  return (
    <tr
      onClick={onClick}
      className={cx(
        "cursor-pointer transition-colors hover:bg-brand-50/50",
        className,
      )}
    >
      {children}
    </tr>
  );
}
