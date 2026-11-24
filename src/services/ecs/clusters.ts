/**
 * ECS clusters. The cluster detail screen is hand-built (src/app/ecs/clusters/[cluster])
 * so it can show the cluster's Services and Tasks tabs with links, as the real console does;
 * the Infrastructure, Configuration, Statistics and Tags tabs come from get().
 */

import {
  CreateClusterCommand,
  DeleteClusterCommand,
  PutClusterCapacityProvidersCommand,
  UpdateClusterSettingsCommand,
  type Cluster,
} from "@aws-sdk/client-ecs";
import type { ResourceDef, Row } from "../../console/types.ts";
import { describeClusters, listClusterArns, tagActions, tagsToEcs } from "./common.ts";
import { arnName, containerInsightsText, ECS_NAME, isEcsName, pairsToRecord, strategyText, tagRows } from "./helpers.ts";

const INSIGHTS_OPTIONS = [
  { value: "disabled", label: "Off" },
  { value: "enhanced", label: "Container Insights with enhanced observability (recommended)" },
  { value: "enabled", label: "Container Insights" },
];

const FARGATE_PROVIDERS = [
  { value: "FARGATE", label: "FARGATE" },
  { value: "FARGATE_SPOT", label: "FARGATE_SPOT" },
];

function clusterRow(c: Cluster): Row {
  return {
    name: c.clusterName ?? arnName(c.clusterArn),
    status: c.status ?? null,
    services: c.activeServicesCount ?? 0,
    runningTasks: c.runningTasksCount ?? 0,
    pendingTasks: c.pendingTasksCount ?? 0,
    containerInstances: c.registeredContainerInstancesCount ?? 0,
    monitoring: containerInsightsText(c.settings),
    capacityProviders: (c.capacityProviders ?? []).join(", ") || "No default found",
    arn: c.clusterArn ?? null,
  };
}

/** The cluster's containerInsights setting value ("disabled" when unset). */
function insightsValue(c: Cluster): string {
  return c.settings?.find((s) => s.name === "containerInsights")?.value || "disabled";
}

/** The Update capacity providers form as the cluster is now (first default strategy entry). */
function capacityValues(c: Cluster): { providers: string[]; strategyProvider: string; base: number; weight: number } {
  const first = c.defaultCapacityProviderStrategy?.[0];
  return { providers: c.capacityProviders ?? [], strategyProvider: first?.capacityProvider ?? "", base: first?.base ?? 0, weight: first?.weight ?? 1 };
}

async function describeOne(ctx: Parameters<ResourceDef["list"]>[0], name: string): Promise<Cluster> {
  if (!isEcsName(name)) throw new Error(`"${name}" is not a valid cluster name.`);
  const [c] = await describeClusters(ctx, [name]);
  if (!c || c.status === "INACTIVE") throw new Error(`Cluster ${name} was not found.`);
  return c;
}

export const clusters: ResourceDef = {
  id: "clusters",
  name: "Clusters",
  singular: "cluster",
  idField: "name",
  nameField: "Cluster name",
  description: "An Amazon ECS cluster groups tasks and services, and the infrastructure (here AWS Fargate) they run on.",
  emptyText: "No clusters. Create a cluster to get started.",
  columns: [
    { key: "name", label: "Cluster", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "services", label: "Services", kind: "count" },
    { key: "pendingTasks", label: "Pending tasks", kind: "count" },
    { key: "runningTasks", label: "Running tasks", kind: "count" },
    { key: "containerInstances", label: "Container instances", kind: "count" },
    { key: "monitoring", label: "CloudWatch monitoring", kind: "text" },
    { key: "capacityProviders", label: "Capacity providers", kind: "text" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const arns = await listClusterArns(ctx);
    if (arns.length === 0) return [];
    return (await describeClusters(ctx, arns.map(arnName))).map(clusterRow);
  },

  async get(ctx, name) {
    const c = await describeOne(ctx, name);
    const row = clusterRow(c);
    const stats = pairsToRecord(c.statistics);
    const defaults = new Map((c.defaultCapacityProviderStrategy ?? []).map((s) => [s.capacityProvider ?? "", s]));
    return {
      summary: {
        "Cluster name": row.name,
        Status: row.status,
        ARN: row.arn,
        "CloudWatch monitoring": row.monitoring,
        "Registered container instances": row.containerInstances,
      },
      tabs: [
        {
          id: "infrastructure",
          label: "Infrastructure",
          kind: "table",
          description: `Capacity providers associated with this cluster. Default capacity provider strategy: ${strategyText(c.defaultCapacityProviderStrategy) ?? "none (tasks must choose a launch type or strategy)"}.`,
          columns: [
            { key: "provider", label: "Capacity provider", kind: "text" },
            { key: "type", label: "Type", kind: "text" },
            { key: "default", label: "In default strategy", kind: "text" },
            { key: "weight", label: "Weight", kind: "count" },
            { key: "base", label: "Base", kind: "count" },
          ],
          data: (c.capacityProviders ?? []).map((p) => ({
            provider: p,
            type: p === "FARGATE" || p === "FARGATE_SPOT" ? "Fargate" : "Auto Scaling group",
            default: defaults.has(p) ? "Yes" : "No",
            weight: defaults.get(p)?.weight ?? null,
            base: defaults.get(p)?.base ?? null,
          })),
          emptyText: "No capacity providers are associated with this cluster.",
        },
        {
          id: "configuration",
          label: "Configuration",
          kind: "keyvalue",
          data: {
            "Container Insights": row.monitoring,
            "Active services": c.activeServicesCount ?? 0,
            "Running tasks": c.runningTasksCount ?? 0,
            "Pending tasks": c.pendingTasksCount ?? 0,
            "Execute command configuration": c.configuration?.executeCommandConfiguration ? JSON.stringify(c.configuration.executeCommandConfiguration) : "Default",
            "Service Connect default namespace": c.serviceConnectDefaults?.namespace ?? "None",
            "Attachments status": c.attachmentsStatus ?? null,
          },
        },
        {
          id: "statistics",
          label: "Statistics",
          kind: "table",
          description: "Counts DescribeClusters returns with include STATISTICS.",
          columns: [
            { key: "name", label: "Statistic", kind: "text" },
            { key: "value", label: "Value", kind: "text" },
          ],
          data: Object.entries(stats).map(([k, v]) => ({ name: k, value: v })),
          emptyText: "No statistics were returned.",
        },
        {
          id: "tags",
          label: "Tags",
          kind: "table",
          columns: [
            { key: "Key", label: "Key", kind: "text" },
            { key: "Value", label: "Value", kind: "text" },
          ],
          data: tagRows(c.tags),
          emptyText: "No tags.",
        },
      ],
    };
  },

  create: {
    title: "Create cluster",
    description: "Creates an ECS cluster with CreateCluster. AWS Fargate capacity (FARGATE and FARGATE_SPOT) is associated with every new cluster, as in the console.",
    fields: [
      {
        name: "name", label: "Cluster name", kind: "text", required: true, section: "Cluster configuration", placeholder: "my-cluster",
        help: "There can be a maximum of 255 characters. The valid characters are letters (uppercase and lowercase), numbers, hyphens, and underscores.",
        validate: { pattern: ECS_NAME, message: "Use up to 255 letters, numbers, hyphens and underscores." },
      },
      {
        name: "defaultProvider", label: "Default capacity provider strategy", kind: "radio", default: "none", section: "Infrastructure",
        help: "AWS Fargate (serverless) is always available. Optionally make one Fargate capacity provider the cluster default, so tasks and services that don't choose a launch type use it.",
        options: [
          { value: "none", label: "No default strategy" },
          { value: "FARGATE", label: "FARGATE" },
          { value: "FARGATE_SPOT", label: "FARGATE_SPOT" },
        ],
      },
      { name: "containerInsights", label: "Container Insights", kind: "radio", default: "disabled", section: "Monitoring", options: INSIGHTS_OPTIONS, help: "Collects metrics and logs from your containers with CloudWatch Container Insights." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      const tags = tagsToEcs(v.tags);
      const provider = typeof v.defaultProvider === "string" && v.defaultProvider !== "none" ? v.defaultProvider : null;
      await ctx.clients.ecs.send(
        new CreateClusterCommand({
          clusterName: name,
          capacityProviders: ["FARGATE", "FARGATE_SPOT"],
          defaultCapacityProviderStrategy: provider ? [{ capacityProvider: provider, weight: 1, base: 0 }] : undefined,
          settings: [{ name: "containerInsights", value: typeof v.containerInsights === "string" ? v.containerInsights : "disabled" }],
          tags: tags.length ? tags : undefined,
        })
      );
      return name;
    },
  },

  actions: [
    {
      id: "update-monitoring",
      label: "Update cluster",
      fields: [{ name: "containerInsights", label: "Container Insights", kind: "radio", required: true, default: "disabled", options: INSIGHTS_OPTIONS }],
      async initialValues(ctx, name) {
        return { containerInsights: insightsValue(await describeOne(ctx, name)) };
      },
      async run(ctx, name, v) {
        if (insightsValue(await describeOne(ctx, name)) === v.containerInsights) return { message: "No changes to save." };
        const r = await ctx.clients.ecs.send(new UpdateClusterSettingsCommand({ cluster: name, settings: [{ name: "containerInsights", value: String(v.containerInsights) }] }));
        return { message: `Updated ${name}. CloudWatch monitoring: ${containerInsightsText(r.cluster?.settings)}.` };
      },
    },
    {
      id: "capacity-providers",
      label: "Update capacity providers",
      fields: [
        { name: "providers", label: "Capacity providers", kind: "multiselect", required: true, default: ["FARGATE", "FARGATE_SPOT"], options: FARGATE_PROVIDERS, help: "Capacity providers associated with the cluster." },
        { name: "strategyProvider", label: "Default strategy capacity provider", kind: "select", default: "", options: FARGATE_PROVIDERS, help: "Leave empty for no default strategy." },
        { name: "base", label: "Base", kind: "number", default: 0, validate: { min: 0, max: 100000, message: "Between 0 and 100000." }, help: "Minimum number of tasks to run on this provider." },
        { name: "weight", label: "Weight", kind: "number", default: 1, validate: { min: 0, max: 1000, message: "Between 0 and 1000." } },
      ],
      async initialValues(ctx, name) {
        return capacityValues(await describeOne(ctx, name));
      },
      async run(ctx, name, v) {
        const c = await describeOne(ctx, name);
        const before = capacityValues(c);
        const providers = Array.isArray(v.providers) ? (v.providers as string[]) : [];
        const sp = typeof v.strategyProvider === "string" && v.strategyProvider !== "" ? v.strategyProvider : null;
        if (sp && !providers.includes(sp)) throw new Error("The default strategy must use one of the cluster's capacity providers.");
        const base = typeof v.base === "number" ? v.base : 0;
        const weight = typeof v.weight === "number" ? v.weight : 1;
        const sameProviders = providers.length === before.providers.length && providers.every((p) => before.providers.includes(p));
        const sameStrategy = (sp ?? "") === before.strategyProvider && (!sp || (base === before.base && weight === before.weight));
        if (sameProviders && sameStrategy) return { message: "No changes to save." };
        // An unchanged strategy is sent back as it is (it may have more entries than this form shows).
        const strategy = sameStrategy ? c.defaultCapacityProviderStrategy ?? [] : sp ? [{ capacityProvider: sp, base, weight }] : [];
        const r = await ctx.clients.ecs.send(
          new PutClusterCapacityProvidersCommand({ cluster: name, capacityProviders: providers, defaultCapacityProviderStrategy: strategy })
        );
        return { message: `Capacity providers: ${(r.cluster?.capacityProviders ?? []).join(", ") || "none"}. Default strategy: ${strategyText(r.cluster?.defaultCapacityProviderStrategy) ?? "none"}.` };
      },
    },
    ...tagActions(async (ctx, name) => (await describeOne(ctx, name)).clusterArn ?? ""),
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, name) {
      await ctx.clients.ecs.send(new DeleteClusterCommand({ cluster: name }));
    },
  },
};
