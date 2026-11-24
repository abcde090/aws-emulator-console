/**
 * Client-side wrapper for server-action calls. The server never throws for service errors,
 * but the call itself can fail (dev server restarted, a rejected action after a rebuild,
 * a body over the size limit). Those become an ordinary `{ ok: false }` so the control
 * re-enables and the error banner shows instead of hanging on "Working…" (CQ-2).
 */

import type { Result } from "./types.ts";

export const TRANSPORT_ERROR = "The console could not reach its server. Reload the page and try again.";

export async function callServer<T>(call: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    const r = await call();
    // A malformed reply is treated like a failed call, never as success.
    if (!r || typeof r !== "object" || typeof (r as { ok?: unknown }).ok !== "boolean") return { ok: false, error: TRANSPORT_ERROR };
    return r;
  } catch (err: unknown) {
    const detail = err instanceof Error && err.message ? ` (${err.message})` : "";
    return { ok: false, error: `${TRANSPORT_ERROR}${detail}` };
  }
}
