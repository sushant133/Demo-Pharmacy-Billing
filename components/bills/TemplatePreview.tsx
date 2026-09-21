import { BillDocument, type BillDocumentProps } from "@/components/bills/BillDocument";
import { printTemplate } from "@/lib/print-templates";

/** CSS millimetres are 1/25.4 inch at the 96dpi the browser assumes. */
const PX_PER_MM = 96 / 25.4;

/**
 * A bill rendered at true proportions, shrunk to fit on screen.
 *
 * Whoever is choosing a template is answering one question - will this come
 * out right on that shop's printer? - and the only honest answer is the real
 * document at the real aspect ratio. So this renders `BillDocument` at its
 * full paper width and scales the result down, rather than reflowing it into
 * whatever space the card has. A 58mm roll looks like a narrow ribbon beside
 * a 15-inch carriage, because that is what it is.
 *
 * Tall templates are clipped rather than scrolled: the preview is for judging
 * the shape of the paper, and the full-size sample is one click away.
 */
export function TemplatePreview({
  bill,
  width,
  maxHeight = 420,
}: {
  bill: BillDocumentProps;
  /** How much horizontal room the preview has, in CSS pixels. */
  width: number;
  maxHeight?: number;
}) {
  const template = printTemplate(bill.templateId);
  const paperPx = template.contentWidthMm * PX_PER_MM;
  const scale = Math.min(1, width / paperPx);

  return (
    <div
      className="relative overflow-hidden rounded-lg border border-slate-200 bg-slate-100 p-3"
      style={{ height: maxHeight }}
      aria-hidden="true"
    >
      <div
        style={{
          width: paperPx,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        <BillDocument {...bill} />
      </div>
      {/* Says "there is more paper below" without inviting a scroll. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-slate-100 to-transparent" />
    </div>
  );
}
