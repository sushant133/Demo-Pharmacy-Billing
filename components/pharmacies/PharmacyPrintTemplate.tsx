"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client";
import {
  PRINT_TEMPLATE_LIST,
  printTemplate,
  type PrintTemplateId,
} from "@/lib/print-templates";
import { sampleBill } from "@/components/bills/sample-bill";
import { TemplatePreview } from "@/components/bills/TemplatePreview";

/**
 * Which paper this shop's counter prints on.
 *
 * Kept apart from the profile form on purpose. That form records what the
 * platform knows about a business and is edited in passing; this changes what
 * every bill the shop prints from now on physically looks like, so it is its
 * own decision, with its own preview and its own line in the platform
 * history.
 *
 * The preview redraws as the selection changes, before anything is saved -
 * the mistake worth preventing here is assigning A4 to a shop with a till
 * roll, and that mistake is obvious the moment the shape is on screen.
 */
export function PharmacyPrintTemplate({
  pharmacyId,
  pharmacyName,
  current,
}: {
  pharmacyId: string;
  pharmacyName: string;
  current: PrintTemplateId;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState<PrintTemplateId>(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const template = printTemplate(choice);
  const dirty = choice !== current;

  async function save() {
    setError(null);
    setSaving(true);
    const result = await apiFetch(`/api/pharmacies/${pharmacyId}/print-template`, {
      method: "PUT",
      json: { printTemplate: choice },
    });
    setSaving(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }

    setSaved(true);
    router.refresh();
  }

  return (
    <div className="card p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Bill template</h2>
          <p className="mt-1 text-sm text-slate-500">
            The paper {pharmacyName}&rsquo;s printer can produce. Applies to
            every bill and credit note printed from now on; bills already
            issued keep the layout they were printed on.
          </p>
        </div>
        <Link href="/superadmin/templates" className="btn-secondary">
          Compare all
        </Link>
      </div>

      {error ? (
        <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-800">
          {error}
        </div>
      ) : null}

      {saved && !dirty ? (
        <p className="mt-3 text-sm text-emerald-700">
          Saved. {pharmacyName} now prints on {template.label.toLowerCase()}.
        </p>
      ) : null}

      <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-[minmax(0,1fr)_22rem]">
        <div>
          <label htmlFor="printTemplate" className="label">
            Printer and paper
          </label>
          <select
            id="printTemplate"
            className="input"
            value={choice}
            onChange={(event) => {
              setChoice(event.target.value as PrintTemplateId);
              setSaved(false);
            }}
          >
            {PRINT_TEMPLATE_LIST.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label} — {option.printer}
              </option>
            ))}
          </select>

          <p className="mt-2 text-sm text-slate-600">{template.summary}</p>
          <p className="mt-1 text-xs text-slate-500">{template.suitedTo}</p>

          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <Spec
              label="Paper"
              value={
                template.paperHeightMm === null
                  ? `${template.paperWidthMm}mm continuous`
                  : `${template.paperWidthMm} × ${template.paperHeightMm}mm`
              }
            />
            <Spec label="Print width" value={`${template.contentWidthMm}mm`} />
            <Spec
              label="Line items"
              value={
                template.layout === "roll"
                  ? "Stacked, one column"
                  : `${template.columns.length} columns`
              }
            />
            <Spec
              label="Bluetooth roll"
              value={
                template.escposColumns
                  ? `${template.escposColumns} characters`
                  : "Not a roll printer"
              }
            />
          </dl>

          {/*
            The Bluetooth button on the bill screen only appears for a roll.
            Saying so here stops "the printer button disappeared" becoming a
            support call a week later.
          */}
          {template.escposColumns === null ? (
            <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-xs text-amber-800">
              This is not a roll printer, so the counter will not be offered
              the direct Bluetooth button — bills go through the system print
              sheet instead.
            </p>
          ) : null}

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving || !dirty}
              className="btn-primary"
            >
              {saving ? "Saving…" : dirty ? "Save template" : "Saved"}
            </button>
            {dirty ? (
              <button
                type="button"
                onClick={() => setChoice(current)}
                className="btn-secondary"
              >
                Cancel
              </button>
            ) : null}
            <Link
              href={`/superadmin/templates/${template.id}`}
              className="text-xs font-medium text-brand-700 hover:text-brand-800"
            >
              Print a test sample &rarr;
            </Link>
          </div>
        </div>

        <TemplatePreview
          bill={sampleBill({ templateId: template.id })}
          width={330}
          maxHeight={400}
        />
      </div>
    </div>
  );
}

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-medium tracking-wide text-slate-500 uppercase">{label}</dt>
      <dd className="mt-0.5 text-slate-900">{value}</dd>
    </div>
  );
}
