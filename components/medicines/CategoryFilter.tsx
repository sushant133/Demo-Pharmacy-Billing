"use client";

import { useState } from "react";
import { Combobox } from "@/components/Combobox";

/**
 * The catalogue's category filter, searchable.
 *
 * Lives inside the list page's plain GET form, so the choice travels as a
 * hidden `category` field and the Filter button submits it exactly as the
 * old <select> did. Blank means all categories.
 */
export function CategoryFilter({
  categories,
  defaultValue,
}: {
  categories: string[];
  defaultValue: string;
}) {
  const [value, setValue] = useState(defaultValue);
  const options = [
    { value: "", label: "All categories" },
    ...categories.map((category) => ({ value: category, label: category })),
  ];

  return (
    <>
      <Combobox
        id="category"
        mode="select"
        value={value}
        onChange={setValue}
        options={options}
        placeholder="Search categories…"
        emptyText="No category matches"
      />
      <input type="hidden" name="category" value={value} />
    </>
  );
}
