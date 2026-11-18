/**
 * True for a path on this site and nothing else.
 *
 * `?next=` and similar parameters end up in `location.assign`, so anything a
 * browser would resolve to another origin must be refused: `//evil.com`,
 * `/\evil.com` (browsers read a backslash as a slash), and tabs or newlines
 * that browsers strip before parsing (`/\t/evil.com`). Checked by resolving
 * against a placeholder origin, which is exactly what the browser will do.
 */
export function isSafeAppPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 2048) return false;
  if (!path.startsWith("/")) return false;
  if (path.startsWith("//") || path.includes("\\")) return false;
  // Control characters (including tab, CR, LF) are never part of a real path here.
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  try {
    const base = "https://app.invalid";
    return new URL(path, base).origin === base;
  } catch {
    return false;
  }
}
