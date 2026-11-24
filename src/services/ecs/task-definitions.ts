/**
 * ECS task definitions. The list shows families with their latest revision; a family's id
 * opens its latest ACTIVE revision and "family:N" opens one revision. The detail screen is
 * hand-built (src/app/ecs/task-definitions/[id]) to add the Revisions tab with links.
 */

import {
  DeleteTaskDefinitionsCommand,
  DeregisterTaskDefinitionCommand,
  DescribeTaskDefinitionCommand,
  RegisterTaskDefinitionCommand,
  type RegisterTaskDefinitionCommandInput,
  type TaskDefinition,
  type Tag as EcsTag,
} from "@aws-sdk/client-ecs";
import type { Ctx, FieldValues, ResourceDef, Row } from "../../console/types.ts";
import { listTaskDefinitionArns, roleOptions, tagsToEcs } from "./common.ts";
import { buildContainerDefinition, checkFargateSize, ECS_NAME, FARGATE_SIZES, splitTaskDefinition, tagRows, taskDefinitionFromJson, taskDefinitionLabel } from "./helpers.ts";

export interface RevisionRow extends Row {
  id: string;
  family: string;
  revision: number;
  status: string;
}

function revisionOf(arnOrLabel: string): { family: string; revision: number } {
  const label = taskDefinitionLabel(arnOrLabel);
  const i = label.lastIndexOf(":");
  return { family: label.slice(0, i), revision: Number(label.slice(i + 1)) };
}

/** All ACTIVE and INACTIVE revisions, optionally of one family, newest first. */
export async function listRevisions(ctx: Ctx, family?: string): Promise<RevisionRow[]> {
  const [active, inactive] = await Promise.all([listTaskDefinitionArns(ctx, "ACTIVE", family), listTaskDefinitionArns(ctx, "INACTIVE", family)]);
  const rows = [
    ...active.map((a) => ({ ...revisionOf(a), status: "ACTIVE" })),
    ...inactive.map((a) => ({ ...revisionOf(a), status: "INACTIVE" })),
  ]
    // familyPrefix is a prefix match: keep only the exact family.
    .filter((r) => family === undefined || r.family === family)
    .map((r) => ({ id: `${r.family}:${r.revision}`, ...r }));
  return rows.sort((a, b) => a.family.localeCompare(b.family) || b.revision - a.revision);
}

async function describe(ctx: Ctx, id: string): Promise<{ td: TaskDefinition; tags: EcsTag[] }> {
  const { family, revision } = splitTaskDefinition(id);
  let ref = id;
  if (revision === null) {
    // A family on its own: the latest ACTIVE revision, else the latest INACTIVE one.
    const revs = await listRevisions(ctx, family);
    const pick = revs.find((r) => r.status === "ACTIVE") ?? revs[0];
    if (!pick) throw new Error(`Task definition family ${family} has no ACTIVE or INACTIVE revisions.`);
    ref = pick.id;
  }
  const r = await ctx.clients.ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: ref, include: ["TAGS"] }));
  if (!r.taskDefinition) throw new Error(`Task definition ${ref} was not found.`);
  return { td: r.taskDefinition, tags: r.tags ?? [] };
}

function revisionRef(td: TaskDefinition): string {
  return `${td.family ?? ""}:${td.revision ?? ""}`;
}

const CPU_OPTIONS = Object.keys(FARGATE_SIZES).map((c) => ({ value: c, label: `${Number(c) / 1024} vCPU` }));
const MEMORY_OPTIONS = [...new Set(Object.values(FARGATE_SIZES).flat())].sort((a, b) => a - b).map((m) => ({ value: String(m), label: `${m / 1024} GB` }));

const JSON_PLACEHOLDER = `{
  "family": "my-app",
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc",
  "cpu": "256",
  "memory": "512",
  "containerDefinitions": [
    { "name": "web", "image": "public.ecr.aws/nginx/nginx:latest", "essential": true,
      "portMappings": [{ "containerPort": 80, "protocol": "tcp" }] }
  ]
}`;

function inputFromForm(ctx: Ctx, v: FieldValues): RegisterTaskDefinitionCommandInput {
  const family = String(v.family);
  const fargate = v.launchType !== "EC2";
  const cpu = String(v.cpu);
  const memory = String(v.memory);
  if (fargate) {
    const sizeError = checkFargateSize(cpu, memory);
    if (sizeError) throw new Error(sizeError);
  }
  if (fargate && v.logging === true && !(typeof v.executionRole === "string" && v.executionRole)) {
    throw new Error("Fargate needs a task execution role to send logs with awslogs. Choose a task execution role, or turn off log collection.");
  }
  const [os, arch] = String(v.platform).split("/");
  const container = buildContainerDefinition({
    name: String(v.containerName),
    image: String(v.image),
    essential: v.essential === true,
    containerPort: typeof v.containerPort === "number" ? v.containerPort : null,
    protocol: String(v.protocol ?? "tcp"),
    environment: typeof v.environment === "string" ? v.environment : "",
    healthCheck: typeof v.healthCheck === "string" ? v.healthCheck : "",
    logGroup: v.logging === true ? `/ecs/${family}` : null,
    region: ctx.region,
  });
  const tags = tagsToEcs(v.tags);
  return {
    family,
    requiresCompatibilities: [fargate ? "FARGATE" : "EC2"],
    networkMode: fargate ? "awsvpc" : (String(v.networkMode) as RegisterTaskDefinitionCommandInput["networkMode"]),
    cpu,
    memory,
    runtimePlatform: { operatingSystemFamily: os as "LINUX", cpuArchitecture: arch as "X86_64" | "ARM64" },
    taskRoleArn: typeof v.taskRole === "string" && v.taskRole ? v.taskRole : undefined,
    executionRoleArn: typeof v.executionRole === "string" && v.executionRole ? v.executionRole : undefined,
    containerDefinitions: [container],
    tags: tags.length ? tags : undefined,
  };
}

async function register(ctx: Ctx, input: RegisterTaskDefinitionCommandInput): Promise<string> {
  const r = await ctx.clients.ecs.send(new RegisterTaskDefinitionCommand(input));
  if (!r.taskDefinition) throw new Error("RegisterTaskDefinition returned no task definition.");
  return revisionRef(r.taskDefinition);
}

/** The register input for a new revision based on an existing one. */
function inputFromExisting(td: TaskDefinition, tags: EcsTag[]): RegisterTaskDefinitionCommandInput {
  return taskDefinitionFromJson(JSON.stringify({ taskDefinition: td, tags }));
}

export const taskDefinitions: ResourceDef = {
  id: "task-definitions",
  name: "Task definitions",
  singular: "task definition",
  idField: "family",
  nameField: "Task definition",
  description: "A task definition is the blueprint for your application: containers, images, CPU and memory, roles and networking. Each change registers a new revision.",
  emptyText: "No task definitions. Create a new task definition to get started.",
  columns: [
    { key: "family", label: "Task definition", kind: "link" },
    { key: "latest", label: "Latest revision", kind: "count" },
    { key: "status", label: "Status of last revision", kind: "status" },
    { key: "active", label: "Active revisions", kind: "count" },
    { key: "inactive", label: "Inactive revisions", kind: "count" },
  ],

  async list(ctx) {
    const byFamily = new Map<string, RevisionRow[]>();
    for (const r of await listRevisions(ctx)) byFamily.set(r.family, [...(byFamily.get(r.family) ?? []), r]);
    return [...byFamily].map(([family, revs]) => ({
      family,
      latest: revs[0].revision,
      status: revs[0].status,
      active: revs.filter((r) => r.status === "ACTIVE").length,
      inactive: revs.filter((r) => r.status === "INACTIVE").length,
    }));
  },

  async get(ctx, id) {
    const { td, tags } = await describe(ctx, id);
    return {
      summary: {
        "Task definition": revisionRef(td),
        Status: td.status ?? null,
        ARN: td.taskDefinitionArn ?? null,
        "Launch type": (td.requiresCompatibilities ?? []).join(", ") || null,
        "Operating system/Architecture": td.runtimePlatform ? `${td.runtimePlatform.operatingSystemFamily ?? "?"}/${td.runtimePlatform.cpuArchitecture ?? "?"}` : null,
        "Task size": td.cpu || td.memory ? `${td.cpu ? `${Number(td.cpu) / 1024} vCPU` : "-"}, ${td.memory ? `${Number(td.memory) / 1024} GB` : "-"}` : null,
        "Network mode": td.networkMode ?? null,
        "Task role": td.taskRoleArn ?? null,
        "Task execution role": td.executionRoleArn ?? null,
        "Registered at": td.registeredAt ?? null,
        "Registered by": td.registeredBy ?? null,
        "Deregistered at": td.deregisteredAt ?? null,
      },
      tabs: [
        {
          id: "containers",
          label: "Containers",
          kind: "table",
          columns: [
            { key: "name", label: "Container name", kind: "text" },
            { key: "image", label: "Image", kind: "code" },
            { key: "essential", label: "Essential", kind: "text" },
            { key: "ports", label: "Port mappings", kind: "text" },
            { key: "cpu", label: "CPU", kind: "text" },
            { key: "memory", label: "Memory hard/soft limit", kind: "text" },
            { key: "env", label: "Environment variables", kind: "text" },
            { key: "logs", label: "Log driver", kind: "text" },
          ],
          data: (td.containerDefinitions ?? []).map((c) => ({
            name: c.name ?? "",
            image: c.image ?? null,
            essential: c.essential === false ? "No" : "Yes",
            ports: c.portMappings?.map((p) => `${p.containerPort ?? "?"}/${p.protocol ?? "tcp"}`).join(", ") || null,
            cpu: c.cpu === undefined ? null : String(c.cpu),
            memory: c.memory || c.memoryReservation ? `${c.memory ?? "-"} / ${c.memoryReservation ?? "-"}` : null,
            env: c.environment?.map((e) => `${e.name}=${e.value}`).join(", ") || null,
            logs: c.logConfiguration?.logDriver ?? null,
          })),
          emptyText: "No container definitions.",
        },
        {
          id: "volumes",
          label: "Storage",
          kind: "table",
          columns: [
            { key: "name", label: "Volume name", kind: "text" },
            { key: "type", label: "Type", kind: "text" },
          ],
          data: (td.volumes ?? []).map((v) => ({ name: v.name ?? "", type: v.efsVolumeConfiguration ? "EFS" : v.dockerVolumeConfiguration ? "Docker volume" : v.host ? "Bind mount" : "Bind mount (task storage)" })),
          emptyText: td.ephemeralStorage?.sizeInGiB ? `No volumes. Ephemeral storage: ${td.ephemeralStorage.sizeInGiB} GiB.` : "No volumes.",
        },
        { id: "json", label: "JSON", kind: "json", data: td, description: "Copy this into Create new revision (JSON) to start a new revision from it." },
        {
          id: "tags",
          label: "Tags",
          kind: "table",
          columns: [
            { key: "Key", label: "Key", kind: "text" },
            { key: "Value", label: "Value", kind: "text" },
          ],
          data: tagRows(tags),
          emptyText: "No tags.",
        },
      ],
    };
  },

  create: {
    title: "Create new task definition",
    description: "Registers a task definition with RegisterTaskDefinition, from the form or from JSON.",
    fields: [
      {
        name: "mode", label: "Create with", kind: "radio", default: "form", section: "Task definition configuration",
        options: [
          { value: "form", label: "Form" },
          { value: "json", label: "JSON" },
        ],
      },
      { name: "json", label: "Task definition JSON", kind: "json", required: true, placeholder: JSON_PLACEHOLDER, section: "Task definition configuration", showIf: { field: "mode", equals: "json" }, help: "RegisterTaskDefinition input, or a task definition's JSON from the console. Read-only fields (ARN, revision, status) are ignored." },
      {
        name: "family", label: "Task definition family", kind: "text", required: true, placeholder: "my-app", section: "Task definition configuration", showIf: { field: "mode", equals: "form" },
        help: "Up to 255 letters (uppercase and lowercase), numbers, hyphens, and underscores. An existing family gets a new revision.",
        validate: { pattern: ECS_NAME, message: "Use up to 255 letters, numbers, hyphens and underscores." },
      },
      {
        name: "launchType", label: "Launch type", kind: "radio", default: "FARGATE", section: "Infrastructure requirements", showIf: { field: "mode", equals: "form" },
        options: [
          { value: "FARGATE", label: "AWS Fargate: serverless compute for containers" },
          { value: "EC2", label: "Amazon EC2 instances: self-managed infrastructure" },
        ],
      },
      {
        name: "platform", label: "Operating system/Architecture", kind: "select", required: true, default: "LINUX/X86_64", section: "Infrastructure requirements", showIf: { field: "mode", equals: "form" },
        options: [
          { value: "LINUX/X86_64", label: "Linux/X86_64" },
          { value: "LINUX/ARM64", label: "Linux/ARM64" },
        ],
      },
      {
        name: "networkMode", label: "Network mode", kind: "select", required: true, default: "awsvpc", section: "Infrastructure requirements", showIf: { field: "launchType", equals: "EC2" },
        help: "Fargate always uses awsvpc.",
        options: ["awsvpc", "bridge", "host", "none"].map((m) => ({ value: m, label: m })),
      },
      { name: "cpu", label: "CPU", kind: "select", required: true, default: "1024", options: CPU_OPTIONS, section: "Task size", showIf: { field: "mode", equals: "form" } },
      { name: "memory", label: "Memory", kind: "select", required: true, default: "3072", options: MEMORY_OPTIONS, section: "Task size", showIf: { field: "mode", equals: "form" }, help: "Fargate allows only certain CPU and memory combinations; the form tells you if yours isn't one." },
      { name: "taskRole", label: "Task role", kind: "select", default: "", options: roleOptions, section: "Task roles", showIf: { field: "mode", equals: "form" }, help: "Role your containers use to call AWS APIs. Needed for ECS Exec." },
      { name: "executionRole", label: "Task execution role", kind: "select", default: "", options: roleOptions, section: "Task roles", showIf: { field: "mode", equals: "form" }, help: "Role the ECS agent uses to pull private images and send logs." },
      {
        name: "containerName", label: "Container name", kind: "text", required: true, placeholder: "web", section: "Container - 1", showIf: { field: "mode", equals: "form" },
        validate: { pattern: ECS_NAME, message: "Use up to 255 letters, numbers, hyphens and underscores." },
      },
      { name: "image", label: "Image URI", kind: "text", required: true, placeholder: "public.ecr.aws/nginx/nginx:latest", section: "Container - 1", showIf: { field: "mode", equals: "form" } },
      { name: "essential", label: "Essential container", kind: "checkbox", default: true, section: "Container - 1", showIf: { field: "mode", equals: "form" }, help: "If an essential container stops, the whole task stops." },
      { name: "containerPort", label: "Container port", kind: "number", default: 80, section: "Container - 1", showIf: { field: "mode", equals: "form" }, help: "Leave empty for no port mapping.", validate: { min: 1, max: 65535, message: "Between 1 and 65535." } },
      { name: "protocol", label: "Protocol", kind: "select", required: true, default: "tcp", options: [{ value: "tcp", label: "TCP" }, { value: "udp", label: "UDP" }], section: "Container - 1", showIf: { field: "mode", equals: "form" } },
      { name: "environment", label: "Environment variables", kind: "textarea", placeholder: "KEY=value", section: "Container - 1", showIf: { field: "mode", equals: "form" }, help: "One KEY=value per line." },
      { name: "healthCheck", label: "Health check command", kind: "text", placeholder: "curl -f http://localhost/ || exit 1", section: "Container - 1", showIf: { field: "mode", equals: "form" }, help: "Run with CMD-SHELL every 30 seconds (timeout 5, retries 3)." },
      { name: "logging", label: "Use log collection (Amazon CloudWatch, awslogs)", kind: "checkbox", default: false, section: "Container - 1", showIf: { field: "mode", equals: "form" }, help: "Sends container logs to the log group /ecs/<family>, created if needed." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags", showIf: { field: "mode", equals: "form" } },
    ],
    async run(ctx, v) {
      return register(ctx, v.mode === "json" ? taskDefinitionFromJson(String(v.json)) : inputFromForm(ctx, v));
    },
  },

  actions: [
    {
      id: "new-revision-image",
      label: "Create new revision",
      fields: [
        { name: "containerName", label: "Container name", kind: "text", help: "Leave empty for the first container." },
        { name: "image", label: "Image URI", kind: "text", required: true, placeholder: "public.ecr.aws/nginx/nginx:1.27" },
      ],
      async run(ctx, id, v) {
        const { td, tags } = await describe(ctx, id);
        const input = inputFromExisting(td, tags);
        const containers = input.containerDefinitions ?? [];
        const wanted = typeof v.containerName === "string" && v.containerName ? v.containerName : containers[0]?.name;
        const target = containers.find((c) => c.name === wanted);
        if (!target) throw new Error(`Container ${wanted ?? ""} is not in ${revisionRef(td)}.`);
        const next = { ...input, containerDefinitions: containers.map((c) => (c === target ? { ...c, image: String(v.image) } : c)) };
        return { message: `Registered ${await register(ctx, next)} from ${revisionRef(td)} with ${wanted} image ${String(v.image)}.` };
      },
    },
    {
      id: "new-revision-json",
      label: "Create new revision with JSON",
      fields: [{ name: "json", label: "Task definition JSON", kind: "json", required: true, placeholder: JSON_PLACEHOLDER, help: "Paste this revision's JSON tab and edit it. The family is kept." }],
      async run(ctx, id, v) {
        const { family } = splitTaskDefinition(id);
        return { message: `Registered ${await register(ctx, taskDefinitionFromJson(String(v.json), family))}.` };
      },
    },
    {
      id: "deregister",
      label: "Deregister",
      danger: true,
      confirm: "Deregistering marks this revision INACTIVE. Running tasks and services keep working, but you can't run new tasks or create services from it.",
      async run(ctx, id) {
        const { td } = await describe(ctx, id);
        const r = await ctx.clients.ecs.send(new DeregisterTaskDefinitionCommand({ taskDefinition: revisionRef(td) }));
        return { message: `${revisionRef(td)} is now ${r.taskDefinition?.status ?? "deregistered"}.` };
      },
    },
    {
      id: "delete-revision",
      label: "Delete",
      danger: true,
      confirm: "Deletes this INACTIVE revision (DeleteTaskDefinitions). Deregister it first. This can't be undone.",
      async run(ctx, id) {
        const { td } = await describe(ctx, id);
        if (td.status !== "INACTIVE") throw new Error(`${revisionRef(td)} is ${td.status ?? "not INACTIVE"}. Deregister it before deleting it.`);
        const r = await ctx.clients.ecs.send(new DeleteTaskDefinitionsCommand({ taskDefinitions: [revisionRef(td)] }));
        const failure = r.failures?.[0];
        if (failure) throw new Error(`${failure.reason ?? "Delete failed"}${failure.detail ? `: ${failure.detail}` : ""}`);
        return { message: `${revisionRef(td)} is ${r.taskDefinitions?.[0]?.status ?? "being deleted"}.` };
      },
    },
  ],
};
