/**
 * Thermal receipt as plain lines.
 *
 * Browser print rasterises the HTML bill (Nepali included). Cheap Bluetooth
 * printers speak ESC/POS and only this ASCII layout. The width is the
 * printer's font-A line: 42 columns on an 80mm roll, 32 on a 58mm one. It
 * comes from the pharmacy's assigned template, because a receipt formatted
 * 42 wide on a 58mm printer wraps every second line into gibberish.
 */

export const THERMAL_WIDTH = 42;

export interface ThermalLine {
  name: string;
  detail: string;
  amount: string;
}

export interface ThermalReceipt {
  shop: string;
  address?: string;
  phone?: string;
  pan?: string;
  vat?: string;
  licence?: string;
  copyLabel: string;
  billNo: string;
  fiscalYear?: string;
  dateBs?: string;
  dateAd: string;
  payment: string;
  buyer: string;
  buyerPan?: string;
  items: ThermalLine[];
  subtotal: string;
  discount?: string;
  taxable: string;
  vatLabel: string;
  vatAmount: string;
  total: string;
  /**
   * Only set when the till was actually told what was handed over. A roll
   * printing "Received 0.00" on a card payment would be worse than silence.
   */
  received?: string;
  change?: string;
  balance?: string;
  words: string;
  cashier?: string;
  terms?: string;
  footer?: string;
}

export function padLine(left: string, right: string, width = THERMAL_WIDTH): string {
  const gap = width - left.length - right.length;
  if (gap >= 1) return left + " ".repeat(gap) + right;
  return `${left} ${right}`.slice(0, width);
}

export function wrapWords(text: string, width = THERMAL_WIDTH): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= width) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    if (word.length <= width) {
      current = word;
    } else {
      for (let i = 0; i < word.length; i += width) {
        const chunk = word.slice(i, i + width);
        if (chunk.length === width) lines.push(chunk);
        else current = chunk;
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function formatThermalReceipt(
  receipt: ThermalReceipt,
  width = THERMAL_WIDTH,
): string[] {
  const dash = "-".repeat(width);
  const lines: string[] = ["TAX INVOICE", receipt.shop.toUpperCase()];
  if (receipt.address) lines.push(...wrapWords(receipt.address, width));
  if (receipt.phone) lines.push(`Tel: ${receipt.phone}`);
  if (receipt.pan) lines.push(`PAN: ${receipt.pan}`);
  if (receipt.vat) lines.push(`VAT: ${receipt.vat}`);
  if (receipt.licence) lines.push(`DDA: ${receipt.licence}`);
  lines.push(dash, receipt.copyLabel, dash);
  lines.push(padLine("Bill no", receipt.billNo, width));
  if (receipt.fiscalYear) lines.push(padLine("FY", receipt.fiscalYear, width));
  if (receipt.dateBs) lines.push(...wrapWords(`BS ${receipt.dateBs}`, width));
  lines.push(...wrapWords(`AD ${receipt.dateAd}`, width));
  lines.push(padLine("Payment", receipt.payment, width));
  lines.push(dash);
  lines.push(...wrapWords(`Buyer: ${receipt.buyer}`, width));
  if (receipt.buyerPan) lines.push(`Buyer PAN: ${receipt.buyerPan}`);
  lines.push(dash, padLine("Item", "Amt", width));
  for (const item of receipt.items) {
    lines.push(...wrapWords(item.name, width));
    lines.push(padLine(`  ${item.detail}`, item.amount, width));
  }
  lines.push(dash);
  lines.push(padLine("Subtotal", receipt.subtotal, width));
  if (receipt.discount) lines.push(padLine("Discount", receipt.discount, width));
  lines.push(padLine("Taxable", receipt.taxable, width));
  lines.push(padLine(receipt.vatLabel, receipt.vatAmount, width));
  lines.push(padLine("TOTAL", receipt.total, width));
  if (receipt.received) lines.push(padLine("Received", receipt.received, width));
  if (receipt.change) lines.push(padLine("Change", receipt.change, width));
  if (receipt.balance) lines.push(padLine("BALANCE DUE", receipt.balance, width));
  lines.push(dash);
  lines.push(...wrapWords(receipt.words, width));
  if (receipt.cashier) lines.push(`Cashier: ${receipt.cashier}`);
  if (receipt.terms) {
    lines.push(dash);
    lines.push(...wrapWords(receipt.terms, width));
  }
  if (receipt.footer) lines.push(...wrapWords(receipt.footer, width));
  lines.push("", "Thank you", "");
  return lines;
}
