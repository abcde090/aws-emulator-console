/** Pure GuardDuty helpers: severity labels, filter criteria from form values, feature rows. */

export type SeverityLabel = "Critical" | "High" | "Medium" | "Low";

/** GuardDuty's documented bands: Low 1.0-3.9, Medium 4.0-6.9, High 7.0-8.9, Critical 9.0-10.0. */
export function severityLabel(score: unknown): SeverityLabel | null {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  if (score >= 9) return "Critical";
  if (score >= 7) return "High";
  if (score >= 4) return "Medium";
  return "Low";
}

const SEVERITY_RANGE: Record<SeverityLabel, [number, number]> = { Low: [1, 4], Medium: [4, 7], High: [7, 9], Critical: [9, 11] };

export interface CriterionCondition {
  Eq?: string[];
  Neq?: string[];
  GreaterThanOrEqual?: number;
  LessThan?: number;
}

export interface FilterInput {
  findingType?: string;
  minSeverity?: string;
  resourceType?: string;
  accountId?: string;
  advanced?: string;
}

/**
 * Builds a GuardDuty FindingCriteria.Criterion from the suppression-rule form.
 * Advanced JSON (a Criterion object) is merged last so it can add any attribute.
 */
export function buildCriterion(input: FilterInput): Record<string, CriterionCondition> {
  const c: Record<string, CriterionCondition> = {};
  if (input.findingType) c.type = { Eq: input.findingType.split(",").map((s) => s.trim()).filter(Boolean) };
  if (input.minSeverity && input.minSeverity in SEVERITY_RANGE) c.severity = { GreaterThanOrEqual: SEVERITY_RANGE[input.minSeverity as SeverityLabel][0] };
  if (input.resourceType) c["resource.resourceType"] = { Eq: [input.resourceType] };
  if (input.accountId) c.accountId = { Eq: [input.accountId] };
  if (input.advanced && input.advanced.trim() !== "") {
    const parsed: unknown = JSON.parse(input.advanced);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Advanced criteria must be a JSON object of attribute: condition.");
    Object.assign(c, parsed as Record<string, CriterionCondition>);
  }
  if (Object.keys(c).length === 0) throw new Error("Add at least one criterion. A rule with no criteria would match every finding.");
  return c;
}

/** Criterion -> table rows for the detail page. */
export function criterionRows(criterion: Record<string, unknown> | undefined): { attribute: string; condition: string }[] {
  return Object.entries(criterion ?? {}).map(([attribute, cond]) => {
    const parts: string[] = [];
    const c = (cond ?? {}) as Record<string, unknown>;
    const seen = new Set<string>();
    const add = (label: string, keys: string[]) => {
      for (const k of keys) {
        const v = c[k];
        if (v === undefined || seen.has(label)) continue;
        seen.add(label);
        parts.push(`${label} ${Array.isArray(v) ? v.join(", ") : String(v)}`);
      }
    };
    add("equals", ["Eq", "Equals"]);
    add("not equals", ["Neq", "NotEquals"]);
    add(">=", ["GreaterThanOrEqual", "Gte"]);
    add(">", ["GreaterThan", "Gt"]);
    add("<=", ["LessThanOrEqual", "Lte"]);
    add("<", ["LessThan", "Lt"]);
    return { attribute, condition: parts.join("; ") || JSON.stringify(cond) };
  });
}

/** Feature names as the console's Protection plans page words them. */
export const FEATURE_LABELS: Record<string, string> = {
  CLOUD_TRAIL: "Foundational: CloudTrail management events",
  DNS_LOGS: "Foundational: DNS logs",
  FLOW_LOGS: "Foundational: VPC flow logs",
  S3_DATA_EVENTS: "S3 Protection",
  EKS_AUDIT_LOGS: "EKS Protection (audit logs)",
  EBS_MALWARE_PROTECTION: "Malware Protection for EC2",
  RDS_LOGIN_EVENTS: "RDS Protection",
  LAMBDA_NETWORK_LOGS: "Lambda Protection",
  EKS_RUNTIME_MONITORING: "EKS Runtime Monitoring",
  RUNTIME_MONITORING: "Runtime Monitoring",
  AI_PROTECTION: "AI Protection",
  AI_ANALYST: "AI analyst",
};

export function featureLabel(name: string | undefined): string {
  return name ? FEATURE_LABELS[name] ?? name : "-";
}
