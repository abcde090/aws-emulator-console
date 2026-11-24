/**
 * Pure helpers for IAM-style JSON policy documents: decoding what IAM returns (URL-encoded),
 * pretty-printing, and the structural checks the console's policy editor runs before saving.
 * Shared by IAM, KMS (key policies) and Secrets Manager (resource policies).
 */

export type PolicyKind = "identity" | "trust" | "resource";

export type PolicyCheck = { ok: true; text: string } | { ok: false; errors: string[] };

const VERSIONS = ["2012-10-17", "2008-10-17"];
const MANAGED_POLICY_MAX = 6144;

/** IAM returns policy documents URL-encoded; other services return plain JSON. */
export function decodePolicy(raw: string | undefined | null): unknown {
  if (raw === undefined || raw === null || raw.trim() === "") return null;
  const candidates = [raw];
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) candidates.push(decoded);
  } catch {
    // Not URL-encoded.
  }
  for (const c of candidates) {
    try {
      return JSON.parse(c) as unknown;
    } catch {
      // try the next form
    }
  }
  return raw;
}

export function prettyPolicy(raw: string | undefined | null): string {
  const v = decodePolicy(raw);
  if (v === null) return "";
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v === undefined ? [] : [v];
}

function checkStatement(st: unknown, i: number, kind: PolicyKind): string[] {
  const where = `Statement ${i + 1}`;
  if (!st || typeof st !== "object" || Array.isArray(st)) return [`${where} must be a JSON object.`];
  const s = st as Record<string, unknown>;
  const errors: string[] = [];
  if (s.Effect !== "Allow" && s.Effect !== "Deny") errors.push(`${where}: Effect must be "Allow" or "Deny".`);
  const hasAction = s.Action !== undefined;
  const hasNotAction = s.NotAction !== undefined;
  if (hasAction === hasNotAction) errors.push(`${where}: use exactly one of Action or NotAction.`);
  for (const a of [...asList(s.Action), ...asList(s.NotAction)]) {
    if (typeof a !== "string" || (a !== "*" && !/^[a-zA-Z0-9-]+:[a-zA-Z0-9*?]+$/.test(a))) errors.push(`${where}: "${String(a)}" is not an action like service:Action.`);
  }
  const hasPrincipal = s.Principal !== undefined || s.NotPrincipal !== undefined;
  if (kind === "identity") {
    if (hasPrincipal) errors.push(`${where}: identity-based policies can't contain Principal or NotPrincipal.`);
    if (s.Resource === undefined && s.NotResource === undefined) errors.push(`${where}: add a Resource or NotResource element.`);
  } else if (!hasPrincipal) {
    errors.push(`${where}: ${kind === "trust" ? "trust" : "resource-based"} policies need a Principal or NotPrincipal element.`);
  }
  if (s.Resource !== undefined && s.NotResource !== undefined) errors.push(`${where}: use only one of Resource or NotResource.`);
  return errors;
}

/** The console's checks for a policy document, returning the compact JSON to send. */
export function checkPolicy(text: string, kind: PolicyKind, managed = false): PolicyCheck {
  if (text.trim() === "") return { ok: false, errors: ["The policy document is empty."] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e: unknown) {
    return { ok: false, errors: [`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, errors: ["The policy must be a JSON object."] };
  const doc = value as Record<string, unknown>;
  const errors: string[] = [];
  if (doc.Version !== undefined && !VERSIONS.includes(String(doc.Version))) errors.push(`Version must be "2012-10-17" (or the older "2008-10-17").`);
  if (doc.Version === undefined) errors.push(`Add "Version": "2012-10-17" so policy variables work as expected.`);
  const statements = asList(doc.Statement);
  if (statements.length === 0) errors.push("Add at least one statement in Statement.");
  statements.forEach((s, i) => errors.push(...checkStatement(s, i, kind)));
  const compact = JSON.stringify(doc);
  if (managed && compact.replace(/\s/g, "").length > MANAGED_POLICY_MAX) errors.push(`Managed policies are limited to ${MANAGED_POLICY_MAX} characters (without whitespace).`);
  return errors.length ? { ok: false, errors } : { ok: true, text: compact };
}

/** Throws the check's errors as one message (for definitions and server actions). */
export function requirePolicy(text: unknown, kind: PolicyKind, managed = false): string {
  const r = checkPolicy(typeof text === "string" ? text : "", kind, managed);
  if (!r.ok) throw new Error(`Policy validation failed: ${r.errors.join(" ")}`);
  return r.text;
}

export const EMPTY_IDENTITY_POLICY = JSON.stringify(
  { Version: "2012-10-17", Statement: [{ Sid: "Statement1", Effect: "Allow", Action: [], Resource: [] }] },
  null,
  2
);
