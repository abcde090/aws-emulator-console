/**
 * Shared ECS loaders and live form options. Every call goes through ctx.clients, so the
 * IAM simulator checks each ListClusters, DescribeServices, ListTasks and so on.
 */

import { fieldTags, tagDiff, tagDiffMessage } from "../../console/tags.ts";
import {
  DescribeClustersCommand,
  ListClustersCommand,
  ListTagsForResourceCommand,
  ListTaskDefinitionsCommand,
  TagResourceCommand,
  UntagResourceCommand,
  type Cluster,
} from "@aws-sdk/client-ecs";
import { DescribeSecurityGroupsCommand, DescribeSubnetsCommand } from "@aws-sdk/client-ec2";
import { DescribeLoadBalancersCommand, DescribeTargetGroupsCommand, type TargetGroup } from "@aws-sdk/client-elastic-load-balancing-v2";
import { ListRolesCommand } from "@aws-sdk/client-iam";
import type { ActionDef, Ctx, FieldDef, Option, Tag } from "../../console/types.ts";
import { arnName, chunk, taskDefinitionLabel } from "./helpers.ts";

export async function listClusterArns(ctx: Ctx): Promise<string[]> {
  const arns: string[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.ecs.send(new ListClustersCommand({ nextToken: token, maxResults: 100 }));
    arns.push(...(r.clusterArns ?? []));
    token = r.nextToken;
  } while (token);
  return arns;
}

export async function describeClusters(ctx: Ctx, names: string[]): Promise<Cluster[]> {
  const out: Cluster[] = [];
  for (const part of chunk(names, 100)) {
    const r = await ctx.clients.ecs.send(new DescribeClustersCommand({ clusters: part, include: ["ATTACHMENTS", "CONFIGURATIONS", "SETTINGS", "STATISTICS", "TAGS"] }));
    out.push(...(r.clusters ?? []));
  }
  return out;
}

export async function clusterNames(ctx: Ctx): Promise<string[]> {
  return (await listClusterArns(ctx)).map(arnName);
}

/** Task definition ARNs with the given status, newest revision first within a family. */
export async function listTaskDefinitionArns(ctx: Ctx, status: "ACTIVE" | "INACTIVE", familyPrefix?: string): Promise<string[]> {
  const arns: string[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.ecs.send(new ListTaskDefinitionsCommand({ status, familyPrefix, sort: "DESC", nextToken: token, maxResults: 100 }));
    arns.push(...(r.taskDefinitionArns ?? []));
    token = r.nextToken;
  } while (token);
  return arns;
}

// ---- Live options ----

export async function clusterOptions(ctx: Ctx): Promise<Option[]> {
  return (await clusterNames(ctx)).sort().map((n) => ({ value: n, label: n }));
}

export async function taskDefinitionOptions(ctx: Ctx): Promise<Option[]> {
  return (await listTaskDefinitionArns(ctx, "ACTIVE")).map((arn) => ({ value: taskDefinitionLabel(arn), label: taskDefinitionLabel(arn) }));
}

export async function subnetOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.ec2.send(new DescribeSubnetsCommand({ NextToken: token }));
    for (const s of r.Subnets ?? []) {
      if (!s.SubnetId) continue;
      const name = s.Tags?.find((t) => t.Key === "Name")?.Value;
      out.push({ value: s.SubnetId, label: `${s.SubnetId}${name ? ` (${name})` : ""} - ${s.VpcId ?? "?"} - ${s.AvailabilityZone ?? "?"} - ${s.CidrBlock ?? ""}` });
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
    for (const g of r.SecurityGroups ?? []) if (g.GroupId) out.push({ value: g.GroupId, label: `${g.GroupId} (${g.GroupName ?? ""}) - ${g.VpcId ?? "?"}` });
    token = r.NextToken;
  } while (token);
  return out;
}

/** Only target groups attached to a load balancer: ECS rejects the others. */
export async function targetGroupOptions(ctx: Ctx): Promise<Option[]> {
  const tgs: TargetGroup[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.elbv2.send(new DescribeTargetGroupsCommand({ Marker: marker }));
    tgs.push(...(r.TargetGroups ?? []));
    marker = r.NextMarker;
  } while (marker);
  const lbName = new Map<string, string>();
  let lbMarker: string | undefined;
  do {
    const r = await ctx.clients.elbv2.send(new DescribeLoadBalancersCommand({ Marker: lbMarker }));
    for (const l of r.LoadBalancers ?? []) lbName.set(l.LoadBalancerArn ?? "", l.LoadBalancerName ?? "");
    lbMarker = r.NextMarker;
  } while (lbMarker);
  return tgs
    .filter((t) => t.TargetGroupArn && (t.LoadBalancerArns ?? []).length > 0)
    .map((t) => ({
      value: t.TargetGroupArn as string,
      label: `${t.TargetGroupName ?? ""} (${t.Protocol ?? ""}:${t.Port ?? ""}, ${t.TargetType ?? ""}) - ${(t.LoadBalancerArns ?? []).map((a) => lbName.get(a) ?? a).join(", ")}`,
    }));
}

export async function roleOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.iam.send(new ListRolesCommand({ Marker: marker, MaxItems: 1000 }));
    for (const role of r.Roles ?? []) if (role.Arn) out.push({ value: role.Arn, label: role.RoleName ?? role.Arn });
    marker = r.IsTruncated ? r.Marker : undefined;
  } while (marker);
  return out;
}

export const NETWORK_FIELDS = (section: string): FieldDef[] => [
  {
    name: "subnets", label: "Subnets", kind: "multiselect", options: subnetOptions, section,
    help: "Fargate tasks (awsvpc network mode) need at least one subnet. Choose subnets in one VPC. Hold Cmd or Ctrl to select several.",
  },
  {
    name: "securityGroups", label: "Security groups", kind: "multiselect", options: securityGroupOptions, section,
    help: "Leave empty to use the VPC's default security group. Must be in the same VPC as the subnets.",
  },
  { name: "assignPublicIp", label: "Public IP", kind: "checkbox", default: true, section, help: "Turned on: each task's elastic network interface gets a public IPv4 address." },
];

export function tagsToEcs(tags: unknown): { key: string; value: string }[] {
  return Array.isArray(tags) ? (tags as Tag[]).map((t) => ({ key: t.Key, value: t.Value })) : [];
}

async function currentTags(ctx: Ctx, arn: string): Promise<Tag[]> {
  const r = await ctx.clients.ecs.send(new ListTagsForResourceCommand({ resourceArn: arn }));
  return (r.tags ?? []).map((t) => ({ Key: t.key ?? "", Value: t.value ?? "" }));
}

/** "Manage tags" for any ECS resource: opens with the current tags and applies only the difference. */
export function tagActions(arnOf: (ctx: Ctx, id: string) => Promise<string>): ActionDef[] {
  return [
    {
      id: "tags",
      label: "Manage tags",
      fields: [{ name: "tags", label: "Tags", kind: "tags", help: "Remove a row to delete that tag." }],
      async initialValues(ctx, id) {
        return { tags: await currentTags(ctx, await arnOf(ctx, id)) };
      },
      async run(ctx, id, v) {
        const arn = await arnOf(ctx, id);
        const diff = tagDiff(await currentTags(ctx, arn), fieldTags(v.tags));
        if (diff.remove.length) await ctx.clients.ecs.send(new UntagResourceCommand({ resourceArn: arn, tagKeys: diff.remove }));
        if (diff.set.length) await ctx.clients.ecs.send(new TagResourceCommand({ resourceArn: arn, tags: tagsToEcs(diff.set) }));
        return { message: tagDiffMessage(diff) };
      },
    },
  ];
}

/** Builds awsvpcConfiguration from the shared networking fields; null when no subnet is chosen. */
export function awsvpcConfig(v: { subnets?: unknown; securityGroups?: unknown; assignPublicIp?: unknown }) {
  const subnets = Array.isArray(v.subnets) ? v.subnets.filter((s): s is string => typeof s === "string") : [];
  if (subnets.length === 0) return null;
  const securityGroups = Array.isArray(v.securityGroups) ? v.securityGroups.filter((s): s is string => typeof s === "string") : [];
  return {
    awsvpcConfiguration: {
      subnets,
      securityGroups: securityGroups.length ? securityGroups : undefined,
      assignPublicIp: v.assignPublicIp === true ? ("ENABLED" as const) : ("DISABLED" as const),
    },
  };
}
