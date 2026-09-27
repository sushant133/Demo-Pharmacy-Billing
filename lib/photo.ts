/**
 * Photo helpers for the browser. Client-only: uses canvas and createImageBitmap.
 */

/** Longest side sent for reading: plenty for print, far smaller than a phone photo. */
const PHOTO_MAX_SIDE = 2000;

/**
 * Shrink a photo to a JPEG the server can take.
 *
 * Phone cameras produce 5-12 MB images; the text on a bill is just as legible
 * at 2000px, and the smaller upload is quicker on a shop's connection and
 * stays under the host's request limit.
 */
export async function shrinkPhoto(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No canvas");
  // White first, so a transparent PNG does not turn black as a JPEG.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.85),
  );
  if (!blob) throw new Error("Could not encode");
  return blob;
}
