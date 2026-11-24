/**
 * Optional secondary lookups for list() and get() (C12). In the real console a user who may
 * call the primary API (DescribeInstances, GetFunction) still sees the resource when a
 * secondary call (DescribeInstanceStatus, ListVersionsByFunction) is denied or fails: only
 * that cell or tab shows the problem. Wrap every secondary call in `secondary()` so one
 * denial never empties the whole page. The primary call stays unwrapped: its error is the page's.
 *
 *   const [status, versions] = await Promise.all([secondary(ec2.send(...)), secondary(lambda.send(...))]);
 *   row.statusCheck = valueOr(status, (s) => s.InstanceStatuses?.[0]?.InstanceStatus?.Status, UNAVAILABLE);
 *   tabs.push(unavailableTab("versions", "Versions", versions) ?? { id: "versions", … data: versions.value … });
 */

import { errorMessage } from "./serialize.ts";
import type { DetailTab } from "./types.ts";

export type Secondary<T> = { ok: true; value: T } | { ok: false; error: string; denied: boolean };

/** Cell text for a value that could not be loaded. */
export const UNAVAILABLE = "Not available";

/** Never throws: the call's value, or its error text (AccessDenied text kept verbatim). */
export async function secondary<T>(call: Promise<T> | (() => Promise<T>)): Promise<Secondary<T>> {
  try {
    return { ok: true, value: await (typeof call === "function" ? call() : call) };
  } catch (err: unknown) {
    const error = errorMessage(err);
    return { ok: false, error, denied: /AccessDenied|not authorized/i.test(error) };
  }
}

/** `pick(value)` when the lookup worked, else `fallback` (e.g. UNAVAILABLE for a cell). */
export function valueOr<T, R>(s: Secondary<T>, pick: (value: T) => R, fallback: R): R {
  return s.ok ? pick(s.value) : fallback;
}

/** A text tab that shows why its data could not be loaded, or null when the lookup worked. */
export function unavailableTab<T>(id: string, label: string, s: Secondary<T>): DetailTab | null {
  if (s.ok) return null;
  return { id, label, kind: "text", data: s.error, description: s.denied ? "You don't have permission to view this." : "This information could not be loaded." };
}

/**
 * Text for a table tab's emptyText (or a description) when its lookup may have failed:
 * `whenOk` when it worked, else "Unavailable: <error>" so the reason shows in that tab only.
 */
export function unavailableText(s: Secondary<unknown> | WithFallback<unknown>, whenOk: string): string;
export function unavailableText(s: Secondary<unknown> | WithFallback<unknown>): string | undefined;
export function unavailableText(s: Secondary<unknown> | WithFallback<unknown>, whenOk?: string): string | undefined {
  const error = "ok" in s ? (s.ok ? null : s.error) : s.error;
  return error === null ? whenOk : `Unavailable: ${error}`;
}

/** A secondary lookup's value, or `fallback` when it failed, plus the error (null when it worked). */
export type WithFallback<T> = { value: T; error: string | null };

/** Like `secondary()`, for callers that always want a value to render (e.g. an empty list) next to the error. */
export async function secondaryOr<T>(call: Promise<T> | (() => Promise<T>), fallback: T): Promise<WithFallback<T>> {
  const s = await secondary(call);
  return s.ok ? { value: s.value, error: null } : { value: fallback, error: s.error };
}

export type Optional<T> = { kind: "value"; value: T } | { kind: "missing" } | { kind: "error"; error: string };

/**
 * A secondary read whose "not set" answer is an error (e.g. PolicyNotFound, ResourceNotFound):
 * those error names (or S3 `Code`s) give `missing`; any other failure gives its text. Never throws.
 */
export async function optionalRead<T>(fn: () => Promise<T>, missingErrors: readonly string[] = []): Promise<Optional<T>> {
  try {
    return { kind: "value", value: await fn() };
  } catch (err: unknown) {
    const name = err instanceof Error ? err.name : "";
    const code = (err as { Code?: unknown } | null)?.Code;
    if (missingErrors.includes(name) || (typeof code === "string" && missingErrors.includes(code))) return { kind: "missing" };
    return { kind: "error", error: errorMessage(err) };
  }
}
