import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/lib/auth";
import { withDbRead } from "@/lib/db";
import { countPharmaciesByTemplate } from "@/lib/pharmacies";
import {
  PRINT_TEMPLATE_LIST,
  type PrinterKind,
  type PrintTemplate,
} from "@/lib/print-templates";
import { integer } from "@/lib/format";
import { sampleBill } from "@/components/bills/sample-bill";
import { TemplatePreview } from "@/components/bills/TemplatePreview";
import { Badge, Card, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Bill templates" };
export const dynamic = "force-dynamic";

const KIND_TONE: Record<PrinterKind, "brand" | "green" | "amber"> = {
  thermal: "brand",
  sheet: "green",
  dotmatrix: "amber",
};

const KIND_LABEL: Record<PrinterKind, string> = {
  thermal: "Thermal roll",
  sheet: "Sheet",
  dotmatrix: "Impact",
};

/**
 * Every bill layout the platform can print, on made-up figures.
 *
 * The catalogue a shop is assigned from. Pharmacies do not all own the same
 * printer - a 58mm handheld at a kiosk, an 80mm roll at most counters, an
 * inkjet where invoices get filed, a wide-carriage impact machine at a
 * distributor - and paper that does not match the machine comes out cut off,
 * cut in half, or one line per page.
 *
 * Previews are real documents at true proportions, not pictures, because a
 * preview drawn by different code is a preview that eventually lies. Each one
 * links to a full-size sample that can actually be sent to a printer, which
 * is the only test that settles the question.
 */
export default async function TemplateGalleryPage() {
  await requirePagePermission("pharmacy:manage");

  // Count only; no shop's own bills are read to build this page.
  const inUse = await withDbRead(() => countPharmaciesByTemplate());

  return (
    <>
      <PageHeader
        title="Bill templates"
        subtitle="What a tax invoice looks like on each kind of printer. Assign one to a pharmacy from its own page."
        actions={
          <Link href="/superadmin/pharmacies" className="btn-secondary">
            All pharmacies
          </Link>
        }
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 xl:grid-cols-3">
        {PRINT_TEMPLATE_LIST.map((template) => (
          <TemplateCard
            key={template.id}
            template={template}
            inUse={inUse[template.id] ?? 0}
          />
        ))}
      </div>
    </>
  );
}

function TemplateCard({
  template,
  inUse,
}: {
  template: PrintTemplate;
  inUse: number;
}) {
  return (
    <Card className="flex flex-col p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">{template.label}</h2>
          <p className="mt-0.5 text-xs text-slate-500">{template.printer}</p>
        </div>
        <Badge tone={KIND_TONE[template.kind]}>{KIND_LABEL[template.kind]}</Badge>
      </div>

      <p className="mt-3 text-sm text-slate-600">{template.summary}</p>
      <p className="mt-1 text-xs text-slate-500">{template.suitedTo}</p>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <Spec label="Paper" value={paperLabel(template)} />
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

      <div className="mt-4">
        <TemplatePreview
          bill={sampleBill({ templateId: template.id })}
          width={320}
          maxHeight={320}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500">
          {inUse > 0
            ? `${integer(inUse)} pharmac${inUse === 1 ? "y prints" : "ies print"} on this.`
            : "No pharmacy uses this yet."}
        </p>
        <Link
          href={`/superadmin/templates/${template.id}`}
          className="text-xs font-medium text-brand-700 hover:text-brand-800"
        >
          Full-size sample &rarr;
        </Link>
      </div>
    </Card>
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

function paperLabel(template: PrintTemplate): string {
  return template.paperHeightMm === null
    ? `${template.paperWidthMm}mm continuous`
    : `${template.paperWidthMm} × ${template.paperHeightMm}mm`;
}
