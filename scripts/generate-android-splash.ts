/**
 * Build the Android launch artwork from the master logo.
 *
 *   npx tsx scripts/generate-android-splash.ts
 *
 * Run it again whenever public/mantramed-logo.png changes; the outputs are
 * committed under android/app/src/main/res.
 *
 * Three sets, because Android draws the launch in three places:
 *
 *   - `splash_icon` - the emblem the launch screen actually shows. Capacitor's
 *     splash plugin launches through the AndroidX SplashScreen API on every
 *     Android version, and that API draws `windowSplashScreenAnimatedIcon`
 *     centred on a flat colour. Left unset, the library falls back to a
 *     generic icon; pointed at the launcher mipmap, a 192px bitmap is blown up
 *     to 288dp and comes out soft. So it gets its own bitmap, rendered from
 *     the 1254px master at every density bucket, so no phone ever upscales it.
 *
 *     The API canvas is 288dp and anything outside the central 192dp circle
 *     is clipped. The emblem is itself round, so it is fitted to 180dp - as
 *     large as it can go with a little air inside that circle.
 *
 *   - `splash` - the full-screen bitmap the plugin shows if `SplashScreen.show()`
 *     is ever called from the page, or if the AndroidX path fails. Emblem on
 *     white at every size and orientation bucket already in res/.
 *
 *   - `ic_launcher_foreground` - the adaptive-icon layer. Adaptive icons are
 *     108dp, so xxxhdpi needs 432px; the previous 192px layer was stretched
 *     more than 2x on the home screen.
 *
 * Everything sits on white, dark mode included. The emblem's upper arc and
 * "Mantra" are dark navy, which vanishes on a dark ground, and the web app the
 * splash hands over to is light-only - a dark splash would flash into a white
 * page.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = path.join(ROOT, "public", "mantramed-logo.png");
const FOREGROUND = path.join(ROOT, "assets", "icon-foreground.png");
const RES = path.join(ROOT, "android", "app", "src", "main", "res");

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

const DENSITIES = [
  ["mdpi", 1],
  ["hdpi", 1.5],
  ["xhdpi", 2],
  ["xxhdpi", 3],
  ["xxxhdpi", 4],
] as const;

/** The emblem with its transparent margin cut away, so sizes are exact. */
let trimmed: Buffer | undefined;
async function emblem(): Promise<Buffer> {
  trimmed ??= await sharp(SOURCE).trim({ threshold: 10 }).png().toBuffer();
  return trimmed;
}

/** The emblem fitted inside a `box`-pixel square, aspect kept. */
async function fitted(box: number): Promise<Buffer> {
  return sharp(await emblem())
    .resize(box, box, { fit: "inside", kernel: "lanczos3" })
    .png()
    .toBuffer();
}

/** `art` centred on a `width` x `height` canvas of `background`. */
async function centred(
  art: Buffer,
  width: number,
  height: number,
  background: typeof WHITE | typeof TRANSPARENT,
): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background } })
    .composite([{ input: art, gravity: "centre" }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function emit(file: string, data: Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
  console.log(
    `  ${path.relative(ROOT, file).replace(/\\/g, "/")}  ${(data.length / 1024).toFixed(1)}KB`,
  );
}

async function main(): Promise<void> {
  const meta = await sharp(SOURCE).metadata();
  console.log(`source ${meta.width}x${meta.height}\n`);

  // 1. The launch-screen emblem: 288dp canvas, 180dp emblem, transparent.
  for (const [bucket, scale] of DENSITIES) {
    const canvas = Math.round(288 * scale);
    const art = await fitted(Math.round(180 * scale));
    await emit(
      path.join(RES, `drawable-${bucket}`, "splash_icon.png"),
      await centred(art, canvas, canvas, TRANSPARENT),
    );
  }

  // 2. Full-screen fallback bitmaps, at the sizes already shipped in res/.
  //    The emblem takes half the short side; the plugin scales with
  //    FIT_CENTER, so a longer or shorter screen only adds white.
  const fullScreen: Array<[string, number, number]> = [["drawable", 320, 480]];
  for (const night of ["", "-night"]) {
    fullScreen.push(
      [`drawable-port${night}-ldpi`, 240, 320],
      [`drawable-port${night}-mdpi`, 320, 480],
      [`drawable-port${night}-hdpi`, 480, 800],
      [`drawable-port${night}-xhdpi`, 720, 1280],
      [`drawable-port${night}-xxhdpi`, 960, 1600],
      [`drawable-port${night}-xxxhdpi`, 1280, 1920],
      [`drawable-land${night}-ldpi`, 320, 240],
      [`drawable-land${night}-mdpi`, 480, 320],
      [`drawable-land${night}-hdpi`, 800, 480],
      [`drawable-land${night}-xhdpi`, 1280, 720],
      [`drawable-land${night}-xxhdpi`, 1600, 960],
      [`drawable-land${night}-xxxhdpi`, 1920, 1280],
    );
  }
  fullScreen.push(["drawable-night", 320, 480]);

  for (const [dir, width, height] of fullScreen) {
    const art = await fitted(Math.round(Math.min(width, height) * 0.5));
    await emit(path.join(RES, dir, "splash.png"), await centred(art, width, height, WHITE));
  }

  // 3. Adaptive-icon foreground at its real 108dp size. Same artwork as
  //    before, just no longer upscaled on the home screen.
  for (const [bucket, scale] of [["ldpi", 0.75] as const, ...DENSITIES]) {
    const size = Math.round(108 * scale);
    await emit(
      path.join(RES, `mipmap-${bucket}`, "ic_launcher_foreground.png"),
      await sharp(FOREGROUND).resize(size, size, { kernel: "lanczos3" }).png().toBuffer(),
    );
  }

  console.log("\ndone");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
