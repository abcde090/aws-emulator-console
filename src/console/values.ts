/**
 * Small, pure helpers for form values and API text that many service definitions need:
 * trimmed text, numbers and lists from FieldValues, two-part ids, JSON text, S3 URIs.
 * No SDK and no React, so unit tests import them directly. Service-specific helpers stay
 * in the service's folder; tag helpers are in ./tags.ts.
 */

import type { FieldValue } from "./types.ts";

/** Separator for ids made of two parts (e.g. "<database>~<table>"). None of the parts can contain it. */
export const ID_SEP = "~";

export function joinId(...parts: string[]): string {
  return parts.join(ID_SEP);
}

/** Splits a two-part id; throws a readable error when the id is not one. */
export function splitId(id: string, what: string): [string, string] {
  const i = id.indexOf(ID_SEP);
  if (i <= 0 || i === id.length - 1) throw new Error(`"${id}" is not a valid ${what} id.`);
  return [id.slice(0, i), id.slice(i + 1)];
}

export function str(v: unknown): string | null {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
}

/** A non-empty trimmed string from a form value, or undefined. */
export function text(v: FieldValue | undefined): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

export function numberOr(v: FieldValue | undefined, fallback?: number): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function strList(v: FieldValue | undefined): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];
}

/** Parses JSON text the API returned; text that is not JSON is returned as is. */
export function parseJsonText(v: string | undefined | null): unknown {
  if (v === undefined || v === null || v.trim() === "") return null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** Parses a JSON form field that must hold an object. */
export function jsonObject(v: FieldValue | undefined, label: string): Record<string, unknown> | undefined {
  const t = text(v);
  if (t === undefined) return undefined;
  const parsed: unknown = JSON.parse(t);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object.`);
  return parsed as Record<string, unknown>;
}

/** A JSON object of string values, e.g. job arguments or restore metadata. */
export function stringMap(v: FieldValue | undefined, label: string): Record<string, string> | undefined {
  const o = jsonObject(v, label);
  if (!o) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(o)) {
    if (typeof val !== "string") throw new Error(`${label}: the value of "${k}" must be a string.`);
    out[k] = val;
  }
  return out;
}

/** Decodes record data (bytes) as UTF-8 text for display; binary data is shown as base64. */
export function bytesToText(data: Uint8Array | undefined): { text: string; base64: string } {
  if (!data) return { text: "", base64: "" };
  const base64 = Buffer.from(data).toString("base64");
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(data);
  // Control characters other than tab/newline mean it isn't readable text.
  const printable = !/[\u0000-\u0008\u000B\u000C\u000E-\u001F�]/.test(decoded);
  return { text: printable ? decoded : `(binary, ${data.byteLength} bytes)`, base64 };
}

/** "s3://bucket/prefix/" -> { bucket, key }; null when it isn't an S3 URI. */
export function parseS3Uri(uri: string): { bucket: string; key: string } | null {
  const m = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])(?:\/(.*))?$/.exec(uri.trim());
  return m ? { bucket: m[1], key: m[2] ?? "" } : null;
}

export const S3_URI_PATTERN = "s3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9](/.*)?";

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** JSON with object keys sorted, so two documents that differ only in key order or spacing compare equal. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/**
 * True when two JSON texts hold the same document (empty and missing count as the same).
 * Text that isn't JSON is compared as trimmed text.
 */
export function sameJson(a: string | undefined | null, b: string | undefined | null): boolean {
  const x = (a ?? "").trim();
  const y = (b ?? "").trim();
  if (x === "" || y === "") return x === y;
  try {
    return JSON.stringify(canonical(JSON.parse(x))) === JSON.stringify(canonical(JSON.parse(y)));
  } catch {
    return x === y;
  }
}

/** JSON text indented for an editor; text that isn't JSON is returned as is, missing as "". */
export function prettyJson(v: string | undefined | null): string {
  const t = (v ?? "").trim();
  if (t === "") return "";
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return t;
  }
}
