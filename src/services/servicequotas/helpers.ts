/** Pure helpers for Service Quotas. */

export interface QuotaLike {
  QuotaCode?: string;
  QuotaName?: string;
  Value?: number;
  Unit?: string;
  Adjustable?: boolean;
  GlobalQuota?: boolean;
  QuotaArn?: string;
  UsageMetric?: { MetricNamespace?: string; MetricName?: string };
}

export interface QuotaRow {
  code: string;
  name: string;
  applied: number | null;
  defaultValue: number | null;
  adjustable: boolean;
  unit: string | null;
  global: boolean;
  arn: string | null;
  usageMetric: string | null;
}

/** Joins applied and default quotas by quota code. A quota only in one list still shows. */
export function mergeQuotas(applied: readonly QuotaLike[], defaults: readonly QuotaLike[]): QuotaRow[] {
  const codes = new Set<string>([...applied, ...defaults].map((q) => q.QuotaCode ?? "").filter(Boolean));
  return [...codes]
    .map((code) => {
      const a = applied.find((q) => q.QuotaCode === code);
      const d = defaults.find((q) => q.QuotaCode === code);
      const any = a ?? d ?? {};
      const metric = any.UsageMetric?.MetricName ? `${any.UsageMetric.MetricNamespace ?? ""}/${any.UsageMetric.MetricName}` : null;
      return {
        code,
        name: any.QuotaName ?? code,
        applied: a?.Value ?? null,
        defaultValue: d?.Value ?? null,
        adjustable: any.Adjustable === true,
        unit: any.Unit && any.Unit !== "None" ? any.Unit : null,
        global: any.GlobalQuota === true,
        arn: a?.QuotaArn ?? d?.QuotaArn ?? null,
        usageMetric: metric,
      };
    })
    .sort((x, y) => x.name.localeCompare(y.name));
}

/** Checks a requested value: a number above the current applied (or default) value. */
export function checkDesiredValue(desired: unknown, current: number | null): string | null {
  if (typeof desired !== "number" || !Number.isFinite(desired)) return "Enter the new quota value.";
  if (desired <= 0) return "The quota value must be greater than 0.";
  if (current !== null && desired <= current) return `Enter a value greater than the current quota value (${current}).`;
  return null;
}
