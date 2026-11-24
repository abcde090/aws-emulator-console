/**
 * ElastiCache caches: one console page per engine (Valkey, Redis OSS, Memcached). Each page
 * lists serverless caches and node-based clusters of that engine, like the real console.
 *   Valkey / Redis OSS node-based -> replication groups (CreateReplicationGroup)
 *   Memcached node-based          -> cache clusters (CreateCacheCluster)
 *   Serverless                    -> serverless caches (CreateServerlessCache)
 */

import {
  CreateCacheClusterCommand,
  CreateReplicationGroupCommand,
  CreateServerlessCacheCommand,
  type CacheCluster,
  type ReplicationGroup,
  type ServerlessCache,
} from "@aws-sdk/client-elasticache";
import type { Ctx, FieldDef, FieldValues, ResourceDef, Row, Tag } from "../../console/types.ts";
import { cacheActions, deleteCache } from "./cache-actions.ts";
import { cacheDetail } from "./cache-detail.ts";
import { endpointText, engineLabel, majorVersion, rowIdFor, usageLimitsText, type CacheEngine } from "./helpers.ts";
import {
  cacheClusters,
  engineVersionOptions,
  NODE_TYPES,
  parameterGroupOptions,
  replicationGroups,
  securityGroupOptions,
  serverlessCaches,
  subnetGroupOptions,
  subnetOptions,
} from "./lookups.ts";

const NAME = "[a-zA-Z][a-zA-Z0-9-]{0,39}";
const NAME_RULE = { pattern: NAME, message: "1-40 letters, numbers or hyphens, starting with a letter." };

function replicationGroupRow(rg: ReplicationGroup, members: Map<string, CacheCluster>, engine: CacheEngine): Row {
  const first = rg.MemberClusters?.map((m) => members.get(m)).find(Boolean);
  const shards = rg.NodeGroups?.length ?? 0;
  return {
    id: rowIdFor("replication-group", rg.ReplicationGroupId ?? "", engine),
    name: rg.ReplicationGroupId ?? "",
    status: rg.Status ?? null,
    deployment: "Node-based cluster",
    engineVersion: first?.EngineVersion ?? null,
    clusterMode: rg.ClusterEnabled ? "Enabled" : "Disabled",
    nodeType: rg.CacheNodeType ?? null,
    shards,
    nodes: rg.MemberClusters?.length ?? 0,
    endpoint: endpointText(rg.ConfigurationEndpoint) ?? endpointText(rg.NodeGroups?.[0]?.PrimaryEndpoint),
    description: rg.Description?.trim() || null,
    created: rg.ReplicationGroupCreateTime ?? null,
    arn: rg.ARN ?? null,
  };
}

function clusterRow(c: CacheCluster, engine: CacheEngine): Row {
  return {
    id: rowIdFor("cluster", c.CacheClusterId ?? "", engine),
    name: c.CacheClusterId ?? "",
    status: c.CacheClusterStatus ?? null,
    deployment: "Node-based cluster",
    engineVersion: c.EngineVersion ?? null,
    clusterMode: engine === "memcached" ? null : "Disabled",
    nodeType: c.CacheNodeType ?? null,
    shards: engine === "memcached" ? null : 1,
    nodes: c.NumCacheNodes ?? null,
    endpoint: endpointText(c.ConfigurationEndpoint) ?? endpointText(c.CacheNodes?.[0]?.Endpoint),
    description: null,
    created: c.CacheClusterCreateTime ?? null,
    arn: c.ARN ?? null,
  };
}

function serverlessRow(s: ServerlessCache, engine: CacheEngine): Row {
  const limits = usageLimitsText(s.CacheUsageLimits);
  return {
    id: rowIdFor("serverless", s.ServerlessCacheName ?? "", engine),
    name: s.ServerlessCacheName ?? "",
    status: s.Status ?? null,
    deployment: "Serverless",
    engineVersion: s.FullEngineVersion ?? s.MajorEngineVersion ?? null,
    clusterMode: null,
    nodeType: null,
    shards: null,
    nodes: null,
    endpoint: endpointText(s.Endpoint),
    description: s.Description?.trim() || (limits.storage ? `Data storage ${limits.storage}` : null),
    created: s.CreateTime ?? null,
    arn: s.ARN ?? null,
  };
}

async function listCaches(ctx: Ctx, engine: CacheEngine): Promise<Row[]> {
  const [groups, clusters, serverless] = await Promise.all([
    engine === "memcached" ? Promise.resolve([]) : replicationGroups(ctx),
    cacheClusters(ctx),
    serverlessCaches(ctx),
  ]);
  const byId = new Map(clusters.filter((c) => c.CacheClusterId).map((c) => [c.CacheClusterId as string, c]));
  const rows: Row[] = [
    ...serverless.filter((s) => s.Engine === engine).map((s) => serverlessRow(s, engine)),
    ...groups.filter((g) => (g.Engine ?? "redis") === engine).map((g) => replicationGroupRow(g, byId, engine)),
    ...clusters.filter((c) => !c.ReplicationGroupId && c.Engine === engine).map((c) => clusterRow(c, engine)),
  ];
  return rows;
}

const tagsOf = (v: FieldValues): Tag[] | undefined => (Array.isArray(v.tags) && v.tags.length ? (v.tags as Tag[]) : undefined);
const optStr = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const optNum = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const strList = (v: unknown): string[] | undefined => (Array.isArray(v) && v.length ? v.filter((x): x is string => typeof x === "string") : undefined);

function createFields(engine: CacheEngine): FieldDef[] {
  const label = engineLabel(engine);
  const nodeBased = { field: "deployment", equals: "node" };
  const serverless = { field: "deployment", equals: "serverless" };
  const fields: FieldDef[] = [
    {
      name: "deployment", label: "Deployment option", kind: "radio", default: "serverless", section: "Engine",
      help: "Serverless scales automatically. A node-based cluster lets you choose node types, shards and replicas.",
      options: [
        { value: "serverless", label: "Serverless - create a cache that scales to application traffic" },
        { value: "node", label: `Design your own cache - choose node types, size and count of your ${label} cluster` },
      ],
    },
    {
      name: "name", label: "Name", kind: "text", required: true, section: "Cache settings", placeholder: "my-cache",
      help: "Must be unique in this Region. Up to 40 letters, numbers or hyphens.", validate: NAME_RULE,
    },
    { name: "description", label: "Description", kind: "text", section: "Cache settings" },
    { name: "engineVersion", label: "Engine version", kind: "select", default: "", options: engineVersionOptions(engine), section: "Cache settings", help: "Leave empty for the latest version. Serverless caches use the major version only." },
    // Serverless settings
    { name: "maxStorage", label: "Maximum data storage (GB)", kind: "number", section: "Usage limits", showIf: serverless, help: "Upper limit on stored data. Leave empty for no limit.", validate: { min: 1, max: 5000, message: "Between 1 and 5000 GB." } },
    { name: "maxEcpu", label: "Maximum ECPUs per second", kind: "number", section: "Usage limits", showIf: serverless, help: "Upper limit on ElastiCache Processing Units per second. Leave empty for no limit.", validate: { min: 1000, max: 15000000, message: "Between 1,000 and 15,000,000." } },
    { name: "subnetIds", label: "Subnets", kind: "multiselect", options: subnetOptions, section: "Connectivity", showIf: serverless, help: "Leave empty to use subnets in the default VPC." },
    { name: "serverlessSecurityGroups", label: "Security groups", kind: "multiselect", options: securityGroupOptions, section: "Connectivity", showIf: serverless },
    // Node-based settings
    { name: "nodeType", label: "Node type", kind: "select", required: true, default: "cache.t3.micro", options: NODE_TYPES, section: "Cluster settings", showIf: nodeBased },
    { name: "parameterGroup", label: "Parameter group", kind: "select", default: "", options: parameterGroupOptions(engine), section: "Cluster settings", showIf: nodeBased, help: "Leave empty for the default parameter group of the engine version." },
    { name: "subnetGroup", label: "Subnet group", kind: "select", default: "", options: subnetGroupOptions, section: "Connectivity", showIf: nodeBased, help: "Leave empty to use the default subnet group of the default VPC." },
    { name: "securityGroups", label: "Security groups", kind: "multiselect", options: securityGroupOptions, section: "Connectivity", showIf: nodeBased },
  ];
  if (engine === "memcached") {
    fields.push({ name: "numNodes", label: "Number of nodes", kind: "number", default: 2, section: "Cluster settings", showIf: nodeBased, validate: { min: 1, max: 60, message: "Between 1 and 60." } });
  } else {
    fields.push(
      { name: "clusterMode", label: "Cluster mode", kind: "radio", default: "disabled", section: "Cluster settings", showIf: nodeBased, help: "Cluster mode spreads data across up to 500 shards.", options: [{ value: "disabled", label: "Disabled - a single shard with up to 5 replicas" }, { value: "enabled", label: "Enabled - multiple shards (node groups)" }] },
      { name: "shards", label: "Number of shards", kind: "number", default: 2, section: "Cluster settings", showIf: { field: "clusterMode", equals: "enabled" }, validate: { min: 1, max: 500, message: "Between 1 and 500." } },
      { name: "replicas", label: "Replicas per shard", kind: "number", default: 2, section: "Cluster settings", showIf: nodeBased, validate: { min: 0, max: 5, message: "Between 0 and 5." } },
      { name: "multiAz", label: "Multi-AZ", kind: "checkbox", default: true, section: "Cluster settings", showIf: nodeBased, help: "Needs at least one replica. Turns on automatic failover too." },
      { name: "transitEncryption", label: "Encryption in transit", kind: "checkbox", default: true, section: "Security", showIf: nodeBased },
      { name: "atRestEncryption", label: "Encryption at rest", kind: "checkbox", default: true, section: "Security", showIf: nodeBased },
      { name: "backupRetention", label: "Backup retention period (days)", kind: "number", default: 1, section: "Backup", help: "0 turns off automatic backups.", validate: { min: 0, max: 35, message: "Between 0 and 35 days." } },
    );
  }
  fields.push({ name: "tags", label: "Tags", kind: "tags", section: "Tags" });
  return fields;
}

async function createCache(ctx: Ctx, engine: CacheEngine, v: FieldValues): Promise<string> {
  const name = String(v.name);
  const ec = ctx.clients.elasticache;
  if (v.deployment === "serverless") {
    const storage = optNum(v.maxStorage);
    const ecpu = optNum(v.maxEcpu);
    await ec.send(new CreateServerlessCacheCommand({
      ServerlessCacheName: name,
      Engine: engine,
      Description: optStr(v.description),
      MajorEngineVersion: majorVersion(engine, optStr(v.engineVersion)),
      CacheUsageLimits: storage || ecpu ? { DataStorage: storage ? { Maximum: storage, Unit: "GB" } : undefined, ECPUPerSecond: ecpu ? { Maximum: ecpu } : undefined } : undefined,
      SubnetIds: strList(v.subnetIds),
      SecurityGroupIds: strList(v.serverlessSecurityGroups),
      SnapshotRetentionLimit: engine === "memcached" ? undefined : optNum(v.backupRetention),
      Tags: tagsOf(v),
    }));
    return rowIdFor("serverless", name, engine);
  }
  if (engine === "memcached") {
    await ec.send(new CreateCacheClusterCommand({
      CacheClusterId: name,
      Engine: "memcached",
      EngineVersion: optStr(v.engineVersion),
      CacheNodeType: String(v.nodeType),
      NumCacheNodes: optNum(v.numNodes) ?? 1,
      CacheParameterGroupName: optStr(v.parameterGroup),
      CacheSubnetGroupName: optStr(v.subnetGroup),
      SecurityGroupIds: strList(v.securityGroups),
      Tags: tagsOf(v),
    }));
    return rowIdFor("cluster", name, engine);
  }
  const replicas = optNum(v.replicas) ?? 0;
  const clustered = v.clusterMode === "enabled";
  const multiAz = v.multiAz === true;
  if (multiAz && replicas < 1) throw new Error("Multi-AZ needs at least one replica. Add a replica or turn Multi-AZ off.");
  await ec.send(new CreateReplicationGroupCommand({
    ReplicationGroupId: name,
    ReplicationGroupDescription: optStr(v.description) ?? " ",
    Engine: engine,
    EngineVersion: optStr(v.engineVersion),
    CacheNodeType: String(v.nodeType),
    CacheParameterGroupName: optStr(v.parameterGroup),
    CacheSubnetGroupName: optStr(v.subnetGroup),
    SecurityGroupIds: strList(v.securityGroups),
    ...(clustered
      ? { NumNodeGroups: optNum(v.shards) ?? 1, ReplicasPerNodeGroup: replicas, ClusterMode: "enabled" as const }
      : { NumCacheClusters: replicas + 1 }),
    MultiAZEnabled: multiAz,
    AutomaticFailoverEnabled: multiAz || clustered,
    TransitEncryptionEnabled: v.transitEncryption === true,
    AtRestEncryptionEnabled: v.atRestEncryption === true,
    SnapshotRetentionLimit: optNum(v.backupRetention),
    Tags: tagsOf(v),
  }));
  return rowIdFor("replication-group", name, engine);
}

export function cacheResource(engine: CacheEngine): ResourceDef {
  const label = engineLabel(engine);
  return {
    id: `${engine}-caches`,
    name: `${label} caches`,
    singular: `${label} cache`,
    idField: "id",
    nameField: "name",
    description: `Serverless caches and node-based clusters running ${label}.`,
    emptyText: `No ${label} caches. Create a ${label} cache to get started.`,
    columns: [
      { key: "name", label: "Cache name", kind: "link" },
      { key: "status", label: "Status", kind: "status" },
      { key: "deployment", label: "Deployment option", kind: "text" },
      { key: "engineVersion", label: "Engine version", kind: "text" },
      ...(engine === "memcached" ? [] : [{ key: "clusterMode", label: "Cluster mode", kind: "text" as const }, { key: "shards", label: "Shards", kind: "count" as const }]),
      { key: "nodes", label: "Nodes", kind: "count" },
      { key: "nodeType", label: "Node type", kind: "text" },
      { key: "endpoint", label: "Endpoint", kind: "code" },
      { key: "created", label: "Created", kind: "date", hidden: true },
      { key: "arn", label: "ARN", kind: "arn", hidden: true },
    ],
    list: (ctx) => listCaches(ctx, engine),
    get: (ctx, id) => cacheDetail(ctx, engine, id),
    create: {
      title: `Create ${label} cache`,
      description: `Creates a ${label} cache in the emulator with ${engine === "memcached" ? "CreateServerlessCache or CreateCacheCluster" : "CreateServerlessCache or CreateReplicationGroup"}.`,
      fields: createFields(engine),
      run: (ctx, v) => createCache(ctx, engine, v),
    },
    actions: cacheActions(engine),
    delete: { confirmText: "delete", run: (ctx, id) => deleteCache(ctx, engine, id) },
  };
}
