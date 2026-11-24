/**
 * RDS calls shared by the databases, snapshots and group definitions. Server only; every
 * call goes through the permission-checked clients in ctx.
 */

import {
  DescribeDBClusterParameterGroupsCommand,
  DescribeDBClustersCommand,
  DescribeDBEngineVersionsCommand,
  DescribeDBInstancesCommand,
  DescribeDBParameterGroupsCommand,
  DescribeDBSubnetGroupsCommand,
  DescribeOptionGroupsCommand,
  type DBCluster,
  type DBInstance,
} from "@aws-sdk/client-rds";
import { DescribeSecurityGroupsCommand, DescribeSubnetsCommand, DescribeVpcsCommand } from "@aws-sdk/client-ec2";
import { ListAliasesCommand, ListKeysCommand } from "@aws-sdk/client-kms";
import type { Ctx, FieldValue, Option, Tag } from "../../console/types.ts";
import { engineName } from "./format.ts";

export async function allInstances(ctx: Ctx, filter?: { clusterId?: string }): Promise<DBInstance[]> {
  const out: DBInstance[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.rds.send(
      new DescribeDBInstancesCommand({ Marker: marker, Filters: filter?.clusterId ? [{ Name: "db-cluster-id", Values: [filter.clusterId] }] : undefined })
    );
    out.push(...(r.DBInstances ?? []));
    marker = r.Marker;
  } while (marker);
  return out;
}

export async function allClusters(ctx: Ctx): Promise<DBCluster[]> {
  const out: DBCluster[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.rds.send(new DescribeDBClustersCommand({ Marker: marker }));
    out.push(...(r.DBClusters ?? []));
    marker = r.Marker;
  } while (marker);
  return out;
}

export async function getInstance(ctx: Ctx, id: string): Promise<DBInstance> {
  const r = await ctx.clients.rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: id }));
  const i = r.DBInstances?.[0];
  if (!i) throw new Error(`DB instance ${id} not found.`);
  return i;
}

export async function getCluster(ctx: Ctx, id: string): Promise<DBCluster> {
  const r = await ctx.clients.rds.send(new DescribeDBClustersCommand({ DBClusterIdentifier: id }));
  const c = r.DBClusters?.[0];
  if (!c) throw new Error(`DB cluster ${id} not found.`);
  return c;
}

// ---- Live options ----

/** Calls a paged API until it stops returning a token. */
export async function allPages<T>(page: (token: string | undefined) => Promise<{ items: T[] | undefined; next: string | undefined }>): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  do {
    const r = await page(token);
    out.push(...(r.items ?? []));
    token = r.next;
  } while (token);
  return out;
}

export async function vpcOptions(ctx: Ctx): Promise<Option[]> {
  const vpcs = await allPages(async (t) => {
    const r = await ctx.clients.ec2.send(new DescribeVpcsCommand({ NextToken: t }));
    return { items: r.Vpcs, next: r.NextToken };
  });
  return vpcs.filter((v) => v.VpcId).map((v) => {
    const name = v.Tags?.find((t) => t.Key === "Name")?.Value;
    return { value: v.VpcId as string, label: `${v.VpcId}${name ? ` (${name})` : ""} ${v.CidrBlock ?? ""}${v.IsDefault ? " - default" : ""}` };
  });
}

export async function subnetOptions(ctx: Ctx): Promise<Option[]> {
  const subnets = await allPages(async (t) => {
    const r = await ctx.clients.ec2.send(new DescribeSubnetsCommand({ NextToken: t }));
    return { items: r.Subnets, next: r.NextToken };
  });
  return subnets.filter((s) => s.SubnetId).map((s) => ({ value: s.SubnetId as string, label: `${s.SubnetId} - ${s.AvailabilityZone ?? ""} - ${s.CidrBlock ?? ""} (${s.VpcId ?? ""})` }));
}

export async function securityGroupOptions(ctx: Ctx): Promise<Option[]> {
  const groups = await allPages(async (t) => {
    const r = await ctx.clients.ec2.send(new DescribeSecurityGroupsCommand({ NextToken: t }));
    return { items: r.SecurityGroups, next: r.NextToken };
  });
  return groups.filter((g) => g.GroupId).map((g) => ({ value: g.GroupId as string, label: `${g.GroupName ?? g.GroupId} (${g.GroupId}, ${g.VpcId ?? ""})` }));
}

export async function subnetGroupOptions(ctx: Ctx): Promise<Option[]> {
  const groups = await allPages(async (m) => {
    const r = await ctx.clients.rds.send(new DescribeDBSubnetGroupsCommand({ Marker: m }));
    return { items: r.DBSubnetGroups, next: r.Marker };
  });
  return groups.filter((g) => g.DBSubnetGroupName).map((g) => ({ value: g.DBSubnetGroupName as string, label: `${g.DBSubnetGroupName} (${g.VpcId ?? ""})` }));
}

export async function parameterGroupOptions(ctx: Ctx): Promise<Option[]> {
  const groups = await allPages(async (m) => {
    const r = await ctx.clients.rds.send(new DescribeDBParameterGroupsCommand({ Marker: m }));
    return { items: r.DBParameterGroups, next: r.Marker };
  });
  return groups.filter((g) => g.DBParameterGroupName).map((g) => ({ value: g.DBParameterGroupName as string, label: `${g.DBParameterGroupName} (${g.DBParameterGroupFamily ?? ""})` }));
}

export async function clusterParameterGroupOptions(ctx: Ctx): Promise<Option[]> {
  const groups = await allPages(async (m) => {
    const r = await ctx.clients.rds.send(new DescribeDBClusterParameterGroupsCommand({ Marker: m }));
    return { items: r.DBClusterParameterGroups, next: r.Marker };
  });
  return groups.filter((g) => g.DBClusterParameterGroupName).map((g) => ({ value: g.DBClusterParameterGroupName as string, label: `${g.DBClusterParameterGroupName} (${g.DBParameterGroupFamily ?? ""})` }));
}

export async function optionGroupOptions(ctx: Ctx): Promise<Option[]> {
  const groups = await allPages(async (m) => {
    const r = await ctx.clients.rds.send(new DescribeOptionGroupsCommand({ Marker: m }));
    return { items: r.OptionGroupsList, next: r.Marker };
  });
  return groups.filter((g) => g.OptionGroupName).map((g) => ({ value: g.OptionGroupName as string, label: `${g.OptionGroupName} (${g.EngineName ?? ""} ${g.MajorEngineVersion ?? ""})` }));
}

/** One engine's versions (DescribeDBEngineVersions, every page). */
export async function engineVersionOptions(ctx: Ctx, engine: string): Promise<Option[]> {
  const out: Option[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.rds.send(new DescribeDBEngineVersionsCommand({ Engine: engine, Marker: marker, MaxRecords: 100 }));
    for (const v of r.DBEngineVersions ?? []) {
      if (v.Engine === engine && v.EngineVersion) out.push({ value: v.EngineVersion, label: `${engineName(v.Engine)} ${v.EngineVersion}` });
    }
    marker = r.Marker;
  } while (marker);
  return out;
}

/** Parameter group families, from the engine versions RDS knows. */
export async function familyOptions(ctx: Ctx): Promise<Option[]> {
  const families = new Set<string>();
  let marker: string | undefined;
  do {
    const r = await ctx.clients.rds.send(new DescribeDBEngineVersionsCommand({ Marker: marker, MaxRecords: 100 }));
    for (const v of r.DBEngineVersions ?? []) if (v.DBParameterGroupFamily) families.add(v.DBParameterGroupFamily);
    marker = r.Marker;
  } while (marker);
  return [...families].sort().map((f) => ({ value: f, label: f }));
}

export async function kmsKeyOptions(ctx: Ctx): Promise<Option[]> {
  const [keys, aliases] = await Promise.all([
    allPages(async (m) => {
      const r = await ctx.clients.kms.send(new ListKeysCommand({ Limit: 1000, Marker: m }));
      return { items: r.Keys, next: r.Truncated ? r.NextMarker : undefined };
    }),
    allPages(async (m) => {
      const r = await ctx.clients.kms.send(new ListAliasesCommand({ Limit: 100, Marker: m }));
      return { items: r.Aliases, next: r.Truncated ? r.NextMarker : undefined };
    }),
  ]);
  const aliasOf = new Map<string, string>();
  for (const a of aliases) if (a.TargetKeyId && a.AliasName) aliasOf.set(a.TargetKeyId, a.AliasName);
  return keys
    .filter((k) => k.KeyId && k.KeyArn)
    .map((k) => ({ value: k.KeyArn as string, label: aliasOf.get(k.KeyId as string) ? `${aliasOf.get(k.KeyId as string)} (${k.KeyId})` : (k.KeyId as string) }));
}

// ---- Values ----

export function text(v: FieldValue | undefined): string {
  return typeof v === "string" ? v.trim() : "";
}

export function optionalText(v: FieldValue | undefined): string | undefined {
  const t = text(v);
  return t === "" ? undefined : t;
}

export function optionalNumber(v: FieldValue | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function strings(v: FieldValue | undefined): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];
}

export function tagList(v: FieldValue | undefined): Tag[] {
  return Array.isArray(v) ? (v as Tag[]).filter((t) => typeof t === "object" && t !== null && "Key" in t) : [];
}

export function parseDateTime(v: FieldValue | undefined, label: string): Date {
  const t = text(v);
  const d = new Date(t);
  if (t === "" || Number.isNaN(d.getTime())) throw new Error(`${label}: enter a date and time such as 2026-11-23T10:00:00Z.`);
  return d;
}

export const tagColumns = [
  { key: "Key", label: "Key", kind: "text" as const },
  { key: "Value", label: "Value", kind: "text" as const },
];
