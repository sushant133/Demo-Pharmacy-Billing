import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionUser } from "@/lib/session";

/**
 * Who is behind the request currently running.
 *
 * The audit log is written from Mongoose middleware, which sees a query and a
 * document but not the person who caused them. Rather than thread a user
 * through every write in the codebase, each API request runs inside one of
 * these and the auth guards fill in the actor once they have verified it.
 *
 * A mutable object on purpose: `requireSession` runs inside the handler, after
 * the context was opened, and a nested `run()` would not reach the code that
 * resumes after it returns.
 *
 * Node-only (async_hooks); never import this from middleware or the browser.
 */
export interface RequestContext {
  actor: SessionUser | null;
  method: string;
  path: string;
  ip: string;
  userAgent: string;
}

/*
  One store per process, not per module copy. Next compiles instrumentation
  and the route handlers into separate bundles, each with its own copy of this
  module, while Mongoose keeps a single process-wide model registry - so a
  model first compiled in the instrumentation bundle would otherwise read a
  store no request ever writes to, and every change through it would be
  logged as "System".
*/
const STORE_KEY = Symbol.for("mantrapharma.request-context");
const holder = globalThis as unknown as Record<symbol, AsyncLocalStorage<RequestContext> | undefined>;
const storage = (holder[STORE_KEY] ??= new AsyncLocalStorage<RequestContext>());

export function runWithRequestContext<T>(
  req: Request | null,
  work: () => Promise<T>,
): Promise<T> {
  let method = "";
  let path = "";
  let ip = "";
  let userAgent = "";
  if (req) {
    method = req.method;
    try {
      path = new URL(req.url).pathname;
    } catch {
      path = "";
    }
    const forwarded = req.headers.get("x-forwarded-for") ?? "";
    ip = forwarded.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "";
    userAgent = (req.headers.get("user-agent") ?? "").slice(0, 300);
  }
  return storage.run({ actor: null, method, path, ip, userAgent }, work);
}

export function currentRequestContext(): RequestContext | null {
  return storage.getStore() ?? null;
}

/** Record who this request is acting for. A no-op outside a request context. */
export function setRequestActor(user: SessionUser): void {
  const context = storage.getStore();
  if (context) context.actor = user;
}
