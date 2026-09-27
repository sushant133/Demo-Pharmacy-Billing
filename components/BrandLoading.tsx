/**
 * Full-screen MantraMed logo, for the moments the app would otherwise show a
 * blank page: the first load of a signed-in screen, and opening a screen
 * from a tapped notification. Same ground and emblem as the Android splash,
 * so the hand-over from the native launch screen is seamless.
 */
export function BrandLoading({ overlay = false }: { overlay?: boolean }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={`${
        overlay ? "fixed inset-0 z-[90]" : "min-h-dvh"
      } flex flex-col items-center justify-center gap-6 bg-white`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- a static brand mark; no optimiser round trip on the loading path */}
      <img
        src="/mantramed-logo.png"
        alt="MantraMed"
        width={112}
        height={112}
        className="h-28 w-28 animate-pulse object-contain"
      />
      <span
        aria-hidden="true"
        className="h-6 w-6 animate-spin rounded-full border-2 border-slate-200 border-t-brand-600"
      />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
