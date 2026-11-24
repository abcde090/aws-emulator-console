/** Pure helpers for FIS experiment template forms. */

export function actionParameters(text: string): Record<string, string> | undefined {
  if (text.trim() === "") return undefined;
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error('Action parameters must be a JSON object, e.g. {"duration": "PT5M"}.');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    else throw new Error(`Action parameter ${k} must be a string.`);
  }
  return Object.keys(out).length ? out : undefined;
}

/** "ALL", "COUNT(2)", "PERCENT(25)" (case-insensitive) -> canonical form. */
export function selectionMode(text: string): string {
  const t = text.trim().toUpperCase();
  if (t === "" || t === "ALL") return "ALL";
  const m = /^(COUNT|PERCENT)\((\d{1,5})\)$/.exec(t);
  if (!m) throw new Error("Selection mode is ALL, COUNT(n) or PERCENT(n).");
  if (m[1] === "PERCENT" && Number(m[2]) > 100) throw new Error("PERCENT is at most 100.");
  return `${m[1]}(${Number(m[2])})`;
}

/** Target by tags ("k=v, k2=v2") or by ARNs (one per line). */
export function targetSpec(method: string, tags: string, arns: string): { resourceTags?: Record<string, string>; resourceArns?: string[] } {
  if (method === "arns") {
    const list = arns.split(/\s+/).map((a) => a.trim()).filter(Boolean);
    if (list.length === 0) throw new Error("Give at least one resource ARN.");
    if (list.some((a) => !a.startsWith("arn:"))) throw new Error("Each resource ARN starts with arn:.");
    return { resourceArns: list };
  }
  const pairs = tags.split(",").map((p) => p.trim()).filter(Boolean);
  if (pairs.length === 0) throw new Error("Give at least one resource tag as Key=Value.");
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i <= 0) throw new Error(`"${p}" is not Key=Value.`);
    out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  return { resourceTags: out };
}
