/**
 * Every server render or route error, logged with its digest and the time.
 * The error screen shows the same digest in its reference, so a reference
 * read out by staff finds this line (and its stack) in the server log.
 */
export async function onRequestError(
  err: unknown,
  request: { path: string; method: string },
  context: { routePath?: string; routeType?: string },
) {
  const digest = (err as { digest?: string } | null)?.digest ?? "";
  console.error(
    `[request error] digest=${digest} at=${new Date().toISOString()} ${request.method} ${request.path} route=${context.routePath ?? ""}`,
    err,
  );
}

/**
 * Runs once when the server process starts.
 *
 * Starts the CBMS retry runner (see instrumentation-node.ts). Written as the
 * conditional import Next documents, so the Edge bundle - which has no
 * database and no node:crypto - drops the branch entirely.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
