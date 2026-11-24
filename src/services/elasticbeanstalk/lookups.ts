/** Live option lists and shared reads for Elastic Beanstalk forms and screens. */

import { DescribeSubnetsCommand, DescribeVpcsCommand } from "@aws-sdk/client-ec2";
import {
  DescribeApplicationsCommand,
  DescribeApplicationVersionsCommand,
  DescribeEnvironmentsCommand,
  ListPlatformVersionsCommand,
  type ApplicationDescription,
  type ApplicationVersionDescription,
  type EnvironmentDescription,
  type PlatformSummary,
} from "@aws-sdk/client-elastic-beanstalk";
import { ListInstanceProfilesCommand, ListRolesCommand } from "@aws-sdk/client-iam";
import { ListBucketsCommand } from "@aws-sdk/client-s3";
import type { Ctx, Option } from "../../console/types.ts";
import { joinId } from "./helpers.ts";

export async function applications(ctx: Ctx, names?: string[]): Promise<ApplicationDescription[]> {
  return (await ctx.clients.elasticbeanstalk.send(new DescribeApplicationsCommand({ ApplicationNames: names }))).Applications ?? [];
}

export async function environments(ctx: Ctx, filter: { ApplicationName?: string; EnvironmentIds?: string[] } = {}): Promise<EnvironmentDescription[]> {
  const out: EnvironmentDescription[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.elasticbeanstalk.send(new DescribeEnvironmentsCommand({ ...filter, IncludeDeleted: false, NextToken: token, MaxRecords: 1000 }));
    out.push(...(r.Environments ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

export async function environment(ctx: Ctx, id: string): Promise<EnvironmentDescription> {
  const env = (await environments(ctx, { EnvironmentIds: [id] }))[0];
  if (!env) throw new Error(`No environment with ID ${id} (it may have been terminated).`);
  return env;
}

export async function versions(ctx: Ctx, app?: string): Promise<ApplicationVersionDescription[]> {
  const out: ApplicationVersionDescription[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.elasticbeanstalk.send(new DescribeApplicationVersionsCommand({ ApplicationName: app, NextToken: token, MaxRecords: 1000 }));
    out.push(...(r.ApplicationVersions ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

export async function applicationOptions(ctx: Ctx): Promise<Option[]> {
  return (await applications(ctx)).filter((a) => a.ApplicationName).map((a) => ({ value: a.ApplicationName as string, label: a.ApplicationName as string }));
}

/** Every version of every application, as "<application>/<label>". */
export async function versionOptions(ctx: Ctx): Promise<Option[]> {
  return (await versions(ctx))
    .filter((v) => v.ApplicationName && v.VersionLabel)
    .map((v) => ({ value: joinId(v.ApplicationName as string, v.VersionLabel as string), label: `${v.ApplicationName} / ${v.VersionLabel}` }));
}

export async function environmentOptions(ctx: Ctx): Promise<Option[]> {
  return (await environments(ctx))
    .filter((e) => e.EnvironmentId)
    .map((e) => ({ value: e.EnvironmentId as string, label: `${e.EnvironmentName ?? e.EnvironmentId} (${e.ApplicationName ?? "?"})` }));
}

export async function platforms(ctx: Ctx): Promise<PlatformSummary[]> {
  const out: PlatformSummary[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.elasticbeanstalk.send(new ListPlatformVersionsCommand({ NextToken: token, MaxRecords: 100 }));
    out.push(...(r.PlatformSummaryList ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

/** Platform versions, recommended ones first, labelled "branch - version". */
export async function platformOptions(ctx: Ctx): Promise<Option[]> {
  const all = (await platforms(ctx)).filter((p) => p.PlatformArn && p.PlatformStatus === "Ready");
  const recommended = all.filter((p) => p.PlatformLifecycleState === "Recommended");
  const others = all.filter((p) => p.PlatformLifecycleState !== "Recommended");
  const label = (p: PlatformSummary) => `${p.PlatformBranchName ?? p.PlatformCategory ?? p.PlatformArn} - ${p.PlatformVersion ?? ""}${p.PlatformLifecycleState === "Recommended" ? " (Recommended)" : ""}`;
  return [...recommended, ...others].map((p) => ({ value: p.PlatformArn as string, label: label(p) }));
}

export async function roleOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.iam.send(new ListRolesCommand({ Marker: marker, MaxItems: 1000 }));
    for (const role of r.Roles ?? []) if (role.RoleName) out.push({ value: role.RoleName, label: role.RoleName });
    marker = r.IsTruncated ? r.Marker : undefined;
  } while (marker);
  return out;
}

export async function instanceProfileOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.iam.send(new ListInstanceProfilesCommand({ Marker: marker, MaxItems: 1000 }));
    for (const p of r.InstanceProfiles ?? []) if (p.InstanceProfileName) out.push({ value: p.InstanceProfileName, label: p.InstanceProfileName });
    marker = r.IsTruncated ? r.Marker : undefined;
  } while (marker);
  return out;
}

export async function vpcOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.ec2.send(new DescribeVpcsCommand({ NextToken: token }));
    for (const v of r.Vpcs ?? []) {
      if (!v.VpcId) continue;
      const name = v.Tags?.find((t) => t.Key === "Name")?.Value;
      out.push({ value: v.VpcId, label: `${v.VpcId}${name ? ` (${name})` : ""} | ${v.CidrBlock ?? ""}${v.IsDefault ? " | default" : ""}` });
    }
    token = r.NextToken;
  } while (token);
  return out;
}

export async function subnetOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.ec2.send(new DescribeSubnetsCommand({ NextToken: token }));
    for (const s of r.Subnets ?? []) if (s.SubnetId) out.push({ value: s.SubnetId, label: `${s.SubnetId} | ${s.VpcId ?? "?"} | ${s.AvailabilityZone ?? "?"} | ${s.CidrBlock ?? ""}` });
    token = r.NextToken;
  } while (token);
  return out;
}

export async function bucketOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.s3.send(new ListBucketsCommand({ ContinuationToken: token }));
    for (const b of r.Buckets ?? []) if (b.Name) out.push({ value: b.Name, label: b.Name });
    token = r.ContinuationToken;
  } while (token);
  return out;
}

/** Roles by ARN (the lifecycle policy's ServiceRole must be an ARN). */
export async function roleArnOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.iam.send(new ListRolesCommand({ Marker: marker, MaxItems: 1000 }));
    for (const role of r.Roles ?? []) if (role.Arn && role.RoleName) out.push({ value: role.Arn, label: role.RoleName });
    marker = r.IsTruncated ? r.Marker : undefined;
  } while (marker);
  return out;
}
