/**
 * Every platform page is `force-dynamic`, so switching sections waits on
 * Mongo. Without this the sidebar sat on the previous screen with nothing to
 * show that anything was happening.
 */
export default function PlatformLoading() {
  return (
    <div className="animate-pulse space-y-4" aria-busy="true" aria-live="polite">
      <div className="h-8 w-48 rounded-lg bg-slate-200" />
      <div className="h-4 w-80 rounded bg-slate-100" />
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="h-24 rounded-xl bg-slate-100" />
        <div className="h-24 rounded-xl bg-slate-100" />
        <div className="h-24 rounded-xl bg-slate-100" />
      </div>
      <div className="h-64 rounded-xl bg-slate-100" />
    </div>
  );
}
