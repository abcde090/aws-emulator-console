/** Pure helpers for Systems Manager forms: document parameters and targets. */

/**
 * Parses document parameters typed as JSON: {"commands": ["echo hi"], "workingDirectory": "/tmp"}.
 * SSM wants every value as a list of strings, so single values are wrapped.
 */
export function parseDocParameters(text: string): Record<string, string[]> {
  if (text.trim() === "") return {};
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error('Parameters must be a JSON object, e.g. {"commands": ["echo hello"]}.');
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
    else if (typeof v === "string") out[k] = [v];
    else if (typeof v === "number" || typeof v === "boolean") out[k] = [String(v)];
    else throw new Error(`Parameter ${k} must be a string or a list of strings.`);
  }
  return out;
}

/** "Env=prod" or "Env=prod,staging" -> an SSM tag target. */
export function tagTarget(text: string): { Key: string; Values: string[] } {
  const m = /^\s*([^=]{1,128})=(.+)$/.exec(text);
  if (!m) throw new Error('Give the tag as Key=Value (several values separated by commas), e.g. "Env=prod".');
  const values = m[2].split(",").map((v) => v.trim()).filter(Boolean);
  if (values.length === 0) throw new Error("Give at least one tag value.");
  return { Key: `tag:${m[1].trim()}`, Values: values };
}

/** "10", "10%" are valid MaxConcurrency / MaxErrors values. */
export function isRateValue(v: string): boolean {
  return /^([1-9][0-9]*|[0]|[1-9][0-9]%|[0-9]%|100%)$/.test(v);
}

/** Last path segment of a patch baseline id/ARN ("arn:...:patchbaseline/pb-123" -> "pb-123"). */
export function shortBaselineId(id: string): string {
  return id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
}

/** Shows a parameter value: SecureString values stay hidden unless decrypted. */
export function maskValue(type: string | undefined, value: string | undefined, decrypted: boolean): string {
  if (value === undefined) return "-";
  if (type === "SecureString" && !decrypted) return "****";
  return value;
}
