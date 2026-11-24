/**
 * Text for bucket settings that may simply not be set (read with `optionalRead` from
 * console/secondary.ts): S3 answers those reads with an error such as NoSuchBucketPolicy.
 */

import type { Optional } from "../../console/secondary.ts";

export function describeOptional<T>(o: Optional<T>, missingText: string): string {
  if (o.kind === "missing") return missingText;
  if (o.kind === "error") return `Could not read: ${o.error}`;
  return "Set";
}

/** Parses a JSON string returned by S3; text that is not JSON is returned as is. */
export function parseJsonText(text: string | undefined): unknown {
  if (text === undefined || text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
