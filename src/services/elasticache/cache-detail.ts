/** The cache detail page: summary plus the tabs the ElastiCache console shows for a cache. */

import { DescribeEventsCommand, ListTagsForResourceCommand, type CacheCluster, type SourceType } from "@aws-sdk/client-elasticache";
import { errorMessage } from "../../console/serialize.ts";
import type { ColumnDef, Ctx, Detail, DetailTab, Row } from "../../console/types.ts";
import { enabledText, endpointText, engineLabel, parseCacheId, usageLimitsText, type CacheEngine } from "./helpers.ts";
import { cacheClusters, replicationGroups, serverlessCaches, serverlessSnapshots, snapshots } from "./lookups.ts";

const TAG_COLUMNS: ColumnDef[] = [
  { key: "Key", label: "Key", kind: "text" },
  { key: "Value", label: "Value", kind: "text" },
];

const SNAPSHOT_COLUMNS: ColumnDef[] = [
  { key: "name", label: "Backup name", kind: "text" },
  { key: "status", label: "Status", kind: "status" },
  { key: "type", label: "Type", kind: "text" },
  { key: "created", label: "Created", kind: "date" },
];

const EVENT_COLUMNS: ColumnDef[] = [
  { key: "date", label: "Date", kind: "date" },
  { key: "source", label: "Source", kind: "text" },
  { key: "type", label: "Source type", kind: "text" },
  { key: "message", label: "Message", kind: "text" },
];

async function tagsTab(ctx: Ctx, arn: string | undefined): Promise<DetailTab> {
  const base = { id: "tags", label: "Tags", kind: "table" as const, columns: TAG_COLUMNS };
  if (!arn) return { ...base, data: [], emptyText: "ElastiCache returned no ARN, so tags can't be read." };
  try {
    const r = await ctx.clients.elasticache.send(new ListTagsForResourceCommand({ ResourceName: arn }));
    return { ...base, data: r.TagList ?? [], emptyText: "No tags." };
  } catch (err: unknown) {
    return { ...base, data: [], emptyText: `Could not read tags: ${errorMessage(err)}` };
  }
}

async function eventsTab(ctx: Ctx, sources: { id: string; type: SourceType }[]): Promise<DetailTab> {
  const base = { id: "events", label: "Events", kind: "table" as const, columns: EVENT_COLUMNS, description: "Events from the last 14 days (DescribeEvents)." };
  try {
    const all = await Promise.all(
      sources.map(async (s) => (await ctx.clients.elasticache.send(new DescribeEventsCommand({ SourceIdentifier: s.id, SourceType: s.type, Duration: 20160, MaxRecords: 100 }))).Events ?? [])
    );
    const rows = all.flat().map((e) => ({ date: e.Date ?? null, source: e.SourceIdentifier ?? null, type: e.SourceType ?? null, message: e.Message ?? null }));
    rows.sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
    return { ...base, data: rows, emptyText: "No events in the last 14 days." };
  } catch (err: unknown) {
    return { ...base, data: [], emptyText: `Could not read events: ${errorMessage(err)}` };
  }
}

function nodeRows(clusters: CacheCluster[], roles: Map<string, string>): Row[] {
  return clusters.flatMap((c) =>
    (c.CacheNodes ?? []).map((n) => ({
      node: c.ReplicationGroupId ? c.CacheClusterId ?? "" : `${c.CacheClusterId ?? ""}-${n.CacheNodeId ?? ""}`,
      status: n.CacheNodeStatus ?? c.CacheClusterStatus ?? null,
      role: roles.get(c.CacheClusterId ?? "") ?? null,
      zone: n.CustomerAvailabilityZone ?? c.PreferredAvailabilityZone ?? null,
      endpoint: endpointText(n.Endpoint),
      nodeType: c.CacheNodeType ?? null,
      created: n.CacheNodeCreateTime ?? c.CacheClusterCreateTime ?? null,
    }))
  );
}

const NODE_COLUMNS: ColumnDef[] = [
  { key: "node", label: "Node name", kind: "text" },
  { key: "status", label: "Status", kind: "status" },
  { key: "role", label: "Role", kind: "text" },
  { key: "zone", label: "Availability Zone", kind: "text" },
  { key: "endpoint", label: "Endpoint", kind: "code" },
  { key: "nodeType", label: "Node type", kind: "text" },
  { key: "created", label: "Created", kind: "date" },
];

function securityRow(c: CacheCluster | undefined, extra: Row): Row {
  return {
    ...extra,
    "Subnet group": c?.CacheSubnetGroupName ?? null,
    "Security groups": c?.SecurityGroups?.map((g) => g.SecurityGroupId).filter(Boolean).join(", ") || null,
    "Network type": c?.NetworkType ?? null,
  };
}

async function replicationGroupDetail(ctx: Ctx, name: string): Promise<Detail> {
  const [rg] = await replicationGroups(ctx, name);
  if (!rg) throw new Error(`Replication group ${name} was not found.`);
  const members = (await cacheClusters(ctx)).filter((c) => c.ReplicationGroupId === name);
  const first = members[0];
  const roles = new Map((rg.NodeGroups ?? []).flatMap((g) => (g.NodeGroupMembers ?? []).map((m) => [m.CacheClusterId ?? "", m.CurrentRole ?? ""] as const)));
  const backups = await snapshots(ctx, { ReplicationGroupId: name }).catch(() => snapshots(ctx).then((all) => all.filter((s) => s.ReplicationGroupId === name)));
  const clustered = rg.ClusterEnabled === true;
  return {
    summary: {
      "Cache name": name,
      Status: rg.Status ?? null,
      Engine: engineLabel(rg.Engine),
      "Engine version": first?.EngineVersion ?? null,
      "Deployment option": "Node-based cluster",
      "Cluster mode": clustered ? "Enabled" : "Disabled",
      "Node type": rg.CacheNodeType ?? null,
      Shards: rg.NodeGroups?.length ?? 0,
      "Number of nodes": rg.MemberClusters?.length ?? 0,
      [clustered ? "Configuration endpoint" : "Primary endpoint"]: clustered ? endpointText(rg.ConfigurationEndpoint) : endpointText(rg.NodeGroups?.[0]?.PrimaryEndpoint),
      ...(clustered ? {} : { "Reader endpoint": endpointText(rg.NodeGroups?.[0]?.ReaderEndpoint) }),
      Description: rg.Description?.trim() || null,
      ARN: rg.ARN ?? null,
    },
    tabs: [
      {
        id: "nodes", label: "Nodes", kind: "table", columns: NODE_COLUMNS, data: nodeRows(members, roles),
        emptyText: "ElastiCache returned no nodes for this cache.",
      },
      {
        id: "shards", label: "Shards", kind: "table",
        columns: [
          { key: "shard", label: "Shard name", kind: "text" },
          { key: "status", label: "Status", kind: "status" },
          { key: "slots", label: "Slots/keyspaces", kind: "text" },
          { key: "nodes", label: "Nodes", kind: "count" },
          { key: "primary", label: "Primary endpoint", kind: "code" },
        ],
        data: (rg.NodeGroups ?? []).map((g) => ({ shard: g.NodeGroupId ?? "", status: g.Status ?? null, slots: g.Slots ?? null, nodes: g.NodeGroupMembers?.length ?? 0, primary: endpointText(g.PrimaryEndpoint) })),
        emptyText: "No shards.",
      },
      {
        id: "security", label: "Security", kind: "keyvalue",
        data: securityRow(first, {
          "Encryption at rest": enabledText(rg.AtRestEncryptionEnabled),
          "Encryption key": rg.KmsKeyId ?? (rg.AtRestEncryptionEnabled ? "Default key (sse-elasticache)" : null),
          "Encryption in transit": enabledText(rg.TransitEncryptionEnabled),
          "Transit encryption mode": rg.TransitEncryptionMode ?? null,
          "AUTH token": enabledText(rg.AuthTokenEnabled),
          "User group IDs": rg.UserGroupIds?.join(", ") || null,
        }),
      },
      {
        id: "availability", label: "Availability", kind: "keyvalue",
        data: { "Multi-AZ": enabledText(rg.MultiAZ), "Auto-failover": enabledText(rg.AutomaticFailover), "Data tiering": enabledText(rg.DataTiering), "Global datastore": rg.GlobalReplicationGroupInfo?.GlobalReplicationGroupId ?? "None" },
      },
      {
        id: "backups", label: "Backups", kind: "table", columns: SNAPSHOT_COLUMNS,
        description: `Automatic backups: ${rg.SnapshotRetentionLimit ? `kept ${rg.SnapshotRetentionLimit} day(s), window ${rg.SnapshotWindow ?? "-"}` : "Disabled"}. Backup node: ${rg.SnapshottingClusterId ?? "-"}.`,
        data: backups.map((s) => ({ name: s.SnapshotName ?? "", status: s.SnapshotStatus ?? null, type: s.SnapshotSource ?? null, created: s.NodeSnapshots?.[0]?.SnapshotCreateTime ?? null })),
        emptyText: "No backups of this cache.",
      },
      {
        id: "maintenance", label: "Maintenance", kind: "keyvalue",
        data: {
          "Maintenance window": first?.PreferredMaintenanceWindow ?? null,
          "Parameter group": first?.CacheParameterGroup?.CacheParameterGroupName ?? null,
          "Parameter group status": first?.CacheParameterGroup?.ParameterApplyStatus ?? null,
          "Auto upgrade minor versions": enabledText(rg.AutoMinorVersionUpgrade ?? first?.AutoMinorVersionUpgrade),
          "Pending changes": rg.PendingModifiedValues && Object.keys(rg.PendingModifiedValues).length ? JSON.stringify(rg.PendingModifiedValues) : "None",
        },
      },
      await eventsTab(ctx, [{ id: name, type: "replication-group" }, ...members.filter((m) => m.CacheClusterId).map((m) => ({ id: m.CacheClusterId as string, type: "cache-cluster" as const }))]),
      await tagsTab(ctx, rg.ARN),
    ],
  };
}

async function clusterDetail(ctx: Ctx, engine: CacheEngine, name: string): Promise<Detail> {
  const [c] = await cacheClusters(ctx, name);
  if (!c) throw new Error(`Cache cluster ${name} was not found.`);
  const backups = engine === "memcached" ? [] : (await snapshots(ctx, { CacheClusterId: name }));
  return {
    summary: {
      "Cache name": name,
      Status: c.CacheClusterStatus ?? null,
      Engine: engineLabel(c.Engine),
      "Engine version": c.EngineVersion ?? null,
      "Deployment option": "Node-based cluster",
      "Node type": c.CacheNodeType ?? null,
      "Number of nodes": c.NumCacheNodes ?? null,
      [engine === "memcached" ? "Configuration endpoint" : "Primary endpoint"]: endpointText(c.ConfigurationEndpoint) ?? endpointText(c.CacheNodes?.[0]?.Endpoint),
      "Availability Zone": c.PreferredAvailabilityZone ?? null,
      ARN: c.ARN ?? null,
    },
    tabs: [
      { id: "nodes", label: "Nodes", kind: "table", columns: NODE_COLUMNS, data: nodeRows([c], new Map()), emptyText: "ElastiCache returned no nodes for this cluster." },
      {
        id: "security", label: "Security", kind: "keyvalue",
        data: securityRow(c, { "Encryption at rest": enabledText(c.AtRestEncryptionEnabled), "Encryption in transit": enabledText(c.TransitEncryptionEnabled), "AUTH token": enabledText(c.AuthTokenEnabled) }),
      },
      ...(engine === "memcached"
        ? []
        : [{
            id: "backups", label: "Backups", kind: "table" as const, columns: SNAPSHOT_COLUMNS,
            description: `Automatic backups: ${c.SnapshotRetentionLimit ? `kept ${c.SnapshotRetentionLimit} day(s), window ${c.SnapshotWindow ?? "-"}` : "Disabled"}.`,
            data: backups.map((s) => ({ name: s.SnapshotName ?? "", status: s.SnapshotStatus ?? null, type: s.SnapshotSource ?? null, created: s.NodeSnapshots?.[0]?.SnapshotCreateTime ?? null })),
            emptyText: "No backups of this cache.",
          }]),
      {
        id: "maintenance", label: "Maintenance", kind: "keyvalue",
        data: {
          "Maintenance window": c.PreferredMaintenanceWindow ?? null,
          "Parameter group": c.CacheParameterGroup?.CacheParameterGroupName ?? null,
          "Parameter group status": c.CacheParameterGroup?.ParameterApplyStatus ?? null,
          "Auto upgrade minor versions": enabledText(c.AutoMinorVersionUpgrade),
          "Pending changes": c.PendingModifiedValues && Object.keys(c.PendingModifiedValues).length ? JSON.stringify(c.PendingModifiedValues) : "None",
        },
      },
      await eventsTab(ctx, [{ id: name, type: "cache-cluster" }]),
      await tagsTab(ctx, c.ARN),
    ],
  };
}

async function serverlessDetail(ctx: Ctx, engine: CacheEngine, name: string): Promise<Detail> {
  const [s] = await serverlessCaches(ctx, name);
  if (!s) throw new Error(`Serverless cache ${name} was not found.`);
  const limits = usageLimitsText(s.CacheUsageLimits);
  const backups = engine === "memcached" ? [] : await serverlessSnapshots(ctx, { ServerlessCacheName: name });
  return {
    summary: {
      "Cache name": name,
      Status: s.Status ?? null,
      Engine: engineLabel(s.Engine),
      "Engine version": s.FullEngineVersion ?? s.MajorEngineVersion ?? null,
      "Deployment option": "Serverless",
      Endpoint: endpointText(s.Endpoint),
      "Reader endpoint": endpointText(s.ReaderEndpoint),
      Description: s.Description?.trim() || null,
      Created: s.CreateTime ?? null,
      ARN: s.ARN ?? null,
    },
    tabs: [
      {
        id: "settings", label: "Settings", kind: "keyvalue",
        data: {
          "Maximum data storage": limits.storage ?? "No limit",
          "Maximum ECPUs per second": limits.ecpu ?? "No limit",
          "Encryption at rest": s.KmsKeyId ? `AWS KMS key ${s.KmsKeyId}` : s.StorageEncryptionType ?? "Default key",
          Subnets: s.SubnetIds?.join(", ") || null,
          "Security groups": s.SecurityGroupIds?.join(", ") || null,
          "User group": s.UserGroupId ?? null,
          "Network type": s.NetworkType ?? null,
        },
      },
      ...(engine === "memcached"
        ? []
        : [{
            id: "backups", label: "Backups", kind: "table" as const, columns: SNAPSHOT_COLUMNS,
            description: `Automatic backups: ${s.SnapshotRetentionLimit ? `kept ${s.SnapshotRetentionLimit} day(s), daily at ${s.DailySnapshotTime ?? "-"} UTC` : "Disabled"}.`,
            data: backups.map((b) => ({ name: b.ServerlessCacheSnapshotName ?? "", status: b.Status ?? null, type: b.SnapshotType ?? null, created: b.CreateTime ?? null })),
            emptyText: "No backups of this cache.",
          }]),
      await eventsTab(ctx, [{ id: name, type: "serverless-cache" }]),
      await tagsTab(ctx, s.ARN),
    ],
  };
}

export function cacheDetail(ctx: Ctx, engine: CacheEngine, id: string): Promise<Detail> {
  const ref = parseCacheId(id, engine);
  if (ref.kind === "serverless") return serverlessDetail(ctx, engine, ref.name);
  if (ref.kind === "cluster") return clusterDetail(ctx, engine, ref.name);
  return replicationGroupDetail(ctx, ref.name);
}
