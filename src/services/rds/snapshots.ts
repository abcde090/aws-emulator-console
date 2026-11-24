/**
 * RDS "Snapshots": DB snapshots and DB cluster snapshots, manual and automated, with
 * restore, copy and delete.
 */

import {
  CopyDBClusterSnapshotCommand,
  CopyDBSnapshotCommand,
  CreateDBClusterSnapshotCommand,
  CreateDBSnapshotCommand,
  DeleteDBClusterSnapshotCommand,
  DeleteDBSnapshotCommand,
  DescribeDBClusterSnapshotsCommand,
  DescribeDBSnapshotsCommand,
  RestoreDBClusterFromSnapshotCommand,
  RestoreDBInstanceFromDBSnapshotCommand,
  type DBClusterSnapshot,
  type DBSnapshot,
} from "@aws-sdk/client-rds";
import type { Ctx, Option, ResourceDef, Row } from "../../console/types.ts";
import { dbKey, engineName, IDENTIFIER, INSTANCE_CLASSES, parseDbKey } from "./format.ts";
import { allClusters, allInstances, optionalText, tagColumns, text } from "./shared.ts";

const CLASS_OPTIONS = INSTANCE_CLASSES.map((c) => ({ value: c, label: c }));
const idValidate = { pattern: IDENTIFIER, message: "1-63 letters, numbers or hyphens; starts with a letter; no two hyphens in a row and no hyphen at the end." };

async function allDbSnapshots(ctx: Ctx): Promise<DBSnapshot[]> {
  const out: DBSnapshot[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.rds.send(new DescribeDBSnapshotsCommand({ Marker: marker }));
    out.push(...(r.DBSnapshots ?? []));
    marker = r.Marker;
  } while (marker);
  return out;
}

async function allClusterSnapshots(ctx: Ctx): Promise<DBClusterSnapshot[]> {
  const out: DBClusterSnapshot[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.rds.send(new DescribeDBClusterSnapshotsCommand({ Marker: marker }));
    out.push(...(r.DBClusterSnapshots ?? []));
    marker = r.Marker;
  } while (marker);
  return out;
}

function dbSnapshotRow(s: DBSnapshot): Row {
  return {
    key: dbKey("db", s.DBSnapshotIdentifier ?? ""),
    name: s.DBSnapshotIdentifier ?? "",
    source: s.DBInstanceIdentifier ?? null,
    kind: "DB instance",
    created: s.SnapshotCreateTime ?? null,
    status: s.Status ?? null,
    progress: s.PercentProgress === undefined ? null : `${s.PercentProgress}%`,
    type: s.SnapshotType ?? null,
    engine: engineName(s.Engine),
    storage: s.AllocatedStorage ?? null,
    arn: s.DBSnapshotArn ?? null,
  };
}

function clusterSnapshotRow(s: DBClusterSnapshot): Row {
  return {
    key: dbKey("cluster", s.DBClusterSnapshotIdentifier ?? ""),
    name: s.DBClusterSnapshotIdentifier ?? "",
    source: s.DBClusterIdentifier ?? null,
    kind: "DB cluster",
    created: s.SnapshotCreateTime ?? null,
    status: s.Status ?? null,
    progress: s.PercentProgress === undefined ? null : `${s.PercentProgress}%`,
    type: s.SnapshotType ?? null,
    engine: engineName(s.Engine),
    storage: s.AllocatedStorage ?? null,
    arn: s.DBClusterSnapshotArn ?? null,
  };
}

async function sourceOptions(ctx: Ctx): Promise<Option[]> {
  const [instances, clusters] = await Promise.all([allInstances(ctx), allClusters(ctx)]);
  return [
    ...instances.filter((i) => !i.DBClusterIdentifier && i.DBInstanceIdentifier).map((i) => ({ value: dbKey("db", i.DBInstanceIdentifier as string), label: `${i.DBInstanceIdentifier} (DB instance)` })),
    ...clusters.filter((c) => c.DBClusterIdentifier).map((c) => ({ value: dbKey("cluster", c.DBClusterIdentifier as string), label: `${c.DBClusterIdentifier} (DB cluster)` })),
  ];
}

async function getDbSnapshot(ctx: Ctx, id: string): Promise<DBSnapshot> {
  const s = (await ctx.clients.rds.send(new DescribeDBSnapshotsCommand({ DBSnapshotIdentifier: id }))).DBSnapshots?.[0];
  if (!s) throw new Error(`DB snapshot ${id} not found.`);
  return s;
}

async function getClusterSnapshot(ctx: Ctx, id: string): Promise<DBClusterSnapshot> {
  const s = (await ctx.clients.rds.send(new DescribeDBClusterSnapshotsCommand({ DBClusterSnapshotIdentifier: id }))).DBClusterSnapshots?.[0];
  if (!s) throw new Error(`DB cluster snapshot ${id} not found.`);
  return s;
}

export const snapshotsResource: ResourceDef = {
  id: "snapshots",
  name: "Snapshots",
  singular: "snapshot",
  idField: "key",
  nameField: "name",
  description: "Manual and automated snapshots of DB instances and DB clusters.",
  emptyText: "You don't have any snapshots.",
  columns: [
    { key: "name", label: "Snapshot name", kind: "link" },
    { key: "source", label: "DB instance or cluster", kind: "text" },
    { key: "kind", label: "Source type", kind: "text" },
    { key: "created", label: "Snapshot creation time", kind: "date" },
    { key: "status", label: "Status", kind: "status" },
    { key: "progress", label: "Progress", kind: "text" },
    { key: "type", label: "Type", kind: "text" },
    { key: "engine", label: "Engine", kind: "text" },
    { key: "storage", label: "Storage (GiB)", kind: "count" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],
  async list(ctx) {
    const [db, cluster] = await Promise.all([allDbSnapshots(ctx), allClusterSnapshots(ctx)]);
    return [...db.map(dbSnapshotRow), ...cluster.map(clusterSnapshotRow)];
  },
  async get(ctx, key) {
    const k = parseDbKey(key);
    if (k.kind === "cluster") {
      const s = await getClusterSnapshot(ctx, k.id);
      return {
        summary: { name: s.DBClusterSnapshotIdentifier ?? k.id, status: s.Status ?? null, source: s.DBClusterIdentifier ?? null, type: s.SnapshotType ?? null },
        summaryLabels: { name: "Snapshot name", status: "Status", source: "DB cluster", type: "Type" },
        tabs: [
          {
            id: "details",
            label: "Details",
            kind: "keyvalue",
            data: {
              Engine: engineName(s.Engine),
              "Engine version": s.EngineVersion ?? null,
              "Snapshot creation time": s.SnapshotCreateTime ?? null,
              "Cluster creation time": s.ClusterCreateTime ?? null,
              Port: s.Port ?? null,
              VPC: s.VpcId ?? null,
              "Master username": s.MasterUsername ?? null,
              Encrypted: s.StorageEncrypted ? "Yes" : "No",
              "AWS KMS key": s.KmsKeyId ?? null,
              "Storage (GiB)": s.AllocatedStorage ?? null,
              "Source snapshot": s.SourceDBClusterSnapshotArn ?? null,
              ARN: s.DBClusterSnapshotArn ?? null,
            },
          },
          { id: "tags", label: "Tags", kind: "table", columns: tagColumns, data: s.TagList ?? [], emptyText: "No tags." },
        ],
      };
    }
    const s = await getDbSnapshot(ctx, k.id);
    return {
      summary: { name: s.DBSnapshotIdentifier ?? k.id, status: s.Status ?? null, source: s.DBInstanceIdentifier ?? null, type: s.SnapshotType ?? null },
      summaryLabels: { name: "Snapshot name", status: "Status", source: "DB instance", type: "Type" },
      tabs: [
        {
          id: "details",
          label: "Details",
          kind: "keyvalue",
          data: {
            Engine: engineName(s.Engine),
            "Engine version": s.EngineVersion ?? null,
            "License model": s.LicenseModel ?? null,
            "Snapshot creation time": s.SnapshotCreateTime ?? null,
            "Instance creation time": s.InstanceCreateTime ?? null,
            "Availability Zone": s.AvailabilityZone ?? null,
            VPC: s.VpcId ?? null,
            Port: s.Port ?? null,
            "Master username": s.MasterUsername ?? null,
            "Storage type": s.StorageType ?? null,
            "Storage (GiB)": s.AllocatedStorage ?? null,
            "Option group": s.OptionGroupName ?? null,
            Encrypted: s.Encrypted ? "Yes" : "No",
            "AWS KMS key": s.KmsKeyId ?? null,
            "Source snapshot": s.SourceDBSnapshotIdentifier ?? null,
            ARN: s.DBSnapshotArn ?? null,
          },
        },
        { id: "tags", label: "Tags", kind: "table", columns: tagColumns, data: s.TagList ?? [], emptyText: "No tags." },
      ],
    };
  },
  create: {
    title: "Take snapshot",
    description: "Creates a manual snapshot with CreateDBSnapshot or CreateDBClusterSnapshot.",
    fields: [
      { name: "source", label: "DB instance or cluster", kind: "select", required: true, options: sourceOptions, section: "Settings", help: "Aurora instances are backed up through their cluster." },
      { name: "name", label: "Snapshot name", kind: "text", required: true, section: "Settings", validate: idValidate },
    ],
    async run(ctx, v) {
      const src = parseDbKey(text(v.source));
      const name = text(v.name);
      if (src.kind === "cluster") await ctx.clients.rds.send(new CreateDBClusterSnapshotCommand({ DBClusterIdentifier: src.id, DBClusterSnapshotIdentifier: name }));
      else await ctx.clients.rds.send(new CreateDBSnapshotCommand({ DBInstanceIdentifier: src.id, DBSnapshotIdentifier: name }));
      return dbKey(src.kind, name);
    },
  },
  actions: [
    {
      id: "restore",
      label: "Restore snapshot",
      availableFor: (row) => typeof row.status !== "string" || row.status === "available",
      fields: [
        { name: "targetId", label: "DB identifier for the restored database", kind: "text", required: true, validate: idValidate },
        { name: "instanceClass", label: "DB instance class", kind: "select", default: "", options: CLASS_OPTIONS, help: "DB instance snapshots only. Leave empty for the snapshot's class." },
        { name: "multiAz", label: "Multi-AZ DB instance", kind: "checkbox", default: false, help: "DB instance snapshots only." },
      ],
      async run(ctx, key, v) {
        const k = parseDbKey(key);
        if (k.kind === "cluster") {
          const s = await getClusterSnapshot(ctx, k.id);
          const r = await ctx.clients.rds.send(new RestoreDBClusterFromSnapshotCommand({ DBClusterIdentifier: text(v.targetId), SnapshotIdentifier: k.id, Engine: s.Engine }));
          return { message: `Restoring to new DB cluster ${r.DBCluster?.DBClusterIdentifier ?? text(v.targetId)}. Add an instance to it from the Databases page once it is available.` };
        }
        const r = await ctx.clients.rds.send(
          new RestoreDBInstanceFromDBSnapshotCommand({ DBInstanceIdentifier: text(v.targetId), DBSnapshotIdentifier: k.id, DBInstanceClass: optionalText(v.instanceClass), MultiAZ: v.multiAz === true })
        );
        return { message: `Restoring to new DB instance ${r.DBInstance?.DBInstanceIdentifier ?? text(v.targetId)} (status ${r.DBInstance?.DBInstanceStatus ?? "unknown"}).` };
      },
    },
    {
      id: "copy",
      label: "Copy snapshot",
      fields: [
        { name: "targetId", label: "New DB snapshot identifier", kind: "text", required: true, validate: idValidate },
        { name: "copyTags", label: "Copy tags", kind: "checkbox", default: true },
      ],
      async run(ctx, key, v) {
        const k = parseDbKey(key);
        if (k.kind === "cluster") {
          const r = await ctx.clients.rds.send(new CopyDBClusterSnapshotCommand({ SourceDBClusterSnapshotIdentifier: k.id, TargetDBClusterSnapshotIdentifier: text(v.targetId), CopyTags: v.copyTags === true }));
          return { message: `Copying to ${r.DBClusterSnapshot?.DBClusterSnapshotIdentifier ?? text(v.targetId)} (status ${r.DBClusterSnapshot?.Status ?? "unknown"}).` };
        }
        const r = await ctx.clients.rds.send(new CopyDBSnapshotCommand({ SourceDBSnapshotIdentifier: k.id, TargetDBSnapshotIdentifier: text(v.targetId), CopyTags: v.copyTags === true }));
        return { message: `Copying to ${r.DBSnapshot?.DBSnapshotIdentifier ?? text(v.targetId)} (status ${r.DBSnapshot?.Status ?? "unknown"}).` };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, key) {
      const k = parseDbKey(key);
      if (k.kind === "cluster") await ctx.clients.rds.send(new DeleteDBClusterSnapshotCommand({ DBClusterSnapshotIdentifier: k.id }));
      else await ctx.clients.rds.send(new DeleteDBSnapshotCommand({ DBSnapshotIdentifier: k.id }));
    },
  },
};
