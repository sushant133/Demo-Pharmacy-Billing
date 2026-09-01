"use client";

import { ErrorScreen } from "@/components/ErrorScreen";

/**
 * Last resort: a throw from the root layout itself, which replaces the whole
 * document. It has to render its own <html> and <body> because the root
 * layout that would normally provide them is the thing that failed, and it
 * cannot rely on the global stylesheet having been applied - hence the inline
 * font stack.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif" }}>
        <ErrorScreen
          error={error}
          reset={reset}
          title="The app didn't start"
          full
        />
      </body>
    </html>
  );
}
