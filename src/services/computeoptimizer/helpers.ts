/**
 * Pure mapping helpers for AWS Compute Optimizer responses. No AWS calls here, so the
 * unit tests can exercise them directly (tests/computeoptimizer.test.mjs).
 */

export interface Savings {
  savingsOpportunityPercentage?: number;
  estimatedMonthlySavings?: { currency?: string; value?: number };
}

export interface NameValue {
  name?: string;
  value?: number;
}

export interface Metric {
  name?: string;
  statistic?: string;
  value?: number;
}

/** "$140.16/month" as the console shows it; "-" when the API returned nothing. */
export function formatSavings(s: Savings | undefined | null): string | null {
  const v = s?.estimatedMonthlySavings?.value;
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const currency = s?.estimatedMonthlySavings?.currency ?? "USD";
  const amount = v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === "USD" ? `$${amount}/month` : `${amount} ${currency}/month`;
}

export function formatPercent(s: Savings | undefined | null): string | null {
  const p = s?.savingsOpportunityPercentage;
  return typeof p === "number" && Number.isFinite(p) ? `${p}%` : null;
}

/** "OVER_PROVISIONED" / "Overprovisioned" / "NotOptimized" -> "Over-provisioned", "Not optimized". */
export function findingLabel(v: unknown): string | null {
  if (typeof v !== "string" || v === "") return null;
  const key = v.replace(/[_\s-]/g, "").toLowerCase();
  const known: Record<string, string> = {
    overprovisioned: "Over-provisioned",
    underprovisioned: "Under-provisioned",
    optimized: "Optimized",
    notoptimized: "Not optimized",
    unavailable: "Unavailable",
    insufficientmetrics: "Insufficient metrics",
    idle: "Idle",
    unused: "Unused",
    unattached: "Unattached",
  };
  if (known[key]) return known[key];
  const words = v.includes("_") ? v.toLowerCase().split("_") : v.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(" ");
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "Over-provisioned: 1, Optimized: 2" from a summaries list. */
export function summarizeFindings(items: NameValue[] | undefined): string | null {
  const parts = (items ?? []).filter((i) => i.name).map((i) => `${findingLabel(i.name)}: ${typeof i.value === "number" ? i.value : 0}`);
  return parts.length ? parts.join(", ") : null;
}

/** Last path segment of an ARN ("...:instance/i-1" -> "i-1", "...:function:name" -> "name"). */
export function idFromArn(arn: unknown): string | null {
  if (typeof arn !== "string" || arn === "") return null;
  const slash = arn.lastIndexOf("/");
  if (slash >= 0) return arn.slice(slash + 1) || null;
  const parts = arn.split(":");
  return parts[parts.length - 1] || null;
}

/** Lambda ARNs here are "...:function:<name>"; the console shows "<name>:<version>". */
export function lambdaId(arn: unknown, version: unknown): string | null {
  if (typeof arn !== "string") return null;
  const m = arn.match(/:function:([^:]+)/);
  if (!m) return null;
  return typeof version === "string" && version !== "" ? `${m[1]}:${version}` : m[1];
}

export function metricText(metrics: Metric[] | undefined, name: string, statistic = "Maximum"): string | null {
  const m = (metrics ?? []).find((x) => x.name === name && (x.statistic ?? statistic) === statistic);
  return typeof m?.value === "number" ? String(m.value) : null;
}

export function metricRows(metrics: Metric[] | undefined): Record<string, unknown>[] {
  return (metrics ?? []).map((m) => ({ name: m.name ?? null, statistic: m.statistic ?? null, value: typeof m.value === "number" ? m.value : null }));
}

export function iso(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

export function joinList(v: unknown): string | null {
  return Array.isArray(v) && v.length ? v.map(String).join(", ") : null;
}

export function tagRows(tags: { key?: string; value?: string }[] | undefined): Record<string, unknown>[] {
  return (tags ?? []).map((t) => ({ key: t.key ?? "", value: t.value ?? "" }));
}

// ---- Recommendation preferences ----

export const PREFERENCE_NAMES = [
  "EnhancedInfrastructureMetrics",
  "InferredWorkloadTypes",
  "ExternalMetricsPreference",
  "LookBackPeriodPreference",
  "PreferredResources",
  "UtilizationPreferences",
] as const;
export type PreferenceName = (typeof PREFERENCE_NAMES)[number];

export interface PreferenceDetail {
  scope?: { name?: string; value?: string };
  resourceType?: string;
  enhancedInfrastructureMetrics?: string;
  inferredWorkloadTypes?: string;
  externalMetricsPreference?: { source?: string };
  lookBackPeriod?: string;
  utilizationPreferences?: { metricName?: string; metricParameters?: { threshold?: string; headroom?: string } }[];
  preferredResources?: { name?: string; includeList?: string[]; excludeList?: string[] }[];
  savingsEstimationMode?: string;
}

/** Preference ids are "<resourceType>|<scopeName>|<scopeValue>" (scope values may contain ":" and "/"). */
export function preferenceId(resourceType: string, scopeName: string, scopeValue: string): string {
  return `${resourceType}|${scopeName}|${scopeValue}`;
}

export function parsePreferenceId(id: string): { resourceType: string; scopeName: string; scopeValue: string } | null {
  const first = id.indexOf("|");
  const second = first < 0 ? -1 : id.indexOf("|", first + 1);
  if (first <= 0 || second <= first + 1 || second === id.length - 1) return null;
  return { resourceType: id.slice(0, first), scopeName: id.slice(first + 1, second), scopeValue: id.slice(second + 1) };
}

/** The preference names a DeleteRecommendationPreferences call needs to clear everything set. */
export function setPreferenceNames(p: PreferenceDetail): PreferenceName[] {
  const names: PreferenceName[] = [];
  if (p.enhancedInfrastructureMetrics) names.push("EnhancedInfrastructureMetrics");
  if (p.inferredWorkloadTypes) names.push("InferredWorkloadTypes");
  if (p.externalMetricsPreference?.source) names.push("ExternalMetricsPreference");
  if (p.lookBackPeriod) names.push("LookBackPeriodPreference");
  if (p.preferredResources?.length) names.push("PreferredResources");
  if (p.utilizationPreferences?.length) names.push("UtilizationPreferences");
  return names;
}

export const LOOKBACK_LABELS: Record<string, string> = { DAYS_14: "14 days", DAYS_32: "32 days", DAYS_93: "93 days" };

export function utilizationText(p: PreferenceDetail): string | null {
  const parts = (p.utilizationPreferences ?? []).map((u) => {
    const bits = [u.metricParameters?.threshold ? `threshold ${u.metricParameters.threshold}` : null, u.metricParameters?.headroom ? `headroom ${u.metricParameters.headroom}` : null].filter(Boolean);
    return `${u.metricName ?? "?"}${bits.length ? ` (${bits.join(", ")})` : ""}`;
  });
  return parts.length ? parts.join("; ") : null;
}

export function preferredText(p: PreferenceDetail): string | null {
  const parts = (p.preferredResources ?? []).map((r) => {
    const inc = r.includeList?.length ? `include ${r.includeList.join(", ")}` : null;
    const exc = r.excludeList?.length ? `exclude ${r.excludeList.join(", ")}` : null;
    return `${r.name ?? "?"}: ${[inc, exc].filter(Boolean).join("; ") || "-"}`;
  });
  return parts.length ? parts.join(" | ") : null;
}

export function preferenceRow(p: PreferenceDetail): Record<string, unknown> {
  const resourceType = p.resourceType ?? "";
  const scopeName = p.scope?.name ?? "";
  const scopeValue = p.scope?.value ?? "";
  return {
    id: preferenceId(resourceType, scopeName, scopeValue),
    resourceType,
    scope: scopeName === "Organization" ? "Organization (all accounts)" : scopeName === "AccountId" ? `Account ${scopeValue}` : `Resource ${scopeValue}`,
    enhancedInfrastructureMetrics: p.enhancedInfrastructureMetrics ?? null,
    inferredWorkloadTypes: p.inferredWorkloadTypes ?? null,
    lookBackPeriod: p.lookBackPeriod ? LOOKBACK_LABELS[p.lookBackPeriod] ?? p.lookBackPeriod : null,
    externalMetrics: p.externalMetricsPreference?.source ?? null,
    utilization: utilizationText(p),
    preferredResources: preferredText(p),
    savingsEstimationMode: p.savingsEstimationMode ?? null,
  };
}

/** Splits "m5.*, c5.large" into a clean list. */
export function splitList(v: unknown): string[] {
  if (typeof v !== "string") return [];
  return v
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Friendlier text for Compute Optimizer's opt-in error; other errors pass through unchanged. */
export function optInMessage(err: unknown): Error | null {
  const name = err instanceof Error ? err.name : "";
  if (name !== "OptInRequiredException") return null;
  return new Error(
    "OptInRequiredException: this account is not opted in to AWS Compute Optimizer. Open the Account page and choose Actions › Opt in to see recommendations."
  );
}
