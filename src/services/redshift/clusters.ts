/** Amazon Redshift provisioned clusters: list, create, detail tabs and actions. */

import { fieldTags, tagDiff, tagDiffMessage } from "../../console/tags.ts";
import {
  CreateClusterCommand,
  CreateClusterSnapshotCommand,
  CreateTagsCommand,
  DeleteClusterCommand,
  DeleteTagsCommand,
  DescribeClustersCommand,
  DescribeEventsCommand,
  DescribeLoggingStatusCommand,
  ModifyClusterCommand,
  ModifyClusterIamRolesCommand,
  PauseClusterCommand,
  RebootClusterCommand,
  ResizeClusterCommand,
  ResumeClusterCommand,
  type Cluster,
} from "@aws-sdk/client-redshift";
import { errorMessage } from "../../console/serialize.ts";
import type { Ctx, FieldValues, Option, ResourceDef, Row, Tag } from "../../console/types.ts";
import { endpointText, jdbcUrl, passwordProblem, splitList, storageText, titleCase } from "./helpers.ts";
import { nodeTypeOptions, parameterGroupOptions, securityGroupOptions, subnetGroupOptions } from "./lookups.ts";

const IDENT = { pattern: "[a-z][a-z0-9]*(-[a-z0-9]+)*", message: "Lowercase letters, numbers and single hyphens, starting with a letter (1-63 characters)." };
const optStr = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const optNum = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const strList = (v: unknown): string[] | undefined => (Array.isArray(v) && v.length ? v.filter((x): x is string => typeof x === "string") : undefined);

export async function describeClusters(ctx: Ctx, id?: string): Promise<Cluster[]> {
  const out: Cluster[] = [];
  let marker: string | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await ctx.clients.redshift.send(new DescribeClustersCommand({ ClusterIdentifier: id, Marker: marker, MaxRecords: 100 }));
    out.push(...(r.Clusters ?? []));
    if (!r.Marker || r.Marker === marker) break;
    marker = r.Marker;
  }
  return out;
}

async function oneCluster(ctx: Ctx, id: string): Promise<Cluster> {
  const [c] = await describeClusters(ctx, id);
  if (!c) throw new Error(`Cluster ${id} was not found.`);
  return c;
}

function clusterRow(c: Cluster): Row {
  return {
    id: c.ClusterIdentifier ?? "",
    status: titleCase(c.ClusterStatus),
    availability: c.ClusterAvailabilityStatus ?? null,
    nodeType: c.NodeType ?? null,
    nodes: c.NumberOfNodes ?? null,
    storage: storageText(c.TotalStorageCapacityInMegaBytes),
    zone: c.AvailabilityZone ?? null,
    created: c.ClusterCreateTime ?? null,
    endpoint: endpointText(c.Endpoint),
    arn: c.ClusterNamespaceArn ?? null,
  };
}

/** The wanted value when it differs from the current one, else undefined (nothing to send). */
function changed<T>(wanted: T | undefined, current: T | undefined): T | undefined {
  return wanted !== undefined && wanted !== current ? wanted : undefined;
}

/** List rows and detail summaries carry the status title-cased ("Available", "Paused"). */
function statusIs(row: Row, wanted: string): boolean {
  const status = row.status ?? row.Status;
  return typeof status !== "string" || status.toLowerCase() === wanted;
}

const currentTags = (c: Cluster): Tag[] => (c.Tags ?? []).filter((t) => t.Key).map((t) => ({ Key: t.Key as string, Value: t.Value ?? "" }));

/** Node types, plus the cluster's current type when the orderable list lacks it. */
async function nodeTypeOptionsFor(ctx: Ctx, id?: string): Promise<Option[]> {
  const types = await nodeTypeOptions(ctx);
  if (!id) return types;
  const current = (await oneCluster(ctx, id)).NodeType;
  return current && !types.some((o) => o.value === current) ? [{ value: current, label: current }, ...types] : types;
}

const clusterArn = (ctx: Ctx, id: string): string => `arn:aws:redshift:${ctx.region}:${ctx.accountId}:cluster:${id}`;

async function createCluster(ctx: Ctx, v: FieldValues): Promise<string> {
  const id = String(v.id);
  const managed = v.passwordMode === "managed";
  const password = optStr(v.password);
  if (!managed) {
    if (!password) throw new Error("Enter an admin password, or let AWS Secrets Manager manage it.");
    const problem = passwordProblem(password);
    if (problem) throw new Error(problem);
  }
  const nodes = optNum(v.nodes) ?? 1;
  const tags = Array.isArray(v.tags) && v.tags.length ? (v.tags as Tag[]) : undefined;
  await ctx.clients.redshift.send(new CreateClusterCommand({
    ClusterIdentifier: id,
    NodeType: String(v.nodeType),
    ClusterType: nodes > 1 ? "multi-node" : "single-node",
    NumberOfNodes: nodes > 1 ? nodes : undefined,
    MasterUsername: String(v.username),
    MasterUserPassword: managed ? undefined : password,
    ManageMasterPassword: managed ? true : undefined,
    DBName: optStr(v.dbName),
    Port: optNum(v.port),
    ClusterSubnetGroupName: optStr(v.subnetGroup),
    VpcSecurityGroupIds: strList(v.securityGroups),
    PubliclyAccessible: v.publiclyAccessible === true,
    EnhancedVpcRouting: v.enhancedVpcRouting === true,
    ClusterParameterGroupName: optStr(v.parameterGroup),
    Encrypted: v.encrypted === true,
    KmsKeyId: v.encrypted === true ? optStr(v.kmsKey) : undefined,
    AutomatedSnapshotRetentionPeriod: optNum(v.snapshotRetention),
    Tags: tags,
  }));
  return id;
}

async function eventsRows(ctx: Ctx, id: string): Promise<Row[] | string> {
  try {
    const r = await ctx.clients.redshift.send(new DescribeEventsCommand({ SourceIdentifier: id, SourceType: "cluster", Duration: 20160, MaxRecords: 100 }));
    return (r.Events ?? []).map((e) => ({ date: e.Date ?? null, severity: e.Severity ?? null, category: e.EventCategories?.join(", ") ?? null, message: e.Message ?? null }));
  } catch (err: unknown) {
    return `Could not read events: ${errorMessage(err)}`;
  }
}

export const clusterResource: ResourceDef = {
  id: "clusters",
  name: "Clusters",
  singular: "cluster",
  idField: "id",
  nameField: "id",
  description: "Provisioned Redshift data warehouse clusters.",
  emptyText: "No clusters. Create a cluster to get started.",
  columns: [
    { key: "id", label: "Cluster", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "availability", label: "Availability", kind: "text" },
    { key: "nodeType", label: "Node type", kind: "text" },
    { key: "nodes", label: "Nodes", kind: "count" },
    { key: "storage", label: "Storage capacity", kind: "text" },
    { key: "zone", label: "Availability Zone", kind: "text" },
    { key: "created", label: "Created", kind: "date" },
    { key: "endpoint", label: "Endpoint", kind: "code", hidden: true },
  ],
  async list(ctx) {
    return (await describeClusters(ctx)).map(clusterRow);
  },
  async get(ctx, id) {
    const c = await oneCluster(ctx, id);
    const [logging, events] = await Promise.all([
      ctx.clients.redshift.send(new DescribeLoggingStatusCommand({ ClusterIdentifier: id })).then((l) => l, (err: unknown) => errorMessage(err)),
      eventsRows(ctx, id),
    ]);
    return {
      summary: {
        "Cluster identifier": id,
        Status: titleCase(c.ClusterStatus),
        "Node type": c.NodeType ?? null,
        "Number of nodes": c.NumberOfNodes ?? null,
        Endpoint: endpointText(c.Endpoint),
        "JDBC URL": jdbcUrl(c.Endpoint, c.DBName),
        "Storage capacity": storageText(c.TotalStorageCapacityInMegaBytes),
        "Cluster version": c.ClusterVersion ?? null,
        "Cluster namespace ARN": c.ClusterNamespaceArn ?? null,
        Created: c.ClusterCreateTime ?? null,
      },
      tabs: [
        {
          id: "properties", label: "Properties", kind: "keyvalue",
          data: {
            "Database name": c.DBName ?? null,
            "Admin user name": c.MasterUsername ?? null,
            "Admin password": c.MasterPasswordSecretArn ? `Managed in AWS Secrets Manager (${c.MasterPasswordSecretArn})` : "Set by you",
            Port: c.Endpoint?.Port ?? null,
            "Parameter group": c.ClusterParameterGroups?.map((p) => `${p.ParameterGroupName ?? ""} (${p.ParameterApplyStatus ?? ""})`).join(", ") || null,
            Encrypted: c.Encrypted ? "Yes" : "No",
            "KMS key": c.KmsKeyId ?? null,
            "Associated IAM roles": c.IamRoles?.map((r) => `${r.IamRoleArn ?? ""} (${r.ApplyStatus ?? ""})`).join(", ") || "None",
            "Default IAM role": c.DefaultIamRoleArn ?? null,
            "Pending changes": c.PendingModifiedValues && Object.keys(c.PendingModifiedValues).length ? JSON.stringify(c.PendingModifiedValues) : "None",
          },
        },
        {
          id: "network", label: "Network and security", kind: "keyvalue",
          data: {
            "VPC ID": c.VpcId ?? null,
            "Cluster subnet group": c.ClusterSubnetGroupName ?? null,
            "Availability Zone": c.AvailabilityZone ?? null,
            "VPC security groups": c.VpcSecurityGroups?.map((g) => g.VpcSecurityGroupId).filter(Boolean).join(", ") || null,
            "Publicly accessible": c.PubliclyAccessible ? "Enabled" : "Disabled",
            "Enhanced VPC routing": c.EnhancedVpcRouting ? "Enabled" : "Disabled",
            "Multi-AZ": c.MultiAZ ?? null,
          },
        },
        {
          id: "nodes", label: "Nodes", kind: "table",
          columns: [
            { key: "role", label: "Node role", kind: "text" },
            { key: "private", label: "Private IP address", kind: "text" },
            { key: "public", label: "Public IP address", kind: "text" },
          ],
          data: (c.ClusterNodes ?? []).map((n) => ({ role: n.NodeRole ?? "", private: n.PrivateIPAddress ?? null, public: n.PublicIPAddress ?? null })),
          emptyText: "Redshift returned no node details.",
        },
        {
          id: "maintenance", label: "Maintenance", kind: "keyvalue",
          data: {
            "Maintenance window": c.PreferredMaintenanceWindow ?? null,
            "Allow version upgrade": c.AllowVersionUpgrade ? "Yes" : "No",
            "Automated snapshot retention (days)": c.AutomatedSnapshotRetentionPeriod ?? null,
            "Manual snapshot retention (days)": c.ManualSnapshotRetentionPeriod === -1 ? "Indefinitely" : c.ManualSnapshotRetentionPeriod ?? null,
            "Audit logging": typeof logging === "string" ? logging : logging.LoggingEnabled ? `Enabled (${logging.LogDestinationType ?? "s3"}${logging.LogExports?.length ? `: ${logging.LogExports.join(", ")}` : ""})` : "Disabled",
          },
        },
        {
          id: "events", label: "Events", kind: "table",
          columns: [
            { key: "date", label: "Time", kind: "date" },
            { key: "severity", label: "Severity", kind: "text" },
            { key: "category", label: "Category", kind: "text" },
            { key: "message", label: "Message", kind: "text" },
          ],
          data: typeof events === "string" ? [] : events,
          emptyText: typeof events === "string" ? events : "No events in the last 14 days.",
        },
        {
          id: "tags", label: "Tags", kind: "table",
          columns: [
            { key: "Key", label: "Key", kind: "text" },
            { key: "Value", label: "Value", kind: "text" },
          ],
          data: c.Tags ?? [],
          emptyText: "No tags.",
        },
      ],
    };
  },
  create: {
    title: "Create cluster",
    description: "Creates a provisioned cluster in the emulator with CreateCluster.",
    fields: [
      { name: "id", label: "Cluster identifier", kind: "text", required: true, placeholder: "redshift-cluster-1", section: "Cluster configuration", help: "Lowercase, unique in this Region.", validate: IDENT },
      { name: "nodeType", label: "Node type", kind: "select", required: true, default: "ra3.large", options: nodeTypeOptions, section: "Cluster configuration" },
      { name: "nodes", label: "Number of nodes", kind: "number", required: true, default: 2, section: "Cluster configuration", help: "1 creates a single-node cluster.", validate: { min: 1, max: 128, message: "Between 1 and 128." } },
      { name: "username", label: "Admin user name", kind: "text", required: true, default: "awsuser", section: "Database configurations", validate: { pattern: "[a-zA-Z][a-zA-Z0-9_]{0,127}", message: "Starts with a letter; letters, numbers and underscores only." } },
      { name: "passwordMode", label: "Admin password", kind: "radio", default: "managed", section: "Database configurations", options: [{ value: "managed", label: "Manage admin credentials in AWS Secrets Manager" }, { value: "manual", label: "Manually add the admin password" }] },
      { name: "password", label: "Admin user password", kind: "password", required: true, section: "Database configurations", showIf: { field: "passwordMode", equals: "manual" }, help: "8-64 characters with an uppercase letter, a lowercase letter and a number. No ' \" \\ / @ or spaces." },
      { name: "dbName", label: "Database name", kind: "text", default: "dev", section: "Database configurations", validate: { pattern: "[a-z][a-z0-9_$]{0,63}", message: "Lowercase letters, numbers, _ or $, starting with a letter." } },
      { name: "port", label: "Database port", kind: "number", default: 5439, section: "Database configurations", validate: { min: 1150, max: 65535, message: "Between 1150 and 65535." } },
      { name: "subnetGroup", label: "Cluster subnet group", kind: "select", default: "", options: subnetGroupOptions, section: "Network and security" },
      { name: "securityGroups", label: "VPC security groups", kind: "multiselect", options: securityGroupOptions, section: "Network and security" },
      { name: "publiclyAccessible", label: "Turn on Publicly accessible", kind: "checkbox", default: false, section: "Network and security" },
      { name: "enhancedVpcRouting", label: "Enhanced VPC routing", kind: "checkbox", default: false, section: "Network and security", help: "Forces COPY and UNLOAD traffic through your VPC." },
      { name: "parameterGroup", label: "Parameter group", kind: "select", default: "", options: parameterGroupOptions, section: "Database configurations" },
      { name: "encrypted", label: "Use AWS KMS encryption", kind: "checkbox", default: true, section: "Encryption" },
      { name: "kmsKey", label: "AWS KMS key ID or ARN", kind: "text", section: "Encryption", showIf: { field: "encrypted", equals: true }, help: "Leave empty for the AWS owned key." },
      { name: "snapshotRetention", label: "Automated snapshot retention period (days)", kind: "number", default: 1, section: "Backup", validate: { min: 0, max: 35, message: "Between 0 and 35." } },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    run: createCluster,
  },
  actions: [
    {
      id: "modify",
      label: "Modify",
      availableFor: (row) => statusIs(row, "available"),
      fields: [
        { name: "password", label: "New admin password", kind: "password", help: "Leave empty to keep the current password." },
        { name: "snapshotRetention", label: "Automated snapshot retention period (days)", kind: "number", validate: { min: 0, max: 35, message: "Between 0 and 35." } },
        { name: "publiclyAccessible", label: "Turn on Publicly accessible", kind: "checkbox", default: false },
        { name: "enhancedVpcRouting", label: "Enhanced VPC routing", kind: "checkbox", default: false },
        { name: "maintenanceWindow", label: "Maintenance window", kind: "text", placeholder: "sun:05:00-sun:05:30", validate: { pattern: "[a-z]{3}:[0-9]{2}:[0-9]{2}-[a-z]{3}:[0-9]{2}:[0-9]{2}", message: "Use ddd:hh24:mi-ddd:hh24:mi." } },
      ],
      async initialValues(ctx, id) {
        const c = await oneCluster(ctx, id);
        return {
          snapshotRetention: c.AutomatedSnapshotRetentionPeriod ?? null,
          publiclyAccessible: c.PubliclyAccessible === true,
          enhancedVpcRouting: c.EnhancedVpcRouting === true,
          maintenanceWindow: c.PreferredMaintenanceWindow ?? "",
        };
      },
      async run(ctx, id, v) {
        const password = optStr(v.password);
        if (password) {
          const problem = passwordProblem(password);
          if (problem) throw new Error(problem);
        }
        const c = await oneCluster(ctx, id);
        const changes = {
          MasterUserPassword: password,
          AutomatedSnapshotRetentionPeriod: changed(optNum(v.snapshotRetention), c.AutomatedSnapshotRetentionPeriod),
          PubliclyAccessible: changed(v.publiclyAccessible === true, c.PubliclyAccessible === true),
          EnhancedVpcRouting: changed(v.enhancedVpcRouting === true, c.EnhancedVpcRouting === true),
          PreferredMaintenanceWindow: changed(optStr(v.maintenanceWindow), c.PreferredMaintenanceWindow),
        };
        if (Object.values(changes).every((x) => x === undefined)) return { message: `No changes to ${id}.` };
        const r = await ctx.clients.redshift.send(new ModifyClusterCommand({ ClusterIdentifier: id, ...changes }));
        return { message: `Modified ${id}. Status: ${r.Cluster?.ClusterStatus ?? "unknown"}.` };
      },
    },
    {
      id: "resize",
      label: "Resize",
      availableFor: (row) => statusIs(row, "available"),
      fields: [
        { name: "nodeType", label: "Node type", kind: "select", required: true, options: nodeTypeOptionsFor },
        { name: "nodes", label: "Number of nodes", kind: "number", required: true, validate: { min: 1, max: 128, message: "Between 1 and 128." } },
        { name: "classic", label: "Classic resize", kind: "checkbox", default: false, help: "Elastic resize is the default." },
      ],
      async initialValues(ctx, id) {
        const c = await oneCluster(ctx, id);
        return { nodeType: c.NodeType ?? "", nodes: c.NumberOfNodes ?? null };
      },
      async run(ctx, id, v) {
        const nodes = Number(v.nodes);
        const c = await oneCluster(ctx, id);
        if (optStr(v.nodeType) === c.NodeType && nodes === c.NumberOfNodes) return { message: `${id} already has ${nodes} ${c.NodeType} node${nodes === 1 ? "" : "s"}. Nothing to resize.` };
        const r = await ctx.clients.redshift.send(new ResizeClusterCommand({ ClusterIdentifier: id, NodeType: optStr(v.nodeType), NumberOfNodes: nodes, ClusterType: nodes > 1 ? "multi-node" : "single-node", Classic: v.classic === true }));
        return { message: `Resize to ${nodes} node${nodes === 1 ? "" : "s"} started. Status: ${r.Cluster?.ClusterStatus ?? "unknown"}.` };
      },
    },
    {
      id: "snapshot",
      label: "Create snapshot",
      availableFor: (row) => statusIs(row, "available"),
      fields: [
        { name: "name", label: "Snapshot identifier", kind: "text", required: true, validate: IDENT },
        { name: "retention", label: "Manual snapshot retention (days)", kind: "number", help: "Leave empty to keep it indefinitely.", validate: { min: 1, max: 3653, message: "Between 1 and 3653." } },
      ],
      async run(ctx, id, v) {
        const r = await ctx.clients.redshift.send(new CreateClusterSnapshotCommand({ ClusterIdentifier: id, SnapshotIdentifier: String(v.name), ManualSnapshotRetentionPeriod: optNum(v.retention) }));
        return { message: `Snapshot ${String(v.name)} is ${r.Snapshot?.Status ?? "requested"}.` };
      },
    },
    {
      id: "reboot",
      label: "Reboot",
      availableFor: (row) => statusIs(row, "available"),
      confirm: "Rebooting makes the cluster unavailable until it restarts.",
      async run(ctx, id) {
        const r = await ctx.clients.redshift.send(new RebootClusterCommand({ ClusterIdentifier: id }));
        return { message: `Reboot started. Status: ${r.Cluster?.ClusterStatus ?? "unknown"}.` };
      },
    },
    {
      id: "pause",
      label: "Pause",
      availableFor: (row) => statusIs(row, "available"),
      confirm: "Pausing stops compute billing; the cluster can't run queries until you resume it.",
      async run(ctx, id) {
        const r = await ctx.clients.redshift.send(new PauseClusterCommand({ ClusterIdentifier: id }));
        return { message: `Pause requested. Status: ${r.Cluster?.ClusterStatus ?? "unknown"}.` };
      },
    },
    {
      id: "resume",
      label: "Resume",
      availableFor: (row) => statusIs(row, "paused"),
      async run(ctx, id) {
        const r = await ctx.clients.redshift.send(new ResumeClusterCommand({ ClusterIdentifier: id }));
        return { message: `Resume requested. Status: ${r.Cluster?.ClusterStatus ?? "unknown"}.` };
      },
    },
    {
      id: "iam-roles",
      label: "Manage IAM roles",
      fields: [
        { name: "roles", label: "Associated IAM role ARNs", kind: "textarea", placeholder: "arn:aws:iam::000000000000:role/MyRedshiftRole", help: "One ARN per line (or comma-separated). Roles you remove here are disassociated." },
      ],
      async initialValues(ctx, id) {
        return { roles: ((await oneCluster(ctx, id)).IamRoles ?? []).map((r) => r.IamRoleArn ?? "").filter(Boolean).join("\n") };
      },
      async run(ctx, id, v) {
        const wanted = splitList(v.roles);
        const current = ((await oneCluster(ctx, id)).IamRoles ?? []).map((r) => r.IamRoleArn ?? "").filter(Boolean);
        const add = wanted.filter((x) => !current.includes(x));
        const remove = current.filter((x) => !wanted.includes(x));
        if (!add.length && !remove.length) return { message: `No changes to the IAM roles of ${id}.` };
        const r = await ctx.clients.redshift.send(new ModifyClusterIamRolesCommand({ ClusterIdentifier: id, AddIamRoles: add.length ? add : undefined, RemoveIamRoles: remove.length ? remove : undefined }));
        return { message: `IAM roles: ${(r.Cluster?.IamRoles ?? []).map((x) => `${x.IamRoleArn ?? ""} (${x.ApplyStatus ?? ""})`).join(", ") || "none"}.` };
      },
    },
    {
      id: "tags",
      label: "Manage tags",
      fields: [{ name: "tags", label: "Tags", kind: "tags", help: "Tags you remove here are removed from the cluster." }],
      async initialValues(ctx, id) {
        return { tags: currentTags(await oneCluster(ctx, id)) };
      },
      async run(ctx, id, v) {
        const arn = clusterArn(ctx, id);
        const diff = tagDiff(currentTags(await oneCluster(ctx, id)), fieldTags(v.tags));
        if (diff.set.length) await ctx.clients.redshift.send(new CreateTagsCommand({ ResourceName: arn, Tags: diff.set }));
        if (diff.remove.length) await ctx.clients.redshift.send(new DeleteTagsCommand({ ResourceName: arn, TagKeys: diff.remove }));
        return { message: tagDiffMessage(diff) };
      },
    },
    {
      id: "delete-with-snapshot",
      label: "Delete with final snapshot",
      danger: true,
      confirm: "Deletes the cluster after taking a final snapshot. This can't be undone.",
      fields: [{ name: "finalSnapshot", label: "Final snapshot identifier", kind: "text", required: true, validate: IDENT }],
      async run(ctx, id, v) {
        const r = await ctx.clients.redshift.send(new DeleteClusterCommand({ ClusterIdentifier: id, FinalClusterSnapshotIdentifier: String(v.finalSnapshot), SkipFinalClusterSnapshot: false }));
        return { message: `Deleting ${id} (${r.Cluster?.ClusterStatus ?? "requested"}); final snapshot ${String(v.finalSnapshot)}.` };
      },
    },
  ],
  delete: {
    confirmText: "name",
    async run(ctx, id) {
      await ctx.clients.redshift.send(new DeleteClusterCommand({ ClusterIdentifier: id, SkipFinalClusterSnapshot: true }));
    },
  },
};
