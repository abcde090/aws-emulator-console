/**
 * RDS "Databases": DB instances and Aurora/Multi-AZ DB clusters in one list, with the
 * console's detail tabs. Actions are in db-actions.ts, the create form in create.ts.
 */

import { GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import {
  DescribeDBClusterSnapshotsCommand,
  DescribeDBLogFilesCommand,
  DescribeDBSnapshotsCommand,
  DescribeEventsCommand,
  DescribePendingMaintenanceActionsCommand,
  type DBCluster,
  type DBInstance,
} from "@aws-sdk/client-rds";
import type { Ctx, Detail, DetailTab, ResourceDef, Row } from "../../console/types.ts";
import { databaseActions } from "./db-actions.ts";
import { createDatabase, createFields } from "./create.ts";
import { clusterRole, clusterRow, engineName, instanceRole, instanceRow, orderDatabases, parseDbKey, pendingText, regionAz } from "./format.ts";
import { optionalRead } from "../../console/secondary.ts";
import { allClusters, allInstances, getCluster, getInstance, tagColumns } from "./shared.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const METRICS = ["CPUUtilization", "DatabaseConnections", "FreeableMemory", "FreeStorageSpace", "ReadIOPS", "WriteIOPS"];

const onOff = (b: boolean | undefined): string => (b ? "Enabled" : "Disabled");

async function metricsRows(ctx: Ctx, dimension: string, id: string): Promise<Row[]> {
  const end = new Date();
  const start = new Date(end.getTime() - DAY_MS);
  const rows = await Promise.all(
    METRICS.map(async (m) => {
      const r = await ctx.clients.cloudwatch.send(
        new GetMetricStatisticsCommand({ Namespace: "AWS/RDS", MetricName: m, Dimensions: [{ Name: dimension, Value: id }], StartTime: start, EndTime: end, Period: 300, Statistics: ["Average"] })
      );
      const points = (r.Datapoints ?? []).filter((p) => typeof p.Average === "number").sort((a, b) => (b.Timestamp?.getTime() ?? 0) - (a.Timestamp?.getTime() ?? 0));
      if (points.length === 0) return null;
      return { metric: m, datapoints: points.length, latest: `${(points[0].Average as number).toFixed(2)} ${points[0].Unit ?? ""}`.trim(), at: points[0].Timestamp ?? null };
    })
  );
  return rows.filter((r): r is NonNullable<typeof r> => r !== null);
}

function monitoringTab(metrics: Awaited<ReturnType<typeof optionalRead<Row[]>>>): DetailTab {
  return {
    id: "monitoring",
    label: "Monitoring",
    kind: "table",
    columns: [
      { key: "metric", label: "CloudWatch metric", kind: "text" },
      { key: "datapoints", label: "Datapoints (24 h)", kind: "count" },
      { key: "latest", label: "Latest average", kind: "text" },
      { key: "at", label: "Latest datapoint", kind: "date" },
    ],
    data: metrics.kind === "value" ? metrics.value : [],
    description: `AWS/RDS metrics (${METRICS.join(", ")}) for the last 24 hours.`,
    emptyText: metrics.kind === "error" ? `Could not read CloudWatch: ${metrics.error}` : "CloudWatch has no AWS/RDS datapoints for this database.",
  };
}

async function eventsTab(ctx: Ctx, sourceType: "db-instance" | "db-cluster", id: string): Promise<DetailTab> {
  const events = await optionalRead(() => ctx.clients.rds.send(new DescribeEventsCommand({ SourceIdentifier: id, SourceType: sourceType, Duration: 20160 })));
  return {
    id: "events",
    label: "Logs & events",
    kind: "table",
    columns: [
      { key: "time", label: "Time", kind: "date" },
      { key: "message", label: "Message", kind: "text" },
      { key: "categories", label: "Categories", kind: "text" },
    ],
    data: events.kind === "value" ? (events.value.Events ?? []).map((e) => ({ time: e.Date ?? null, message: e.Message ?? "", categories: (e.EventCategories ?? []).join(", ") })).reverse() : [],
    description: "Recent events (last 14 days) from DescribeEvents.",
    emptyText: events.kind === "error" ? `Could not read events: ${events.error}` : "No recent events.",
  };
}

function tagsTab(tags: { Key?: string; Value?: string }[] | undefined): DetailTab {
  return { id: "tags", label: "Tags", kind: "table", columns: tagColumns, data: tags ?? [], emptyText: "No tags." };
}

async function instanceDetail(ctx: Ctx, id: string): Promise<Detail> {
  const i = await getInstance(ctx, id);
  const clusters = i.DBClusterIdentifier ? [await getCluster(ctx, i.DBClusterIdentifier)] : [];
  const [snapshots, metrics, logs, maintenance] = await Promise.all([
    optionalRead(() => ctx.clients.rds.send(new DescribeDBSnapshotsCommand({ DBInstanceIdentifier: id }))),
    optionalRead(() => metricsRows(ctx, "DBInstanceIdentifier", id)),
    optionalRead(() => ctx.clients.rds.send(new DescribeDBLogFilesCommand({ DBInstanceIdentifier: id }))),
    optionalRead(() => ctx.clients.rds.send(new DescribePendingMaintenanceActionsCommand({ ResourceIdentifier: i.DBInstanceArn }))),
  ]);
  const events = await eventsTab(ctx, "db-instance", id);
  const pendingMaint = maintenance.kind === "value" ? (maintenance.value.PendingMaintenanceActions ?? []).flatMap((p) => (p.PendingMaintenanceActionDetails ?? []).map((d) => `${d.Action ?? ""}: ${d.Description ?? ""}`)) : [];
  return {
    summary: {
      identifier: i.DBInstanceIdentifier ?? id,
      status: i.DBInstanceStatus ?? null,
      role: instanceRole(i, clusters),
      engine: engineName(i.Engine),
      regionAz: regionAz(ctx.region, i.AvailabilityZone, i.MultiAZ),
      size: i.DBInstanceClass ?? null,
    },
    summaryLabels: { identifier: "DB identifier", status: "Status", role: "Role", engine: "Engine", regionAz: "Region & AZ", size: "Class" },
    tabs: [
      {
        id: "connectivity",
        label: "Connectivity & security",
        kind: "keyvalue",
        data: {
          Endpoint: i.Endpoint?.Address ?? null,
          Port: i.Endpoint?.Port ?? i.DbInstancePort ?? null,
          "Availability Zone": i.AvailabilityZone ?? null,
          "Secondary Availability Zone": i.SecondaryAvailabilityZone ?? null,
          VPC: i.DBSubnetGroup?.VpcId ?? null,
          "Subnet group": i.DBSubnetGroup?.DBSubnetGroupName ?? null,
          Subnets: (i.DBSubnetGroup?.Subnets ?? []).map((s) => s.SubnetIdentifier).join(", ") || null,
          "Network type": i.NetworkType ?? null,
          "VPC security groups": (i.VpcSecurityGroups ?? []).map((g) => `${g.VpcSecurityGroupId} (${g.Status})`).join(", ") || null,
          "Publicly accessible": i.PubliclyAccessible ? "Yes" : "No",
          "Certificate authority": i.CACertificateIdentifier ?? null,
          "Certificate authority date": i.CertificateDetails?.ValidTill ?? null,
          "IAM DB authentication": onOff(i.IAMDatabaseAuthenticationEnabled),
        },
      },
      monitoringTab(metrics),
      events,
      {
        id: "configuration",
        label: "Configuration",
        kind: "keyvalue",
        data: {
          "DB instance ID": i.DBInstanceIdentifier ?? null,
          "Engine version": i.EngineVersion ?? null,
          "DB name": i.DBName ?? null,
          "License model": i.LicenseModel ?? null,
          "Option groups": (i.OptionGroupMemberships ?? []).map((o) => `${o.OptionGroupName} (${o.Status})`).join(", ") || null,
          "Parameter group": (i.DBParameterGroups ?? []).map((p) => `${p.DBParameterGroupName} (${p.ParameterApplyStatus})`).join(", ") || null,
          "Instance class": i.DBInstanceClass ?? null,
          "Multi-AZ": i.MultiAZ ? "Yes" : "No",
          "Storage type": i.StorageType ?? null,
          Storage: i.AllocatedStorage === undefined ? null : `${i.AllocatedStorage} GiB`,
          "Provisioned IOPS": i.Iops ?? null,
          "Storage throughput (MiBps)": i.StorageThroughput ?? null,
          "Maximum storage threshold": i.MaxAllocatedStorage === undefined ? null : `${i.MaxAllocatedStorage} GiB`,
          Encryption: onOff(i.StorageEncrypted),
          "AWS KMS key": i.KmsKeyId ?? null,
          "Master username": i.MasterUsername ?? null,
          "Master credentials ARN": i.MasterUserSecret?.SecretArn ?? null,
          "Master credentials status": i.MasterUserSecret?.SecretStatus ?? null,
          "Read replica source": i.ReadReplicaSourceDBInstanceIdentifier ?? null,
          "Read replicas": (i.ReadReplicaDBInstanceIdentifiers ?? []).join(", ") || null,
          "DB cluster": i.DBClusterIdentifier ?? null,
          "Deletion protection": onOff(i.DeletionProtection),
          "Performance Insights": onOff(i.PerformanceInsightsEnabled),
          "Created time": i.InstanceCreateTime ?? null,
          "Resource ID": i.DbiResourceId ?? null,
          ARN: i.DBInstanceArn ?? null,
        },
      },
      {
        id: "maintenance",
        label: "Maintenance & backups",
        kind: "keyvalue",
        data: {
          "Auto minor version upgrade": onOff(i.AutoMinorVersionUpgrade),
          "Maintenance window": i.PreferredMaintenanceWindow ?? null,
          "Pending modifications": pendingText(i.PendingModifiedValues),
          "Pending maintenance": maintenance.kind === "error" ? `Could not read: ${maintenance.error}` : pendingMaint.join("; ") || "None",
          "Automated backups": (i.BackupRetentionPeriod ?? 0) > 0 ? `Enabled (${i.BackupRetentionPeriod} days)` : "Disabled",
          "Backup window": i.PreferredBackupWindow ?? null,
          "Latest restore time": i.LatestRestorableTime ?? null,
          "Copy tags to snapshots": onOff(i.CopyTagsToSnapshot),
          "Backup target": i.BackupTarget ?? null,
          "Log files": logs.kind === "value" ? (logs.value.DescribeDBLogFiles ?? []).map((l) => `${l.LogFileName} (${l.Size ?? 0} bytes)`).join(", ") || "None" : logs.kind === "error" ? `Could not read: ${logs.error}` : "None",
        },
      },
      {
        id: "snapshots",
        label: "Snapshots",
        kind: "table",
        columns: [
          { key: "id", label: "Snapshot name", kind: "text" },
          { key: "status", label: "Status", kind: "status" },
          { key: "type", label: "Snapshot type", kind: "text" },
          { key: "created", label: "Snapshot creation time", kind: "date" },
          { key: "storage", label: "Storage (GiB)", kind: "count" },
        ],
        data:
          snapshots.kind === "value"
            ? (snapshots.value.DBSnapshots ?? []).map((s) => ({ id: s.DBSnapshotIdentifier ?? "", status: s.Status ?? null, type: s.SnapshotType ?? null, created: s.SnapshotCreateTime ?? null, storage: s.AllocatedStorage ?? null }))
            : [],
        emptyText: snapshots.kind === "error" ? `Could not read snapshots: ${snapshots.error}` : "No snapshots of this DB instance. Use Actions > Take snapshot.",
      },
      tagsTab(i.TagList),
    ],
  };
}

async function clusterDetail(ctx: Ctx, id: string): Promise<Detail> {
  const c = await getCluster(ctx, id);
  const [members, snapshots, metrics] = await Promise.all([
    optionalRead(() => allInstances(ctx, { clusterId: id })),
    optionalRead(() => ctx.clients.rds.send(new DescribeDBClusterSnapshotsCommand({ DBClusterIdentifier: id }))),
    optionalRead(() => metricsRows(ctx, "DBClusterIdentifier", id)),
  ]);
  const events = await eventsTab(ctx, "db-cluster", id);
  return {
    summary: { identifier: c.DBClusterIdentifier ?? id, status: c.Status ?? null, role: clusterRole(c), engine: engineName(c.Engine), engineVersion: c.EngineVersion ?? null, region: ctx.region },
    summaryLabels: { identifier: "DB identifier", status: "Status", role: "Role", engine: "Engine", engineVersion: "Engine version", region: "Region" },
    tabs: [
      {
        id: "instances",
        label: "Instances",
        kind: "table",
        columns: [
          { key: "identifier", label: "DB identifier", kind: "text" },
          { key: "status", label: "Status", kind: "status" },
          { key: "role", label: "Role", kind: "text" },
          { key: "regionAz", label: "Region & AZ", kind: "text" },
          { key: "size", label: "Size", kind: "text" },
        ],
        data: members.kind === "value" ? members.value.map((i) => instanceRow(i, [c], ctx.region)) : [],
        emptyText: members.kind === "error" ? `Could not read instances: ${members.error}` : "This cluster has no DB instances. Use Actions > Add reader.",
      },
      {
        id: "connectivity",
        label: "Connectivity & security",
        kind: "keyvalue",
        data: {
          "Writer endpoint": c.Endpoint ?? null,
          "Reader endpoint": c.ReaderEndpoint ?? null,
          Port: c.Port ?? null,
          "Availability Zones": (c.AvailabilityZones ?? []).join(", ") || null,
          "Subnet group": c.DBSubnetGroup ?? null,
          "VPC security groups": (c.VpcSecurityGroups ?? []).map((g) => `${g.VpcSecurityGroupId} (${g.Status})`).join(", ") || null,
          "Network type": c.NetworkType ?? null,
          "IAM DB authentication": onOff(c.IAMDatabaseAuthenticationEnabled),
        },
      },
      monitoringTab(metrics),
      events,
      {
        id: "configuration",
        label: "Configuration",
        kind: "keyvalue",
        data: {
          "DB cluster ID": c.DBClusterIdentifier ?? null,
          "Engine version": c.EngineVersion ?? null,
          "Engine mode": c.EngineMode ?? null,
          "Database name": c.DatabaseName ?? null,
          "DB cluster parameter group": c.DBClusterParameterGroup ?? null,
          "Multi-AZ": c.MultiAZ ? "Yes" : "No",
          "Storage type": c.StorageType ?? null,
          Encryption: onOff(c.StorageEncrypted),
          "AWS KMS key": c.KmsKeyId ?? null,
          "Master username": c.MasterUsername ?? null,
          "Master credentials ARN": c.MasterUserSecret?.SecretArn ?? null,
          "Deletion protection": onOff(c.DeletionProtection),
          "Created time": c.ClusterCreateTime ?? null,
          "Resource ID": c.DbClusterResourceId ?? null,
          ARN: c.DBClusterArn ?? null,
        },
      },
      {
        id: "maintenance",
        label: "Maintenance & backups",
        kind: "keyvalue",
        data: {
          "Maintenance window": c.PreferredMaintenanceWindow ?? null,
          "Pending modifications": pendingText(c.PendingModifiedValues),
          "Backup retention period": c.BackupRetentionPeriod === undefined ? null : `${c.BackupRetentionPeriod} days`,
          "Backup window": c.PreferredBackupWindow ?? null,
          "Earliest restorable time": c.EarliestRestorableTime ?? null,
          "Latest restorable time": c.LatestRestorableTime ?? null,
          "Copy tags to snapshots": onOff(c.CopyTagsToSnapshot),
        },
      },
      {
        id: "snapshots",
        label: "Snapshots",
        kind: "table",
        columns: [
          { key: "id", label: "Snapshot name", kind: "text" },
          { key: "status", label: "Status", kind: "status" },
          { key: "type", label: "Snapshot type", kind: "text" },
          { key: "created", label: "Snapshot creation time", kind: "date" },
        ],
        data:
          snapshots.kind === "value"
            ? (snapshots.value.DBClusterSnapshots ?? []).map((s) => ({ id: s.DBClusterSnapshotIdentifier ?? "", status: s.Status ?? null, type: s.SnapshotType ?? null, created: s.SnapshotCreateTime ?? null }))
            : [],
        emptyText: snapshots.kind === "error" ? `Could not read snapshots: ${snapshots.error}` : "No snapshots of this DB cluster. Use Actions > Take snapshot.",
      },
      tagsTab(c.TagList),
    ],
  };
}

export const databasesResource: ResourceDef = {
  id: "databases",
  name: "Databases",
  singular: "database",
  idField: "key",
  nameField: "identifier",
  description: "DB instances and DB clusters. Aurora cluster instances are listed under their cluster.",
  emptyText: "You don't have any databases. Create a database to get started.",
  columns: [
    { key: "identifier", label: "DB identifier", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "role", label: "Role", kind: "text" },
    { key: "engine", label: "Engine", kind: "text" },
    { key: "engineVersion", label: "Engine version", kind: "text", hidden: true },
    { key: "regionAz", label: "Region & AZ", kind: "text" },
    { key: "size", label: "Size", kind: "text" },
    { key: "multiAz", label: "Multi-AZ", kind: "text" },
    { key: "vpc", label: "VPC", kind: "text" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],
  async list(ctx) {
    const [instances, clusters]: [DBInstance[], DBCluster[]] = await Promise.all([allInstances(ctx), allClusters(ctx)]);
    return orderDatabases([...clusters.map((c) => clusterRow(c, ctx.region)), ...instances.map((i) => instanceRow(i, clusters, ctx.region))]);
  },
  async get(ctx, key) {
    const k = parseDbKey(key);
    return k.kind === "cluster" ? clusterDetail(ctx, k.id) : instanceDetail(ctx, k.id);
  },
  create: {
    title: "Create database",
    description: "Standard create. RDS engines call CreateDBInstance; Aurora calls CreateDBCluster and then CreateDBInstance for the writer (and a reader for Multi-AZ).",
    fields: createFields,
    run: createDatabase,
  },
  actions: databaseActions,
};
