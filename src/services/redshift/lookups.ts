/** Live option loaders for the Redshift forms. Every loader follows the API's pages. */

import {
  DescribeClusterParameterGroupsCommand,
  DescribeClusterSubnetGroupsCommand,
  DescribeOrderableClusterOptionsCommand,
  type ClusterParameterGroup,
  type ClusterSubnetGroup,
} from "@aws-sdk/client-redshift";
import { DescribeSecurityGroupsCommand, DescribeSubnetsCommand } from "@aws-sdk/client-ec2";
import type { Ctx, Option } from "../../console/types.ts";

/** Follows Marker / NextToken pages until the API stops returning one. */
export async function pages<T>(fetch: (marker: string | undefined) => Promise<{ items: T[] | undefined; marker: string | undefined }>): Promise<T[]> {
  const out: T[] = [];
  let marker: string | undefined;
  for (let i = 0; i < 100; i++) {
    const page = await fetch(marker);
    out.push(...(page.items ?? []));
    if (!page.marker || page.marker === marker) break;
    marker = page.marker;
  }
  return out;
}

export function subnetGroups(ctx: Ctx, name?: string): Promise<ClusterSubnetGroup[]> {
  return pages(async (Marker) => {
    const r = await ctx.clients.redshift.send(new DescribeClusterSubnetGroupsCommand({ ClusterSubnetGroupName: name, Marker, MaxRecords: 100 }));
    return { items: r.ClusterSubnetGroups, marker: r.Marker };
  });
}

export function parameterGroups(ctx: Ctx, name?: string): Promise<ClusterParameterGroup[]> {
  return pages(async (Marker) => {
    const r = await ctx.clients.redshift.send(new DescribeClusterParameterGroupsCommand({ ParameterGroupName: name, Marker, MaxRecords: 100 }));
    return { items: r.ParameterGroups, marker: r.Marker };
  });
}

export async function nodeTypeOptions(ctx: Ctx): Promise<Option[]> {
  const options = await pages(async (Marker) => {
    const r = await ctx.clients.redshift.send(new DescribeOrderableClusterOptionsCommand({ Marker, MaxRecords: 100 }));
    return { items: r.OrderableClusterOptions, marker: r.Marker };
  });
  const types = [...new Set(options.map((o) => o.NodeType).filter((t): t is string => Boolean(t)))];
  return types.map((t) => ({ value: t, label: t }));
}

export async function subnetGroupOptions(ctx: Ctx): Promise<Option[]> {
  return (await subnetGroups(ctx))
    .filter((g) => g.ClusterSubnetGroupName)
    .map((g) => ({ value: g.ClusterSubnetGroupName as string, label: `${g.ClusterSubnetGroupName} (${g.VpcId ?? ""})` }));
}

export async function parameterGroupOptions(ctx: Ctx): Promise<Option[]> {
  return (await parameterGroups(ctx))
    .filter((g) => g.ParameterGroupName)
    .map((g) => ({ value: g.ParameterGroupName as string, label: `${g.ParameterGroupName} (${g.ParameterGroupFamily ?? ""})` }));
}

export async function securityGroupOptions(ctx: Ctx): Promise<Option[]> {
  const groups = await pages(async (NextToken) => {
    const r = await ctx.clients.ec2.send(new DescribeSecurityGroupsCommand({ NextToken }));
    return { items: r.SecurityGroups, marker: r.NextToken };
  });
  return groups.filter((g) => g.GroupId).map((g) => ({ value: g.GroupId as string, label: `${g.GroupName ?? g.GroupId} (${g.GroupId}, ${g.VpcId ?? ""})` }));
}

export async function subnetOptions(ctx: Ctx): Promise<Option[]> {
  const subnets = await pages(async (NextToken) => {
    const r = await ctx.clients.ec2.send(new DescribeSubnetsCommand({ NextToken }));
    return { items: r.Subnets, marker: r.NextToken };
  });
  return subnets.filter((s) => s.SubnetId).map((s) => ({ value: s.SubnetId as string, label: `${s.SubnetId} (${s.AvailabilityZone ?? "?"}, ${s.CidrBlock ?? ""}, ${s.VpcId ?? ""})` }));
}
