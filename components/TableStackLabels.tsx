"use client";

import { useEffect, useRef } from "react";

/**
 * Names every cell after its column, for the phone card layout.
 *
 * Below `sm` a `TableWrap` lays each row out as a card, and each field needs
 * its column's name beside it - "Selling price", "In stock". Those names are
 * already in the header row, so rather than every page repeating them on
 * every cell, this copies each header's text onto the cells under it as
 * `data-label`, which the stylesheet prints above the value.
 *
 * Rows arrive and leave without a reload (filters, pagination, a row added
 * from a panel), so it re-labels whenever the table's rows change.
 */
export function TableStackLabels() {
  const markerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const table = markerRef.current?.parentElement?.querySelector("table");
    if (!table) return;

    let frame = 0;

    function label() {
      frame = 0;
      const headRow = table!.tHead?.rows[table!.tHead.rows.length - 1];
      if (!headRow) return;

      // Column index -> header text, honouring header cells that span.
      const names: string[] = [];
      for (const cell of Array.from(headRow.cells)) {
        const text = (cell.textContent ?? "").replace(/\s+/g, " ").trim();
        for (let i = 0; i < cell.colSpan; i += 1) names.push(text);
      }

      const sections = [...Array.from(table!.tBodies), table!.tFoot].filter(
        (section): section is HTMLTableSectionElement => section !== null,
      );

      for (const section of sections) {
        for (const row of Array.from(section.rows)) {
          let column = 0;
          for (const cell of Array.from(row.cells)) {
            const name = cell.colSpan === 1 ? names[column] : undefined;
            if (name) {
              if (cell.dataset.label !== name) cell.dataset.label = name;
            } else if (cell.dataset.label !== undefined) {
              delete cell.dataset.label;
            }
            column += cell.colSpan;
          }
        }
      }
    }

    label();

    const observer = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(label);
    });
    observer.observe(table, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return <span ref={markerRef} hidden />;
}
