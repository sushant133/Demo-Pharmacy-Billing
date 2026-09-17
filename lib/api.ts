import { NextResponse } from "next/server";
import { ZodError, type TypeOf, type ZodTypeAny } from "zod";
import { FefoError } from "@/lib/fefo";

/**
 * Every API route returns the same envelope:
 *
 *   success -> { ok: true,  data: <payload>, meta?: <pagination etc> }
 *   failure -> { ok: false, error: { code, message, details? } }
 *
 * Clients can therefore branch on `ok` alone and never guess at shapes.
 */

export type ApiErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INSUFFICIENT_STOCK"
  | "INTERNAL_ERROR";

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_ERROR: 422,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INSUFFICIENT_STOCK: 409,
  INTERNAL_ERROR: 500,
};

export interface ApiMeta {
  page?: number;
  pageSize?: number;
  total?: number;
  totalPages?: number;
  [key: string]: unknown;
}

export type ApiSuccess<T> = { ok: true; data: T; meta?: ApiMeta };
export type ApiFailure = {
  ok: false;
  error: { code: ApiErrorCode; message: string; details?: unknown };
};
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/** Thrown anywhere inside a handler; converted to a response by withRoute. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError("BAD_REQUEST", message, details);
  }
  static unauthorized(message = "You must be signed in to do that.") {
    return new ApiError("UNAUTHORIZED", message);
  }
  static forbidden(message = "You do not have permission to do that.") {
    return new ApiError("FORBIDDEN", message);
  }
  static notFound(message = "Not found.") {
    return new ApiError("NOT_FOUND", message);
  }
  static conflict(message: string, details?: unknown) {
    return new ApiError("CONFLICT", message, details);
  }
  static insufficientStock(message: string, details?: unknown) {
    return new ApiError("INSUFFICIENT_STOCK", message, details);
  }
}

export function ok<T>(data: T, meta?: ApiMeta, status = 200) {
  const body: ApiSuccess<T> = meta ? { ok: true, data, meta } : { ok: true, data };
  return NextResponse.json(body, { status });
}

export function created<T>(data: T) {
  return ok(data, undefined, 201);
}

export function fail(code: ApiErrorCode, message: string, details?: unknown) {
  const body: ApiFailure = { ok: false, error: { code, message, details } };
  return NextResponse.json(body, { status: STATUS_BY_CODE[code] });
}

/** Mongo duplicate-key errors carry code 11000 and the offending key. */
function isDuplicateKeyError(
  err: unknown,
): err is { code: number; keyValue?: Record<string, unknown> } {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === 11000
  );
}

/**
 * Which field a duplicate-key error is actually about.
 *
 * Every unique index in this system is scoped - `{pharmacyId, barcode}`,
 * `{pharmacyId, billNo}` - and Mongo reports the keys in index order, so the
 * first one is the tenant, not the thing the user typed. Taking it naively
 * produced "That pharmacyId is already in use", which names an internal
 * column and tells nobody which box to change.
 *
 * So the scoping keys are skipped, and what is left is said in the words the
 * form uses.
 */
const SCOPE_KEYS = new Set(["pharmacyId", "branchId", "_id"]);

const FIELD_LABELS: Record<string, string> = {
  sku: "medicine code",
  barcode: "barcode",
  billNo: "bill number",
  grnNo: "GRN number",
  email: "email address",
  panNo: "PAN",
  phone: "phone number",
  code: "code",
  name: "name",
};

function duplicateField(keyValue?: Record<string, unknown>): string {
  const key =
    Object.keys(keyValue ?? {}).find((name) => !SCOPE_KEYS.has(name)) ?? "value";
  return FIELD_LABELS[key] ?? key;
}

function isMongooseValidationError(
  err: unknown,
): err is { name: string; errors: Record<string, { message: string }> } {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "ValidationError"
  );
}

function isCastError(err: unknown): err is { name: string; path: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "CastError"
  );
}

/** Turn any thrown value into the standard failure envelope. */
export function toErrorResponse(err: unknown) {
  if (err instanceof ApiError) {
    return fail(err.code, err.message, err.details);
  }

  if (err instanceof ZodError) {
    return fail("VALIDATION_ERROR", "Some fields need attention.", fieldErrors(err));
  }

  if (err instanceof FefoError) {
    return fail("BAD_REQUEST", err.message);
  }

  if (isDuplicateKeyError(err)) {
    return fail("CONFLICT", `That ${duplicateField(err.keyValue)} is already in use.`);
  }

  if (isMongooseValidationError(err)) {
    const details: Record<string, string[]> = {};
    for (const [path, detail] of Object.entries(err.errors)) {
      details[path] = [detail.message];
    }
    return fail("VALIDATION_ERROR", "Some fields need attention.", details);
  }

  if (isCastError(err)) {
    return fail("BAD_REQUEST", `Invalid value for "${err.path}".`);
  }

  // Anything unrecognised is a bug: log the detail server-side, return a
  // generic message so internals never leak to the client.
  console.error("[api] unhandled error", err);
  return fail("INTERNAL_ERROR", "Something went wrong. Please try again.");
}

/** Flatten a ZodError into { fieldPath: [messages] } for form display. */
export function fieldErrors(error: ZodError): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_form";
    (result[key] ??= []).push(issue.message);
  }
  return result;
}

/**
 * Wrap a route handler so every thrown error becomes a consistent response.
 * Generic over the context argument so dynamic routes keep their typed params.
 */
export function withRoute<Ctx>(
  handler: (req: Request, ctx: Ctx) => Promise<Response>,
): (req: Request, ctx: Ctx) => Promise<Response> {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      return toErrorResponse(err);
    }
  };
}

/**
 * Parse and validate a JSON request body, throwing a typed error on failure.
 *
 * The generic is the schema itself, not its output type: schemas that use
 * `.default()` or `.transform()` have different input and output types, and
 * pinning both to one parameter would widen every defaulted field back to
 * `T | undefined` at the call site.
 */
export async function parseJson<S extends ZodTypeAny>(
  req: Request,
  schema: S,
): Promise<TypeOf<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw ApiError.badRequest("Request body must be valid JSON.");
  }
  return schema.parse(raw) as TypeOf<S>;
}

/** Parse and validate URL search params against a schema. */
export function parseQuery<S extends ZodTypeAny>(req: Request, schema: S): TypeOf<S> {
  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  return schema.parse(params) as TypeOf<S>;
}
