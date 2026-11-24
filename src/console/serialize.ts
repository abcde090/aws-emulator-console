/**
 * Turns SDK responses into plain JSON values that can cross the server/client boundary,
 * and turns errors into the text the console shows.
 */

const MAX_DEPTH = 40;

export function toPlain(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[nested too deeply]";
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (value instanceof Uint8Array) return `(${value.byteLength} bytes of binary data)`;
  if (value instanceof Map) return toPlain(Object.fromEntries(value), depth + 1);
  if (value instanceof Set) return toPlain([...value], depth + 1);
  if (Array.isArray(value)) return value.map((v) => toPlain(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "$metadata" || v === undefined || typeof v === "function") continue;
      out[k] = toPlain(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** "QueueDoesNotExist: The specified queue does not exist." — the AWS error name and text. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AccessDeniedError" || err.message.startsWith("AccessDenied (simulated")) return err.message;
    const name = err.name && err.name !== "Error" ? err.name : "";
    const message = err.message || "(no message)";
    if (name && !message.startsWith(name)) return `${name}: ${message}`;
    return message;
  }
  if (typeof err === "string") return err;
  return "Unexpected error";
}
