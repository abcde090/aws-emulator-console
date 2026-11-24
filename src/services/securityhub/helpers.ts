/** Pure Security Hub helpers: ASFF building, filter building and labels. Unit tested. */

export type SeverityLabel = "INFORMATIONAL" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export const SEVERITY_LABELS: SeverityLabel[] = ["INFORMATIONAL", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
export const WORKFLOW_STATUSES = ["NEW", "NOTIFIED", "RESOLVED", "SUPPRESSED"] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export function isSeverity(v: unknown): v is SeverityLabel {
  return typeof v === "string" && (SEVERITY_LABELS as string[]).includes(v);
}

export function isWorkflowStatus(v: unknown): v is WorkflowStatus {
  return typeof v === "string" && (WORKFLOW_STATUSES as readonly string[]).includes(v);
}

/** The default product ARN a customer uses to import its own findings. */
export function defaultProductArn(region: string, account: string): string {
  return `arn:aws:securityhub:${region}:${account}:product/${account}/default`;
}

export interface FindingInput {
  id: string;
  title: string;
  description: string;
  severity: SeverityLabel;
  type: string;
  resourceType: string;
  resourceId: string;
  generatorId: string;
  region: string;
  account: string;
  now: string;
}

/** A minimal, valid AWS Security Finding Format (ASFF) document. */
export function buildAsff(f: FindingInput): Record<string, unknown> {
  for (const [label, value] of [["Finding ID", f.id], ["Title", f.title], ["Description", f.description], ["Resource ID", f.resourceId]] as const) {
    if (value.trim() === "") throw new Error(`${label} is required.`);
  }
  return {
    SchemaVersion: "2018-10-08",
    Id: f.id,
    ProductArn: defaultProductArn(f.region, f.account),
    GeneratorId: f.generatorId || "custom",
    AwsAccountId: f.account,
    Types: [f.type],
    CreatedAt: f.now,
    UpdatedAt: f.now,
    Severity: { Label: f.severity },
    Title: f.title,
    Description: f.description,
    Resources: [{ Type: f.resourceType || "Other", Id: f.resourceId, Region: f.region }],
  };
}

export interface StringFilter {
  Value: string;
  Comparison: "EQUALS" | "PREFIX" | "NOT_EQUALS" | "PREFIX_NOT_EQUALS" | "CONTAINS" | "NOT_CONTAINS";
}

export interface RuleCriteriaInput {
  severities: string[];
  productName: string;
  resourceType: string;
  titlePrefix: string;
  complianceStatus: string;
}

/** Automation rule criteria from the form. At least one criterion is required. */
export function buildRuleCriteria(i: RuleCriteriaInput): Record<string, StringFilter[]> {
  const c: Record<string, StringFilter[]> = {};
  const sev = i.severities.filter(isSeverity);
  if (sev.length) c.SeverityLabel = sev.map((Value) => ({ Value, Comparison: "EQUALS" }));
  if (i.productName) c.ProductName = [{ Value: i.productName, Comparison: "EQUALS" }];
  if (i.resourceType) c.ResourceType = [{ Value: i.resourceType, Comparison: "EQUALS" }];
  if (i.titlePrefix) c.Title = [{ Value: i.titlePrefix, Comparison: "PREFIX" }];
  if (i.complianceStatus) c.ComplianceStatus = [{ Value: i.complianceStatus, Comparison: "EQUALS" }];
  if (Object.keys(c).length === 0) throw new Error("Add at least one criterion; a rule with no criteria would change every finding.");
  return c;
}

/** "arn:aws:securityhub:us-east-1:111:automation-rule/uuid" -> "uuid". */
export function arnTail(arn: string | undefined): string {
  if (!arn) return "";
  return arn.slice(arn.lastIndexOf("/") + 1);
}

/** Criteria object -> readable rows. */
export function criteriaRows(criteria: Record<string, unknown> | undefined): { field: string; condition: string }[] {
  return Object.entries(criteria ?? {}).map(([field, list]) => ({
    field,
    condition: Array.isArray(list)
      ? list.map((x) => {
          const o = (x ?? {}) as Record<string, unknown>;
          return `${String(o.Comparison ?? "")} ${String(o.Value ?? o.Key ?? JSON.stringify(o))}`.trim();
        }).join(" OR ")
      : JSON.stringify(list),
  }));
}
