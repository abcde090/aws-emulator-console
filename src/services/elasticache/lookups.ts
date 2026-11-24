/**
 * Live reads shared by the ElastiCache resources: paged Describe calls and the option
 * loaders for create forms (subnet groups, parameter groups, engine versions, VPC data).
 */

import {
  DescribeCacheClustersCommand,
  DescribeCacheEngineVersionsCommand,
  DescribeCacheParameterGroupsCommand,
  DescribeCacheSubnetGroupsCommand,
  DescribeReplicationGroupsCommand,
  DescribeServerlessCachesCommand,
  DescribeServerlessCacheSnapshotsCommand,
  DescribeSnapshotsCommand,
  type CacheCluster,
  type CacheParameterGroup,
  type CacheSubnetGroup,
  type ReplicationGroup,
  type ServerlessCache,
  type ServerlessCacheSnapshot,
  type Snapshot,
} from "@aws-sdk/client-elasticache";
import { DescribeSecurityGroupsCommand, DescribeSubnetsCommand } from "@aws-sdk/client-ec2";
import type { Ctx, Option } from "../../console/types.ts";
import { familyMatchesEngine, type CacheEngine } from "./helpers.ts";

/** Follows Marker pages until the API stops returning one. */
async function pages<T>(fetch: (marker: string | undefined) => Promise<{ items: T[] | undefined; marker: string | undefined }>): Promise<T[]> {
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

export function replicationGroups(ctx: Ctx, id?: string): Promise<ReplicationGroup[]> {
  return pages(async (Marker) => {
    const r = await ctx.clients.elasticache.send(new DescribeReplicationGroupsCommand({ ReplicationGroupId: id, Marker, MaxRecords: 100 }));
    return { items: r.ReplicationGroups, marker: r.Marker };
  });
}

export function cacheClusters(ctx: Ctx, id?: string): Promise<CacheCluster[]> {
  return pages(async (Marker) => {
    const r = await ctx.clients.elasticache.send(new DescribeCacheClustersCommand({ CacheClusterId: id, ShowCacheNodeInfo: true, Marker, MaxRecords: 100 }));
    return { items: r.CacheClusters, marker: r.Marker };
  });
}

export function serverlessCaches(ctx: Ctx, name?: string): Promise<ServerlessCache[]> {
  return pages(async (NextToken) => {
    const r = await ctx.clients.elasticache.send(new DescribeServerlessCachesCommand({ ServerlessCacheName: name, NextToken, MaxResults: 50 }));
    return { items: r.ServerlessCaches, marker: r.NextToken };
  });
}

export function snapshots(ctx: Ctx, filter: { ReplicationGroupId?: string; CacheClusterId?: string; SnapshotName?: string } = {}): Promise<Snapshot[]> {
  return pages(async (Marker) => {
    const r = await ctx.clients.elasticache.send(new DescribeSnapshotsCommand({ ...filter, Marker, MaxRecords: 50 }));
    return { items: r.Snapshots, marker: r.Marker };
  });
}

export function serverlessSnapshots(ctx: Ctx, filter: { ServerlessCacheName?: string; ServerlessCacheSnapshotName?: string } = {}): Promise<ServerlessCacheSnapshot[]> {
  return pages(async (NextToken) => {
    const r = await ctx.clients.elasticache.send(new DescribeServerlessCacheSnapshotsCommand({ ...filter, NextToken, MaxResults: 50 }));
    return { items: r.ServerlessCacheSnapshots, marker: r.NextToken };
  });
}

export function subnetGroups(ctx: Ctx, name?: string): Promise<CacheSubnetGroup[]> {
  return pages(async (Marker) => {
    const r = await ctx.clients.elasticache.send(new DescribeCacheSubnetGroupsCommand({ CacheSubnetGroupName: name, Marker, MaxRecords: 100 }));
    return { items: r.CacheSubnetGroups, marker: r.Marker };
  });
}

export function parameterGroups(ctx: Ctx, name?: string): Promise<CacheParameterGroup[]> {
  return pages(async (Marker) => {
    const r = await ctx.clients.elasticache.send(new DescribeCacheParameterGroupsCommand({ CacheParameterGroupName: name, Marker, MaxRecords: 100 }));
    return { items: r.CacheParameterGroups, marker: r.Marker };
  });
}

// ---- option loaders ----

export async function subnetGroupOptions(ctx: Ctx): Promise<Option[]> {
  return (await subnetGroups(ctx))
    .filter((g) => g.CacheSubnetGroupName)
    .map((g) => ({ value: g.CacheSubnetGroupName as string, label: `${g.CacheSubnetGroupName} (${g.VpcId ?? "no VPC"}, ${g.Subnets?.length ?? 0} subnets)` }));
}

export function parameterGroupOptions(engine: CacheEngine): (ctx: Ctx) => Promise<Option[]> {
  return async (ctx) =>
    (await parameterGroups(ctx))
      .filter((g) => g.CacheParameterGroupName && familyMatchesEngine(g.CacheParameterGroupFamily, engine))
      .map((g) => ({ value: g.CacheParameterGroupName as string, label: `${g.CacheParameterGroupName} (${g.CacheParameterGroupFamily ?? ""})` }));
}

export function engineVersionOptions(engine: CacheEngine): (ctx: Ctx) => Promise<Option[]> {
  return async (ctx) => {
    const all = await pages(async (Marker) => {
      const r = await ctx.clients.elasticache.send(new DescribeCacheEngineVersionsCommand({ Engine: engine, Marker, MaxRecords: 100 }));
      return { items: r.CacheEngineVersions, marker: r.Marker };
    });
    const versions = all.filter((v) => v.EngineVersion).map((v) => v.EngineVersion as string);
    // Newest first, as the console lists them.
    return [...new Set(versions)].sort((a, b) => b.localeCompare(a, "en", { numeric: true })).map((v) => ({ value: v, label: v }));
  };
}

export async function familyOptions(ctx: Ctx): Promise<Option[]> {
  const all = await pages(async (Marker) => {
    const r = await ctx.clients.elasticache.send(new DescribeCacheEngineVersionsCommand({ Marker, MaxRecords: 100 }));
    return { items: r.CacheEngineVersions, marker: r.Marker };
  });
  const families = [...new Set(all.map((v) => v.CacheParameterGroupFamily).filter((f): f is string => Boolean(f)))];
  return families.sort((a, b) => a.localeCompare(b, "en", { numeric: true })).map((f) => ({ value: f, label: f }));
}

export async function subnetOptions(ctx: Ctx): Promise<Option[]> {
  const subnets = await pages(async (NextToken) => {
    const r = await ctx.clients.ec2.send(new DescribeSubnetsCommand({ NextToken }));
    return { items: r.Subnets, marker: r.NextToken };
  });
  return subnets
    .filter((s) => s.SubnetId)
    .map((s) => ({ value: s.SubnetId as string, label: `${s.SubnetId} (${s.AvailabilityZone ?? "?"}, ${s.CidrBlock ?? ""}, ${s.VpcId ?? ""})` }));
}

export async function securityGroupOptions(ctx: Ctx): Promise<Option[]> {
  const groups = await pages(async (NextToken) => {
    const r = await ctx.clients.ec2.send(new DescribeSecurityGroupsCommand({ NextToken }));
    return { items: r.SecurityGroups, marker: r.NextToken };
  });
  return groups
    .filter((g) => g.GroupId)
    .map((g) => ({ value: g.GroupId as string, label: `${g.GroupName ?? g.GroupId} (${g.GroupId}, ${g.VpcId ?? ""})` }));
}

export const NODE_TYPES: Option[] = [
  "cache.t4g.micro", "cache.t4g.small", "cache.t4g.medium",
  "cache.t3.micro", "cache.t3.small", "cache.t3.medium",
  "cache.m7g.large", "cache.m7g.xlarge", "cache.m6g.large", "cache.m5.large",
  "cache.r7g.large", "cache.r7g.xlarge", "cache.r6g.large", "cache.r5.large",
].map((t) => ({ value: t, label: t }));
