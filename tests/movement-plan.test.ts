import { describe, expect, it } from "vitest";
import { planAdjustment, planRemoval } from "@/lib/movement-plan";
import {
  ADJUSTMENT_REASONS,
  MOVEMENT_DIRECTION,
  MOVEMENT_KINDS,
  MOVEMENT_KIND_LABELS,
  MOVEMENT_REASONS,
  MOVEMENT_REASON_LABELS,
  WRITE_OFF_REASONS,
  isMovementReason,
} from "@/lib/movement-kinds";

describe("planAdjustment", () => {
  it("adds units when the shelf holds more than the system thought", () => {
    const plan = planAdjustment(40, 46);
    expect(plan).toMatchObject({
      ok: true,
      direction: "in",
      quantity: 6,
      balanceAfter: 46,
    });
  });

  it("removes units when the shelf holds fewer", () => {
    const plan = planAdjustment(40, 33);
    expect(plan).toMatchObject({
      ok: true,
      direction: "out",
      quantity: 7,
      balanceAfter: 33,
    });
  });

  /*
    The sign is the whole point of this function. A stock-take that found two
    extra boxes must not be written as one that destroyed two, and nothing
    downstream would notice - the count would simply be wrong from then on.
  */
  it("never reports a magnitude with the wrong sign", () => {
    for (const onHand of [0, 1, 7, 250]) {
      for (const counted of [0, 1, 7, 250]) {
        const plan = planAdjustment(onHand, counted);
        if (!plan.ok) continue;
        expect(plan.quantity).toBeGreaterThan(0);
        expect(plan.balanceAfter).toBe(counted);
        expect(plan.direction).toBe(counted > onHand ? "in" : "out");
      }
    }
  });

  it("refuses a count that matches, rather than writing a zero-unit movement", () => {
    const plan = planAdjustment(40, 40);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toBe("no-change");
  });

  it("counts a lot down to zero, which is a real correction", () => {
    expect(planAdjustment(12, 0)).toMatchObject({
      ok: true,
      direction: "out",
      quantity: 12,
      balanceAfter: 0,
    });
  });

  it("refuses a negative or fractional count", () => {
    for (const counted of [-1, 2.5, Number.NaN]) {
      const plan = planAdjustment(10, counted);
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.reason).toBe("negative");
    }
  });
});

describe("planRemoval", () => {
  it("takes units off and says what is left", () => {
    expect(planRemoval(50, 12)).toMatchObject({
      ok: true,
      direction: "out",
      quantity: 12,
      balanceAfter: 38,
    });
  });

  it("allows clearing the lot exactly", () => {
    expect(planRemoval(12, 12)).toMatchObject({ ok: true, balanceAfter: 0 });
  });

  it("never lets a lot go negative", () => {
    const plan = planRemoval(12, 13);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toBe("insufficient");
  });

  it("says something useful about an empty lot", () => {
    const plan = planRemoval(0, 1);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.message).toContain("nothing left");
  });

  it("refuses zero, negative and fractional quantities", () => {
    for (const quantity of [0, -3, 1.5]) {
      const plan = planRemoval(50, quantity);
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.reason).toBe("negative");
    }
  });
});

describe("movement vocabulary", () => {
  it("gives every kind a direction and a label", () => {
    for (const kind of MOVEMENT_KINDS) {
      expect(MOVEMENT_DIRECTION[kind]).toMatch(/^(in|out)$/);
      expect(MOVEMENT_KIND_LABELS[kind]).toBeTruthy();
    }
  });

  it("gives every reason a label", () => {
    for (const reason of MOVEMENT_REASONS) {
      expect(MOVEMENT_REASON_LABELS[reason]).toBeTruthy();
    }
  });

  it("offers only real reasons on the two forms", () => {
    for (const reason of [...ADJUSTMENT_REASONS, ...WRITE_OFF_REASONS]) {
      expect(isMovementReason(reason)).toBe(true);
    }
  });

  /*
    The two lists are deliberately disjoint apart from "other": an adjustment
    says the count was wrong, a write-off says the count was right and the
    stock is gone. Offering "expired" as a way to correct a count would blur
    the one distinction the two screens exist to keep.
  */
  it("keeps the adjustment and write-off reasons apart", () => {
    const shared = ADJUSTMENT_REASONS.filter((reason) =>
      (WRITE_OFF_REASONS as readonly string[]).includes(reason),
    );
    expect(shared).toEqual(["other"]);
  });

  it("rejects anything that is not a reason", () => {
    expect(isMovementReason("stolen-by-aliens")).toBe(false);
    expect(isMovementReason(undefined)).toBe(false);
  });
});
