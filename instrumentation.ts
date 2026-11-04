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
