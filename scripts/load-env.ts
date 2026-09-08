import { config } from "dotenv";
import { resolve } from "node:path";

/**
 * Load the same env files Next.js does, so seed/backfill/migrate hit the
 * database the running app uses.
 *
 * `.env` first, then `.env.local` which wins. Missing files are ignored.
 * This import must stay above anything that reads `lib/config`.
 */
config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), ".env.local"), override: true });
