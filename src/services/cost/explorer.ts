/**
 * Cost Explorer side of Billing and Cost Management: the cost report (GetCostAndUsage),
 * cost categories and cost anomaly detection monitors and alert subscriptions. The report
 * page itself is hand-built (src/app/cost/cost-explorer); every value or error shown
 * there is the emulator's own response.
 */

import {
  CreateAnomalyMonitorCommand,
  CreateAnomalySubscriptionCommand,
  CreateCostCategoryDefinitionCommand,
  DeleteAnomalyMonitorCommand,
  DeleteCostCategoryDefinitionCommand,
  DescribeCostCategoryDefinitionCommand,
  GetAnomalyMonitorsCommand,
  GetAnomalySubscriptionsCommand,
  GetCostAndUsageCommand,
  ListCostCategoryDefinitionsCommand,
  ListTagsForResourceCommand,
  UpdateAnomalyMonitorCommand,
  UpdateAnomalySubscriptionCommand,
  UpdateCostCategoryDefinitionCommand,
  type AnomalyMonitor,
  type AnomalySubscription,
  type AnomalySubscriptionFrequency,
  type CostCategoryReference,
  type CostCategoryRule,
  type Dimension,
  type Subscriber,
} from "@aws-sdk/client-cost-explorer";
import type { Ctx, FieldValues, Option, ResourceDef, Tag } from "../../console/types.ts";
import { flattenCostResults, invalidEmails, splitList } from "./helpers.ts";

const CE_ARN = "arn:aws:ce::\\d{12}:[a-z]+/[A-Za-z0-9-]+";
const NAME = "[\\w\\s.:+=@_/-]{1,50}";

export const RULE_DIMENSIONS: Option[] = [
  { value: "LINKED_ACCOUNT", label: "Account" },
  { value: "SERVICE", label: "Service" },
  { value: "REGION", label: "Region" },
  { value: "USAGE_TYPE", label: "Usage type" },
  { value: "CHARGE_TYPE", label: "Charge type" },
];

async function describeCategory(ctx: Ctx, arn: string) {
  const c = (await ctx.clients.costexplorer.send(new DescribeCostCategoryDefinitionCommand({ CostCategoryArn: requireArn(arn, "cost category") }))).CostCategory;
  if (!c) throw new Error(`Cost category ${arn} was not found.`);
  return c;
}

/** The subscription's absolute $ threshold, when it has one. */
function absoluteThreshold(s: AnomalySubscription): number | null {
  const d = s.ThresholdExpression?.Dimensions;
  if (d?.Key === "ANOMALY_TOTAL_IMPACT_ABSOLUTE" && d.Values?.length) {
    const n = Number(d.Values[0]);
    return Number.isFinite(n) ? n : null;
  }
  return !s.ThresholdExpression && typeof s.Threshold === "number" ? s.Threshold : null;
}

function requireArn(id: string, kind: string): string {
  if (!new RegExp(`^${CE_ARN}$`).test(id)) throw new Error(`"${id}" is not a ${kind} ARN.`);
  return id;
}

const iso = (s: string | undefined): string | null => (s ? new Date(s).toISOString() : null);
const firstOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);

// ---- Cost Explorer -------------------------------------------------------------------

export const costExplorer: ResourceDef = {
  id: "cost-explorer",
  name: "Cost Explorer",
  singular: "cost report",
  idField: "key",
  description: "Visualize, understand and manage your AWS costs and usage over time.",
  emptyText: "Cost Explorer returned no costs for this period.",
  columns: [
    { key: "group", label: "Service", kind: "link" },
    { key: "period", label: "Period", kind: "text" },
    { key: "amount", label: "Unblended cost", kind: "text" },
    { key: "unit", label: "Unit", kind: "text" },
  ],
  /** Month-to-date unblended cost by service, the console's default report. */
  async list(ctx) {
    const now = new Date();
    const end = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
    const r = await ctx.clients.costexplorer.send(
      new GetCostAndUsageCommand({ TimePeriod: { Start: firstOfMonth(now), End: end }, Granularity: "MONTHLY", Metrics: ["UnblendedCost"], GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }] })
    );
    return flattenCostResults(r.ResultsByTime ?? [], "UnblendedCost").map((row, i) => ({ ...row, key: String(i) }));
  },
};

// ---- Cost categories -----------------------------------------------------------------

async function listCategories(ctx: Ctx): Promise<CostCategoryReference[]> {
  const out: CostCategoryReference[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.costexplorer.send(new ListCostCategoryDefinitionsCommand({ NextToken: token }));
    out.push(...(r.CostCategoryReferences ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

/** Parses the rules JSON field into CostCategoryRule[]; throws a readable error. */
export function parseRules(text: unknown): CostCategoryRule[] {
  if (typeof text !== "string" || text.trim() === "") throw new Error("Rules are required.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Rules must be valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("Rules must be a non-empty JSON array of rule objects.");
  for (const r of parsed) {
    if (r === null || typeof r !== "object" || Array.isArray(r)) throw new Error("Each rule must be an object such as {\"Value\": \"Prod\", \"Rule\": {...}}.");
  }
  return parsed as CostCategoryRule[];
}

function simpleRule(value: unknown, dimension: unknown, values: unknown): CostCategoryRule {
  const v = typeof value === "string" ? value.trim() : "";
  const list = splitList(values);
  if (v === "") throw new Error("Enter the cost category value for the rule.");
  if (list.length === 0) throw new Error("Enter at least one dimension value for the rule.");
  return { Value: v, Rule: { Dimensions: { Key: String(dimension) as Dimension, Values: list, MatchOptions: ["EQUALS"] } } };
}

export const costCategories: ResourceDef = {
  id: "cost-categories",
  name: "Cost categories",
  singular: "cost category",
  idField: "arn",
  nameField: "Name",
  description: "Map costs to your own business structure (teams, projects, environments) with rules.",
  emptyText: "No cost categories. Create a cost category to group costs.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "rules", label: "Rules", kind: "count" },
    { key: "values", label: "Values", kind: "text" },
    { key: "effectiveStart", label: "Effective start", kind: "date" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],
  async list(ctx) {
    return (await listCategories(ctx)).map((c) => ({
      arn: c.CostCategoryArn ?? "",
      name: c.Name ?? null,
      status: c.ProcessingStatus?.map((p) => p.Status).join(", ") || null,
      rules: c.NumberOfRules ?? null,
      values: (c.Values ?? []).join(", ") || null,
      effectiveStart: c.EffectiveStart ?? null,
    }));
  },
  async get(ctx, arn) {
    const r = await ctx.clients.costexplorer.send(new DescribeCostCategoryDefinitionCommand({ CostCategoryArn: requireArn(arn, "cost category") }));
    const c = r.CostCategory;
    if (!c) throw new Error(`Cost category ${arn} was not returned.`);
    return {
      summary: { Name: c.Name, ARN: c.CostCategoryArn, "Default value": c.DefaultValue ?? null, "Rule version": c.RuleVersion, "Effective start": iso(c.EffectiveStart), "Effective end": iso(c.EffectiveEnd) },
      tabs: [
        {
          id: "rules",
          label: "Rules",
          kind: "table",
          columns: [
            { key: "value", label: "Value", kind: "text" },
            { key: "type", label: "Type", kind: "text" },
            { key: "rule", label: "Rule", kind: "code" },
          ],
          data: (c.Rules ?? []).map((rule) => ({ value: rule.Value ?? rule.InheritedValue?.DimensionKey ?? null, type: rule.Type ?? "REGULAR", rule: JSON.stringify(rule.Rule ?? rule.InheritedValue ?? {}) })),
          emptyText: "No rules.",
        },
        {
          id: "status",
          label: "Processing status",
          kind: "table",
          columns: [
            { key: "component", label: "Component", kind: "text" },
            { key: "status", label: "Status", kind: "status" },
          ],
          data: (c.ProcessingStatus ?? []).map((p) => ({ component: p.Component, status: p.Status })),
        },
        { id: "json", label: "JSON", kind: "json", data: c },
      ],
    };
  },
  create: {
    title: "Create cost category",
    description: "Define a name and rules that assign costs to cost category values.",
    fields: [
      { name: "name", label: "Cost category name", kind: "text", required: true, placeholder: "Team", validate: { pattern: NAME, message: "1-50 characters." }, section: "Cost category details" },
      { name: "defaultValue", label: "Default value", kind: "text", help: "Value for costs that match no rule.", validate: { pattern: NAME, message: "1-50 characters." }, section: "Cost category details" },
      {
        name: "mode",
        label: "Define rules",
        kind: "radio",
        default: "simple",
        options: [
          { value: "simple", label: "One rule using a dimension" },
          { value: "json", label: "Rules JSON (CostCategoryRule list)" },
        ],
        section: "Category rules",
      },
      { name: "ruleValue", label: "Cost category value", kind: "text", placeholder: "Production", showIf: { field: "mode", equals: "simple" }, section: "Category rules" },
      { name: "dimension", label: "Dimension", kind: "select", default: "LINKED_ACCOUNT", options: RULE_DIMENSIONS, showIf: { field: "mode", equals: "simple" }, section: "Category rules" },
      { name: "dimensionValues", label: "Dimension values", kind: "text", help: "Separated by commas, e.g. account IDs or service names.", showIf: { field: "mode", equals: "simple" }, section: "Category rules" },
      { name: "rules", label: "Rules JSON", kind: "json", placeholder: '[{"Value":"Prod","Rule":{"Dimensions":{"Key":"LINKED_ACCOUNT","Values":["111122223333"]}}}]', showIf: { field: "mode", equals: "json" }, section: "Category rules" },
    ],
    async run(ctx, v) {
      const rules = v.mode === "json" ? parseRules(v.rules) : [simpleRule(v.ruleValue, v.dimension, v.dimensionValues)];
      const r = await ctx.clients.costexplorer.send(
        new CreateCostCategoryDefinitionCommand({ Name: String(v.name), RuleVersion: "CostCategoryExpression.v1", Rules: rules, DefaultValue: typeof v.defaultValue === "string" && v.defaultValue !== "" ? v.defaultValue : undefined })
      );
      if (!r.CostCategoryArn) throw new Error("Cost Explorer returned no ARN for the cost category.");
      return r.CostCategoryArn;
    },
  },
  actions: [
    {
      id: "edit-rules",
      label: "Edit rules",
      fields: [
        { name: "rules", label: "Rules JSON", kind: "json", required: true, help: "The category's current rules (a CostCategoryRule list). Saving replaces every rule with this list." },
        { name: "defaultValue", label: "Default value", kind: "text", validate: { pattern: NAME, message: "1-50 characters." } },
      ],
      async initialValues(ctx, arn) {
        const c = await describeCategory(ctx, arn);
        return { rules: JSON.stringify(c.Rules ?? [], null, 2), defaultValue: c.DefaultValue ?? "" };
      },
      async run(ctx, arn, v) {
        await ctx.clients.costexplorer.send(
          new UpdateCostCategoryDefinitionCommand({ CostCategoryArn: requireArn(arn, "cost category"), RuleVersion: "CostCategoryExpression.v1", Rules: parseRules(v.rules), DefaultValue: typeof v.defaultValue === "string" && v.defaultValue !== "" ? v.defaultValue : undefined })
        );
        return { message: "Cost category rules updated." };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, arn) {
      await ctx.clients.costexplorer.send(new DeleteCostCategoryDefinitionCommand({ CostCategoryArn: requireArn(arn, "cost category") }));
    },
  },
};

// ---- Cost anomaly detection ------------------------------------------------------------

async function listMonitors(ctx: Ctx, arns?: string[]): Promise<AnomalyMonitor[]> {
  const out: AnomalyMonitor[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.costexplorer.send(new GetAnomalyMonitorsCommand({ MonitorArnList: arns, NextPageToken: token }));
    out.push(...(r.AnomalyMonitors ?? []));
    token = r.NextPageToken;
  } while (token);
  return out;
}

async function listSubscriptions(ctx: Ctx, arns?: string[]): Promise<AnomalySubscription[]> {
  const out: AnomalySubscription[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.costexplorer.send(new GetAnomalySubscriptionsCommand({ SubscriptionArnList: arns, NextPageToken: token }));
    out.push(...(r.AnomalySubscriptions ?? []));
    token = r.NextPageToken;
  } while (token);
  return out;
}

function monitorType(m: AnomalyMonitor): string {
  if (m.MonitorType === "DIMENSIONAL") return m.MonitorDimension === "SERVICE" ? "AWS services" : `Dimensional (${m.MonitorDimension ?? "?"})`;
  return "Custom";
}

export const anomalyMonitors: ResourceDef = {
  id: "anomaly-monitors",
  name: "Cost monitors",
  singular: "cost monitor",
  idField: "arn",
  nameField: "Name",
  description: "Cost anomaly detection monitors watch your spend with machine learning and flag unusual changes.",
  emptyText: "No cost monitors. Create a monitor to start detecting anomalies.",
  columns: [
    { key: "name", label: "Monitor name", kind: "link" },
    { key: "type", label: "Monitor type", kind: "text" },
    { key: "values", label: "Dimension values evaluated", kind: "count" },
    { key: "created", label: "Date created", kind: "date" },
    { key: "updated", label: "Last updated", kind: "date" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],
  async list(ctx) {
    return (await listMonitors(ctx)).map((m) => ({ arn: m.MonitorArn ?? "", name: m.MonitorName ?? null, type: monitorType(m), values: m.DimensionalValueCount ?? null, created: m.CreationDate ?? null, updated: m.LastUpdatedDate ?? null }));
  },
  async get(ctx, arn) {
    const [m] = await listMonitors(ctx, [requireArn(arn, "cost monitor")]);
    if (!m) throw new Error(`Cost monitor ${arn} was not found.`);
    const tags = await ctx.clients.costexplorer.send(new ListTagsForResourceCommand({ ResourceArn: arn }));
    const subs = (await listSubscriptions(ctx)).filter((s) => (s.MonitorArnList ?? []).includes(arn));
    return {
      summary: { Name: m.MonitorName, ARN: m.MonitorArn, "Monitor type": monitorType(m), "Dimension values evaluated": m.DimensionalValueCount ?? null, "Date created": m.CreationDate ?? null, "Last updated": m.LastUpdatedDate ?? null, "Last evaluated": m.LastEvaluatedDate ?? null },
      tabs: [
        {
          id: "subscriptions",
          label: "Alert subscriptions",
          kind: "table",
          columns: [
            { key: "name", label: "Subscription", kind: "text" },
            { key: "frequency", label: "Frequency", kind: "text" },
            { key: "threshold", label: "Threshold", kind: "text" },
          ],
          data: subs.map((s) => ({ name: s.SubscriptionName, frequency: s.Frequency, threshold: thresholdText(s) })),
          emptyText: "No alert subscriptions use this monitor.",
        },
        { id: "spec", label: "Monitor specification", kind: "json", data: m.MonitorSpecification ?? null, emptyText: "No specification (AWS services monitor)." },
        {
          id: "tags",
          label: "Tags",
          kind: "table",
          columns: [
            { key: "Key", label: "Key", kind: "text" },
            { key: "Value", label: "Value", kind: "text" },
          ],
          data: tags.ResourceTags ?? [],
          emptyText: "No tags.",
        },
      ],
    };
  },
  create: {
    title: "Create monitor",
    description: "Choose what to monitor. AWS services monitors evaluate each service you use separately.",
    fields: [
      {
        name: "monitorType",
        label: "Monitor type",
        kind: "radio",
        default: "SERVICE",
        options: [
          { value: "SERVICE", label: "AWS services - recommended for most accounts" },
          { value: "LINKED_ACCOUNT", label: "Linked account - monitors the spend of the accounts you choose" },
        ],
        section: "Monitor type",
      },
      { name: "accounts", label: "Linked accounts", kind: "text", placeholder: "111122223333, 444455556666", help: "Account IDs, separated by commas.", showIf: { field: "monitorType", equals: "LINKED_ACCOUNT" }, section: "Monitor type" },
      { name: "name", label: "Monitor name", kind: "text", required: true, validate: { pattern: NAME, message: "1-50 characters." }, section: "Monitor details" },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      const tags = Array.isArray(v.tags) ? (v.tags as Tag[]) : [];
      let monitor: AnomalyMonitor;
      if (v.monitorType === "LINKED_ACCOUNT") {
        const accounts = splitList(v.accounts);
        if (accounts.length === 0 || accounts.some((a) => !/^\d{12}$/.test(a))) throw new Error("Enter one or more 12-digit account IDs.");
        monitor = { MonitorName: name, MonitorType: "CUSTOM", MonitorSpecification: { Dimensions: { Key: "LINKED_ACCOUNT", Values: accounts } } };
      } else {
        monitor = { MonitorName: name, MonitorType: "DIMENSIONAL", MonitorDimension: "SERVICE" };
      }
      const r = await ctx.clients.costexplorer.send(new CreateAnomalyMonitorCommand({ AnomalyMonitor: monitor, ResourceTags: tags.length ? tags : undefined }));
      if (!r.MonitorArn) throw new Error("Cost Explorer returned no monitor ARN.");
      return r.MonitorArn;
    },
  },
  actions: [
    {
      id: "rename",
      label: "Edit monitor name",
      fields: [{ name: "name", label: "Monitor name", kind: "text", required: true, validate: { pattern: NAME, message: "1-50 characters." } }],
      async initialValues(ctx, arn) {
        const [m] = await listMonitors(ctx, [requireArn(arn, "cost monitor")]);
        return { name: m?.MonitorName ?? "" };
      },
      async run(ctx, arn, v) {
        await ctx.clients.costexplorer.send(new UpdateAnomalyMonitorCommand({ MonitorArn: requireArn(arn, "cost monitor"), MonitorName: String(v.name) }));
        return { message: `Monitor renamed to ${String(v.name)}.` };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, arn) {
      await ctx.clients.costexplorer.send(new DeleteAnomalyMonitorCommand({ MonitorArn: requireArn(arn, "cost monitor") }));
    },
  },
};

function thresholdText(s: AnomalySubscription): string | null {
  const d = s.ThresholdExpression?.Dimensions;
  if (d?.Key && d.Values?.length) {
    const what = d.Key === "ANOMALY_TOTAL_IMPACT_PERCENTAGE" ? "% total impact" : "$ total impact";
    return `${what} >= ${d.Values.join(", ")}`;
  }
  return s.Threshold !== undefined ? `$${s.Threshold}` : null;
}

async function monitorOptions(ctx: Ctx): Promise<Option[]> {
  return (await listMonitors(ctx)).filter((m) => m.MonitorArn).map((m) => ({ value: m.MonitorArn as string, label: m.MonitorName ?? (m.MonitorArn as string) }));
}

const FREQUENCIES: Option[] = [
  { value: "IMMEDIATE", label: "Individual alerts (Amazon SNS only)" },
  { value: "DAILY", label: "Daily summaries" },
  { value: "WEEKLY", label: "Weekly summaries" },
];

function thresholdExpression(amount: number) {
  return { Dimensions: { Key: "ANOMALY_TOTAL_IMPACT_ABSOLUTE" as const, Values: [String(amount)], MatchOptions: ["GREATER_THAN_OR_EQUAL" as const] } };
}

export const anomalySubscriptions: ResourceDef = {
  id: "anomaly-subscriptions",
  name: "Alert subscriptions",
  singular: "alert subscription",
  idField: "arn",
  nameField: "Name",
  description: "Who is told about detected anomalies, how often, and above what impact.",
  emptyText: "No alert subscriptions.",
  columns: [
    { key: "name", label: "Subscription name", kind: "link" },
    { key: "frequency", label: "Alerting frequency", kind: "text" },
    { key: "threshold", label: "Threshold", kind: "text" },
    { key: "monitors", label: "Monitors", kind: "count" },
    { key: "recipients", label: "Recipients", kind: "text" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],
  async list(ctx) {
    return (await listSubscriptions(ctx)).map((s) => ({
      arn: s.SubscriptionArn ?? "",
      name: s.SubscriptionName ?? null,
      frequency: s.Frequency ?? null,
      threshold: thresholdText(s),
      monitors: (s.MonitorArnList ?? []).length,
      recipients: (s.Subscribers ?? []).map((x) => x.Address).join(", ") || null,
    }));
  },
  async get(ctx, arn) {
    const [s] = await listSubscriptions(ctx, [requireArn(arn, "alert subscription")]);
    if (!s) throw new Error(`Alert subscription ${arn} was not found.`);
    const monitors = await listMonitors(ctx);
    return {
      summary: { Name: s.SubscriptionName, ARN: s.SubscriptionArn, Frequency: s.Frequency, Threshold: thresholdText(s), Account: s.AccountId ?? null },
      tabs: [
        {
          id: "recipients",
          label: "Recipients",
          kind: "table",
          columns: [
            { key: "Type", label: "Type", kind: "text" },
            { key: "Address", label: "Address", kind: "text" },
            { key: "Status", label: "Status", kind: "status" },
          ],
          data: s.Subscribers ?? [],
        },
        {
          id: "monitors",
          label: "Cost monitors",
          kind: "table",
          columns: [
            { key: "name", label: "Monitor", kind: "text" },
            { key: "arn", label: "ARN", kind: "arn" },
          ],
          data: (s.MonitorArnList ?? []).map((a) => ({ arn: a, name: monitors.find((m) => m.MonitorArn === a)?.MonitorName ?? "(monitor no longer exists)" })),
          emptyText: "No monitors.",
        },
      ],
    };
  },
  create: {
    title: "Create alert subscription",
    description: "AWS Emulator can't delete alert subscriptions yet (DeleteAnomalySubscription), so subscriptions you create here stay until the emulator restarts.",
    fields: [
      { name: "name", label: "Subscription name", kind: "text", required: true, validate: { pattern: NAME, message: "1-50 characters." }, section: "Alert subscription" },
      { name: "frequency", label: "Alerting frequency", kind: "select", required: true, default: "DAILY", options: FREQUENCIES, section: "Alert subscription" },
      { name: "threshold", label: "Threshold ($ total cost impact)", kind: "number", required: true, default: 100, validate: { min: 0, max: 1_000_000_000, message: "Enter 0 or more." }, section: "Alert subscription" },
      { name: "monitors", label: "Cost monitors", kind: "multiselect", required: true, options: monitorOptions, section: "Alert subscription" },
      { name: "emails", label: "Email recipients", kind: "text", help: "Separated by commas. Not used for individual alerts.", section: "Recipients" },
      { name: "snsTopic", label: "Amazon SNS topic ARN", kind: "text", help: "Required for individual alerts.", validate: { pattern: "arn:aws:sns:[a-z0-9-]+:\\d{12}:[\\w-]+(\\.fifo)?", message: "Enter an SNS topic ARN." }, section: "Recipients" },
    ],
    async run(ctx, v) {
      const emails = splitList(v.emails);
      const bad = invalidEmails(emails);
      if (bad.length) throw new Error(`Not a valid email address: ${bad.join(", ")}`);
      const subscribers: Subscriber[] = emails.map((Address) => ({ Address, Type: "EMAIL" }));
      if (typeof v.snsTopic === "string" && v.snsTopic !== "") subscribers.push({ Address: v.snsTopic, Type: "SNS" });
      if (subscribers.length === 0) throw new Error("Add an email recipient or an SNS topic.");
      const monitors = Array.isArray(v.monitors) ? v.monitors.filter((m): m is string => typeof m === "string") : [];
      const r = await ctx.clients.costexplorer.send(
        new CreateAnomalySubscriptionCommand({
          AnomalySubscription: {
            SubscriptionName: String(v.name),
            Frequency: String(v.frequency) as AnomalySubscriptionFrequency,
            MonitorArnList: monitors,
            Subscribers: subscribers,
            ThresholdExpression: thresholdExpression(typeof v.threshold === "number" ? v.threshold : 100),
          },
        })
      );
      if (!r.SubscriptionArn) throw new Error("Cost Explorer returned no subscription ARN.");
      return r.SubscriptionArn;
    },
  },
  actions: [
    {
      id: "edit",
      label: "Edit frequency and threshold",
      fields: [
        { name: "frequency", label: "Alerting frequency", kind: "select", required: true, default: "DAILY", options: FREQUENCIES },
        { name: "threshold", label: "Threshold ($ total cost impact)", kind: "number", required: true, validate: { min: 0, max: 1_000_000_000, message: "Enter 0 or more." } },
      ],
      async initialValues(ctx, arn) {
        const [s] = await listSubscriptions(ctx, [requireArn(arn, "alert subscription")]);
        if (!s) return {};
        const values: FieldValues = { frequency: s.Frequency ?? "DAILY" };
        const t = absoluteThreshold(s);
        if (t !== null) values.threshold = t;
        return values;
      },
      async run(ctx, arn, v) {
        const [s] = await listSubscriptions(ctx, [requireArn(arn, "alert subscription")]);
        const threshold = typeof v.threshold === "number" ? v.threshold : 100;
        if (s && s.Frequency === v.frequency && absoluteThreshold(s) === threshold) return { message: "No changes: the alert subscription is unchanged." };
        await ctx.clients.costexplorer.send(
          new UpdateAnomalySubscriptionCommand({
            SubscriptionArn: requireArn(arn, "alert subscription"),
            Frequency: String(v.frequency) as AnomalySubscriptionFrequency,
            ThresholdExpression: thresholdExpression(threshold),
          })
        );
        return { message: "Alert subscription updated." };
      },
    },
  ],
};
