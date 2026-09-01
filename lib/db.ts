import mongoose from "mongoose";
import { config } from "@/lib/config";

/**
 * Cached Mongoose connection.
 *
 * Next.js dev mode re-evaluates modules on every hot reload; without this
 * cache each reload would open a brand new pool and eventually exhaust the
 * server's connection limit. The cache lives on globalThis, which survives
 * module re-evaluation.
 *
 * The same cache has to survive something harsher once deployed serverless.
 * There the process is frozen between invocations and thawed later with its
 * globals intact but its sockets long dead, and a burst of traffic is served
 * by many such containers at once, each opening its own pool to Atlas. So
 * reusing a pool means proving it is actually alive, and opening one means
 * tolerating an attempt that loses the race.
 */

type MongooseCache = {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
  /** The last connect failure, and when it happened. See COOLDOWN_MS. */
  lastError?: { at: number; error: unknown };
};

const globalForMongoose = globalThis as typeof globalThis & {
  __mongooseCache?: MongooseCache;
  __mongoTxSupport?: boolean;
};

const cache: MongooseCache = (globalForMongoose.__mongooseCache ??= {
  conn: null,
  promise: null,
});

/**
 * How long a failed connection is taken at its word before we try again.
 *
 * One page view is not one connection attempt. A render that throws is
 * followed by the error path re-rendering the same layout, so without this a
 * single click against a cluster that is down pays the full connect budget
 * twice over and the person waits nearly a minute to be told something they
 * could have been told in ten seconds. Short enough that a cluster coming
 * back up is picked up on the next click.
 */
const COOLDOWN_MS = 3_000;

/**
 * Attempts at opening a pool before giving up, including the first.
 *
 * Two, not more. These multiply against the server-selection timeout, and the
 * budget has to fit inside the hosting platform's function limit - a page that
 * takes a minute to report a failure is worse than one that fails in ten
 * seconds, because by then the person at the counter has already clicked
 * again. A cluster that will answer at all answers on the first or second try.
 */
const CONNECT_ATTEMPTS = 2;

/**
 * Kept well under the platform's function timeout so a lost attempt still
 * leaves room to retry, rather than burning the whole request budget on one
 * server selection that was never going to succeed. Worst case here is two
 * attempts plus the backoff between them: a little over twelve seconds.
 */
const SERVER_SELECTION_TIMEOUT_MS = 6_000;

const CONNECT_OPTIONS = {
  dbName: config.mongoDb,
  /**
   * Buffering ON, deliberately.
   *
   * With it off, a query that reaches Mongoose a moment before the pool is
   * live throws instantly - MongoNotConnectedError - and inside a server
   * component that is an unhandled render error, not a retry. A thawed
   * container hits that window on essentially every request. Left on, the
   * same query waits for the pool that is already being opened, which is
   * what the caller meant.
   */
  bufferCommands: true,
  /** Bounded, so a genuinely dead cluster still fails rather than hanging. */
  bufferTimeoutMS: 10_000,
  /**
   * Small pools, many containers. A serverless burst opens one pool per
   * container, so a large maxPoolSize multiplies into a connection storm
   * against the cluster's limit; minPoolSize 0 lets an idle container hold
   * nothing open.
   */
  maxPoolSize: 5,
  minPoolSize: 0,
  maxIdleTimeMS: 60_000,
  serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
  // Schemas already declare indexes. Building them on every process
  // start makes the first click after boot take seconds.
  autoIndex: false,
} as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Transient in the "try it again and it will probably work" sense: a socket
 * that timed out, a primary mid-election, a pool cleared underneath us. A bad
 * password or an unknown database is none of those and must surface at once.
 */
export function isTransientDbError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name ?? "";
  if (
    name === "MongoNetworkError" ||
    name === "MongoNetworkTimeoutError" ||
    name === "MongoServerSelectionError" ||
    name === "MongoNotConnectedError" ||
    name === "PoolClearedError" ||
    name === "MongoPoolClearedError" ||
    name === "MongoTopologyClosedError"
  ) {
    return true;
  }

  const message = (err as { message?: string } | null)?.message ?? "";
  return (
    /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN/i.test(message) ||
    /connection .* closed|pool was cleared|topology was destroyed/i.test(message) ||
    /buffering timed out|operation buffering timed out/i.test(message)
  );
}

/**
 * Failures that happen before a write can have reached the server.
 * Safe to reconnect and try the write once. A dropped socket mid-write is
 * not on this list - that write may already have been applied.
 */
function isSafeToRetryWrite(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name ?? "";
  return (
    name === "MongoNotConnectedError" ||
    name === "MongoServerSelectionError" ||
    name === "MongoTopologyClosedError" ||
    name === "MongoNetworkTimeoutError" ||
    name === "PoolClearedError" ||
    name === "MongoPoolClearedError"
  );
}

async function openConnection(): Promise<typeof mongoose> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
    try {
      const conn = await mongoose.connect(config.mongoUri, CONNECT_OPTIONS);
      console.info(`[mongo] connected to ${conn.connection.name}`);
      return conn;
    } catch (err) {
      lastError = err;
      if (attempt === CONNECT_ATTEMPTS || !isTransientDbError(err)) break;

      // Short, growing backoff. A cold burst is many containers racing for the
      // same cluster, and staggering the retries is most of what resolves it.
      const backoff = 150 * 2 ** (attempt - 1);
      console.warn(
        `[mongo] connect attempt ${attempt}/${CONNECT_ATTEMPTS} failed, retrying in ${backoff}ms:`,
        (err as { message?: string })?.message ?? err,
      );
      await sleep(backoff);
    }
  }

  throw lastError;
}

/** True when the cached pool is both open and pointed at the right database. */
function isReusable(conn: typeof mongoose): boolean {
  return conn.connection.readyState === 1 && conn.connection.name === config.mongoDb;
}

/** Tear the cached pool down so the next connectDB opens a fresh one. */
async function dropCachedConnection(): Promise<void> {
  if (cache.conn) {
    try {
      await cache.conn.disconnect();
    } catch {
      // The old socket is already gone; keep going and open a new pool.
    }
  }
  cache.conn = null;
  cache.promise = null;
}

export async function connectDB(): Promise<typeof mongoose> {
  // Drop a cached pool that landed in the wrong database (common after an
  // env change + Fast Refresh: globalThis survives, process.env does not get
  // a new process), or one whose sockets died while the container was frozen.
  // Without this, login looks in `test` and 401s.
  if (cache.conn) {
    if (isReusable(cache.conn)) return cache.conn;
    await dropCachedConnection();
  }

  if (cache.lastError && Date.now() - cache.lastError.at < COOLDOWN_MS) {
    throw cache.lastError.error;
  }

  if (!cache.promise) {
    mongoose.set("strictQuery", true);
    cache.promise = openConnection()
      .then((conn) => {
        cache.lastError = undefined;
        return conn;
      })
      .catch((err: unknown) => {
        // Clear the promise so the next request retries instead of reusing a
        // permanently rejected promise.
        cache.promise = null;
        cache.lastError = { at: Date.now(), error: err };
        throw err;
      });
  }

  cache.conn = await cache.promise;
  return cache.conn;
}

/**
 * Run reads against the database, reconnecting once if the pool turns out to
 * be dead.
 *
 * `connectDB` can only report that the pool *looked* healthy when the request
 * started; a container thawed mid-flight discovers otherwise on its first
 * query. Retrying once, after tearing the stale pool down, turns what would
 * have been a 500 on an otherwise fine page into a few hundred milliseconds.
 *
 * Reads only. A write that may already have been applied must never be
 * replayed blindly, so write paths keep failing loudly.
 */
export async function withDbRead<T>(fn: () => Promise<T>): Promise<T> {
  // A failure to connect at all is not a stale pool, it is a cluster that is
  // not answering, and `connectDB` has already spent its own retries proving
  // that. Reconnecting again below would only double the wait before the user
  // sees the same error, so that case is rethrown untouched.
  await connectDB();

  try {
    return await fn();
  } catch (err) {
    if (!isTransientDbError(err)) throw err;

    console.warn(
      "[mongo] transient read failure, reconnecting and retrying once:",
      (err as { message?: string })?.message ?? err,
    );

    // We did have a live pool a moment ago, so this is the recoverable case:
    // sockets that died under a frozen container. A fresh pool fixes it.
    await dropCachedConnection();
    await connectDB();
    return fn();
  }
}

/**
 * Run a write after proving the pool is up.
 *
 * Retries only when the failure happened before a write could have reached
 * the server. A write that may already have been applied is never replayed.
 */
export async function withDbWrite<T>(fn: () => Promise<T>): Promise<T> {
  await connectDB();

  try {
    return await fn();
  } catch (err) {
    if (!isSafeToRetryWrite(err)) throw err;

    console.warn(
      "[mongo] connection failed before write, reconnecting and retrying once:",
      (err as { message?: string })?.message ?? err,
    );

    await dropCachedConnection();
    await connectDB();
    return fn();
  }
}

/**
 * True when the connected deployment supports multi-document transactions
 * (replica set or sharded cluster). A standalone mongod does not.
 *
 * Probed once with the `hello` command and cached, because a standalone
 * server only rejects the transaction at commit time - too late to fall back
 * cleanly.
 */
export async function supportsTransactions(): Promise<boolean> {
  if (globalForMongoose.__mongoTxSupport !== undefined) {
    return globalForMongoose.__mongoTxSupport;
  }

  const conn = await connectDB();
  const db = conn.connection.db;
  if (!db) return false;

  try {
    const hello = await db.admin().command({ hello: 1 });
    // `setName` => replica set member. `isdbgrid` => mongos (sharded cluster).
    const supported = Boolean(hello.setName) || hello.msg === "isdbgrid";
    globalForMongoose.__mongoTxSupport = supported;
    return supported;
  } catch {
    return false;
  }
}
