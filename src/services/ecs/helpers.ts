/**
 * Pure helpers for the Amazon ECS definition: ids, ARNs, task sizes and task definition
 * JSON. No SDK calls here, so they are unit-tested in tests/ecs-helpers.test.mjs.
 */

import type { ContainerDefinition, KeyValuePair, RegisterTaskDefinitionCommandInput } from "@aws-sdk/client-ecs";

/** Cluster and service names: up to 255 letters, numbers, hyphens and underscores. */
export const ECS_NAME = "[A-Za-z0-9_-]{1,255}";
const NAME_RE = new RegExp(`^${ECS_NAME}$`);

export function isEcsName(v: unknown): v is string {
  return typeof v === "string" && NAME_RE.test(v);
}

/** Services and tasks live inside a cluster; their console id is "<cluster>/<name or task id>". */
export function joinId(cluster: string, name: string): string {
  return `${cluster}/${name}`;
}

export function splitId(id: string, what: string): { cluster: string; name: string } {
  const i = id.indexOf("/");
  const cluster = i > 0 ? id.slice(0, i) : "";
  const name = i > 0 ? id.slice(i + 1) : "";
  if (!isEcsName(cluster) || !/^[A-Za-z0-9_-]{1,255}$/.test(name)) throw new Error(`"${id}" is not a valid ${what} id (expected cluster/name).`);
  return { cluster, name };
}

/** The last "/" segment of an ARN (cluster name, service name, task id). */
export function arnName(arn: string | undefined | null): string {
  if (!arn) return "";
  return arn.slice(arn.lastIndexOf("/") + 1);
}

/** arn:aws:ecs:...:task/<cluster>/<id> and service/<cluster>/<name> -> cluster name. */
export function clusterFromArn(arn: string | undefined | null): string {
  if (!arn) return "";
  const parts = arn.split(":").slice(5).join(":").split("/");
  if (parts[0] === "cluster") return parts[1] ?? "";
  return parts.length >= 3 ? parts[1] : "";
}

/** task-definition ARN -> "family:revision". Leaves a short name unchanged. */
export function taskDefinitionLabel(arn: string | undefined | null): string {
  if (!arn) return "";
  const i = arn.indexOf("task-definition/");
  return i >= 0 ? arn.slice(i + "task-definition/".length) : arn;
}

export function splitTaskDefinition(id: string): { family: string; revision: number | null } {
  const m = /^([A-Za-z0-9_-]{1,255})(?::(\d+))?$/.exec(id);
  if (!m) throw new Error(`"${id}" is not a task definition family or family:revision.`);
  return { family: m[1], revision: m[2] === undefined ? null : Number(m[2]) };
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** ECS returns statistics and attachment details as [{ name, value }]. */
export function pairsToRecord(pairs: readonly KeyValuePair[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs ?? []) if (p.name) out[p.name] = p.value ?? "";
  return out;
}

export function containerInsightsText(settings: readonly { name?: string; value?: string }[] | undefined): string {
  const v = settings?.find((s) => s.name === "containerInsights")?.value;
  if (v === "enhanced") return "Container Insights with enhanced observability";
  if (v === "enabled") return "Container Insights";
  return "Off";
}

export function strategyText(strategy: readonly { capacityProvider?: string; weight?: number; base?: number }[] | undefined): string | null {
  if (!strategy || strategy.length === 0) return null;
  return strategy.map((s) => `${s.capacityProvider ?? "?"} (weight ${s.weight ?? 0}, base ${s.base ?? 0})`).join(", ");
}

/** "KEY=value" per line -> environment variables. Blank lines are skipped. */
export function parseEnvLines(text: string): KeyValuePair[] {
  const out: KeyValuePair[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "") return;
    const eq = line.indexOf("=");
    const name = eq > 0 ? line.slice(0, eq).trim() : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Environment variables line ${i + 1}: use KEY=value.`);
    out.push({ name, value: line.slice(eq + 1) });
  });
  return out;
}

/** Valid Fargate task sizes: CPU units -> memory (MiB). */
export const FARGATE_SIZES: Record<string, number[]> = {
  "256": [512, 1024, 2048],
  "512": [1024, 2048, 3072, 4096],
  "1024": [2048, 3072, 4096, 5120, 6144, 7168, 8192],
  "2048": Array.from({ length: 13 }, (_, i) => 4096 + i * 1024),
  "4096": Array.from({ length: 23 }, (_, i) => 8192 + i * 1024),
  "8192": Array.from({ length: 12 }, (_, i) => 16384 + i * 4096),
  "16384": Array.from({ length: 12 }, (_, i) => 32768 + i * 8192),
};

export function checkFargateSize(cpu: string, memory: string): string | null {
  const allowed = FARGATE_SIZES[cpu];
  if (!allowed) return `${cpu} CPU units is not a Fargate task size.`;
  if (!allowed.includes(Number(memory))) return `Fargate doesn't support ${memory} MiB with ${Number(cpu) / 1024} vCPU. Choose ${allowed[0]}-${allowed[allowed.length - 1]} MiB.`;
  return null;
}

/** Fields DescribeTaskDefinition returns that RegisterTaskDefinition does not accept. */
const READ_ONLY_KEYS = ["taskDefinitionArn", "revision", "status", "requiresAttributes", "compatibilities", "registeredAt", "registeredBy", "deregisteredAt", "deleteRequestedAt"];

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Parses task definition JSON for RegisterTaskDefinition. Accepts the register input, a
 * single task definition as the console's JSON tab shows it, or DescribeTaskDefinition
 * output ({ taskDefinition, tags }). Read-only fields are dropped.
 */
export function taskDefinitionFromJson(text: string, familyOverride?: string): RegisterTaskDefinitionCommandInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The task definition is not valid JSON.");
  }
  if (!isObject(parsed)) throw new Error("The task definition JSON must be an object.");
  const wrapperTags = Array.isArray(parsed.tags) && isObject(parsed.taskDefinition) ? parsed.tags : undefined;
  const body: Record<string, unknown> = { ...(isObject(parsed.taskDefinition) ? parsed.taskDefinition : parsed) };
  for (const k of READ_ONLY_KEYS) delete body[k];
  if (wrapperTags && wrapperTags.length) body.tags = wrapperTags;
  if (familyOverride) body.family = familyOverride;
  if (!isEcsName(body.family)) throw new Error('The JSON needs a "family": up to 255 letters, numbers, hyphens and underscores.');
  const containers = body.containerDefinitions;
  if (!Array.isArray(containers) || containers.length === 0) throw new Error('The JSON needs at least one entry in "containerDefinitions".');
  containers.forEach((c: unknown, i: number) => {
    if (!isObject(c) || typeof c.name !== "string" || c.name === "" || typeof c.image !== "string" || c.image === "") {
      throw new Error(`containerDefinitions[${i}] needs a "name" and an "image".`);
    }
  });
  return body as unknown as RegisterTaskDefinitionCommandInput;
}

export interface ContainerFormValues {
  name: string;
  image: string;
  essential: boolean;
  containerPort: number | null;
  protocol: string;
  environment: string;
  healthCheck: string;
  logGroup: string | null;
  region: string;
}

export function buildContainerDefinition(v: ContainerFormValues): ContainerDefinition {
  const env = parseEnvLines(v.environment);
  const def: ContainerDefinition = { name: v.name, image: v.image, essential: v.essential };
  if (v.containerPort !== null) {
    def.portMappings = [{ containerPort: v.containerPort, protocol: v.protocol === "udp" ? "udp" : "tcp", name: `${v.name}-${v.containerPort}-${v.protocol === "udp" ? "udp" : "tcp"}` }];
  }
  if (env.length) def.environment = env;
  if (v.healthCheck.trim() !== "") def.healthCheck = { command: ["CMD-SHELL", v.healthCheck.trim()], interval: 30, timeout: 5, retries: 3 };
  if (v.logGroup) {
    def.logConfiguration = {
      logDriver: "awslogs",
      options: { "awslogs-group": v.logGroup, "awslogs-create-group": "true", "awslogs-region": v.region, "awslogs-stream-prefix": "ecs" },
    };
  }
  return def;
}

/** Converts SDK tag lists ({ key, value }) to rows. */
export function tagRows(tags: readonly { key?: string; value?: string }[] | undefined): { Key: string; Value: string }[] {
  return (tags ?? []).map((t) => ({ Key: t.key ?? "", Value: t.value ?? "" }));
}

/** "a, b ,c" -> ["a","b","c"]. */
export function splitList(text: unknown): string[] {
  return typeof text === "string" ? text.split(",").map((s) => s.trim()).filter((s) => s !== "") : [];
}
