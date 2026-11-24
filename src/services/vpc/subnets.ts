/** Subnets: create in a VPC and AZ, auto-assign public IPv4, route table and network ACL association. */

import { secondaryOr, unavailableText } from "../../console/secondary.ts";
import {
  AssociateRouteTableCommand,
  CreateSubnetCommand,
  DeleteSubnetCommand,
  DescribeFlowLogsCommand,
  type FlowLog,
  ModifySubnetAttributeCommand,
  ReplaceNetworkAclAssociationCommand,
  ReplaceRouteTableAssociationCommand,
} from "@aws-sdk/client-ec2";
import type { Ctx, Option, ResourceDef } from "../../console/types.ts";
import { aclOptions, availabilityZones, byVpc, describeAcls, describeRouteTables, describeSubnets, one, routeTableOptions, tagActions, tagsTab, tagSpec, text, vpcOptions } from "./ec2.ts";
import { nameOf, portRangeLabel, protocolLabel, routeDestination, routeTarget, withName } from "./helpers.ts";

async function azOptions(ctx: Ctx): Promise<Option[]> {
  return [...(await availabilityZones(ctx)).map((z) => ({ value: z.name, label: `${z.name} (${z.id})` }))];
}

/** The route table a subnet uses: its explicit association, else the VPC's main table. */
async function subnetRouting(ctx: Ctx, subnetId: string, vpcId: string) {
  const tables = await describeRouteTables(ctx, byVpc(vpcId));
  const explicit = tables.find((t) => t.Associations?.some((a) => a.SubnetId === subnetId));
  const main = tables.find((t) => t.Associations?.some((a) => a.Main));
  return { table: explicit ?? main, explicit: Boolean(explicit), association: explicit?.Associations?.find((a) => a.SubnetId === subnetId)?.RouteTableAssociationId };
}

/** The subnet's VPC, for pickers scoped to it; null when there is no subnet id. */
async function subnetVpc(ctx: Ctx, subnetId: string | undefined): Promise<string | null> {
  if (!subnetId) return null;
  return one(await describeSubnets(ctx, undefined, [subnetId]), "Subnet", subnetId).VpcId ?? null;
}

/** Route tables in the subnet's VPC (all route tables when opened without a subnet). */
async function subnetRouteTableOptions(ctx: Ctx, subnetId?: string): Promise<Option[]> {
  const vpcId = await subnetVpc(ctx, subnetId);
  if (!vpcId) return routeTableOptions(ctx);
  return (await describeRouteTables(ctx, byVpc(vpcId))).filter((r) => r.RouteTableId).map((r) => ({ value: r.RouteTableId as string, label: `${r.RouteTableId}${nameOf(r.Tags) ? ` (${nameOf(r.Tags)})` : ""}${r.Associations?.some((a) => a.Main) ? " - main" : ""}` }));
}

/** Network ACLs in the subnet's VPC. */
async function subnetAclOptions(ctx: Ctx, subnetId?: string): Promise<Option[]> {
  const vpcId = await subnetVpc(ctx, subnetId);
  if (!vpcId) return aclOptions(ctx);
  return (await describeAcls(ctx, byVpc(vpcId))).filter((a) => a.NetworkAclId).map((a) => ({ value: a.NetworkAclId as string, label: `${a.NetworkAclId}${nameOf(a.Tags) ? ` (${nameOf(a.Tags)})` : ""}${a.IsDefault ? " - default" : ""}` }));
}

export const subnets: ResourceDef = {
  id: "subnets",
  name: "Subnets",
  singular: "subnet",
  idField: "subnetId",
  description: "A subnet is a range of IP addresses in your VPC, in one Availability Zone.",
  emptyText: "You don't have any subnets in this Region.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "subnetId", label: "Subnet ID", kind: "link" },
    { key: "state", label: "State", kind: "status" },
    { key: "vpcId", label: "VPC", kind: "text" },
    { key: "cidr", label: "IPv4 CIDR", kind: "text" },
    { key: "ipv6", label: "IPv6 CIDR", kind: "text" },
    { key: "available", label: "Available IPv4 addresses", kind: "count" },
    { key: "az", label: "Availability Zone", kind: "text" },
    { key: "azId", label: "Availability Zone ID", kind: "text" },
    { key: "routeTable", label: "Route table", kind: "text" },
    { key: "acl", label: "Network ACL", kind: "text" },
    { key: "isDefault", label: "Default subnet", kind: "boolean" },
    { key: "publicIp", label: "Auto-assign public IPv4 address", kind: "boolean" },
  ],
  async list(ctx) {
    const [list, tablesR, aclsR] = await Promise.all([describeSubnets(ctx), secondaryOr(describeRouteTables(ctx), []), secondaryOr(describeAcls(ctx), [])]);
    const [tables, acls] = [tablesR.value, aclsR.value];
    return list.map((s) => {
      const explicit = tables.find((t) => t.Associations?.some((a) => a.SubnetId === s.SubnetId));
      const main = tables.find((t) => t.VpcId === s.VpcId && t.Associations?.some((a) => a.Main));
      return {
        name: nameOf(s.Tags),
        subnetId: s.SubnetId ?? "",
        state: s.State ?? null,
        vpcId: s.VpcId ?? null,
        cidr: s.CidrBlock ?? null,
        ipv6: s.Ipv6CidrBlockAssociationSet?.map((a) => a.Ipv6CidrBlock).filter(Boolean).join(", ") || null,
        available: s.AvailableIpAddressCount ?? null,
        az: s.AvailabilityZone ?? null,
        azId: s.AvailabilityZoneId ?? null,
        routeTable: tablesR.error ? "Unavailable" : (explicit ?? main)?.RouteTableId ?? null,
        acl: aclsR.error ? "Unavailable" : acls.find((a) => a.Associations?.some((x) => x.SubnetId === s.SubnetId))?.NetworkAclId ?? null,
        isDefault: s.DefaultForAz ?? false,
        publicIp: s.MapPublicIpOnLaunch ?? false,
      };
    });
  },
  async get(ctx, id) {
    const s = one(await describeSubnets(ctx, undefined, [id]), "Subnet", id);
    const [routingR, aclsR, flowR] = await Promise.all([
      secondaryOr(subnetRouting(ctx, id, s.VpcId ?? ""), { table: undefined, explicit: false, association: undefined }),
      secondaryOr(describeAcls(ctx, [{ Name: "association.subnet-id", Values: [id] }]), []),
      secondaryOr(ctx.clients.ec2.send(new DescribeFlowLogsCommand({ Filter: [{ Name: "resource-id", Values: [id] }] })), { FlowLogs: [] } as { FlowLogs?: FlowLog[] }),
    ]);
    const [routing, acls, flow] = [routingR.value, aclsR.value, flowR.value];
    const acl = acls[0];
    return {
      summary: {
        "Subnet ID": id,
        Name: nameOf(s.Tags),
        "Subnet ARN": s.SubnetArn ?? null,
        State: s.State ?? null,
        "IPv4 CIDR": s.CidrBlock ?? null,
        "Available IPv4 addresses": s.AvailableIpAddressCount ?? null,
        "IPv6 CIDR": s.Ipv6CidrBlockAssociationSet?.map((a) => a.Ipv6CidrBlock).filter(Boolean).join(", ") || null,
        "Availability Zone": s.AvailabilityZone ?? null,
        "Availability Zone ID": s.AvailabilityZoneId ?? null,
        VPC: s.VpcId ?? null,
        "Route table": routingR.error ? `Unavailable: ${routingR.error}` : routing.table ? `${routing.table.RouteTableId}${routing.explicit ? "" : " (main)"}` : null,
        "Network ACL": aclsR.error ? `Unavailable: ${aclsR.error}` : acl?.NetworkAclId ?? null,
        "Default subnet": s.DefaultForAz ? "Yes" : "No",
        "Auto-assign public IPv4 address": s.MapPublicIpOnLaunch ? "Yes" : "No",
        "Auto-assign IPv6 address": s.AssignIpv6AddressOnCreation ? "Yes" : "No",
        "Owner ID": s.OwnerId ?? null,
      },
      tabs: [
        {
          id: "route-table",
          label: "Route table",
          kind: "table",
          description: routing.table ? `Routes of ${routing.table.RouteTableId}${routing.explicit ? "" : ", the VPC's main route table (no explicit association)"}.` : undefined,
          columns: [
            { key: "destination", label: "Destination", kind: "text" },
            { key: "target", label: "Target", kind: "text" },
            { key: "state", label: "Status", kind: "status" },
          ],
          data: (routing.table?.Routes ?? []).map((r) => ({ destination: routeDestination(r), target: routeTarget(r), state: r.State ?? null })),
          emptyText: unavailableText(routingR, "No route table."),
        },
        {
          id: "acl",
          label: "Network ACL",
          kind: "table",
          description: acl ? `Rules of ${acl.NetworkAclId}, evaluated in rule number order.` : undefined,
          columns: [
            { key: "direction", label: "Direction", kind: "text" },
            { key: "rule", label: "Rule number", kind: "text" },
            { key: "protocol", label: "Protocol", kind: "text" },
            { key: "ports", label: "Port range", kind: "text" },
            { key: "cidr", label: "Source / Destination", kind: "text" },
            { key: "action", label: "Allow/Deny", kind: "text" },
          ],
          data: (acl?.Entries ?? []).map((e) => ({
            direction: e.Egress ? "Outbound" : "Inbound",
            rule: e.RuleNumber === 32767 ? "*" : String(e.RuleNumber ?? ""),
            protocol: protocolLabel(e.Protocol),
            ports: portRangeLabel(e.Protocol === "-1" ? "-1" : e.Protocol, e.PortRange?.From, e.PortRange?.To),
            cidr: e.CidrBlock ?? e.Ipv6CidrBlock ?? null,
            action: e.RuleAction === "allow" ? "Allow" : "Deny",
          })),
          emptyText: unavailableText(aclsR, "No network ACL."),
        },
        {
          id: "flow-logs",
          label: "Flow logs",
          kind: "table",
          columns: [
            { key: "FlowLogId", label: "Flow log ID", kind: "text" },
            { key: "TrafficType", label: "Filter", kind: "text" },
            { key: "LogDestinationType", label: "Destination type", kind: "text" },
            { key: "FlowLogStatus", label: "Status", kind: "status" },
          ],
          data: flow.FlowLogs ?? [],
          emptyText: unavailableText(flowR, "No flow logs."),
        },
        tagsTab(s.Tags),
      ],
    };
  },
  create: {
    title: "Create subnet",
    description: "Creates a subnet with CreateSubnet.",
    fields: [
      { name: "vpcId", label: "VPC ID", kind: "select", required: true, options: vpcOptions, section: "VPC", help: "Create subnets in this VPC." },
      { name: "name", label: "Subnet name", kind: "text", section: "Subnet settings", placeholder: "my-subnet-01" },
      { name: "az", label: "Availability Zone", kind: "select", options: azOptions, section: "Subnet settings", help: "Leave empty (-) for No preference: Amazon chooses a zone." },
      { name: "cidr", label: "IPv4 subnet CIDR block", kind: "text", required: true, placeholder: "10.0.1.0/24", section: "Subnet settings", help: "Must be inside the VPC's CIDR and between /16 and /28.", validate: { pattern: "\\d{1,3}(\\.\\d{1,3}){3}/(1[6-9]|2[0-8])", message: "Enter an IPv4 CIDR block between /16 and /28." } },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags - optional" },
    ],
    async run(ctx, v) {
      const r = await ctx.clients.ec2.send(
        new CreateSubnetCommand({ VpcId: text(v.vpcId), CidrBlock: text(v.cidr), AvailabilityZone: text(v.az) || undefined, TagSpecifications: tagSpec("subnet", withName(v.name, v.tags)) })
      );
      const id = r.Subnet?.SubnetId;
      if (!id) throw new Error("CreateSubnet returned no subnet ID.");
      return id;
    },
  },
  actions: [
    {
      id: "settings",
      label: "Edit subnet settings",
      fields: [{ name: "publicIp", label: "Enable auto-assign public IPv4 address", kind: "checkbox", default: false, help: "Instances launched in this subnet get a public IPv4 address. Public subnets usually enable this." }],
      initialValues: async (ctx, id) => ({ publicIp: one(await describeSubnets(ctx, undefined, [id]), "Subnet", id).MapPublicIpOnLaunch === true }),
      async run(ctx, id, v) {
        const want = v.publicIp === true;
        const current = one(await describeSubnets(ctx, undefined, [id]), "Subnet", id).MapPublicIpOnLaunch === true;
        if (current === want) return { message: `No change: auto-assign public IPv4 address is already ${want ? "enabled" : "disabled"} for ${id}.` };
        await ctx.clients.ec2.send(new ModifySubnetAttributeCommand({ SubnetId: id, MapPublicIpOnLaunch: { Value: want } }));
        return { message: `Auto-assign public IPv4 address is now ${want ? "enabled" : "disabled"} for ${id}.` };
      },
    },
    {
      id: "route-table",
      label: "Edit route table association",
      fields: [{ name: "routeTableId", label: "Route table ID", kind: "select", required: true, options: subnetRouteTableOptions, help: "Route tables in the subnet's VPC." }],
      async initialValues(ctx, id) {
        const s = one(await describeSubnets(ctx, undefined, [id]), "Subnet", id);
        return { routeTableId: (await subnetRouting(ctx, id, s.VpcId ?? "")).table?.RouteTableId ?? "" };
      },
      async run(ctx, id, v) {
        const s = one(await describeSubnets(ctx, undefined, [id]), "Subnet", id);
        const routing = await subnetRouting(ctx, id, s.VpcId ?? "");
        const rtb = text(v.routeTableId);
        if (rtb === routing.table?.RouteTableId) return { message: `No change: ${id} already uses route table ${rtb}.` };
        if (routing.association) await ctx.clients.ec2.send(new ReplaceRouteTableAssociationCommand({ AssociationId: routing.association, RouteTableId: rtb }));
        else await ctx.clients.ec2.send(new AssociateRouteTableCommand({ RouteTableId: rtb, SubnetId: id }));
        return { message: `${id} now uses route table ${rtb}.` };
      },
    },
    {
      id: "acl",
      label: "Edit network ACL association",
      fields: [{ name: "aclId", label: "Network ACL ID", kind: "select", required: true, options: subnetAclOptions, help: "Network ACLs in the subnet's VPC." }],
      initialValues: async (ctx, id) => ({ aclId: (await describeAcls(ctx, [{ Name: "association.subnet-id", Values: [id] }]))[0]?.NetworkAclId ?? "" }),
      async run(ctx, id, v) {
        const acl = (await describeAcls(ctx, [{ Name: "association.subnet-id", Values: [id] }]))[0];
        const assoc = acl?.Associations?.find((a) => a.SubnetId === id)?.NetworkAclAssociationId;
        if (!assoc) throw new Error(`${id} has no network ACL association to replace.`);
        if (acl?.NetworkAclId === text(v.aclId)) return { message: `No change: ${id} already uses network ACL ${text(v.aclId)}.` };
        await ctx.clients.ec2.send(new ReplaceNetworkAclAssociationCommand({ AssociationId: assoc, NetworkAclId: text(v.aclId) }));
        return { message: `${id} now uses network ACL ${text(v.aclId)}.` };
      },
    },
    ...tagActions,
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.ec2.send(new DeleteSubnetCommand({ SubnetId: id }));
    },
  },
};
