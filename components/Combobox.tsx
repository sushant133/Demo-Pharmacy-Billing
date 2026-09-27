"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cx } from "@/components/ui";

/**
 * A text input with a filtered suggestion list.
 *
 * Two modes:
 *   - `select`: the value is one option's `value` (a supplier id, a medicine
 *     id). Typing only searches; leaving without picking puts the chosen
 *     label back. Nothing that is not on the list can be saved.
 *   - `free`: the value is the text itself (a category, a unit). The list is
 *     suggestions; anything typed is kept, and a new name is offered as
 *     "Add …" so it is clear it will be created.
 *
 * Keyboard: arrows move, Enter picks, Escape closes. Built on the ARIA
 * combobox pattern so screen readers announce the list and the active row.
 */

export interface ComboOption {
  value: string;
  label: string;
  /** Second line: manufacturer, pack, terms. Also searched. */
  detail?: string;
  /** Extra search text that is not shown (generic name, code). */
  keywords?: string;
}

const MAX_SHOWN = 60;

function rank(option: ComboOption, query: string): number {
  const label = option.label.toLowerCase();
  if (label === query) return 0;
  if (label.startsWith(query)) return 1;
  if (label.split(/\s+/).some((word) => word.startsWith(query))) return 2;
  if (label.includes(query)) return 3;
  const rest = `${option.detail ?? ""} ${option.keywords ?? ""}`.toLowerCase();
  return rest.includes(query) ? 4 : -1;
}

export function Combobox({
  id,
  mode,
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  invalid,
  className,
  inputClassName,
  emptyText = "No matches",
  addLabel = (text) => `Add “${text}”`,
}: {
  id?: string;
  mode: "select" | "free";
  value: string;
  onChange: (value: string) => void;
  options: ComboOption[];
  placeholder?: string;
  ariaLabel?: string;
  invalid?: boolean;
  className?: string;
  inputClassName?: string;
  emptyText?: string;
  addLabel?: (text: string) => string;
}) {
  const autoId = useId();
  const inputId = id ?? `combo-${autoId}`;
  const listId = `${inputId}-list`;

  const selected = mode === "select" ? options.find((option) => option.value === value) : undefined;
  const shownValue = mode === "select" ? selected?.label ?? "" : value;

  const [text, setText] = useState(shownValue);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Whether the text is being edited; until then the list shows everything.
  const [typing, setTyping] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Follow the value when it is changed from outside (a preset, a reset).
  useEffect(() => {
    if (!open) setText(shownValue);
  }, [shownValue, open]);

  const query = typing ? text.trim().toLowerCase() : "";
  const matches = useMemo(() => {
    if (!query) return options.slice(0, MAX_SHOWN);
    return options
      .map((option) => ({ option, score: rank(option, query) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => a.score - b.score || a.option.label.localeCompare(b.option.label))
      .slice(0, MAX_SHOWN)
      .map((entry) => entry.option);
  }, [options, query]);

  const trimmed = text.trim();
  const canAdd =
    mode === "free" &&
    trimmed !== "" &&
    !options.some((option) => option.label.toLowerCase() === trimmed.toLowerCase());

  // Rows as shown: matches first, so Enter takes the closest existing entry
  // ("cap" → capsule); "Add" last, for when none of them is meant.
  const rows: Array<{ kind: "add"; text: string } | { kind: "option"; option: ComboOption }> = [
    ...matches.map((option) => ({ kind: "option" as const, option })),
    ...(canAdd ? [{ kind: "add" as const, text: trimmed }] : []),
  ];

  function close(revert: boolean) {
    setOpen(false);
    setTyping(false);
    if (revert && mode === "select") setText(shownValue);
  }

  function pick(index: number) {
    const row = rows[index];
    if (!row) return;
    if (row.kind === "add") {
      onChange(row.text);
      setText(row.text);
    } else {
      onChange(row.option.value);
      setText(row.option.label);
    }
    setOpen(false);
    setTyping(false);
  }

  // Close when focus or a click lands anywhere else.
  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) close(true);
    }
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  });

  // Keep the active row in view while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const activeId = open && rows[active] ? `${inputId}-opt-${active}` : undefined;

  return (
    <div ref={wrapRef} className={cx("relative", className)}>
      <input
        id={inputId}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-invalid={invalid || undefined}
        autoComplete="off"
        value={text}
        placeholder={placeholder}
        onFocus={(event) => {
          setOpen(true);
          setActive(0);
          event.currentTarget.select();
        }}
        onClick={() => setOpen(true)}
        onChange={(event) => {
          setText(event.target.value);
          setTyping(true);
          setOpen(true);
          setActive(0);
          if (mode === "free") onChange(event.target.value);
        }}
        onBlur={(event) => {
          // Moving into the list is not leaving.
          if (wrapRef.current?.contains(event.relatedTarget as Node)) return;
          close(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            if (!open) setOpen(true);
            else setActive((current) => Math.min(current + 1, rows.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((current) => Math.max(current - 1, 0));
          } else if (event.key === "Enter") {
            if (open && rows.length > 0) {
              // Pick, and never submit the surrounding form mid-search.
              event.preventDefault();
              pick(active);
            }
          } else if (event.key === "Escape") {
            if (open) {
              event.preventDefault();
              event.stopPropagation();
              close(true);
            }
          } else if (event.key === "Tab") {
            close(true);
          }
        }}
        className={cx("input pr-8", invalid && "border-rose-400", inputClassName)}
      />
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="m8 10 4 4 4-4" />
      </svg>

      {open ? (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-full z-40 mt-1 max-h-64 min-w-full overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg"
        >
          {rows.length === 0 ? (
            <li className="px-3 py-2 text-slate-500">{emptyText}</li>
          ) : (
            rows.map((row, index) => (
              <li
                key={row.kind === "add" ? "__add" : row.option.value}
                id={`${inputId}-opt-${index}`}
                data-index={index}
                role="option"
                aria-selected={index === active}
                // Keep focus in the input so blur does not close the list first.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(index)}
                onMouseEnter={() => setActive(index)}
                className={cx(
                  "px-3 py-2",
                  index === active ? "bg-brand-50 text-brand-900" : "text-slate-700",
                )}
              >
                {row.kind === "add" ? (
                  <span className="font-medium text-brand-700">+ {addLabel(row.text)}</span>
                ) : (
                  <>
                    <span
                      className={cx(
                        "block break-words",
                        row.option.value === value && "font-semibold",
                      )}
                    >
                      {row.option.label}
                    </span>
                    {row.option.detail ? (
                      <span className="block break-words text-xs text-slate-500">
                        {row.option.detail}
                      </span>
                    ) : null}
                  </>
                )}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
