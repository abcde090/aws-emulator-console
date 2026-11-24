/**
 * Compute Optimizer recommendation pages (EC2 instances, Auto Scaling groups, EBS volumes,
 * Lambda functions, idle resources, commercial software licenses). Every value comes from
 * the Get*Recommendations responses; the URL id is the resource's own id, not its ARN.
 */

import {
  GetAutoScalingGroupRecommendationsCommand,
  GetEBSVolumeRecommendationsCommand,
  GetEC2InstanceRecommendationsCommand,
  GetIdleRecommendationsCommand,
  GetLambdaFunctionRecommendationsCommand,
  GetLicenseRecommendationsCommand,
  type AutoScalingGroupRecommendation,
  type IdleRecommendation,
  type InstanceRecommendation,
  type LambdaFunctionRecommendation,
  type LicenseRecommendation,
  type VolumeRecommendation,
} from "@aws-sdk/client-compute-optimizer";
import type { ColumnDef, Ctx, Detail, DetailTab, ResourceDef, Row } from "../../console/types.ts";
import { findingLabel, formatPercent, formatSavings, idFromArn, iso, joinList, lambdaId, metricRows, metricText, optInMessage, tagRows, type Savings } from "./helpers.ts";

/** Runs a Compute Optimizer call, turning the opt-in error into a pointer to the Account page. */
export async function co<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    throw optInMessage(err) ?? err;
  }
}

/** Follows nextToken until the API stops returning one. */
async function allPages<T>(fetch: (token: string | undefined) => Promise<{ items: T[]; next?: string }>): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  for (let i = 0; i < 100; i++) {
    const page = await co(() => fetch(token));
    out.push(...page.items);
    token = page.next;
    if (!token) break;
  }
  return out;
}

const METRIC_COLUMNS: ColumnDef[] = [
  { key: "name", label: "Metric", kind: "text" },
  { key: "statistic", label: "Statistic", kind: "text" },
  { key: "value", label: "Value", kind: "text" },
];
const TAG_COLUMNS: ColumnDef[] = [
  { key: "key", label: "Key", kind: "text" },
  { key: "value", label: "Value", kind: "text" },
];

function commonTabs(r: { utilizationMetrics?: unknown; tags?: { key?: string; value?: string }[]; effectiveRecommendationPreferences?: unknown }, metricsDescription: string): DetailTab[] {
  const tabs: DetailTab[] = [
    { id: "utilization", label: "Utilization metrics", kind: "table", columns: METRIC_COLUMNS, data: metricRows(r.utilizationMetrics as { name?: string; statistic?: string; value?: number }[] | undefined), description: metricsDescription, emptyText: "No utilization metrics were returned." },
    { id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: tagRows(r.tags), emptyText: "No tags." },
  ];
  if (r.effectiveRecommendationPreferences !== undefined) {
    tabs.push({ id: "preferences", label: "Effective recommendation preferences", kind: "json", data: r.effectiveRecommendationPreferences, description: "The preferences Compute Optimizer applied when it generated this recommendation." });
  }
  return tabs;
}

interface RecConfig<T> {
  id: string;
  name: string;
  singular: string;
  description: string;
  emptyText: string;
  columns: ColumnDef[];
  fetchAll(ctx: Ctx): Promise<T[]>;
  row(r: T): Row;
  detail(r: T): Detail;
}

function recResource<T>(c: RecConfig<T>): ResourceDef {
  return {
    id: c.id,
    name: c.name,
    singular: c.singular,
    idField: "id",
    nameField: "name",
    description: c.description,
    emptyText: c.emptyText,
    columns: c.columns,
    async list(ctx) {
      return (await c.fetchAll(ctx)).map((r) => c.row(r));
    },
    async get(ctx, id) {
      const found = (await c.fetchAll(ctx)).find((r) => c.row(r).id === id);
      if (!found) throw new Error(`Compute Optimizer has no ${c.singular} recommendation for ${id}.`);
      return c.detail(found);
    },
  };
}

const savingsCols: ColumnDef[] = [
  { key: "savings", label: "Estimated monthly savings (on-demand)", kind: "text" },
  { key: "savingsPercent", label: "Savings opportunity (%)", kind: "text" },
];

// ---- EC2 instances ----

function ec2Row(r: InstanceRecommendation): Row {
  const best = r.recommendationOptions?.find((o) => o.rank === 1) ?? r.recommendationOptions?.[0];
  return {
    id: idFromArn(r.instanceArn),
    name: r.instanceName || idFromArn(r.instanceArn),
    arn: r.instanceArn ?? null,
    finding: findingLabel(r.finding),
    findingReasons: joinList(r.findingReasonCodes),
    currentType: r.currentInstanceType ?? null,
    recommendedType: best?.instanceType ?? null,
    savings: formatSavings(best?.savingsOpportunity as Savings | undefined),
    savingsPercent: formatPercent(best?.savingsOpportunity as Savings | undefined),
    performanceRisk: r.currentPerformanceRisk ?? null,
    migrationEffort: best?.migrationEffort ?? null,
    state: r.instanceState ?? null,
    lastRefresh: iso(r.lastRefreshTimestamp),
  };
}

const ec2Instances = recResource<InstanceRecommendation>({
  id: "ec2-instances",
  name: "EC2 instances",
  singular: "EC2 instance",
  description: "Recommendations for EC2 instance types, based on the instances' utilization over the look-back period.",
  emptyText: "No EC2 instance recommendations. Compute Optimizer returned none for this account.",
  columns: [
    { key: "name", label: "Instance name", kind: "link" },
    { key: "id", label: "Instance ID", kind: "text" },
    { key: "finding", label: "Finding", kind: "status" },
    { key: "findingReasons", label: "Finding reasons", kind: "text" },
    { key: "currentType", label: "Current instance type", kind: "text" },
    { key: "recommendedType", label: "Recommended instance type", kind: "text" },
    ...savingsCols,
    { key: "performanceRisk", label: "Current performance risk", kind: "text" },
    { key: "migrationEffort", label: "Migration effort", kind: "text" },
    { key: "lastRefresh", label: "Last refreshed", kind: "date", hidden: true },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],
  fetchAll: (ctx) =>
    allPages(async (token) => {
      const r = await ctx.clients.computeoptimizer.send(new GetEC2InstanceRecommendationsCommand({ nextToken: token }));
      return { items: r.instanceRecommendations ?? [], next: r.nextToken };
    }),
  row: ec2Row,
  detail(r) {
    const row = ec2Row(r);
    return {
      summary: {
        "Instance name": row.name,
        "Instance ID": row.id,
        Finding: row.finding,
        "Finding reasons": row.findingReasons,
        "Current instance type": row.currentType,
        "Current performance risk": row.performanceRisk,
        "Instance state": row.state,
        "Inferred workload types": joinList(r.inferredWorkloadTypes),
        "Look-back period (days)": r.lookBackPeriodInDays ?? null,
        "Last refreshed": row.lastRefresh,
        ARN: row.arn,
      },
      tabs: [
        {
          id: "options",
          label: "Recommended instance type options",
          kind: "table",
          columns: [
            { key: "rank", label: "Option", kind: "count" },
            { key: "instanceType", label: "Instance type", kind: "text" },
            { key: "savings", label: "Estimated monthly savings", kind: "text" },
            { key: "savingsPercent", label: "Savings opportunity (%)", kind: "text" },
            { key: "performanceRisk", label: "Performance risk", kind: "text" },
            { key: "migrationEffort", label: "Migration effort", kind: "text" },
            { key: "platformDifferences", label: "Platform differences", kind: "text" },
            { key: "projectedCpu", label: "Projected CPU (max %)", kind: "text" },
            { key: "projectedMemory", label: "Projected memory (max %)", kind: "text" },
          ],
          data: (r.recommendationOptions ?? []).map((o) => ({
            rank: o.rank ?? null,
            instanceType: o.instanceType ?? null,
            savings: formatSavings(o.savingsOpportunity as Savings | undefined),
            savingsPercent: formatPercent(o.savingsOpportunity as Savings | undefined),
            performanceRisk: o.performanceRisk ?? null,
            migrationEffort: o.migrationEffort ?? null,
            platformDifferences: joinList(o.platformDifferences),
            projectedCpu: metricText(o.projectedUtilizationMetrics, "Cpu"),
            projectedMemory: metricText(o.projectedUtilizationMetrics, "Memory"),
          })),
          emptyText: "No recommendation options.",
        },
        ...commonTabs(r, "Maximum utilization of the current instance over the look-back period."),
      ],
    };
  },
});

// ---- Auto Scaling groups ----

function asgConfig(c: { instanceType?: string; desiredCapacity?: number; minSize?: number; maxSize?: number } | undefined): string | null {
  if (!c) return null;
  return `${c.instanceType ?? "?"} (desired ${c.desiredCapacity ?? "-"}, min ${c.minSize ?? "-"}, max ${c.maxSize ?? "-"})`;
}

function asgRow(r: AutoScalingGroupRecommendation): Row {
  const best = r.recommendationOptions?.find((o) => o.rank === 1) ?? r.recommendationOptions?.[0];
  return {
    id: r.autoScalingGroupName ?? idFromArn(r.autoScalingGroupArn),
    name: r.autoScalingGroupName ?? idFromArn(r.autoScalingGroupArn),
    arn: r.autoScalingGroupArn ?? null,
    finding: findingLabel(r.finding),
    currentType: r.currentConfiguration?.instanceType ?? null,
    recommendedType: best?.configuration?.instanceType ?? null,
    savings: formatSavings(best?.savingsOpportunity as Savings | undefined),
    savingsPercent: formatPercent(best?.savingsOpportunity as Savings | undefined),
    performanceRisk: r.currentPerformanceRisk ?? null,
    migrationEffort: best?.migrationEffort ?? null,
    lastRefresh: iso(r.lastRefreshTimestamp),
  };
}

const autoScalingGroups = recResource<AutoScalingGroupRecommendation>({
  id: "auto-scaling-groups",
  name: "Auto Scaling groups",
  singular: "Auto Scaling group",
  description: "Recommendations for the instance type of Auto Scaling groups.",
  emptyText: "No Auto Scaling group recommendations. Compute Optimizer returned none for this account.",
  columns: [
    { key: "name", label: "Auto Scaling group name", kind: "link" },
    { key: "finding", label: "Finding", kind: "status" },
    { key: "currentType", label: "Current instance type", kind: "text" },
    { key: "recommendedType", label: "Recommended instance type", kind: "text" },
    ...savingsCols,
    { key: "performanceRisk", label: "Current performance risk", kind: "text" },
    { key: "migrationEffort", label: "Migration effort", kind: "text" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],
  fetchAll: (ctx) =>
    allPages(async (token) => {
      const r = await ctx.clients.computeoptimizer.send(new GetAutoScalingGroupRecommendationsCommand({ nextToken: token }));
      return { items: r.autoScalingGroupRecommendations ?? [], next: r.nextToken };
    }),
  row: asgRow,
  detail(r) {
    const row = asgRow(r);
    return {
      summary: {
        "Auto Scaling group name": row.name,
        Finding: row.finding,
        "Current configuration": asgConfig(r.currentConfiguration),
        "Current performance risk": row.performanceRisk,
        "Inferred workload types": joinList(r.inferredWorkloadTypes),
        "Look-back period (days)": r.lookBackPeriodInDays ?? null,
        "Last refreshed": row.lastRefresh,
        ARN: row.arn,
      },
      tabs: [
        {
          id: "options",
          label: "Recommended options",
          kind: "table",
          columns: [
            { key: "rank", label: "Option", kind: "count" },
            { key: "configuration", label: "Configuration", kind: "text" },
            { key: "savings", label: "Estimated monthly savings", kind: "text" },
            { key: "savingsPercent", label: "Savings opportunity (%)", kind: "text" },
            { key: "performanceRisk", label: "Performance risk", kind: "text" },
            { key: "migrationEffort", label: "Migration effort", kind: "text" },
          ],
          data: (r.recommendationOptions ?? []).map((o) => ({
            rank: o.rank ?? null,
            configuration: asgConfig(o.configuration),
            savings: formatSavings(o.savingsOpportunity as Savings | undefined),
            savingsPercent: formatPercent(o.savingsOpportunity as Savings | undefined),
            performanceRisk: o.performanceRisk ?? null,
            migrationEffort: o.migrationEffort ?? null,
          })),
          emptyText: "No recommendation options.",
        },
        ...commonTabs({ ...r, tags: undefined }, "Maximum utilization of the group's instances over the look-back period.").filter((t) => t.id !== "tags"),
      ],
    };
  },
});

// ---- EBS volumes ----

function volumeConfig(c: { volumeType?: string; volumeSize?: number; volumeBaselineIOPS?: number; volumeBaselineThroughput?: number } | undefined): string | null {
  if (!c) return null;
  return `${c.volumeType ?? "?"}, ${c.volumeSize ?? "-"} GiB, ${c.volumeBaselineIOPS ?? "-"} IOPS, ${c.volumeBaselineThroughput ?? "-"} MiB/s`;
}

function ebsRow(r: VolumeRecommendation): Row {
  const best = r.volumeRecommendationOptions?.find((o) => o.rank === 1) ?? r.volumeRecommendationOptions?.[0];
  return {
    id: idFromArn(r.volumeArn),
    name: idFromArn(r.volumeArn),
    arn: r.volumeArn ?? null,
    finding: findingLabel(r.finding),
    current: volumeConfig(r.currentConfiguration),
    recommended: volumeConfig(best?.configuration),
    savings: formatSavings(best?.savingsOpportunity as Savings | undefined),
    savingsPercent: formatPercent(best?.savingsOpportunity as Savings | undefined),
    performanceRisk: r.currentPerformanceRisk ?? null,
    lastRefresh: iso(r.lastRefreshTimestamp),
  };
}

const ebsVolumes = recResource<VolumeRecommendation>({
  id: "ebs-volumes",
  name: "EBS volumes",
  singular: "EBS volume",
  description: "Recommendations for EBS volume type, size, IOPS and throughput.",
  emptyText: "No EBS volume recommendations. Compute Optimizer returned none for this account.",
  columns: [
    { key: "name", label: "Volume ID", kind: "link" },
    { key: "finding", label: "Finding", kind: "status" },
    { key: "current", label: "Current configuration", kind: "text" },
    { key: "recommended", label: "Recommended configuration", kind: "text" },
    ...savingsCols,
    { key: "performanceRisk", label: "Current performance risk", kind: "text" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],
  fetchAll: (ctx) =>
    allPages(async (token) => {
      const r = await ctx.clients.computeoptimizer.send(new GetEBSVolumeRecommendationsCommand({ nextToken: token }));
      return { items: r.volumeRecommendations ?? [], next: r.nextToken };
    }),
  row: ebsRow,
  detail(r) {
    const row = ebsRow(r);
    return {
      summary: { "Volume ID": row.id, Finding: row.finding, "Current configuration": row.current, "Root volume": r.currentConfiguration?.rootVolume ?? null, "Current performance risk": row.performanceRisk, "Last refreshed": row.lastRefresh, ARN: row.arn },
      tabs: [
        {
          id: "options",
          label: "Recommended options",
          kind: "table",
          columns: [
            { key: "rank", label: "Option", kind: "count" },
            { key: "configuration", label: "Configuration", kind: "text" },
            { key: "savings", label: "Estimated monthly savings", kind: "text" },
            { key: "performanceRisk", label: "Performance risk", kind: "text" },
          ],
          data: (r.volumeRecommendationOptions ?? []).map((o) => ({ rank: o.rank ?? null, configuration: volumeConfig(o.configuration), savings: formatSavings(o.savingsOpportunity as Savings | undefined), performanceRisk: o.performanceRisk ?? null })),
          emptyText: "No recommendation options.",
        },
        ...commonTabs(r, "Utilization of the volume over the look-back period."),
      ],
    };
  },
});

// ---- Lambda functions ----

function lambdaRow(r: LambdaFunctionRecommendation): Row {
  const best = r.memorySizeRecommendationOptions?.find((o) => o.rank === 1) ?? r.memorySizeRecommendationOptions?.[0];
  const id = lambdaId(r.functionArn, r.functionVersion);
  return {
    id,
    name: id,
    arn: r.functionArn ?? null,
    finding: findingLabel(r.finding),
    findingReasons: joinList(r.findingReasonCodes),
    currentMemory: r.currentMemorySize ?? null,
    recommendedMemory: best?.memorySize ?? null,
    invocations: r.numberOfInvocations ?? null,
    savings: formatSavings(best?.savingsOpportunity as Savings | undefined),
    savingsPercent: formatPercent(best?.savingsOpportunity as Savings | undefined),
    performanceRisk: r.currentPerformanceRisk ?? null,
    lastRefresh: iso(r.lastRefreshTimestamp),
  };
}

const lambdaFunctions = recResource<LambdaFunctionRecommendation>({
  id: "lambda-functions",
  name: "Lambda functions",
  singular: "Lambda function",
  description: "Recommendations for the memory size of Lambda functions.",
  emptyText: "No Lambda function recommendations. Compute Optimizer returned none for this account.",
  columns: [
    { key: "name", label: "Function name", kind: "link" },
    { key: "finding", label: "Finding", kind: "status" },
    { key: "findingReasons", label: "Finding reasons", kind: "text" },
    { key: "currentMemory", label: "Current configured memory (MB)", kind: "count" },
    { key: "recommendedMemory", label: "Recommended configured memory (MB)", kind: "count" },
    ...savingsCols,
    { key: "performanceRisk", label: "Current performance risk", kind: "text" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],
  fetchAll: (ctx) =>
    allPages(async (token) => {
      const r = await ctx.clients.computeoptimizer.send(new GetLambdaFunctionRecommendationsCommand({ nextToken: token }));
      return { items: r.lambdaFunctionRecommendations ?? [], next: r.nextToken };
    }),
  row: lambdaRow,
  detail(r) {
    const row = lambdaRow(r);
    return {
      summary: {
        "Function name": row.name,
        Finding: row.finding,
        "Finding reasons": row.findingReasons,
        "Current configured memory (MB)": row.currentMemory,
        "Invocations in look-back period": row.invocations,
        "Current performance risk": row.performanceRisk,
        "Look-back period (days)": r.lookbackPeriodInDays ?? null,
        "Last refreshed": row.lastRefresh,
        ARN: row.arn,
      },
      tabs: [
        {
          id: "options",
          label: "Recommended memory options",
          kind: "table",
          columns: [
            { key: "rank", label: "Option", kind: "count" },
            { key: "memorySize", label: "Memory (MB)", kind: "count" },
            { key: "savings", label: "Estimated monthly savings", kind: "text" },
            { key: "savingsPercent", label: "Savings opportunity (%)", kind: "text" },
            { key: "durationExpected", label: "Projected duration, expected (ms)", kind: "text" },
          ],
          data: (r.memorySizeRecommendationOptions ?? []).map((o) => ({
            rank: o.rank ?? null,
            memorySize: o.memorySize ?? null,
            savings: formatSavings(o.savingsOpportunity as Savings | undefined),
            savingsPercent: formatPercent(o.savingsOpportunity as Savings | undefined),
            durationExpected: metricText(o.projectedUtilizationMetrics, "Duration", "Expected"),
          })),
          emptyText: "No recommendation options.",
        },
        ...commonTabs(r, "Duration and memory used over the look-back period."),
      ],
    };
  },
});

// ---- Idle resources ----

function idleRow(r: IdleRecommendation): Row {
  return {
    id: r.resourceId ?? idFromArn(r.resourceArn),
    name: r.resourceId ?? idFromArn(r.resourceArn),
    arn: r.resourceArn ?? null,
    resourceType: r.resourceType ?? null,
    finding: findingLabel(r.finding),
    description: r.findingDescription ?? null,
    savings: formatSavings(r.savingsOpportunity as Savings | undefined),
    savingsPercent: formatPercent(r.savingsOpportunity as Savings | undefined),
    lastRefresh: iso(r.lastRefreshTimestamp),
  };
}

const idleResources = recResource<IdleRecommendation>({
  id: "idle-resources",
  name: "Idle resources",
  singular: "idle resource",
  description: "Resources that were idle, unused or unattached over the look-back period. Stopping or deleting them saves their whole cost.",
  emptyText: "No idle resource recommendations. Compute Optimizer returned none for this account.",
  columns: [
    { key: "name", label: "Resource ID", kind: "link" },
    { key: "resourceType", label: "Resource type", kind: "text" },
    { key: "finding", label: "Finding", kind: "status" },
    { key: "description", label: "Finding description", kind: "text" },
    ...savingsCols,
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],
  fetchAll: (ctx) =>
    allPages(async (token) => {
      const r = await ctx.clients.computeoptimizer.send(new GetIdleRecommendationsCommand({ nextToken: token }));
      return { items: r.idleRecommendations ?? [], next: r.nextToken };
    }),
  row: idleRow,
  detail(r) {
    const row = idleRow(r);
    return {
      summary: {
        "Resource ID": row.id,
        "Resource type": row.resourceType,
        Finding: row.finding,
        "Finding description": row.description,
        "Estimated monthly savings": row.savings,
        "Savings after discounts": formatSavings(r.savingsOpportunityAfterDiscounts as Savings | undefined),
        "Look-back period (days)": r.lookBackPeriodInDays ?? null,
        "Last refreshed": row.lastRefresh,
        ARN: row.arn,
      },
      tabs: commonTabs(r, "Utilization of the resource over the look-back period."),
    };
  },
});

// ---- Commercial software licenses ----

function licenseRow(r: LicenseRecommendation): Row {
  const best = r.licenseRecommendationOptions?.find((o) => o.rank === 1) ?? r.licenseRecommendationOptions?.[0];
  const c = r.currentLicenseConfiguration;
  return {
    id: idFromArn(r.resourceArn),
    name: idFromArn(r.resourceArn),
    arn: r.resourceArn ?? null,
    finding: findingLabel(r.finding),
    findingReasons: joinList(r.findingReasonCodes),
    license: c ? `${c.licenseName ?? "?"} ${c.licenseEdition ?? ""} ${c.licenseVersion ?? ""}`.replace(/\s+/g, " ").trim() : null,
    instanceType: c?.instanceType ?? null,
    recommendedEdition: best?.licenseEdition ?? null,
    savings: formatSavings(best?.savingsOpportunity as Savings | undefined),
    savingsPercent: formatPercent(best?.savingsOpportunity as Savings | undefined),
    lastRefresh: iso(r.lastRefreshTimestamp),
  };
}

const licenses = recResource<LicenseRecommendation>({
  id: "licenses",
  name: "Licenses",
  singular: "license",
  description: "Recommendations for commercial software licenses (for example SQL Server editions) running on EC2 instances.",
  emptyText: "No license recommendations. Compute Optimizer returned none for this account.",
  columns: [
    { key: "name", label: "Instance ID", kind: "link" },
    { key: "finding", label: "Finding", kind: "status" },
    { key: "findingReasons", label: "Finding reasons", kind: "text" },
    { key: "license", label: "Current license", kind: "text" },
    { key: "instanceType", label: "Instance type", kind: "text" },
    { key: "recommendedEdition", label: "Recommended edition", kind: "text" },
    ...savingsCols,
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],
  fetchAll: (ctx) =>
    allPages(async (token) => {
      const r = await ctx.clients.computeoptimizer.send(new GetLicenseRecommendationsCommand({ nextToken: token }));
      return { items: r.licenseRecommendations ?? [], next: r.nextToken };
    }),
  row: licenseRow,
  detail(r) {
    const row = licenseRow(r);
    const c = r.currentLicenseConfiguration;
    return {
      summary: {
        "Instance ID": row.id,
        Finding: row.finding,
        "Finding reasons": row.findingReasons,
        "Current license": row.license,
        "License model": c?.licenseModel ?? null,
        "Operating system": c?.operatingSystem ?? null,
        "Number of cores": c?.numberOfCores ?? null,
        "Instance type": row.instanceType,
        "Last refreshed": row.lastRefresh,
        ARN: row.arn,
      },
      tabs: [
        {
          id: "options",
          label: "Recommended options",
          kind: "table",
          columns: [
            { key: "rank", label: "Option", kind: "count" },
            { key: "edition", label: "License edition", kind: "text" },
            { key: "model", label: "License model", kind: "text" },
            { key: "os", label: "Operating system", kind: "text" },
            { key: "savings", label: "Estimated monthly savings", kind: "text" },
            { key: "savingsPercent", label: "Savings opportunity (%)", kind: "text" },
          ],
          data: (r.licenseRecommendationOptions ?? []).map((o) => ({
            rank: o.rank ?? null,
            edition: o.licenseEdition ?? null,
            model: o.licenseModel ?? null,
            os: o.operatingSystem ?? null,
            savings: formatSavings(o.savingsOpportunity as Savings | undefined),
            savingsPercent: formatPercent(o.savingsOpportunity as Savings | undefined),
          })),
          emptyText: "No recommendation options.",
        },
        { id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: tagRows(r.tags), emptyText: "No tags." },
      ],
    };
  },
});

export const recommendationResources: ResourceDef[] = [ec2Instances, autoScalingGroups, ebsVolumes, lambdaFunctions, idleResources, licenses];
