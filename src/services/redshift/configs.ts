/** Redshift snapshots, subnet groups, parameter groups and events. */

import {
  CopyClusterSnapshotCommand,
  CreateClusterParameterGroupCommand,
  CreateClusterSubnetGroupCommand,
  DeleteClusterParameterGroupCommand,
  DeleteClusterSnapshotCommand,
  DeleteClusterSubnetGroupCommand,
  DescribeClusterParameterGroupsCommand,
  DescribeClusterParametersCommand,
  DescribeClusterSnapshotsCommand,
  DescribeClusterSubnetGroupsCommand,
  DescribeEventsCommand,
  ModifyClusterParameterGroupCommand,
  ModifyClusterSubnetGroupCommand,
  ResetClusterParameterGroupCommand,
  RestoreFromClusterSnapshotCommand,
  type Parameter,
  type Snapshot,
} from "@aws-sdk/client-redshift";
import type { Ctx, FieldValues, ResourceDef, Row, Tag } from "../../console/types.ts";
import { storageText, titleCase } from "./helpers.ts";
import { nodeTypeOptions, parameterGroups, subnetGroupOptions, subnetGroups, subnetOptions } from "./lookups.ts";

const IDENT = { pattern: "[a-z][a-z0-9]*(-[a-z0-9]+)*", message: "Lowercase letters, numbers and single hyphens, starting with a letter." };
const tagsOf = (v: unknown): Tag[] | undefined => (Array.isArray(v) && v.length ? (v as Tag[]) : undefined);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Default parameter groups (default.*) can't be changed. */
function isCustomGroup(row: Row): boolean {
  const name = row.name ?? row.Name;
  return typeof name !== "string" || !name.startsWith("default.");
}

/** Snapshot rows carry the status title-cased. */
function snapshotAvailable(row: Row): boolean {
  const status = row.status ?? row.Status;
  return typeof status !== "string" || status.toLowerCase() === "available";
}

async function allSnapshots(ctx: Ctx, id?: string): Promise<Snapshot[]> {
  const out: Snapshot[] = [];
  let marker: string | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await ctx.clients.redshift.send(new DescribeClusterSnapshotsCommand({ SnapshotIdentifier: id, Marker: marker, MaxRecords: 100 }));
    out.push(...(r.Snapshots ?? []));
    if (!r.Marker || r.Marker === marker) break;
    marker = r.Marker;
  }
  return out;
}

export const snapshotResource: ResourceDef = {
  id: "snapshots",
  name: "Snapshots",
  singular: "snapshot",
  idField: "id",
  nameField: "id",
  description: "Point-in-time backups of clusters. Restore one to create a new cluster.",
  emptyText: "No snapshots.",
  columns: [
    { key: "id", label: "Snapshot", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "cluster", label: "Cluster", kind: "text" },
    { key: "type", label: "Snapshot type", kind: "text" },
    { key: "created", label: "Snapshot creation time", kind: "date" },
    { key: "size", label: "Size", kind: "text" },
    { key: "retention", label: "Retention period", kind: "text" },
  ],
  async list(ctx) {
    return (await allSnapshots(ctx)).map((s) => ({
      id: s.SnapshotIdentifier ?? "",
      status: titleCase(s.Status),
      cluster: s.ClusterIdentifier ?? null,
      type: titleCase(s.SnapshotType),
      created: s.SnapshotCreateTime ?? null,
      size: typeof s.TotalBackupSizeInMegaBytes === "number" ? `${s.TotalBackupSizeInMegaBytes} MB` : null,
      retention: s.ManualSnapshotRetentionPeriod === -1 ? "Indefinitely" : s.ManualSnapshotRetentionPeriod !== undefined ? `${s.ManualSnapshotRetentionPeriod} days` : null,
    }));
  },
  async get(ctx, id) {
    const [s] = await allSnapshots(ctx, id);
    if (!s) throw new Error(`Snapshot ${id} was not found.`);
    return {
      summary: {
        "Snapshot identifier": id,
        Status: titleCase(s.Status),
        "Source cluster": s.ClusterIdentifier ?? null,
        "Snapshot type": titleCase(s.SnapshotType),
        "Node type": s.NodeType ?? null,
        "Number of nodes": s.NumberOfNodes ?? null,
        "Database name": s.DBName ?? null,
        "Admin user name": s.MasterUsername ?? null,
        Encrypted: s.Encrypted ? "Yes" : "No",
        "Cluster storage": storageText(s.TotalBackupSizeInMegaBytes),
        Created: s.SnapshotCreateTime ?? null,
        "Cluster created": s.ClusterCreateTime ?? null,
        ARN: s.SnapshotArn ?? null,
      },
      tabs: [{ id: "tags", label: "Tags", kind: "table", columns: [{ key: "Key", label: "Key", kind: "text" }, { key: "Value", label: "Value", kind: "text" }], data: s.Tags ?? [], emptyText: "No tags." }],
    };
  },
  actions: [
    {
      id: "restore",
      label: "Restore to provisioned cluster",
      availableFor: snapshotAvailable,
      fields: [
        { name: "cluster", label: "Cluster identifier", kind: "text", required: true, validate: IDENT },
        { name: "nodeType", label: "Node type", kind: "select", default: "", options: nodeTypeOptions, help: "Leave empty to use the snapshot's node type." },
        { name: "nodes", label: "Number of nodes", kind: "number", validate: { min: 1, max: 128, message: "Between 1 and 128." } },
        { name: "subnetGroup", label: "Cluster subnet group", kind: "select", default: "", options: subnetGroupOptions },
        { name: "publiclyAccessible", label: "Publicly accessible", kind: "checkbox", default: false },
      ],
      async run(ctx, id, v) {
        const cluster = String(v.cluster);
        const r = await ctx.clients.redshift.send(new RestoreFromClusterSnapshotCommand({
          ClusterIdentifier: cluster,
          SnapshotIdentifier: id,
          NodeType: typeof v.nodeType === "string" && v.nodeType ? v.nodeType : undefined,
          NumberOfNodes: typeof v.nodes === "number" ? v.nodes : undefined,
          ClusterSubnetGroupName: typeof v.subnetGroup === "string" && v.subnetGroup ? v.subnetGroup : undefined,
          PubliclyAccessible: v.publiclyAccessible === true,
        }));
        return { message: `Restoring ${id} into cluster ${cluster}. Status: ${r.Cluster?.ClusterStatus ?? "unknown"}.` };
      },
    },
    {
      id: "copy",
      label: "Copy to manual snapshot",
      availableFor: (row) => snapshotAvailable(row) && String(row.type ?? row["Snapshot type"] ?? "automated").toLowerCase() === "automated",
      fields: [{ name: "target", label: "New snapshot identifier", kind: "text", required: true, validate: IDENT }],
      async run(ctx, id, v) {
        const r = await ctx.clients.redshift.send(new CopyClusterSnapshotCommand({ SourceSnapshotIdentifier: id, TargetSnapshotIdentifier: String(v.target) }));
        return { message: `Copied to ${String(v.target)} (${r.Snapshot?.Status ?? "requested"}). Only automated snapshots can be copied.` };
      },
    },
  ],
  delete: {
    confirmText: "name",
    async run(ctx, id) {
      await ctx.clients.redshift.send(new DeleteClusterSnapshotCommand({ SnapshotIdentifier: id }));
    },
  },
};

export const subnetGroupResource: ResourceDef = {
  id: "subnet-groups",
  name: "Subnet groups",
  singular: "subnet group",
  idField: "name",
  nameField: "name",
  description: "Cluster subnet groups say which VPC subnets a cluster can use.",
  emptyText: "No cluster subnet groups.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "description", label: "Description", kind: "text" },
    { key: "status", label: "Status", kind: "status" },
    { key: "vpc", label: "VPC ID", kind: "text" },
    { key: "subnets", label: "Subnets", kind: "count" },
  ],
  async list(ctx) {
    return (await subnetGroups(ctx)).map((g) => ({ name: g.ClusterSubnetGroupName ?? "", description: g.Description ?? null, status: g.SubnetGroupStatus ?? null, vpc: g.VpcId ?? null, subnets: g.Subnets?.length ?? 0 }));
  },
  async get(ctx, name) {
    const r = await ctx.clients.redshift.send(new DescribeClusterSubnetGroupsCommand({ ClusterSubnetGroupName: name }));
    const g = r.ClusterSubnetGroups?.[0];
    if (!g) throw new Error(`Subnet group ${name} was not found.`);
    return {
      summary: { Name: name, Description: g.Description ?? null, Status: g.SubnetGroupStatus ?? null, "VPC ID": g.VpcId ?? null },
      tabs: [
        {
          id: "subnets", label: "Subnets", kind: "table",
          columns: [{ key: "subnet", label: "Subnet ID", kind: "text" }, { key: "zone", label: "Availability Zone", kind: "text" }, { key: "status", label: "Status", kind: "status" }],
          data: (g.Subnets ?? []).map((s) => ({ subnet: s.SubnetIdentifier ?? "", zone: s.SubnetAvailabilityZone?.Name ?? null, status: s.SubnetStatus ?? null })),
          emptyText: "No subnets.",
        },
        { id: "tags", label: "Tags", kind: "table", columns: [{ key: "Key", label: "Key", kind: "text" }, { key: "Value", label: "Value", kind: "text" }], data: g.Tags ?? [], emptyText: "No tags." },
      ],
    };
  },
  create: {
    title: "Create cluster subnet group",
    description: "Creates a cluster subnet group with CreateClusterSubnetGroup.",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, validate: IDENT, section: "Subnet group details" },
      { name: "description", label: "Description", kind: "text", required: true, section: "Subnet group details" },
      { name: "subnets", label: "Subnets", kind: "multiselect", required: true, options: subnetOptions, section: "Add subnets", help: "All subnets must be in the same VPC." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      await ctx.clients.redshift.send(new CreateClusterSubnetGroupCommand({ ClusterSubnetGroupName: name, Description: String(v.description), SubnetIds: strList(v.subnets), Tags: tagsOf(v.tags) }));
      return name;
    },
  },
  actions: [
    {
      id: "edit",
      label: "Edit",
      fields: [
        { name: "description", label: "Description", kind: "text", help: "Clearing it keeps the current description." },
        { name: "subnets", label: "Subnets", kind: "multiselect", required: true, options: subnetOptions, help: "Replaces the subnets of the group." },
      ],
      async initialValues(ctx, name) {
        const [g] = await subnetGroups(ctx, name);
        return { description: g?.Description ?? "", subnets: (g?.Subnets ?? []).map((x) => x.SubnetIdentifier ?? "").filter(Boolean) };
      },
      async run(ctx, name, v) {
        await ctx.clients.redshift.send(new ModifyClusterSubnetGroupCommand({ ClusterSubnetGroupName: name, Description: typeof v.description === "string" && v.description ? v.description : undefined, SubnetIds: strList(v.subnets) }));
        return { message: `Saved subnet group ${name}.` };
      },
    },
  ],
  delete: {
    confirmText: "name",
    async run(ctx, name) {
      await ctx.clients.redshift.send(new DeleteClusterSubnetGroupCommand({ ClusterSubnetGroupName: name }));
    },
  },
};

async function allParameters(ctx: Ctx, name: string, source?: string): Promise<Parameter[]> {
  const out: Parameter[] = [];
  let marker: string | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await ctx.clients.redshift.send(new DescribeClusterParametersCommand({ ParameterGroupName: name, Source: source, Marker: marker, MaxRecords: 100 }));
    out.push(...(r.Parameters ?? []));
    if (!r.Marker || r.Marker === marker) break;
    marker = r.Marker;
  }
  return out;
}

const paramRow = (p: Parameter): Row => ({ name: p.ParameterName ?? "", value: p.ParameterValue ?? null, allowed: p.AllowedValues ?? null, applyType: p.ApplyType ?? null, modifiable: p.IsModifiable ?? null, source: p.Source ?? null, description: p.Description ?? null });

export const parameterGroupResource: ResourceDef = {
  id: "parameter-groups",
  name: "Parameter groups",
  singular: "parameter group",
  idField: "name",
  nameField: "name",
  description: "Parameter groups hold database settings for the clusters that use them.",
  emptyText: "No parameter groups.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "family", label: "Family", kind: "text" },
    { key: "description", label: "Description", kind: "text" },
  ],
  async list(ctx) {
    return (await parameterGroups(ctx)).map((g) => ({ name: g.ParameterGroupName ?? "", family: g.ParameterGroupFamily ?? null, description: g.Description ?? null }));
  },
  async get(ctx, name) {
    const r = await ctx.clients.redshift.send(new DescribeClusterParameterGroupsCommand({ ParameterGroupName: name }));
    const g = r.ParameterGroups?.[0];
    if (!g) throw new Error(`Parameter group ${name} was not found.`);
    return {
      summary: { Name: name, Family: g.ParameterGroupFamily ?? null, Description: g.Description ?? null },
      tabs: [
        {
          id: "parameters", label: "Parameters", kind: "table",
          description: "Use Actions > Edit parameters to change values. Default parameter groups can't be changed.",
          columns: [
            { key: "name", label: "Name", kind: "text" },
            { key: "value", label: "Value", kind: "code" },
            { key: "allowed", label: "Allowed values", kind: "text" },
            { key: "applyType", label: "Apply type", kind: "text" },
            { key: "modifiable", label: "Modifiable", kind: "boolean" },
            { key: "source", label: "Source", kind: "text" },
            { key: "description", label: "Description", kind: "text" },
          ],
          data: (await allParameters(ctx, name)).map(paramRow),
          emptyText: "No parameters.",
        },
        { id: "tags", label: "Tags", kind: "table", columns: [{ key: "Key", label: "Key", kind: "text" }, { key: "Value", label: "Value", kind: "text" }], data: g.Tags ?? [], emptyText: "No tags." },
      ],
    };
  },
  create: {
    title: "Create parameter group",
    description: "Creates a cluster parameter group with CreateClusterParameterGroup.",
    fields: [
      { name: "name", label: "Parameter group name", kind: "text", required: true, validate: IDENT, section: "Parameter group details" },
      { name: "description", label: "Description", kind: "text", required: true, section: "Parameter group details" },
      { name: "family", label: "Family", kind: "select", required: true, default: "redshift-2.0", options: [{ value: "redshift-2.0", label: "redshift-2.0" }, { value: "redshift-1.0", label: "redshift-1.0" }], section: "Parameter group details" },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      await ctx.clients.redshift.send(new CreateClusterParameterGroupCommand({ ParameterGroupName: name, ParameterGroupFamily: String(v.family), Description: String(v.description), Tags: tagsOf(v.tags) }));
      return name;
    },
  },
  actions: [
    {
      id: "edit-parameters",
      label: "Edit parameters",
      availableFor: isCustomGroup,
      async initialValues(ctx, name): Promise<FieldValues> {
        const changed = await allParameters(ctx, name, "user");
        if (changed.length === 0) return {};
        return { values: JSON.stringify(Object.fromEntries(changed.map((p) => [p.ParameterName ?? "", p.ParameterValue ?? ""])), null, 2) };
      },
      fields: [{ name: "values", label: "Parameters", kind: "json", required: true, placeholder: '{ "enable_user_activity_logging": "true" }', help: "A JSON object of parameter name to new value." }],
      async run(ctx, name, v) {
        const parsed: unknown = JSON.parse(String(v.values));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Enter a JSON object of parameter names and values.");
        const params = Object.entries(parsed as Record<string, unknown>).map(([k, val]) => ({ ParameterName: k, ParameterValue: typeof val === "string" ? val : JSON.stringify(val) }));
        if (!params.length) throw new Error("Name at least one parameter.");
        const r = await ctx.clients.redshift.send(new ModifyClusterParameterGroupCommand({ ParameterGroupName: name, Parameters: params }));
        return { message: r.ParameterGroupStatus ?? `Saved ${params.length} parameter(s).` };
      },
    },
    {
      id: "reset",
      label: "Reset all to defaults",
      danger: true,
      confirm: "Resets every parameter in this group to its default.",
      availableFor: isCustomGroup,
      async run(ctx, name) {
        const r = await ctx.clients.redshift.send(new ResetClusterParameterGroupCommand({ ParameterGroupName: name, ResetAllParameters: true }));
        return { message: r.ParameterGroupStatus ?? `Reset ${name}.` };
      },
    },
  ],
  delete: {
    confirmText: "name",
    async run(ctx, name) {
      await ctx.clients.redshift.send(new DeleteClusterParameterGroupCommand({ ParameterGroupName: name }));
    },
  },
};

export const eventResource: ResourceDef = {
  id: "events",
  name: "Events",
  singular: "event",
  idField: "key",
  description: "Redshift events from the last 14 days.",
  emptyText: "No events in the last 14 days.",
  columns: [
    { key: "source", label: "Source", kind: "link" },
    { key: "type", label: "Source type", kind: "text" },
    { key: "severity", label: "Severity", kind: "text" },
    { key: "category", label: "Category", kind: "text" },
    { key: "date", label: "Time", kind: "date" },
    { key: "message", label: "Message", kind: "text" },
  ],
  async list(ctx) {
    const rows: Row[] = [];
    let marker: string | undefined;
    for (let i = 0; i < 20; i++) {
      const r = await ctx.clients.redshift.send(new DescribeEventsCommand({ Duration: 20160, MaxRecords: 100, Marker: marker }));
      for (const e of r.Events ?? []) rows.push({ key: e.EventId ? `${e.EventId}-${rows.length}` : `${rows.length}`, source: e.SourceIdentifier ?? "", type: e.SourceType ?? null, severity: e.Severity ?? null, category: e.EventCategories?.join(", ") ?? null, date: e.Date ?? null, message: e.Message ?? null });
      if (!r.Marker || r.Marker === marker) break;
      marker = r.Marker;
    }
    return rows;
  },
};
