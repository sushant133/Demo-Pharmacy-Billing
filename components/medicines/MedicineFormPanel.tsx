"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { apiFetch } from "@/lib/client";
import { Field, SlideOver } from "@/components/SlideOver";
import { medicineSchema } from "@/lib/validation";
import { MEDICINE_UNITS, mergeMedicineCategories } from "@/lib/constants";
import { canSellLoose, resolveUnitsPerStrip, unitWord } from "@/lib/pack";

/**
 * Add / edit a catalogue entry.
 *
 * Validation runs against the same Zod schema the API enforces, so the form
 * rejects bad input before the round trip and the messages match exactly. What
 * the schema cannot know - that a code is already taken by another line - only
 * the database can answer, so those come back from the API and are put on the
 * field they belong to rather than shown as a wall of text at the top.
 */

export interface MedicineFormValues {
  id: string;
  /** The shop's own code for this line. Blank when it does not use codes. */
  sku: string;
  name: string;
  genericName: string;
  saltComposition: string;
  manufacturer: string;
  category: string;
  unit: string;
  packSize: string;
  barcode: string;
  unitsPerStrip: number | null;
  /** Indicative prices used to pre-fill a delivery; never what the till charges. */
  defaultCostPrice: number | null;
  defaultSalePrice: number | null;
  requiresPrescription: boolean;
  reorderLevel: number | null;
  isActive: boolean;
}

/** What the API says happened to a medicine that was asked to be deleted. */
interface DeleteResult {
  deleted: boolean;
  deactivated: boolean;
  message?: string;
}

export function MedicineFormPanel({
  medicine,
  canDelete,
  extraCategories = [],
  returnHref = "/medicines",
}: {
  medicine: MedicineFormValues | null;
  canDelete: boolean;
  extraCategories?: string[];
  /**
   * The list as it was when the panel was opened, filters and page included.
   *
   * Closing used to push a bare "/medicines", so saving an edit from page 3 of
   * a filtered list threw the user back to an unfiltered page 1 and left them
   * to find their place again. The caller knows the URL; it passes it in.
   */
  returnHref?: string;
}) {
  const router = useRouter();
  const isEdit = Boolean(medicine);
  const categories = mergeMedicineCategories(extraCategories);
  const knownCategory =
    medicine?.category && categories.includes(medicine.category)
      ? medicine.category
      : "Other";

  const [values, setValues] = useState({
    sku: medicine?.sku ?? "",
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
    barcode: medicine?.barcode ?? "",
    unitsPerStrip:
      medicine?.unitsPerStrip != null
        ? String(medicine.unitsPerStrip)
        : medicine && resolveUnitsPerStrip(medicine.unit, medicine.packSize) > 1
          ? String(resolveUnitsPerStrip(medicine.unit, medicine.packSize))
          : "",
    defaultCostPrice: medicine?.defaultCostPrice?.toString() ?? "",
    defaultSalePrice: medicine?.defaultSalePrice?.toString() ?? "",
    requiresPrescription: medicine?.requiresPrescription ?? false,
    reorderLevel: medicine?.reorderLevel?.toString() ?? "",
    isActive: medicine?.isActive ?? true,
  });

  /*
    A note, never a block. Selling at or below cost is a real decision -
    clearing a short-dated lot, matching a competitor - so this says what the
    figures imply and gets out of the way.
  */
  const cost = Number(values.defaultCostPrice);
  const mrp = Number(values.defaultSalePrice);
  const marginWarning =
    values.defaultCostPrice.trim() !== "" &&
    values.defaultSalePrice.trim() !== "" &&
    Number.isFinite(cost) &&
    Number.isFinite(mrp) &&
    mrp < cost
      ? "The MRP is below the purchase price, so this line would sell at a loss."
      : null;

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** null = not asked, "asking" = confirming, else the outcome to report. */
  const [deleteState, setDeleteState] = useState<
    null | "asking" | { done: DeleteResult }
  >(null);
  const inflight = useRef(false);

  const close = useCallback(() => {
    router.push(returnHref);
    router.refresh();
  }, [router, returnHref]);

  function set<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    // A message that stays put while the field it complains about is being
    // corrected reads as though the correction did not register.
    setErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key as string];
      return next;
    });
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
      setSaving(false);
      // A duplicate code or barcode is a problem with one box, and saying so
      // at the top of the panel leaves the user hunting for which.
      const placed = placeServerErrors(result, setErrors);
      setFormError(placed ? null : result.message);
      return;
    }

    close();
  }

  async function remove() {
    if (!medicine || inflight.current) return;
    inflight.current = true;
    setSaving(true);
    setFormError(null);

    const result = await apiFetch<DeleteResult>(`/api/medicines/${medicine.id}`, {
      method: "DELETE",
    });

    inflight.current = false;
    setSaving(false);

    if (!result.ok) {
      setDeleteState(null);
      setFormError(result.message);
      return;
    }

    /*
      A medicine with batch history is deactivated rather than deleted, so past
      bills still reprint. The API says so in its response, and this panel used
      to discard it and close - the user pressed Delete, saw the row still
      there marked Inactive, and was told nothing. The outcome is now reported
      before the panel closes.
    */
    setDeleteState({ done: result.data });
  }

  const deleted = typeof deleteState === "object" && deleteState !== null;

  return (
    <SlideOver
      title={
        deleted
          ? deleteState.done.deleted
            ? "Medicine deleted"
            : "Medicine deactivated"
          : isEdit
            ? "Edit medicine"
            : "Add medicine"
      }
      description={
        deleted
          ? undefined
          : isEdit
            ? "Changes apply to future bills only; past bills keep the details they were printed with."
            : "Add the product to the catalogue, then receive stock against it as a batch."
      }
      onClose={close}
      footer={
        deleted ? (
          <button type="button" onClick={close} className="btn-primary w-full">
            Back to medicines
          </button>
        ) : (
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
        )
      }
    >
      {deleted ? (
        <div
          role="status"
          className={
            deleteState.done.deleted
              ? "rounded-lg border border-slate-200 bg-slate-50 px-4 py-3"
              : "rounded-lg border border-amber-200 bg-amber-50 px-4 py-3"
          }
        >
          <p
            className={
              deleteState.done.deleted
                ? "text-sm text-slate-700"
                : "text-sm text-amber-900"
            }
          >
            {deleteState.done.message ??
              (deleteState.done.deleted
                ? "The medicine was removed from the catalogue."
                : "The medicine was marked inactive.")}
          </p>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          className="space-y-5"
        >
          {formError ? (
            <div
              role="alert"
              className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
            >
              {formError}
            </div>
          ) : null}

          {/*
            Three groups, because twelve fields in one flat column is a form
            people scroll past rather than read: what the product is, how it
            comes packed, and how the shop handles it.
          */}
          <Section title="Identity">
            {/*
              The shop's own code, first because it is how the product is
              referred to everywhere outside this screen - the shelf label, the
              stock-take sheet, the accountant's ledger.

              Upper-cased as it is typed rather than silently on save, so the
              box shows exactly what will be stored. Optional: plenty of
              counters work by name alone, and a required code would just get
              filled with rubbish.
            */}
            <Field
              label="Medicine code / SKU"
              htmlFor="sku"
              error={errors.sku}
              hint="Your own reference, e.g. AMX-500. Optional, but must be unique."
            >
              <input
                id="sku"
                value={values.sku}
                onChange={(event) =>
                  set("sku", event.target.value.trim().toUpperCase())
                }
                autoComplete="off"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                maxLength={40}
                placeholder="AMX-500"
                className="input font-mono tracking-wide"
              />
            </Field>

            {/*
              The name the counter knows the product by, which on a Nepali
              pharmacy shelf is the brand as printed on the pack. It is the one
              field the till searches first and the one that prints on a bill,
              so it is called what it is rather than "Brand name" - the generic
              and the salt have their own boxes below.
            */}
            <Field
              label="Medicine name"
              htmlFor="name"
              error={errors.name}
              required
              hint="As written on the pack - this is what prints on the bill."
            >
              <input
                id="name"
                value={values.name}
                onChange={(event) => set("name", event.target.value)}
                placeholder="e.g. Cetzine 10mg"
                className="input"
                required
              />
            </Field>

            <Field
              label="Generic name"
              htmlFor="genericName"
              error={errors.genericName}
            >
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

            <Field
              label="Manufacturer"
              htmlFor="manufacturer"
              error={errors.manufacturer}
              hint="Two medicines may share a name only if their makers differ."
            >
              <input
                id="manufacturer"
                value={values.manufacturer}
                onChange={(event) => set("manufacturer", event.target.value)}
                placeholder="e.g. Deurali-Janta"
                className="input"
              />
            </Field>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
                      unitsPerStrip: canSellLoose(unit)
                        ? current.unitsPerStrip
                        : "",
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
          </Section>

          <Section title="Pack">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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

              {/*
                What the till scans - the manufacturer's code, not the shop's.
                The quickest way to fill it is to click into the box and scan
                the pack: the scanner types the code itself.
              */}
              <Field
                label="Barcode"
                htmlFor="barcode"
                error={errors.barcode}
                hint="Scan the pack into this box, or leave it blank."
              >
                <input
                  id="barcode"
                  value={values.barcode}
                  onChange={(event) => set("barcode", event.target.value.trim())}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  placeholder="Scan or type"
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
          </Section>

          {/*
            Indicative prices, not the till's prices.
            -----------------------------------------
            What a customer is charged comes off the lot FEFO picked, and what
            a unit cost comes off the delivery it arrived on - both live on
            Batch, and two lots of the same drug routinely differ. A single
            figure here could never be either of those without quietly
            contradicting the register.

            What it is good for is the blank GRN form. A medicine filed before
            it has ever been delivered has no previous lot to copy from, so the
            storekeeper types the MRP off the box every time. The hint says
            exactly this, because a price field in a pharmacy that does not say
            what it governs will be read as the selling price.
          */}
          <Section title="Default prices">
            <p className="-mt-1 text-xs text-slate-500">
              Used to pre-fill the next delivery for this medicine. The till
              always charges the price on the lot it dispenses, which is set
              when stock is received.
            </p>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Purchase price (cost)"
                htmlFor="defaultCostPrice"
                error={errors.defaultCostPrice}
                hint="What you expect to pay per unit."
              >
                <input
                  id="defaultCostPrice"
                  type="number"
                  min={0}
                  step="0.01"
                  value={values.defaultCostPrice}
                  onChange={(event) => set("defaultCostPrice", event.target.value)}
                  placeholder="Not set"
                  className="input tnum"
                />
              </Field>

              <Field
                label="MRP"
                htmlFor="defaultSalePrice"
                error={errors.defaultSalePrice}
                hint="Printed on the pack. Blank if it varies by lot."
              >
                <input
                  id="defaultSalePrice"
                  type="number"
                  min={0}
                  step="0.01"
                  value={values.defaultSalePrice}
                  onChange={(event) => set("defaultSalePrice", event.target.value)}
                  placeholder="Not set"
                  className="input tnum"
                />
              </Field>
            </div>

            {/*
              Shown rather than blocked: a shop may genuinely sell at or below
              cost to clear a short-dated line, so this is a note, not an error.
            */}
            {marginWarning ? (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {marginWarning}
              </p>
            ) : null}
          </Section>

          <Section title="Handling">
            <Field
              label="Reorder level"
              htmlFor="reorderLevel"
              error={errors.reorderLevel}
              hint="Below this, the medicine shows as low stock. Blank uses the shop default."
            >
              <input
                id="reorderLevel"
                type="number"
                min={0}
                value={values.reorderLevel}
                onChange={(event) => set("reorderLevel", event.target.value)}
                placeholder="Shop default"
                className="input tnum"
              />
            </Field>

            <label className="flex items-start gap-2.5 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={values.requiresPrescription}
                onChange={(event) =>
                  set("requiresPrescription", event.target.checked)
                }
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              <span>
                Prescription required
                <span className="block text-xs text-slate-500">
                  Shows an Rx warning at the counter.
                </span>
              </span>
            </label>

            {isEdit ? (
              <label className="flex items-start gap-2.5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={values.isActive}
                  onChange={(event) => set("isActive", event.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                />
                <span>
                  Active
                  <span className="block text-xs text-slate-500">
                    An inactive medicine stays on past bills but cannot be sold.
                  </span>
                </span>
              </label>
            ) : null}
          </Section>

          {isEdit && canDelete ? (
            <div className="border-t border-slate-100 pt-4">
              {/*
                Deleting is not offered as a bare link any more. It either
                removes a catalogue entry outright or quietly deactivates one
                with history behind it, and neither should happen on a single
                stray click - the same two-step the void control uses.
              */}
              {deleteState === "asking" ? (
                <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
                  <p className="text-xs text-rose-800">
                    Delete {medicine!.name}? If it has any batch or bill history
                    it is marked inactive instead, so past bills still reprint.
                    Otherwise it is removed from the catalogue for good.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={remove}
                      disabled={saving}
                      className="btn-danger flex-1 py-1.5 text-xs"
                    >
                      {saving ? "Deleting…" : "Delete medicine"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteState(null)}
                      className="btn-secondary py-1.5 text-xs"
                    >
                      Keep it
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setDeleteState("asking")}
                  disabled={saving}
                  className="text-xs font-medium text-rose-600 hover:text-rose-700 hover:underline"
                >
                  Delete this medicine
                </button>
              )}
            </div>
          ) : null}

          {/* Enables Enter-to-submit without a visible duplicate button. */}
          <button type="submit" className="sr-only">
            Save
          </button>
        </form>
      )}
    </SlideOver>
  );
}

/**
 * Put an API validation failure back on the fields it came from.
 *
 * `details` is the flattened ZodError the route returns; a CONFLICT from a
 * unique index has no details, so the offending field is inferred from the
 * message instead - "That medicine code is already in use" belongs on the code
 * box, not in a banner three fields above it.
 *
 * Returns whether anything was placed, so the caller knows to keep showing the
 * banner when nothing was.
 */
function placeServerErrors(
  result: { message: string; code: string; details?: unknown },
  setErrors: (errors: Record<string, string>) => void,
): boolean {
  const details = result.details;
  if (details && typeof details === "object") {
    const placed: Record<string, string> = {};
    for (const [key, messages] of Object.entries(
      details as Record<string, unknown>,
    )) {
      const first = Array.isArray(messages) ? messages[0] : messages;
      // "unitsPerStrip.0" and the like name a nested path; the box is the root.
      const field = key.split(".")[0] ?? key;
      if (typeof first === "string") placed[field] = first;
    }
    if (Object.keys(placed).length > 0) {
      setErrors(placed);
      return true;
    }
  }

  if (result.code === "CONFLICT") {
    const field = CONFLICT_FIELDS.find((entry) =>
      result.message.toLowerCase().includes(entry.phrase),
    );
    if (field) {
      setErrors({ [field.key]: result.message });
      return true;
    }
  }

  return false;
}

/** The wording lib/api.ts uses for a duplicate key, mapped back to the box. */
const CONFLICT_FIELDS = [
  { phrase: "medicine code", key: "sku" },
  { phrase: "barcode", key: "barcode" },
  { phrase: "name", key: "name" },
] as const;

/** A titled group of fields. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-4">
      <legend className="w-full border-b border-slate-100 pb-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}
