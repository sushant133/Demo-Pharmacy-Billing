"use client";

import { ErrorScreen } from "@/components/ErrorScreen";

/**
 * Error boundary for the platform screens.
 *
 * The shop app has had one of these since it existed; the superadmin group
 * did not, so a dropped Mongo connection while listing pharmacies escaped all
 * the way to the root boundary and took the platform shell down with it. Here
 * the sidebar stays put and `reset()` re-runs just the failed segment, which
 * is the retry a transient database error actually needs.
 */
export default function PlatformError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorScreen error={error} reset={reset} />;
}
