import path from "node:path";
import sharp, { type Sharp } from "sharp";
import { createWorker, OEM, PSM, type Worker } from "tesseract.js";
import { config } from "@/lib/config";
import type { OcrLine, OcrWord } from "@/lib/medicine-ocr";
import { readWithOcrSpace } from "@/lib/ocr-space";

/**
 * Text recognition for the photo readers.
 *
 * `readImageText` asks OCR.space first when a key is configured
 * (lib/ocr-space.ts), and otherwise, or when that fails, reads on this server:
 *
 * Tesseract's LSTM model (the English "best_int" data, shipped in
 * node_modules by @tesseract.js-data/eng) runs in a worker thread inside the
 * Next server - no API key, no network, nothing leaves the machine. One
 * worker is kept warm and reused; requests queue for it, which is fine for a
 * pharmacy counter and keeps memory to one model's worth.
 *
 * Server-only.
 */

const LANG_PATH = path.join(process.cwd(), "node_modules", "@tesseract.js-data", "eng", "4.0.0_best_int");

let workerPromise: Promise<Worker> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function getWorker(): Promise<Worker> {
  workerPromise ??= createWorker("eng", OEM.LSTM_ONLY, {
    langPath: LANG_PATH,
    gzip: true,
    cacheMethod: "none",
  }).catch((error) => {
    // A failed start must not poison every later request.
    workerPromise = null;
    throw error;
  });
  return workerPromise;
}

/** Run jobs one at a time on the single worker. */
function serialise<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

export type OcrLayout = "pack" | "list";

const WHITE = { r: 255, g: 255, b: 255 };

interface GreyImage {
  data: Buffer;
  width: number;
  height: number;
}

/** A one-channel image as sharp input. */
const fromGrey = ({ data, width, height }: GreyImage): Sharp =>
  sharp(data, { raw: { width, height, channels: 1 } });

/**
 * A pipeline's result as one-channel pixels. sharp writes raw output as RGB
 * unless told otherwise - even from a one-channel input - so every step that
 * works on pixels goes through here.
 */
async function toGrey(pipeline: Sharp): Promise<GreyImage> {
  const { data, info } = await pipeline.greyscale().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 1) throw new Error(`Expected 1 channel, got ${info.channels}`);
  return { data, width: info.width, height: info.height };
}

/**
 * A grey max (or min) filter over a square of side 2 * radius + 1: paper
 * spreads over thin dark print (max), or print over paper (min). sharp's own
 * dilate/erode are binary - they threshold a grey image first - so this is
 * done by hand, separably, on the small images it is used on.
 */
function rankFilter(image: GreyImage, radius: number, op: "max" | "min"): GreyImage {
  const { width, height } = image;
  const pick = op === "max" ? Math.max : Math.min;
  const rows = Buffer.alloc(image.data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let value = image.data[y * width + x]!;
      for (let k = Math.max(0, x - radius); k <= Math.min(width - 1, x + radius); k++) {
        value = pick(value, image.data[y * width + k]!);
      }
      rows[y * width + x] = value;
    }
  }
  const out = Buffer.alloc(image.data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let value = rows[y * width + x]!;
      for (let k = Math.max(0, y - radius); k <= Math.min(height - 1, y + radius); k++) {
        value = pick(value, rows[k * width + x]!);
      }
      out[y * width + x] = value;
    }
  }
  return { data: out, width, height };
}

/** EXIF-upright, then turned by `rotate` degrees. Two passes: sharp keeps only one rotate. */
async function uprightImage(data: Buffer, rotate = 0): Promise<Buffer> {
  const upright = await sharp(data, { failOn: "none" }).rotate().toBuffer();
  return rotate ? sharp(upright).rotate(rotate, { background: WHITE }).toBuffer() : upright;
}

// ---------------------------------------------------------------------------
// A pack
// ---------------------------------------------------------------------------

/**
 * Clean a pack photo up for recognition: upright (EXIF), greyscale, large
 * enough that small print is 20+ pixels high, contrast stretched, lightly
 * sharpened. `invert` gives the negative - white-on-colour print on a pack
 * reads far better as dark-on-light.
 */
async function preparePack(data: Buffer, options: { invert?: boolean; rotate?: number } = {}): Promise<Buffer> {
  const upright = await uprightImage(data, options.rotate);
  const meta = await sharp(upright).metadata();
  const longest = Math.max(meta.width ?? 0, meta.height ?? 0) || 2000;
  const target = Math.min(3000, Math.max(1800, longest));
  let pipeline = sharp(upright)
    .resize({ width: target, height: target, fit: "inside", withoutEnlargement: false })
    .greyscale()
    .normalise()
    .sharpen({ sigma: 1 });
  if (options.invert) pipeline = pipeline.negate({ alpha: false });
  return pipeline.png().toBuffer();
}

// ---------------------------------------------------------------------------
// A bill
// ---------------------------------------------------------------------------

/** Width a bill is scaled to: its table print ends up ~30px high, where Tesseract reads best. */
const DOCUMENT_WIDTH = 2700;

/**
 * Clean a photographed bill for recognition.
 *
 * Phone photos of bills (often WhatsApp-compressed to 900px wide) have table
 * print only ~11px high, shading across the page, faint dot-matrix print,
 * pen ticks across the numbers and ruled grid lines between every column -
 * each of which wrecks Tesseract on its own: decimals vanish, "|" and "["
 * appear inside numbers, rows split. So:
 *
 *  1. read the colour channel that keeps the print and loses blue pen;
 *  2. scale up until the print is ~30px high;
 *  3. flat-field against the paper's own brightness, so shadows and folds
 *     drop out, and stretch the ink - faint or bold - to dark;
 *  4. level every row by the slope of the print around it;
 *  5. erase long straight runs of ink - the table's ruling - which no letter
 *     or digit is long enough to be.
 */
export async function prepareDocument(data: Buffer, options: { rotate?: number } = {}): Promise<Buffer> {
  const upright = await uprightImage(data, options.rotate);
  const meta = await sharp(upright).metadata();
  const sourceWidth = meta.width ?? DOCUMENT_WIDTH;
  const scale = Math.min(4, Math.max(1, DOCUMENT_WIDTH / sourceWidth));

  const channel = await printChannel(upright, meta.channels ?? 3);
  const grey = await toGrey(
    sharp(upright)
      .removeAlpha()
      .extractChannel(channel)
      .resize({ width: Math.round(sourceWidth * scale), kernel: "lanczos3" }),
  );
  const { width, height } = grey;

  // The paper's own brightness at each point: a max filter wipes out print
  // (dark and thin) before the blur, so dense text and ruling do not drag the
  // estimate down. Done at quarter size - the background is smooth anyway.
  const small = rankFilter(await toGrey(fromGrey(grey).resize({ width: Math.round(width / 4) })), 6, "max");
  const background = (await toGrey(fromGrey(small).blur(6).resize({ width, height, fit: "fill" }))).data;

  // Paper is what is bright after the max filter; the floor, a hand or the
  // table around the bill is not, and is blanked so it cannot pass for ink.
  let brightest = 0;
  for (let i = 0; i < background.length; i += 7) brightest = Math.max(brightest, background[i]!);
  const paperFloor = brightest * 0.55;

  const ratios = new Float32Array(grey.data.length);
  for (let i = 0; i < ratios.length; i++) {
    ratios[i] = background[i]! < paperFloor ? 1 : Math.min(1, grey.data[i]! / Math.max(1, background[i]!));
  }
  const paperCut = paperCutOff(ratios, background, paperFloor);

  // The darkest ink nearby (a min filter over about a line of print): faint
  // dot-matrix print and bold laser print are each stretched to black
  // against their own neighbourhood. Never closer to the paper than 0.2 below
  // the cut-off, so a blank patch's noise is not blown up into marks.
  const ratioImage: GreyImage = { data: Buffer.alloc(ratios.length), width, height };
  for (let i = 0; i < ratios.length; i++) ratioImage.data[i] = Math.round(ratios[i]! * 255);
  const localSmall = rankFilter(await toGrey(fromGrey(ratioImage).resize({ width: Math.round(width / 4) })), 4, "min");
  const localInk = (await toGrey(fromGrey(localSmall).blur(3).resize({ width, height, fit: "fill" }))).data;

  const flat = Buffer.alloc(ratios.length);
  for (let i = 0; i < flat.length; i++) {
    const ratio = ratios[i]!;
    if (ratio >= paperCut) {
      flat[i] = 255;
      continue;
    }
    const ink = Math.min(localInk[i]! / 255, paperCut - 0.2);
    flat[i] = Math.round(255 * Math.min(1, Math.max(0, (ratio - ink) / (paperCut - ink))));
  }

  // A bill photographed off square puts one row's name and its numbers on
  // different text lines, and breaks every ruling line into steps too short
  // to recognise as ruling. Photos of paper are rarely tilted evenly - it
  // curls, and perspective slopes the bottom rows more than the top - so each
  // band of the page is measured and every row is levelled by its own slope.
  const out = shearRows(flat, width, height, rowSlopes(flat, width, height));
  if (process.env.OCR_DEBUG) console.log("[ocr] channel", channel, "paper cut", paperCut);

  eraseRuling(out, width, height);
  return fromGrey({ data: out, width, height }).png().toBuffer();
}

/**
 * Which colour channel to read a bill in.
 *
 * Black print is dark in every channel, but the blue pen a shop ticks and
 * underlines a bill with is nearly as bright as paper in the blue channel -
 * so reading that one drops ticks across the numbers and handwritten notes.
 * Unless the print itself is blue (some dot-matrix ribbons are): then the
 * blue channel loses the print too, and the red channel, where blue ink is
 * darkest, is read instead.
 */
async function printChannel(image: Buffer, channels: number): Promise<"red" | "blue" | 0> {
  if (channels < 3) return 0;
  const { data, info } = await sharp(image)
    .removeAlpha()
    .resize({ width: 600 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  // Print is sparse, so a wide blur is close enough to the paper's colour here.
  const background = await sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } })
    .blur(8)
    .raw()
    .toBuffer();
  let redInk = 0;
  let blueInk = 0;
  for (let i = 0; i + 2 < data.length; i += 3) {
    if (data[i]! < background[i]! * 0.8) redInk++;
    if (data[i + 2]! < background[i + 2]! * 0.8) blueInk++;
  }
  return blueInk >= redInk * 0.6 ? "blue" : "red";
}

/**
 * Where paper ends, from the pixel-to-background ratios on the paper. It
 * follows the paper's noise, read from the near-white pixels only: a clean
 * sheet keeps even very faint dot-matrix print (cut near 0.97), a shaded,
 * JPEG-blotched one cuts harder (near 0.86) so the blotches go.
 */
function paperCutOff(ratios: Float32Array, background: Buffer, paperFloor: number): number {
  const bins = 200;
  const histogram = new Uint32Array(bins + 1);
  let total = 0;
  for (let i = 0; i < ratios.length; i += 3) {
    if (background[i]! < paperFloor || ratios[i]! < 0.85) continue;
    histogram[Math.round(ratios[i]! * bins)]! += 1;
    total++;
  }
  let seen = 0;
  let paperLow = 1;
  for (let bin = 0; bin <= bins; bin++) {
    seen += histogram[bin]!;
    if (seen >= total * 0.1) {
      paperLow = bin / bins;
      break;
    }
  }
  return Math.min(0.97, Math.max(0.86, 1 - 3 * (1 - paperLow)));
}

/**
 * The slope (tan of the tilt; positive = rows rise to the right) of the
 * print at every row of the page.
 *
 * The page is measured in overlapping bands by the projection-profile
 * method (rows of print give the sharpest peaks in the row-by-row ink count
 * when sheared exactly level). Bands with no clear rows - blank table body,
 * margins - take their neighbours' slope, and the slope is interpolated
 * between band centres so a curled page is followed smoothly.
 */
export function rowSlopes(pixels: Buffer, width: number, height: number): Float64Array {
  const band = Math.round(height / 6);
  const step = Math.round(band / 2);
  const known: { centre: number; slope: number }[] = [];
  for (let top = 0; top + band <= height; top += step) {
    const found = bandSkew(pixels.subarray(top * width, (top + band) * width), width, band);
    if (found.gain > 1.05) {
      known.push({ centre: top + band / 2, slope: Math.tan((found.degrees * Math.PI) / 180) });
    }
  }
  const slopes = new Float64Array(height);
  if (known.length === 0) return slopes;
  for (let y = 0; y < height; y++) {
    if (y <= known[0]!.centre) {
      slopes[y] = known[0]!.slope;
    } else if (y >= known.at(-1)!.centre) {
      slopes[y] = known.at(-1)!.slope;
    } else {
      let k = 0;
      while (known[k + 1]!.centre < y) k++;
      const a = known[k]!;
      const b = known[k + 1]!;
      slopes[y] = a.slope + ((b.slope - a.slope) * (y - a.centre)) / (b.centre - a.centre);
    }
  }
  return slopes;
}

/** The best levelling angle for one band, and how much sharper it makes the rows than level. */
function bandSkew(pixels: Buffer, width: number, height: number): { degrees: number; gain: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      if (pixels[y * width + x]! < 128) {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  if (xs.length < 500) return { degrees: 0, gain: 1 };

  const offset = Math.ceil((width * 0.08) / 4);
  const score = (degrees: number) => {
    const slope = Math.tan((degrees * Math.PI) / 180);
    const bins = new Float64Array(Math.ceil(height / 4) + 2 * offset + 2);
    for (let i = 0; i < xs.length; i++) {
      const bin = Math.round((ys[i]! + xs[i]! * slope) / 4) + offset;
      if (bin >= 0 && bin < bins.length) bins[bin]! += 1;
    }
    let total = 0;
    for (const count of bins) total += count * count;
    return total;
  };

  const level = score(0);
  let best = 0;
  let bestScore = level;
  for (let degrees = -4; degrees <= 4.001; degrees += 0.25) {
    const value = score(degrees);
    if (value > bestScore) {
      best = degrees;
      bestScore = value;
    }
  }
  const coarse = best;
  for (let degrees = coarse - 0.2; degrees <= coarse + 0.201; degrees += 0.05) {
    const value = score(degrees);
    if (value > bestScore) {
      best = degrees;
      bestScore = value;
    }
  }
  return { degrees: Math.round(best * 100) / 100, gain: level ? bestScore / level : 1 };
}

/**
 * Level every row by its own slope: a vertical shear about the page centre,
 * so rows come out horizontal while columns stay where they were.
 */
function shearRows(pixels: Buffer, width: number, height: number, slopes: Float64Array): Buffer {
  const out = Buffer.alloc(pixels.length, 255);
  const centre = width / 2;
  for (let y = 0; y < height; y++) {
    const slope = slopes[y]!;
    for (let x = 0; x < width; x++) {
      const sourceY = y - (x - centre) * slope;
      const y0 = Math.floor(sourceY);
      if (y0 < 0 || y0 + 1 >= height) continue;
      const f = sourceY - y0;
      out[y * width + x] = Math.round(pixels[y0 * width + x]! * (1 - f) + pixels[(y0 + 1) * width + x]! * f);
    }
  }
  return out;
}

/**
 * Erase the table's ruling in place: ink runs wider than any word, or taller
 * than two lines of print. Any visible mark counts (grid lines are often
 * printed lighter than the text), column rules may be dashed, and each rule
 * is erased with a margin so its grey edge does not stay behind as a ghost.
 */
function eraseRuling(pixels: Buffer, width: number, height: number): void {
  const ink = new Uint8Array(width * height);
  for (let i = 0; i < ink.length; i++) ink[i] = pixels[i]! < 200 ? 1 : 0;
  const ruling = new Uint8Array(width * height);
  const minH = Math.round(width / 10);
  const minV = Math.round(height / 35);
  const margin = 3;
  const gap = 8;

  for (let y = 0; y < height; y++) {
    let start = -1;
    for (let x = 0; x <= width; x++) {
      const on = x < width && ink[y * width + x] === 1;
      if (on && start < 0) start = x;
      if (!on && start >= 0) {
        if (x - start >= minH) {
          for (let dy = -margin; dy <= margin; dy++) {
            const row = y + dy;
            if (row >= 0 && row < height) ruling.fill(1, row * width + start, row * width + x);
          }
        }
        start = -1;
      }
    }
  }
  for (let x = 0; x < width; x++) {
    let start = -1;
    let last = -1;
    for (let y = 0; y <= height; y++) {
      const on = y < height && ink[y * width + x] === 1;
      if (on) {
        if (start < 0) start = y;
        last = y;
      } else if (start >= 0 && (y - last > gap || y === height)) {
        if (last - start >= minV) {
          for (let k = start; k <= last; k++) {
            for (let dx = -margin; dx <= margin; dx++) {
              const col = x + dx;
              if (col >= 0 && col < width) ruling[k * width + col] = 1;
            }
          }
        }
        start = -1;
      }
    }
  }
  for (let i = 0; i < pixels.length; i++) if (ruling[i]) pixels[i] = 255;
}

// ---------------------------------------------------------------------------
// Recognition
// ---------------------------------------------------------------------------

export async function recognise(image: Buffer, layout: OcrLayout): Promise<OcrLine[]> {
  const worker = await getWorker();
  await worker.setParameters({
    // A pack is scattered text of many sizes. A bill is read as one uniform
    // block, so each table row stays one line instead of being split into
    // column blocks.
    tessedit_pageseg_mode: layout === "pack" ? PSM.SPARSE_TEXT : PSM.SINGLE_BLOCK,
    tessedit_char_whitelist: "",
    preserve_interword_spaces: "1",
    user_defined_dpi: "300",
  });
  const { data } = await worker.recognize(image, {}, { blocks: true, text: true });
  const lines: OcrLine[] = [];
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        const text = line.text.trim();
        if (!text) continue;
        lines.push({
          text,
          height: line.bbox.y1 - line.bbox.y0,
          confidence: line.confidence,
          words: line.words
            .filter((word) => word.text.trim() !== "")
            .map((word) => ({ text: word.text.trim(), confidence: word.confidence, ...word.bbox })),
        });
      }
    }
  }
  return lines;
}

/** An expiry date as printed on a bill: "04/2027", "12/27", read with some noise. */
const EXPIRY_WORD = /^[\dOoIl]{1,2}[/-][\dOoIl]{2,4}[.,]?$/;

/** A word that is mostly digits: part of a bill row's numbers. */
const isNumeric = (text: string) => {
  const digits = text.replace(/[^\d]/g, "").length;
  return digits > 0 && digits >= text.replace(/[.,\s]/g, "").length * 0.5;
};

/**
 * Where a bill row's numbers start: just after its expiry date, or - when
 * the date was lost - at the run of numeric words that ends the line.
 */
function numbersStart(words: readonly OcrWord[]): number {
  for (let i = words.length - 1; i >= 0; i--) {
    if (EXPIRY_WORD.test(words[i]!.text)) return i + 1 < words.length ? i + 1 : -1;
  }
  let start = words.length;
  while (start > 0 && isNumeric(words[start - 1]!.text)) start--;
  return words.length - start >= 3 ? start : -1;
}

/**
 * Re-read the numbers of each bill row with Tesseract allowed only digits and
 * separators - a page-wide reading turns "5.00" into "S00", "120.70" into
 * "12070" and "1,207.00" into "1.20700".
 *
 * Each number is re-read on its own (kept when more confident, or when it
 * finds the decimal point the first reading lost), and the row's whole
 * number area is also re-read as one line and kept as an alternative: the
 * parser takes whichever reading adds up (qty x rate = amount).
 */
async function rereadNumbers(image: Buffer, lines: OcrLine[]): Promise<void> {
  const meta = await sharp(image).metadata();
  const pageWidth = meta.width ?? 0;
  const pageHeight = meta.height ?? 0;
  const worker = await getWorker();
  try {
    for (const line of lines) {
      const words = line.words ?? [];
      const start = numbersStart(words);
      if (start < 0) continue;
      const tail = words.slice(start);

      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_WORD,
        tessedit_char_whitelist: "0123456789.,",
      });
      for (const word of tail) {
        const reread = await readCrop(worker, image, word, pageWidth, pageHeight);
        if (!reread) continue;
        const gainsDecimal = /[.,]\d{2}$/.test(reread.text) && !/[.,]\d{2}$/.test(word.text);
        if (reread.confidence > word.confidence || gainsDecimal) {
          word.text = reread.text;
          word.confidence = reread.confidence;
        }
      }
      line.text = words.map((word) => word.text).join(" ");

      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_LINE,
        tessedit_char_whitelist: "0123456789., ",
      });
      // The row's band: the median word's top and bottom, so one word box
      // that strays into the next row (a tick, a smudge) does not pull a
      // second line of print into the crop.
      const band = rowBand(words);
      const area: OcrWord = {
        text: "",
        confidence: 0,
        x0: tail[0]!.x0,
        x1: Math.max(...tail.map((word) => word.x1)),
        ...band,
      };
      const head = words.slice(0, start).map((word) => word.text);
      line.alternatives = [];
      for (const thicken of [false, true]) {
        const whole = await readCrop(worker, image, area, pageWidth, pageHeight, { keepSpaces: true, thicken });
        if (whole) line.alternatives.push([...head, whole.text].join(" "));
      }

      // The whole row again, thickened and unrestricted: for faint dot-matrix
      // bills this is often the only reading of the name that comes out right.
      await worker.setParameters({ tessedit_char_whitelist: "" });
      const row: OcrWord = { text: "", confidence: 0, x0: words[0]!.x0, x1: area.x1, ...band };
      for (const thicken of [false, true]) {
        const whole = await readCrop(worker, image, row, pageWidth, pageHeight, { keepSpaces: true, thicken });
        if (whole) line.alternatives.push(whole.text);
      }
    }
  } finally {
    await worker.setParameters({
      tessedit_char_whitelist: "",
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
    });
  }
}

/** The typical top and bottom of a row of words. */
function rowBand(words: readonly OcrWord[]): { y0: number; y1: number } {
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  return { y0: median(words.map((word) => word.y0)), y1: median(words.map((word) => word.y1)) };
}

async function readCrop(
  worker: Worker,
  image: Buffer,
  box: OcrWord,
  width: number,
  height: number,
  options: { keepSpaces?: boolean; thicken?: boolean } = {},
): Promise<{ text: string; confidence: number } | null> {
  const pad = Math.round((box.y1 - box.y0) * 0.35);
  const left = Math.max(0, box.x0 - pad);
  const top = Math.max(0, box.y0 - pad);
  const right = Math.min(width, box.x1 + pad);
  const bottom = Math.min(height, box.y1 + pad);
  if (right - left < 4 || bottom - top < 4) return null;
  let cut = sharp(image).extract({ left, top, width: right - left, height: bottom - top });
  if (options.thicken) {
    // Dot-matrix strokes are rows of separate dots; spreading each dot by a
    // pixel joins them into lines Tesseract recognises.
    cut = fromGrey(rankFilter(await toGrey(cut), 1, "min"));
  }
  const crop = await cut.extend({ top: 12, bottom: 12, left: 12, right: 12, background: WHITE }).png().toBuffer();
  const { data } = await worker.recognize(crop);
  const text = options.keepSpaces ? data.text.replace(/\s+/g, " ").trim() : data.text.replace(/\s+/g, "");
  return text ? { text, confidence: data.confidence } : null;
}

/** Merge two readings of one pack, keeping each distinct line once. */
function merge(a: OcrLine[], b: OcrLine[]): OcrLine[] {
  const seen = new Map<string, OcrLine>();
  for (const line of [...a, ...b]) {
    const key = line.text.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!key) continue;
    const kept = seen.get(key);
    if (!kept || line.confidence > kept.confidence) seen.set(key, line);
  }
  return [...seen.values()];
}

/** Rough quality of a reading: confident words of real length. */
function score(lines: readonly OcrLine[]): number {
  return lines.reduce((sum, line) => {
    const words = line.text.split(/\s+/).filter((w) => /[a-z]{3,}/i.test(w)).length;
    return sum + words * (line.confidence / 100);
  }, 0);
}

/** A bill: cleaned and levelled, read, then its numbers re-read. */
async function readDocument(data: Buffer, rotate = 0): Promise<OcrLine[]> {
  const image = await prepareDocument(data, { rotate });
  const lines = await recognise(image, "list");
  await rereadNumbers(image, lines);
  return lines;
}

/**
 * Read the text lines in a photo. A pack is read as-is and as its negative
 * and the two merged; a bill is cleaned, levelled and its numbers re-read.
 * Either is retried turned a quarter each way when the first pass finds
 * almost nothing - a phone photo of a bill is as often sideways as not.
 */
export async function readImageText(data: Buffer, layout: OcrLayout): Promise<OcrLine[]> {
  if (config.ocrSpace.apiKey) {
    try {
      return await readWithOcrSpace(data, layout);
    } catch (error) {
      // Limits reached or the service down: slower, but the shop keeps working.
      console.warn("[ocr] OCR.space could not read this photo, using Tesseract:", error instanceof Error ? error.message : error);
    }
  }
  return readWithTesseract(data, layout);
}

function readWithTesseract(data: Buffer, layout: OcrLayout): Promise<OcrLine[]> {
  return serialise(async () => {
    if (layout === "list") {
      let lines = await readDocument(data);
      if (score(lines) < 4) {
        for (const rotate of [90, 270]) {
          const turned = await readDocument(data, rotate);
          if (score(turned) > score(lines) * 1.5) lines = turned;
        }
      }
      return lines;
    }

    let lines = await recognise(await preparePack(data), "pack");
    lines = merge(lines, await recognise(await preparePack(data, { invert: true }), "pack"));
    if (score(lines) < 4) {
      for (const rotate of [90, 270]) {
        const turned = await recognise(await preparePack(data, { rotate }), "pack");
        if (score(turned) > score(lines) * 1.5) lines = turned;
      }
    }
    return lines;
  });
}
