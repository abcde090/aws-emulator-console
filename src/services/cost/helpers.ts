/** Pure helpers for Billing and Cost Management screens (budgets, Cost Explorer, categories). */

export interface Money {
  Amount?: string;
  Unit?: string;
}

/** "USD 12.50" style; budget amounts arrive as decimal strings. */
export function money(m: Money | undefined | null): string | null {
  if (!m || m.Amount === undefined) return null;
  const n = Number(m.Amount);
  const amount = Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : m.Amount;
  return m.Unit === "USD" ? `$${amount}` : `${amount}${m.Unit ? ` ${m.Unit}` : ""}`;
}

/** Actual as a percentage of the limit, e.g. "12.50%". Null when either is missing or the limit is 0. */
export function percentOf(actual: Money | undefined, limit: Money | undefined): string | null {
  const a = Number(actual?.Amount);
  const l = Number(limit?.Amount);
  if (actual?.Amount === undefined || limit?.Amount === undefined || !Number.isFinite(a) || !Number.isFinite(l) || l === 0) return null;
  return `${((a / l) * 100).toFixed(2)}%`;
}

/** Splits "a@x.com, b@y.com\n c" into trimmed, non-empty, de-duplicated entries. */
export function splitList(text: unknown): string[] {
  if (typeof text !== "string") return [];
  return [...new Set(text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function invalidEmails(list: readonly string[]): string[] {
  return list.filter((e) => !EMAIL.test(e));
}

export interface NotificationKey {
  NotificationType: string;
  ComparisonOperator: string;
  Threshold: number;
  ThresholdType: string;
}

/** A budget notification has no ID; the console addresses it by its four fields. */
export function encodeNotification(n: { NotificationType?: string; ComparisonOperator?: string; Threshold?: number; ThresholdType?: string }): string {
  return [n.NotificationType ?? "", n.ComparisonOperator ?? "", String(n.Threshold ?? ""), n.ThresholdType ?? "PERCENTAGE"].join("|");
}

export function decodeNotification(key: string): NotificationKey | null {
  const parts = key.split("|");
  if (parts.length !== 4) return null;
  const [type, op, threshold, thresholdType] = parts;
  const t = Number(threshold);
  if (!["ACTUAL", "FORECASTED"].includes(type)) return null;
  if (!["GREATER_THAN", "LESS_THAN", "EQUAL_TO"].includes(op)) return null;
  if (!["PERCENTAGE", "ABSOLUTE_VALUE"].includes(thresholdType)) return null;
  if (threshold === "" || !Number.isFinite(t)) return null;
  return { NotificationType: type, ComparisonOperator: op, Threshold: t, ThresholdType: thresholdType };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Validates a Cost Explorer date range (YYYY-MM-DD, start before end). Returns an error or null. */
export function checkDateRange(start: unknown, end: unknown): string | null {
  if (typeof start !== "string" || !DAY.test(start) || Number.isNaN(Date.parse(start))) return "Start date must be YYYY-MM-DD.";
  if (typeof end !== "string" || !DAY.test(end) || Number.isNaN(Date.parse(end))) return "End date must be YYYY-MM-DD.";
  if (Date.parse(start) >= Date.parse(end)) return "The start date must be before the end date.";
  return null;
}

export interface CostResultByTime {
  TimePeriod?: { Start?: string; End?: string };
  Total?: Record<string, { Amount?: string; Unit?: string }>;
  Groups?: { Keys?: string[]; Metrics?: Record<string, { Amount?: string; Unit?: string }> }[];
  Estimated?: boolean;
}

export interface CostRow {
  period: string;
  group: string;
  amount: string | null;
  unit: string | null;
  estimated: boolean;
}

/** Flattens GetCostAndUsage ResultsByTime into one row per period and group. */
export function flattenCostResults(results: readonly CostResultByTime[], metric: string): CostRow[] {
  return results.flatMap((r) => {
    const period = `${r.TimePeriod?.Start ?? "?"} – ${r.TimePeriod?.End ?? "?"}`;
    const estimated = r.Estimated === true;
    if (r.Groups && r.Groups.length > 0) {
      return r.Groups.map((g) => ({ period, group: (g.Keys ?? []).join(", ") || "(no key)", amount: g.Metrics?.[metric]?.Amount ?? null, unit: g.Metrics?.[metric]?.Unit ?? null, estimated }));
    }
    return [{ period, group: "Total", amount: r.Total?.[metric]?.Amount ?? null, unit: r.Total?.[metric]?.Unit ?? null, estimated }];
  });
}
