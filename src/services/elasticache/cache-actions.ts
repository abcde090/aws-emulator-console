/** Actions on an ElastiCache cache. Each one checks which kind of cache the id names. */

import { fieldTags, tagDiff, tagDiffMessage } from "../../console/tags.ts";
import {
  AddTagsToResourceCommand,
  CreateServerlessCacheSnapshotCommand,
  CreateSnapshotCommand,
  DecreaseReplicaCountCommand,
  DeleteCacheClusterCommand,
  DeleteReplicationGroupCommand,
  DeleteServerlessCacheCommand,
  IncreaseReplicaCountCommand,
  ModifyCacheClusterCommand,
  ModifyReplicationGroupCommand,
  ModifyServerlessCacheCommand,
  RebootCacheClusterCommand,
  ListTagsForResourceCommand,
  RemoveTagsFromResourceCommand,
  TestFailoverCommand,
} from "@aws-sdk/client-elasticache";
import type { ActionDef, Ctx, FieldValues, Option, Row, Tag } from "../../console/types.ts";
import { parseCacheId, type CacheEngine, type CacheRef } from "./helpers.ts";
import { cacheClusters, NODE_TYPES, replicationGroups, serverlessCaches } from "./lookups.ts";

const optStr = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const optNum = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const SNAPSHOT_NAME = { pattern: "[a-zA-Z][a-zA-Z0-9-]{0,254}", message: "Letters, numbers and hyphens, starting with a letter." };

function nodeBasedOnly(ref: CacheRef, what: string): asserts ref is Exclude<CacheRef, { kind: "serverless" }> {
  if (ref.kind === "serverless") throw new Error(`${what} applies to node-based clusters. Serverless caches manage their own nodes.`);
}

async function arnOf(ctx: Ctx, ref: CacheRef): Promise<string> {
  const arn =
    ref.kind === "serverless" ? (await serverlessCaches(ctx, ref.name))[0]?.ARN
    : ref.kind === "cluster" ? (await cacheClusters(ctx, ref.name))[0]?.ARN
    : (await replicationGroups(ctx, ref.name))[0]?.ARN;
  if (!arn) throw new Error(`ElastiCache returned no ARN for ${ref.name}.`);
  return arn;
}

/** The node that backups are taken from: the primary of the first shard. */
async function backupSource(ctx: Ctx, name: string): Promise<string> {
  const [rg] = await replicationGroups(ctx, name);
  const primary = rg?.NodeGroups?.[0]?.NodeGroupMembers?.find((m) => m.CurrentRole === "primary")?.CacheClusterId;
  const source = rg?.SnapshottingClusterId ?? primary ?? rg?.MemberClusters?.[0];
  if (!source) throw new Error(`Replication group ${name} has no node to back up.`);
  return source;
}

/** The wanted value when it differs from the current one, else undefined (nothing to send). */
function changed<T>(wanted: T | undefined, current: T | undefined): T | undefined {
  return wanted !== undefined && wanted !== current ? wanted : undefined;
}

/** Current settings of a cache, in the Modify dialog's field names. */
async function currentSettings(ctx: Ctx, engine: CacheEngine, ref: CacheRef): Promise<FieldValues> {
  if (ref.kind === "serverless") {
    const [s] = await serverlessCaches(ctx, ref.name);
    if (!s) throw new Error(`Serverless cache ${ref.name} was not found.`);
    return {
      description: s.Description?.trim() ?? "",
      maxStorage: s.CacheUsageLimits?.DataStorage?.Maximum ?? null,
      maxEcpu: s.CacheUsageLimits?.ECPUPerSecond?.Maximum ?? null,
      ...(engine === "memcached" ? {} : { backupRetention: s.SnapshotRetentionLimit ?? null }),
    };
  }
  if (ref.kind === "cluster") {
    const [c] = await cacheClusters(ctx, ref.name);
    if (!c) throw new Error(`Cache cluster ${ref.name} was not found.`);
    return {
      nodeType: c.CacheNodeType ?? "",
      ...(engine === "memcached" ? { numNodes: c.NumCacheNodes ?? null } : { backupRetention: c.SnapshotRetentionLimit ?? null }),
    };
  }
  const [rg] = await replicationGroups(ctx, ref.name);
  if (!rg) throw new Error(`Replication group ${ref.name} was not found.`);
  return { description: rg.Description?.trim() ?? "", nodeType: rg.CacheNodeType ?? "", backupRetention: rg.SnapshotRetentionLimit ?? null };
}

/** Sends only what the user changed; an unchanged dialog calls nothing. */
async function modify(ctx: Ctx, engine: CacheEngine, ref: CacheRef, v: FieldValues): Promise<string> {
  const ec = ctx.clients.elasticache;
  const apply = v.applyImmediately === true;
  const now = await currentSettings(ctx, engine, ref);
  const description = changed(optStr(v.description), optStr(now.description));
  const nodeType = changed(optStr(v.nodeType), optStr(now.nodeType));
  const retention = engine === "memcached" ? undefined : changed(optNum(v.backupRetention), optNum(now.backupRetention));
  const noChange = `No changes to ${ref.name}.`;
  if (ref.kind === "serverless") {
    const storage = changed(optNum(v.maxStorage), optNum(now.maxStorage));
    const ecpu = changed(optNum(v.maxEcpu), optNum(now.maxEcpu));
    if (description === undefined && storage === undefined && ecpu === undefined && retention === undefined) return noChange;
    const keepStorage = storage ?? optNum(now.maxStorage);
    const keepEcpu = ecpu ?? optNum(now.maxEcpu);
    await ec.send(new ModifyServerlessCacheCommand({
      ServerlessCacheName: ref.name,
      Description: description,
      // CacheUsageLimits replaces both limits, so the one left alone is sent back as it is.
      CacheUsageLimits: storage !== undefined || ecpu !== undefined
        ? { DataStorage: keepStorage ? { Maximum: keepStorage, Unit: "GB" } : undefined, ECPUPerSecond: keepEcpu ? { Maximum: keepEcpu } : undefined }
        : undefined,
      SnapshotRetentionLimit: retention,
    }));
    return `Modified serverless cache ${ref.name}.`;
  }
  if (ref.kind === "cluster") {
    const [c] = await cacheClusters(ctx, ref.name);
    if (!c) throw new Error(`Cache cluster ${ref.name} was not found.`);
    const current = c.NumCacheNodes ?? 0;
    const wanted = engine === "memcached" ? changed(optNum(v.numNodes), current) : undefined;
    if (nodeType === undefined && wanted === undefined && retention === undefined) return noChange;
    const remove = wanted !== undefined && wanted < current
      ? (c.CacheNodes ?? []).map((n) => n.CacheNodeId ?? "").filter(Boolean).sort().slice(wanted)
      : undefined;
    const r = await ec.send(new ModifyCacheClusterCommand({
      CacheClusterId: ref.name,
      CacheNodeType: nodeType,
      NumCacheNodes: wanted,
      CacheNodeIdsToRemove: remove,
      SnapshotRetentionLimit: retention,
      ApplyImmediately: apply,
    }));
    return `Modified ${ref.name}. Status: ${r.CacheCluster?.CacheClusterStatus ?? "unknown"}.`;
  }
  if (description === undefined && nodeType === undefined && retention === undefined) return noChange;
  const r = await ec.send(new ModifyReplicationGroupCommand({
    ReplicationGroupId: ref.name,
    ReplicationGroupDescription: description,
    CacheNodeType: nodeType,
    SnapshotRetentionLimit: retention,
    ApplyImmediately: apply,
  }));
  return `Modified ${ref.name}. Status: ${r.ReplicationGroup?.Status ?? "unknown"}.`;
}

/** The node types, plus the cache's current type when it isn't in the list. */
function nodeTypeOptions(engine: CacheEngine): (ctx: Ctx, id?: string) => Promise<Option[]> {
  return async (ctx, id) => {
    if (!id) return NODE_TYPES;
    const ref = parseCacheId(id, engine);
    if (ref.kind === "serverless") return NODE_TYPES;
    const current = ref.kind === "cluster" ? (await cacheClusters(ctx, ref.name))[0]?.CacheNodeType : (await replicationGroups(ctx, ref.name))[0]?.CacheNodeType;
    return current && !NODE_TYPES.some((o) => o.value === current) ? [{ value: current, label: current }, ...NODE_TYPES] : NODE_TYPES;
  };
}

// ---- When actions apply (list row or detail summary) ----

const rowStatus = (row: Row): unknown => row.status ?? row.Status;
const isAvailable = (row: Row): boolean => typeof rowStatus(row) !== "string" || rowStatus(row) === "available";
const isServerless = (row: Row): boolean => (row.deployment ?? row["Deployment option"]) === "Serverless";
/** A node-based replication group (not a single cache cluster, not serverless). */
function isReplicationGroup(row: Row): boolean {
  if (isServerless(row)) return false;
  if (typeof row.id === "string") return !row.id.startsWith("cluster:");
  return "Shards" in row;
}

async function currentTags(ctx: Ctx, arn: string): Promise<Tag[]> {
  const r = await ctx.clients.elasticache.send(new ListTagsForResourceCommand({ ResourceName: arn }));
  return (r.TagList ?? []).filter((t) => t.Key).map((t) => ({ Key: t.Key as string, Value: t.Value ?? "" }));
}

export async function deleteCache(ctx: Ctx, engine: CacheEngine, id: string, finalSnapshot?: string): Promise<void> {
  const ref = parseCacheId(id, engine);
  const ec = ctx.clients.elasticache;
  if (ref.kind === "serverless") await ec.send(new DeleteServerlessCacheCommand({ ServerlessCacheName: ref.name, FinalSnapshotName: finalSnapshot }));
  else if (ref.kind === "cluster") await ec.send(new DeleteCacheClusterCommand({ CacheClusterId: ref.name, FinalSnapshotIdentifier: finalSnapshot }));
  else await ec.send(new DeleteReplicationGroupCommand({ ReplicationGroupId: ref.name, FinalSnapshotIdentifier: finalSnapshot, RetainPrimaryCluster: false }));
}

export function cacheActions(engine: CacheEngine): ActionDef[] {
  const redisLike = engine !== "memcached";
  const actions: ActionDef[] = [
    {
      id: "modify",
      label: "Modify",
      fields: [
        { name: "description", label: "Description", kind: "text", help: "Replication groups and serverless caches. Clearing it keeps the current description." },
        { name: "nodeType", label: "Node type (node-based only)", kind: "select", options: nodeTypeOptions(engine) },
        ...(engine === "memcached"
          ? [{ name: "numNodes", label: "Number of nodes (node-based only)", kind: "number" as const, validate: { min: 1, max: 60, message: "Between 1 and 60." }, help: "Fewer nodes removes the highest-numbered nodes." }]
          : [{ name: "backupRetention", label: "Backup retention period (days)", kind: "number" as const, validate: { min: 0, max: 35, message: "Between 0 and 35." } }]),
        { name: "maxStorage", label: "Maximum data storage in GB (serverless only)", kind: "number", validate: { min: 1, max: 5000, message: "Between 1 and 5000 GB." } },
        { name: "maxEcpu", label: "Maximum ECPUs per second (serverless only)", kind: "number", validate: { min: 1000, max: 15000000, message: "Between 1,000 and 15,000,000." } },
        { name: "applyImmediately", label: "Apply immediately", kind: "checkbox", default: true, help: "Otherwise changes wait for the next maintenance window." },
      ],
      initialValues: (ctx, id) => currentSettings(ctx, engine, parseCacheId(id, engine)),
      async run(ctx, id, v) {
        return { message: await modify(ctx, engine, parseCacheId(id, engine), v) };
      },
    },
    {
      id: "reboot",
      label: "Reboot nodes",
      confirm: "Rebooting restarts every node of this cluster. Cached data on Memcached nodes is lost.",
      availableFor: (row) => !isServerless(row) && isAvailable(row),
      async run(ctx, id) {
        const ref = parseCacheId(id, engine);
        nodeBasedOnly(ref, "Rebooting nodes");
        const clusters = ref.kind === "cluster" ? await cacheClusters(ctx, ref.name) : (await cacheClusters(ctx)).filter((c) => c.ReplicationGroupId === ref.name);
        for (const c of clusters) {
          const nodes = (c.CacheNodes ?? []).map((n) => n.CacheNodeId ?? "").filter(Boolean);
          if (c.CacheClusterId && nodes.length) await ctx.clients.elasticache.send(new RebootCacheClusterCommand({ CacheClusterId: c.CacheClusterId, CacheNodeIdsToReboot: nodes }));
        }
        return { message: `Reboot requested for ${clusters.length} node group${clusters.length === 1 ? "" : "s"} of ${ref.name}.` };
      },
    },
    {
      id: "tags",
      label: "Manage tags",
      fields: [{ name: "tags", label: "Tags", kind: "tags", help: "Tags you remove here are removed from the cache." }],
      async initialValues(ctx, id) {
        return { tags: await currentTags(ctx, await arnOf(ctx, parseCacheId(id, engine))) };
      },
      async run(ctx, id, v) {
        const arn = await arnOf(ctx, parseCacheId(id, engine));
        const diff = tagDiff(await currentTags(ctx, arn), fieldTags(v.tags));
        if (diff.set.length) await ctx.clients.elasticache.send(new AddTagsToResourceCommand({ ResourceName: arn, Tags: diff.set }));
        if (diff.remove.length) await ctx.clients.elasticache.send(new RemoveTagsFromResourceCommand({ ResourceName: arn, TagKeys: diff.remove }));
        return { message: tagDiffMessage(diff) };
      },
    },
  ];
  if (!redisLike) return actions;
  return [
    ...actions,
    {
      id: "backup",
      label: "Backup",
      availableFor: isAvailable,
      fields: [{ name: "snapshotName", label: "Backup name", kind: "text", required: true, validate: SNAPSHOT_NAME }],
      async run(ctx, id, v) {
        const ref = parseCacheId(id, engine);
        const name = String(v.snapshotName);
        if (ref.kind === "serverless") {
          const r = await ctx.clients.elasticache.send(new CreateServerlessCacheSnapshotCommand({ ServerlessCacheName: ref.name, ServerlessCacheSnapshotName: name }));
          return { message: `Backup ${name} is ${r.ServerlessCacheSnapshot?.Status ?? "requested"}.` };
        }
        const source = ref.kind === "cluster" ? ref.name : await backupSource(ctx, ref.name);
        const r = await ctx.clients.elasticache.send(new CreateSnapshotCommand({ CacheClusterId: source, SnapshotName: name }));
        return { message: `Backup ${name} of node ${source} is ${r.Snapshot?.SnapshotStatus ?? "requested"}.` };
      },
    },
    {
      id: "add-replicas",
      label: "Add replicas",
      availableFor: (row) => isReplicationGroup(row) && isAvailable(row),
      fields: [{ name: "count", label: "New number of replicas per shard", kind: "number", required: true, default: 2, validate: { min: 1, max: 5, message: "Between 1 and 5." } }],
      async run(ctx, id, v) {
        const ref = parseCacheId(id, engine);
        if (ref.kind !== "replication-group") throw new Error("Replicas can be added to node-based clusters only.");
        const r = await ctx.clients.elasticache.send(new IncreaseReplicaCountCommand({ ReplicationGroupId: ref.name, NewReplicaCount: Number(v.count), ApplyImmediately: true }));
        return { message: `${ref.name} now has ${r.ReplicationGroup?.MemberClusters?.length ?? "?"} nodes. Status: ${r.ReplicationGroup?.Status ?? "unknown"}.` };
      },
    },
    {
      id: "remove-replicas",
      label: "Remove replicas",
      availableFor: (row) => isReplicationGroup(row) && isAvailable(row),
      danger: true,
      fields: [{ name: "count", label: "New number of replicas per shard", kind: "number", required: true, default: 1, validate: { min: 0, max: 4, message: "Between 0 and 4." } }],
      async run(ctx, id, v) {
        const ref = parseCacheId(id, engine);
        if (ref.kind !== "replication-group") throw new Error("Replicas can be removed from node-based clusters only.");
        const r = await ctx.clients.elasticache.send(new DecreaseReplicaCountCommand({ ReplicationGroupId: ref.name, NewReplicaCount: Number(v.count), ApplyImmediately: true }));
        return { message: `${ref.name} now has ${r.ReplicationGroup?.MemberClusters?.length ?? "?"} nodes. Status: ${r.ReplicationGroup?.Status ?? "unknown"}.` };
      },
    },
    {
      id: "failover",
      label: "Failover primary",
      availableFor: (row) => isReplicationGroup(row) && isAvailable(row),
      confirm: "Tests automatic failover: a replica of the shard is promoted to primary (TestFailover).",
      fields: [{ name: "shard", label: "Shard (node group ID)", kind: "text", required: true, default: "0001", validate: { pattern: "[0-9]{4}", message: "A 4-digit node group ID, e.g. 0001." } }],
      async run(ctx, id, v) {
        const ref = parseCacheId(id, engine);
        if (ref.kind !== "replication-group") throw new Error("Failover applies to node-based clusters with replicas.");
        const r = await ctx.clients.elasticache.send(new TestFailoverCommand({ ReplicationGroupId: ref.name, NodeGroupId: String(v.shard) }));
        return { message: `Failover started for shard ${String(v.shard)}. Status: ${r.ReplicationGroup?.Status ?? "unknown"}.` };
      },
    },
    {
      id: "delete-with-backup",
      label: "Delete with final backup",
      danger: true,
      confirm: "Deletes the cache after taking a final backup. This can't be undone.",
      fields: [{ name: "finalSnapshot", label: "Final backup name", kind: "text", required: true, validate: SNAPSHOT_NAME }],
      async run(ctx, id, v) {
        await deleteCache(ctx, engine, id, String(v.finalSnapshot));
        return { message: `Deleting ${parseCacheId(id, engine).name}; final backup ${String(v.finalSnapshot)} requested. Refresh the list to follow its status.` };
      },
    },
  ];
}
