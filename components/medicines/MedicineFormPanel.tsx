"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { apiFetch } from "@/lib/client";
import { Field, SlideOver } from "@/components/SlideOver";
import { medicineSchema } from "@/lib/validation";
import { MEDICINE_UNITS, mergeMedicineCategories } from "@/lib/constants";
import { canSellLoose, resolveUnitsPerStrip, unitWord } from "@/lib/pack";

/**
 * Add / edit a catalogue entry.
 *
 * Validation runs against the same Zod schema the API enforces, so the form
 * rejects bad input before the round trip and the messages match exactly.
 */

export interface MedicineFormValues {
  id: string;
  name: string;
  genericName: string;
  saltComposition: string;
  manufacturer: string;
  category: string;
  unit: string;
  packSize: string;
  unitsPerStrip: number | null;
  requiresPrescription: boolean;
  reorderLevel: number | null;
  isActive: boolean;
}

export function MedicineFormPanel({
  medicine,
  canDelete,
  extraCategories = [],
}: {
  medicine: MedicineFormValues | null;
  canDelete: boolean;
  extraCategories?: string[];
}) {
  const router = useRouter();
  const isEdit = Boolean(medicine);
  const categories = mergeMedicineCategories(extraCategories);
  const knownCategory =
    medicine?.category && categories.includes(medicine.category)
      ? medicine.category
      : "Other";

  const [values, setValues] = useState({
    name: medicine?.name ?? "",
    genericName: medicine?.genericName ?? "",
    saltComposition: medicine?.saltComposition ?? "",
    manufacturer: medicine?.manufacturer ?? "",
    category: knownCategory,
    categoryCustom:
      knownCategory === "Other" &&
      medicine?.category &&
      medicine.category !== "Other"
        ? medicine.category
        : "",
    unit: medicine?.unit ?? "tablet",
    packSize: medicine?.packSize ?? "",
    unitsPerStrip:
      medicine?.unitsPerStrip != null
        ? String(medicine.unitsPerStrip)
        : medicine && resolveUnitsPerStrip(medicine.unit, medicine.packSize) > 1
          ? String(resolveUnitsPerStrip(medicine.unit, medicine.packSize))
          : "",
    requiresPrescription: medicine?.requiresPrescription ?? false,
    reorderLevel: medicine?.reorderLevel?.toString() ?? "",
    isActive: medicine?.isActive ?? true,
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inflight = useRef(false);

  const close = useCallback(() => {
    router.push("/medicines");
    router.refresh();
  }, [router]);

  function set<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function setPackSize(packSize: string) {
    setValues((current) => {
      const guessed = resolveUnitsPerStrip(current.unit, packSize, null);
      const stripEmpty = current.unitsPerStrip.trim() === "";
      return {
        ...current,
        packSize,
        unitsPerStrip:
          stripEmpty && guessed > 1 ? String(guessed) : current.unitsPerStrip,
      };
    });
  }

  async function save() {
    if (inflight.current) return;
    setFormError(null);

    const category =
      values.category === "Other" && values.categoryCustom.trim()
        ? values.categoryCustom.trim()
        : values.category;
    const parsed = medicineSchema.safeParse({ ...values, category });
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "_form");
        fieldErrors[key] ??= issue.message;
      }
      setErrors(fieldErrors);
      return;
    }

    setErrors({});
    inflight.current = true;
    setSaving(true);

    const result = await apiFetch(
      isEdit ? `/api/medicines/${medicine!.id}` : "/api/medicines",
      { method: isEdit ? "PATCH" : "POST", json: parsed.data },
    );

    if (!result.ok) {
      inflight.current = false;
      setFormError(result.message);
      setSaving(false);
      return;
    }

    close();
  }

  async function remove() {
    if (!medicine || inflight.current) return;
    inflight.current = true;
    setSaving(true);
    setFormError(null);

    const result = await apiFetch<{ message?: string }>(
      `/api/medicines/${medicine.id}`,
      { method: "DELETE" },
    );

    if (!result.ok) {
      inflight.current = false;
      setFormError(result.message);
      setSaving(false);
      return;
    }

    close();
  }

  return (
    <SlideOver
      title={isEdit ? "Edit medicine" : "Add medicine"}
      description={
        isEdit
          ? "Changes apply to future bills only; past bills keep the details they were printed with."
          : "Add the product to the catalogue, then receive stock against it as a batch."
      }
      onClose={close}
      footer={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="btn-primary flex-1"
          >
            {saving ? "Saving…" : isEdit ? "Save changes" : "Add medicine"}
          </button>
          <button type="button" onClick={close} className="btn-secondary">
            Cancel
          </button>
        </div>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        className="space-y-4"
      >
        {formError ? (
          <div
            role="alert"
            className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
          >
            {formError}
          </div>
        ) : null}

        <Field label="Brand name" htmlFor="name" error={errors.name}>
          <input
            id="name"
            value={values.name}
            onChange={(event) => set("name", event.target.value)}
            placeholder="e.g. Cetzine 10mg"
            className="input"
            required
          />
        </Field>

        <Field label="Generic name" htmlFor="genericName" error={errors.genericName}>
          <input
            id="genericName"
            value={values.genericName}
            onChange={(event) => set("genericName", event.target.value)}
            placeholder="e.g. Cetirizine"
            className="input"
          />
        </Field>

        <Field
          label="Salt composition"
          htmlFor="saltComposition"
          error={errors.saltComposition}
          hint="Shown in POS search, so staff can find a brand by its salt."
        >
          <input
            id="saltComposition"
            value={values.saltComposition}
            onChange={(event) => set("saltComposition", event.target.value)}
            placeholder="e.g. Cetirizine Hydrochloride 10mg"
            className="input"
          />
        </Field>

        <Field label="Manufacturer" htmlFor="manufacturer" error={errors.manufacturer}>
          <input
            id="manufacturer"
            value={values.manufacturer}
            onChange={(event) => set("manufacturer", event.target.value)}
            placeholder="e.g. Deurali-Janta"
            className="input"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Category" htmlFor="category" error={errors.category}>
            <select
              id="category"
              value={values.category}
              onChange={(event) => set("category", event.target.value)}
              className="input"
            >
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Unit" htmlFor="unit" error={errors.unit}>
            <select
              id="unit"
              value={values.unit}
              onChange={(event) => {
                const unit = event.target.value;
                setValues((current) => ({
                  ...current,
                  unit,
                  unitsPerStrip: canSellLoose(unit) ? current.unitsPerStrip : "",
                }));
              }}
              className="input capitalize"
            >
              {MEDICINE_UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {values.category === "Other" ? (
          <Field
            label="Category name"
            htmlFor="categoryCustom"
            error={errors.category}
            hint="Optional. Leave blank to keep Other, or type a name such as Ayurvedic."
          >
            <input
              id="categoryCustom"
              value={values.categoryCustom}
              onChange={(event) => set("categoryCustom", event.target.value)}
              placeholder="e.g. Ayurvedic"
              className="input"
            />
          </Field>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Pack size"
            htmlFor="packSize"
            error={errors.packSize}
            hint="What the box says, e.g. 10x10, 1x10, 5x2, 100ml."
          >
            <input
              id="packSize"
              value={values.packSize}
              onChange={(event) => setPackSize(event.target.value)}
              placeholder="1x10"
              className="input"
            />
          </Field>

          <Field
            label="Reorder level"
            htmlFor="reorderLevel"
            error={errors.reorderLevel}
            hint="Blank uses the shop default."
          >
            <input
              id="reorderLevel"
              type="number"
              min={0}
              value={values.reorderLevel}
              onChange={(event) => set("reorderLevel", event.target.value)}
              className="input tnum"
            />
          </Field>
        </div>

        {canSellLoose(values.unit) ? (
          <Field
            label={`${unitWord(values.unit, 2)} in one strip`}
            htmlFor="unitsPerStrip"
            error={errors.unitsPerStrip}
            hint="Pantop strip of 10 → 10. A 5×2 strip is also 10. Staff then type 4 to sell four, or 6 to take six back."
          >
            <input
              id="unitsPerStrip"
              type="number"
              min={1}
              max={1000}
              value={values.unitsPerStrip}
              onChange={(event) => set("unitsPerStrip", event.target.value)}
              placeholder="10"
              className="input tnum"
            />
          </Field>
        ) : null}

        <label className="flex items-center gap-2.5 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={values.requiresPrescription}
            onChange={(event) => set("requiresPrescription", event.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          />
          Prescription required (shows an Rx warning at the counter)
        </label>

        {isEdit ? (
          <label className="flex items-center gap-2.5 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={values.isActive}
              onChange={(event) => set("isActive", event.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            />
            Active (inactive medicines cannot be billed)
          </label>
        ) : null}

        {isEdit && canDelete ? (
          <div className="border-t border-slate-100 pt-4">
            <button
              type="button"
              onClick={remove}
              disabled={saving}
              className="text-xs font-medium text-rose-600 hover:text-rose-700 hover:underline"
            >
              Delete this medicine
            </button>
            <p className="mt-1 text-xs text-slate-500">
              If it has batch history it is marked inactive instead, so past bills
              stay intact.
            </p>
          </div>
        ) : null}

        {/* Enables Enter-to-submit without a visible duplicate button. */}
        <button type="submit" className="sr-only">
          Save
        </button>
      </form>
    </SlideOver>
  );
}
