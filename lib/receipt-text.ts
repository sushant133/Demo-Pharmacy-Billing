/**
 * 80mm thermal receipt as plain lines.
 *
 * Browser print rasterises the HTML bill (Nepali included). Cheap Bluetooth
 * printers speak ESC/POS and only this ASCII layout. Width is 42 columns,
 * the usual 80mm font-A line.
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

export function formatThermalReceipt(receipt: ThermalReceipt): string[] {
  const dash = "-".repeat(THERMAL_WIDTH);
  const lines: string[] = ["TAX INVOICE", receipt.shop.toUpperCase()];
  if (receipt.address) lines.push(...wrapWords(receipt.address));
  if (receipt.phone) lines.push(`Tel: ${receipt.phone}`);
  if (receipt.pan) lines.push(`PAN: ${receipt.pan}`);
  if (receipt.vat) lines.push(`VAT: ${receipt.vat}`);
  if (receipt.licence) lines.push(`DDA: ${receipt.licence}`);
  lines.push(dash, receipt.copyLabel, dash);
  lines.push(padLine("Bill no", receipt.billNo));
  if (receipt.fiscalYear) lines.push(padLine("FY", receipt.fiscalYear));
  if (receipt.dateBs) lines.push(...wrapWords(`BS ${receipt.dateBs}`));
  lines.push(...wrapWords(`AD ${receipt.dateAd}`));
  lines.push(padLine("Payment", receipt.payment));
  lines.push(dash);
  lines.push(...wrapWords(`Buyer: ${receipt.buyer}`));
  if (receipt.buyerPan) lines.push(`Buyer PAN: ${receipt.buyerPan}`);
  lines.push(dash, padLine("Item", "Amt"));
  for (const item of receipt.items) {
    lines.push(...wrapWords(item.name));
    lines.push(padLine(`  ${item.detail}`, item.amount));
  }
  lines.push(dash);
  lines.push(padLine("Subtotal", receipt.subtotal));
  if (receipt.discount) lines.push(padLine("Discount", receipt.discount));
  lines.push(padLine("Taxable", receipt.taxable));
  lines.push(padLine(receipt.vatLabel, receipt.vatAmount));
  lines.push(padLine("TOTAL", receipt.total));
  lines.push(dash);
  lines.push(...wrapWords(receipt.words));
  if (receipt.cashier) lines.push(`Cashier: ${receipt.cashier}`);
  if (receipt.terms) {
    lines.push(dash);
    lines.push(...wrapWords(receipt.terms));
  }
  if (receipt.footer) lines.push(...wrapWords(receipt.footer));
  lines.push("", "Thank you", "");
  return lines;
}
