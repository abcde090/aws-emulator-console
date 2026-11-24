/**
 * Shared EC2 plumbing for the VPC console: paginated describes, live option loaders for
 * forms, and the tag actions every VPC resource has. All calls use ctx.clients.ec2.
 */

import { fieldTags, tagDiff, tagDiffMessage } from "../../console/tags.ts";
import {
  CreateTagsCommand,
  DeleteTagsCommand,
  DescribeAddressesCommand,
  DescribeAvailabilityZonesCommand,
  DescribeCustomerGatewaysCommand,
  DescribeDhcpOptionsCommand,
  DescribeEgressOnlyInternetGatewaysCommand,
  DescribeInstancesCommand,
  DescribeInternetGatewaysCommand,
  DescribeNatGatewaysCommand,
  DescribeNetworkAclsCommand,
  DescribeNetworkInterfacesCommand,
  DescribeRouteTablesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeTagsCommand,
  DescribeTransitGatewayAttachmentsCommand,
  DescribeTransitGatewaysCommand,
  DescribeVpcPeeringConnectionsCommand,
  DescribeVpcsCommand,
  DescribeVpnGatewaysCommand,
  type Filter,
  type Instance,
  type ResourceType,
  type RouteTable,
  type Subnet,
  type TagSpecification,
  type Vpc,
} from "@aws-sdk/client-ec2";
import type { ActionDef, Ctx, Option } from "../../console/types.ts";
import { nameOf, tagRows, type Ec2Tag, type Tag } from "./helpers.ts";

/** Follows NextToken until the last page. */
export async function collect<T>(page: (token: string | undefined) => Promise<{ items: T[] | undefined; next: string | undefined }>): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  let guard = 0;
  do {
    const r = await page(token);
    out.push(...(r.items ?? []));
    token = r.next;
    guard++;
  } while (token && guard < 200);
  return out;
}

export const byVpc = (vpcId: string): Filter[] => [{ Name: "vpc-id", Values: [vpcId] }];

export function tagSpec(type: ResourceType, tags: Tag[]): TagSpecification[] | undefined {
  return tags.length ? [{ ResourceType: type, Tags: tags }] : undefined;
}

export const label = (id: string | undefined, tags: Ec2Tag[] | undefined, extra?: string): string => {
  const n = nameOf(tags);
  return [id ?? "", n ? `(${n})` : "", extra ?? ""].filter(Boolean).join(" ");
};

// ---- describes ----

export const describeVpcs = (ctx: Ctx, filters?: Filter[], ids?: string[]): Promise<Vpc[]> =>
  collect(async (t) => {
    const r = await ctx.clients.ec2.send(new DescribeVpcsCommand({ Filters: filters, VpcIds: ids, NextToken: t }));
    return { items: r.Vpcs, next: r.NextToken };
  });

export const describeSubnets = (ctx: Ctx, filters?: Filter[], ids?: string[]): Promise<Subnet[]> =>
  collect(async (t) => {
    const r = await ctx.clients.ec2.send(new DescribeSubnetsCommand({ Filters: filters, SubnetIds: ids, NextToken: t }));
    return { items: r.Subnets, next: r.NextToken };
  });

export const describeRouteTables = (ctx: Ctx, filters?: Filter[], ids?: string[]): Promise<RouteTable[]> =>
  collect(async (t) => {
    const r = await ctx.clients.ec2.send(new DescribeRouteTablesCommand({ Filters: filters, RouteTableIds: ids, NextToken: t }));
    return { items: r.RouteTables, next: r.NextToken };
  });

export const describeAcls = (ctx: Ctx, filters?: Filter[], ids?: string[]) =>
  collect(async (t) => {
    const r = await ctx.clients.ec2.send(new DescribeNetworkAclsCommand({ Filters: filters, NetworkAclIds: ids, NextToken: t }));
    return { items: r.NetworkAcls, next: r.NextToken };
  });

export const describeSecurityGroups = (ctx: Ctx, filters?: Filter[], ids?: string[]) =>
  collect(async (t) => {
    const r = await ctx.clients.ec2.send(new DescribeSecurityGroupsCommand({ Filters: filters, GroupIds: ids, NextToken: t }));
    return { items: r.SecurityGroups, next: r.NextToken };
  });

export const describeIgws = (ctx: Ctx, filters?: Filter[], ids?: string[]) =>
  collect(async (t) => {
    const r = await ctx.clients.ec2.send(new DescribeInternetGatewaysCommand({ Filters: filters, InternetGatewayIds: ids, NextToken: t }));
    return { items: r.InternetGateways, next: r.NextToken };
  });

export const describeEgressIgws = (ctx: Ctx, ids?: string[]) =>
  collect(async (t) => {
    const r = await ctx.clients.ec2.send(new DescribeEgressOnlyInternetGatewaysCommand({ EgressOnlyInternetGatewayIds: ids, NextToken: t }));
    return { items: r.EgressOnlyInternetGateways, next: r.NextToken };
  });

export const describeNats = (ctx: Ctx, filters?: Filter[], ids?: string[]) =>
  collect(async (t) => {
    const r = await ctx.clients.ec2.send(new DescribeNatGatewaysCommand({ Filter: filters, NatGatewayIds: ids, NextToken: t }));
    return { items: r.NatGateways, next: r.NextToken };
  });

export const describePeerings = (ctx: Ctx, filters?: Filter[], ids?: string[]) =>
  collect(async (t) => {
    const r = await ctx.clients.ec2.send(new DescribeVpcPeeringConnectionsCommand({ Filters: filters, VpcPeeringConnectionIds: ids, NextToken: t }));
    return { items: r.VpcPeeringConnections, next: r.NextToken };
  });

export const describeTgws = (ctx: Ctx, ids?: string[]) =>
  collect(async (t) => {
    const r = await ctx.clients.ec2.send(new DescribeTransitGatewaysCommand({ TransitGatewayIds: ids, NextToken: t }));
    return { items: r.TransitGateways, next: r.NextToken };
  });

export const describeTgwAttachments = (ctx: Ctx, filters?: Filter[], ids?: string[]) =>
  collect(async (t) => {
    const r = await ctx.clients.ec2.send(new DescribeTransitGatewayAttachmentsCommand({ Filters: filters, TransitGatewayAttachmentIds: ids, NextToken: t }));
    return { items: r.TransitGatewayAttachments, next: r.NextToken };
  });

export const describeEnis = (ctx: Ctx, filters?: Filter[]) =>
  collect(async (t) => {
    const r = await ctx.clients.ec2.send(new DescribeNetworkInterfacesCommand({ Filters: filters, NextToken: t }));
    return { items: r.NetworkInterfaces, next: r.NextToken };
  });

export async function describeInstances(ctx: Ctx, filters?: Filter[]): Promise<Instance[]> {
  const reservations = await collect(async (t) => {
    const r = await ctx.clients.ec2.send(new DescribeInstancesCommand({ Filters: filters, NextToken: t }));
    return { items: r.Reservations, next: r.NextToken };
  });
  return reservations.flatMap((r) => r.Instances ?? []);
}

export async function describeAddresses(ctx: Ctx, ids?: string[]) {
  const r = await ctx.clients.ec2.send(new DescribeAddressesCommand({ AllocationIds: ids }));
  return r.Addresses ?? [];
}

export const describeDhcp = (ctx: Ctx, ids?: string[]) =>
  collect(async (t) => {
    const r = await ctx.clients.ec2.send(new DescribeDhcpOptionsCommand({ DhcpOptionsIds: ids, NextToken: t }));
    return { items: r.DhcpOptions, next: r.NextToken };
  });

export async function describeCgws(ctx: Ctx, ids?: string[]) {
  return (await ctx.clients.ec2.send(new DescribeCustomerGatewaysCommand({ CustomerGatewayIds: ids }))).CustomerGateways ?? [];
}

export async function describeVgws(ctx: Ctx, ids?: string[]) {
  return (await ctx.clients.ec2.send(new DescribeVpnGatewaysCommand({ VpnGatewayIds: ids }))).VpnGateways ?? [];
}

/** First item or a clear "not found" error, as the console shows for a stale link. */
export function one<T>(items: T[], what: string, id: string): T {
  const first = items[0];
  if (!first) throw new Error(`${what} ${id} was not found.`);
  return first;
}

export async function availabilityZones(ctx: Ctx): Promise<{ name: string; id: string }[]> {
  const r = await ctx.clients.ec2.send(new DescribeAvailabilityZonesCommand({}));
  return (r.AvailabilityZones ?? [])
    .filter((z) => z.ZoneName && (z.ZoneType ?? "availability-zone") === "availability-zone")
    .map((z) => ({ name: z.ZoneName as string, id: z.ZoneId ?? "" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---- option loaders ----

export async function vpcOptions(ctx: Ctx): Promise<Option[]> {
  return (await describeVpcs(ctx)).filter((v) => v.VpcId).map((v) => ({ value: v.VpcId as string, label: label(v.VpcId, v.Tags, v.CidrBlock) }));
}

export async function subnetOptions(ctx: Ctx): Promise<Option[]> {
  return (await describeSubnets(ctx))
    .filter((s) => s.SubnetId)
    .map((s) => ({ value: s.SubnetId as string, label: `${label(s.SubnetId, s.Tags)} | ${s.CidrBlock ?? ""} | ${s.AvailabilityZone ?? ""} | ${s.VpcId ?? ""}` }));
}

export async function routeTableOptions(ctx: Ctx): Promise<Option[]> {
  return (await describeRouteTables(ctx)).filter((r) => r.RouteTableId).map((r) => ({ value: r.RouteTableId as string, label: `${label(r.RouteTableId, r.Tags)} | ${r.VpcId ?? ""}` }));
}

export async function aclOptions(ctx: Ctx): Promise<Option[]> {
  return (await describeAcls(ctx)).filter((a) => a.NetworkAclId).map((a) => ({ value: a.NetworkAclId as string, label: `${label(a.NetworkAclId, a.Tags)} | ${a.VpcId ?? ""}` }));
}

export async function securityGroupOptions(ctx: Ctx): Promise<Option[]> {
  return (await describeSecurityGroups(ctx)).filter((g) => g.GroupId).map((g) => ({ value: g.GroupId as string, label: `${g.GroupId} (${g.GroupName ?? ""}) | ${g.VpcId ?? ""}` }));
}

export async function tgwOptions(ctx: Ctx): Promise<Option[]> {
  return (await describeTgws(ctx))
    .filter((t) => t.TransitGatewayId && t.State !== "deleted" && t.State !== "deleting")
    .map((t) => ({ value: t.TransitGatewayId as string, label: label(t.TransitGatewayId, t.Tags) }));
}

export async function tgwAttachmentOptions(ctx: Ctx): Promise<Option[]> {
  return (await describeTgwAttachments(ctx))
    .filter((a) => a.TransitGatewayAttachmentId && a.State !== "deleted" && a.State !== "deleting")
    .map((a) => ({ value: a.TransitGatewayAttachmentId as string, label: `${label(a.TransitGatewayAttachmentId, a.Tags)} | ${a.ResourceType ?? ""} ${a.ResourceId ?? ""} | ${a.TransitGatewayId ?? ""}` }));
}

export async function eniOptions(ctx: Ctx): Promise<Option[]> {
  return (await describeEnis(ctx)).filter((e) => e.NetworkInterfaceId).map((e) => ({ value: e.NetworkInterfaceId as string, label: `${e.NetworkInterfaceId} | ${e.PrivateIpAddress ?? ""} | ${e.Description ?? e.InterfaceType ?? ""}` }));
}

export async function instanceOptions(ctx: Ctx): Promise<Option[]> {
  return (await describeInstances(ctx))
    .filter((i) => i.InstanceId && i.State?.Name !== "terminated")
    .map((i) => ({ value: i.InstanceId as string, label: `${label(i.InstanceId, i.Tags)} | ${i.State?.Name ?? ""}` }));
}

/** Every resource a route can point at, labelled by kind as in the console's Target menu. */
export async function routeTargetOptions(ctx: Ctx): Promise<Option[]> {
  const [igws, eigws, nats, tgws, pcxs, vgws] = await Promise.all([
    describeIgws(ctx),
    describeEgressIgws(ctx),
    describeNats(ctx),
    describeTgws(ctx),
    describePeerings(ctx),
    describeVgws(ctx),
  ]);
  return [
    ...igws.filter((g) => g.InternetGatewayId).map((g) => ({ value: g.InternetGatewayId as string, label: `Internet Gateway: ${label(g.InternetGatewayId, g.Tags, g.Attachments?.[0]?.VpcId)}` })),
    ...eigws.filter((g) => g.EgressOnlyInternetGatewayId).map((g) => ({ value: g.EgressOnlyInternetGatewayId as string, label: `Egress Only Internet Gateway: ${label(g.EgressOnlyInternetGatewayId, g.Tags)}` })),
    ...nats.filter((n) => n.NatGatewayId && n.State !== "deleted" && n.State !== "deleting").map((n) => ({ value: n.NatGatewayId as string, label: `NAT Gateway: ${label(n.NatGatewayId, n.Tags, n.SubnetId)}` })),
    ...tgws.filter((t) => t.TransitGatewayId && t.State !== "deleted").map((t) => ({ value: t.TransitGatewayId as string, label: `Transit Gateway: ${label(t.TransitGatewayId, t.Tags)}` })),
    ...pcxs.filter((p) => p.VpcPeeringConnectionId && p.Status?.Code === "active").map((p) => ({ value: p.VpcPeeringConnectionId as string, label: `Peering Connection: ${label(p.VpcPeeringConnectionId, p.Tags)}` })),
    ...vgws.filter((g) => g.VpnGatewayId && g.State === "available").map((g) => ({ value: g.VpnGatewayId as string, label: `Virtual Private Gateway: ${label(g.VpnGatewayId, g.Tags)}` })),
  ];
}

// ---- tags ----

export async function currentTags(ctx: Ctx, resourceId: string): Promise<Tag[]> {
  const r = await ctx.clients.ec2.send(new DescribeTagsCommand({ Filters: [{ Name: "resource-id", Values: [resourceId] }] }));
  return tagRows(r.Tags);
}

export const TAG_COLUMNS = [
  { key: "Key", label: "Key", kind: "text" as const },
  { key: "Value", label: "Value", kind: "text" as const },
];

export function tagsTab(tags: Ec2Tag[] | undefined) {
  return { id: "tags", label: "Tags", kind: "table" as const, columns: TAG_COLUMNS, data: tagRows(tags), emptyText: "No tags." };
}

/** "Manage tags": prefilled with the current tags; saves only the difference (CreateTags / DeleteTags). */
export const tagActions: ActionDef[] = [
  {
    id: "manage-tags",
    label: "Manage tags",
    fields: [{ name: "tags", label: "Tags", kind: "tags", help: "The resource's tags. Edit, add or remove keys; the Name tag is the resource's name." }],
    initialValues: async (ctx, id) => ({ tags: await currentTags(ctx, id) }),
    async run(ctx, id, v) {
      const diff = tagDiff(await currentTags(ctx, id), fieldTags(v.tags));
      if (diff.remove.length) await ctx.clients.ec2.send(new DeleteTagsCommand({ Resources: [id], Tags: diff.remove.map((Key) => ({ Key })) }));
      if (diff.set.length) await ctx.clients.ec2.send(new CreateTagsCommand({ Resources: [id], Tags: diff.set }));
      return { message: tagDiffMessage(diff) };
    },
  },
];

/** A value from a list row or a detail summary, whichever key it has (for availableFor). */
export function rowValue(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (row[k] !== undefined && row[k] !== null) return row[k];
  return undefined;
}

/** availableFor helper: true when the row's status is one of `states`, or unknown. */
export const statusIn = (states: string[], ...keys: string[]) => (row: Record<string, unknown>): boolean => {
  const v = rowValue(row, ...keys);
  return typeof v !== "string" || states.includes(v);
};

export const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);
export const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
export const numOrUndef = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
