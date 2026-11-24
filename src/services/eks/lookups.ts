/**
 * Live option lists for EKS forms (roles, subnets, security groups, clusters, versions,
 * add-ons, access policies). Every call goes through the permission-checked clients.
 */

import { DescribeSecurityGroupsCommand, DescribeSubnetsCommand } from "@aws-sdk/client-ec2";
import {
  DescribeAddonVersionsCommand,
  DescribeClusterVersionsCommand,
  ListAccessPoliciesCommand,
  ListClustersCommand,
  type ClusterVersionInformation,
} from "@aws-sdk/client-eks";
import { ListRolesCommand, ListUsersCommand } from "@aws-sdk/client-iam";
import type { Ctx, Option } from "../../console/types.ts";

export async function clusterNames(ctx: Ctx): Promise<string[]> {
  const names: string[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.eks.send(new ListClustersCommand({ nextToken: token, maxResults: 100 }));
    names.push(...(r.clusters ?? []));
    token = r.nextToken;
  } while (token);
  return names;
}

export async function clusterOptions(ctx: Ctx): Promise<Option[]> {
  return (await clusterNames(ctx)).map((n) => ({ value: n, label: n }));
}

export async function clusterVersions(ctx: Ctx): Promise<ClusterVersionInformation[]> {
  const out: ClusterVersionInformation[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.eks.send(new DescribeClusterVersionsCommand({ nextToken: token }));
    out.push(...(r.clusterVersions ?? []));
    token = r.nextToken;
  } while (token);
  return out;
}

/** Supported Kubernetes versions, newest first; the default version is listed first. */
export async function versionOptions(ctx: Ctx): Promise<Option[]> {
  const versions = (await clusterVersions(ctx)).filter((v) => v.clusterVersion && String(v.versionStatus ?? v.status) !== "UNSUPPORTED");
  const sorted = [...versions].sort((a, b) => Number(b.defaultVersion === true) - Number(a.defaultVersion === true) || (b.clusterVersion ?? "").localeCompare(a.clusterVersion ?? "", "en", { numeric: true }));
  return sorted.map((v) => ({
    value: v.clusterVersion as string,
    label: `${v.clusterVersion}${v.defaultVersion ? " (default)" : ""}${String(v.versionStatus ?? v.status) === "EXTENDED_SUPPORT" ? " - extended support" : ""}`,
  }));
}

export async function roleOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.iam.send(new ListRolesCommand({ Marker: marker, MaxItems: 1000 }));
    for (const role of r.Roles ?? []) if (role.Arn && role.RoleName) out.push({ value: role.Arn, label: role.RoleName });
    marker = r.IsTruncated ? r.Marker : undefined;
  } while (marker);
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** IAM users and roles, for access entries. */
export async function principalOptions(ctx: Ctx): Promise<Option[]> {
  const roles = (await roleOptions(ctx)).map((o) => ({ value: o.value, label: `Role: ${o.label}` }));
  const users: Option[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.iam.send(new ListUsersCommand({ Marker: marker, MaxItems: 1000 }));
    for (const u of r.Users ?? []) if (u.Arn && u.UserName) users.push({ value: u.Arn, label: `User: ${u.UserName}` });
    marker = r.IsTruncated ? r.Marker : undefined;
  } while (marker);
  return [...roles, ...users];
}

export async function subnetOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.ec2.send(new DescribeSubnetsCommand({ NextToken: token }));
    for (const s of r.Subnets ?? []) {
      if (!s.SubnetId) continue;
      const name = s.Tags?.find((t) => t.Key === "Name")?.Value;
      out.push({ value: s.SubnetId, label: `${s.SubnetId}${name ? ` (${name})` : ""} | ${s.VpcId ?? "?"} | ${s.AvailabilityZone ?? "?"} | ${s.CidrBlock ?? ""}` });
    }
    token = r.NextToken;
  } while (token);
  return out;
}

export async function securityGroupOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.ec2.send(new DescribeSecurityGroupsCommand({ NextToken: token }));
    for (const g of r.SecurityGroups ?? []) if (g.GroupId) out.push({ value: g.GroupId, label: `${g.GroupId} (${g.GroupName ?? ""}) | ${g.VpcId ?? "?"}` });
    token = r.NextToken;
  } while (token);
  return out;
}

export async function addonNameOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.eks.send(new DescribeAddonVersionsCommand({ nextToken: token, maxResults: 100 }));
    for (const a of r.addons ?? []) {
      if (!a.addonName) continue;
      const by = a.publisher || a.owner;
      out.push({ value: a.addonName, label: `${a.addonName}${a.type ? ` - ${a.type}` : ""}${by ? ` (${by})` : ""}` });
    }
    token = r.nextToken;
  } while (token);
  return out.sort((a, b) => a.value.localeCompare(b.value));
}

export async function accessPolicyOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.eks.send(new ListAccessPoliciesCommand({ nextToken: token, maxResults: 100 }));
    for (const p of r.accessPolicies ?? []) if (p.arn) out.push({ value: p.arn, label: p.name ?? p.arn });
    token = r.nextToken;
  } while (token);
  return out;
}
