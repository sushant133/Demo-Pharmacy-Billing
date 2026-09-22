import { config } from "@/lib/config";

/**
 * The frame every MantraMed email is sent in.
 *
 * Email is not the web. A mail client is free to strip the `<head>`, ignore
 * a stylesheet, refuse a flexbox and re-flow anything it does not recognise,
 * and Outlook still renders through Word. So this is deliberately old
 * fashioned: table layout, inline styles, no external CSS, no web fonts, one
 * image. It is the shape that survives.
 *
 * Every message is built from the same pieces - the same header bar, the same
 * type scale, the same footer - so a shop that gets its credentials on Sunday
 * and a reset link on Wednesday recognises the second as coming from whoever
 * sent the first. That recognition is most of what an email template is for.
 */

/** Brand colours, repeated here because a mail client cannot read our CSS. */
const INK = "#0f172a";
const BODY = "#334155";
const MUTED = "#64748b";
const RULE = "#e2e8f0";
const GROUND = "#f1f5f9";
const BRAND = "#0f766e";
const BRAND_DARK = "#0b3b38";

export interface EmailButton {
  label: string;
  url: string;
}

export interface EmailBlock {
  /** A short heading above the block. */
  label?: string;
  /** Rows of name/value, rendered as a bordered panel. */
  rows?: Array<{ name: string; value: string }>;
  /** Free paragraphs. */
  paragraphs?: string[];
  /** A cautionary panel, amber rather than grey. */
  caution?: string;
}

export interface EmailContent {
  /** The line under the header bar. */
  heading: string;
  /** Opening paragraphs, before any block. */
  intro: string[];
  blocks?: EmailBlock[];
  button?: EmailButton;
  /** Closing paragraphs, after the blocks and button. */
  outro?: string[];
}

/**
 * Escape text for HTML.
 *
 * Everything interpolated below is either ours or a pharmacy's own name, and
 * a shop is perfectly capable of being called "Sun & Moon Pharmacy". An
 * unescaped ampersand is a broken entity in a mail client just as it is in a
 * browser.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${BODY};">${escapeHtml(text)}</p>`;
}

/**
 * A name/value panel.
 *
 * The value is monospaced: these panels carry things that get retyped - an
 * email address, a password - and a proportional face makes an l, a 1 and an
 * I the same shape at exactly the moment that matters.
 */
function rowsPanel(rows: Array<{ name: string; value: string }>): string {
  const cells = rows
    .map(
      (row, index) => `
        <tr>
          <td style="padding:${index === 0 ? "14px" : "10px"} 16px 4px;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED};font-family:Arial,Helvetica,sans-serif;">${escapeHtml(row.name)}</td>
        </tr>
        <tr>
          <td style="padding:0 16px ${index === rows.length - 1 ? "14px" : "0"};font-size:15px;color:${INK};font-family:'Courier New',Courier,monospace;font-weight:bold;word-break:break-all;">${escapeHtml(row.value)}</td>
        </tr>`,
    )
    .join("");

  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid ${RULE};border-radius:8px;background:#ffffff;margin:0 0 18px;">
      ${cells}
    </table>`;
}

function cautionPanel(text: string): string {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid #fcd34d;border-radius:8px;background:#fffbeb;margin:0 0 18px;">
      <tr>
        <td style="padding:12px 16px;font-size:13px;line-height:1.6;color:#92400e;">${escapeHtml(text)}</td>
      </tr>
    </table>`;
}

function blockHtml(block: EmailBlock): string {
  const parts: string[] = [];
  if (block.label) {
    parts.push(
      `<p style="margin:0 0 8px;font-size:11px;font-weight:bold;letter-spacing:0.1em;text-transform:uppercase;color:${BRAND};">${escapeHtml(block.label)}</p>`,
    );
  }
  for (const text of block.paragraphs ?? []) parts.push(paragraph(text));
  if (block.rows?.length) parts.push(rowsPanel(block.rows));
  if (block.caution) parts.push(cautionPanel(block.caution));
  return parts.join("");
}

/**
 * A button that is really a table cell.
 *
 * Outlook ignores padding on an anchor, so the padding lives on the cell and
 * the anchor fills it. The URL is repeated as text underneath by the caller's
 * outro where it matters, because plenty of clients strip the link.
 */
function buttonHtml(button: EmailButton): string {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 20px;">
      <tr>
        <td style="background:${BRAND};border-radius:8px;">
          <a href="${escapeHtml(button.url)}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;font-family:Arial,Helvetica,sans-serif;">${escapeHtml(button.label)}</a>
        </td>
      </tr>
    </table>`;
}

/**
 * Wrap content in the MantraMed frame.
 *
 * The logo is referenced by absolute URL rather than embedded: a CID
 * attachment makes the message heavier for every recipient, and an image that
 * fails to load has to be survivable anyway - which is why the header also
 * carries the name as live text, and why nothing below depends on an image
 * appearing.
 */
export function renderEmail(content: EmailContent): string {
  const logo = `${config.appUrl}/icon-192.png`;

  const body = [
    ...content.intro.map(paragraph),
    ...(content.blocks ?? []).map(blockHtml),
    content.button ? buttonHtml(content.button) : "",
    ...(content.outro ?? []).map(paragraph),
  ].join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(content.heading)}</title>
</head>
<body style="margin:0;padding:0;background:${GROUND};">
<!-- Preheader: what a phone shows beside the subject, and nothing more. -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(content.intro[0] ?? content.heading)}</div>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${GROUND};">
  <tr>
    <td align="center" style="padding:28px 12px;">

      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;background:#ffffff;border:1px solid ${RULE};border-radius:14px;overflow:hidden;">

        <!-- Header bar -->
        <tr>
          <td style="background:${BRAND_DARK};padding:22px 28px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding-right:14px;" valign="middle">
                  <img src="${escapeHtml(logo)}" width="44" height="44" alt="" style="display:block;width:44px;height:44px;border:0;border-radius:10px;background:#ffffff;">
                </td>
                <td valign="middle">
                  <div style="font-size:20px;font-weight:bold;color:#ffffff;font-family:Arial,Helvetica,sans-serif;letter-spacing:-0.2px;">MantraMed</div>
                  <div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#5eead4;font-family:Arial,Helvetica,sans-serif;padding-top:3px;">Pharmacy Suite</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:28px;font-family:Arial,Helvetica,sans-serif;">
            <h1 style="margin:0 0 16px;font-size:21px;line-height:1.3;color:${INK};font-weight:bold;">${escapeHtml(content.heading)}</h1>
            ${body}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="border-top:1px solid ${RULE};background:#f8fafc;padding:18px 28px;font-family:Arial,Helvetica,sans-serif;">
            <p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:${MUTED};">
              Sent by MantraMed, the pharmacy suite your shop signs in to.
              This message was sent to the address on the account.
            </p>
            <p style="margin:0;font-size:11px;line-height:1.6;color:#94a3b8;">
              A product of MantraSphere Innovations Pvt. Ltd.
            </p>
          </td>
        </tr>

      </table>

    </td>
  </tr>
</table>
</body>
</html>`;
}

/**
 * The same message as plain text.
 *
 * Not a courtesy. A message with no text part is markedly more likely to be
 * scored as spam, and the credentials in it are the one thing that must still
 * arrive in a client that refuses HTML.
 */
export function renderEmailText(content: EmailContent): string {
  const lines: string[] = ["MantraMed - Pharmacy Suite", "", content.heading, ""];

  for (const text of content.intro) lines.push(text, "");

  for (const block of content.blocks ?? []) {
    if (block.label) lines.push(block.label.toUpperCase());
    for (const text of block.paragraphs ?? []) lines.push(text, "");
    for (const row of block.rows ?? []) lines.push(`  ${row.name}: ${row.value}`);
    if (block.rows?.length) lines.push("");
    if (block.caution) lines.push(block.caution, "");
  }

  if (content.button) lines.push(content.button.label + ":", content.button.url, "");
  for (const text of content.outro ?? []) lines.push(text, "");

  lines.push(
    "---",
    "Sent by MantraMed, the pharmacy suite your shop signs in to.",
    "A product of MantraSphere Innovations Pvt. Ltd.",
  );

  return lines.join("\n");
}
