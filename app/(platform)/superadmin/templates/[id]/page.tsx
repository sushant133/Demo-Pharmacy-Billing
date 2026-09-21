import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePagePermission } from "@/lib/auth";
import {
  isPrintTemplateId,
  pageRule,
  printTemplate,
  receiptVars,
} from "@/lib/print-templates";
import { BillDocument } from "@/components/bills/BillDocument";
import { sampleBill } from "@/components/bills/sample-bill";
import { AutoPrint } from "@/components/AutoPrint";
import type { CSSProperties } from "react";

export const metadata: Metadata = { title: "Template sample" };
export const dynamic = "force-dynamic";

/**
 * One template at full size, on paper if asked.
 *
 * The gallery's shrunken previews answer "what shape is this?". This answers
 * the only question that finally settles a template choice: put the shop's
 * actual printer in front of it, press Print, and see whether the paper comes
 * out right. Nothing here reads or writes a pharmacy's records - the figures
 * are invented, and printing a sample consumes no bill number.
 */
export default async function TemplateSamplePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePagePermission("pharmacy:manage");
  const { id } = await params;
  if (!isPrintTemplateId(id)) notFound();

  const template = printTemplate(id);
  const bill = sampleBill({ templateId: template.id });

  return (
    <div
      className="receipt-page -m-4 sm:-m-6"
      style={receiptVars(template) as CSSProperties}
    >
      {/*
        `@page` cannot be selected by class, so the size travels with the
        page rather than living in the stylesheet.
      */}
      <style>{pageRule(template)}</style>

      <div className="no-print receipt-toolbar">
        <Link href="/superadmin/templates" className="btn-secondary">
          ← All templates
        </Link>
        <AutoPrint asButton label={`${template.label} sample`} />
      </div>

      <p className="no-print receipt-notice border-slate-200 bg-white text-slate-600">
        <span className="font-medium text-slate-900">{template.label}</span> ·{" "}
        {template.printer} ·{" "}
        {template.paperHeightMm === null
          ? `${template.paperWidthMm}mm continuous`
          : `${template.paperWidthMm} × ${template.paperHeightMm}mm`}
        . Invented figures. Printing this does not touch any pharmacy&rsquo;s
        records.
      </p>

      <BillDocument {...bill} />
    </div>
  );
}
