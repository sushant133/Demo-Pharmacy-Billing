import type { PhotoImportRow } from "@/lib/medicine-import";
import { invoiceMeta, tidyExpiry, type BillLine, type BillReading } from "@/lib/bill-import";

/**
 * Turn OCR text into medicine fields - the on-server photo reader.
 *
 * Tesseract (lib/medicine-ocr-engine.ts) gives back lines of text with their
 * size and confidence and nothing else. This file is the part that knows what
 * a medicine pack or a supplier's bill looks like: which line is the brand,
 * where the composition starts, what an MRP or a barcode looks like, and how
 * to repair the usual OCR slips ("Paracetarnol", "5OO mg") against a list of
 * known generics.
 *
 * Pure and synchronous, so every rule is covered by tests without a picture.
 * Its output feeds the same form fill, CSV and review table as a typed or
 * uploaded list.
 */

export interface OcrWord {
  text: string;
  confidence: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrLine {
  text: string;
  /** Height of the text in pixels - the brand is the biggest print on a pack. */
  height: number;
  /** Tesseract's confidence, 0-100. */
  confidence: number;
  words?: OcrWord[];
  /** Other readings of the same line (a bill row's numbers re-read alone). */
  alternatives?: string[];
  /** The OCR.space engine that read this. Absent when Tesseract did. */
  reader?: number;
}

/** One pack as read, before packReadingToFill turns it into form values. */
export interface OcrPackReading {
  isMedicinePack: boolean;
  name: string;
  genericName: string;
  saltComposition: string;
  manufacturer: string;
  category: string;
  unit: string;
  packSize: string;
  barcode: string;
  unitsPerStrip: number | null;
  mrp: number | null;
  mrpForPieces: number | null;
  note: string;
}

// ---------------------------------------------------------------------------
// Knowledge: common generics and the category each belongs to
// ---------------------------------------------------------------------------

/**
 * Generics seen on Nepali pharmacy shelves, keyed by the spelling printed on
 * packs. It serves three purposes: spotting that a photo is a medicine at
 * all, filling the generic name when the composition line is unreadable, and
 * giving a category the pharmacist would otherwise type by hand.
 */
const GENERICS: Record<string, string> = {
  paracetamol: "Analgesic",
  acetaminophen: "Analgesic",
  ibuprofen: "Analgesic",
  diclofenac: "Analgesic",
  aceclofenac: "Analgesic",
  naproxen: "Analgesic",
  mefenamic: "Analgesic",
  ketorolac: "Analgesic",
  tramadol: "Analgesic",
  etoricoxib: "Analgesic",
  nimesulide: "Analgesic",
  aspirin: "Analgesic",
  amoxicillin: "Antibiotic",
  amoxycillin: "Antibiotic",
  clavulanic: "Antibiotic",
  clavulanate: "Antibiotic",
  ampicillin: "Antibiotic",
  cloxacillin: "Antibiotic",
  flucloxacillin: "Antibiotic",
  azithromycin: "Antibiotic",
  clarithromycin: "Antibiotic",
  erythromycin: "Antibiotic",
  ciprofloxacin: "Antibiotic",
  ofloxacin: "Antibiotic",
  levofloxacin: "Antibiotic",
  norfloxacin: "Antibiotic",
  cefixime: "Antibiotic",
  cefpodoxime: "Antibiotic",
  cefuroxime: "Antibiotic",
  cefadroxil: "Antibiotic",
  cephalexin: "Antibiotic",
  ceftriaxone: "Antibiotic",
  doxycycline: "Antibiotic",
  metronidazole: "Antibiotic",
  tinidazole: "Antibiotic",
  ornidazole: "Antibiotic",
  nitrofurantoin: "Antibiotic",
  cotrimoxazole: "Antibiotic",
  sulfamethoxazole: "Antibiotic",
  trimethoprim: "Antibiotic",
  linezolid: "Antibiotic",
  gentamicin: "Antibiotic",
  fluconazole: "Antifungal",
  itraconazole: "Antifungal",
  terbinafine: "Antifungal",
  clotrimazole: "Antifungal",
  ketoconazole: "Antifungal",
  miconazole: "Antifungal",
  albendazole: "Anthelmintic",
  mebendazole: "Anthelmintic",
  ivermectin: "Anthelmintic",
  acyclovir: "Antiviral",
  valacyclovir: "Antiviral",
  oseltamivir: "Antiviral",
  cetirizine: "Antihistamine",
  levocetirizine: "Antihistamine",
  loratadine: "Antihistamine",
  desloratadine: "Antihistamine",
  fexofenadine: "Antihistamine",
  chlorpheniramine: "Antihistamine",
  pheniramine: "Antihistamine",
  hydroxyzine: "Antihistamine",
  montelukast: "Respiratory",
  salbutamol: "Respiratory",
  levosalbutamol: "Respiratory",
  budesonide: "Respiratory",
  formoterol: "Respiratory",
  ambroxol: "Respiratory",
  bromhexine: "Respiratory",
  guaifenesin: "Respiratory",
  dextromethorphan: "Respiratory",
  theophylline: "Respiratory",
  omeprazole: "Antacid",
  esomeprazole: "Antacid",
  pantoprazole: "Antacid",
  rabeprazole: "Antacid",
  lansoprazole: "Antacid",
  ranitidine: "Antacid",
  famotidine: "Antacid",
  sucralfate: "Antacid",
  domperidone: "Gastro",
  ondansetron: "Gastro",
  metoclopramide: "Gastro",
  itopride: "Gastro",
  loperamide: "Gastro",
  racecadotril: "Gastro",
  lactulose: "Gastro",
  bisacodyl: "Gastro",
  dicyclomine: "Gastro",
  hyoscine: "Gastro",
  drotaverine: "Gastro",
  simethicone: "Gastro",
  metformin: "Antidiabetic",
  glimepiride: "Antidiabetic",
  gliclazide: "Antidiabetic",
  glibenclamide: "Antidiabetic",
  sitagliptin: "Antidiabetic",
  vildagliptin: "Antidiabetic",
  teneligliptin: "Antidiabetic",
  dapagliflozin: "Antidiabetic",
  empagliflozin: "Antidiabetic",
  pioglitazone: "Antidiabetic",
  insulin: "Antidiabetic",
  amlodipine: "Antihypertensive",
  losartan: "Antihypertensive",
  telmisartan: "Antihypertensive",
  olmesartan: "Antihypertensive",
  valsartan: "Antihypertensive",
  enalapril: "Antihypertensive",
  ramipril: "Antihypertensive",
  hydrochlorothiazide: "Antihypertensive",
  chlorthalidone: "Antihypertensive",
  nifedipine: "Antihypertensive",
  cilnidipine: "Antihypertensive",
  atenolol: "Cardiac",
  metoprolol: "Cardiac",
  bisoprolol: "Cardiac",
  carvedilol: "Cardiac",
  propranolol: "Cardiac",
  atorvastatin: "Cardiac",
  rosuvastatin: "Cardiac",
  clopidogrel: "Cardiac",
  furosemide: "Cardiac",
  spironolactone: "Cardiac",
  torsemide: "Cardiac",
  digoxin: "Cardiac",
  isosorbide: "Cardiac",
  nitroglycerin: "Cardiac",
  warfarin: "Cardiac",
  prednisolone: "Steroid",
  methylprednisolone: "Steroid",
  dexamethasone: "Steroid",
  hydrocortisone: "Steroid",
  betamethasone: "Steroid",
  deflazacort: "Steroid",
  mometasone: "Dermatology",
  clobetasol: "Dermatology",
  fusidic: "Dermatology",
  mupirocin: "Dermatology",
  permethrin: "Dermatology",
  calamine: "Dermatology",
  tretinoin: "Dermatology",
  adapalene: "Dermatology",
  levothyroxine: "Thyroid",
  thyroxine: "Thyroid",
  carbimazole: "Thyroid",
  alprazolam: "Psychiatric",
  clonazepam: "Psychiatric",
  diazepam: "Psychiatric",
  lorazepam: "Psychiatric",
  escitalopram: "Psychiatric",
  sertraline: "Psychiatric",
  fluoxetine: "Psychiatric",
  amitriptyline: "Psychiatric",
  olanzapine: "Psychiatric",
  risperidone: "Psychiatric",
  gabapentin: "Neurology",
  pregabalin: "Neurology",
  phenytoin: "Neurology",
  levetiracetam: "Neurology",
  carbamazepine: "Neurology",
  sodium_valproate: "Neurology",
  flunarizine: "Neurology",
  betahistine: "Neurology",
  cinnarizine: "Neurology",
  methylcobalamin: "Supplement",
  cyanocobalamin: "Supplement",
  folic: "Supplement",
  cholecalciferol: "Supplement",
  calcitriol: "Supplement",
  calcium: "Supplement",
  ferrous: "Supplement",
  zinc: "Supplement",
  multivitamin: "Supplement",
  pyridoxine: "Supplement",
  thiamine: "Supplement",
  riboflavin: "Supplement",
  ascorbic: "Supplement",
  tamsulosin: "Urology",
  finasteride: "Urology",
  sildenafil: "Urology",
  tadalafil: "Urology",
  moxifloxacin: "Ophthalmic",
  tobramycin: "Ophthalmic",
  timolol: "Ophthalmic",
  carboxymethylcellulose: "Ophthalmic",
  mifepristone: "Gynaecology",
  misoprostol: "Gynaecology",
  progesterone: "Gynaecology",
  norethisterone: "Gynaecology",
  tranexamic: "Haemostatic",
  ors: "Rehydration",
};

/** Plain-word keys, so "sodium_valproate" matches the printed "valproate". */
const GENERIC_WORDS = new Map<string, string>(
  Object.entries(GENERICS).map(([key, category]) => [key.split("_").pop()!, category]),
);

/** Levenshtein distance, stopping once it exceeds `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * The known generic a printed word is, allowing for OCR slips: one wrong
 * letter in a 6-9 letter word, two in a longer one. Short words must match
 * exactly - "zinc" one letter off is too many other words.
 */
export function matchGeneric(word: string): { generic: string; category: string } | null {
  const clean = word.toLowerCase().replace(/[^a-z]/g, "");
  if (clean.length < 3) return null;
  const exact = GENERIC_WORDS.get(clean);
  if (exact) return { generic: clean, category: exact };
  if (clean.length < 6) return null;
  const allowed = clean.length >= 10 ? 2 : 1;
  let best: { generic: string; category: string; distance: number } | null = null;
  for (const [generic, category] of GENERIC_WORDS) {
    if (generic.length < 6) continue;
    const distance = editDistance(clean, generic, allowed);
    if (distance <= allowed && (!best || distance < best.distance)) {
      best = { generic, category, distance };
    }
  }
  return best ? { generic: best.generic, category: best.category } : null;
}

const titleCase = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

// ---------------------------------------------------------------------------
// Shared text rules
// ---------------------------------------------------------------------------

/**
 * Fix the letter-for-digit swaps OCR makes inside numbers: "5OOmg" → "500mg",
 * "1O.5O" → "10.50", "l0" → "10". Only a word that already holds a digit and
 * whose letters are only O/I/l (plus a unit) is touched, so "B12", "Omez"
 * and "Oil" stay as they are.
 */
export function repairDigits(text: string): string {
  return text
    .split(" ")
    .map((word) => {
      const match = word.match(/^([\dOoIl.,]*\d[\dOoIl.,]*)(mg|mcg|ml|gm|g|iu|%|x)?([.,:;)]?)$/i);
      if (!match) return word;
      return match[1]!.replace(/[Oo]/g, "0").replace(/[Il]/g, "1") + (match[2] ?? "") + match[3];
    })
    .join(" ");
}

function normalise(text: string): string {
  return repairDigits(
    text
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/[—–]/g, "-")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

const DOSE = /(\d+(?:\.\d+)?)\s*(mg|mcg|µg|ug|gm|g|ml|iu|%)(?![a-z])/i;

/** Dosage forms, first the word printed, then what the form stores. */
const UNIT_WORDS: [RegExp, string][] = [
  [/\b(tablets?|tabs?|tab\.)\b/i, "tablet"],
  [/\b(capsules?|caps?\.?)\b/i, "capsule"],
  [/\b(syrup|syp\.?|syr\.?)\b/i, "syrup"],
  [/\b(suspension|susp\.?)\b/i, "suspension"],
  [/\b(injection|inj\.?|vials?|ampoules?|amp\.)\b/i, "injection"],
  [/\b(ointment|oint\.?)\b/i, "ointment"],
  [/\bcream\b/i, "cream"],
  [/\bgel\b/i, "gel"],
  [/\b(eye|ear|nasal)?\s*drops?\b/i, "drops"],
  [/\b(inhaler|rotacaps?|respules?)\b/i, "inhaler"],
  [/\b(sachets?|granules)\b/i, "sachet"],
  [/\bsuppositor(y|ies)\b/i, "suppository"],
  [/\blotion\b/i, "lotion"],
  [/\b(powder|dusting)\b/i, "powder"],
  [/\bsolution\b/i, "solution"],
  [/\bsoap/i, "soap"],
  [/\b(liquid|linctus|elixir)\b/i, "syrup"],
];

export function detectUnit(text: string): string {
  for (const [pattern, unit] of UNIT_WORDS) if (pattern.test(text)) return unit;
  return "";
}

/** A pack written "10x10" / "10 X 10" / "1*15", as strips x pieces. */
const PACK = /\b(\d{1,3})\s*[x×*]\s*(\d{1,3})\b/i;

/** Valid EAN-8 / UPC-A / EAN-13 check digit. */
export function validRetailCode(digits: string): boolean {
  if (![8, 12, 13].includes(digits.length)) return false;
  const body = digits.slice(0, -1);
  let sum = 0;
  // Weights alternate 3,1 from the digit next to the check digit.
  for (let i = 0; i < body.length; i++) {
    const digit = Number(body[body.length - 1 - i]);
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

/** The first valid retail barcode number in the text, spaces allowed within. */
export function findBarcode(lines: readonly string[]): string {
  for (const line of lines) {
    for (const run of line.match(/\d[\d ]{6,20}\d/g) ?? []) {
      const digits = run.replace(/ /g, "");
      if (validRetailCode(digits)) return digits;
      // A run that swallowed a neighbouring number: try each 13 and 12 window.
      for (const size of [13, 12]) {
        for (let i = 0; i + size <= digits.length; i++) {
          const slice = digits.slice(i, i + size);
          if (validRetailCode(slice)) return slice;
        }
      }
    }
  }
  return "";
}

const toNumber = (raw: string) => Number(raw.replace(/,/g, ""));

// ---------------------------------------------------------------------------
// One pack
// ---------------------------------------------------------------------------

/** Lines that are regulatory print, never the brand. */
const BOILERPLATE =
  /\b(store|keep|dosage|directions?|warning|caution|schedule|prescription|mfg|mfd|manufactured|marketed|mktd|batch|b\.?\s?no|exp|expiry|m\.?\s?r\.?\s?p|price|rs\.?|each|contains?|composition|reg|regd|licen[cs]e|lic|made in|www|protect|children|reach|only|rx|incl|taxes|dose|physician|leaflet|temperature|ltd|limited|pvt|pharma|laborator|healthcare|film|coated|uncoated|excipients?|colou?r|q\.?s|i\.?p|b\.?p|u\.?s\.?p|as directed|registered|trademark|see|use|for)\b|°c/i;

const COMPANY =
  /\b(pharma(ceuticals?)?|laborator(y|ies)|labs?|healthcare|life ?sciences|remed(y|ies)|drugs|biotech|formulations?|industries|ltd\.?|limited|pvt\.?|inc\.?|gmbh)\b/i;

const MAKER_PREFIX =
  /\b(manufactured|mfd\.?|mfg\.?|marketed|mktd\.?|distributed|packed)\s*(and\s*marketed\s*)?(by|for)?\s*[:.\-]?\s*/i;

function findManufacturer(lines: readonly string[]): string {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const prefix = line.match(MAKER_PREFIX);
    if (!prefix) continue;
    let rest = line.slice(prefix.index! + prefix[0].length).trim();
    // "Manufactured by:" on its own line, the company on the next.
    if (rest.replace(/[^a-z]/gi, "").length < 4) rest = lines[i + 1] ?? "";
    const company = trimCompany(rest);
    if (company) return company;
  }
  const line = lines.find((l) => COMPANY.test(l) && !DOSE.test(l));
  return line ? trimCompany(line) : "";
}

/** "Deurali-Janta Pharmaceuticals Pvt. Ltd., Kathmandu" → up to "Ltd." */
function trimCompany(text: string): string {
  const clean = text.replace(/^[^a-z]+/i, "").trim();
  const end = clean.match(/\b(ltd\.?|limited|pvt\.? ?ltd\.?|inc\.?|gmbh)/i);
  const cut = end ? clean.slice(0, end.index! + end[0].length) : clean.split(/[,;]/)[0]!;
  return cut.replace(/[.,;:\s]+$/, (tail) => (tail.startsWith(".") ? "." : "")).trim().slice(0, 80);
}

interface Salt {
  name: string;
  amount: string;
}

/**
 * The composition block: "Each film coated tablet contains: Pantoprazole
 * Sodium IP eq. to Pantoprazole 40 mg". Reads each dose on the lines from the
 * "contains" line on (or every dose line, when there is no such line).
 */
function findComposition(lines: readonly string[]): { salts: Salt[]; generics: string[] } {
  const start = lines.findIndex((l) => /\b(each|contains?|composition)\b/i.test(l));
  const window = start >= 0 ? lines.slice(start, start + 6) : lines;
  const salts: Salt[] = [];
  const generics: string[] = [];
  const seen = new Set<string>();

  const text = window
    .join(" ")
    .replace(/.*?\b(contains?|composition)\s*[:.\-]?\s*/i, "")
    .replace(/\b(equivalent|eq\.?)\s*(to)?\b/gi, "eq")
    .replace(/\b(i\.?p\.?|b\.?p\.?|u\.?s\.?p\.?|ph\.?\s?eur\.?)(?=\s|$|[.,:])/gi, " ");
  const pattern = /([A-Za-z][A-Za-z\- ]{2,60}?)[\s.:]*(\d+(?:\.\d+)?)\s*(mg|mcg|µg|ug|gm|g|ml|iu|%)(?![a-z])/gi;
  for (const match of text.matchAll(pattern)) {
    // "Pantoprazole Sodium eq Pantoprazole 40mg" → the part after "eq".
    const words = match[1]!.split(/\beq\b/i).pop()!.trim().split(/\s+/);
    const known = words.map((w) => matchGeneric(w)).filter((g) => g != null);
    const nameWords = words.filter((w) => !/^(each|tablets?|capsules?|syrup|suspension|injection|ml|contains?|and|of|as)$/i.test(w));
    if (nameWords.length === 0) continue;
    const name = nameWords.slice(-3).map((w) => (matchGeneric(w) ? titleCase(matchGeneric(w)!.generic) : w)).join(" ");
    const amount = `${match[2]}${match[3]!.toLowerCase().replace("gm", "g")}`;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    salts.push({ name, amount });
    for (const g of known) if (!generics.includes(g.generic)) generics.push(g.generic);
  }
  return { salts, generics };
}

function findMrp(lines: readonly string[]): { mrp: number | null; line: number } {
  const marker = /\b(m\s?\.?\s?r\s?\.?\s?p\b\.?|max(imum)?\.?\s*retail\s*price|price|rs\b\.?|npr)|₹/i;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const at = line.search(marker);
    if (at < 0) continue;
    // The amount is on the same line, or the next one when printed as a box.
    const after = `${line.slice(at)} ${lines[i + 1] ?? ""}`;
    // Whole numbers only - backtracking into "10 x 10" must not yield "1".
    const amount = after.match(
      /(?<![\d.,])(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,6}(?:\.\d{1,2})?)(?![\d.,]*\d)(?!\s*(mg|mcg|ml|g|%|x)\b)/i,
    );
    if (amount) {
      const value = toNumber(amount[1]!);
      if (value > 0 && value < 100000) return { mrp: value, line: i };
    }
  }
  return { mrp: null, line: -1 };
}

/**
 * How many pieces the printed MRP covers. Explicit wording wins ("per
 * tablet", "per strip of 10"); otherwise a tablet or capsule pack with a
 * known strip size is priced per strip, which is how Nepali and Indian packs
 * print it - flagged in the note so the pharmacist checks.
 */
function mrpPieces(
  text: string,
  unit: string,
  unitsPerStrip: number | null,
): { pieces: number | null; assumed: boolean } {
  const perPiece = /\b(per|\/)\s*(tablet|tab|capsule|cap|piece|unit)\b/i;
  if (perPiece.test(text)) return { pieces: 1, assumed: false };
  const perStripOf = text.match(/\b(per|for)\s*(strip|pack|blister)\s*(of)?\s*(\d{1,3})\b/i);
  if (perStripOf) return { pieces: Number(perStripOf[4]), assumed: false };
  if (/\b(per|\/)\s*(strip|blister)\b/i.test(text) && unitsPerStrip) {
    return { pieces: unitsPerStrip, assumed: false };
  }
  if (["tablet", "capsule"].includes(unit) && unitsPerStrip && unitsPerStrip > 1) {
    return { pieces: unitsPerStrip, assumed: true };
  }
  if (unit) return { pieces: 1, assumed: false };
  return { pieces: null, assumed: false };
}

function findPack(lines: readonly string[]): { packSize: string; unitsPerStrip: number | null } {
  for (const line of lines) {
    const pack = line.match(PACK);
    // "5 x 2 ml" is a dose, not a pack.
    if (pack && !/^\s*(mg|ml|g)\b/i.test(line.slice(pack.index! + pack[0].length))) {
      return { packSize: `${pack[1]}x${pack[2]}`, unitsPerStrip: Number(pack[2]) };
    }
  }
  for (const line of lines) {
    const count = line.match(
      /\b(?:strip|blister|pack)\s*of\s*(\d{1,3})|\b(\d{1,3})\s*(tablets|tabs|capsules|caps)\b/i,
    );
    if (count) {
      const pieces = Number(count[1] ?? count[2]);
      if (pieces > 0) return { packSize: `1x${pieces}`, unitsPerStrip: pieces };
    }
  }
  for (const line of lines) {
    if (/\b(each|contains?|per)\b/i.test(line)) continue;
    const volume = line.match(/\b(\d{1,4})\s*(ml|g|gm)\b/i);
    if (volume) return { packSize: `${volume[1]}${volume[2]!.toLowerCase().replace("gm", "g")}`, unitsPerStrip: null };
  }
  return { packSize: "", unitsPerStrip: null };
}

/**
 * The brand: the largest confidently-read print that is not regulatory text
 * or the company. A bare strength just below it ("40", "500 mg") is joined
 * on, since packs often print it as a separate line.
 */
function findBrand(lines: readonly OcrLine[], generics: readonly string[]): string {
  let index = -1;
  let bestScore = 0;
  lines.forEach((line, i) => {
    const text = line.text;
    const letters = text.replace(/[^a-z]/gi, "");
    if (letters.length < 3 || line.confidence < 45) return;
    if (BOILERPLATE.test(text) || COMPANY.test(text)) return;
    if (text.length > 40) return;
    // A line that is only the generic is the generic, not the brand.
    const words = text.split(/\s+/).filter((w) => /[a-z]{3,}/i.test(w));
    if (words.length > 0 && words.every((w) => generics.includes(matchGeneric(w)?.generic ?? ""))) return;
    const score = line.height * (line.confidence / 100) * (text.length <= 3 ? 0.5 : 1);
    if (score > bestScore) {
      index = i;
      bestScore = score;
    }
  });
  if (index < 0) return "";
  let brand = lines[index]!.text.replace(/[^\w\s+\-./]/g, "").replace(/\s+/g, " ").trim();
  if (!/\d/.test(brand)) {
    const next = lines[index + 1]?.text.trim() ?? "";
    const strength = next.match(/^(\d+(?:\.\d+)?)\s*(mg|mcg|ml|g)?$/i);
    if (strength) brand = `${brand} ${strength[0].replace(/\s+/g, "")}`;
  }
  return brand;
}

/** Read one medicine pack from OCR lines. */
export function parsePackText(raw: readonly OcrLine[]): OcrPackReading {
  const lines = raw
    .map((line) => ({ ...line, text: normalise(line.text) }))
    .filter((line) => line.text.length > 0);
  const texts = lines.map((line) => line.text);
  const all = texts.join("\n");

  const { salts, generics: fromComposition } = findComposition(texts);
  // Known generics anywhere on the pack, only when the composition is
  // unreadable - otherwise "Potassium Clavulanate" in the title would add a
  // second spelling of what the composition already named.
  const generics = [...fromComposition];
  if (generics.length === 0) {
    for (const word of all.split(/[^A-Za-z]+/)) {
      const known = matchGeneric(word);
      if (known && !generics.includes(known.generic)) generics.push(known.generic);
    }
  }

  const unit = detectUnit(all);
  const { packSize, unitsPerStrip } = findPack(texts);
  const { mrp, line: mrpLine } = findMrp(texts);
  const barcode = findBarcode(texts);
  const name = findBrand(lines, generics);
  const manufacturer = findManufacturer(texts);
  const category = generics.map((g) => GENERIC_WORDS.get(g)!).find(Boolean) ?? "";

  const nearMrp = mrpLine >= 0 ? texts.slice(Math.max(0, mrpLine - 1), mrpLine + 2).join(" ") : "";
  const { pieces, assumed } = mrp != null ? mrpPieces(nearMrp || all, unit, unitsPerStrip) : { pieces: null, assumed: false };

  const isMedicinePack =
    salts.length > 0 || generics.length > 0 || (unit !== "" && (DOSE.test(all) || mrp != null));

  const notes: string[] = [];
  if (assumed && pieces) notes.push(`MRP taken as per strip of ${pieces}.`);
  if (!name) notes.push("Brand name not legible.");
  if (salts.length === 0 && generics.length === 0) notes.push("Composition not legible.");
  const confidence = lines.length
    ? lines.reduce((sum, line) => sum + line.confidence, 0) / lines.length
    : 0;
  if (confidence < 60) notes.push("The photo was hard to read - check every field.");

  return {
    isMedicinePack,
    name,
    genericName: generics.map(titleCase).join(" + "),
    saltComposition: salts.map((salt) => `${salt.name} ${salt.amount}`).join(" + "),
    manufacturer,
    category,
    unit,
    packSize,
    barcode,
    unitsPerStrip,
    mrp,
    mrpForPieces: pieces,
    note: isMedicinePack
      ? notes.join(" ")
      : "That does not look like a medicine pack. Photograph the front of the box or strip, close and in good light.",
  };
}

// ---------------------------------------------------------------------------
// A list or bill
// ---------------------------------------------------------------------------

/** Headings, totals and the bill's own details - never a medicine line. */
const NOT_A_ROW =
  /^(s\.?\s?n\.?|sn|sl\.?\s?no|particulars|description|items?|products?|name|qty|quantity|batch|total|sub\s?total|grand|vat|tax|discount|disc|amount|net|round|bill|invoice|date|pan|vat\s?no|tel|phone|mobile|address|thank|signature|authori[sz]ed|cash|credit|balance|received|in words|rupees|customer|supplier|page)\b|\b(total|grand total|sub ?total|in words|vat no|pan no|invoice no)\b/i;

/** A column that is not the name: batch, expiry, HS code. */
const SIDE_COLUMN = /^([A-Z]{1,4}\d{2,}[A-Z\d]*|\d{1,2}[/-]\d{2,4}|\d{2,}[A-Z]+\d*)$/i;

const NEAR = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.02 * Math.abs(b), 0.05);

/**
 * The prices on a line from its trailing numbers. A bill line has a
 * quantity, a rate and an amount with qty x rate = amount; any other number
 * between the rate and the amount that is at least the rate is the MRP. A
 * price list line has one number (the MRP) or two (rate, MRP).
 */
export function pricesFrom(numbers: readonly number[]): { purchasePrice: number | null; mrp: number | null } {
  for (let k = numbers.length - 1; k >= 2; k--) {
    for (let j = k - 1; j >= 1; j--) {
      for (let i = j - 1; i >= 0; i--) {
        const qty = numbers[i]!;
        const rate = numbers[j]!;
        if (qty <= 0 || rate <= 0 || !Number.isInteger(qty)) continue;
        if (NEAR(qty * rate, numbers[k]!)) {
          const between = numbers.slice(j + 1, k).filter((n) => n >= rate);
          const after = numbers.slice(0, i).filter((n) => n >= rate);
          const mrp = between.at(-1) ?? after.at(-1) ?? null;
          return { purchasePrice: rate, mrp };
        }
      }
    }
  }
  if (numbers.length === 1) return { purchasePrice: null, mrp: numbers[0]! };
  if (numbers.length === 2) {
    const [a, b] = numbers as [number, number];
    return { purchasePrice: Math.min(a, b), mrp: Math.max(a, b) };
  }
  return { purchasePrice: null, mrp: null };
}

const FORM_WORD = /^(tabs?|tablets?|caps?|capsules?|syp|syrup|inj|injection|susp|suspension|drops?|cream|gel|oint|ointment|sachet)\.?$/i;

/** One medicine line of a bill or list, or null for a heading/total/noise. */
export function parseListLine(raw: string): PhotoImportRow | null {
  const line = normalise(raw)
    // Leading serial number: "1.", "12)", "3 -", or a bare "1 " before the name.
    .replace(/^\d{1,3}\s*[.)\-:|]\s*|^\d{1,3}\s+(?=[A-Za-z])/, "")
    .replace(/[|]/g, " ")
    .trim();
  if (line.replace(/[^a-z]/gi, "").length < 3) return null;
  if (NOT_A_ROW.test(line)) return null;

  const pack = line.match(PACK);
  const tokens = line.replace(PACK, " ").split(/\s+/).filter(Boolean);
  // With a pack column, everything before it is the name: "Pantop 40 10x10"
  // keeps its 40, which alone would read as a quantity.
  const beforePack = pack
    ? line.slice(0, pack.index).trim().split(/\s+/).filter(Boolean).length
    : 0;

  const nameParts: string[] = [];
  const numbers: number[] = [];
  let nameDone = false;
  for (let i = 0; i < tokens.length; i++) {
    if (i < beforePack) {
      if (DOSE.test(tokens[i]!) || !SIDE_COLUMN.test(tokens[i]!)) nameParts.push(tokens[i]!);
      continue;
    }
    if (pack && i === beforePack) nameDone = true;
    const token = tokens[i]!;
    const next = tokens[i + 1] ?? "";
    const isNumber = /^\d+(?:[.,]\d+)*$/.test(token);
    // Strength stays with the name: "10mg", "10 mg", "250/5".
    const isStrength = DOSE.test(token) || (isNumber && /^(mg|mcg|ml|g|iu|%)$/i.test(next));
    if (!nameDone) {
      // "Pantop 40 Tab": a bare number before a form word is the brand strength,
      // not a price. Only the first one: in "Cetzine 10mg 10 tab" the name already
      // has its strength, and that 10 is a count.
      if (isNumber && FORM_WORD.test(next) && !nameParts.some((part) => /\d/.test(part))) {
        nameParts.push(token);
        continue;
      }
      if (isStrength) {
        nameParts.push(DOSE.test(token) ? token : `${token}${next.toLowerCase()}`);
        if (!DOSE.test(token)) i++;
        continue;
      }
      if (isNumber || SIDE_COLUMN.test(token)) {
        nameDone = true;
      } else {
        nameParts.push(token);
        continue;
      }
    }
    if (isNumber) numbers.push(toNumber(token.replace(/,(?=\d{1,2}$)/, ".")));
  }

  // Dosage-form words are kept in the unit column, not the name.
  const unit = detectUnit(nameParts.join(" "));
  const name = nameParts
    .filter((part, i) => !(i === 0 && /^(tab|tabs|cap|caps|syp|inj)\.?$/i.test(part)))
    .join(" ")
    .replace(/[^\w\s+\-./%()]/g, "")
    // "500 mg" → "500mg", the way the rest of the shop's list writes it.
    .replace(/(\d)\s+(mg|mcg|ml|g|iu)\b/gi, (_, digit: string, dose: string) => digit + dose.toLowerCase())
    .trim();
  if (name.replace(/[^a-z]/gi, "").length < 3) return null;
  // The supplier's own name at the top of a bill.
  if (numbers.length === 0 && !pack && COMPANY.test(name)) return null;

  const generic = name
    .split(/[^A-Za-z]+/)
    .map((w) => matchGeneric(w))
    .find((g) => g != null);
  const { purchasePrice, mrp } = pricesFrom(numbers);

  return {
    name,
    generic: generic ? titleCase(generic.generic) : "",
    manufacturer: "",
    category: generic?.category ?? "",
    unit,
    packSize: pack ? `${pack[1]}x${pack[2]}` : "",
    purchasePrice,
    mrp,
  };
}

// ---------------------------------------------------------------------------
// A supplier's bill
// ---------------------------------------------------------------------------

/**
 * Supplier bills in Nepal print one row per item in a fixed column order -
 * S.N., description, pack, batch, expiry, then the numbers: quantity, free,
 * rate, amount, MRP, discount or remarks - every amount with two decimals.
 * The rows are read by that shape rather than by where the columns sit, so a
 * bill works however it was photographed:
 *
 *  - the expiry date (MM/YYYY) splits a row into its text half and its
 *    number half;
 *  - the number half is anchored by quantity x rate = amount, which also
 *    shows which reading of a smudged number is the right one; the MRP is
 *    the number just after the amount (or where the header puts it);
 *  - the text half ends with the batch and the pack, and the rest is the
 *    medicine's name.
 */

/**
 * An expiry date as a bill prints it: "04/2027", "12/27", "05-2028"; OCR
 * noise allowed. Never with a dot - "5.00" is a quantity, not May 2000.
 */
const EXPIRY = /^[\dOoIl]{1,2}[/-][\dOoIl]{2,4}[.,]?$/;

/** Where the table ends: totals, amount in words, the bill's notes. */
const FOOTER =
  /\b(basic\s?total|grand\s?total|sub\s?total|net\s?(total|payable)|in\s?words?|total\s?amount|amount\s?in|round\s?off|less\s?:?\s?discount)\b|^\s*total\b/i;

type Column = "qty" | "free" | "rate" | "amount" | "mrp" | "discount";

const HEADER_WORDS: [RegExp, Column | "text"][] = [
  [/^(description|particulars?|items?|products?|medicines?)$/, "text"],
  [/^(pack|packing|pkg|batch|expiry|exp)$/, "text"],
  [/^(qty|quantity|qnty)$/, "qty"],
  [/^(free|bonus|sch|scheme)$/, "free"],
  [/^(rate|price|prate|cost)$/, "rate"],
  [/^(amount|amt|value)$/, "amount"],
  [/^(mrp|m\.?r\.?p)$/, "mrp"],
  [/^(dis|disc|discount|dis%|disc%)$/, "discount"],
];

/** The table header: the order of the number columns, or null if this line is not one. */
export function readHeader(text: string): Column[] | null {
  const columns: Column[] = [];
  let matches = 0;
  for (const raw of text.toLowerCase().split(/[\s|]+/)) {
    const word = raw.replace(/[^a-z%.]/g, "").replace(/\.$/, "");
    if (!word) continue;
    for (const [pattern, column] of HEADER_WORDS) {
      if (pattern.test(word) || (word.length >= 5 && matchesLoosely(word, pattern))) {
        matches++;
        if (column !== "text" && !columns.includes(column)) columns.push(column);
        break;
      }
    }
  }
  return matches >= 4 && columns.includes("qty") ? columns : null;
}

/** One OCR slip allowed in a long header word ("Quantlty", "Amourt"). */
function matchesLoosely(word: string, pattern: RegExp): boolean {
  const options = pattern.source.replace(/^\^\(|\)\$/g, "").split("|");
  return options.some((option) => /^[a-z]{5,}$/.test(option) && editDistance(word, option, 1) <= 1);
}

/**
 * A number from a bill's number columns. OCR drops or swaps separators, so
 * with `twoDecimals` (every amount on the bill printed as 0.00) the digits
 * alone decide: "12070" → 120.70, "1.20700" → 1207.00, "1,043.30" → 1043.30.
 * Letters that are digits in disguise are read as digits first.
 */
export function readAmount(token: string, twoDecimals: boolean): number | null {
  // "HELI", "Ta.)": letters that no digit is mistaken for - not a number.
  if (/[A-CE-HK-NPRT-Ya-ce-hj-knp-rt-y]/.test(token)) return null;
  const cleaned = token
    .replace(/[OoDQ]/g, "0")
    .replace(/[Il|!\]\[J]/g, "1")
    .replace(/[Ss]/g, "5")
    .replace(/B/g, "8")
    .replace(/[Zz]/g, "2")
    .replace(/[^\d.,]/g, "")
    .replace(/^[.,]+|[.,]+$/g, "");
  if (!/\d/.test(cleaned)) return null;
  const digits = cleaned.replace(/[.,]/g, "");
  if (twoDecimals) {
    if (digits.length <= 2 && !/[.,]/.test(cleaned)) return Number(digits);
    if (/[.,]\d$/.test(cleaned)) return Number(digits) / 10;
    return Number(digits) / 100;
  }
  const decimal = cleaned.match(/^(.*)[.,](\d{1,2})$/);
  return decimal ? Number(`${decimal[1]!.replace(/[.,]/g, "")}.${decimal[2]}`) : Number(digits);
}

/** The ways one smudged number might really read: as printed, or with a stray leading 1 (a ruling line). */
function amountReadings(token: string, twoDecimals: boolean): number[] {
  const value = readAmount(token, twoDecimals);
  if (value == null) return [];
  const readings = [value];
  const digits = token.replace(/[^\d]/g, "");
  if (digits.length >= 4 && digits.startsWith("1")) {
    const trimmed = readAmount(token.replace(/^[^\d]*1/, ""), twoDecimals);
    if (trimmed != null) readings.push(trimmed);
  }
  return readings;
}

/**
 * Bills compute the amount to the paisa. The only gap allowed is rounding: the
 * printed rate is itself rounded to the paisa, which can shift the amount by
 * half a paisa per unit - never a misread digit.
 */
const ADDS_UP = (qty: number, rate: number, amount: number) =>
  Math.abs(qty * rate - amount) <= 0.011 + qty * 0.005;

interface RowNumbers {
  qty: number;
  free: number | null;
  rate: number;
  amount: number;
  mrp: number | null;
  /** "full": qty x rate = amount as read; "pair": rate and amount agree but the quantity was misread. */
  checked: "full" | "pair";
}

/**
 * The quantity, free quantity, rate, amount and MRP from a row's number
 * tokens, found by qty x rate = amount. Free is what sits between quantity
 * and rate (a blank free column prints nothing, so none there is 0); the MRP
 * is taken where the header puts it relative to the amount, or - with no
 * header - the number right after the amount.
 */
export function readRowNumbers(
  tokens: readonly string[],
  columns: readonly Column[] | null,
  twoDecimals: boolean,
): RowNumbers | null {
  const values = tokens.map((token) => amountReadings(token, twoDecimals));
  // Every combination that adds up, best first: rate and amount side by side
  // (every bill prints them as neighbouring columns), then the larger amount
  // - "5.00 x 1.00 = 5.00" from the qty, free and discount columns also adds
  // up, but it is not the line's value.
  let best: { score: number; numbers: RowNumbers } | null = null;
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      for (let k = j + 1; k < values.length; k++) {
        for (const qty of values[i]!) {
          if (qty <= 0 || qty > 10000) continue;
          for (const rate of values[j]!) {
            if (rate <= 0) continue;
            for (const amount of values[k]!) {
              if (!ADDS_UP(qty, rate, amount)) continue;
              const score = (k === j + 1 ? 1e9 : 0) + amount;
              if (!best || score > best.score) {
                best = {
                  score,
                  numbers: {
                    qty,
                    free: freeFrom(tokens, values, i, j),
                    rate,
                    amount,
                    mrp: mrpFrom(values, columns, j, k),
                    checked: "full",
                  },
                };
              }
            }
          }
        }
      }
    }
  }
  if (best) return best.numbers;

  // The quantity itself misread: a rate and the amount beside it whose ratio
  // is a whole quantity still pin the row down - 5500.00 / 275.00 is exactly
  // 20. Only printed prices take part - both with their decimals - and only
  // amounts a bill line would carry, or a free quantity and a rate would pass.
  const printed = (token: string) => /\d[.,]\d{2}$/.test(token);
  let pair: RowNumbers | null = null;
  for (let j = 0; j + 1 < values.length; j++) {
    if (!printed(tokens[j]!) || !printed(tokens[j + 1]!)) continue;
    const rate = values[j]![0];
    const amount = values[j + 1]![0];
    if (rate == null || amount == null || rate < 10 || amount < 100 || amount <= rate) continue;
    const qty = Math.round(amount / rate);
    if (qty < 1 || qty > 1000 || !ADDS_UP(qty, rate, amount)) continue;
    if (!pair || amount > pair.amount) {
      pair = { qty, free: null, rate, amount, mrp: mrpFrom(values, columns, j, j + 1), checked: "pair" };
    }
  }
  return pair;
}

/** How far qty x rate may miss the amount and still be one misread digit. */
const NEARLY = 0.05;

/**
 * A row that misses by one misread digit: "6.00 344.45 2069.10", where the rate
 * was really 344.85.
 *
 * Never accepted on its own, because a price is never guessed. This is only a
 * candidate: `readBill` uses it when the bill's printed total proves every
 * amount on the page, which also proves the rate worked out from one.
 */
function nearlyAddsUp(
  tokens: readonly string[],
  columns: readonly Column[] | null,
  twoDecimals: boolean,
): RowNumbers | null {
  const values = tokens.map((token) => amountReadings(token, twoDecimals));
  const printed = (index: number) => /\d[.,]\d{2}$/.test(tokens[index] ?? "");
  let best: RowNumbers | null = null;
  for (let j = 1; j + 1 < values.length; j++) {
    if (!printed(j) || !printed(j + 1)) continue;
    const rate = values[j]![0];
    const amount = values[j + 1]![0];
    if (rate == null || amount == null || rate <= 0 || amount <= rate) continue;
    // The quantity is beside the rate, or one along with the free column between.
    for (const i of [j - 1, j - 2]) {
      if (i < 0 || !printed(i)) continue;
      const qty = values[i]![0];
      if (qty == null || qty <= 0 || qty > 10000) continue;
      if (Math.abs(qty * rate - amount) > amount * NEARLY) continue;
      if (best && amount <= best.amount) continue;
      best = {
        qty,
        free: freeFrom(tokens, values, i, j),
        rate: Math.round((amount / qty) * 100) / 100,
        amount,
        mrp: mrpFrom(values, columns, j, j + 1),
        checked: "full",
      };
      break;
    }
  }
  return best;
}

/** An "MM/YYYY" expiry earlier than the month of a "YYYY-MM-DD" date. False if either is unknown. */
function expiredBefore(expiry: string, date: string): boolean {
  const end = /^(\d{2})\/(\d{4})$/.exec(expiry);
  const day = /^(\d{4})-(\d{2})/.exec(date);
  if (!end || !day) return false;
  return Number(end[2]) * 12 + Number(end[1]) < Number(day[1]) * 12 + Number(day[2]);
}

/** An "MM/YYYY" expiry further beyond a "YYYY-MM-DD" date than any shelf life. */
function expiryTooFar(expiry: string, date: string): boolean {
  const end = /^(\d{2})\/(\d{4})$/.exec(expiry);
  const day = /^(\d{4})-(\d{2})/.exec(date);
  if (!end || !day) return false;
  return Number(end[2]) - Number(day[1]) > MAX_SHELF_LIFE_YEARS;
}

/** The sum printed under a bill's lines, before discount: "Basic Total : 3,789.8". */
const LABELLED_TOTAL = /\b(?:basic|sub\s*-?)\s*total(?:\s+amount)?\s*[:.-]*\s*(?:rs\.?\s*)?(\d[\d,]*(?:\.\d{1,2})?)/i;
/** A bare "Total", where the word before it does not make it something else. */
const BARE_TOTAL = /(?<!net\s)(?<!grand\s)(?<!bill\s)\btotal(?:\s+amount)?\s*[:.-]*\s*(?:rs\.?\s*)?(\d[\d,]*(?:\.\d{1,2})?)/i;

/**
 * Looks for the phrase, not at whole lines: a bill read by word position can run
 * "In Words: ... Basic Total 3,708.60" together on one line. The value must
 * follow its label directly, so "Total Qty 20" is not taken for a sum of money.
 */
export function printedTotal(lines: readonly OcrLine[]): number | null {
  for (const pattern of [LABELLED_TOTAL, BARE_TOTAL]) {
    for (const line of lines) {
      const match = pattern.exec(line.text);
      if (match) return Number(match[1]!.replace(/,/g, ""));
    }
  }
  return null;
}

/** Longer than any medicine is licensed for, so a digit was misread. */
const MAX_SHELF_LIFE_YEARS = 6;

/** A printed serial at the start of a row: "10 MONAST ...", "10. MONAST ...". */
function serialOf(text: string): number | null {
  const match = /^\s*(\d{1,3})[.)]?\s+[A-Za-z]/.exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * Serial numbers skipped between the rows found: the row was on the paper and
 * did not make it through. Only trusted when nearly every row has a serial, and
 * they ascend, so a name starting with a number cannot set this off.
 */
export function missingSerials(serials: readonly (number | null)[]): number[] {
  const known = serials.filter((serial): serial is number => serial != null);
  if (known.length < 3 || known.length < serials.length * 0.7) return [];
  if (known.some((serial, index) => index > 0 && serial <= known[index - 1]!)) return [];
  const present = new Set(known);
  const missing: number[] = [];
  for (let serial = known[0]!; serial < known.at(-1)!; serial++) {
    if (!present.has(serial)) missing.push(serial);
  }
  return missing.length <= 5 ? missing : [];
}

/**
 * Says so when a photo was not read by the engine that handles bills well, as
 * on real bills the others get far more wrong: the monthly limit, or the service
 * being down, should not pass unnoticed by whoever is checking the result.
 */
export function readerWarning(lines: readonly OcrLine[]): string {
  if (lines.some((line) => line.reader === 3)) return "";
  return "The main reader was not available, so a backup read this photo and is more likely to make mistakes. Check every line carefully.";
}

/** Headed as goods going back, not a delivery. "Credit Memo" and "Credit Invoice" are sales on credit. */
const RETURN_DOCUMENT = /\breturn\b|\bcr\.?\s*note\b|\bcredit\s+note\b|\bdebit\s+note\b/i;

/**
 * The free quantity: the number between quantity and rate, 0 when the column
 * is blank. Of two there (a pen tick read as "0" beside "0.00"), the one
 * printed as an amount is the column.
 */
function freeFrom(tokens: readonly string[], values: number[][], qty: number, rate: number): number | null {
  const between = values
    .map((readings, index) => ({ readings, token: tokens[index]! }))
    .slice(qty + 1, rate)
    .filter(({ readings }) => readings.length > 0);
  if (between.length === 0) return 0;
  if (between.length === 1) return between[0]!.readings[0]!;
  const printed = between.filter(({ token }) => /\d[.,]\d{2}$/.test(token));
  return printed.length === 1 ? printed[0]!.readings[0]! : null;
}

function mrpFrom(values: number[][], columns: readonly Column[] | null, rate: number, amount: number): number | null {
  let at = amount + 1;
  if (columns) {
    const mrp = columns.indexOf("mrp");
    const amountColumn = columns.indexOf("amount");
    const rateColumn = columns.indexOf("rate");
    if (mrp >= 0 && amountColumn >= 0) at = amount + (mrp - amountColumn);
    // MRP printed between rate and amount.
    if (mrp >= 0 && rateColumn >= 0 && mrp < amountColumn && mrp > rateColumn) at = rate + (mrp - rateColumn);
  }
  const reading = values[at]?.[0];
  if (reading == null || reading <= 0) return null;
  // An MRP five times the rate, or a fifth of it, is a misread, not a price.
  const rateValue = values[rate]?.[0];
  if (rateValue && (reading > rateValue * 5 || reading < rateValue / 5)) return null;
  return reading;
}

/** A pack as bills print it: "10 S", "1 PHL", "1PH", "60ML", "10X1", "15'S", "1 AMP", "100GM", "1". */
const PACK_WORD =
  /^(\d{1,4}\s?[x×*]\s?\d{1,4}|\d{1,4}\s?['`’"]?\s?s|\d{1,4}\s?(ml|m|gm|g|mg|kg|l|ltr|pc|pcs|ph|phl|pkt|amp|vial|btl|tab|tabs|cap|caps|strip|tube|sachet)?|pc|pcs|ph|phl|amp|s|'s)$/i;

/** A batch number: letters and digits, at least one digit ("TET98107", "MB-135", "483"). */
const BATCH_WORD = /^(?=.*\d)[A-Za-z\d][A-Za-z\d\-/]{1,15}$/;

/** A pack glued to its batch by the OCR ("30MLMPJ253614"): the pack part, and the rest. */
const PACK_PREFIX = /^(\d{1,4}(?:ml|gm|mg|g|m))(?=[A-Za-z]{1,4}\d)/i;

/** A row's text half split into name, pack and batch. */
export function splitRowText(tokens: readonly string[]): { name: string; pack: string; batch: string } {
  const words = [...tokens];
  let pack = "";
  let batch = "";

  // Batch: the last word, when it looks like one; a glued pack comes off its front.
  const last = (words.at(-1) ?? "").replace(/[^\w\-/]/g, "").replace(/^[-/]+/, "");
  if (words.length > 1 && BATCH_WORD.test(last)) {
    words.pop();
    batch = last;
    const glued = last.match(PACK_PREFIX);
    if (glued) {
      pack = glued[1]!;
      batch = last.slice(glued[1]!.length);
    }
  }

  // Pack: one or two words before the batch ("1 PHL", "10 S", "60ML").
  if (!pack && words.length > 1) {
    const two = words.slice(-2).join(" ");
    if (words.length > 2 && /^\d/.test(two) && PACK_WORD.test(two)) {
      pack = two;
      words.splice(-2);
    } else if (/^\d/.test(words.at(-1)!) && words.at(-1)!.length <= 7) {
      pack = words.pop()!;
    }
  }

  // Name: drop the serial number and OCR debris before it ("\", "_5~", "eX 5").
  while (words.length > 1) {
    const first = words[0]!;
    const letters = first.replace(/[^A-Za-z]/g, "").length;
    // One or two letters before a real name are a smudged serial number ("QA" for "4" under a tick).
    const debris =
      letters < 2 || (first.length <= 2 && (!/^[A-Z]{2}$/.test(first) || /[A-Za-z]{4}/.test(words[1] ?? "")));
    if (!debris || !words.slice(1).some((w) => /[A-Za-z]{3,}/.test(w))) break;
    words.shift();
  }
  const name = words
    .join(" ")
    // Serial number glued to the name: "_5~PERINORM", "10_ORNADO".
    .replace(/^[^A-Za-z]*\d{0,3}[^A-Za-z\d]+(?=[A-Za-z]{3})/, "")
    .replace(/[^\w\s+\-/.%()]/g, " ")
    // "SML" / "SMG" are "5ML" / "5MG" misread.
    .replace(/\bS(ML|MG)\b/g, "5$1")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-./]+|[\s\-./]+$/g, "")
    .trim();
  return { name, pack: pack.replace(/\s+/g, " ").toUpperCase(), batch: batch.toUpperCase() };
}

interface BillRow {
  line: BillLine;
  /** Only rate and amount agreed; the quantity (and so the MRP beside it) is less sure. */
  pairOnly: boolean;
  /** What the row may be, if the bill's total proves it. Never used otherwise. */
  candidate: RowNumbers | null;
  /** The number printed at the start of the row. */
  serial?: number | null;
}

/** A bill row's two halves - the words before the expiry date and the numbers after it - and the date. */
function splitAtExpiry(text: string): { head: string[]; tail: string[]; expiry: string } | null {
  const tokens = normalise(text).split(/\s+/).filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (EXPIRY.test(tokens[i]!)) {
      return { head: tokens.slice(0, i), tail: tokens.slice(i + 1), expiry: tidyExpiry(tokens[i]!) };
    }
  }
  // Expiry lost: the numbers are the run of numeric words that ends the line.
  let start = tokens.length;
  while (start > 0 && /\d/.test(tokens[start - 1]!) && !/[A-Za-z]{2}/.test(tokens[start - 1]!)) start--;
  if (tokens.length - start < 3) return null;
  return { head: tokens.slice(0, start), tail: tokens.slice(start), expiry: "" };
}

function readBillRow(line: OcrLine, columns: Column[] | null, twoDecimals: boolean): BillRow | null {
  // Every reading of the row is tried; one whose numbers fully add up beats
  // one where only rate and amount agree, which beats one with neither. The
  // page reading comes first, so it wins a tie. The expiry is kept from
  // whichever reading printed one.
  const rank = (numbers: RowNumbers | null) => (numbers?.checked === "full" ? 2 : numbers ? 1 : 0);
  let best: { head: string[]; numbers: RowNumbers | null } | null = null;
  let candidate: RowNumbers | null = null;
  let expiry = "";
  for (const reading of [line.text, ...(line.alternatives ?? [])]) {
    const halves = splitAtExpiry(reading);
    if (!halves) continue;
    expiry ||= halves.expiry;
    const numbers = readRowNumbers(halves.tail, columns, twoDecimals);
    if (!best || rank(numbers) > rank(best.numbers)) best = { head: halves.head, numbers };
    candidate ??= nearlyAddsUp(halves.tail, columns, twoDecimals);
  }
  if (!best) return null;

  const { name, pack, batch } = splitRowText(best.head);
  if (name.replace(/[^A-Za-z]/g, "").length < 3) return null;
  const numbers = best.numbers;
  return {
    line: {
      description: name,
      pack,
      batch,
      expiry,
      quantity: numbers?.qty ?? null,
      free: numbers?.free ?? null,
      rate: numbers?.rate ?? null,
      amount: numbers?.amount ?? null,
      mrp: numbers?.mrp ?? null,
      checked: numbers != null,
    },
    pairOnly: numbers?.checked === "pair",
    candidate,
  };
}

/**
 * The item lines of a supplier's bill as read by OCR, with the invoice
 * number and date from above the table - or null when the lines are not a
 * bill. Rows run from the header to the totals; a row must carry an expiry
 * date or numbers that add up.
 */
export function readBill(lines: readonly OcrLine[]): BillReading | null {
  let columns: Column[] | null = null;
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const header = readHeader(lines[i]!.text);
    if (header) {
      columns = header;
      start = i + 1;
      break;
    }
  }

  // Supplier bills always print expiry dates; a plain price list does not,
  // and is better read line by line than forced into batch and pack columns.
  const table = lines.slice(start);
  if (!table.some((line) => normalise(line.text).split(/\s+/).some((token) => EXPIRY.test(token)))) {
    return null;
  }

  // Do this bill's amounts all carry two decimals? Then digits alone place the point.
  let decimals = 0;
  let plain = 0;
  for (const line of table) {
    for (const token of normalise(line.text).split(/\s+/)) {
      if (/^\d[\d,]*[.,]\d{2}$/.test(token)) decimals++;
      else if (/^\d{3,}$/.test(token)) plain++;
    }
  }
  const twoDecimals = decimals >= 3 && decimals >= plain;

  const found: BillRow[] = [];
  const rowLines = new Set<OcrLine>();
  for (const line of table) {
    if (FOOTER.test(line.text) && found.length > 0) break;
    const row = readBillRow(line, columns, twoDecimals);
    if (!row) continue;
    const hasExpiry = normalise(line.text)
      .split(/\s+/)
      .some((token) => EXPIRY.test(token));
    // A near miss is kept even with no expiry: bills without expiry dates exist,
    // and its numbers are there for the printed total to prove.
    if (!row.line.checked && !hasExpiry && !row.candidate) continue;
    row.serial = serialOf(normalise(line.text));
    found.push(row);
    rowLines.add(line);
  }

  // A bill that prints its names in capitals prints all of them so: a name a
  // pen tick knocked into lower case goes back.
  const capitals = found.filter((row) => row.line.description === row.line.description.toUpperCase()).length;
  if (capitals >= found.length * 0.7) {
    for (const row of found) row.line.description = row.line.description.toUpperCase();
  }

  const above = lines.slice(0, columns ? start - 1 : 0).map((line) => line.text);
  const notes: string[] = [];

  if (above.some((text) => RETURN_DOCUMENT.test(text))) {
    notes.push(
      "This looks like a return or credit note, not a purchase bill. Saving it as a purchase would add stock that went back to the supplier.",
    );
  }

  const skipped = missingSerials(found.map((row) => row.serial ?? null));
  if (skipped.length > 0) {
    notes.push(
      `Line${skipped.length === 1 ? "" : "s"} ${skipped.join(", ")} on the bill could not be read - add ${skipped.length === 1 ? "it" : "them"} by hand.`,
    );
  }

  // The bill's own arithmetic, the one check that covers every line at once.
  const total = printedTotal(table);
  if (total != null && found.length > 0) {
    const amountOf = (row: BillRow) => row.line.amount ?? row.candidate?.amount ?? null;
    const complete = found.every((row) => amountOf(row) != null);
    const sum = found.reduce((running, row) => running + (amountOf(row) ?? 0), 0);
    if (complete && Math.abs(sum - total) <= 1) {
      // Every amount is proven, so a rate worked out from one is too.
      for (const row of found) {
        row.pairOnly = false;
        if (row.line.checked || !row.candidate) continue;
        const { qty, free, rate, amount, mrp } = row.candidate;
        Object.assign(row.line, { quantity: qty, free, rate, amount, mrp, checked: true });
      }
    } else if (complete) {
      notes.push(
        `These lines add up to Rs. ${sum.toFixed(2)} but the bill's total says Rs. ${total.toFixed(2)}. A line may be misread or missing.`,
      );
    }
  }

  const unchecked = found.filter((row) => !row.line.checked).length;
  if (unchecked > 0) {
    notes.push(
      `${unchecked} row${unchecked === 1 ? "'s" : "s'"} prices could not be read with certainty - check ${unchecked === 1 ? "it" : "them"} against the bill.`,
    );
  }
  const unsure = found.filter((row) => row.pairOnly).length;
  if (unsure > 0) {
    notes.push(`${unsure} row${unsure === 1 ? "'s" : "s'"} quantity was unclear - check ${unsure === 1 ? "it" : "them"}.`);
  }
  const noMrp = found.filter((row) => row.line.checked && row.line.mrp == null).length;
  if (noMrp > 0) {
    notes.push(`${noMrp} row${noMrp === 1 ? "'s" : "s'"} MRP could not be read - fill it in from the bill.`);
  }
  const noExpiry = found.filter((row) => !row.line.expiry).length;
  if (noExpiry > 0) {
    notes.push(`${noExpiry} row${noExpiry === 1 ? "'s" : "s'"} expiry could not be read.`);
  }
  // Before the bill's own date: nobody sells stock already expired, so it is
  // almost always a misread digit ("07/2021" for 07/2027).
  // The details are sometimes printed, or read, below the table instead.
  const below = table.filter((line) => !rowLines.has(line)).map((line) => line.text);
  const aboveMeta = invoiceMeta(above);
  const belowMeta = invoiceMeta(below);
  const meta = {
    invoiceNo: aboveMeta.invoiceNo || belowMeta.invoiceNo,
    invoiceDate: aboveMeta.invoiceDate || belowMeta.invoiceDate,
  };
  const billDate = meta.invoiceDate;
  const farOff = found.filter((row) => expiryTooFar(row.line.expiry, billDate)).length;
  if (farOff > 0) {
    notes.push(`${farOff} row${farOff === 1 ? " shows" : "s show"} an expiry too far ahead to be right - check ${farOff === 1 ? "it" : "them"}.`);
  }
  const expired = found.filter((row) => expiredBefore(row.line.expiry, billDate)).length;
  if (expired > 0) {
    notes.push(`${expired} row${expired === 1 ? " shows" : "s show"} an expiry before the bill's own date - check ${expired === 1 ? "it" : "them"}.`);
  }
  const belowCost = found.filter(
    (row) => row.line.mrp != null && row.line.rate != null && row.line.mrp < row.line.rate,
  ).length;
  if (belowCost > 0) {
    notes.push(`${belowCost} row${belowCost === 1 ? " has" : "s have"} an MRP below the rate - check the bill's units.`);
  }

  return {
    lines: found.map((row) => row.line),
    ...meta,
    letterhead: above.map((text) => text.trim()).filter((text) => /[A-Za-z]{3}/.test(text)).slice(0, 4),
    note: notes.join(" "),
  };
}

/**
 * The item rows of a supplier's bill as catalogue rows (for Bulk add
 * medicines), or null when the lines are not a bill.
 */
export function parseBillText(lines: readonly OcrLine[]): { rows: PhotoImportRow[]; note: string } | null {
  const bill = readBill(lines);
  if (!bill) return null;
  const rows = bill.lines.map((line): PhotoImportRow => {
    const generic = line.description
      .split(/[^A-Za-z]+/)
      .map((word) => matchGeneric(word))
      .find((match) => match != null);
    return {
      name: line.description,
      generic: generic ? titleCase(generic.generic) : "",
      manufacturer: "",
      category: generic?.category ?? "",
      unit: detectUnit(line.description),
      packSize: line.pack,
      purchasePrice: line.rate,
      mrp: line.mrp,
    };
  });
  return { rows, note: bill.note };
}

// ---------------------------------------------------------------------------
// Learning from the shop's own catalogue
// ---------------------------------------------------------------------------

/** A medicine the pharmacy already has, as the photo reader compares against it. */
export interface CatalogueEntry {
  /** The medicine (or supplier) this entry is, when the caller needs it back. */
  id?: string;
  name: string;
  genericName?: string;
  manufacturer?: string;
  category?: string;
  unit?: string;
  packSize?: string;
}

/**
 * A name folded for comparison: letters and digits only, with the pairs OCR
 * confuses made equal - 0/O, 1/I/L, 5/S, 8/B, 6/G, 2/Z - so "G-NAX SOAP75GM"
 * and "G-MAX SOAPTSGH" differ only where the photo really was unclear.
 */
function fold(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/0/g, "O")
    .replace(/[1L]/g, "I")
    .replace(/5/g, "S")
    .replace(/8/g, "B")
    .replace(/6/g, "G")
    .replace(/2/g, "Z");
}

/** A name's strength, the first thing in it starting with a digit: "500MG", "40". */
function strengthOf(name: string): string {
  return /\d[0-9A-Z.]*/.exec(name.toUpperCase())?.[0] ?? "";
}

/** Letters OCR takes for digits, once folded, and the digits it leaves alone. */
const DIGIT_LIKE = /[0-9OISBGZ]/;

/** A unit that may be missing from one reading of a strength: "75" and "75GM". */
const UNIT_ONLY = /^(MG|GM|MI|G|MCG|IU)$/;

/**
 * Whether two strengths are really different, rather than one misread.
 *
 * "756M" and "75GM" are one misread letter, and fold to the same thing. "500MG"
 * and "650MG" fold apart where both sides are digits, and that is a different
 * product. Fuzzy matching on the whole name cannot see this: one digit is a small
 * edit, and it would receive stock under the wrong strength.
 */
export function strengthsConflict(a: string, b: string): boolean {
  const first = fold(a);
  const second = fold(b);
  if (first === second) return false;
  if (first.length === second.length) {
    for (let i = 0; i < first.length; i++) {
      if (first[i] !== second[i] && DIGIT_LIKE.test(first[i]!) && DIGIT_LIKE.test(second[i]!)) return true;
    }
    return false;
  }
  const [short, long] = first.length < second.length ? [first, second] : [second, first];
  return !(long.startsWith(short) && UNIT_ONLY.test(long.slice(short.length)));
}

/**
 * The medicine in the shop's catalogue a read name most likely is: the
 * closest by edit distance, when it is close enough (three-quarters of the
 * letters agree) and clearly closer than the runner-up. Every medicine the
 * shop saves - including each corrected import - becomes something later
 * photos are matched against, so the reader gets better the more it is used.
 */
export function matchCatalogue(name: string, catalogue: readonly CatalogueEntry[]): CatalogueEntry | null {
  const target = fold(name);
  if (target.length < 4) return null;
  const strength = strengthOf(name);
  let best: { entry: CatalogueEntry; score: number } | null = null;
  let second = 0;
  for (const entry of catalogue) {
    const candidate = fold(entry.name);
    if (!candidate) continue;
    // Only when both name a strength: a smudge can lose the digits altogether.
    const theirs = strengthOf(entry.name);
    if (strength && theirs && strengthsConflict(strength, theirs)) continue;
    const longest = Math.max(target.length, candidate.length);
    const allowed = Math.floor(longest * 0.25);
    const distance = editDistance(target, candidate, allowed);
    if (distance > allowed) continue;
    const score = 1 - distance / longest;
    if (!best || score > best.score) {
      second = best?.score ?? second;
      best = { entry, score };
    } else if (score > second) {
      second = score;
    }
  }
  if (!best) return null;
  return best.score === 1 || best.score - second >= 0.05 ? best.entry : null;
}

/** A read row with its name corrected to the catalogue's, and its blanks filled from it. */
function withCatalogue(row: PhotoImportRow, entry: CatalogueEntry): PhotoImportRow {
  return {
    ...row,
    name: entry.name,
    generic: row.generic || entry.genericName || "",
    manufacturer: row.manufacturer || entry.manufacturer || "",
    category: row.category || entry.category || "",
    unit: row.unit || entry.unit || "",
    packSize: row.packSize || entry.packSize || "",
  };
}

/**
 * Every medicine line of a photographed bill or list, with a note for the
 * pharmacist. Names are matched against `catalogue` - the medicines the shop
 * already has - so a smudged name comes back as the one it stocks.
 */
export function parseListText(
  raw: readonly OcrLine[],
  catalogue: readonly CatalogueEntry[] = [],
): { rows: PhotoImportRow[]; note: string } {
  const parsed = parseLines(raw);
  if (catalogue.length === 0 || parsed.rows.length === 0) return parsed;

  let matched = 0;
  const rows = parsed.rows.map((row) => {
    const entry = matchCatalogue(row.name, catalogue);
    if (!entry) return row;
    matched++;
    return withCatalogue(row, entry);
  });
  const note = [
    parsed.note,
    matched > 0 ? `${matched} name${matched === 1 ? "" : "s"} matched to medicines you already have.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return { rows, note };
}

function parseLines(raw: readonly OcrLine[]): { rows: PhotoImportRow[]; note: string } {
  // A supplier's bill is read by its columns; anything else line by line.
  const bill = parseBillText(raw);
  if (bill && bill.rows.length > 0) return bill;

  const rows: PhotoImportRow[] = [];
  let doubtful = 0;
  for (const line of raw) {
    const row = parseListLine(line.text);
    if (!row) continue;
    rows.push(row);
    if (line.confidence < 60) doubtful++;
  }
  let note = "";
  if (rows.length === 0) {
    note = "No medicine lines could be read. Photograph the list flat, close and in good light.";
  } else if (doubtful > 0) {
    note = `${doubtful} line${doubtful === 1 ? " was" : "s were"} hard to read - check the highlighted names and prices.`;
  }
  return { rows, note };
}
