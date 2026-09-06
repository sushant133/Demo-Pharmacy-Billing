/**
 * Strip vs loose-tablet counting, the way a counter pharmacist talks.
 *
 * Stock, bills and returns are always a plain number of pieces (4 tablets,
 * 6 tablets). Pack size is only a label and a shortcut: a Pantop strip of 10
 * still sells as 4 if that is what the customer asked for.
 */

const LOOSE_UNITS = new Set(["tablet", "capsule", "sachet", "suppository"]);

const UNIT_WORDS: Record<string, { one: string; many: string }> = {
  tablet: { one: "tablet", many: "tablets" },
  capsule: { one: "capsule", many: "capsules" },
  syrup: { one: "bottle", many: "bottles" },
  injection: { one: "vial", many: "vials" },
  ointment: { one: "tube", many: "tubes" },
  cream: { one: "tube", many: "tubes" },
  drops: { one: "bottle", many: "bottles" },
  inhaler: { one: "inhaler", many: "inhalers" },
  sachet: { one: "sachet", many: "sachets" },
  suppository: { one: "suppository", many: "suppositories" },
  other: { one: "unit", many: "units" },
};

/** Pieces you can break out of a strip; a syrup bottle is sold whole. */
export function canSellLoose(unit: string): boolean {
  return LOOSE_UNITS.has(unit);
}

/** "tablet" / "tablets" — what staff say at the till, not the catalogue enum. */
export function unitWord(unit: string, count = 1): string {
  const words = UNIT_WORDS[unit] ?? { one: "unit", many: "units" };
  return Math.abs(count) === 1 ? words.one : words.many;
}

export function formatUnitCount(count: number, unit: string): string {
  return `${count} ${unitWord(unit, count)}`;
}

export interface PackShape {
  /** Pieces in one strip. 1 means the pack is sold whole. */
  unitsPerStrip: number;
  /** Strips in a box when pack size is 10x10. Null when unknown. */
  stripsPerBox: number | null;
}

/**
 * Read "10x10", "1x10", "5x2", "1×3" as strips × pieces.
 * "100ml" / "1 vial" are not strips, so this returns null.
 */
export function parsePackSize(packSize: string): { strips: number; pieces: number } | null {
  const normalised = packSize
    .trim()
    .toLowerCase()
    .replace(/[×*]/g, "x")
    .replace(/\s+/g, "");
  const pair = /^(\d+)x(\d+)$/.exec(normalised);
  if (pair) {
    const strips = Number(pair[1]);
    const pieces = Number(pair[2]);
    if (strips >= 1 && pieces >= 1) return { strips, pieces };
  }
  const single = /^(\d+)$/.exec(normalised);
  if (single) {
    const pieces = Number(single[1]);
    if (pieces >= 1) return { strips: 1, pieces };
  }
  return null;
}

/**
 * Tablets in one strip from a printed pack mark.
 *
 * 10x10 / 1x10 / 2x15 are strips × tablets. 5x2 is the blister on *one*
 * strip (10 tablets), which is how a counter reads that foil.
 */
export function piecesPerStrip(strips: number, pieces: number): number {
  if (strips === 1) return pieces;
  if (strips >= 10) return pieces;
  if (strips <= 6 && pieces <= 6) return strips * pieces;
  return pieces;
}

/**
 * How many pieces make one strip at the till.
 *
 * A saved `unitsPerStrip` always wins. Otherwise 10x10 and 1x10 both mean
 * 10 tablets in a strip; a syrup stays 1.
 */
export function resolveUnitsPerStrip(
  unit: string,
  packSize: string,
  override?: number | null,
): number {
  if (
    override != null &&
    Number.isInteger(override) &&
    override >= 1 &&
    override <= 1000
  ) {
    return override;
  }
  if (!canSellLoose(unit)) return 1;
  const parsed = parsePackSize(packSize);
  return parsed ? piecesPerStrip(parsed.strips, parsed.pieces) : 1;
}

export function packShape(
  unit: string,
  packSize: string,
  override?: number | null,
): PackShape {
  const parsed = parsePackSize(packSize);
  return {
    unitsPerStrip: resolveUnitsPerStrip(unit, packSize, override),
    stripsPerBox: parsed?.strips ?? null,
  };
}

/** "strip of 10 tablets" — shown next to the name so 1 is never mistaken for a box. */
export function stripLabel(unitsPerStrip: number, unit: string): string | null {
  if (unitsPerStrip <= 1) return null;
  return `strip of ${unitsPerStrip} ${unitWord(unit, unitsPerStrip)}`;
}

/**
 * Plain-language quantity. Always leads with the number the customer said
 * (4, 6, 14), then explains strips if that helps.
 *
 *   4, strip of 10 → "4 tablets (from a strip of 10)"
 *   10, strip of 10 → "1 strip (10 tablets)"
 *   14, strip of 10 → "14 tablets (1 strip + 4)"
 *   6, strip of 2  → "6 tablets (3 × 2)"
 */
export function describeQuantity(
  quantity: number,
  unitsPerStrip: number,
  unit: string,
): string {
  const pieces = formatUnitCount(quantity, unit);
  if (quantity <= 0 || unitsPerStrip <= 1) return pieces;

  const strips = Math.floor(quantity / unitsPerStrip);
  const loose = quantity % unitsPerStrip;

  if (strips === 0) {
    return `${pieces} (from a strip of ${unitsPerStrip})`;
  }
  if (loose === 0) {
    if (unitsPerStrip === 2 && strips > 1) {
      return `${pieces} (${strips} × 2)`;
    }
    const stripWord = strips === 1 ? "1 strip" : `${strips} strips`;
    return `${stripWord} (${pieces})`;
  }
  const stripWord = strips === 1 ? "1 strip" : `${strips} strips`;
  return `${pieces} (${stripWord} + ${loose})`;
}

/** Hint when a GRN quantity looks like strips typed as pieces. */
export function describePurchaseQuantity(
  quantity: number,
  unitsPerStrip: number,
  unit: string,
): string | null {
  if (quantity <= 0) return null;
  const pieces = formatUnitCount(quantity, unit);
  if (unitsPerStrip <= 1) return pieces;
  if (quantity < unitsPerStrip) {
    const asStrips = quantity * unitsPerStrip;
    return `${pieces}. If you received ${quantity} strip${quantity === 1 ? "" : "s"}, enter ${asStrips}.`;
  }
  return describeQuantity(quantity, unitsPerStrip, unit);
}

/** "~18 strips" next to remaining stock, never instead of the tablet count. */
export function describeStock(quantity: number, unitsPerStrip: number, unit: string): string {
  const pieces = formatUnitCount(quantity, unit);
  if (unitsPerStrip <= 1 || quantity <= 0) return pieces;
  const strips = Math.floor(quantity / unitsPerStrip);
  const loose = quantity % unitsPerStrip;
  if (strips <= 0) return pieces;
  if (loose === 0) {
    return `${pieces} · ${strips} strip${strips === 1 ? "" : "s"}`;
  }
  return `${pieces} · ${strips} strip${strips === 1 ? "" : "s"} + ${loose}`;
}
