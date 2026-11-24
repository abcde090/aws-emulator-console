/** ElastiCache subnet groups and parameter groups. */

import {
  CreateCacheParameterGroupCommand,
  CreateCacheSubnetGroupCommand,
  DeleteCacheParameterGroupCommand,
  DeleteCacheSubnetGroupCommand,
  DescribeCacheParametersCommand,
  ModifyCacheParameterGroupCommand,
  ModifyCacheSubnetGroupCommand,
  ResetCacheParameterGroupCommand,
  type Parameter,
} from "@aws-sdk/client-elasticache";
import type { Ctx, FieldValues, ResourceDef, Row } from "../../console/types.ts";
import { familyOptions, parameterGroups, subnetGroups, subnetOptions } from "./lookups.ts";

const GROUP_NAME = { pattern: "[a-zA-Z][a-zA-Z0-9-]{0,254}", message: "Letters, numbers and hyphens, starting with a letter." };

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export const subnetGroupResource: ResourceDef = {
  id: "subnet-groups",
  name: "Subnet groups",
  singular: "subnet group",
  idField: "name",
  nameField: "name",
  description: "A subnet group is a collection of subnets in a VPC that node-based caches can use.",
  emptyText: "No subnet groups. Create one to place caches in chosen subnets.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "description", label: "Description", kind: "text" },
    { key: "vpc", label: "VPC ID", kind: "text" },
    { key: "subnets", label: "Subnets", kind: "count" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],
  async list(ctx) {
    return (await subnetGroups(ctx)).map((g) => ({
      name: g.CacheSubnetGroupName ?? "",
      description: g.CacheSubnetGroupDescription ?? null,
      vpc: g.VpcId ?? null,
      subnets: g.Subnets?.length ?? 0,
      arn: g.ARN ?? null,
    }));
  },
  async get(ctx, name) {
    const [g] = await subnetGroups(ctx, name);
    if (!g) throw new Error(`Subnet group ${name} was not found.`);
    return {
      summary: { Name: name, Description: g.CacheSubnetGroupDescription ?? null, "VPC ID": g.VpcId ?? null, ARN: g.ARN ?? null },
      tabs: [
        {
          id: "subnets", label: "Subnets", kind: "table",
          columns: [
            { key: "subnet", label: "Subnet ID", kind: "text" },
            { key: "zone", label: "Availability Zone", kind: "text" },
            { key: "network", label: "Network types", kind: "text" },
          ],
          data: (g.Subnets ?? []).map((s) => ({ subnet: s.SubnetIdentifier ?? "", zone: s.SubnetAvailabilityZone?.Name ?? null, network: s.SupportedNetworkTypes?.join(", ") ?? null })),
          emptyText: "No subnets.",
        },
      ],
    };
  },
  create: {
    title: "Create subnet group",
    description: "Creates a cache subnet group with CreateCacheSubnetGroup.",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, section: "Subnet group settings", validate: GROUP_NAME },
      { name: "description", label: "Description", kind: "text", required: true, section: "Subnet group settings" },
      { name: "subnets", label: "Subnets", kind: "multiselect", required: true, options: subnetOptions, section: "Subnet group settings", help: "All subnets must be in the same VPC." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      const tags = Array.isArray(v.tags) && v.tags.length ? (v.tags as { Key: string; Value: string }[]) : undefined;
      await ctx.clients.elasticache.send(new CreateCacheSubnetGroupCommand({ CacheSubnetGroupName: name, CacheSubnetGroupDescription: String(v.description), SubnetIds: strList(v.subnets), Tags: tags }));
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
        return { description: g?.CacheSubnetGroupDescription ?? "", subnets: (g?.Subnets ?? []).map((x) => x.SubnetIdentifier ?? "").filter(Boolean) };
      },
      async run(ctx, name, v) {
        await ctx.clients.elasticache.send(new ModifyCacheSubnetGroupCommand({ CacheSubnetGroupName: name, CacheSubnetGroupDescription: typeof v.description === "string" && v.description ? v.description : undefined, SubnetIds: strList(v.subnets) }));
        return { message: `Saved subnet group ${name}.` };
      },
    },
  ],
  delete: {
    confirmText: "name",
    async run(ctx, name) {
      await ctx.clients.elasticache.send(new DeleteCacheSubnetGroupCommand({ CacheSubnetGroupName: name }));
    },
  },
};

async function allParameters(ctx: Ctx, name: string, source?: string): Promise<Parameter[]> {
  const out: Parameter[] = [];
  let marker: string | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await ctx.clients.elasticache.send(new DescribeCacheParametersCommand({ CacheParameterGroupName: name, Source: source, Marker: marker, MaxRecords: 100 }));
    out.push(...(r.Parameters ?? []));
    if (!r.Marker || r.Marker === marker) break;
    marker = r.Marker;
  }
  return out;
}

function parameterRow(p: Parameter): Row {
  return {
    name: p.ParameterName ?? "",
    value: p.ParameterValue ?? null,
    allowed: p.AllowedValues ?? null,
    modifiable: p.IsModifiable ?? null,
    source: p.Source ?? null,
    type: p.DataType ?? null,
    changeType: p.ChangeType ?? null,
    description: p.Description ?? null,
  };
}

/** Default parameter groups (default.*) can't be changed. */
function isCustomGroup(row: Row): boolean {
  const name = row.name ?? row.Name;
  return typeof name !== "string" || !name.startsWith("default.");
}

export const parameterGroupResource: ResourceDef = {
  id: "parameter-groups",
  name: "Parameter groups",
  singular: "parameter group",
  idField: "name",
  nameField: "name",
  description: "Parameter groups hold engine settings that apply to every node of a node-based cache.",
  emptyText: "No parameter groups.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "family", label: "Family", kind: "text" },
    { key: "description", label: "Description", kind: "text" },
    { key: "type", label: "Type", kind: "text" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],
  async list(ctx) {
    return (await parameterGroups(ctx)).map((g) => ({
      name: g.CacheParameterGroupName ?? "",
      family: g.CacheParameterGroupFamily ?? null,
      description: g.Description ?? null,
      type: g.CacheParameterGroupName?.startsWith("default.") ? "Default" : "Custom",
      arn: g.ARN ?? null,
    }));
  },
  async get(ctx, name) {
    const [g] = await parameterGroups(ctx, name);
    if (!g) throw new Error(`Parameter group ${name} was not found.`);
    const params = await allParameters(ctx, name);
    return {
      summary: { Name: name, Family: g.CacheParameterGroupFamily ?? null, Description: g.Description ?? null, Global: g.IsGlobal ? "Yes" : "No", ARN: g.ARN ?? null },
      tabs: [
        {
          id: "parameters", label: "Parameters", kind: "table",
          description: "Use Actions > Edit parameter values to change a parameter. Default parameter groups can't be changed.",
          columns: [
            { key: "name", label: "Name", kind: "text" },
            { key: "value", label: "Value", kind: "code" },
            { key: "allowed", label: "Allowed values", kind: "text" },
            { key: "modifiable", label: "Modifiable", kind: "boolean" },
            { key: "source", label: "Source", kind: "text" },
            { key: "type", label: "Data type", kind: "text" },
            { key: "changeType", label: "Change type", kind: "text" },
            { key: "description", label: "Description", kind: "text" },
          ],
          data: params.map(parameterRow),
          emptyText: "No parameters.",
        },
      ],
    };
  },
  create: {
    title: "Create parameter group",
    description: "Creates a cache parameter group with CreateCacheParameterGroup. It starts with the family's default values.",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, validate: GROUP_NAME, section: "Parameter group details" },
      { name: "description", label: "Description", kind: "text", required: true, section: "Parameter group details" },
      { name: "family", label: "Family", kind: "select", required: true, options: familyOptions, section: "Parameter group details", help: "Engine and major version the group applies to, e.g. valkey8." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      const tags = Array.isArray(v.tags) && v.tags.length ? (v.tags as { Key: string; Value: string }[]) : undefined;
      await ctx.clients.elasticache.send(new CreateCacheParameterGroupCommand({ CacheParameterGroupName: name, CacheParameterGroupFamily: String(v.family), Description: String(v.description), Tags: tags }));
      return name;
    },
  },
  actions: [
    {
      id: "edit-parameters",
      label: "Edit parameter values",
      availableFor: isCustomGroup,
      async initialValues(ctx, name): Promise<FieldValues> {
        const changed = await allParameters(ctx, name, "user");
        if (changed.length === 0) return {};
        return { values: JSON.stringify(Object.fromEntries(changed.map((p) => [p.ParameterName ?? "", p.ParameterValue ?? ""])), null, 2) };
      },
      fields: [
        { name: "values", label: "Parameters", kind: "json", required: true, placeholder: '{ "maxmemory-policy": "allkeys-lru" }', help: "A JSON object of parameter name to new value. Names and allowed values are on the Parameters tab." },
      ],
      async run(ctx, name, v) {
        const parsed: unknown = JSON.parse(String(v.values));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Enter a JSON object such as {\"maxmemory-policy\": \"allkeys-lru\"}.");
        const entries = Object.entries(parsed as Record<string, unknown>).map(([k, val]) => ({ ParameterName: k, ParameterValue: typeof val === "string" ? val : JSON.stringify(val) }));
        if (entries.length === 0) throw new Error("Name at least one parameter.");
        if (entries.length > 20) throw new Error("ElastiCache changes at most 20 parameters per request.");
        await ctx.clients.elasticache.send(new ModifyCacheParameterGroupCommand({ CacheParameterGroupName: name, ParameterNameValues: entries }));
        return { message: `Saved ${entries.length} parameter${entries.length === 1 ? "" : "s"}: ${entries.map((e) => `${e.ParameterName}=${e.ParameterValue}`).join(", ")}.` };
      },
    },
    {
      id: "show-modified",
      label: "Show modified parameters",
      async run(ctx, name) {
        const rows = (await allParameters(ctx, name, "user")).map(parameterRow);
        return {
          message: `${rows.length} parameter${rows.length === 1 ? " differs" : "s differ"} from the defaults.`,
          table: {
            rowKey: "name",
            emptyText: "Every parameter has its default value.",
            columns: [
              { key: "name", label: "Name", kind: "text" },
              { key: "value", label: "Value", kind: "code" },
              { key: "changeType", label: "Change type", kind: "text" },
            ],
            rows,
          },
        };
      },
    },
    {
      id: "reset",
      label: "Reset all to defaults",
      availableFor: isCustomGroup,
      danger: true,
      confirm: "Resets every parameter in this group to the family's default value.",
      async run(ctx, name) {
        await ctx.clients.elasticache.send(new ResetCacheParameterGroupCommand({ CacheParameterGroupName: name, ResetAllParameters: true }));
        return { message: `Reset ${name} to default values.` };
      },
    },
  ],
  delete: {
    confirmText: "name",
    async run(ctx, name) {
      await ctx.clients.elasticache.send(new DeleteCacheParameterGroupCommand({ CacheParameterGroupName: name }));
    },
  },
};
