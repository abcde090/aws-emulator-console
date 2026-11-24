/**
 * Live option loaders and "may not be set" reads shared by the EFS, Backup, Athena, Glue
 * and Kinesis definitions. Every call uses the permission-checked clients on ctx.
 */

import { DescribeAvailabilityZonesCommand, DescribeSecurityGroupsCommand, DescribeSubnetsCommand } from "@aws-sdk/client-ec2";
import { ListRolesCommand } from "@aws-sdk/client-iam";
import { ListBucketsCommand } from "@aws-sdk/client-s3";
import type { Ctx, Option } from "../../console/types.ts";
import { nameTag } from "../../console/tags.ts";

/** IAM roles; roles whose trust policy names the service principal are listed first. */
export async function roleOptions(ctx: Ctx, servicePrincipal: string): Promise<Option[]> {
  const roles: { arn: string; name: string; trusts: boolean }[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.iam.send(new ListRolesCommand({ Marker: marker }));
    for (const role of r.Roles ?? []) {
      if (!role.Arn || !role.RoleName) continue;
      const doc = role.AssumeRolePolicyDocument ? safeDecode(role.AssumeRolePolicyDocument) : "";
      roles.push({ arn: role.Arn, name: role.RoleName, trusts: doc.includes(servicePrincipal) });
    }
    marker = r.IsTruncated ? r.Marker : undefined;
  } while (marker);
  roles.sort((a, b) => Number(b.trusts) - Number(a.trusts) || a.name.localeCompare(b.name));
  return roles.map((r) => ({ value: r.arn, label: r.trusts ? `${r.name} (trusts ${servicePrincipal})` : r.name }));
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export async function subnetOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.ec2.send(new DescribeSubnetsCommand({ NextToken: token }));
    for (const s of r.Subnets ?? []) {
      if (s.SubnetId) out.push({ value: s.SubnetId, label: `${s.SubnetId} (${[nameTag(s.Tags), s.AvailabilityZone, s.VpcId, s.CidrBlock].filter(Boolean).join(", ")})` });
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
    for (const g of r.SecurityGroups ?? []) if (g.GroupId) out.push({ value: g.GroupId, label: `${g.GroupId} (${g.GroupName ?? ""}, ${g.VpcId ?? ""})` });
    token = r.NextToken;
  } while (token);
  return out;
}

export async function availabilityZoneOptions(ctx: Ctx): Promise<Option[]> {
  const r = await ctx.clients.ec2.send(new DescribeAvailabilityZonesCommand({}));
  return (r.AvailabilityZones ?? []).filter((z) => z.ZoneName).map((z) => ({ value: z.ZoneName as string, label: z.ZoneName as string }));
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
