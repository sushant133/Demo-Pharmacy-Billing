import mongoose from "mongoose";
import { config } from "@/lib/config";

/**
 * Cached Mongoose connection.
 *
 * Next.js dev mode re-evaluates modules on every hot reload; without this
 * cache each reload would open a brand new pool and eventually exhaust the
 * server's connection limit. The cache lives on globalThis, which survives
 * module re-evaluation.
 */

type MongooseCache = {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
};

const globalForMongoose = globalThis as typeof globalThis & {
  __mongooseCache?: MongooseCache;
  __mongoTxSupport?: boolean;
};

const cache: MongooseCache = (globalForMongoose.__mongooseCache ??= {
  conn: null,
  promise: null,
});

export async function connectDB(): Promise<typeof mongoose> {
  if (cache.conn) return cache.conn;

  if (!cache.promise) {
    mongoose.set("strictQuery", true);
    cache.promise = mongoose
      .connect(config.mongoUri, {
        bufferCommands: false,
        maxPoolSize: 10,
        minPoolSize: 1,
        serverSelectionTimeoutMS: 5_000,
        // Schemas already declare indexes. Building them on every process
        // start makes the first click after boot take seconds.
        autoIndex: false,
      })
      .catch((err: unknown) => {
        // Clear the promise so the next request retries instead of reusing a
        // permanently rejected promise.
        cache.promise = null;
        throw err;
      });
  }

  cache.conn = await cache.promise;
  return cache.conn;
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
