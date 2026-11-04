import { timingSafeEqual } from "node:crypto";
import { ApiError, ok, withRoute } from "@/lib/api";
import { config } from "@/lib/config";
import { syncDueCbms } from "@/lib/cbms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/cbms/run - retry every pharmacy's due CBMS rows.
 *
 * For deployments where the in-process runner cannot be relied on (a
 * serverless host that freezes between requests). An external scheduler calls
 * this with `Authorization: Bearer <CBMS_CRON_SECRET>`; with no secret set the
 * route is closed.
 */
export const POST = withRoute(async (req) => {
  const secret = config.cbms.cronSecret;
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const match =
    secret.length > 0 &&
    given.length === secret.length &&
    timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!match) throw ApiError.unauthorized("Not allowed.");

  const attempted = await syncDueCbms({ limit: 200 });
  return ok({ attempted });
});
