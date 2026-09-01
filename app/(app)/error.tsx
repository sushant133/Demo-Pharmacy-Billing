"use client";

import { ErrorScreen } from "@/components/ErrorScreen";

/**
 * Error boundary for every authenticated screen.
 *
 * Sits inside the shell, so the sidebar and top bar stay put and the failure
 * is contained to the panel the user was looking at. `reset()` re-renders the
 * segment on the server, which is exactly the retry a dropped database
 * connection needs.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorScreen error={error} reset={reset} />;
}
