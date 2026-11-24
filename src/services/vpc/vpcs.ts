/**
 * Your VPCs: list, "VPC only" and "VPC and more" creation (subnets per AZ, internet gateway,
 * NAT gateways, route tables, S3 gateway endpoint), VPC settings, CIDRs, and the console's
 * delete, which also removes the VPC's subnets, gateways, route tables, ACLs and groups.
 */

import { secondaryOr, unavailableText } from "../../console/secondary.ts";
import {
  AllocateAddressCommand,
  AssociateDhcpOptionsCommand,
  AssociateRouteTableCommand,
  AssociateVpcCidrBlockCommand,
  AttachInternetGatewayCommand,
  CreateInternetGatewayCommand,
  CreateNatGatewayCommand,
  CreateRouteCommand,
  CreateRouteTableCommand,
  CreateSubnetCommand,
  CreateVpcCommand,
  CreateVpcEndpointCommand,
  DeleteEgressOnlyInternetGatewayCommand,
  DeleteInternetGatewayCommand,
  DeleteNetworkAclCommand,
  DeleteRouteTableCommand,
  DeleteSecurityGroupCommand,
  DeleteSubnetCommand,
  DeleteVpcCommand,
  DeleteVpcEndpointsCommand,
  DescribeFlowLogsCommand,
  type FlowLog,
  DescribeVpcAttributeCommand,
  DescribeVpcEndpointsCommand,
  DetachInternetGatewayCommand,
  DisassociateRouteTableCommand,
  ModifyVpcAttributeCommand,
  type Tenancy,
} from "@aws-sdk/client-ec2";
import type { Ctx, FieldValues, Option, ResourceDef, Row } from "../../console/types.ts";
import {
  availabilityZones,
  byVpc,
  describeAcls,
  describeDhcp,
  describeEgressIgws,
  describeIgws,
  describeNats,
  describeRouteTables,
  describeSecurityGroups,
  describeSubnets,
  describeTgwAttachments,
  describeVpcs,
  one,
  tagActions,
  tagsTab,
  tagSpec,
  text,
} from "./ec2.ts";
import { defaultSubnetPrefix, nameOf, parseCidr, routeDestination, routeTarget, subnetCidrs, withName } from "./helpers.ts";
import { flowLogFields, createFlowLog } from "./flow-logs.ts";

const CIDR_PATTERN = "\\d{1,3}(\\.\\d{1,3}){3}/(1[6-9]|2[0-8])";

async function dhcpChoices(ctx: Ctx): Promise<Option[]> {
  const sets = await describeDhcp(ctx);
  return [{ value: "default", label: "No DHCP option set (default)" }, ...sets.filter((d) => d.DhcpOptionsId).map((d) => ({ value: d.DhcpOptionsId as string, label: `${d.DhcpOptionsId}${nameOf(d.Tags) ? ` (${nameOf(d.Tags)})` : ""}` }))];
}

/** The current values behind "Edit VPC settings". */
async function currentVpcSettings(ctx: Ctx, id: string): Promise<{ dnsSupport: boolean; dnsHostnames: boolean; dhcp: string }> {
  const ec2 = ctx.clients.ec2;
  const [vpc, support, hostnames] = await Promise.all([
    describeVpcs(ctx, undefined, [id]).then((r) => one(r, "VPC", id)),
    ec2.send(new DescribeVpcAttributeCommand({ VpcId: id, Attribute: "enableDnsSupport" })),
    ec2.send(new DescribeVpcAttributeCommand({ VpcId: id, Attribute: "enableDnsHostnames" })),
  ]);
  return { dnsSupport: support.EnableDnsSupport?.Value === true, dnsHostnames: hostnames.EnableDnsHostnames?.Value === true, dhcp: vpc.DhcpOptionsId || "default" };
}

async function vpcAttribute(ctx: Ctx, vpcId: string, attr: "enableDnsSupport" | "enableDnsHostnames" | "enableNetworkAddressUsageMetrics"): Promise<boolean | null> {
  try {
    const r = await ctx.clients.ec2.send(new DescribeVpcAttributeCommand({ VpcId: vpcId, Attribute: attr }));
    const v = attr === "enableDnsSupport" ? r.EnableDnsSupport : attr === "enableDnsHostnames" ? r.EnableDnsHostnames : r.EnableNetworkAddressUsageMetrics;
    return v?.Value ?? null;
  } catch {
    return null;
  }
}

// ---- "VPC and more" ----

interface MorePlan {
  name: string;
  azs: { name: string; id: string }[];
  publicPerAz: number;
  privatePerAz: number;
  nat: "none" | "one" | "per-az";
  s3Endpoint: boolean;
}

function planFrom(v: FieldValues, zones: { name: string; id: string }[]): MorePlan {
  const azCount = Number(v.azCount ?? 2);
  if (zones.length < azCount) throw new Error(`The Region has only ${zones.length} Availability Zones.`);
  const plan: MorePlan = {
    name: text(v.name) || "project",
    azs: zones.slice(0, azCount),
    publicPerAz: Number(v.publicSubnets ?? 1),
    privatePerAz: Number(v.privateSubnets ?? 1),
    nat: v.natGateways === "one" || v.natGateways === "per-az" ? v.natGateways : "none",
    s3Endpoint: v.s3Endpoint === "s3",
  };
  if (plan.nat !== "none" && plan.publicPerAz === 0) throw new Error("NAT gateways need a public subnet. Add public subnets or choose None for NAT gateways.");
  if (plan.nat !== "none" && plan.privatePerAz === 0) throw new Error("NAT gateways are only useful with private subnets. Add private subnets or choose None.");
  return plan;
}

async function createMore(ctx: Ctx, vpcId: string, cidr: string, plan: MorePlan, created: string[]): Promise<void> {
  const ec2 = ctx.clients.ec2;
  const vpc = parseCidr(cidr);
  if (!vpc) throw new Error(`${cidr} is not a valid IPv4 CIDR block.`);
  const total = plan.azs.length * (plan.publicPerAz + plan.privatePerAz);
  const cidrs = subnetCidrs(cidr, total, defaultSubnetPrefix(vpc.prefix));
  let next = 0;
  const publicSubnets: { id: string; az: string }[] = [];
  const privateSubnets: { id: string; az: string }[] = [];
  const makeSubnet = async (kind: "public" | "private", index: number, az: string): Promise<string> => {
    const name = `${plan.name}-subnet-${kind}${index}-${az}`;
    const r = await ec2.send(new CreateSubnetCommand({ VpcId: vpcId, CidrBlock: cidrs[next++], AvailabilityZone: az, TagSpecifications: tagSpec("subnet", [{ Key: "Name", Value: name }]) }));
    const id = r.Subnet?.SubnetId;
    if (!id) throw new Error(`CreateSubnet returned no ID for ${name}.`);
    created.push(id);
    return id;
  };
  for (let n = 0; n < plan.publicPerAz; n++) for (const [i, az] of plan.azs.entries()) publicSubnets.push({ id: await makeSubnet("public", n * plan.azs.length + i + 1, az.name), az: az.name });
  for (let n = 0; n < plan.privatePerAz; n++) for (const [i, az] of plan.azs.entries()) privateSubnets.push({ id: await makeSubnet("private", n * plan.azs.length + i + 1, az.name), az: az.name });

  const routeTableIds: string[] = [];
  if (publicSubnets.length) {
    const igw = (await ec2.send(new CreateInternetGatewayCommand({ TagSpecifications: tagSpec("internet-gateway", [{ Key: "Name", Value: `${plan.name}-igw` }]) }))).InternetGateway?.InternetGatewayId;
    if (!igw) throw new Error("CreateInternetGateway returned no ID.");
    created.push(igw);
    await ec2.send(new AttachInternetGatewayCommand({ InternetGatewayId: igw, VpcId: vpcId }));
    const rtb = (await ec2.send(new CreateRouteTableCommand({ VpcId: vpcId, TagSpecifications: tagSpec("route-table", [{ Key: "Name", Value: `${plan.name}-rtb-public` }]) }))).RouteTable?.RouteTableId;
    if (!rtb) throw new Error("CreateRouteTable returned no ID.");
    created.push(rtb);
    routeTableIds.push(rtb);
    await ec2.send(new CreateRouteCommand({ RouteTableId: rtb, DestinationCidrBlock: "0.0.0.0/0", GatewayId: igw }));
    for (const s of publicSubnets) await ec2.send(new AssociateRouteTableCommand({ RouteTableId: rtb, SubnetId: s.id }));
  }

  const natByAz = new Map<string, string>();
  const natAzs = plan.nat === "one" ? plan.azs.slice(0, 1) : plan.nat === "per-az" ? plan.azs : [];
  for (const [i, az] of natAzs.entries()) {
    const subnet = publicSubnets.find((s) => s.az === az.name);
    if (!subnet) continue;
    const eip = (await ec2.send(new AllocateAddressCommand({ Domain: "vpc", TagSpecifications: tagSpec("elastic-ip", [{ Key: "Name", Value: `${plan.name}-eip-${az.name}` }]) }))).AllocationId;
    if (!eip) throw new Error("AllocateAddress returned no allocation ID.");
    created.push(eip);
    const nat = (await ec2.send(new CreateNatGatewayCommand({ SubnetId: subnet.id, AllocationId: eip, TagSpecifications: tagSpec("natgateway", [{ Key: "Name", Value: `${plan.name}-nat-public${i + 1}-${az.name}` }]) }))).NatGateway?.NatGatewayId;
    if (!nat) throw new Error("CreateNatGateway returned no ID.");
    created.push(nat);
    natByAz.set(az.name, nat);
  }

  for (const [i, s] of privateSubnets.entries()) {
    const rtb = (await ec2.send(new CreateRouteTableCommand({ VpcId: vpcId, TagSpecifications: tagSpec("route-table", [{ Key: "Name", Value: `${plan.name}-rtb-private${i + 1}-${s.az}` }]) }))).RouteTable?.RouteTableId;
    if (!rtb) throw new Error("CreateRouteTable returned no ID.");
    created.push(rtb);
    routeTableIds.push(rtb);
    const nat = natByAz.get(s.az) ?? [...natByAz.values()][0];
    if (nat) await ec2.send(new CreateRouteCommand({ RouteTableId: rtb, DestinationCidrBlock: "0.0.0.0/0", NatGatewayId: nat }));
    await ec2.send(new AssociateRouteTableCommand({ RouteTableId: rtb, SubnetId: s.id }));
  }

  if (plan.s3Endpoint) {
    const privateTables = routeTableIds.slice(publicSubnets.length ? 1 : 0);
    const ep = await ec2.send(
      new CreateVpcEndpointCommand({
        VpcId: vpcId,
        ServiceName: `com.amazonaws.${ctx.region}.s3`,
        VpcEndpointType: "Gateway",
        RouteTableIds: privateTables.length ? privateTables : routeTableIds,
        TagSpecifications: tagSpec("vpc-endpoint", [{ Key: "Name", Value: `${plan.name}-vpce-s3` }]),
      })
    );
    if (ep.VpcEndpoint?.VpcEndpointId) created.push(ep.VpcEndpoint.VpcEndpointId);
  }
}

// ---- delete (the console removes the VPC's own resources too) ----

async function deleteVpcAndResources(ctx: Ctx, vpcId: string): Promise<void> {
  const ec2 = ctx.clients.ec2;
  const filters = byVpc(vpcId);
  const nats = (await describeNats(ctx, filters)).filter((n) => n.State !== "deleted" && n.State !== "deleting");
  if (nats.length) throw new Error(`Delete the VPC's NAT gateways first (${nats.map((n) => n.NatGatewayId).join(", ")}), then delete the VPC.`);
  const attachments = (await describeTgwAttachments(ctx, [{ Name: "resource-id", Values: [vpcId] }])).filter((a) => a.State !== "deleted" && a.State !== "deleting");
  if (attachments.length) throw new Error(`Delete the VPC's transit gateway attachments first (${attachments.map((a) => a.TransitGatewayAttachmentId).join(", ")}).`);

  const endpoints = (await ec2.send(new DescribeVpcEndpointsCommand({ Filters: filters }))).VpcEndpoints ?? [];
  const endpointIds = endpoints.filter((e) => String(e.State ?? "").toLowerCase() !== "deleted" && e.VpcEndpointId).map((e) => e.VpcEndpointId as string);
  if (endpointIds.length) await ec2.send(new DeleteVpcEndpointsCommand({ VpcEndpointIds: endpointIds }));

  for (const igw of await describeIgws(ctx, [{ Name: "attachment.vpc-id", Values: [vpcId] }])) {
    if (!igw.InternetGatewayId) continue;
    await ec2.send(new DetachInternetGatewayCommand({ InternetGatewayId: igw.InternetGatewayId, VpcId: vpcId }));
    await ec2.send(new DeleteInternetGatewayCommand({ InternetGatewayId: igw.InternetGatewayId }));
  }
  for (const g of await describeEgressIgws(ctx)) {
    if (g.EgressOnlyInternetGatewayId && g.Attachments?.some((a) => a.VpcId === vpcId)) {
      await ec2.send(new DeleteEgressOnlyInternetGatewayCommand({ EgressOnlyInternetGatewayId: g.EgressOnlyInternetGatewayId }));
    }
  }
  for (const rt of await describeRouteTables(ctx, filters)) {
    if (!rt.RouteTableId || rt.Associations?.some((a) => a.Main)) continue;
    for (const a of rt.Associations ?? []) if (a.RouteTableAssociationId) await ec2.send(new DisassociateRouteTableCommand({ AssociationId: a.RouteTableAssociationId }));
    await ec2.send(new DeleteRouteTableCommand({ RouteTableId: rt.RouteTableId }));
  }
  for (const s of await describeSubnets(ctx, filters)) if (s.SubnetId) await ec2.send(new DeleteSubnetCommand({ SubnetId: s.SubnetId }));
  for (const acl of await describeAcls(ctx, filters)) if (acl.NetworkAclId && !acl.IsDefault) await ec2.send(new DeleteNetworkAclCommand({ NetworkAclId: acl.NetworkAclId }));
  for (const sg of await describeSecurityGroups(ctx, filters)) if (sg.GroupId && sg.GroupName !== "default") await ec2.send(new DeleteSecurityGroupCommand({ GroupId: sg.GroupId }));
  await ec2.send(new DeleteVpcCommand({ VpcId: vpcId }));
}

// ---- resource ----

export const vpcs: ResourceDef = {
  id: "vpcs",
  name: "Your VPCs",
  singular: "VPC",
  idField: "vpcId",
  description: "A virtual private cloud (VPC) is a logically isolated virtual network for your AWS resources.",
  emptyText: "You don't have any VPCs in this Region.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "vpcId", label: "VPC ID", kind: "link" },
    { key: "state", label: "State", kind: "status" },
    { key: "cidr", label: "IPv4 CIDR", kind: "text" },
    { key: "ipv6", label: "IPv6 CIDR", kind: "text" },
    { key: "dhcp", label: "DHCP option set", kind: "text" },
    { key: "mainRouteTable", label: "Main route table", kind: "text" },
    { key: "mainAcl", label: "Main network ACL", kind: "text" },
    { key: "tenancy", label: "Tenancy", kind: "text" },
    { key: "isDefault", label: "Default VPC", kind: "boolean" },
    { key: "owner", label: "Owner ID", kind: "text" },
  ],

  async list(ctx) {
    const [vpcList, rtsR, aclsR] = await Promise.all([describeVpcs(ctx), secondaryOr(describeRouteTables(ctx, [{ Name: "association.main", Values: ["true"] }]), []), secondaryOr(describeAcls(ctx, [{ Name: "default", Values: ["true"] }]), [])]);
    const [rts, acls] = [rtsR.value, aclsR.value];
    return vpcList.map((v) => ({
      name: nameOf(v.Tags),
      vpcId: v.VpcId ?? "",
      state: v.State ?? null,
      cidr: v.CidrBlock ?? null,
      ipv6: v.Ipv6CidrBlockAssociationSet?.map((a) => a.Ipv6CidrBlock).filter(Boolean).join(", ") || null,
      dhcp: v.DhcpOptionsId ?? null,
      mainRouteTable: rtsR.error ? "Unavailable" : rts.find((r) => r.VpcId === v.VpcId)?.RouteTableId ?? null,
      mainAcl: aclsR.error ? "Unavailable" : acls.find((a) => a.VpcId === v.VpcId)?.NetworkAclId ?? null,
      tenancy: v.InstanceTenancy ?? null,
      isDefault: v.IsDefault ?? false,
      owner: v.OwnerId ?? null,
    }));
  },

  async get(ctx, id) {
    const v = one(await describeVpcs(ctx, undefined, [id]), "VPC", id);
    const f = byVpc(id);
    const [subnetsR, rtsR, aclsR, dnsSupport, dnsHostnames, flowR] = await Promise.all([
      secondaryOr(describeSubnets(ctx, f), []),
      secondaryOr(describeRouteTables(ctx, f), []),
      secondaryOr(describeAcls(ctx, f), []),
      vpcAttribute(ctx, id, "enableDnsSupport"),
      vpcAttribute(ctx, id, "enableDnsHostnames"),
      secondaryOr(ctx.clients.ec2.send(new DescribeFlowLogsCommand({ Filter: [{ Name: "resource-id", Values: [id] }] })), { FlowLogs: [] } as { FlowLogs?: FlowLog[] }),
    ]);
    const [subnets, rts, acls, flow] = [subnetsR.value, rtsR.value, aclsR.value, flowR.value];
    const mapError = subnetsR.error ?? rtsR.error;
    const main = rts.find((r) => r.Associations?.some((a) => a.Main));
    const tableFor = (subnetId: string) => rts.find((r) => r.Associations?.some((a) => a.SubnetId === subnetId)) ?? main;
    const resourceMap: Row[] = subnets.map((s) => {
      const rt = tableFor(s.SubnetId ?? "");
      return {
        subnet: `${s.SubnetId ?? ""}${nameOf(s.Tags) ? ` (${nameOf(s.Tags)})` : ""}`,
        az: s.AvailabilityZone ?? null,
        cidr: s.CidrBlock ?? null,
        routeTable: rt ? `${rt.RouteTableId ?? ""}${nameOf(rt.Tags) ? ` (${nameOf(rt.Tags)})` : ""}${rt === main && !rt.Associations?.some((a) => a.SubnetId === s.SubnetId) ? " - main" : ""}` : null,
        routes: (rt?.Routes ?? []).map((r) => `${routeDestination(r)} → ${routeTarget(r)}`).join("; "),
      };
    });
    return {
      summary: {
        "VPC ID": id,
        State: v.State ?? null,
        "DNS hostnames": dnsHostnames,
        "DNS resolution": dnsSupport,
        Tenancy: v.InstanceTenancy ?? null,
        "DHCP option set": v.DhcpOptionsId ?? null,
        "Main route table": rtsR.error ? `Unavailable: ${rtsR.error}` : main?.RouteTableId ?? null,
        "Main network ACL": aclsR.error ? `Unavailable: ${aclsR.error}` : acls.find((a) => a.IsDefault)?.NetworkAclId ?? null,
        "Default VPC": v.IsDefault ? "Yes" : "No",
        "IPv4 CIDR": v.CidrBlock ?? null,
        "IPv6 CIDR": v.Ipv6CidrBlockAssociationSet?.map((a) => a.Ipv6CidrBlock).filter(Boolean).join(", ") || null,
        "Owner ID": v.OwnerId ?? null,
        Name: nameOf(v.Tags),
      },
      tabs: [
        {
          id: "resource-map",
          label: "Resource map",
          kind: "table",
          description: "Each subnet, the route table it uses (explicitly associated or the main table) and that table's routes.",
          columns: [
            { key: "subnet", label: "Subnet", kind: "text" },
            { key: "az", label: "Availability Zone", kind: "text" },
            { key: "cidr", label: "IPv4 CIDR", kind: "text" },
            { key: "routeTable", label: "Route table", kind: "text" },
            { key: "routes", label: "Routes (destination → target)", kind: "code" },
          ],
          data: resourceMap,
          emptyText: mapError ? `Unavailable: ${mapError}` : "This VPC has no subnets.",
        },
        {
          id: "cidrs",
          label: "CIDRs",
          kind: "table",
          columns: [
            { key: "version", label: "Address type", kind: "text" },
            { key: "cidr", label: "CIDR", kind: "text" },
            { key: "state", label: "Status", kind: "status" },
            { key: "id", label: "Association ID", kind: "text" },
          ],
          data: [
            ...(v.CidrBlockAssociationSet ?? []).map((a) => ({ version: "IPv4", cidr: a.CidrBlock ?? null, state: a.CidrBlockState?.State ?? null, id: a.AssociationId ?? null })),
            ...(v.Ipv6CidrBlockAssociationSet ?? []).map((a) => ({ version: "IPv6", cidr: a.Ipv6CidrBlock ?? null, state: a.Ipv6CidrBlockState?.State ?? null, id: a.AssociationId ?? null })),
          ],
        },
        {
          id: "flow-logs",
          label: "Flow logs",
          kind: "table",
          columns: [
            { key: "FlowLogId", label: "Flow log ID", kind: "text" },
            { key: "TrafficType", label: "Filter", kind: "text" },
            { key: "LogDestinationType", label: "Destination type", kind: "text" },
            { key: "destination", label: "Destination name", kind: "text" },
            { key: "FlowLogStatus", label: "Status", kind: "status" },
          ],
          data: (flow.FlowLogs ?? []).map((l) => ({ ...l, destination: l.LogGroupName ?? l.LogDestination ?? null })),
          emptyText: unavailableText(flowR, "No flow logs. Use Actions > Create flow log."),
        },
        tagsTab(v.Tags),
      ],
    };
  },

  create: {
    title: "Create VPC",
    description: "Creates a VPC with CreateVpc. With VPC and more, it also creates subnets in each Availability Zone, an internet gateway, NAT gateways, route tables and an S3 gateway endpoint, like the console's wizard.",
    fields: [
      {
        name: "resources", label: "Resources to create", kind: "radio", default: "vpc-only", section: "VPC settings",
        help: "Create only the VPC, or the VPC and other networking resources.",
        options: [
          { value: "vpc-only", label: "VPC only" },
          { value: "more", label: "VPC and more" },
        ],
      },
      { name: "name", label: "Name tag", kind: "text", section: "VPC settings", placeholder: "my-vpc", help: "With VPC and more, this is the prefix for every resource's Name tag (for example project-vpc, project-subnet-public1-us-east-1a).", validate: { max: 200, message: "At most 200 characters." } },
      { name: "cidr", label: "IPv4 CIDR", kind: "text", required: true, default: "10.0.0.0/16", section: "VPC settings", help: "The CIDR block size must be between /16 and /28.", validate: { pattern: CIDR_PATTERN, message: "Enter an IPv4 CIDR block between /16 and /28, such as 10.0.0.0/16." } },
      {
        name: "ipv6", label: "IPv6 CIDR block", kind: "radio", default: "none", section: "VPC settings",
        options: [
          { value: "none", label: "No IPv6 CIDR block" },
          { value: "amazon", label: "Amazon-provided IPv6 CIDR block" },
        ],
      },
      { name: "tenancy", label: "Tenancy", kind: "select", default: "default", section: "VPC settings", options: [{ value: "default", label: "Default" }, { value: "dedicated", label: "Dedicated" }] },
      { name: "azCount", label: "Number of Availability Zones (AZs)", kind: "radio", default: "2", section: "Availability Zones and subnets", showIf: { field: "resources", equals: "more" }, options: [{ value: "1", label: "1" }, { value: "2", label: "2" }, { value: "3", label: "3" }], help: "Choose 2 or more for high availability." },
      { name: "publicSubnets", label: "Number of public subnets", kind: "radio", default: "1", section: "Availability Zones and subnets", showIf: { field: "resources", equals: "more" }, options: [{ value: "0", label: "0" }, { value: "1", label: "One per Availability Zone" }], help: "Public subnets route 0.0.0.0/0 to an internet gateway." },
      { name: "privateSubnets", label: "Number of private subnets", kind: "radio", default: "1", section: "Availability Zones and subnets", showIf: { field: "resources", equals: "more" }, options: [{ value: "0", label: "0" }, { value: "1", label: "One per Availability Zone" }, { value: "2", label: "Two per Availability Zone" }] },
      { name: "natGateways", label: "NAT gateways", kind: "radio", default: "none", section: "Availability Zones and subnets", showIf: { field: "resources", equals: "more" }, options: [{ value: "none", label: "None" }, { value: "one", label: "In 1 AZ" }, { value: "per-az", label: "1 per AZ" }], help: "Each NAT gateway uses an Elastic IP address. 1 per AZ is the highly available choice." },
      { name: "s3Endpoint", label: "VPC endpoints", kind: "radio", default: "s3", section: "Availability Zones and subnets", showIf: { field: "resources", equals: "more" }, options: [{ value: "none", label: "None" }, { value: "s3", label: "S3 Gateway" }], help: "An S3 gateway endpoint keeps S3 traffic off the NAT gateway and internet." },
      { name: "dnsHostnames", label: "Enable DNS hostnames", kind: "checkbox", default: true, section: "DNS options", showIf: { field: "resources", equals: "more" } },
      { name: "dnsSupport", label: "Enable DNS resolution", kind: "checkbox", default: true, section: "DNS options", showIf: { field: "resources", equals: "more" } },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags - optional" },
    ],
    async run(ctx, v) {
      const ec2 = ctx.clients.ec2;
      const cidr = text(v.cidr);
      if (!parseCidr(cidr)) throw new Error(`${cidr} is not a network address. For a /16 the last two numbers must be 0 (for example 10.0.0.0/16).`);
      const more = v.resources === "more";
      const plan = more ? planFrom(v, await availabilityZones(ctx)) : null;
      const name = more && plan ? `${plan.name}-vpc` : text(v.name);
      const r = await ec2.send(
        new CreateVpcCommand({
          CidrBlock: cidr,
          AmazonProvidedIpv6CidrBlock: v.ipv6 === "amazon" ? true : undefined,
          InstanceTenancy: (v.tenancy === "dedicated" ? "dedicated" : "default") as Tenancy,
          TagSpecifications: tagSpec("vpc", withName(name, v.tags)),
        })
      );
      const vpcId = r.Vpc?.VpcId;
      if (!vpcId) throw new Error("CreateVpc returned no VPC ID.");
      if (!plan) return vpcId;
      const created: string[] = [];
      try {
        if (v.dnsSupport === false) await ec2.send(new ModifyVpcAttributeCommand({ VpcId: vpcId, EnableDnsSupport: { Value: false } }));
        if (v.dnsHostnames === true) await ec2.send(new ModifyVpcAttributeCommand({ VpcId: vpcId, EnableDnsHostnames: { Value: true } }));
        await createMore(ctx, vpcId, cidr, plan, created);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`VPC ${vpcId} was created${created.length ? ` with ${created.join(", ")}` : ""}, but the next step failed: ${msg}`);
      }
      return vpcId;
    },
  },

  actions: [
    {
      id: "settings",
      label: "Edit VPC settings",
      fields: [
        { name: "dnsSupport", label: "Enable DNS resolution", kind: "checkbox", default: true, help: "The Amazon-provided DNS server (VPC base + 2) answers queries from the VPC." },
        { name: "dnsHostnames", label: "Enable DNS hostnames", kind: "checkbox", default: false, help: "Instances with public IP addresses get public DNS hostnames. Needs DNS resolution." },
        { name: "dhcp", label: "DHCP option set", kind: "select", required: true, options: dhcpChoices },
      ],
      initialValues: async (ctx, id) => currentVpcSettings(ctx, id),
      async run(ctx, id, v) {
        const ec2 = ctx.clients.ec2;
        const now = await currentVpcSettings(ctx, id);
        const done: string[] = [];
        const support = v.dnsSupport === true;
        const hostnames = v.dnsHostnames === true;
        // Turn DNS resolution on before hostnames, and hostnames off before resolution.
        if (support && !now.dnsSupport) {
          await ec2.send(new ModifyVpcAttributeCommand({ VpcId: id, EnableDnsSupport: { Value: true } }));
          done.push("DNS resolution enabled");
        }
        if (hostnames !== now.dnsHostnames) {
          await ec2.send(new ModifyVpcAttributeCommand({ VpcId: id, EnableDnsHostnames: { Value: hostnames } }));
          done.push(`DNS hostnames ${hostnames ? "enabled" : "disabled"}`);
        }
        if (!support && now.dnsSupport) {
          await ec2.send(new ModifyVpcAttributeCommand({ VpcId: id, EnableDnsSupport: { Value: false } }));
          done.push("DNS resolution disabled");
        }
        const dhcp = text(v.dhcp) || now.dhcp;
        if (dhcp !== now.dhcp) {
          await ec2.send(new AssociateDhcpOptionsCommand({ VpcId: id, DhcpOptionsId: dhcp }));
          done.push(dhcp === "default" ? "no DHCP option set" : `DHCP option set ${dhcp}`);
        }
        return { message: done.length ? `Saved: ${done.join(", ")}.` : `No changes to ${id}.` };
      },
    },
    {
      id: "add-cidr",
      label: "Add IPv4 CIDR",
      fields: [{ name: "cidr", label: "IPv4 CIDR", kind: "text", required: true, placeholder: "10.1.0.0/16", validate: { pattern: CIDR_PATTERN, message: "Enter an IPv4 CIDR block between /16 and /28." } }],
      async run(ctx, id, v) {
        const r = await ctx.clients.ec2.send(new AssociateVpcCidrBlockCommand({ VpcId: id, CidrBlock: text(v.cidr) }));
        return { message: `Added ${r.CidrBlockAssociation?.CidrBlock ?? text(v.cidr)} (${r.CidrBlockAssociation?.AssociationId ?? "no association ID"}).` };
      },
    },
    {
      id: "create-flow-log",
      label: "Create flow log",
      fields: flowLogFields(false),
      async run(ctx, id, v) {
        const flowId = await createFlowLog(ctx, { ...v, resourceType: "VPC", vpcId: id });
        return { message: `Created flow log ${flowId} for ${id}.` };
      },
    },
    ...tagActions,
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await deleteVpcAndResources(ctx, id);
    },
  },
};
