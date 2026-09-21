import type { CSSProperties } from "react";
import { cx } from "@/components/ui";
import {
  hasColumn,
  printTemplate,
  receiptVars,
  type PrintTemplate,
} from "@/lib/print-templates";

/**
 * One printed document, laid out for whichever printer the shop owns.
 *
 * The tax invoice and the credit note are the same piece of paper with
 * different words on it, and both have to come off a 58mm roll, an A4 sheet
 * and a dot-matrix carriage. Rather than three copies of the markup drifting
 * apart, there is one component here and the shape of the paper is a
 * `PrintTemplate`.
 *
 * Every prop is plain data. That keeps this renderable from a server page,
 * from the client component that records a reprint, and from the superadmin
 * gallery that previews all eight templates with made-up figures - and it is
 * the gallery that matters, because a preview built from different code is a
 * preview that eventually lies.
 */

export interface BillDocumentIssuer {
  name: string;
  legalName?: string;
  address?: string;
  phone?: string;
  email?: string;
  pan?: string;
  vat?: string;
  licence?: string;
}

export interface BillDocumentItem {
  name: string;
  batch: string;
  /** Already formatted for reading: "Aug 2027", or "" when unknown. */
  expiry: string;
  /** Quantity with its unit: "10 tab". */
  qty: string;
  rate: string;
  amount: string;
}

export interface BillDocumentRow {
  label: string;
  value: string;
}

export interface BillDocumentTotal {
  label: string;
  value: string;
  /** The grand total, printed heavier and ruled off. */
  grand?: boolean;
}

export interface BillDocumentProps {
  templateId: string;
  /** "कर बीजक / TAX INVOICE", or the credit note's own heading. */
  kicker: string;
  issuer: BillDocumentIssuer;
  /** ORIGINAL, "Copy of Original – 2", CREDIT NOTE. */
  copyLabel: string;
  /** A reprint is boxed, so a customer can tell one from the original. */
  copyIsReprint?: boolean;
  /** A cancelled bill still prints - the number was issued - but says so. */
  banner?: string;
  meta: BillDocumentRow[];
  /** Buyer block. An empty label prints the value on its own line. */
  party: BillDocumentRow[];
  /** "Item", or "Item returned" on a credit note. */
  itemsHeading: string;
  items: BillDocumentItem[];
  totals: BillDocumentTotal[];
  /** The amount in words, which a Nepali tax invoice must carry. */
  words: string;
  note?: string;
  /** Who served, and at which outlet. */
  footLine: string;
  signatureLabel?: string;
  /** Terms, the closing line, anything else in small print. */
  tiny?: string[];
}

export function BillDocument(props: BillDocumentProps) {
  const template = printTemplate(props.templateId);

  // A template with two entries prints the same document twice under
  // different captions. `key` is the index because the captions are the
  // identity here, and a one-entry list is the ordinary case.
  return (
    <>
      {template.copies.map((caption, index) => (
        <OneCopy key={index} {...props} template={template} caption={caption} />
      ))}
    </>
  );
}

function OneCopy({
  template,
  caption,
  kicker,
  issuer,
  copyLabel,
  copyIsReprint = false,
  banner,
  meta,
  party,
  itemsHeading,
  items,
  totals,
  words,
  note,
  footLine,
  signatureLabel,
  tiny = [],
}: BillDocumentProps & { template: PrintTemplate; caption: string }) {
  return (
    <article
      className="receipt"
      data-layout={template.layout}
      data-mono={template.monospace ? "true" : undefined}
      style={receiptVars(template) as CSSProperties}
    >
      <header className="receipt-head">
        <p className="receipt-kicker">{kicker}</p>
        <h1 className="receipt-shop">{issuer.name}</h1>
        {issuer.legalName && issuer.legalName !== issuer.name ? (
          <p>{issuer.legalName}</p>
        ) : null}
        {issuer.address ? <p>{issuer.address}</p> : null}
        {issuer.phone ? <p>Tel: {issuer.phone}</p> : null}
        {issuer.email ? <p>{issuer.email}</p> : null}
        <p className="receipt-pan">PAN: {issuer.pan || "—"}</p>
        {issuer.vat ? <p>VAT: {issuer.vat}</p> : null}
        {issuer.licence ? <p>DDA licence: {issuer.licence}</p> : null}
      </header>

      {caption ? <p className="receipt-caption">{caption}</p> : null}

      <p className={cx("receipt-copy", copyIsReprint && "reprint")}>{copyLabel}</p>

      {banner ? <p className="receipt-void">{banner}</p> : null}

      <dl className="receipt-meta">
        {meta.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>

      <section className="receipt-party">
        {party.map((row, index) => (
          <p key={`${row.label}-${index}`}>
            {row.label ? <span className="k">{row.label}</span> : null}
            {row.value}
          </p>
        ))}
      </section>

      {template.layout === "roll" ? (
        <RollLines heading={itemsHeading} items={items} />
      ) : (
        <TableLines template={template} heading={itemsHeading} items={items} />
      )}

      <dl className="receipt-totals">
        {totals.map((total) => (
          <div key={total.label} className={total.grand ? "grand" : undefined}>
            <dt>{total.label}</dt>
            <dd>{total.value}</dd>
          </div>
        ))}
      </dl>

      <p className="receipt-words">{words}</p>

      {note ? <p className="receipt-note">{note}</p> : null}

      <footer className="receipt-foot">
        <p>{footLine}</p>
        {template.showSignature && signatureLabel ? (
          <p className="sign">{signatureLabel} ________________</p>
        ) : null}
        {tiny.map((line, index) => (
          <p key={index} className="tiny">
            {line}
          </p>
        ))}
      </footer>
    </article>
  );
}

/**
 * Narrow paper: the name on its own line, everything that identifies the
 * batch underneath it, the money on the right.
 */
function RollLines({
  heading,
  items,
}: {
  heading: string;
  items: BillDocumentItem[];
}) {
  return (
    <table className="receipt-lines">
      <thead>
        <tr>
          <th className="left">#</th>
          <th className="left">{heading}</th>
          <th className="right">Amt</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item, index) => (
          <tr key={`${item.name}-${index}`}>
            <td className="left muted">{index + 1}</td>
            <td className="left">
              {item.name}
              <span className="muted block">
                {[`${item.qty} × ${item.rate}`, item.batch, item.expiry]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </td>
            <td className="right">{item.amount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Sheet and tractor paper: one column per field, so a line can be read
 * across rather than down.
 */
function TableLines({
  template,
  heading,
  items,
}: {
  template: PrintTemplate;
  heading: string;
  items: BillDocumentItem[];
}) {
  const batch = hasColumn(template, "batch");
  const expiry = hasColumn(template, "expiry");
  const qty = hasColumn(template, "qty");
  const rate = hasColumn(template, "rate");

  return (
    <table className="receipt-lines">
      <thead>
        <tr>
          <th className="left col-index">#</th>
          <th className="left">{heading}</th>
          {batch ? <th className="left col-batch">Batch</th> : null}
          {expiry ? <th className="left col-expiry">Expiry</th> : null}
          {qty ? <th className="right col-qty">Qty</th> : null}
          {rate ? <th className="right col-rate">Rate</th> : null}
          <th className="right col-amount">Amount</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item, index) => (
          <tr key={`${item.name}-${index}`}>
            <td className="left muted">{index + 1}</td>
            <td className="left">
              {item.name}
              {/*
                Whatever this paper has no column for still has to appear:
                a batch number missing from a tax invoice is a compliance
                problem, not a layout preference.
              */}
              {batch && expiry ? null : (
                <span className="muted block">
                  {[batch ? "" : item.batch, expiry ? "" : item.expiry]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              )}
            </td>
            {batch ? <td className="left muted">{item.batch}</td> : null}
            {expiry ? <td className="left muted">{item.expiry}</td> : null}
            {qty ? <td className="right">{item.qty}</td> : null}
            {rate ? <td className="right">{item.rate}</td> : null}
            <td className="right">{item.amount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
