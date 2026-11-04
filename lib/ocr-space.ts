import sharp from "sharp";
import { config } from "@/lib/config";
import { readBill, type OcrLine } from "@/lib/medicine-ocr";

/**
 * OCR.space, the hosted reader for pack and bill photos.
 *
 * Returns the same `OcrLine[]` Tesseract does, so the parsers that know what a
 * pack or a bill looks like (lib/medicine-ocr.ts) do not care who read it. Any
 * failure throws, and the caller falls back to Tesseract: a shop must still be
 * able to receive stock when the free plan's limits are hit or the service is
 * down.
 *
 * Engines are tried best first. Engine 3 reads bill tables far more faithfully:
 * on a test bill, engine 2 turned "10S" into "105" and dropped zero quantities,
 * which shifts every number after them into the wrong column. But engine 3 has
 * its own, smaller monthly allowance, so engine 2 is the next stop. On real
 * bills engine 2 reads far fewer rows, so running out of engine 3 is noticeable.
 *
 * The key is sent only from this server, in a header, and is never logged.
 *
 * Server-only.
 */

export type OcrSpaceLayout = "pack" | "list";

/** The free plan refuses files over 1 MB. Kept a little under it. */
export const MAX_UPLOAD_BYTES = 980 * 1024;

/** OCR.space gives no confidence figure. It reads well, so past the parsers' doubt checks. */
const ASSUMED_CONFIDENCE = 90;

/** Print height for bill lines, where nothing in the parser reads it. */
const ROW_HEIGHT = 30;

export class OcrSpaceError extends Error {
  constructor(
    message: string,
    /** How long the service asked to be left alone, when it said. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/**
 * Engines that have told us to back off, and until when.
 *
 * The free key has a burst limit beyond its published monthly figures, and once
 * tripped it stays shut for over half an hour. Asking again changes nothing and
 * makes every scan slower, so a resting engine is skipped until its time is up.
 * Per process, which is all it needs to be: the worst a restart costs is asking
 * once more and being told again.
 */
const restingUntil = new Map<number, number>();

export function clearOcrSpaceRest(): void {
  restingUntil.clear();
}

/**
 * The photo as an upright JPEG under the upload limit.
 *
 * Reduced only as far as it must be: table print is what fails first, so size
 * is given up in small steps, and quality before resolution.
 */
export async function prepareUpload(data: Buffer, turn = 0, enlarge = false): Promise<Buffer> {
  // Two passes, because sharp keeps only one rotate: EXIF first, then the turn.
  let upright = await sharp(data, { failOn: "none" }).rotate().toBuffer();
  if (turn) upright = await sharp(upright).rotate(turn).toBuffer();
  if (enlarge) {
    // A WhatsApp photo is 720px wide, with print only a few pixels high.
    const { width } = await sharp(upright).metadata();
    if (width && width < 1800) {
      upright = await sharp(upright).resize({ width: width * 2, kernel: "lanczos3" }).sharpen({ sigma: 1 }).toBuffer();
    }
  }
  let smallest: Buffer | null = null;
  for (const side of [2600, 2200, 1800, 1400, 1100]) {
    for (const quality of [88, 76, 64]) {
      const attempt = await sharp(upright)
        .resize({ width: side, height: side, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality })
        .toBuffer();
      if (attempt.byteLength <= MAX_UPLOAD_BYTES) return attempt;
      smallest = attempt;
    }
  }
  throw new OcrSpaceError(`Photo is still ${smallest?.byteLength ?? 0} bytes at the smallest size.`);
}

/** One line of engine text, without the Markdown engine 3 dresses it in. */
function plainLine(raw: string): string {
  let line = raw.trim();
  // A table's rule: | --- | :--: |
  if (/^\|?[\s:|-]+\|?$/.test(line) && line.includes("-")) return "";
  line = line.replace(/^#{1,6}\s+/, "").replace(/\*\*/g, "");
  if (line.includes("|")) {
    line = line
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join(" ");
  }
  // Engine 2's table mode separates columns with tabs.
  return line.replace(/\s+/g, " ").trim();
}

/** A bill's rows from the parsed text, when the engine kept each row on one line. */
export function textToLines(text: string): OcrLine[] {
  return text
    .split(/\r?\n/)
    .map(plainLine)
    .filter(Boolean)
    .map((line) => ({ text: line, height: ROW_HEIGHT, confidence: ASSUMED_CONFIDENCE }));
}

interface OverlayLine {
  LineText?: string;
  MaxHeight?: number;
  MinTop?: number;
  Words?: Array<{ Left?: number; Top?: number; Height?: number }>;
}

/** How far a photographed page may lean: about 4.5 degrees either way. */
const MAX_SLOPE = 0.08;

/**
 * Rebuild a table's rows from where the words sit on the page.
 *
 * Engine 3's text order cannot be relied on: given a very slightly different
 * image, it returned one bill as whole rows and then column by column, which no
 * row parser can read. Positions do not depend on that. The page's tilt is found
 * first, as the slope that stacks the most text into the fewest rows, because on
 * a tilted phone photo a row can drift further than the gap to the next row.
 */
export function overlayToRows(lines: readonly OverlayLine[]): OcrLine[] {
  const boxes = lines
    .map((line) => {
      const first = line.Words?.[0];
      const height = line.MaxHeight ?? first?.Height ?? 0;
      return {
        text: plainLine(line.LineText ?? ""),
        x: first?.Left ?? 0,
        y: (line.MinTop ?? first?.Top ?? 0) + height / 2,
        height,
      };
    })
    .filter((box) => box.text !== "" && box.height > 0);
  if (boxes.length === 0) return [];

  const heights = boxes.map((box) => box.height).sort((a, b) => a - b);
  const rowHeight = heights[Math.floor(heights.length / 2)]!;

  let slope = 0;
  let bestStack = -1;
  // Level is tried first, so a straight page stays level on a tie.
  for (const candidate of slopesToTry()) {
    const bins = new Map<number, number>();
    for (const box of boxes) {
      const bin = Math.round((box.y - candidate * box.x) / (rowHeight / 2));
      bins.set(bin, (bins.get(bin) ?? 0) + 1);
    }
    let stack = 0;
    for (const count of bins.values()) stack += count * count;
    if (stack > bestStack) {
      bestStack = stack;
      slope = candidate;
    }
  }

  const levelled = boxes
    .map((box) => ({ ...box, level: box.y - slope * box.x }))
    .sort((a, b) => a.level - b.level);
  const rows: Array<typeof levelled> = [];
  for (const box of levelled) {
    const row = rows.at(-1);
    if (row && box.level - row[0]!.level <= rowHeight * 0.6) row.push(box);
    else rows.push([box]);
  }
  return rows.map((row) => ({
    text: [...row].sort((a, b) => a.x - b.x).map((box) => box.text).join(" "),
    height: ROW_HEIGHT,
    confidence: ASSUMED_CONFIDENCE,
  }));
}

function slopesToTry(): number[] {
  const slopes = [0];
  for (let step = 0.002; step <= MAX_SLOPE + 1e-9; step += 0.002) slopes.push(step, -step);
  return slopes;
}

/**
 * A pack's lines from the overlay, top to bottom, with their real print height:
 * the brand is picked out as the biggest print on the box.
 */
export function overlayToLines(lines: readonly OverlayLine[]): OcrLine[] {
  return [...lines]
    .sort((a, b) => (a.MinTop ?? 0) - (b.MinTop ?? 0))
    .map((line) => ({
      text: plainLine(line.LineText ?? ""),
      height: line.MaxHeight ?? ROW_HEIGHT,
      confidence: ASSUMED_CONFIDENCE,
    }))
    .filter((line) => line.text !== "");
}

interface ParsedPage {
  ParsedText?: string;
  FileParseExitCode?: number;
  ErrorMessage?: string | string[];
  TextOverlay?: { Lines?: OverlayLine[] };
}

interface ApiReply {
  ParsedResults?: ParsedPage[] | null;
  OCRExitCode?: number;
  IsErroredOnProcessing?: boolean;
  ErrorMessage?: string | string[] | null;
  /** How a refused key or an exhausted plan is answered. */
  error?: string;
  /** Seconds to wait, sent with a rate-limit error. */
  retryAfter?: number;
}

const messageOf = (value: unknown): string =>
  (Array.isArray(value) ? value.join(" ") : String(value ?? "")).slice(0, 200);

/**
 * The text reading's lines above a bill's table. Rebuilding rows by position
 * runs a bill's two header columns together, "Address : Lahan  Invoice No : 629",
 * and the invoice number and date are then lost. The table is what position
 * fixes, so the header is kept from the text as well.
 */
function aboveTheTable(lines: readonly OcrLine[]): OcrLine[] {
  const table = lines.findIndex((line) => BILL_HEADING.test(line.text));
  return table > 0 ? lines.slice(0, table) : [];
}

/** Lines from a reply, or a throw saying why there are none. */
export function linesFromReply(reply: ApiReply | string, layout: OcrSpaceLayout): OcrLine[] {
  // A refused key is answered with a bare JSON string.
  if (typeof reply !== "object" || reply === null) throw new OcrSpaceError(messageOf(reply));
  if (reply.error) throw new OcrSpaceError(messageOf(reply.error), reply.retryAfter);
  const page = reply.ParsedResults?.[0];
  if (reply.IsErroredOnProcessing || !page || page.FileParseExitCode !== 1) {
    throw new OcrSpaceError(
      messageOf(reply.ErrorMessage ?? page?.ErrorMessage) || `Exit code ${reply.OCRExitCode ?? "unknown"}`,
    );
  }
  const overlay = page.TextOverlay?.Lines ?? [];
  let lines: OcrLine[];
  if (layout === "pack") {
    lines = overlay.length > 0 ? overlayToLines(overlay) : textToLines(page.ParsedText ?? "");
  } else {
    // Two readings of one reply, at no extra request: keep whichever adds up.
    const asText = textToLines(page.ParsedText ?? "");
    const byPosition = overlayToRows(overlay);
    lines =
      readingQuality(byPosition, layout).score > readingQuality(asText, layout).score
        ? [...aboveTheTable(asText), ...byPosition]
        : asText;
  }
  if (lines.length === 0) throw new OcrSpaceError("No text was found.");
  return lines;
}

async function callEngine(image: Buffer, layout: OcrSpaceLayout, engine: number): Promise<OcrLine[]> {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(image)], { type: "image/jpeg" }), "photo.jpg");
  form.set("filetype", "JPG");
  form.set("OCREngine", String(engine));
  form.set("detectOrientation", "true");
  form.set("scale", "true");
  // The overlay makes engine 3 slower, but a pack needs its print heights and a
  // bill its word positions.
  form.set("isOverlayRequired", "true");
  if (layout === "list") form.set("isTable", "true");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ocrSpace.timeoutMs);
  try {
    const response = await fetch(config.ocrSpace.apiUrl, {
      method: "POST",
      headers: { apikey: config.ocrSpace.apiKey },
      body: form,
      signal: controller.signal,
    });
    const text = await response.text();
    let reply: ApiReply | string;
    try {
      reply = JSON.parse(text) as ApiReply | string;
    } catch {
      // The limits answer in plain text rather than JSON.
      throw new OcrSpaceError(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    return linesFromReply(reply, layout);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new OcrSpaceError(`No answer within ${Math.round(config.ocrSpace.timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How well a photo was understood, as a sideways photo still returns text and
 * can even read the names right while losing every number.
 */
export interface ReadingQuality {
  /** Higher is better, for choosing between two readings of one photo. */
  score: number;
  /** Makes sense at all: if not, the photo is worth turning. */
  usable: boolean;
  /** Nothing left that another attempt could improve. */
  complete: boolean;
}

/** No further attempts start after this long. */
const RETRY_WINDOW_MS = 60_000;

/** A name with a price after it: a plain list reads like this when upright. */
const PRICED_LINE = /[a-z]{3,}.*\s\d[\d,]*(?:\.\d+)?$/i;

const BILL_HEADING = /\bbatch\b|\bexpiry\b/i;

export function readingQuality(lines: readonly OcrLine[], layout: OcrSpaceLayout): ReadingQuality {
  if (layout === "pack") {
    const words = lines.flatMap((line) => line.text.split(" ")).filter((word) => /[a-z]{3,}/i.test(word)).length;
    return { score: words, usable: words >= 4, complete: words >= 4 };
  }
  const bill = readBill(lines);
  const rows = bill?.lines ?? [];
  if (rows.length > 0) {
    const proven = rows.filter((row) => row.checked).length;
    // Rows that add up singly can still leave the total out, or a line behind.
    const totalAgrees = !bill!.note.includes("add up to") && !bill!.note.includes("by hand");
    return {
      score: proven * 1000 + rows.length + (totalAgrees ? 500 : 0),
      usable: proven > 0,
      complete: proven === rows.length && totalAgrees,
    };
  }
  // A bill's heading with no rows under it is a failed reading, not a plain list.
  if (lines.some((line) => BILL_HEADING.test(line.text))) return { score: 0, usable: false, complete: false };
  const priced = lines.filter((line) => PRICED_LINE.test(line.text)).length;
  return { score: priced, usable: priced > 0, complete: priced > 0 };
}

/**
 * Read a photo. Throws when no engine could, so the caller can fall back.
 *
 * A phone photo of a bill is as often sideways as not, so a reading whose rows
 * add up nowhere is tried a quarter-turn each way. A bill with a row still out
 * gets one more attempt, enlarged: sending the same image again would only get
 * the same answer. Each costs a request, so neither runs on a clean reading,
 * and neither starts once someone has been waiting at the counter for a minute.
 */
export async function readWithOcrSpace(data: Buffer, layout: OcrSpaceLayout): Promise<OcrLine[]> {
  const started = Date.now();
  const inTime = () => Date.now() - started < RETRY_WINDOW_MS;
  let best = await readOneWay(data, layout, 0);
  let quality = readingQuality(best, layout);
  let bestTurn = 0;

  const attempt = async (turn: number, enlarge = false) => {
    try {
      const lines = await readOneWay(data, layout, turn, enlarge);
      const next = readingQuality(lines, layout);
      if (next.score > quality.score) {
        best = lines;
        quality = next;
        bestTurn = turn;
      }
    } catch {
      // The reading already in hand stands.
    }
  };

  for (const turn of [90, 270]) {
    if (quality.usable || !inTime()) break;
    await attempt(turn);
  }
  // Only on the engine worth a second look: the backup would just spend requests.
  if (quality.usable && !quality.complete && inTime() && best[0]?.reader === 3) {
    await attempt(bestTurn, true);
  }
  return best;
}

/** One orientation, trying each engine in turn. */
async function readOneWay(
  data: Buffer,
  layout: OcrSpaceLayout,
  turn: number,
  enlarge = false,
): Promise<OcrLine[]> {
  const image = await prepareUpload(data, turn, enlarge);
  const problems: string[] = [];
  for (const engine of config.ocrSpace.engines) {
    if ((restingUntil.get(engine) ?? 0) > Date.now()) {
      problems.push(`engine ${engine}: resting after a rate limit`);
      continue;
    }
    try {
      const lines = await callEngine(image, layout, engine);
      return lines.map((line) => ({ ...line, reader: engine }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push(`engine ${engine}: ${message}`);
      if (error instanceof OcrSpaceError && error.retryAfterSeconds) {
        restingUntil.set(engine, Date.now() + error.retryAfterSeconds * 1000);
      }
      // Worth seeing in the log: the next reader is noticeably weaker on bills.
      console.warn(`[ocr] OCR.space engine ${engine} failed: ${message}`);
    }
  }
  throw new OcrSpaceError(problems.join("; "));
}
