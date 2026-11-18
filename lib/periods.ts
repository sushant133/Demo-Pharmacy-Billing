import { BS_MONTHS, adIsoToBsIso, bsIsoToAdIso, daysInBsMonth, formatYmd, parseYmd } from "@/lib/bs-date";
import { toDateInputValue } from "@/lib/dates";

/**
 * Report periods in the calendar the shop actually keeps: Nepali months and
 * the Nepali fiscal year (1 Shrawan to the end of Asar). Every value is an AD
 * YYYY-MM-DD pair, because that is what the date filters store and query.
 */
export interface Period {
  key: string;
  label: string;
  from: string;
  to: string;
}

const SHRAWAN = 4;

function bsToAd(year: number, month: number, day: number): string {
  return bsIsoToAdIso(formatYmd({ year, month, day })) ?? "";
}

export function nepaliPeriods(todayIso: string = toDateInputValue()): {
  thisMonth: Period;
  lastMonth: Period;
  fiscalYear: Period;
  lastFiscalYear: Period;
} | null {
  const today = parseYmd(adIsoToBsIso(todayIso) ?? "");
  if (!today) return null;
  const { year, month } = today;

  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;

  const fyStart = month >= SHRAWAN ? year : year - 1;
  const fyLabel = (start: number) => `FY ${start}-${String((start + 1) % 100).padStart(2, "0")}`;
  // The day before 1 Shrawan of the following year, i.e. the last day of Asar.
  const fyEnd = (start: number) => bsToAd(start + 1, SHRAWAN - 1, daysInBsMonth(start + 1, SHRAWAN - 1));

  return {
    thisMonth: {
      key: "bs-month",
      label: `${BS_MONTHS[month - 1]} ${year}`,
      from: bsToAd(year, month, 1),
      to: todayIso,
    },
    lastMonth: {
      key: "bs-last-month",
      label: `${BS_MONTHS[prevMonth - 1]} ${prevYear}`,
      from: bsToAd(prevYear, prevMonth, 1),
      to: bsToAd(prevYear, prevMonth, daysInBsMonth(prevYear, prevMonth)),
    },
    fiscalYear: {
      key: "fy",
      label: fyLabel(fyStart),
      from: bsToAd(fyStart, SHRAWAN, 1),
      to: todayIso,
    },
    lastFiscalYear: {
      key: "last-fy",
      label: fyLabel(fyStart - 1),
      from: bsToAd(fyStart - 1, SHRAWAN, 1),
      to: fyEnd(fyStart - 1),
    },
  };
}

/** The four periods as a list, for a row of quick links. */
export function nepaliPeriodList(todayIso?: string): Period[] {
  const periods = nepaliPeriods(todayIso);
  if (!periods) return [];
  return [periods.thisMonth, periods.lastMonth, periods.fiscalYear, periods.lastFiscalYear];
}
