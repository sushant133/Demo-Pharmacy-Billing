import { describe, expect, it } from "vitest";
import {
  PRESCRIPTION_STATUSES,
  PRESCRIPTION_STATUS_LABELS,
  isExpiredOn,
  isPrescriptionStatus,
  outstandingUnits,
  prescriptionStatus,
  prescriptionStatusFilter,
  remainingOnLine,
  type PrescriptionRecord,
} from "@/lib/prescription-status";

const NOW = new Date("2026-06-15T10:00:00.000Z");
const day = (offset: number) => new Date(NOW.getTime() + offset * 86_400_000);

function script(overrides: Partial<PrescriptionRecord> = {}): PrescriptionRecord {
  return {
    items: [{ quantityPrescribed: 30, quantityDispensed: 0 }],
    validUntil: day(30),
    cancelledAt: null,
    ...overrides,
  };
}

describe("remainingOnLine", () => {
  it("is what is still owed on a line", () => {
    expect(remainingOnLine({ quantityPrescribed: 30, quantityDispensed: 12 })).toBe(18);
  });

  it("never goes negative when more was handed over than prescribed", () => {
    expect(remainingOnLine({ quantityPrescribed: 10, quantityDispensed: 14 })).toBe(0);
  });
});

describe("outstandingUnits", () => {
  it("sums what is left across every line", () => {
    const record = script({
      items: [
        { quantityPrescribed: 30, quantityDispensed: 30 },
        { quantityPrescribed: 10, quantityDispensed: 4 },
        { quantityPrescribed: 5, quantityDispensed: 0 },
      ],
    });
    expect(outstandingUnits(record)).toBe(11);
  });
});

describe("isExpiredOn", () => {
  /*
    A script valid until the 15th is valid all day on the 15th - that is how a
    patient and a pharmacist both read it. Comparing raw timestamps would
    refuse it from midnight and turn a valid script into an argument.

    The instants below are chosen to be unambiguous in Asia/Kathmandu (UTC+5:45),
    which is the timezone the shop - and therefore this rule - reckons days in.
    Midday UTC is the same calendar day there; that is the point of the test.
  */
  const lastDay = new Date("2026-06-15T00:00:00.000Z");

  it("keeps a script valid through the whole of its last day", () => {
    expect(isExpiredOn(lastDay, new Date("2026-06-15T12:00:00.000Z"))).toBe(false);
  });

  it("expires it the next day", () => {
    expect(isExpiredOn(lastDay, new Date("2026-06-16T12:00:00.000Z"))).toBe(true);
  });

  /*
    The bug this replaced: `setHours(23,59,59,999)` moved the boundary into the
    machine's timezone, so whether a script was still good depended on where
    the server happened to sit. Pinned by running the same instant through and
    expecting the shop's answer, not the host's.
  */
  it("reckons the day in the shop's timezone, not the server's", () => {
    // 20:00 UTC on the 15th is already 01:45 on the 16th in Kathmandu, so a
    // script good until the 15th has lapsed - whatever the host clock says.
    expect(isExpiredOn(lastDay, new Date("2026-06-15T20:00:00.000Z"))).toBe(true);
    // 19:00 UTC on the 14th is 00:45 on the 15th there: its last day, just begun.
    expect(isExpiredOn(lastDay, new Date("2026-06-14T19:00:00.000Z"))).toBe(false);
  });

  it("treats a script with no expiry as never expiring", () => {
    expect(isExpiredOn(null, NOW)).toBe(false);
    expect(isExpiredOn(undefined, NOW)).toBe(false);
  });

  it("does not throw on a date it cannot read", () => {
    expect(isExpiredOn("not a date", NOW)).toBe(false);
  });
});

describe("prescriptionStatus precedence", () => {
  it("calls a cancelled script cancelled, whatever else is true of it", () => {
    const record = script({
      cancelledAt: day(-1),
      validUntil: day(-10),
      items: [{ quantityPrescribed: 30, quantityDispensed: 5 }],
    });
    const view = prescriptionStatus(record, NOW);
    expect(view.status).toBe("cancelled");
    expect(view.dispensable).toBe(false);
    expect(view.outstanding).toBe(0);
  });

  /*
    A script that ran to completion before it lapsed is finished, not expired.
    The date stopped mattering the moment the last unit went over the counter.
  */
  it("prefers fully dispensed over expired", () => {
    const record = script({
      validUntil: day(-5),
      items: [{ quantityPrescribed: 30, quantityDispensed: 30 }],
    });
    expect(prescriptionStatus(record, NOW).status).toBe("dispensed");
  });

  it("calls a lapsed script with units left expired, and refuses it", () => {
    const record = script({
      validUntil: day(-1),
      items: [{ quantityPrescribed: 30, quantityDispensed: 10 }],
    });
    const view = prescriptionStatus(record, NOW);
    expect(view.status).toBe("expired");
    expect(view.dispensable).toBe(false);
    expect(view.outstanding).toBe(20);
  });

  it("calls a part-filled script in date part dispensed, and allows more", () => {
    const record = script({
      items: [{ quantityPrescribed: 30, quantityDispensed: 10 }],
    });
    const view = prescriptionStatus(record, NOW);
    expect(view.status).toBe("partial");
    expect(view.dispensable).toBe(true);
    expect(view.outstanding).toBe(20);
  });

  it("calls an untouched script in date active", () => {
    const view = prescriptionStatus(script(), NOW);
    expect(view.status).toBe("active");
    expect(view.dispensable).toBe(true);
    expect(view.outstanding).toBe(30);
  });

  it("treats a script with no expiry as good indefinitely", () => {
    const record = script({ validUntil: null });
    expect(prescriptionStatus(record, NOW).status).toBe("active");
  });

  /*
    The one thing this rule must never do is say a script may be dispensed
    against when it may not. Everything cancelled or lapsed is refused, and
    nothing with units left and time on it is.
  */
  it("only ever allows dispensing on a live, in-date, unfinished script", () => {
    const cases: PrescriptionRecord[] = [
      script(),
      script({ items: [{ quantityPrescribed: 30, quantityDispensed: 29 }] }),
      script({ items: [{ quantityPrescribed: 30, quantityDispensed: 30 }] }),
      script({ validUntil: day(-1) }),
      script({ cancelledAt: day(-1) }),
      script({ validUntil: null }),
    ];

    for (const record of cases) {
      const view = prescriptionStatus(record, NOW);
      const live = !record.cancelledAt && !isExpiredOn(record.validUntil, NOW);
      const unfinished = outstandingUnits(record) > 0;
      expect(view.dispensable).toBe(live && unfinished);
    }
  });
});

describe("prescriptionStatusFilter", () => {
  it("covers every status the dropdown offers", () => {
    for (const status of PRESCRIPTION_STATUSES) {
      const filter = prescriptionStatusFilter(status, NOW);
      expect(filter).toBeTruthy();
      expect(PRESCRIPTION_STATUS_LABELS[status]).toBeTruthy();
    }
  });

  it("looks for the cancellation marker, not the outstanding count", () => {
    expect(prescriptionStatusFilter("cancelled", NOW)).toEqual({
      cancelledAt: { $ne: null },
    });
  });

  it("excludes cancelled scripts from every live status", () => {
    for (const status of ["active", "partial", "dispensed", "expired"] as const) {
      expect(prescriptionStatusFilter(status, NOW)).toMatchObject({
        cancelledAt: null,
      });
    }
  });

  it("separates active from partial by whether anything has gone out", () => {
    expect(prescriptionStatusFilter("active", NOW)).toMatchObject({
      dispensedUnits: 0,
    });
    expect(prescriptionStatusFilter("partial", NOW)).toMatchObject({
      dispensedUnits: { $gt: 0 },
    });
  });
});

describe("isPrescriptionStatus", () => {
  it("accepts the statuses the dropdown offers and nothing else", () => {
    expect(isPrescriptionStatus("partial")).toBe(true);
    expect(isPrescriptionStatus("nonsense")).toBe(false);
    expect(isPrescriptionStatus(undefined)).toBe(false);
  });
});
