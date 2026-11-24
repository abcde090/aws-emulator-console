/**
 * Compute Optimizer recommendation preferences: Get/Put/DeleteRecommendationPreferences.
 * One row per resource type and scope that has preferences set.
 */

import {
  DeleteRecommendationPreferencesCommand,
  GetRecommendationPreferencesCommand,
  PutRecommendationPreferencesCommand,
  type PutRecommendationPreferencesRequest,
  type ResourceType,
  type Scope,
  type ScopeName,
  type UtilizationPreference,
} from "@aws-sdk/client-compute-optimizer";
import type { Ctx, FieldDef, FieldValues, Option, ResourceDef } from "../../console/types.ts";
import { co } from "./recommendations.ts";
import { parsePreferenceId, preferenceRow, setPreferenceNames, splitList, type PreferenceDetail } from "./helpers.ts";

const RESOURCE_TYPES: Option[] = [
  { value: "Ec2Instance", label: "EC2 instances" },
  { value: "AutoScalingGroup", label: "Auto Scaling groups" },
  { value: "EbsVolume", label: "EBS volumes" },
  { value: "EcsService", label: "ECS services on Fargate" },
  { value: "RdsDBInstance", label: "RDS DB instances" },
  { value: "AuroraDBClusterStorage", label: "Aurora DB cluster storage" },
];

// Optional selects get the engine's "-" (not set: Compute Optimizer keeps its default or the current value).
const activeInactive: Option[] = [{ value: "Active", label: "Active" }, { value: "Inactive", label: "Inactive" }];

const PREFERENCE_FIELDS: FieldDef[] = [
  {
    name: "enhancedInfrastructureMetrics",
    label: "Enhanced infrastructure metrics",
    kind: "select",
    options: activeInactive,
    section: "Preferences",
    help: "Extends the look-back period to 93 days for EC2 instances, Auto Scaling groups and RDS DB instances (a paid feature in AWS).",
  },
  {
    name: "inferredWorkloadTypes",
    label: "Inferred workload types",
    kind: "select",
    options: activeInactive,
    section: "Preferences",
    help: "Lets Compute Optimizer infer applications such as PostgreSQL or Nginx on instances and recommend accordingly.",
  },
  {
    name: "lookBackPeriod",
    label: "Look-back period",
    kind: "select",
    options: [{ value: "DAYS_14", label: "14 days" }, { value: "DAYS_32", label: "32 days" }, { value: "DAYS_93", label: "93 days" }],
    section: "Preferences",
    help: "How many days of utilization metrics the analysis uses.",
  },
  {
    name: "externalMetrics",
    label: "External metrics ingestion",
    kind: "select",
    options: [{ value: "Datadog", label: "Datadog" }, { value: "Dynatrace", label: "Dynatrace" }, { value: "Instana", label: "Instana" }, { value: "NewRelic", label: "New Relic" }],
    section: "Preferences",
    help: "EC2 only: use memory metrics from an observability product.",
  },
  {
    name: "cpuThreshold",
    label: "CPU utilization threshold",
    kind: "select",
    options: [{ value: "P99_5", label: "P99.5" }, { value: "P95", label: "P95" }, { value: "P90", label: "P90" }],
    section: "Rightsizing preferences (EC2)",
    help: "The percentile of CPU utilization that the recommendation must cover.",
  },
  {
    name: "cpuHeadroom",
    label: "CPU utilization headroom",
    kind: "select",
    options: [{ value: "PERCENT_30", label: "30%" }, { value: "PERCENT_20", label: "20%" }, { value: "PERCENT_0", label: "0%" }],
    section: "Rightsizing preferences (EC2)",
  },
  {
    name: "memoryHeadroom",
    label: "Memory utilization headroom",
    kind: "select",
    options: [{ value: "PERCENT_30", label: "30%" }, { value: "PERCENT_20", label: "20%" }, { value: "PERCENT_10", label: "10%" }, { value: "PERCENT_0", label: "0%" }],
    section: "Rightsizing preferences (EC2)",
  },
  {
    name: "preferredTypes",
    label: "Preferred instance types",
    kind: "text",
    placeholder: "m5.*, c6g.large",
    section: "Rightsizing preferences (EC2)",
    help: "Comma-separated instance types or families (wildcards allowed) to consider in recommendations.",
  },
];

const pick = (v: FieldValues, keys: string[]): FieldValues => Object.fromEntries(keys.map((k) => [k, typeof v[k] === "string" ? v[k] : ""]));

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The preference part of a PutRecommendationPreferences request, built from the form. */
function preferenceInput(v: FieldValues): Partial<PutRecommendationPreferencesRequest> {
  const input: Partial<PutRecommendationPreferencesRequest> = {};
  const eim = str(v.enhancedInfrastructureMetrics);
  if (eim === "Active" || eim === "Inactive") input.enhancedInfrastructureMetrics = eim;
  const iwt = str(v.inferredWorkloadTypes);
  if (iwt === "Active" || iwt === "Inactive") input.inferredWorkloadTypes = iwt;
  const lookBack = str(v.lookBackPeriod);
  if (lookBack === "DAYS_14" || lookBack === "DAYS_32" || lookBack === "DAYS_93") input.lookBackPeriod = lookBack;
  const ext = str(v.externalMetrics);
  if (ext === "Datadog" || ext === "Dynatrace" || ext === "Instana" || ext === "NewRelic") input.externalMetricsPreference = { source: ext };
  const util: UtilizationPreference[] = [];
  const cpuThreshold = str(v.cpuThreshold);
  const cpuHeadroom = str(v.cpuHeadroom);
  if (cpuThreshold || cpuHeadroom) {
    util.push({
      metricName: "CpuUtilization",
      metricParameters: { threshold: cpuThreshold as "P90" | "P95" | "P99_5" | undefined, headroom: cpuHeadroom as "PERCENT_0" | "PERCENT_20" | "PERCENT_30" | undefined },
    });
  }
  const memHeadroom = str(v.memoryHeadroom);
  if (memHeadroom) util.push({ metricName: "MemoryUtilization", metricParameters: { headroom: memHeadroom as "PERCENT_0" | "PERCENT_10" | "PERCENT_20" | "PERCENT_30" } });
  if (util.length) input.utilizationPreferences = util;
  const types = splitList(v.preferredTypes);
  if (types.length) input.preferredResources = [{ name: "Ec2InstanceTypes", includeList: types }];
  return input;
}

/** The form values for a preference that is already set (for the prefilled Edit dialog). */
function preferenceValues(p: PreferenceDetail): FieldValues {
  const cpu = (p.utilizationPreferences ?? []).find((u) => u.metricName === "CpuUtilization")?.metricParameters;
  const mem = (p.utilizationPreferences ?? []).find((u) => u.metricName === "MemoryUtilization")?.metricParameters;
  const types = (p.preferredResources ?? []).find((r) => r.name === "Ec2InstanceTypes")?.includeList ?? [];
  return {
    enhancedInfrastructureMetrics: p.enhancedInfrastructureMetrics ?? "",
    inferredWorkloadTypes: p.inferredWorkloadTypes ?? "",
    lookBackPeriod: p.lookBackPeriod ?? "",
    externalMetrics: p.externalMetricsPreference?.source ?? "",
    cpuThreshold: cpu?.threshold ?? "",
    cpuHeadroom: cpu?.headroom ?? "",
    memoryHeadroom: mem?.headroom ?? "",
    preferredTypes: types.join(", "),
  };
}

async function put(ctx: Ctx, resourceType: string, scope: Scope, v: FieldValues, current?: PreferenceDetail): Promise<void> {
  const prefs = preferenceInput(v);
  // Keep an exclude list the form doesn't show.
  const exclude = current?.preferredResources?.find((r) => r.name === "Ec2InstanceTypes")?.excludeList;
  if (prefs.preferredResources && exclude?.length) prefs.preferredResources = prefs.preferredResources.map((r) => ({ ...r, excludeList: exclude }));
  if (Object.keys(prefs).length === 0) throw new Error("Choose at least one preference to set.");
  await co(() => ctx.clients.computeoptimizer.send(new PutRecommendationPreferencesCommand({ resourceType: resourceType as ResourceType, scope, ...prefs })));
}

async function readPreferences(ctx: Ctx, resourceType: string, scope?: Scope): Promise<PreferenceDetail[]> {
  const out: PreferenceDetail[] = [];
  let token: string | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await co(() => ctx.clients.computeoptimizer.send(new GetRecommendationPreferencesCommand({ resourceType: resourceType as ResourceType, scope, nextToken: token })));
    out.push(...((r.recommendationPreferencesDetails ?? []) as PreferenceDetail[]));
    token = r.nextToken;
    if (!token) break;
  }
  return out;
}

function scopeFromId(id: string): { resourceType: string; scope: Scope } {
  const p = parsePreferenceId(id);
  if (!p) throw new Error(`"${id}" is not a recommendation preference id.`);
  return { resourceType: p.resourceType, scope: { name: p.scopeName as ScopeName, value: p.scopeValue } };
}

async function findPreference(ctx: Ctx, id: string): Promise<PreferenceDetail> {
  const { resourceType, scope } = scopeFromId(id);
  const found = (await readPreferences(ctx, resourceType, scope)).find((p) => preferenceRow(p).id === id);
  if (!found) throw new Error(`No recommendation preferences are set for ${id}.`);
  return found;
}

export const preferences: ResourceDef = {
  id: "preferences",
  name: "Recommendation preferences",
  singular: "recommendation preference",
  idField: "id",
  nameField: "resourceType",
  description: "Preferences that change how Compute Optimizer generates recommendations, set per resource type for the account, the organization or one resource.",
  emptyText: "No recommendation preferences are set. Compute Optimizer uses its defaults.",
  columns: [
    { key: "resourceType", label: "Resource type", kind: "link" },
    { key: "scope", label: "Scope", kind: "text" },
    { key: "enhancedInfrastructureMetrics", label: "Enhanced infrastructure metrics", kind: "text" },
    { key: "inferredWorkloadTypes", label: "Inferred workload types", kind: "text" },
    { key: "lookBackPeriod", label: "Look-back period", kind: "text" },
    { key: "externalMetrics", label: "External metrics", kind: "text" },
    { key: "utilization", label: "Utilization preferences", kind: "text" },
    { key: "preferredResources", label: "Preferred instances", kind: "text" },
    { key: "savingsEstimationMode", label: "Savings estimation mode", kind: "text", hidden: true },
  ],

  async list(ctx) {
    const all = await Promise.all(RESOURCE_TYPES.map((t) => readPreferences(ctx, t.value)));
    return all.flat().map(preferenceRow);
  },

  async get(ctx, id) {
    const p = await findPreference(ctx, id);
    const row = preferenceRow(p);
    return {
      summary: {
        "Resource type": row.resourceType,
        Scope: row.scope,
        "Enhanced infrastructure metrics": row.enhancedInfrastructureMetrics,
        "Inferred workload types": row.inferredWorkloadTypes,
        "Look-back period": row.lookBackPeriod,
        "External metrics": row.externalMetrics,
        "Utilization preferences": row.utilization,
        "Preferred instances": row.preferredResources,
        "Savings estimation mode": row.savingsEstimationMode,
      },
      tabs: [{ id: "json", label: "API response", kind: "json", data: p, description: "GetRecommendationPreferences output for this resource type and scope." }],
    };
  },

  create: {
    title: "Set recommendation preferences",
    description: "Compute Optimizer applies these preferences the next time it refreshes recommendations. Not every preference applies to every resource type; Compute Optimizer rejects combinations it doesn't support.",
    fields: [
      { name: "resourceType", label: "Resource type", kind: "select", required: true, options: RESOURCE_TYPES, default: "Ec2Instance", section: "Scope" },
      {
        name: "scope",
        label: "Scope",
        kind: "radio",
        required: true,
        default: "AccountId",
        section: "Scope",
        options: [
          { value: "AccountId", label: "This account" },
          { value: "Organization", label: "Organization (all member accounts; management account only)" },
          { value: "ResourceArn", label: "One resource (required for Auto Scaling groups)" },
        ],
      },
      { name: "resourceArn", label: "Resource ARN", kind: "text", required: true, section: "Scope", showIf: { field: "scope", equals: "ResourceArn" }, validate: { pattern: "arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:\\d{12}:.+", message: "Enter a resource ARN." } },
      ...PREFERENCE_FIELDS,
    ],
    async run(ctx, v) {
      const resourceType = String(v.resourceType);
      const scopeName = String(v.scope);
      const value = scopeName === "Organization" ? "ALL_ACCOUNTS" : scopeName === "ResourceArn" ? String(v.resourceArn ?? "") : ctx.accountId;
      const scope: Scope = { name: scopeName as ScopeName, value };
      await put(ctx, resourceType, scope, v);
      return preferenceRow({ resourceType, scope: { name: scopeName, value } }).id as string;
    },
  },

  actions: [
    {
      id: "edit",
      label: "Edit preferences",
      fields: PREFERENCE_FIELDS.map((f) => (f.name === "enhancedInfrastructureMetrics" ? { ...f, help: `${f.help ?? ""} A preference set to "-" keeps its current value; use Delete to clear preferences.`.trim() } : f)),
      async initialValues(ctx, id) {
        return preferenceValues(await findPreference(ctx, id));
      },
      async run(ctx, id, v) {
        const { resourceType, scope } = scopeFromId(id);
        const current = await findPreference(ctx, id);
        const before = preferenceValues(current);
        if (JSON.stringify(before) === JSON.stringify(pick(v, Object.keys(before)))) {
          return { message: "No changes: the preferences are unchanged." };
        }
        await put(ctx, resourceType, scope, v, current);
        const row = preferenceRow(await findPreference(ctx, id));
        return { message: `Preferences saved for ${row.resourceType} (${row.scope}).`, json: row };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      const { resourceType, scope } = scopeFromId(id);
      const names = setPreferenceNames(await findPreference(ctx, id));
      if (names.length === 0) throw new Error("Only the savings estimation mode is set here, and DeleteRecommendationPreferences can't remove it.");
      await co(() => ctx.clients.computeoptimizer.send(new DeleteRecommendationPreferencesCommand({ resourceType: resourceType as ResourceType, scope, recommendationPreferenceNames: names })));
    },
  },
};
