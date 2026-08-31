/**
 * Amount in words for IRD tax invoices (English is accepted on the bill).
 */

const ONES = [
  "",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];

const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function belowThousand(value: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  if (hundreds) parts.push(`${ONES[hundreds] ?? ""} hundred`);
  if (rest >= 20) {
    const ten = Math.floor(rest / 10);
    const one = rest % 10;
    const tenWord = TENS[ten] ?? "";
    const oneWord = ONES[one] ?? "";
    parts.push(one ? `${tenWord}-${oneWord}` : tenWord);
  } else if (rest) {
    parts.push(ONES[rest] ?? "");
  }
  return parts.join(" ");
}

function integerWords(value: number): string {
  if (value === 0) return "zero";

  const crore = Math.floor(value / 10_000_000);
  const lakh = Math.floor((value % 10_000_000) / 100_000);
  const thousand = Math.floor((value % 100_000) / 1000);
  const rest = value % 1000;

  const parts: string[] = [];
  if (crore) parts.push(`${belowThousand(crore)} crore`);
  if (lakh) parts.push(`${belowThousand(lakh)} lakh`);
  if (thousand) parts.push(`${belowThousand(thousand)} thousand`);
  if (rest) parts.push(belowThousand(rest));
  return parts.join(" ");
}

/** "One thousand two hundred rupees and fifty paisa only." */
export function amountInWords(value: number): string {
  const rounded = Math.round((Number(value) || 0) * 100);
  const rupees = Math.floor(rounded / 100);
  const paisa = rounded % 100;

  let text = `${integerWords(rupees)} rupee${rupees === 1 ? "" : "s"}`;
  if (paisa) {
    text += ` and ${integerWords(paisa)} paisa`;
  }
  text += " only";
  return text.charAt(0).toUpperCase() + text.slice(1);
}
