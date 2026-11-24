/**
 * ECS tasks. A task lives inside a cluster, so its console id is "<cluster>/<task id>".
 * "Run task" is the create form; Stop is an action. Running and stopped tasks are listed
 * (ECS keeps stopped tasks visible for a while, as in the console's "Stopped" filter).
 */

import { DescribeTasksCommand, ListTasksCommand, RunTaskCommand, StopTaskCommand, type DesiredStatus, type Task } from "@aws-sdk/client-ecs";
import type { Ctx, ResourceDef, Row } from "../../console/types.ts";
import { awsvpcConfig, clusterNames, clusterOptions, NETWORK_FIELDS, tagActions, tagsToEcs, taskDefinitionOptions } from "./common.ts";
import { arnName, chunk, clusterFromArn, joinId, pairsToRecord, splitId, tagRows, taskDefinitionLabel } from "./helpers.ts";
import { COMPUTE_FIELDS } from "./services.ts";

async function listTaskArns(ctx: Ctx, cluster: string, desiredStatus: DesiredStatus, serviceName?: string): Promise<string[]> {
  const arns: string[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.ecs.send(new ListTasksCommand({ cluster, desiredStatus, serviceName, nextToken: token, maxResults: 100 }));
    arns.push(...(r.taskArns ?? []));
    token = r.nextToken;
  } while (token);
  return arns;
}

async function describeTaskArns(ctx: Ctx, cluster: string, arns: string[]): Promise<Task[]> {
  const out: Task[] = [];
  for (const part of chunk(arns, 100)) {
    const r = await ctx.clients.ecs.send(new DescribeTasksCommand({ cluster, tasks: part }));
    out.push(...(r.tasks ?? []));
  }
  return out;
}

/** Running and stopped tasks of a cluster, optionally only one service's. */
export async function describeTasksIn(ctx: Ctx, cluster: string, serviceName?: string): Promise<Task[]> {
  const [running, stopped] = await Promise.all([
    listTaskArns(ctx, cluster, "RUNNING", serviceName),
    listTaskArns(ctx, cluster, "STOPPED", serviceName),
  ]);
  const tasks = await describeTaskArns(ctx, cluster, [...new Set([...running, ...stopped])]);
  return tasks.sort((a, b) => String(b.createdAt?.toISOString() ?? "").localeCompare(String(a.createdAt?.toISOString() ?? "")));
}

async function describeTask(ctx: Ctx, id: string): Promise<Task> {
  const { cluster, name } = splitId(id, "task");
  const r = await ctx.clients.ecs.send(new DescribeTasksCommand({ cluster, tasks: [name], include: ["TAGS"] }));
  const t = r.tasks?.[0];
  if (!t) throw new Error(`Task ${name} was not found in cluster ${cluster}${r.failures?.[0]?.reason ? ` (${r.failures[0].reason})` : ""}.`);
  return t;
}

export function taskRow(t: Task): Row {
  const cluster = clusterFromArn(t.clusterArn) || clusterFromArn(t.taskArn);
  const taskId = arnName(t.taskArn);
  return {
    id: joinId(cluster, taskId),
    taskId,
    cluster,
    lastStatus: t.lastStatus ?? null,
    desiredStatus: t.desiredStatus ?? null,
    taskDefinition: taskDefinitionLabel(t.taskDefinitionArn),
    health: t.healthStatus ?? null,
    started: t.startedAt ?? t.createdAt ?? null,
    stopped: t.stoppedAt ?? null,
    group: t.group ?? null,
    launchType: t.launchType ?? null,
    capacityProvider: t.capacityProviderName ?? null,
    stoppedReason: t.stoppedReason ?? null,
    arn: t.taskArn ?? null,
  };
}

export const tasks: ResourceDef = {
  id: "tasks",
  name: "Tasks",
  singular: "task",
  idField: "id",
  nameField: "Task ID",
  description: "Tasks are running copies of a task definition, started by a service or by Run task. Stopped tasks stay visible for a while with their stopped reason.",
  emptyText: "No tasks. Run a task, or create a service, in a cluster.",
  columns: [
    { key: "taskId", label: "Task", kind: "link" },
    { key: "cluster", label: "Cluster", kind: "text" },
    { key: "lastStatus", label: "Last status", kind: "status" },
    { key: "desiredStatus", label: "Desired status", kind: "status" },
    { key: "taskDefinition", label: "Task definition", kind: "text" },
    { key: "health", label: "Health status", kind: "status" },
    { key: "started", label: "Started at", kind: "date" },
    { key: "group", label: "Group", kind: "text" },
    { key: "launchType", label: "Launch type", kind: "text" },
    { key: "capacityProvider", label: "Capacity provider", kind: "text", hidden: true },
    { key: "stoppedReason", label: "Stopped reason", kind: "text", hidden: true },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const rows: Row[] = [];
    for (const cluster of await clusterNames(ctx)) rows.push(...(await describeTasksIn(ctx, cluster)).map(taskRow));
    return rows;
  },

  async get(ctx, id) {
    const t = await describeTask(ctx, id);
    const row = taskRow(t);
    const eni = t.attachments?.find((a) => a.type === "ElasticNetworkInterface");
    const eniDetails = pairsToRecord(eni?.details);
    return {
      summary: {
        "Task ID": row.taskId,
        Cluster: row.cluster,
        "Last status": row.lastStatus,
        "Desired status": row.desiredStatus,
        "Task definition: revision": row.taskDefinition,
        "Health status": row.health,
        "Stopped reason": row.stoppedReason,
        ARN: row.arn,
      },
      tabs: [
        {
          id: "configuration",
          label: "Configuration",
          kind: "keyvalue",
          data: {
            "Launch type": t.launchType ?? null,
            "Capacity provider": t.capacityProviderName ?? null,
            "Platform version": t.platformVersion ?? null,
            "Operating system family": t.platformFamily ?? null,
            "CPU | Memory": t.cpu || t.memory ? `${t.cpu ?? "-"} | ${t.memory ?? "-"}` : null,
            "Ephemeral storage (GiB)": t.ephemeralStorage?.sizeInGiB ?? null,
            "Availability Zone": t.availabilityZone ?? null,
            Group: t.group ?? null,
            "Started by": t.startedBy ?? null,
            Connectivity: t.connectivity ?? null,
            "Created at": t.createdAt ?? null,
            "Started at": t.startedAt ?? null,
            "Stopping at": t.stoppingAt ?? null,
            "Stopped at": t.stoppedAt ?? null,
            "Stop code": t.stopCode ?? null,
            "Stopped reason": t.stoppedReason ?? null,
            "ECS Exec": t.enableExecuteCommand ? "Turned on" : "Turned off",
          },
        },
        {
          id: "containers",
          label: "Containers",
          kind: "table",
          columns: [
            { key: "name", label: "Container name", kind: "text" },
            { key: "image", label: "Image URI", kind: "code" },
            { key: "lastStatus", label: "Status", kind: "status" },
            { key: "health", label: "Health status", kind: "status" },
            { key: "exitCode", label: "Exit code", kind: "text" },
            { key: "reason", label: "Reason", kind: "text" },
            { key: "ip", label: "Private IP", kind: "text" },
            { key: "ports", label: "Network bindings", kind: "text" },
          ],
          data: (t.containers ?? []).map((c) => ({
            name: c.name ?? "",
            image: c.image ?? null,
            lastStatus: c.lastStatus ?? null,
            health: c.healthStatus ?? null,
            exitCode: c.exitCode === undefined ? null : String(c.exitCode),
            reason: c.reason ?? null,
            ip: c.networkInterfaces?.map((n) => n.privateIpv4Address).filter(Boolean).join(", ") || null,
            ports: c.networkBindings?.map((b) => `${b.hostPort ?? "?"}:${b.containerPort ?? "?"}/${b.protocol ?? "tcp"}`).join(", ") || null,
          })),
          emptyText: "No containers were returned for this task.",
        },
        {
          id: "networking",
          label: "Networking",
          kind: "keyvalue",
          data: eni
            ? {
                "Network mode": "awsvpc",
                "ENI ID": eniDetails.networkInterfaceId ?? null,
                Subnet: eniDetails.subnetId ?? null,
                "Private IP": eniDetails.privateIPv4Address ?? null,
                "MAC address": eniDetails.macAddress ?? null,
                "Attachment status": eni.status ?? null,
              }
            : {},
          emptyText: "This task has no elastic network interface (it doesn't use the awsvpc network mode).",
        },
        { id: "overrides", label: "Overrides", kind: "json", data: t.overrides ?? null, emptyText: "No overrides." },
        {
          id: "tags",
          label: "Tags",
          kind: "table",
          columns: [
            { key: "Key", label: "Key", kind: "text" },
            { key: "Value", label: "Value", kind: "text" },
          ],
          data: tagRows(t.tags),
          emptyText: "No tags.",
        },
        { id: "json", label: "JSON", kind: "json", data: t },
      ],
    };
  },

  create: {
    title: "Run task",
    description: "Starts standalone tasks with RunTask. Fargate tasks use the awsvpc network mode, so choose subnets.",
    fields: [
      { name: "cluster", label: "Existing cluster", kind: "select", required: true, options: clusterOptions, section: "Environment" },
      ...COMPUTE_FIELDS("Environment"),
      { name: "taskDefinition", label: "Task definition family and revision", kind: "select", required: true, options: taskDefinitionOptions, section: "Deployment configuration", help: "Only ACTIVE task definition revisions can be run." },
      { name: "count", label: "Desired tasks", kind: "number", default: 1, required: true, section: "Deployment configuration", validate: { min: 1, max: 10, message: "Between 1 and 10." } },
      { name: "group", label: "Task group", kind: "text", section: "Deployment configuration", help: "Defaults to family:<task definition family>.", validate: { pattern: "[A-Za-z0-9_:.-]{1,255}", message: "Up to 255 letters, numbers, hyphens, underscores, colons and periods." } },
      ...NETWORK_FIELDS("Networking"),
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const cluster = String(v.cluster);
      const tags = tagsToEcs(v.tags);
      const platformVersion = typeof v.platformVersion === "string" && v.platformVersion ? v.platformVersion : undefined;
      const r = await ctx.clients.ecs.send(
        new RunTaskCommand({
          cluster,
          taskDefinition: String(v.taskDefinition),
          count: typeof v.count === "number" ? v.count : 1,
          launchType: v.compute === "launchType" ? "FARGATE" : undefined,
          capacityProviderStrategy: v.compute === "capacityProvider" ? [{ capacityProvider: String(v.capacityProvider), weight: 1, base: 0 }] : undefined,
          platformVersion,
          group: typeof v.group === "string" && v.group ? v.group : undefined,
          networkConfiguration: awsvpcConfig(v) ?? undefined,
          tags: tags.length ? tags : undefined,
        })
      );
      const first = r.tasks?.[0];
      if (!first?.taskArn) {
        const reasons = (r.failures ?? []).map((f) => `${f.arn ?? ""} ${f.reason ?? ""} ${f.detail ?? ""}`.trim()).join("; ");
        throw new Error(`RunTask started no task${reasons ? `: ${reasons}` : "."}`);
      }
      return joinId(cluster, arnName(first.taskArn));
    },
  },

  actions: [
    {
      id: "stop",
      label: "Stop",
      danger: true,
      availableFor: (row) => (row.desiredStatus ?? row["Desired status"]) !== "STOPPED",
      fields: [{ name: "reason", label: "Reason for stopping", kind: "text", help: "Shown as the task's stopped reason.", validate: { max: 255, message: "At most 255 characters." } }],
      async run(ctx, id, v) {
        const { cluster, name } = splitId(id, "task");
        const reason = typeof v.reason === "string" && v.reason ? v.reason : "Task stopped by user from the console";
        const r = await ctx.clients.ecs.send(new StopTaskCommand({ cluster, task: name, reason }));
        return { message: `Stop requested. Last status: ${r.task?.lastStatus ?? "?"}, desired status: ${r.task?.desiredStatus ?? "?"}.` };
      },
    },
    ...tagActions(async (ctx, id) => (await describeTask(ctx, id)).taskArn ?? ""),
  ],
};
