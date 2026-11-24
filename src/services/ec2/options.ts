/**
 * Shared EC2 reads and live form options (VPCs, subnets, security groups, key pairs ...).
 * Every call goes through ctx.clients, so the IAM simulator checks it.
 */

import {
  DescribeAvailabilityZonesCommand,
  DescribeInstancesCommand,
  DescribeInstanceTypesCommand,
  DescribeKeyPairsCommand,
  DescribeLaunchTemplatesCommand,
  DescribeNetworkInterfacesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVolumesCommand,
  DescribeVpcsCommand,
  type Instance,
  type InstanceTypeInfo,
  type SecurityGroup,
  type Subnet,
  type Vpc,
} from "@aws-sdk/client-ec2";
import { ListInstanceProfilesCommand } from "@aws-sdk/client-iam";
import { DescribeTargetGroupsCommand, type TargetGroup } from "@aws-sdk/client-elastic-load-balancing-v2";
import type { Ctx, Option } from "../../console/types.ts";
import { nameTag } from "./helpers.ts";

export async function allInstances(ctx: Ctx, filters?: { Name: string; Values: string[] }[]): Promise<Instance[]> {
  const out: Instance[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.ec2.send(new DescribeInstancesCommand({ NextToken: token, Filters: filters }));
    for (const res of r.Reservations ?? []) out.push(...(res.Instances ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

export async function oneInstance(ctx: Ctx, id: string): Promise<Instance> {
  const r = await ctx.clients.ec2.send(new DescribeInstancesCommand({ InstanceIds: [id] }));
  const inst = r.Reservations?.[0]?.Instances?.[0];
  if (!inst) throw new Error(`Instance ${id} was not found.`);
  return inst;
}

/** Follows NextToken until the last page. */
async function paged<T>(page: (token: string | undefined) => Promise<{ items: T[] | undefined; next: string | undefined }>): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  do {
    const r = await page(token);
    out.push(...(r.items ?? []));
    token = r.next;
  } while (token);
  return out;
}

export async function allVpcs(ctx: Ctx): Promise<Vpc[]> {
  return paged(async (t) => {
    const r = await ctx.clients.ec2.send(new DescribeVpcsCommand({ NextToken: t }));
    return { items: r.Vpcs, next: r.NextToken };
  });
}

export async function allSubnets(ctx: Ctx, vpcId?: string): Promise<Subnet[]> {
  return paged(async (t) => {
    const r = await ctx.clients.ec2.send(new DescribeSubnetsCommand({ NextToken: t, Filters: vpcId ? [{ Name: "vpc-id", Values: [vpcId] }] : undefined }));
    return { items: r.Subnets, next: r.NextToken };
  });
}

export async function allSecurityGroups(ctx: Ctx): Promise<SecurityGroup[]> {
  const out: SecurityGroup[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.ec2.send(new DescribeSecurityGroupsCommand({ NextToken: token }));
    out.push(...(r.SecurityGroups ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

export async function allInstanceTypes(ctx: Ctx): Promise<InstanceTypeInfo[]> {
  const out: InstanceTypeInfo[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.ec2.send(new DescribeInstanceTypesCommand({ NextToken: token, MaxResults: 100 }));
    out.push(...(r.InstanceTypes ?? []));
    token = r.NextToken;
  } while (token);
  return out.sort((a, b) => String(a.InstanceType).localeCompare(String(b.InstanceType), "en", { numeric: true }));
}

export async function allTargetGroups(ctx: Ctx): Promise<TargetGroup[]> {
  const out: TargetGroup[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.elbv2.send(new DescribeTargetGroupsCommand({ Marker: marker }));
    out.push(...(r.TargetGroups ?? []));
    marker = r.NextMarker;
  } while (marker);
  return out;
}

const labelWithName = (id: string, tags: { Key?: string; Value?: string }[] | undefined, extra?: string) => {
  const n = nameTag(tags);
  return `${id}${n ? ` (${n})` : ""}${extra ? ` - ${extra}` : ""}`;
};

export async function vpcOptions(ctx: Ctx): Promise<Option[]> {
  return (await allVpcs(ctx)).filter((v) => v.VpcId).map((v) => ({ value: v.VpcId as string, label: labelWithName(v.VpcId as string, v.Tags, `${v.CidrBlock ?? ""}${v.IsDefault ? " (default)" : ""}`) }));
}

export async function subnetOptions(ctx: Ctx): Promise<Option[]> {
  return (await allSubnets(ctx))
    .filter((s) => s.SubnetId)
    .map((s) => ({ value: s.SubnetId as string, label: labelWithName(s.SubnetId as string, s.Tags, `${s.AvailabilityZone ?? ""} ${s.CidrBlock ?? ""} ${s.VpcId ?? ""}`) }));
}

export async function securityGroupOptions(ctx: Ctx): Promise<Option[]> {
  return (await allSecurityGroups(ctx)).filter((g) => g.GroupId).map((g) => ({ value: g.GroupId as string, label: `${g.GroupName ?? ""} (${g.GroupId}) - ${g.VpcId ?? ""}` }));
}

export async function keyPairOptions(ctx: Ctx): Promise<Option[]> {
  const r = await ctx.clients.ec2.send(new DescribeKeyPairsCommand({}));
  return (r.KeyPairs ?? []).filter((k) => k.KeyName).map((k) => ({ value: k.KeyName as string, label: `${k.KeyName} (${k.KeyType ?? "rsa"})` }));
}

/** Instances that are not terminated, labelled with name, state and AZ. */
export async function liveInstanceOptions(ctx: Ctx): Promise<Option[]> {
  const list = await allInstances(ctx, [{ Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] }]);
  return list.filter((i) => i.InstanceId).map((i) => ({ value: i.InstanceId as string, label: labelWithName(i.InstanceId as string, i.Tags, `${i.State?.Name ?? ""}, ${i.Placement?.AvailabilityZone ?? ""}`) }));
}

export async function availabilityZoneOptions(ctx: Ctx): Promise<Option[]> {
  const r = await ctx.clients.ec2.send(new DescribeAvailabilityZonesCommand({}));
  return (r.AvailabilityZones ?? []).filter((z) => z.ZoneName).map((z) => ({ value: z.ZoneName as string, label: z.ZoneName as string }));
}

export async function instanceTypeOptions(ctx: Ctx): Promise<Option[]> {
  return (await allInstanceTypes(ctx))
    .filter((t) => t.InstanceType)
    .map((t) => ({
      value: t.InstanceType as string,
      label: `${t.InstanceType} - ${t.VCpuInfo?.DefaultVCpus ?? "?"} vCPU, ${t.MemoryInfo?.SizeInMiB !== undefined ? `${t.MemoryInfo.SizeInMiB / 1024} GiB` : "? GiB"}${t.FreeTierEligible ? " (free tier eligible)" : ""}`,
    }));
}

export async function launchTemplateOptions(ctx: Ctx): Promise<Option[]> {
  const list = await paged(async (t) => {
    const r = await ctx.clients.ec2.send(new DescribeLaunchTemplatesCommand({ NextToken: t }));
    return { items: r.LaunchTemplates, next: r.NextToken };
  });
  return list.filter((t) => t.LaunchTemplateId).map((t) => ({ value: t.LaunchTemplateId as string, label: `${t.LaunchTemplateName ?? ""} (${t.LaunchTemplateId})` }));
}

export async function instanceProfileOptions(ctx: Ctx): Promise<Option[]> {
  const list = await paged(async (t) => {
    const r = await ctx.clients.iam.send(new ListInstanceProfilesCommand({ MaxItems: 1000, Marker: t }));
    return { items: r.InstanceProfiles, next: r.IsTruncated ? r.Marker : undefined };
  });
  return list.filter((p) => p.InstanceProfileName).map((p) => ({ value: p.InstanceProfileName as string, label: `${p.InstanceProfileName}${p.Roles?.[0]?.RoleName ? ` (role ${p.Roles[0].RoleName})` : ""}` }));
}

export async function targetGroupOptions(ctx: Ctx): Promise<Option[]> {
  return (await allTargetGroups(ctx)).filter((t) => t.TargetGroupArn).map((t) => ({ value: t.TargetGroupArn as string, label: `${t.TargetGroupName ?? ""} (${t.Protocol ?? ""}:${t.Port ?? ""}, ${t.TargetType ?? ""}, ${t.VpcId ?? ""})` }));
}

export async function availableVolumeOptions(ctx: Ctx): Promise<Option[]> {
  const list = await paged(async (t) => {
    const r = await ctx.clients.ec2.send(new DescribeVolumesCommand({ NextToken: t }));
    return { items: r.Volumes, next: r.NextToken };
  });
  return list.filter((v) => v.VolumeId).map((v) => ({ value: v.VolumeId as string, label: labelWithName(v.VolumeId as string, v.Tags, `${v.Size ?? "?"} GiB ${v.VolumeType ?? ""}, ${v.State ?? ""}, ${v.AvailabilityZone ?? ""}`) }));
}

export async function networkInterfaceOptions(ctx: Ctx): Promise<Option[]> {
  const list = await paged(async (t) => {
    const r = await ctx.clients.ec2.send(new DescribeNetworkInterfacesCommand({ NextToken: t }));
    return { items: r.NetworkInterfaces, next: r.NextToken };
  });
  return list.filter((n) => n.NetworkInterfaceId).map((n) => ({ value: n.NetworkInterfaceId as string, label: `${n.NetworkInterfaceId} - ${n.PrivateIpAddress ?? ""} ${n.Description ? `(${n.Description})` : ""}` }));
}

/** EC2 tag specification for create calls; undefined when there are no tags. */
export function tagSpec(resourceType: string, tags: { Key: string; Value: string }[]) {
  return tags.length ? [{ ResourceType: resourceType as never, Tags: tags }] : undefined;
}
