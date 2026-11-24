/**
 * RDS "Subnet groups", "Parameter groups", "Option groups" and "Events".
 */

import {
  CreateDBClusterParameterGroupCommand,
  CreateDBParameterGroupCommand,
  CreateDBSubnetGroupCommand,
  CreateOptionGroupCommand,
  DeleteDBClusterParameterGroupCommand,
  DeleteDBParameterGroupCommand,
  DeleteDBSubnetGroupCommand,
  DeleteOptionGroupCommand,
  DescribeDBClusterParameterGroupsCommand,
  DescribeDBClusterParametersCommand,
  DescribeDBParameterGroupsCommand,
  DescribeDBParametersCommand,
  DescribeDBSubnetGroupsCommand,
  DescribeEventsCommand,
  DescribeOptionGroupsCommand,
  ModifyDBClusterParameterGroupCommand,
  ModifyDBParameterGroupCommand,
  ModifyDBSubnetGroupCommand,
  ModifyOptionGroupCommand,
  ResetDBClusterParameterGroupCommand,
  ResetDBParameterGroupCommand,
  type ApplyMethod,
  type Parameter,
} from "@aws-sdk/client-rds";
import { DescribeSubnetsCommand } from "@aws-sdk/client-ec2";
import type { Ctx, Option, ResourceDef, Row } from "../../console/types.ts";
import { ENGINES } from "./format.ts";
import { familyOptions, optionalNumber, strings, subnetOptions, tagList, text, vpcOptions } from "./shared.ts";

const GROUP_NAME = "[a-zA-Z][a-zA-Z0-9-]{0,254}";
const groupValidate = { pattern: GROUP_NAME, message: "Letters, numbers and hyphens, starting with a letter." };

// ---- Subnet groups ----

async function checkSubnets(ctx: Ctx, vpcId: string, subnetIds: string[]): Promise<void> {
  if (subnetIds.length < 2) throw new Error("Choose at least two subnets, in at least two Availability Zones.");
  const r = await ctx.clients.ec2.send(new DescribeSubnetsCommand({ SubnetIds: subnetIds }));
  const subnets = r.Subnets ?? [];
  const wrong = subnets.filter((s) => s.VpcId !== vpcId).map((s) => s.SubnetId);
  if (wrong.length) throw new Error(`These subnets are not in ${vpcId}: ${wrong.join(", ")}.`);
  if (new Set(subnets.map((s) => s.AvailabilityZone)).size < 2) throw new Error("The subnets must cover at least two Availability Zones.");
}

export const subnetGroupsResource: ResourceDef = {
  id: "subnet-groups",
  name: "Subnet groups",
  singular: "DB subnet group",
  idField: "name",
  nameField: "name",
  description: "A DB subnet group is the set of subnets in a VPC that RDS can place DB instances in.",
  emptyText: "You don't have any DB subnet groups.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "description", label: "Description", kind: "text" },
    { key: "status", label: "Status", kind: "status" },
    { key: "vpc", label: "VPC", kind: "text" },
    { key: "subnets", label: "Subnets", kind: "count" },
  ],
  async list(ctx) {
    const r = await ctx.clients.rds.send(new DescribeDBSubnetGroupsCommand({}));
    return (r.DBSubnetGroups ?? []).map((g) => ({ name: g.DBSubnetGroupName ?? "", description: g.DBSubnetGroupDescription ?? null, status: g.SubnetGroupStatus ?? null, vpc: g.VpcId ?? null, subnets: g.Subnets?.length ?? 0 }));
  },
  async get(ctx, name) {
    const g = (await ctx.clients.rds.send(new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: name }))).DBSubnetGroups?.[0];
    if (!g) throw new Error(`DB subnet group ${name} not found.`);
    return {
      summary: { name: g.DBSubnetGroupName ?? name, description: g.DBSubnetGroupDescription ?? null, vpc: g.VpcId ?? null, status: g.SubnetGroupStatus ?? null, arn: g.DBSubnetGroupArn ?? null },
      summaryLabels: { name: "Name", description: "Description", vpc: "VPC ID", status: "Status", arn: "ARN" },
      tabs: [
        {
          id: "subnets",
          label: "Subnets",
          kind: "table",
          columns: [
            { key: "az", label: "Availability Zone", kind: "text" },
            { key: "id", label: "Subnet ID", kind: "text" },
            { key: "status", label: "Status", kind: "status" },
          ],
          data: (g.Subnets ?? []).map((s) => ({ az: s.SubnetAvailabilityZone?.Name ?? null, id: s.SubnetIdentifier ?? "", status: s.SubnetStatus ?? null })),
          emptyText: "No subnets.",
        },
      ],
    };
  },
  create: {
    title: "Create DB subnet group",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, section: "Subnet group details", validate: groupValidate },
      { name: "description", label: "Description", kind: "text", required: true, section: "Subnet group details" },
      { name: "vpc", label: "VPC", kind: "select", required: true, options: vpcOptions, section: "Subnet group details" },
      { name: "subnets", label: "Subnets", kind: "multiselect", required: true, options: subnetOptions, section: "Add subnets", help: "Choose at least two subnets of the VPC, in at least two Availability Zones." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const subnets = strings(v.subnets);
      await checkSubnets(ctx, text(v.vpc), subnets);
      const tags = tagList(v.tags);
      await ctx.clients.rds.send(new CreateDBSubnetGroupCommand({ DBSubnetGroupName: text(v.name), DBSubnetGroupDescription: text(v.description), SubnetIds: subnets, Tags: tags.length ? tags : undefined }));
      return text(v.name).toLowerCase();
    },
  },
  actions: [
    {
      id: "edit",
      label: "Edit",
      fields: [
        { name: "description", label: "Description", kind: "text" },
        { name: "subnets", label: "Subnets", kind: "multiselect", required: true, options: subnetOptions, help: "Replaces the group's subnets. Same VPC, at least two Availability Zones." },
      ],
      async initialValues(ctx, name) {
        const g = (await ctx.clients.rds.send(new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: name }))).DBSubnetGroups?.[0];
        return { description: g?.DBSubnetGroupDescription ?? "", subnets: (g?.Subnets ?? []).map((x) => x.SubnetIdentifier ?? "").filter(Boolean) };
      },
      async run(ctx, name, v) {
        const g = (await ctx.clients.rds.send(new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: name }))).DBSubnetGroups?.[0];
        const subnets = strings(v.subnets);
        await checkSubnets(ctx, g?.VpcId ?? "", subnets);
        await ctx.clients.rds.send(new ModifyDBSubnetGroupCommand({ DBSubnetGroupName: name, DBSubnetGroupDescription: text(v.description) || undefined, SubnetIds: subnets }));
        return { message: `Saved ${subnets.length} subnets.` };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, name) {
      await ctx.clients.rds.send(new DeleteDBSubnetGroupCommand({ DBSubnetGroupName: name }));
    },
  },
};

// ---- Parameter groups ----

type GroupKind = "db" | "cluster";

function parseGroupKey(key: string): { kind: GroupKind; name: string } {
  const [kind, ...rest] = key.split(":");
  const name = rest.join(":");
  if ((kind !== "db" && kind !== "cluster") || !name) throw new Error(`"${key}" is not a parameter group id this console made.`);
  return { kind, name };
}

async function allParameters(ctx: Ctx, kind: GroupKind, name: string): Promise<Parameter[]> {
  const out: Parameter[] = [];
  let marker: string | undefined;
  do {
    const r =
      kind === "db"
        ? await ctx.clients.rds.send(new DescribeDBParametersCommand({ DBParameterGroupName: name, Marker: marker }))
        : await ctx.clients.rds.send(new DescribeDBClusterParametersCommand({ DBClusterParameterGroupName: name, Marker: marker }));
    out.push(...(r.Parameters ?? []));
    marker = r.Marker;
  } while (marker);
  return out;
}

function parameterRow(p: Parameter): Row {
  return {
    name: p.ParameterName ?? "",
    value: p.ParameterValue ?? null,
    allowed: p.AllowedValues ?? null,
    modifiable: p.IsModifiable ?? null,
    source: p.Source ?? null,
    applyType: p.ApplyType ?? null,
    dataType: p.DataType ?? null,
    description: p.Description ?? null,
  };
}

export const parameterGroupsResource: ResourceDef = {
  id: "parameter-groups",
  name: "Parameter groups",
  singular: "parameter group",
  idField: "key",
  nameField: "name",
  description: "Engine configuration values applied to DB instances (DB parameter groups) or Aurora clusters (DB cluster parameter groups).",
  emptyText: "You don't have any parameter groups.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "family", label: "Family", kind: "text" },
    { key: "type", label: "Type", kind: "text" },
    { key: "description", label: "Description", kind: "text" },
  ],
  async list(ctx) {
    const [db, cluster] = await Promise.all([ctx.clients.rds.send(new DescribeDBParameterGroupsCommand({})), ctx.clients.rds.send(new DescribeDBClusterParameterGroupsCommand({}))]);
    return [
      ...(db.DBParameterGroups ?? []).map((g) => ({ key: `db:${g.DBParameterGroupName ?? ""}`, name: g.DBParameterGroupName ?? "", family: g.DBParameterGroupFamily ?? null, type: "DB parameter group", description: g.Description ?? null })),
      ...(cluster.DBClusterParameterGroups ?? []).map((g) => ({ key: `cluster:${g.DBClusterParameterGroupName ?? ""}`, name: g.DBClusterParameterGroupName ?? "", family: g.DBParameterGroupFamily ?? null, type: "DB cluster parameter group", description: g.Description ?? null })),
    ];
  },
  async get(ctx, key) {
    const k = parseGroupKey(key);
    const params = await allParameters(ctx, k.kind, k.name);
    const group =
      k.kind === "db"
        ? (await ctx.clients.rds.send(new DescribeDBParameterGroupsCommand({ DBParameterGroupName: k.name }))).DBParameterGroups?.[0]
        : (await ctx.clients.rds.send(new DescribeDBClusterParameterGroupsCommand({ DBClusterParameterGroupName: k.name }))).DBClusterParameterGroups?.[0];
    const modified = params.filter((p) => p.Source === "user");
    return {
      summary: { name: k.name, family: group?.DBParameterGroupFamily ?? null, type: k.kind === "db" ? "DB parameter group" : "DB cluster parameter group", description: group?.Description ?? null },
      summaryLabels: { name: "Parameter group name", family: "Family", type: "Type", description: "Description" },
      tabs: [
        {
          id: "parameters",
          label: `Parameters (${params.length})`,
          kind: "table",
          columns: [
            { key: "name", label: "Name", kind: "text" },
            { key: "value", label: "Value", kind: "code" },
            { key: "allowed", label: "Allowed values", kind: "text" },
            { key: "modifiable", label: "Modifiable", kind: "boolean" },
            { key: "source", label: "Source", kind: "text" },
            { key: "applyType", label: "Apply type", kind: "text" },
            { key: "dataType", label: "Data type", kind: "text" },
            { key: "description", label: "Description", kind: "text" },
          ],
          data: params.map(parameterRow),
          emptyText: "This group has no parameters.",
        },
        {
          id: "modified",
          label: "Modified parameters",
          kind: "table",
          columns: [
            { key: "name", label: "Name", kind: "text" },
            { key: "value", label: "Value", kind: "code" },
            { key: "applyType", label: "Apply type", kind: "text" },
          ],
          data: modified.map(parameterRow),
          description: "Parameters whose source is user: values set with Edit parameter.",
          emptyText: "No parameters have been changed from their defaults.",
        },
      ],
    };
  },
  create: {
    title: "Create parameter group",
    fields: [
      { name: "family", label: "Parameter group family", kind: "select", required: true, options: familyOptions, section: "Parameter group details", help: "For example postgres16 or aurora-mysql8.0." },
      {
        name: "type", label: "Type", kind: "radio", default: "db", section: "Parameter group details",
        options: [
          { value: "db", label: "DB parameter group" },
          { value: "cluster", label: "DB cluster parameter group (Aurora and Multi-AZ DB clusters)" },
        ],
      },
      { name: "name", label: "Parameter group name", kind: "text", required: true, section: "Parameter group details", validate: groupValidate },
      { name: "description", label: "Description", kind: "text", required: true, section: "Parameter group details" },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const tags = tagList(v.tags);
      const name = text(v.name);
      if (v.type === "cluster") {
        await ctx.clients.rds.send(new CreateDBClusterParameterGroupCommand({ DBClusterParameterGroupName: name, DBParameterGroupFamily: text(v.family), Description: text(v.description), Tags: tags.length ? tags : undefined }));
        return `cluster:${name.toLowerCase()}`;
      }
      await ctx.clients.rds.send(new CreateDBParameterGroupCommand({ DBParameterGroupName: name, DBParameterGroupFamily: text(v.family), Description: text(v.description), Tags: tags.length ? tags : undefined }));
      return `db:${name.toLowerCase()}`;
    },
  },
  actions: [
    {
      id: "edit-parameter",
      label: "Edit parameter",
      fields: [
        { name: "parameter", label: "Parameter name", kind: "text", required: true, help: "See the Parameters tab for names, allowed values and whether a parameter is modifiable." },
        { name: "value", label: "Value", kind: "text", required: true },
        {
          name: "applyMethod", label: "Apply method", kind: "radio", required: true, default: "immediate",
          options: [
            { value: "immediate", label: "Immediate (dynamic parameters only)" },
            { value: "pending-reboot", label: "Pending reboot" },
          ],
        },
      ],
      async run(ctx, key, v) {
        const k = parseGroupKey(key);
        const param = { ParameterName: text(v.parameter), ParameterValue: text(v.value), ApplyMethod: text(v.applyMethod) as ApplyMethod };
        if (k.kind === "db") await ctx.clients.rds.send(new ModifyDBParameterGroupCommand({ DBParameterGroupName: k.name, Parameters: [param] }));
        else await ctx.clients.rds.send(new ModifyDBClusterParameterGroupCommand({ DBClusterParameterGroupName: k.name, Parameters: [param] }));
        return { message: `Set ${param.ParameterName} = ${param.ParameterValue} (${param.ApplyMethod}).` };
      },
    },
    {
      id: "reset",
      label: "Reset all parameters",
      danger: true,
      confirm: "Every parameter goes back to its engine default.",
      async run(ctx, key) {
        const k = parseGroupKey(key);
        if (k.kind === "db") await ctx.clients.rds.send(new ResetDBParameterGroupCommand({ DBParameterGroupName: k.name, ResetAllParameters: true }));
        else await ctx.clients.rds.send(new ResetDBClusterParameterGroupCommand({ DBClusterParameterGroupName: k.name, ResetAllParameters: true }));
        return { message: "All parameters reset to their defaults." };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, key) {
      const k = parseGroupKey(key);
      if (k.kind === "db") await ctx.clients.rds.send(new DeleteDBParameterGroupCommand({ DBParameterGroupName: k.name }));
      else await ctx.clients.rds.send(new DeleteDBClusterParameterGroupCommand({ DBClusterParameterGroupName: k.name }));
    },
  },
};

// ---- Option groups ----

/** The options already in a group, for Delete option. */
async function currentOptions(ctx: Ctx, name?: string): Promise<Option[]> {
  if (!name) return [];
  const g = (await ctx.clients.rds.send(new DescribeOptionGroupsCommand({ OptionGroupName: name }))).OptionGroupsList?.[0];
  return (g?.Options ?? []).filter((o) => o.OptionName).map((o) => ({ value: o.OptionName as string, label: o.OptionName as string }));
}

export const optionGroupsResource: ResourceDef = {
  id: "option-groups",
  name: "Option groups",
  singular: "option group",
  idField: "name",
  nameField: "name",
  description: "Option groups turn on extra engine features, such as audit plugins or Oracle and SQL Server options.",
  emptyText: "You don't have any option groups.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "description", label: "Description", kind: "text" },
    { key: "engine", label: "Engine", kind: "text" },
    { key: "version", label: "Major engine version", kind: "text" },
    { key: "options", label: "Options", kind: "count" },
  ],
  async list(ctx) {
    const r = await ctx.clients.rds.send(new DescribeOptionGroupsCommand({}));
    return (r.OptionGroupsList ?? []).map((g) => ({ name: g.OptionGroupName ?? "", description: g.OptionGroupDescription ?? null, engine: g.EngineName ?? null, version: g.MajorEngineVersion ?? null, options: g.Options?.length ?? 0 }));
  },
  async get(ctx, name) {
    const g = (await ctx.clients.rds.send(new DescribeOptionGroupsCommand({ OptionGroupName: name }))).OptionGroupsList?.[0];
    if (!g) throw new Error(`Option group ${name} not found.`);
    return {
      summary: { name: g.OptionGroupName ?? name, description: g.OptionGroupDescription ?? null, engine: g.EngineName ?? null, version: g.MajorEngineVersion ?? null, arn: g.OptionGroupArn ?? null },
      summaryLabels: { name: "Name", description: "Description", engine: "Engine", version: "Major engine version", arn: "ARN" },
      tabs: [
        {
          id: "options",
          label: "Options",
          kind: "table",
          columns: [
            { key: "name", label: "Name", kind: "text" },
            { key: "description", label: "Description", kind: "text" },
            { key: "port", label: "Port", kind: "text" },
            { key: "persistent", label: "Persistent", kind: "boolean" },
            { key: "permanent", label: "Permanent", kind: "boolean" },
            { key: "settings", label: "Option settings", kind: "code" },
          ],
          data: (g.Options ?? []).map((o) => ({
            name: o.OptionName ?? "",
            description: o.OptionDescription ?? null,
            port: o.Port ?? null,
            persistent: o.Persistent ?? null,
            permanent: o.Permanent ?? null,
            settings: (o.OptionSettings ?? []).map((s) => `${s.Name}=${s.Value ?? ""}`).join(", ") || null,
          })),
          emptyText: "No options. Use Actions > Add option.",
        },
      ],
    };
  },
  create: {
    title: "Create option group",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, section: "Option group details", validate: groupValidate },
      { name: "description", label: "Description", kind: "text", required: true, section: "Option group details" },
      { name: "engine", label: "Engine", kind: "select", required: true, default: "mysql", options: ENGINES.filter((e) => !e.value.startsWith("aurora") && e.value !== "postgres"), section: "Option group details" },
      { name: "version", label: "Major engine version", kind: "text", required: true, section: "Option group details", placeholder: "8.0", help: "For example 8.0 for MySQL, 19 for Oracle, 16.00 for SQL Server." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const tags = tagList(v.tags);
      await ctx.clients.rds.send(
        new CreateOptionGroupCommand({ OptionGroupName: text(v.name), OptionGroupDescription: text(v.description), EngineName: text(v.engine), MajorEngineVersion: text(v.version), Tags: tags.length ? tags : undefined })
      );
      return text(v.name).toLowerCase();
    },
  },
  actions: [
    {
      id: "add-option",
      label: "Add option",
      fields: [
        { name: "option", label: "Option name", kind: "text", required: true, placeholder: "MARIADB_AUDIT_PLUGIN", help: "The option's RDS name, e.g. MARIADB_AUDIT_PLUGIN (MySQL/MariaDB), S3_INTEGRATION (Oracle), SQLSERVER_BACKUP_RESTORE." },
        { name: "port", label: "Port", kind: "number", help: "Only for options that listen on a port." },
        { name: "apply", label: "Apply immediately", kind: "checkbox", default: true },
      ],
      async run(ctx, name, v) {
        const r = await ctx.clients.rds.send(
          new ModifyOptionGroupCommand({ OptionGroupName: name, ApplyImmediately: v.apply === true, OptionsToInclude: [{ OptionName: text(v.option), Port: optionalNumber(v.port) }] })
        );
        return { message: `Options now: ${(r.OptionGroup?.Options ?? []).map((o) => o.OptionName).join(", ") || "none"}.` };
      },
    },
    {
      id: "remove-option",
      label: "Delete option",
      danger: true,
      fields: [
        { name: "option", label: "Option", kind: "select", required: true, options: currentOptions },
        { name: "apply", label: "Apply immediately", kind: "checkbox", default: true },
      ],
      async run(ctx, name, v) {
        const r = await ctx.clients.rds.send(new ModifyOptionGroupCommand({ OptionGroupName: name, OptionsToRemove: [text(v.option)], ApplyImmediately: v.apply === true }));
        return { message: `Options now: ${(r.OptionGroup?.Options ?? []).map((o) => o.OptionName).join(", ") || "none"}.` };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, name) {
      await ctx.clients.rds.send(new DeleteOptionGroupCommand({ OptionGroupName: name }));
    },
  },
};

// ---- Events ----

export const eventsResource: ResourceDef = {
  id: "events",
  name: "Events",
  singular: "event",
  idField: "id",
  description: "RDS events from the last 14 days, newest first.",
  emptyText: "No events in the last 14 days.",
  columns: [
    { key: "source", label: "Source", kind: "link" },
    { key: "type", label: "Type", kind: "text" },
    { key: "time", label: "Time", kind: "date" },
    { key: "message", label: "Message", kind: "text" },
    { key: "categories", label: "Categories", kind: "text" },
  ],
  async list(ctx) {
    const rows: Row[] = [];
    let marker: string | undefined;
    do {
      const r = await ctx.clients.rds.send(new DescribeEventsCommand({ Duration: 20160, Marker: marker, MaxRecords: 100 }));
      for (const e of r.Events ?? []) {
        rows.push({ id: `${rows.length}`, source: e.SourceIdentifier ?? "", type: e.SourceType ?? null, time: e.Date ?? null, message: e.Message ?? "", categories: (e.EventCategories ?? []).join(", ") });
      }
      marker = r.Marker;
    } while (marker && rows.length < 1000);
    return rows.reverse();
  },
};
