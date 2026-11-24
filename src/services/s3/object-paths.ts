/** Pure helpers for the S3 object browser: prefixes shown as folders. */

export interface Crumb {
  label: string;
  prefix: string;
}

/** "a/b/" -> [{a, "a/"}, {b, "a/b/"}]. */
export function prefixCrumbs(prefix: string): Crumb[] {
  const parts = prefix.split("/").filter((p) => p !== "");
  return parts.map((label, i) => ({ label, prefix: `${parts.slice(0, i + 1).join("/")}/` }));
}

/** The name shown for a key or prefix inside the current folder. */
export function displayName(keyOrPrefix: string, currentPrefix: string): string {
  return keyOrPrefix.startsWith(currentPrefix) ? keyOrPrefix.slice(currentPrefix.length) : keyOrPrefix;
}

/** A prefix the browser may open: "" or ending with "/". */
export function normalisePrefix(prefix: unknown): string {
  if (typeof prefix !== "string" || prefix === "") return "";
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

export type NameCheck = { ok: true; name: string } | { ok: false; error: string };

/** Folder names, as in the S3 console: no "/" inside, not empty, at most 1024 bytes with the prefix. */
export function checkFolderName(name: unknown, prefix: string): NameCheck {
  if (typeof name !== "string") return { ok: false, error: "Enter a folder name." };
  const trimmed = name.trim().replace(/\/+$/, "");
  if (trimmed === "") return { ok: false, error: "Enter a folder name." };
  if (trimmed.includes("/")) return { ok: false, error: "Folder names can't contain \"/\"." };
  if (trimmed === "." || trimmed === "..") return { ok: false, error: "Folder names can't be \".\" or \"..\"." };
  if (new TextEncoder().encode(`${prefix}${trimmed}/`).length > 1024) return { ok: false, error: "The full key must be at most 1024 bytes." };
  return { ok: true, name: trimmed };
}

/** Object key for an uploaded file in the current folder. */
export function uploadKey(prefix: string, fileName: string): string | null {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  if (base === "" || base === "." || base === "..") return null;
  const key = `${prefix}${base}`;
  return new TextEncoder().encode(key).length <= 1024 ? key : null;
}

/** A bucket name as S3 accepts it (also guards the download route's input). */
export function isBucketName(v: unknown): v is string {
  return typeof v === "string" && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(v);
}

/** Content-Disposition for a download, safe for any key. */
export function attachmentHeader(key: string): string {
  const base = key.split("/").filter((p) => p !== "").pop() ?? "download";
  const ascii = base.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
}

/** Storage classes the object page offers (the S3 console's list). */
export const STORAGE_CLASSES = ["STANDARD", "INTELLIGENT_TIERING", "STANDARD_IA", "ONEZONE_IA", "GLACIER_IR", "GLACIER", "DEEP_ARCHIVE", "REDUCED_REDUNDANCY"] as const;

/** "s3://bucket/key" for an object. */
export function s3Uri(bucket: string, key: string): string {
  return `s3://${bucket}/${key}`;
}

/**
 * Parses a copy destination. "s3://b/folder/" (or "s3://b") keeps the source object's
 * file name; "s3://b/name" is the full new key. Null when it is not a usable S3 URI.
 */
export function parseS3Uri(uri: unknown, sourceKey: string): { bucket: string; key: string } | null {
  if (typeof uri !== "string") return null;
  const m = /^s3:\/\/([^/]+)(?:\/(.*))?$/.exec(uri.trim());
  if (!m || !isBucketName(m[1])) return null;
  const rest = m[2] ?? "";
  const base = sourceKey.split("/").filter((p) => p !== "").pop() ?? "";
  const key = rest === "" || rest.endsWith("/") ? `${rest}${base}` : rest;
  if (key === "" || new TextEncoder().encode(key).length > 1024) return null;
  return { bucket: m[1], key };
}

/** Link to the object page. */
export function objectHref(bucket: string, key: string, versionId?: string | null): string {
  const v = versionId ? `&versionId=${encodeURIComponent(versionId)}` : "";
  return `/s3/buckets/${encodeURIComponent(bucket)}/object?key=${encodeURIComponent(key)}${v}`;
}
