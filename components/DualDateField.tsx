"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BS_MONTHS,
  adIsoToBsIso,
  bsIsoToAdIso,
  daysInBsMonth,
  formatYmd,
  parseYmd,
} from "@/lib/bs-date";
import { cx } from "@/components/ui";

/**
 * One calendar date, entered as English (AD) or Nepali (BS).
 *
 * The value the rest of the app stores is always AD YYYY-MM-DD. Typing either
 * side fills the other so a strip marked EXP 2027-03 and a bill dated
 * 2082-12-05 are the same field.
 */

const BS_YEARS = Array.from({ length: 40 }, (_, index) => 2060 + index);

function bsParts(adIso: string): { year: string; month: string; day: string } {
  const iso = adIso ? adIsoToBsIso(adIso) : null;
  const parsed = iso ? parseYmd(iso) : null;
  if (!parsed) return { year: "", month: "", day: "" };
  return {
    year: String(parsed.year),
    month: String(parsed.month),
    day: String(parsed.day),
  };
}

export function DualDateField({
  id,
  name,
  value,
  defaultValue,
  onChange,
  required,
  disabled,
  compact,
  split,
  table,
  error,
  "aria-label": ariaLabel,
}: {
  id: string;
  name?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (adIso: string) => void;
  required?: boolean;
  disabled?: boolean;
  compact?: boolean;
  /** AD and BS side by side. Default stacks them so filter rows do not overflow. */
  split?: boolean;
  /** One AD picker and one BS YYYY-MM-DD box, for dense GRN lines. */
  table?: boolean;
  error?: boolean;
  "aria-label"?: string;
}) {
  const controlled = value !== undefined;
  const [inner, setInner] = useState(value ?? defaultValue ?? "");
  const ad = controlled ? value : inner;
  const [bs, setBs] = useState(() => bsParts(ad));
  const [bsText, setBsText] = useState(() => adIsoToBsIso(ad) ?? "");

  useEffect(() => {
    setBs(bsParts(ad));
    setBsText(adIsoToBsIso(ad) ?? "");
  }, [ad]);

  const dayCount = useMemo(() => {
    const year = Number(bs.year);
    const month = Number(bs.month);
    if (!year || !month) return 32;
    return daysInBsMonth(year, month);
  }, [bs.year, bs.month]);

  function emit(nextAd: string) {
    if (!controlled) setInner(nextAd);
    onChange?.(nextAd);
  }

  function onAdInput(nextAd: string) {
    emit(nextAd);
    setBs(bsParts(nextAd));
    setBsText(adIsoToBsIso(nextAd) ?? "");
  }

  function onBsText(raw: string) {
    setBsText(raw);
    if (!raw.trim()) {
      emit("");
      setBs({ year: "", month: "", day: "" });
      return;
    }
    const converted = bsIsoToAdIso(raw);
    if (converted) {
      emit(converted);
      setBs(bsParts(converted));
    }
  }

  function onBsPart(part: "year" | "month" | "day", raw: string) {
    const next = { ...bs, [part]: raw };
    const year = Number(next.year);
    const month = Number(next.month);
    let day = Number(next.day);
    if (year && month && day) {
      const max = daysInBsMonth(year, month);
      if (day > max) {
        day = max;
        next.day = String(max);
      }
    }
    setBs(next);
    if (!year || !month || !day) {
      if (!next.year && !next.month && !next.day) emit("");
      return;
    }
    const converted = bsIsoToAdIso(formatYmd({ year, month, day }));
    if (converted) emit(converted);
  }

  const inputClass = cx(
    "input min-w-0",
    (compact || table) && "px-2 py-1.5 text-xs",
    error && "border-rose-400",
  );

  const bsSelectClass = cx(
    "input min-w-0",
    compact ? "px-1.5 py-1.5 text-xs" : "px-2",
  );

  if (table) {
    return (
      <div className="w-[12.5rem] space-y-1">
        <label className="flex items-center gap-1">
          <span className="w-6 shrink-0 text-[10px] font-medium text-slate-500">AD</span>
          <input
            id={id}
            name={name}
            type="date"
            min="1944-01-01"
            max="2043-12-31"
            value={ad}
            onChange={(event) => onAdInput(event.target.value)}
            required={required}
            disabled={disabled}
            aria-label={ariaLabel ? `${ariaLabel} (English)` : "English date"}
            className={inputClass}
          />
        </label>
        <label className="flex items-center gap-1">
          <span className="w-6 shrink-0 text-[10px] font-medium text-slate-500">BS</span>
          <input
            id={`${id}-bs`}
            type="text"
            inputMode="numeric"
            placeholder="2082-05-20"
            value={bsText}
            onChange={(event) => onBsText(event.target.value)}
            disabled={disabled}
            aria-label={ariaLabel ? `${ariaLabel} (Nepali)` : "Nepali date"}
            className={cx(inputClass, "tnum")}
          />
        </label>
      </div>
    );
  }

  return (
    <div
      className={cx(
        "min-w-0",
        split ? "grid gap-2 sm:grid-cols-2" : "space-y-1.5",
      )}
    >
      <div className="min-w-0">
        <p className={cx("text-slate-500", compact ? "mb-0.5 text-[10px] font-medium" : "label")}>
          English (AD)
        </p>
        <input
          id={id}
          name={name}
          type="date"
          min="1944-01-01"
          max="2043-12-31"
          value={ad}
          onChange={(event) => onAdInput(event.target.value)}
          required={required}
          disabled={disabled}
          aria-label={ariaLabel ? `${ariaLabel} (English)` : "English date"}
          className={inputClass}
        />
      </div>
      <div className="min-w-0">
        <p className={cx("text-slate-500", compact ? "mb-0.5 text-[10px] font-medium" : "label")}>
          Nepali (BS)
        </p>
        <div className="grid min-w-0 grid-cols-[4.75rem_minmax(0,1fr)_3.5rem] gap-1">
          <input
            id={`${id}-bs-year`}
            type="number"
            min={2000}
            max={2099}
            list={`${id}-bs-years`}
            placeholder="2082"
            value={bs.year}
            onChange={(event) => onBsPart("year", event.target.value)}
            disabled={disabled}
            aria-label={ariaLabel ? `${ariaLabel} (Nepali year)` : "Nepali year"}
            className={cx(bsSelectClass, "tnum")}
          />
          <datalist id={`${id}-bs-years`}>
            {BS_YEARS.map((year) => (
              <option key={year} value={year} />
            ))}
          </datalist>
          <select
            id={`${id}-bs-month`}
            value={bs.month}
            onChange={(event) => onBsPart("month", event.target.value)}
            disabled={disabled}
            aria-label={ariaLabel ? `${ariaLabel} (Nepali month)` : "Nepali month"}
            className={cx(bsSelectClass, "truncate")}
          >
            <option value="">Month</option>
            {BS_MONTHS.map((month, index) => (
              <option key={month} value={String(index + 1)}>
                {month}
              </option>
            ))}
          </select>
          <input
            id={`${id}-bs-day`}
            type="number"
            min={1}
            max={dayCount}
            placeholder="Dd"
            value={bs.day}
            onChange={(event) => onBsPart("day", event.target.value)}
            disabled={disabled}
            aria-label={ariaLabel ? `${ariaLabel} (Nepali day)` : "Nepali day"}
            className={cx(bsSelectClass, "tnum")}
          />
        </div>
      </div>
    </div>
  );
}
