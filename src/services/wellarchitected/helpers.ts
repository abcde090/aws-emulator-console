/** Pure helpers for the Well-Architected Tool screens (no AWS calls, unit-tested). */

export type RiskCounts = Partial<Record<string, number>>;

export const RISK_ORDER = ["HIGH", "MEDIUM", "NONE", "NOT_APPLICABLE", "UNANSWERED"] as const;

export const RISK_LABELS: Record<string, string> = {
  HIGH: "High risk",
  MEDIUM: "Medium risk",
  NONE: "No improvements identified",
  NOT_APPLICABLE: "Not applicable",
  UNANSWERED: "Unanswered",
};

export const NOT_APPLICABLE_REASONS: { value: string; label: string }[] = [
  { value: "OUT_OF_SCOPE", label: "Out of scope" },
  { value: "BUSINESS_PRIORITIES", label: "Business priorities" },
  { value: "ARCHITECTURE_CONSTRAINTS", label: "Architecture constraints" },
  { value: "OTHER", label: "Other" },
  { value: "NONE", label: "None" },
];

export const WORKLOAD_ID = /^[0-9a-f]{32}$/;
/** AWS lens aliases ("wellarchitected") or a lens ARN for custom and shared lenses. */
export const LENS_ALIAS = /^(?:[A-Za-z0-9_.-]{1,128}|arn:aws[a-z-]*:wellarchitected:[a-z0-9-]*:[0-9a-z]*:lens\/[A-Za-z0-9_.-]{1,128})$/;
export const QUESTION_ID = /^[A-Za-z0-9_.-]{1,128}$/;
export const PILLAR_ID = /^[A-Za-z0-9_.-]{1,64}$/;
export const MAX_NOTES = 2084;

export function riskCount(counts: unknown, key: string): number {
  if (!counts || typeof counts !== "object") return 0;
  const v = (counts as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function totalQuestions(counts: unknown): number {
  if (!counts || typeof counts !== "object") return 0;
  return Object.values(counts as Record<string, unknown>).reduce<number>((sum, v) => sum + (typeof v === "number" && Number.isFinite(v) ? v : 0), 0);
}

/** "12/57" — answered questions (everything but UNANSWERED) over all questions. */
export function answeredText(counts: unknown): string | null {
  const total = totalQuestions(counts);
  if (total === 0) return null;
  return `${total - riskCount(counts, "UNANSWERED")}/${total}`;
}

/** Splits "us-east-1, eu-west-1\nap-south-1" into trimmed, unique, non-empty items. */
export function splitList(v: unknown): string[] {
  if (Array.isArray(v)) return [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean))];
  if (typeof v !== "string") return [];
  return [...new Set(v.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean))];
}

export function environmentLabel(v: unknown): string | null {
  if (v === "PRODUCTION") return "Production";
  if (v === "PREPRODUCTION") return "Pre-production";
  return typeof v === "string" ? v : null;
}

export interface ChoiceLike {
  ChoiceId?: string;
  Title?: string;
}

/** The "None of these" choice can't be combined with others. */
export function isNoneChoice(c: ChoiceLike): boolean {
  return c.Title === "None of these" || (typeof c.ChoiceId === "string" && c.ChoiceId.endsWith("_no"));
}

/**
 * Checks a submitted selection against the question's real choices. Returns the
 * selection in the question's order, or an error to show.
 */
export function checkSelection(choices: ChoiceLike[], selected: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(selected) || !selected.every((s) => typeof s === "string")) return { ok: false, error: "Selected choices must be a list." };
  const wanted = new Set(selected as string[]);
  const known = choices.filter((c): c is ChoiceLike & { ChoiceId: string } => typeof c.ChoiceId === "string");
  for (const id of wanted) if (!known.some((c) => c.ChoiceId === id)) return { ok: false, error: `"${id}" is not a choice for this question.` };
  const picked = known.filter((c) => wanted.has(c.ChoiceId));
  if (picked.some(isNoneChoice) && picked.length > 1) return { ok: false, error: '"None of these" can\'t be selected together with other choices.' };
  return { ok: true, value: picked.map((c) => c.ChoiceId) };
}

/** Next selection after a checkbox click: "None of these" clears the others and vice versa. */
export function toggleChoice(choices: ChoiceLike[], selected: string[], id: string, on: boolean): string[] {
  if (!on) return selected.filter((s) => s !== id);
  const choice = choices.find((c) => c.ChoiceId === id);
  if (!choice) return selected;
  if (isNoneChoice(choice)) return [id];
  const noneIds = new Set(choices.filter(isNoneChoice).map((c) => c.ChoiceId));
  return [...selected.filter((s) => !noneIds.has(s)), id];
}

/** Tags as the Well-Architected API wants them: a plain map. */
export function tagMap(tags: unknown): Record<string, string> | undefined {
  if (!Array.isArray(tags) || tags.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const t of tags as { Key?: unknown; Value?: unknown }[]) if (t && typeof t.Key === "string" && t.Key !== "") out[t.Key] = typeof t.Value === "string" ? t.Value : "";
  return Object.keys(out).length ? out : undefined;
}

/** File name for a downloaded report: only safe characters. */
export function reportFileName(workloadName: string, lens: string, milestone: number | null): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "workload";
  return `${safe(workloadName)}-${safe(lens.split("/").pop() ?? lens)}${milestone ? `-milestone-${milestone}` : ""}.pdf`;
}

/** Parses ?milestone=; only positive integers up to 100 (the service's limit) are accepted. */
export function parseMilestone(v: string | null): number | null | "invalid" {
  if (v === null || v === "") return null;
  if (!/^\d{1,3}$/.test(v)) return "invalid";
  const n = Number(v);
  return n >= 1 && n <= 100 ? n : "invalid";
}

/**
 * A lens link (HelpfulResourceUrl, ImprovementPlanUrl) when it is an absolute http(s) URL,
 * else null. Lens JSON can be imported by anyone, so other schemes are never rendered.
 */
export function safeExternalUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}
