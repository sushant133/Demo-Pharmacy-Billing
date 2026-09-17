import { describe, expect, it, vi } from "vitest";
import {
  allocateSequence,
  displayBillNo,
  formatBillNo,
  formatGrnNo,
  storedBillNo,
} from "@/models/Counter";

/**
 * Bill numbering.
 *
 * A wrong number here is not a cosmetic bug: it either collides with a bill
 * that already exists - which the unique {pharmacyId, billNo} index rejects,
 * stopping the till on a sale that was perfectly valid - or it silently skips
 * a number, which is the first thing an auditor asks about.
 *
 * The case that actually bit: a pharmacy whose counters predated per-pharmacy
 * keys. The new key did not exist, allocation restarted at 1, and every sale
 * collided with a bill from 138 bills ago.
 */

/** A counter that behaves like the Mongo document, with no Mongo. */
function fakeCounter(initial: number | null) {
  const state = { seq: initial };
  return {
    state,
    bump: vi.fn(async () => {
      if (state.seq === null) {
        state.seq = 1;
        return null; // upsert created it
      }
      const before = state.seq;
      state.seq = before + 1;
      return before;
    }),
    set: vi.fn(async (value: number) => {
      state.seq = value;
    }),
  };
}

describe("allocateSequence", () => {
  it("continues an existing sequence", async () => {
    const counter = fakeCounter(138);

    await expect(
      allocateSequence({ bump: counter.bump, set: counter.set }),
    ).resolves.toBe(139);
    expect(counter.state.seq).toBe(139);
    expect(counter.set).not.toHaveBeenCalled();
  });

  it("starts at 1 when nothing has ever been numbered", async () => {
    const counter = fakeCounter(null);
    const seed = vi.fn(async () => 0);

    await expect(
      allocateSequence({ bump: counter.bump, set: counter.set, seed }),
    ).resolves.toBe(1);
    expect(counter.state.seq).toBe(1);
    expect(counter.set).not.toHaveBeenCalled();
  });

  it("skips past records that already exist when the counter is missing", async () => {
    // The real failure: 138 bills on file, no counter under the current key.
    const counter = fakeCounter(null);
    const seed = vi.fn(async () => 138);

    await expect(
      allocateSequence({ bump: counter.bump, set: counter.set, seed }),
    ).resolves.toBe(139);
    // And it is lifted, so the next caller does not repeat the work.
    expect(counter.state.seq).toBe(139);
    expect(counter.set).toHaveBeenCalledWith(139);
  });

  it("never consults the records for a counter that already exists", async () => {
    const counter = fakeCounter(5);
    const seed = vi.fn(async () => 999);

    await expect(
      allocateSequence({ bump: counter.bump, set: counter.set, seed }),
    ).resolves.toBe(6);
    // A live counter is the authority; re-deriving it from documents every
    // time would be both slow and a way to reissue a number after a void.
    expect(seed).not.toHaveBeenCalled();
  });

  it("issues consecutive numbers once seeded", async () => {
    const counter = fakeCounter(null);
    const seed = vi.fn(async () => 138);

    const first = await allocateSequence({
      bump: counter.bump,
      set: counter.set,
      seed,
    });
    const second = await allocateSequence({ bump: counter.bump, set: counter.set, seed });
    const third = await allocateSequence({ bump: counter.bump, set: counter.set, seed });

    expect([first, second, third]).toEqual([139, 140, 141]);
    expect(seed).toHaveBeenCalledTimes(1);
  });

  it("starts at 1 without a seed, as a plain sequence", async () => {
    const counter = fakeCounter(null);

    await expect(
      allocateSequence({ bump: counter.bump, set: counter.set }),
    ).resolves.toBe(1);
  });
});

describe("bill number formatting", () => {
  it("pads to six digits under the fiscal year", () => {
    expect(formatBillNo(139, "2083-84")).toBe("INV-2083-84-000139");
    expect(formatGrnNo(15)).toBe("GRN-000015");
  });

  it("prints the fiscal year with a slash but stores it with a hyphen", () => {
    const stored = formatBillNo(139, "2083-84");
    expect(displayBillNo(stored)).toBe("INV-2083/84-000139");
    expect(storedBillNo(displayBillNo(stored))).toBe(stored);
  });
});
