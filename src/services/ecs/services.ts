/**
 * ECS services. A service lives inside a cluster, so its console id is "<cluster>/<service>".
 * The detail screen is hand-built (src/app/ecs/services/[id]) to add the service's Tasks tab
 * with links; everything else comes from get().
 */

import {
  CreateServiceCommand,
  DeleteServiceCommand,
  DescribeServiceDeploymentsCommand,
  DescribeServicesCommand,
  ListServiceDeploymentsCommand,
  ListServicesCommand,
  UpdateServiceCommand,
  type CreateServiceCommandInput,
  type Service,
} from "@aws-sdk/client-ecs";
import { DescribeTargetHealthCommand } from "@aws-sdk/client-elastic-load-balancing-v2";
import { errorMessage } from "../../console/serialize.ts";
import type { Ctx, FieldValues, ResourceDef, Row } from "../../console/types.ts";
import { awsvpcConfig, clusterNames, clusterOptions, NETWORK_FIELDS, tagActions, tagsToEcs, targetGroupOptions, taskDefinitionOptions } from "./common.ts";
import { arnName, chunk, clusterFromArn, ECS_NAME, joinId, splitId, strategyText, tagRows, taskDefinitionLabel } from "./helpers.ts";

async function listServiceArns(ctx: Ctx, cluster: string): Promise<string[]> {
  const arns: string[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.ecs.send(new ListServicesCommand({ cluster, nextToken: token, maxResults: 100 }));
    arns.push(...(r.serviceArns ?? []));
    token = r.nextToken;
  } while (token);
  return arns;
}

export async function describeServicesIn(ctx: Ctx, cluster: string): Promise<Service[]> {
  const arns = await listServiceArns(ctx, cluster);
  const out: Service[] = [];
  for (const part of chunk(arns, 10)) {
    const r = await ctx.clients.ecs.send(new DescribeServicesCommand({ cluster, services: part }));
    out.push(...(r.services ?? []));
  }
  return out;
}

async function describeService(ctx: Ctx, id: string): Promise<Service> {
  const { cluster, name } = splitId(id, "service");
  const r = await ctx.clients.ecs.send(new DescribeServicesCommand({ cluster, services: [name], include: ["TAGS"] }));
  const s = r.services?.[0];
  if (!s) throw new Error(`Service ${name} was not found in cluster ${cluster}${r.failures?.[0]?.reason ? ` (${r.failures[0].reason})` : ""}.`);
  return s;
}

function computeText(s: Service): string {
  return s.launchType ?? strategyText(s.capacityProviderStrategy) ?? "Cluster default";
}

export function serviceRow(s: Service): Row {
  const cluster = clusterFromArn(s.clusterArn) || clusterFromArn(s.serviceArn);
  const name = s.serviceName ?? arnName(s.serviceArn);
  const primary = s.deployments?.find((d) => d.status === "PRIMARY");
  return {
    id: joinId(cluster, name),
    name,
    cluster,
    status: s.status ?? null,
    serviceType: s.schedulingStrategy === "DAEMON" ? "Daemon" : "Replica",
    deployment: primary?.rolloutState ?? null,
    desired: s.desiredCount ?? 0,
    running: s.runningCount ?? 0,
    pending: s.pendingCount ?? 0,
    taskDefinition: taskDefinitionLabel(s.taskDefinition),
    compute: computeText(s),
    created: s.createdAt ?? null,
    arn: s.serviceArn ?? null,
  };
}

async function targetHealthText(ctx: Ctx, targetGroupArn: string): Promise<string> {
  try {
    const r = await ctx.clients.elbv2.send(new DescribeTargetHealthCommand({ TargetGroupArn: targetGroupArn }));
    const list = r.TargetHealthDescriptions ?? [];
    if (list.length === 0) return "No registered targets";
    const counts = new Map<string, number>();
    for (const t of list) counts.set(t.TargetHealth?.State ?? "unknown", (counts.get(t.TargetHealth?.State ?? "unknown") ?? 0) + 1);
    return [...counts].map(([state, n]) => `${n} ${state}`).join(", ");
  } catch (err: unknown) {
    return `Could not read target health: ${errorMessage(err)}`;
  }
}

async function serviceDeploymentRows(ctx: Ctx, s: Service): Promise<{ rows: Row[]; error: string | null }> {
  try {
    const cluster = clusterFromArn(s.clusterArn);
    const list = await ctx.clients.ecs.send(new ListServiceDeploymentsCommand({ cluster, service: s.serviceName, maxResults: 20 }));
    const arns = (list.serviceDeployments ?? []).map((d) => d.serviceDeploymentArn).filter((a): a is string => Boolean(a));
    if (arns.length === 0) return { rows: [], error: null };
    const r = await ctx.clients.ecs.send(new DescribeServiceDeploymentsCommand({ serviceDeploymentArns: arns }));
    const rows = (r.serviceDeployments ?? []).map((d) => ({
      id: arnName(d.serviceDeploymentArn),
      status: d.status ?? null,
      reason: d.statusReason ?? null,
      target: arnName(d.targetServiceRevision?.arn),
      requested: d.targetServiceRevision?.requestedTaskCount ?? null,
      running: d.targetServiceRevision?.runningTaskCount ?? null,
      rollback: d.rollback ? `${d.rollback.reason ?? "Rolled back"}` : null,
      created: d.createdAt ?? null,
      finished: d.finishedAt ?? null,
    }));
    rows.sort((a, b) => String(b.created ?? "").localeCompare(String(a.created ?? "")));
    return { rows, error: null };
  } catch (err: unknown) {
    return { rows: [], error: errorMessage(err) };
  }
}

function deploymentConfiguration(v: FieldValues): CreateServiceCommandInput["deploymentConfiguration"] {
  return {
    minimumHealthyPercent: typeof v.minHealthy === "number" ? v.minHealthy : 100,
    maximumPercent: typeof v.maxPercent === "number" ? v.maxPercent : 200,
    deploymentCircuitBreaker: { enable: v.circuitBreaker === true, rollback: v.circuitBreaker === true && v.rollback === true },
  };
}

function computeInput(v: FieldValues): Pick<CreateServiceCommandInput, "launchType" | "capacityProviderStrategy" | "platformVersion"> {
  const platformVersion = typeof v.platformVersion === "string" && v.platformVersion ? v.platformVersion : undefined;
  if (v.compute === "launchType") return { launchType: "FARGATE", platformVersion };
  if (v.compute === "capacityProvider") {
    return { capacityProviderStrategy: [{ capacityProvider: String(v.capacityProvider), weight: 1, base: 0 }], platformVersion };
  }
  return { platformVersion };
}

export const COMPUTE_FIELDS = (section: string) => [
  {
    name: "compute", label: "Compute options", kind: "radio" as const, default: "launchType", section,
    options: [
      { value: "launchType", label: "Launch type: launch tasks directly on AWS Fargate" },
      { value: "capacityProvider", label: "Capacity provider strategy: use a Fargate capacity provider" },
      { value: "default", label: "Cluster default strategy (the cluster needs a default capacity provider strategy)" },
    ],
  },
  {
    name: "capacityProvider", label: "Capacity provider", kind: "select" as const, required: true, section, showIf: { field: "compute", equals: "capacityProvider" },
    options: [
      { value: "FARGATE", label: "FARGATE" },
      { value: "FARGATE_SPOT", label: "FARGATE_SPOT" },
    ],
    help: "Must be associated with the cluster.",
  },
  {
    name: "platformVersion", label: "Platform version", kind: "select" as const, required: true, default: "LATEST", section,
    options: [
      { value: "LATEST", label: "LATEST" },
      { value: "1.4.0", label: "1.4.0" },
      { value: "1.3.0", label: "1.3.0" },
    ],
  },
];

export const services: ResourceDef = {
  id: "services",
  name: "Services",
  singular: "service",
  idField: "id",
  nameField: "Service name",
  description: "Services keep a desired number of tasks running from a task definition, optionally behind a load balancer. Each service belongs to a cluster.",
  emptyText: "No services. Create a service in a cluster to get started.",
  columns: [
    { key: "name", label: "Service name", kind: "link" },
    { key: "cluster", label: "Cluster", kind: "text" },
    { key: "status", label: "Status", kind: "status" },
    { key: "serviceType", label: "Service type", kind: "text" },
    { key: "deployment", label: "Deployments and tasks", kind: "status" },
    { key: "desired", label: "Desired tasks", kind: "count" },
    { key: "running", label: "Running tasks", kind: "count" },
    { key: "pending", label: "Pending tasks", kind: "count" },
    { key: "taskDefinition", label: "Task definition", kind: "text" },
    { key: "compute", label: "Launch type", kind: "text" },
    { key: "created", label: "Created", kind: "date", hidden: true },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const rows: Row[] = [];
    for (const cluster of await clusterNames(ctx)) rows.push(...(await describeServicesIn(ctx, cluster)).map(serviceRow));
    return rows;
  },

  async get(ctx, id) {
    const s = await describeService(ctx, id);
    const row = serviceRow(s);
    const net = s.networkConfiguration?.awsvpcConfiguration;
    const dc = s.deploymentConfiguration;
    const [deps, lbRows] = await Promise.all([
      serviceDeploymentRows(ctx, s),
      Promise.all((s.loadBalancers ?? []).map(async (lb) => ({
        targetGroup: lb.targetGroupArn ?? lb.loadBalancerName ?? null,
        container: lb.containerName ?? null,
        port: lb.containerPort ?? null,
        health: lb.targetGroupArn ? await targetHealthText(ctx, lb.targetGroupArn) : null,
      }))),
    ]);
    return {
      summary: {
        "Service name": row.name,
        Cluster: row.cluster,
        Status: row.status,
        "Task definition: revision": row.taskDefinition,
        "Desired tasks": row.desired,
        "Running tasks": row.running,
        "Pending tasks": row.pending,
        ARN: row.arn,
      },
      tabs: [
        {
          id: "health",
          label: "Deployments",
          kind: "table",
          description: "Current deployments (DescribeServices). The PRIMARY deployment is the one ECS is rolling out.",
          columns: [
            { key: "id", label: "Deployment ID", kind: "text" },
            { key: "status", label: "Status", kind: "status" },
            { key: "rollout", label: "Rollout state", kind: "status" },
            { key: "taskDefinition", label: "Task definition", kind: "text" },
            { key: "desired", label: "Desired", kind: "count" },
            { key: "pending", label: "Pending", kind: "count" },
            { key: "running", label: "Running", kind: "count" },
            { key: "failed", label: "Failed tasks", kind: "count" },
            { key: "updated", label: "Updated", kind: "date" },
            { key: "reason", label: "Rollout state reason", kind: "text" },
          ],
          data: (s.deployments ?? []).map((d) => ({
            id: d.id ?? "",
            status: d.status ?? null,
            rollout: d.rolloutState ?? null,
            taskDefinition: taskDefinitionLabel(d.taskDefinition),
            desired: d.desiredCount ?? 0,
            pending: d.pendingCount ?? 0,
            running: d.runningCount ?? 0,
            failed: d.failedTasks ?? 0,
            updated: d.updatedAt ?? null,
            reason: d.rolloutStateReason ?? null,
          })),
          emptyText: "No deployments.",
        },
        {
          id: "service-deployments",
          label: "Deployment history",
          kind: "table",
          description: deps.error ? `ListServiceDeployments failed: ${deps.error}` : "Service deployments (ListServiceDeployments / DescribeServiceDeployments), newest first.",
          columns: [
            { key: "id", label: "Service deployment", kind: "text" },
            { key: "status", label: "Status", kind: "status" },
            { key: "target", label: "Target service revision", kind: "text" },
            { key: "requested", label: "Requested tasks", kind: "count" },
            { key: "running", label: "Running tasks", kind: "count" },
            { key: "created", label: "Created", kind: "date" },
            { key: "finished", label: "Finished", kind: "date" },
            { key: "reason", label: "Status reason", kind: "text" },
            { key: "rollback", label: "Rollback", kind: "text" },
          ],
          data: deps.rows,
          emptyText: deps.error ? "Deployment history could not be loaded." : "No service deployments.",
        },
        {
          id: "events",
          label: "Events",
          kind: "table",
          columns: [
            { key: "created", label: "Started at", kind: "date" },
            { key: "message", label: "Message", kind: "text" },
            { key: "id", label: "Event ID", kind: "text" },
          ],
          data: (s.events ?? []).map((e) => ({ created: e.createdAt ?? null, message: e.message ?? "", id: e.id ?? "" })),
          emptyText: "No events yet.",
        },
        {
          id: "configuration",
          label: "Configuration and networking",
          kind: "keyvalue",
          data: {
            "Service type": row.serviceType,
            "Launch type / capacity provider strategy": row.compute,
            "Platform version": s.platformVersion ?? null,
            "Platform family": s.platformFamily ?? null,
            "Minimum healthy percent": dc?.minimumHealthyPercent ?? null,
            "Maximum percent": dc?.maximumPercent ?? null,
            "Deployment circuit breaker": dc?.deploymentCircuitBreaker ? (dc.deploymentCircuitBreaker.enable ? `Turned on${dc.deploymentCircuitBreaker.rollback ? ", with rollback" : ""}` : "Turned off") : null,
            "Deployment controller": s.deploymentController?.type ?? null,
            "Health check grace period (seconds)": s.healthCheckGracePeriodSeconds ?? null,
            Subnets: net?.subnets?.join(", ") ?? null,
            "Security groups": net?.securityGroups?.join(", ") ?? null,
            "Public IP": net?.assignPublicIp ?? null,
            "Service role": s.roleArn ?? null,
            "ECS Exec": s.enableExecuteCommand ? "Turned on" : "Turned off",
            "Propagate tags from": s.propagateTags ?? null,
            "Created at": s.createdAt ?? null,
            "Created by": s.createdBy ?? null,
          },
        },
        {
          id: "load-balancers",
          label: "Load balancing",
          kind: "table",
          columns: [
            { key: "targetGroup", label: "Target group", kind: "arn" },
            { key: "container", label: "Container", kind: "text" },
            { key: "port", label: "Container port", kind: "count" },
            { key: "health", label: "Target health", kind: "text" },
          ],
          data: lbRows,
          emptyText: "This service doesn't use a load balancer.",
        },
        {
          id: "tags",
          label: "Tags",
          kind: "table",
          columns: [
            { key: "Key", label: "Key", kind: "text" },
            { key: "Value", label: "Value", kind: "text" },
          ],
          data: tagRows(s.tags),
          emptyText: "No tags.",
        },
      ],
    };
  },

  create: {
    title: "Create service",
    description: "Creates a replica service with CreateService. Fargate tasks use the awsvpc network mode, so choose subnets.",
    fields: [
      { name: "cluster", label: "Existing cluster", kind: "select", required: true, options: clusterOptions, section: "Environment" },
      ...COMPUTE_FIELDS("Environment"),
      { name: "taskDefinition", label: "Task definition family and revision", kind: "select", required: true, options: taskDefinitionOptions, section: "Deployment configuration", help: "Only ACTIVE task definition revisions can be used." },
      {
        name: "name", label: "Service name", kind: "text", required: true, section: "Deployment configuration", placeholder: "my-service",
        help: "Up to 255 letters, numbers, hyphens and underscores; unique in the cluster.",
        validate: { pattern: ECS_NAME, message: "Use up to 255 letters, numbers, hyphens and underscores." },
      },
      { name: "desiredCount", label: "Desired tasks", kind: "number", default: 1, required: true, section: "Deployment configuration", validate: { min: 0, max: 5000, message: "Between 0 and 5000." } },
      { name: "minHealthy", label: "Min running tasks %", kind: "number", default: 100, section: "Deployment options", validate: { min: 0, max: 100, message: "Between 0 and 100." } },
      { name: "maxPercent", label: "Max running tasks %", kind: "number", default: 200, section: "Deployment options", validate: { min: 100, max: 200, message: "Between 100 and 200." } },
      { name: "circuitBreaker", label: "Use the Amazon ECS deployment circuit breaker", kind: "checkbox", default: true, section: "Deployment failure detection", help: "Stops a deployment whose tasks keep failing to reach steady state." },
      { name: "rollback", label: "Rollback on failures", kind: "checkbox", default: true, section: "Deployment failure detection", showIf: { field: "circuitBreaker", equals: true } },
      ...NETWORK_FIELDS("Networking"),
      { name: "useLb", label: "Use load balancing", kind: "checkbox", default: false, section: "Load balancing", help: "Register the service's tasks with an existing target group (target type ip) behind an Application or Network Load Balancer." },
      { name: "targetGroup", label: "Target group", kind: "select", required: true, options: targetGroupOptions, section: "Load balancing", showIf: { field: "useLb", equals: true }, help: "Only target groups attached to a load balancer are listed." },
      { name: "lbContainer", label: "Container to load balance", kind: "text", required: true, section: "Load balancing", showIf: { field: "useLb", equals: true }, help: "Container name from the task definition." },
      { name: "lbPort", label: "Container port", kind: "number", required: true, default: 80, section: "Load balancing", showIf: { field: "useLb", equals: true }, validate: { min: 1, max: 65535, message: "Between 1 and 65535." } },
      { name: "grace", label: "Health check grace period (seconds)", kind: "number", section: "Load balancing", showIf: { field: "useLb", equals: true }, validate: { min: 0, max: 2147483647, message: "0 or more." } },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const cluster = String(v.cluster);
      const name = String(v.name);
      const tags = tagsToEcs(v.tags);
      const lb = v.useLb === true
        ? [{ targetGroupArn: String(v.targetGroup), containerName: String(v.lbContainer), containerPort: Number(v.lbPort) }]
        : undefined;
      await ctx.clients.ecs.send(
        new CreateServiceCommand({
          cluster,
          serviceName: name,
          taskDefinition: String(v.taskDefinition),
          desiredCount: typeof v.desiredCount === "number" ? v.desiredCount : 1,
          schedulingStrategy: "REPLICA",
          ...computeInput(v),
          deploymentConfiguration: deploymentConfiguration(v),
          networkConfiguration: awsvpcConfig(v) ?? undefined,
          loadBalancers: lb,
          healthCheckGracePeriodSeconds: lb && typeof v.grace === "number" ? v.grace : undefined,
          tags: tags.length ? tags : undefined,
        })
      );
      return joinId(cluster, name);
    },
  },

  actions: [
    {
      id: "update",
      label: "Update service",
      fields: [
        { name: "taskDefinition", label: "Task definition revision", kind: "select", default: "", options: taskDefinitionOptions, help: "Only ACTIVE revisions are listed." },
        { name: "desiredCount", label: "Desired tasks", kind: "number", help: "Leave empty to keep the current count.", validate: { min: 0, max: 5000, message: "Between 0 and 5000." } },
        { name: "minHealthy", label: "Min running tasks %", kind: "number", help: "Leave empty to keep.", validate: { min: 0, max: 100, message: "Between 0 and 100." } },
        { name: "maxPercent", label: "Max running tasks %", kind: "number", help: "Leave empty to keep.", validate: { min: 100, max: 200, message: "Between 100 and 200." } },
        { name: "force", label: "Force new deployment", kind: "checkbox", default: false, help: "Starts a new deployment even if nothing else changed, e.g. to pull a new image for the same tag." },
      ],
      async initialValues(ctx, id) {
        const s = await describeService(ctx, id);
        return {
          taskDefinition: s.taskDefinition ? taskDefinitionLabel(s.taskDefinition) : "",
          desiredCount: s.desiredCount ?? null,
          minHealthy: s.deploymentConfiguration?.minimumHealthyPercent ?? null,
          maxPercent: s.deploymentConfiguration?.maximumPercent ?? null,
        };
      },
      async run(ctx, id, v) {
        const { cluster, name } = splitId(id, "service");
        const cur = await describeService(ctx, id);
        const curDc = cur.deploymentConfiguration;
        const changedNum = (x: unknown, now: number | undefined) => (typeof x === "number" && x !== now ? x : undefined);
        const taskDefinition = typeof v.taskDefinition === "string" && v.taskDefinition && v.taskDefinition !== taskDefinitionLabel(cur.taskDefinition) ? v.taskDefinition : undefined;
        const desiredCount = changedNum(v.desiredCount, cur.desiredCount);
        const minHealthy = changedNum(v.minHealthy, curDc?.minimumHealthyPercent);
        const maxPercent = changedNum(v.maxPercent, curDc?.maximumPercent);
        // deploymentConfiguration is sent whole: unchanged parts keep their current values.
        const dc = minHealthy !== undefined || maxPercent !== undefined
          ? { ...curDc, minimumHealthyPercent: minHealthy ?? curDc?.minimumHealthyPercent, maximumPercent: maxPercent ?? curDc?.maximumPercent }
          : undefined;
        if (!taskDefinition && desiredCount === undefined && !dc && v.force !== true) return { message: "No changes to save." };
        const r = await ctx.clients.ecs.send(
          new UpdateServiceCommand({
            cluster,
            service: name,
            taskDefinition,
            desiredCount,
            deploymentConfiguration: dc,
            forceNewDeployment: v.force === true,
          })
        );
        const s = r.service;
        return { message: `Updated ${name}: desired tasks ${s?.desiredCount ?? "?"}, task definition ${taskDefinitionLabel(s?.taskDefinition)}, ${s?.deployments?.length ?? 0} deployment(s).` };
      },
    },
    {
      id: "force-deploy",
      label: "Force new deployment",
      confirm: "Starts a new deployment that replaces every task of this service with the same task definition.",
      async run(ctx, id) {
        const { cluster, name } = splitId(id, "service");
        const r = await ctx.clients.ecs.send(new UpdateServiceCommand({ cluster, service: name, forceNewDeployment: true }));
        const primary = r.service?.deployments?.find((d) => d.status === "PRIMARY");
        return { message: `New deployment ${primary?.id ?? ""} started (${primary?.rolloutState ?? "status not returned"}).` };
      },
    },
    ...tagActions(async (ctx, id) => (await describeService(ctx, id)).serviceArn ?? ""),
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      const { cluster, name } = splitId(id, "service");
      // Force delete, as the console's delete does: the service is scaled to 0 and drained.
      await ctx.clients.ecs.send(new DeleteServiceCommand({ cluster, service: name, force: true }));
    },
  },
};
