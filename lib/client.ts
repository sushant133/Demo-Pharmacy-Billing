import type { ApiFailure, ApiMeta, ApiResponse } from "@/lib/api";

/**
 * Browser-side fetch wrapper that understands the API envelope.
 *
 * Returns a discriminated result instead of throwing, so components handle
 * "insufficient stock" the same way they handle any other outcome - as a
 * message to show, not an exception to catch.
 */

export type ClientResult<T> =
  | { ok: true; data: T; meta?: ApiMeta }
  | { ok: false; message: string; code: string; details?: unknown };

function networkFailure(): ClientResult<never> {
  return {
    ok: false,
    code: "NETWORK_ERROR",
    message: "Could not reach the server. Check your connection and try again.",
  };
}

export async function apiFetch<T>(
  input: string,
  init?: RequestInit & { json?: unknown },
): Promise<ClientResult<T>> {
  const { json, ...rest } = init ?? {};

  try {
    const response = await fetch(input, {
      ...rest,
      headers: {
        ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
        ...rest.headers,
      },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });

    // A proxy or an auth redirect can return HTML; treat that as a failure
    // rather than letting response.json() throw a parse error at the caller.
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      if (response.status === 401) {
        return {
          ok: false,
          code: "UNAUTHORIZED",
          message: "Your session has expired. Please sign in again.",
        };
      }
      return {
        ok: false,
        code: "INTERNAL_ERROR",
        message: `Unexpected response from the server (${response.status}).`,
      };
    }

    const body = (await response.json()) as ApiResponse<T>;

    if (!body.ok) {
      const failure = body as ApiFailure;
      return {
        ok: false,
        code: failure.error.code,
        message: failure.error.message,
        details: failure.error.details,
      };
    }

    return { ok: true, data: body.data, meta: body.meta };
  } catch {
    return networkFailure();
  }
}

/** Build a query string, dropping empty values. */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}
