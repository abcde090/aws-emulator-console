/**
 * IAM returns policy documents URL-encoded (RFC 3986), as the AWS docs say. Some tools hand
 * them back already decoded, so both forms are accepted.
 */

import type { PolicyDocument } from "./permissions.ts";

export type ParsedPolicy = { ok: true; document: PolicyDocument } | { ok: false; error: string };

export function parsePolicyDocument(raw: string | undefined): ParsedPolicy {
  if (raw === undefined || raw.trim() === "") return { ok: false, error: "the policy document is empty" };
  const candidates = [raw];
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) candidates.push(decoded);
  } catch {
    // Not URL-encoded; the raw form is the only candidate.
  }
  for (const text of candidates) {
    try {
      const value: unknown = JSON.parse(text);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const doc = value as PolicyDocument;
        const st = doc.Statement;
        if (st !== undefined && (typeof st !== "object" || st === null)) return { ok: false, error: "Statement is not an object or a list" };
        return { ok: true, document: doc };
      }
    } catch {
      // Try the next form.
    }
  }
  return { ok: false, error: "the policy document is not valid JSON" };
}
