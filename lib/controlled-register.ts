/**
 * The arithmetic of the narcotic and psychotropic record.
 *
 * Follows DDA's retailer format: one running record per drug, each line either
 * units received or units dispensed, with the quantity in stock after it. Kept
 * pure and away from the database, like FEFO, because it fails the same way -
 * by being quietly wrong in a book an inspector reads.
 */

export interface RegisterEvent {
  medicineId: string;
  at: Date;
  /** Positive for units coming in, negative for units going out. */
  delta: number;
  batch: string;
  supplier?: string;
  patient?: string;
  prescribedBy?: string;
  recipient?: string;
  dispenser?: string;
  remarks?: string;
  /** The class it moved under, when that may differ from the medicine's today. */
  schedule?: string;
  /** Moves the balance but is not listed: sold before the drug was controlled. */
  unlisted?: boolean;
}

export interface RegisterLine extends RegisterEvent {
  /** What the shelf held once this had happened. */
  inStock: number;
}

/**
 * Lines inside the period, each with its running balance.
 *
 * Today's stock is the one figure known for certain, so the balance is walked
 * back from it. `events` must therefore run from the start of the period up to
 * now, not just to the end of the period; those after `to` only move the balance
 * and are not listed.
 */
export function registerLines(
  events: readonly RegisterEvent[],
  currentStock: ReadonlyMap<string, number>,
  to: Date,
): RegisterLine[] {
  const byMedicine = new Map<string, RegisterEvent[]>();
  for (const event of events) {
    const list = byMedicine.get(event.medicineId) ?? [];
    list.push(event);
    byMedicine.set(event.medicineId, list);
  }

  const lines: RegisterLine[] = [];
  for (const [medicineId, list] of byMedicine) {
    const ordered = [...list].sort((a, b) => a.at.getTime() - b.at.getTime());
    const moved = ordered.reduce((sum, event) => sum + event.delta, 0);
    let balance = (currentStock.get(medicineId) ?? 0) - moved;
    for (const event of ordered) {
      balance += event.delta;
      if (event.at < to && !event.unlisted) lines.push({ ...event, inStock: balance });
    }
  }
  return lines;
}
