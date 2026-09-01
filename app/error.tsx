"use client";

import { ErrorScreen } from "@/components/ErrorScreen";

/**
 * Error boundary one level above the authenticated shell.
 *
 * A segment's own `error.tsx` cannot catch a throw from its `layout.tsx`, and
 * the app layout resolves the session and the branch switcher - both database
 * reads. Without this, that particular failure escapes to Next's bare error
 * page. Rendered without the shell, since the shell is what failed.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorScreen error={error} reset={reset} full />;
}
