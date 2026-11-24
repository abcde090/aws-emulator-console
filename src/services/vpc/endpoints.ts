/** VPC endpoints (gateway and interface) and VPC peering connections. */

import {
  AcceptVpcPeeringConnectionCommand,
  CreateVpcEndpointCommand,
  CreateVpcPeeringConnectionCommand,
  DeleteVpcEndpointsCommand,
  DeleteVpcPeeringConnectionCommand,
  DescribeVpcEndpointServicesCommand,
  DescribeVpcEndpointsCommand,
  ModifyVpcEndpointCommand,
  RejectVpcPeeringConnectionCommand,
  type VpcEndpoint,
  type VpcPeeringConnection,
} from "@aws-sdk/client-ec2";
import type { Ctx, FieldValues, Option, ResourceDef, Row } from "../../console/types.ts";
import { collect, describePeerings, describeRouteTables, one, routeTableOptions, rowValue, securityGroupOptions, statusIn, strings, subnetOptions, tagActions, tagsTab, tagSpec, text, vpcOptions } from "./ec2.ts";
import { nameOf, routeDestination, withName } from "./helpers.ts";

// ---- Endpoints ----

async function endpointServiceOptions(ctx: Ctx, type: "Gateway" | "Interface"): Promise<Option[]> {
  const services = await collect(async (t) => {
    const r = await ctx.clients.ec2.send(new DescribeVpcEndpointServicesCommand({ Filters: [{ Name: "service-type", Values: [type] }], NextToken: t }));
    return { items: r.ServiceDetails, next: r.NextToken };
  });
  return services
    .filter((s) => s.ServiceName)
    .map((s) => ({ value: s.ServiceName as string, label: s.ServiceName as string }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

async function describeEndpoints(ctx: Ctx, ids?: string[]): Promise<VpcEndpoint[]> {
  return collect(async (t) => {
    const r = await ctx.clients.ec2.send(new DescribeVpcEndpointsCommand({ VpcEndpointIds: ids, NextToken: t }));
    return { items: r.VpcEndpoints, next: r.NextToken };
  });
}

function parsePolicy(text: string | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Route tables in the endpoint's VPC. */
async function endpointRouteTableOptions(ctx: Ctx, id?: string): Promise<Option[]> {
  const vpcId = id ? one(await describeEndpoints(ctx, [id]), "Endpoint", id).VpcId : undefined;
  const tables = await describeRouteTables(ctx, vpcId ? [{ Name: "vpc-id", Values: [vpcId] }] : undefined);
  return tables.filter((t) => t.RouteTableId).map((t) => ({ value: t.RouteTableId as string, label: `${t.RouteTableId}${nameOf(t.Tags) ? ` (${nameOf(t.Tags)})` : ""}${vpcId ? "" : ` | ${t.VpcId ?? ""}`}` }));
}

export const endpoints: ResourceDef = {
  id: "endpoints",
  name: "Endpoints",
  singular: "endpoint",
  idField: "id",
  description: "VPC endpoints connect your VPC privately to AWS services without an internet gateway or NAT device.",
  emptyText: "You don't have any endpoints in this Region.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "id", label: "VPC endpoint ID", kind: "link" },
    { key: "type", label: "Endpoint type", kind: "text" },
    { key: "state", label: "Status", kind: "status" },
    { key: "vpcId", label: "VPC ID", kind: "text" },
    { key: "service", label: "Service name", kind: "text" },
    { key: "created", label: "Creation time", kind: "date" },
  ],
  async list(ctx) {
    return (await describeEndpoints(ctx)).map((e) => ({
      name: nameOf(e.Tags),
      id: e.VpcEndpointId ?? "",
      type: e.VpcEndpointType ?? null,
      state: e.State ?? null,
      vpcId: e.VpcId ?? null,
      service: e.ServiceName ?? null,
      created: e.CreationTimestamp ?? null,
    }));
  },
  async get(ctx, id) {
    const e = one(await describeEndpoints(ctx, [id]), "VPC endpoint", id);
    return {
      summary: {
        "Endpoint ID": id,
        Name: nameOf(e.Tags),
        Status: e.State ?? null,
        "Endpoint type": e.VpcEndpointType ?? null,
        "VPC ID": e.VpcId ?? null,
        "Service name": e.ServiceName ?? null,
        "Private DNS names enabled": e.VpcEndpointType === "Interface" ? (e.PrivateDnsEnabled ? "Yes" : "No") : null,
        "IP address type": e.IpAddressType ?? null,
        "Creation time": e.CreationTimestamp ?? null,
      },
      tabs: [
        {
          id: "subnets",
          label: "Subnets",
          kind: "table",
          columns: [{ key: "subnet", label: "Subnet ID", kind: "text" }],
          data: (e.SubnetIds ?? []).map((subnet) => ({ subnet })),
          emptyText: e.VpcEndpointType === "Gateway" ? "Gateway endpoints use route tables, not subnets." : "No subnets.",
        },
        {
          id: "route-tables",
          label: "Route tables",
          kind: "table",
          columns: [{ key: "routeTable", label: "Route table ID", kind: "text" }],
          data: (e.RouteTableIds ?? []).map((routeTable) => ({ routeTable })),
          emptyText: e.VpcEndpointType === "Interface" ? "Interface endpoints use network interfaces in subnets, not route tables." : "No route tables.",
        },
        {
          id: "security-groups",
          label: "Security groups",
          kind: "table",
          columns: [
            { key: "GroupId", label: "Group ID", kind: "text" },
            { key: "GroupName", label: "Group name", kind: "text" },
          ],
          data: e.Groups ?? [],
          emptyText: "No security groups.",
        },
        {
          id: "dns",
          label: "DNS names",
          kind: "table",
          columns: [
            { key: "DnsName", label: "DNS name", kind: "code" },
            { key: "HostedZoneId", label: "Hosted zone ID", kind: "text" },
          ],
          data: e.DnsEntries ?? [],
          emptyText: "No DNS names.",
        },
        {
          id: "eni",
          label: "Network interfaces",
          kind: "table",
          columns: [{ key: "eni", label: "Network interface ID", kind: "text" }],
          data: (e.NetworkInterfaceIds ?? []).map((eni) => ({ eni })),
          emptyText: "No network interfaces.",
        },
        { id: "policy", label: "Policy", kind: "json", data: parsePolicy(e.PolicyDocument), emptyText: "No policy." },
        tagsTab(e.Tags),
      ],
    };
  },
  create: {
    title: "Create endpoint",
    description: "Creates a VPC endpoint with CreateVpcEndpoint.",
    fields: [
      { name: "name", label: "Name tag", kind: "text", section: "Endpoint settings", placeholder: "my-endpoint-01" },
      { name: "type", label: "Type", kind: "radio", default: "Gateway", section: "Endpoint settings", options: [{ value: "Gateway", label: "AWS services - Gateway (Amazon S3, DynamoDB): routes in your route tables" }, { value: "Interface", label: "AWS services - Interface: network interfaces in your subnets (AWS PrivateLink)" }] },
      { name: "gatewayService", label: "Service name", kind: "select", required: true, section: "Services", showIf: { field: "type", equals: "Gateway" }, options: (ctx) => endpointServiceOptions(ctx, "Gateway") },
      { name: "interfaceService", label: "Service name", kind: "select", required: true, section: "Services", showIf: { field: "type", equals: "Interface" }, options: (ctx) => endpointServiceOptions(ctx, "Interface") },
      { name: "vpcId", label: "VPC", kind: "select", required: true, options: vpcOptions, section: "Network settings" },
      { name: "routeTables", label: "Route tables", kind: "multiselect", options: routeTableOptions, section: "Route tables", showIf: { field: "type", equals: "Gateway" }, help: "A route to the service's prefix list is added to each selected route table. They must be in the VPC." },
      { name: "subnets", label: "Subnets", kind: "multiselect", options: subnetOptions, section: "Subnets", showIf: { field: "type", equals: "Interface" }, help: "One endpoint network interface per subnet. Choose one subnet per Availability Zone." },
      { name: "securityGroups", label: "Security groups", kind: "multiselect", options: securityGroupOptions, section: "Security groups", showIf: { field: "type", equals: "Interface" }, help: "Leave empty for the VPC's default security group." },
      { name: "privateDns", label: "Enable DNS name", kind: "checkbox", default: true, section: "Network settings", showIf: { field: "type", equals: "Interface" }, help: "Lets the service's default DNS name resolve to the endpoint. Needs DNS hostnames and resolution on the VPC." },
      { name: "policyType", label: "Policy", kind: "radio", default: "full", section: "Policy", options: [{ value: "full", label: "Full access" }, { value: "custom", label: "Custom" }] },
      { name: "policy", label: "Policy document", kind: "json", section: "Policy", showIf: { field: "policyType", equals: "custom" } },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const gateway = v.type !== "Interface";
      const r = await ctx.clients.ec2.send(
        new CreateVpcEndpointCommand({
          VpcId: text(v.vpcId),
          VpcEndpointType: gateway ? "Gateway" : "Interface",
          ServiceName: text(gateway ? v.gatewayService : v.interfaceService),
          RouteTableIds: gateway ? strings(v.routeTables) : undefined,
          SubnetIds: gateway ? undefined : strings(v.subnets),
          SecurityGroupIds: gateway || strings(v.securityGroups).length === 0 ? undefined : strings(v.securityGroups),
          PrivateDnsEnabled: gateway ? undefined : v.privateDns === true,
          PolicyDocument: v.policyType === "custom" && text(v.policy) ? text(v.policy) : undefined,
          TagSpecifications: tagSpec("vpc-endpoint", withName(v.name, v.tags)),
        })
      );
      const id = r.VpcEndpoint?.VpcEndpointId;
      if (!id) throw new Error("CreateVpcEndpoint returned no ID.");
      return id;
    },
  },
  actions: [
    {
      id: "route-tables",
      label: "Manage route tables",
      availableFor: (row) => rowValue(row, "type", "Endpoint type") === undefined || rowValue(row, "type", "Endpoint type") === "Gateway",
      fields: [{ name: "routeTables", label: "Route tables", kind: "multiselect", options: endpointRouteTableOptions, help: "The gateway endpoint adds a route (prefix list) to each selected route table in its VPC." }],
      initialValues: async (ctx, id) => ({ routeTables: one(await describeEndpoints(ctx, [id]), "Endpoint", id).RouteTableIds ?? [] }),
      async run(ctx, id, v) {
        const current = one(await describeEndpoints(ctx, [id]), "Endpoint", id).RouteTableIds ?? [];
        const wanted = strings(v.routeTables);
        const add = wanted.filter((r) => !current.includes(r));
        const remove = current.filter((r) => !wanted.includes(r));
        if (!add.length && !remove.length) return { message: `No route table changes on ${id}.` };
        await ctx.clients.ec2.send(new ModifyVpcEndpointCommand({ VpcEndpointId: id, AddRouteTableIds: add.length ? add : undefined, RemoveRouteTableIds: remove.length ? remove : undefined }));
        return { message: `Route tables updated: ${add.length} added, ${remove.length} removed.` };
      },
    },
    {
      id: "policy",
      label: "Edit policy",
      fields: [{ name: "policy", label: "Policy document", kind: "json", required: true, help: "Controls which principals can use the endpoint and for what." }],
      async initialValues(ctx, id): Promise<FieldValues> {
        const doc = one(await describeEndpoints(ctx, [id]), "Endpoint", id).PolicyDocument;
        const parsed = parsePolicy(doc);
        return doc ? { policy: typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2) } : {};
      },
      async run(ctx, id, v) {
        await ctx.clients.ec2.send(new ModifyVpcEndpointCommand({ VpcEndpointId: id, PolicyDocument: text(v.policy) }));
        return { message: "Endpoint policy saved." };
      },
    },
    ...tagActions,
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      const r = await ctx.clients.ec2.send(new DeleteVpcEndpointsCommand({ VpcEndpointIds: [id] }));
      const failed = r.Unsuccessful?.[0];
      if (failed) throw new Error(`${failed.Error?.Code ?? "Error"}: ${failed.Error?.Message ?? ""}`);
    },
  },
};

// ---- Peering connections ----

function peeringRow(p: VpcPeeringConnection): Row {
  const cidrs = (info: VpcPeeringConnection["RequesterVpcInfo"]) => info?.CidrBlockSet?.map((c) => c.CidrBlock).filter(Boolean).join(", ") || info?.CidrBlock || null;
  return {
    name: nameOf(p.Tags),
    id: p.VpcPeeringConnectionId ?? "",
    status: p.Status?.Code ?? null,
    requesterVpc: p.RequesterVpcInfo?.VpcId ?? null,
    accepterVpc: p.AccepterVpcInfo?.VpcId ?? null,
    requesterCidrs: cidrs(p.RequesterVpcInfo),
    accepterCidrs: cidrs(p.AccepterVpcInfo),
    requesterOwner: p.RequesterVpcInfo?.OwnerId ?? null,
    accepterOwner: p.AccepterVpcInfo?.OwnerId ?? null,
    requesterRegion: p.RequesterVpcInfo?.Region ?? null,
    accepterRegion: p.AccepterVpcInfo?.Region ?? null,
  };
}

export const peeringConnections: ResourceDef = {
  id: "peering-connections",
  name: "Peering connections",
  singular: "peering connection",
  idField: "id",
  description: "A peering connection routes traffic between two VPCs using private IPv4 or IPv6 addresses. Peering is not transitive.",
  emptyText: "You don't have any peering connections in this Region.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "id", label: "Peering connection ID", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "requesterVpc", label: "Requester VPC", kind: "text" },
    { key: "accepterVpc", label: "Accepter VPC", kind: "text" },
    { key: "requesterCidrs", label: "Requester CIDRs", kind: "text" },
    { key: "accepterCidrs", label: "Accepter CIDRs", kind: "text" },
    { key: "requesterOwner", label: "Requester owner ID", kind: "text" },
    { key: "accepterOwner", label: "Accepter owner ID", kind: "text" },
    { key: "requesterRegion", label: "Requester Region", kind: "text", hidden: true },
    { key: "accepterRegion", label: "Accepter Region", kind: "text", hidden: true },
  ],
  async list(ctx) {
    return (await describePeerings(ctx)).map(peeringRow);
  },
  async get(ctx, id) {
    const p = one(await describePeerings(ctx, undefined, [id]), "Peering connection", id);
    const r = peeringRow(p);
    const tables = await describeRouteTables(ctx, [{ Name: "route.vpc-peering-connection-id", Values: [id] }]);
    return {
      summary: {
        "Peering connection ID": id,
        Name: r.name,
        Status: r.status,
        "Status message": p.Status?.Message ?? null,
        "Requester VPC": r.requesterVpc,
        "Accepter VPC": r.accepterVpc,
        "Requester CIDRs": r.requesterCidrs,
        "Accepter CIDRs": r.accepterCidrs,
        "Requester owner ID": r.requesterOwner,
        "Accepter owner ID": r.accepterOwner,
        "Requester Region": r.requesterRegion,
        "Accepter Region": r.accepterRegion,
        Expiration: p.ExpirationTime ?? null,
      },
      tabs: [
        {
          id: "route-tables",
          label: "Route tables",
          kind: "table",
          description: "Routes that send traffic over this peering connection. Add a route in each VPC's route table for traffic to flow both ways.",
          columns: [
            { key: "routeTable", label: "Route table ID", kind: "text" },
            { key: "vpc", label: "VPC", kind: "text" },
            { key: "destination", label: "Destination", kind: "text" },
            { key: "state", label: "Status", kind: "status" },
          ],
          data: tables.flatMap((t) => (t.Routes ?? []).filter((x) => x.VpcPeeringConnectionId === id).map((x) => ({ routeTable: t.RouteTableId ?? "", vpc: t.VpcId ?? null, destination: routeDestination(x), state: x.State ?? null }))),
          emptyText: "No routes use this peering connection yet. Use Route tables > Add route with this peering connection as the target.",
        },
        {
          id: "dns",
          label: "DNS",
          kind: "keyvalue",
          data: {
            "Requester DNS resolution (from accepter VPC)": p.RequesterVpcInfo?.PeeringOptions?.AllowDnsResolutionFromRemoteVpc ?? null,
            "Accepter DNS resolution (from requester VPC)": p.AccepterVpcInfo?.PeeringOptions?.AllowDnsResolutionFromRemoteVpc ?? null,
          },
        },
        tagsTab(p.Tags),
      ],
    };
  },
  create: {
    title: "Create peering connection",
    description: "Requests a peering connection with CreateVpcPeeringConnection. The accepter VPC's owner must accept it before it becomes active.",
    fields: [
      { name: "name", label: "Name", kind: "text", section: "Peering connection settings", placeholder: "my-peering-connection-01" },
      { name: "vpcId", label: "VPC ID (Requester)", kind: "select", required: true, options: vpcOptions, section: "Select a local VPC to peer with" },
      { name: "peerVpcId", label: "VPC ID (Accepter)", kind: "select", required: true, options: vpcOptions, section: "Select another VPC to peer with", help: "My account, this Region. The two VPCs' CIDR blocks must not overlap." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      if (text(v.vpcId) === text(v.peerVpcId)) throw new Error("Choose two different VPCs.");
      const r = await ctx.clients.ec2.send(new CreateVpcPeeringConnectionCommand({ VpcId: text(v.vpcId), PeerVpcId: text(v.peerVpcId), TagSpecifications: tagSpec("vpc-peering-connection", withName(v.name, v.tags)) }));
      const id = r.VpcPeeringConnection?.VpcPeeringConnectionId;
      if (!id) throw new Error("CreateVpcPeeringConnection returned no ID.");
      return id;
    },
  },
  actions: [
    {
      id: "accept",
      label: "Accept request",
      availableFor: statusIn(["pending-acceptance"], "status", "Status"),
      confirm: "Accepting activates the peering connection. Then add routes in both VPCs' route tables.",
      async run(ctx, id) {
        const r = await ctx.clients.ec2.send(new AcceptVpcPeeringConnectionCommand({ VpcPeeringConnectionId: id }));
        return { message: `Peering connection ${id} is ${r.VpcPeeringConnection?.Status?.Code ?? "accepted"}.` };
      },
    },
    {
      id: "reject",
      label: "Reject request",
      availableFor: statusIn(["pending-acceptance"], "status", "Status"),
      danger: true,
      confirm: "Rejecting a pending request can't be undone.",
      async run(ctx, id) {
        await ctx.clients.ec2.send(new RejectVpcPeeringConnectionCommand({ VpcPeeringConnectionId: id }));
        return { message: `Rejected ${id}.` };
      },
    },
    ...tagActions,
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.ec2.send(new DeleteVpcPeeringConnectionCommand({ VpcPeeringConnectionId: id }));
    },
  },
};
