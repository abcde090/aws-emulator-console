/** Site-to-Site VPN: customer gateways, virtual private gateways and VPN connections. */

import {
  AttachVpnGatewayCommand,
  CreateCustomerGatewayCommand,
  CreateVpnConnectionCommand,
  CreateVpnConnectionRouteCommand,
  CreateVpnGatewayCommand,
  DeleteCustomerGatewayCommand,
  DeleteVpnConnectionCommand,
  DeleteVpnConnectionRouteCommand,
  DeleteVpnGatewayCommand,
  DescribeVpnConnectionsCommand,
  DetachVpnGatewayCommand,
  type VpnConnection,
} from "@aws-sdk/client-ec2";
import type { Ctx, Option, ResourceDef } from "../../console/types.ts";
import { describeCgws, describeVgws, numOrUndef, one, strings, tagActions, tagsTab, tagSpec, text, tgwOptions, vpcOptions } from "./ec2.ts";
import { nameOf, splitList, withName } from "./helpers.ts";

const IPV4 = "\\d{1,3}(\\.\\d{1,3}){3}";

async function cgwOptions(ctx: Ctx): Promise<Option[]> {
  return (await describeCgws(ctx)).filter((c) => c.CustomerGatewayId && c.State === "available").map((c) => ({ value: c.CustomerGatewayId as string, label: `${c.CustomerGatewayId}${nameOf(c.Tags) ? ` (${nameOf(c.Tags)})` : ""} | ${c.IpAddress ?? ""}` }));
}

async function vgwOptions(ctx: Ctx): Promise<Option[]> {
  return (await describeVgws(ctx)).filter((g) => g.VpnGatewayId && g.State === "available").map((g) => ({ value: g.VpnGatewayId as string, label: `${g.VpnGatewayId}${nameOf(g.Tags) ? ` (${nameOf(g.Tags)})` : ""}` }));
}

export const customerGateways: ResourceDef = {
  id: "customer-gateways",
  name: "Customer gateways",
  singular: "customer gateway",
  idField: "id",
  description: "A customer gateway describes your on-premises VPN device to AWS.",
  emptyText: "You don't have any customer gateways.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "id", label: "Customer gateway ID", kind: "link" },
    { key: "state", label: "State", kind: "status" },
    { key: "type", label: "Type", kind: "text" },
    { key: "ip", label: "IP address", kind: "text" },
    { key: "asn", label: "BGP ASN", kind: "text" },
    { key: "device", label: "Device name", kind: "text" },
  ],
  async list(ctx) {
    return (await describeCgws(ctx)).map((c) => ({ name: nameOf(c.Tags), id: c.CustomerGatewayId ?? "", state: c.State ?? null, type: c.Type ?? null, ip: c.IpAddress ?? null, asn: c.BgpAsn ?? null, device: c.DeviceName ?? null }));
  },
  async get(ctx, id) {
    const c = one(await describeCgws(ctx, [id]), "Customer gateway", id);
    return {
      summary: { "Customer gateway ID": id, Name: nameOf(c.Tags), State: c.State ?? null, Type: c.Type ?? null, "IP address": c.IpAddress ?? null, "BGP ASN": c.BgpAsn ?? null, "Device name": c.DeviceName ?? null, "Certificate ARN": c.CertificateArn ?? null },
      tabs: [tagsTab(c.Tags)],
    };
  },
  create: {
    title: "Create customer gateway",
    description: "Creates a customer gateway with CreateCustomerGateway.",
    fields: [
      { name: "name", label: "Name tag", kind: "text", section: "Details" },
      { name: "asn", label: "BGP ASN", kind: "number", default: 65000, required: true, section: "Details", help: "The Border Gateway Protocol Autonomous System Number of your device.", validate: { min: 1, max: 4294967294, message: "Between 1 and 4294967294." } },
      { name: "ip", label: "IP address", kind: "text", required: true, section: "Details", placeholder: "203.0.113.12", help: "The public IP address of your device's internet-routable interface.", validate: { pattern: IPV4, message: "Enter an IPv4 address." } },
      { name: "device", label: "Device", kind: "text", section: "Details" },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const r = await ctx.clients.ec2.send(
        new CreateCustomerGatewayCommand({ Type: "ipsec.1", BgpAsn: numOrUndef(v.asn), IpAddress: text(v.ip), DeviceName: text(v.device) || undefined, TagSpecifications: tagSpec("customer-gateway", withName(v.name, v.tags)) })
      );
      const id = r.CustomerGateway?.CustomerGatewayId;
      if (!id) throw new Error("CreateCustomerGateway returned no ID.");
      return id;
    },
  },
  actions: tagActions,
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.ec2.send(new DeleteCustomerGatewayCommand({ CustomerGatewayId: id }));
    },
  },
};

export const virtualPrivateGateways: ResourceDef = {
  id: "virtual-private-gateways",
  name: "Virtual private gateways",
  singular: "virtual private gateway",
  idField: "id",
  description: "The VPN concentrator on the AWS side of a Site-to-Site VPN connection, attached to one VPC.",
  emptyText: "You don't have any virtual private gateways.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "id", label: "Virtual private gateway ID", kind: "link" },
    { key: "state", label: "State", kind: "status" },
    { key: "type", label: "Type", kind: "text" },
    { key: "vpcId", label: "VPC", kind: "text" },
    { key: "asn", label: "Amazon side ASN", kind: "text" },
  ],
  async list(ctx) {
    return (await describeVgws(ctx)).map((g) => {
      const attached = g.VpcAttachments?.find((a) => a.State === "attached" || a.State === "attaching");
      return { name: nameOf(g.Tags), id: g.VpnGatewayId ?? "", state: g.State ?? null, type: g.Type ?? null, vpcId: attached?.VpcId ?? null, asn: g.AmazonSideAsn !== undefined ? String(g.AmazonSideAsn) : null };
    });
  },
  async get(ctx, id) {
    const g = one(await describeVgws(ctx, [id]), "Virtual private gateway", id);
    return {
      summary: { "Virtual private gateway ID": id, Name: nameOf(g.Tags), State: g.State ?? null, Type: g.Type ?? null, VPC: g.VpcAttachments?.find((a) => a.State === "attached" || a.State === "attaching")?.VpcId ?? null, "Amazon side ASN": g.AmazonSideAsn ?? null },
      tabs: [
        {
          id: "attachments",
          label: "VPC attachments",
          kind: "table",
          columns: [
            { key: "VpcId", label: "VPC", kind: "text" },
            { key: "State", label: "State", kind: "status" },
          ],
          data: g.VpcAttachments ?? [],
          emptyText: "Not attached to a VPC.",
        },
        tagsTab(g.Tags),
      ],
    };
  },
  create: {
    title: "Create virtual private gateway",
    fields: [
      { name: "name", label: "Name tag", kind: "text", section: "Details" },
      { name: "asnType", label: "Autonomous System Number (ASN)", kind: "radio", default: "amazon", section: "Details", options: [{ value: "amazon", label: "Amazon default ASN" }, { value: "custom", label: "Custom ASN" }] },
      { name: "asn", label: "Custom ASN", kind: "number", required: true, section: "Details", showIf: { field: "asnType", equals: "custom" }, validate: { min: 64512, max: 4294967294, message: "Use a private ASN: 64512-65534 or 4200000000-4294967294." } },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const r = await ctx.clients.ec2.send(
        new CreateVpnGatewayCommand({ Type: "ipsec.1", AmazonSideAsn: v.asnType === "custom" ? numOrUndef(v.asn) : undefined, TagSpecifications: tagSpec("vpn-gateway", withName(v.name, v.tags)) })
      );
      const id = r.VpnGateway?.VpnGatewayId;
      if (!id) throw new Error("CreateVpnGateway returned no ID.");
      return id;
    },
  },
  actions: [
    {
      id: "attach",
      label: "Attach to VPC",
      availableFor: (row) => !(row.vpcId || row.VPC),
      fields: [{ name: "vpcId", label: "Available VPCs", kind: "select", required: true, options: vpcOptions }],
      async run(ctx, id, v) {
        const r = await ctx.clients.ec2.send(new AttachVpnGatewayCommand({ VpnGatewayId: id, VpcId: text(v.vpcId) }));
        return { message: `Attachment to ${text(v.vpcId)} is ${r.VpcAttachment?.State ?? "requested"}.` };
      },
    },
    {
      id: "detach",
      label: "Detach from VPC",
      danger: true,
      confirm: "The VPN connections on this gateway stop carrying traffic for the VPC.",
      availableFor: (row) => Boolean(row.vpcId || row.VPC),
      async run(ctx, id) {
        const g = one(await describeVgws(ctx, [id]), "Virtual private gateway", id);
        const vpcId = g.VpcAttachments?.find((a) => a.State === "attached")?.VpcId;
        if (!vpcId) throw new Error(`${id} is not attached to a VPC.`);
        await ctx.clients.ec2.send(new DetachVpnGatewayCommand({ VpnGatewayId: id, VpcId: vpcId }));
        return { message: `Detached ${id} from ${vpcId}.` };
      },
    },
    ...tagActions,
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.ec2.send(new DeleteVpnGatewayCommand({ VpnGatewayId: id }));
    },
  },
};

async function describeVpns(ctx: Ctx, ids?: string[]): Promise<VpnConnection[]> {
  return (await ctx.clients.ec2.send(new DescribeVpnConnectionsCommand({ VpnConnectionIds: ids }))).VpnConnections ?? [];
}

const ROUTE_COLUMNS = [
  { key: "DestinationCidrBlock", label: "Destination CIDR", kind: "text" as const },
  { key: "Source", label: "Source", kind: "text" as const },
  { key: "State", label: "State", kind: "status" as const },
];

export const vpnConnections: ResourceDef = {
  id: "vpn-connections",
  name: "Site-to-Site VPN connections",
  singular: "VPN connection",
  idField: "id",
  description: "Two IPsec tunnels between your customer gateway and a virtual private gateway or transit gateway.",
  emptyText: "You don't have any VPN connections.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "id", label: "VPN ID", kind: "link" },
    { key: "state", label: "State", kind: "status" },
    { key: "vgw", label: "Virtual private gateway", kind: "text" },
    { key: "tgw", label: "Transit gateway", kind: "text" },
    { key: "cgw", label: "Customer gateway", kind: "text" },
    { key: "routing", label: "Routing", kind: "text" },
    { key: "type", label: "Type", kind: "text" },
    { key: "category", label: "Category", kind: "text" },
  ],
  async list(ctx) {
    return (await describeVpns(ctx)).map((c) => ({
      name: nameOf(c.Tags),
      id: c.VpnConnectionId ?? "",
      state: c.State ?? null,
      vgw: c.VpnGatewayId ?? null,
      tgw: c.TransitGatewayId ?? null,
      cgw: c.CustomerGatewayId ?? null,
      routing: c.Options?.StaticRoutesOnly ? "Static" : "Dynamic",
      type: c.Type ?? null,
      category: c.Category ?? null,
    }));
  },
  async get(ctx, id) {
    const c = one(await describeVpns(ctx, [id]), "VPN connection", id);
    const o = c.Options ?? {};
    return {
      summary: {
        "VPN ID": id,
        Name: nameOf(c.Tags),
        State: c.State ?? null,
        "Virtual private gateway": c.VpnGatewayId ?? null,
        "Transit gateway": c.TransitGatewayId ?? null,
        "Customer gateway": c.CustomerGatewayId ?? null,
        Routing: o.StaticRoutesOnly ? "Static" : "Dynamic",
        Type: c.Type ?? null,
        Category: c.Category ?? null,
        "Local IPv4 network CIDR": o.LocalIpv4NetworkCidr ?? null,
        "Remote IPv4 network CIDR": o.RemoteIpv4NetworkCidr ?? null,
        Acceleration: o.EnableAcceleration ? "Enabled" : "Disabled",
        "Gateway association state": c.GatewayAssociationState ?? null,
      },
      tabs: [
        {
          id: "tunnels",
          label: "Tunnel details",
          kind: "table",
          columns: [
            { key: "OutsideIpAddress", label: "Outside IP address", kind: "text" },
            { key: "inside", label: "Inside IPv4 CIDR", kind: "text" },
            { key: "Status", label: "Status", kind: "status" },
            { key: "LastStatusChange", label: "Last status change", kind: "date" },
            { key: "StatusMessage", label: "Details", kind: "text" },
            { key: "AcceptedRouteCount", label: "Accepted routes", kind: "count" },
          ],
          data: (c.VgwTelemetry ?? []).map((t) => ({ ...t, inside: o.TunnelOptions?.find((x) => x.OutsideIpAddress === t.OutsideIpAddress)?.TunnelInsideCidr ?? null })),
          emptyText: "No tunnel telemetry.",
        },
        { id: "routes", label: "Static routes", kind: "table", columns: ROUTE_COLUMNS, data: c.Routes ?? [], emptyText: o.StaticRoutesOnly ? "No static routes." : "This connection uses dynamic (BGP) routing." },
        { id: "config", label: "Customer gateway configuration", kind: "text", data: c.CustomerGatewayConfiguration ?? "", emptyText: "No configuration returned.", description: "The generic configuration for your device, as returned by DescribeVpnConnections. It contains the tunnels' pre-shared keys." },
        tagsTab(c.Tags),
      ],
    };
  },
  create: {
    title: "Create VPN connection",
    description: "Creates a Site-to-Site VPN connection with CreateVpnConnection.",
    fields: [
      { name: "name", label: "Name tag", kind: "text", section: "Details" },
      { name: "target", label: "Target gateway type", kind: "radio", default: "vgw", section: "Details", options: [{ value: "vgw", label: "Virtual private gateway" }, { value: "tgw", label: "Transit gateway" }] },
      { name: "vgwId", label: "Virtual private gateway", kind: "select", required: true, options: vgwOptions, section: "Details", showIf: { field: "target", equals: "vgw" } },
      { name: "tgwId", label: "Transit gateway", kind: "select", required: true, options: tgwOptions, section: "Details", showIf: { field: "target", equals: "tgw" } },
      { name: "cgwId", label: "Customer gateway ID", kind: "select", required: true, options: cgwOptions, section: "Details", help: "Create the customer gateway first." },
      { name: "routing", label: "Routing options", kind: "radio", default: "dynamic", section: "Details", options: [{ value: "dynamic", label: "Dynamic (requires BGP)" }, { value: "static", label: "Static" }] },
      { name: "prefixes", label: "Static IP prefixes", kind: "text", section: "Details", showIf: { field: "routing", equals: "static" }, placeholder: "192.168.0.0/16, 172.16.0.0/12", help: "Your on-premises networks, comma-separated." },
      { name: "localCidr", label: "Local IPv4 network CIDR", kind: "text", section: "Tunnel options", placeholder: "0.0.0.0/0" },
      { name: "remoteCidr", label: "Remote IPv4 network CIDR", kind: "text", section: "Tunnel options", placeholder: "0.0.0.0/0" },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const toVgw = v.target !== "tgw";
      const isStatic = v.routing === "static";
      const r = await ctx.clients.ec2.send(
        new CreateVpnConnectionCommand({
          Type: "ipsec.1",
          CustomerGatewayId: text(v.cgwId),
          VpnGatewayId: toVgw ? text(v.vgwId) : undefined,
          TransitGatewayId: toVgw ? undefined : text(v.tgwId),
          Options: { StaticRoutesOnly: isStatic, LocalIpv4NetworkCidr: text(v.localCidr) || undefined, RemoteIpv4NetworkCidr: text(v.remoteCidr) || undefined },
          TagSpecifications: tagSpec("vpn-connection", withName(v.name, v.tags)),
        })
      );
      const id = r.VpnConnection?.VpnConnectionId;
      if (!id) throw new Error("CreateVpnConnection returned no ID.");
      if (isStatic && toVgw) for (const cidr of splitList(v.prefixes)) await ctx.clients.ec2.send(new CreateVpnConnectionRouteCommand({ VpnConnectionId: id, DestinationCidrBlock: cidr }));
      return id;
    },
  },
  actions: [
    {
      id: "add-route",
      label: "Add static route",
      fields: [{ name: "cidr", label: "Destination CIDR", kind: "text", required: true, placeholder: "192.168.0.0/16", validate: { pattern: `${IPV4}/\\d{1,2}`, message: "Enter an IPv4 CIDR block." } }],
      async run(ctx, id, v) {
        await ctx.clients.ec2.send(new CreateVpnConnectionRouteCommand({ VpnConnectionId: id, DestinationCidrBlock: text(v.cidr) }));
        return { message: `Added static route ${text(v.cidr)}.` };
      },
    },
    {
      id: "remove-routes",
      label: "Remove static routes",
      async run(ctx, id) {
        const c = one(await describeVpns(ctx, [id]), "VPN connection", id);
        const rows = (c.Routes ?? []).filter((r) => r.DestinationCidrBlock).map((r) => ({ ...r, DestinationCidrBlock: r.DestinationCidrBlock ?? "" }));
        return { message: "Select static routes to remove.", table: { columns: ROUTE_COLUMNS, rows, rowKey: "DestinationCidrBlock", emptyText: "No static routes.", selectionAction: { actionId: "delete-routes", label: "Remove", danger: true, valuesField: "cidrs" } } };
      },
    },
    {
      id: "delete-routes",
      label: "Remove selected routes",
      hidden: true,
      danger: true,
      fields: [{ name: "cidrs", label: "Routes", kind: "multiselect", required: true }],
      async run(ctx, id, v) {
        const cidrs = strings(v.cidrs);
        for (const c of cidrs) await ctx.clients.ec2.send(new DeleteVpnConnectionRouteCommand({ VpnConnectionId: id, DestinationCidrBlock: c }));
        return { message: `Removed ${cidrs.length} route${cidrs.length === 1 ? "" : "s"}.` };
      },
    },
    ...tagActions,
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.ec2.send(new DeleteVpnConnectionCommand({ VpnConnectionId: id }));
    },
  },
};
