/** ElastiCache backups (node-based snapshots and serverless snapshots) and events. */

import {
  CopySnapshotCommand,
  CreateReplicationGroupCommand,
  CreateServerlessCacheCommand,
  DeleteSnapshotCommand,
  DescribeEventsCommand,
} from "@aws-sdk/client-elasticache";
import type { ResourceDef, Row } from "../../console/types.ts";
import { engineLabel } from "./helpers.ts";
import { NODE_TYPES, serverlessSnapshots, snapshots } from "./lookups.ts";

const SERVERLESS = "serverless:";
const NAME = { pattern: "[a-zA-Z][a-zA-Z0-9-]{0,39}", message: "1-40 letters, numbers or hyphens, starting with a letter." };

type BackupRef = { serverless: boolean; name: string };
const parseBackup = (id: string): BackupRef => (id.startsWith(SERVERLESS) ? { serverless: true, name: id.slice(SERVERLESS.length) } : { serverless: false, name: id });

/** Restore and copy need a finished backup. */
function backupAvailable(row: Row): boolean {
  const status = row.status ?? row.Status;
  return typeof status !== "string" || status === "available";
}

export const backupResource: ResourceDef = {
  id: "backups",
  name: "Backups",
  singular: "backup",
  idField: "id",
  nameField: "name",
  description: "Point-in-time copies of Valkey and Redis OSS caches. Restore one to create a new cache.",
  emptyText: "No backups. Use Backup on a cache to create one.",
  columns: [
    { key: "name", label: "Backup name", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "type", label: "Backup type", kind: "text" },
    { key: "source", label: "Source cache", kind: "text" },
    { key: "deployment", label: "Deployment option", kind: "text" },
    { key: "engine", label: "Engine", kind: "text" },
    { key: "created", label: "Created", kind: "date" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],
  async list(ctx) {
    const [nodeBased, serverless] = await Promise.all([snapshots(ctx), serverlessSnapshots(ctx)]);
    const rows: Row[] = [
      ...serverless.map((s) => ({
        id: `${SERVERLESS}${s.ServerlessCacheSnapshotName ?? ""}`,
        name: s.ServerlessCacheSnapshotName ?? "",
        status: s.Status ?? null,
        type: s.SnapshotType ?? null,
        source: s.ServerlessCacheConfiguration?.ServerlessCacheName ?? null,
        deployment: "Serverless",
        engine: engineLabel(s.ServerlessCacheConfiguration?.Engine),
        created: s.CreateTime ?? null,
        arn: s.ARN ?? null,
      })),
      ...nodeBased.map((s) => ({
        id: s.SnapshotName ?? "",
        name: s.SnapshotName ?? "",
        status: s.SnapshotStatus ?? null,
        type: s.SnapshotSource ?? null,
        source: s.ReplicationGroupId ?? s.CacheClusterId ?? null,
        deployment: "Node-based cluster",
        engine: engineLabel(s.Engine),
        created: s.NodeSnapshots?.[0]?.SnapshotCreateTime ?? null,
        arn: s.ARN ?? null,
      })),
    ];
    return rows;
  },
  async get(ctx, id) {
    const ref = parseBackup(id);
    if (ref.serverless) {
      const [s] = await serverlessSnapshots(ctx, { ServerlessCacheSnapshotName: ref.name });
      if (!s) throw new Error(`Backup ${ref.name} was not found.`);
      return {
        summary: {
          "Backup name": ref.name,
          Status: s.Status ?? null,
          "Backup type": s.SnapshotType ?? null,
          "Source cache": s.ServerlessCacheConfiguration?.ServerlessCacheName ?? null,
          Engine: engineLabel(s.ServerlessCacheConfiguration?.Engine),
          "Major engine version": s.ServerlessCacheConfiguration?.MajorEngineVersion ?? null,
          "Size (bytes used)": s.BytesUsedForCache ?? null,
          Created: s.CreateTime ?? null,
          "Expires": s.ExpiryTime ?? null,
          "KMS key": s.KmsKeyId ?? null,
          ARN: s.ARN ?? null,
        },
      };
    }
    const [s] = await snapshots(ctx, { SnapshotName: ref.name });
    if (!s) throw new Error(`Backup ${ref.name} was not found.`);
    return {
      summary: {
        "Backup name": ref.name,
        Status: s.SnapshotStatus ?? null,
        "Backup type": s.SnapshotSource ?? null,
        "Source cache": s.ReplicationGroupId ?? s.CacheClusterId ?? null,
        Engine: engineLabel(s.Engine),
        "Engine version": s.EngineVersion ?? null,
        "Node type": s.CacheNodeType ?? null,
        Shards: s.NumNodeGroups ?? null,
        "Cluster mode": s.AutomaticFailover === undefined ? null : s.NumNodeGroups && s.NumNodeGroups > 1 ? "Enabled" : "Disabled",
        "Parameter group": s.CacheParameterGroupName ?? null,
        "KMS key": s.KmsKeyId ?? null,
        ARN: s.ARN ?? null,
      },
      tabs: [
        {
          id: "nodes", label: "Node snapshots", kind: "table",
          columns: [
            { key: "cluster", label: "Node", kind: "text" },
            { key: "shard", label: "Shard", kind: "text" },
            { key: "size", label: "Cache size", kind: "text" },
            { key: "created", label: "Snapshot created", kind: "date" },
          ],
          data: (s.NodeSnapshots ?? []).map((n) => ({ cluster: n.CacheClusterId ?? n.CacheNodeId ?? "", shard: n.NodeGroupId ?? null, size: n.CacheSize ?? null, created: n.SnapshotCreateTime ?? null })),
          emptyText: "No node snapshots.",
        },
      ],
    };
  },
  actions: [
    {
      id: "restore",
      label: "Restore",
      availableFor: backupAvailable,
      fields: [
        { name: "name", label: "New cache name", kind: "text", required: true, validate: NAME },
        { name: "nodeType", label: "Node type (node-based backups)", kind: "select", default: "cache.t3.micro", options: NODE_TYPES },
      ],
      async run(ctx, id, v) {
        const ref = parseBackup(id);
        const name = String(v.name);
        if (ref.serverless) {
          const [s] = await serverlessSnapshots(ctx, { ServerlessCacheSnapshotName: ref.name });
          const engine = s?.ServerlessCacheConfiguration?.Engine;
          if (!s || !engine || !s.ARN) throw new Error(`Backup ${ref.name} was not found.`);
          await ctx.clients.elasticache.send(new CreateServerlessCacheCommand({ ServerlessCacheName: name, Engine: engine, MajorEngineVersion: s.ServerlessCacheConfiguration?.MajorEngineVersion, SnapshotArnsToRestore: [s.ARN] }));
          return { message: `Restoring ${ref.name} into new serverless cache ${name}.` };
        }
        const [s] = await snapshots(ctx, { SnapshotName: ref.name });
        if (!s) throw new Error(`Backup ${ref.name} was not found.`);
        const r = await ctx.clients.elasticache.send(new CreateReplicationGroupCommand({
          ReplicationGroupId: name,
          ReplicationGroupDescription: `Restored from ${ref.name}`,
          SnapshotName: ref.name,
          Engine: s.Engine,
          CacheNodeType: typeof v.nodeType === "string" && v.nodeType ? v.nodeType : s.CacheNodeType,
        }));
        return { message: `Restoring ${ref.name} into new cache ${name}. Status: ${r.ReplicationGroup?.Status ?? "unknown"}.` };
      },
    },
    {
      id: "copy",
      label: "Copy (node-based backups)",
      availableFor: backupAvailable,
      fields: [{ name: "target", label: "New backup name", kind: "text", required: true, validate: NAME }],
      async run(ctx, id, v) {
        const ref = parseBackup(id);
        const target = String(v.target);
        // CopyServerlessCacheSnapshot is not implemented by AWS Emulator (see notSupported).
        if (ref.serverless) throw new Error("AWS Emulator doesn't support copying serverless backups yet (CopyServerlessCacheSnapshot).");
        await ctx.clients.elasticache.send(new CopySnapshotCommand({ SourceSnapshotName: ref.name, TargetSnapshotName: target }));
        return { message: `Copying ${ref.name} to ${target}.` };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      const ref = parseBackup(id);
      // DeleteServerlessCacheSnapshot is not implemented by AWS Emulator (see notSupported).
      if (ref.serverless) throw new Error("AWS Emulator doesn't support deleting serverless backups yet (DeleteServerlessCacheSnapshot).");
      await ctx.clients.elasticache.send(new DeleteSnapshotCommand({ SnapshotName: ref.name }));
    },
  },
};

export const eventResource: ResourceDef = {
  id: "events",
  name: "Events",
  singular: "event",
  idField: "key",
  description: "ElastiCache events from the last 14 days.",
  emptyText: "No events in the last 14 days.",
  columns: [
    { key: "source", label: "Source", kind: "link" },
    { key: "type", label: "Type", kind: "text" },
    { key: "date", label: "Date", kind: "date" },
    { key: "message", label: "Message", kind: "text" },
  ],
  async list(ctx) {
    const rows: Row[] = [];
    let marker: string | undefined;
    for (let i = 0; i < 20; i++) {
      const r = await ctx.clients.elasticache.send(new DescribeEventsCommand({ Duration: 20160, MaxRecords: 100, Marker: marker }));
      for (const e of r.Events ?? []) {
        rows.push({ key: `${rows.length}`, source: e.SourceIdentifier ?? "", type: e.SourceType ?? null, date: e.Date ?? null, message: e.Message ?? null });
      }
      if (!r.Marker || r.Marker === marker) break;
      marker = r.Marker;
    }
    return rows;
  },
};
