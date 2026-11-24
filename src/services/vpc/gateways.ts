/** Internet gateways, egress-only internet gateways, NAT gateways, Elastic IPs and DHCP option sets. */

import {
  AllocateAddressCommand,
  AssociateAddressCommand,
  AttachInternetGatewayCommand,
  CreateDhcpOptionsCommand,
  CreateEgressOnlyInternetGatewayCommand,
  CreateInternetGatewayCommand,
  CreateNatGatewayCommand,
  DeleteDhcpOptionsCommand,
  DeleteEgressOnlyInternetGatewayCommand,
  DeleteInternetGatewayCommand,
  DeleteNatGatewayCommand,
  DetachInternetGatewayCommand,
  DisassociateAddressCommand,
  ReleaseAddressCommand,
  type ConnectivityType,
  type NewDhcpConfiguration,
} from "@aws-sdk/client-ec2";
import type { Ctx, Option, ResourceDef } from "../../console/types.ts";
import { describeAddresses, describeDhcp, describeEgressIgws, describeIgws, describeNats, eniOptions, instanceOptions, one, statusIn, subnetOptions, tagActions, tagsTab, tagSpec, text, vpcOptions } from "./ec2.ts";
import { nameOf, splitList, withName } from "./helpers.ts";

// ---- Internet gateways ----

export const internetGateways: ResourceDef = {
  id: "internet-gateways",
  name: "Internet gateways",
  singular: "internet gateway",
  idField: "id",
  description: "An internet gateway is a virtual router that connects a VPC to the internet.",
  emptyText: "You don't have any internet gateways in this Region.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "id", label: "Internet gateway ID", kind: "link" },
    { key: "state", label: "State", kind: "status" },
    { key: "vpcId", label: "VPC ID", kind: "text" },
    { key: "owner", label: "Owner", kind: "text" },
  ],
  async list(ctx) {
    return (await describeIgws(ctx)).map((g) => ({
      name: nameOf(g.Tags),
      id: g.InternetGatewayId ?? "",
      state: g.Attachments?.length ? "Attached" : "Detached",
      vpcId: g.Attachments?.[0]?.VpcId ?? null,
      owner: g.OwnerId ?? null,
    }));
  },
  async get(ctx, id) {
    const g = one(await describeIgws(ctx, undefined, [id]), "Internet gateway", id);
    return {
      summary: { "Internet gateway ID": id, Name: nameOf(g.Tags), State: g.Attachments?.length ? "Attached" : "Detached", "VPC ID": g.Attachments?.[0]?.VpcId ?? null, Owner: g.OwnerId ?? null },
      tabs: [tagsTab(g.Tags)],
    };
  },
  create: {
    title: "Create internet gateway",
    description: "Creates an internet gateway with CreateInternetGateway. Attach it to a VPC afterwards.",
    fields: [
      { name: "name", label: "Name tag", kind: "text", section: "Internet gateway settings", placeholder: "my-internet-gateway-01" },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags - optional" },
    ],
    async run(ctx, v) {
      const r = await ctx.clients.ec2.send(new CreateInternetGatewayCommand({ TagSpecifications: tagSpec("internet-gateway", withName(v.name, v.tags)) }));
      const id = r.InternetGateway?.InternetGatewayId;
      if (!id) throw new Error("CreateInternetGateway returned no ID.");
      return id;
    },
  },
  actions: [
    {
      id: "attach",
      label: "Attach to VPC",
      availableFor: statusIn(["Detached"], "state", "State"),
      fields: [{ name: "vpcId", label: "Available VPCs", kind: "select", required: true, options: vpcOptions, help: "A VPC can have only one internet gateway." }],
      async run(ctx, id, v) {
        await ctx.clients.ec2.send(new AttachInternetGatewayCommand({ InternetGatewayId: id, VpcId: text(v.vpcId) }));
        return { message: `Attached ${id} to ${text(v.vpcId)}.` };
      },
    },
    {
      id: "detach",
      label: "Detach from VPC",
      danger: true,
      confirm: "Resources in the VPC lose internet access through this gateway.",
      availableFor: statusIn(["Attached"], "state", "State"),
      async run(ctx, id) {
        const g = one(await describeIgws(ctx, undefined, [id]), "Internet gateway", id);
        const vpcId = g.Attachments?.[0]?.VpcId;
        if (!vpcId) throw new Error(`${id} is not attached to a VPC.`);
        await ctx.clients.ec2.send(new DetachInternetGatewayCommand({ InternetGatewayId: id, VpcId: vpcId }));
        return { message: `Detached ${id} from ${vpcId}.` };
      },
    },
    ...tagActions,
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.ec2.send(new DeleteInternetGatewayCommand({ InternetGatewayId: id }));
    },
  },
};

// ---- Egress-only internet gateways ----

export const egressOnlyGateways: ResourceDef = {
  id: "egress-only-internet-gateways",
  name: "Egress-only internet gateways",
  singular: "egress-only internet gateway",
  idField: "id",
  description: "Lets IPv6 traffic out of a VPC to the internet while blocking connections started from the internet.",
  emptyText: "You don't have any egress-only internet gateways.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "id", label: "Egress-only internet gateway ID", kind: "link" },
    { key: "state", label: "State", kind: "status" },
    { key: "vpcId", label: "VPC ID", kind: "text" },
  ],
  async list(ctx) {
    return (await describeEgressIgws(ctx)).map((g) => ({ name: nameOf(g.Tags), id: g.EgressOnlyInternetGatewayId ?? "", state: g.Attachments?.[0]?.State ?? "detached", vpcId: g.Attachments?.[0]?.VpcId ?? null }));
  },
  async get(ctx, id) {
    const g = one(await describeEgressIgws(ctx, [id]), "Egress-only internet gateway", id);
    return { summary: { "Egress-only internet gateway ID": id, Name: nameOf(g.Tags), State: g.Attachments?.[0]?.State ?? "detached", "VPC ID": g.Attachments?.[0]?.VpcId ?? null }, tabs: [tagsTab(g.Tags)] };
  },
  create: {
    title: "Create egress only internet gateway",
    fields: [
      { name: "name", label: "Name", kind: "text", section: "Egress only internet gateway settings" },
      { name: "vpcId", label: "VPC", kind: "select", required: true, options: vpcOptions, section: "Egress only internet gateway settings", help: "The VPC needs an IPv6 CIDR block to use it." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const r = await ctx.clients.ec2.send(new CreateEgressOnlyInternetGatewayCommand({ VpcId: text(v.vpcId), TagSpecifications: tagSpec("egress-only-internet-gateway", withName(v.name, v.tags)) }));
      const id = r.EgressOnlyInternetGateway?.EgressOnlyInternetGatewayId;
      if (!id) throw new Error("CreateEgressOnlyInternetGateway returned no ID.");
      return id;
    },
  },
  actions: tagActions,
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.ec2.send(new DeleteEgressOnlyInternetGatewayCommand({ EgressOnlyInternetGatewayId: id }));
    },
  },
};

// ---- Elastic IPs ----

async function freeEipOptions(ctx: Ctx): Promise<Option[]> {
  const free = (await describeAddresses(ctx)).filter((a) => a.AllocationId && !a.AssociationId);
  return [{ value: "new", label: "Allocate a new Elastic IP" }, ...free.map((a) => ({ value: a.AllocationId as string, label: `${a.PublicIp ?? ""} (${a.AllocationId})${nameOf(a.Tags) ? ` ${nameOf(a.Tags)}` : ""}` }))];
}

export const elasticIps: ResourceDef = {
  id: "elastic-ips",
  name: "Elastic IPs",
  singular: "Elastic IP address",
  idField: "allocationId",
  description: "Static public IPv4 addresses you can associate with an instance or network interface.",
  emptyText: "You don't have any Elastic IP addresses.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "publicIp", label: "Allocated IPv4 address", kind: "text" },
    { key: "allocationId", label: "Allocation ID", kind: "link" },
    { key: "type", label: "Type", kind: "text" },
    { key: "instanceId", label: "Associated instance ID", kind: "text" },
    { key: "privateIp", label: "Private IP address", kind: "text" },
    { key: "associationId", label: "Association ID", kind: "text" },
    { key: "eni", label: "Network interface ID", kind: "text" },
    { key: "borderGroup", label: "Network border group", kind: "text" },
  ],
  async list(ctx) {
    return (await describeAddresses(ctx)).map((a) => ({
      name: nameOf(a.Tags),
      publicIp: a.PublicIp ?? null,
      allocationId: a.AllocationId ?? "",
      type: "Public IP",
      instanceId: a.InstanceId ?? null,
      privateIp: a.PrivateIpAddress ?? null,
      associationId: a.AssociationId ?? null,
      eni: a.NetworkInterfaceId ?? null,
      borderGroup: a.NetworkBorderGroup ?? null,
    }));
  },
  async get(ctx, id) {
    const a = one(await describeAddresses(ctx, [id]), "Elastic IP address", id);
    return {
      summary: {
        "Allocated IPv4 address": a.PublicIp ?? null,
        "Allocation ID": id,
        Name: nameOf(a.Tags),
        Scope: a.Domain ?? null,
        "Associated instance ID": a.InstanceId ?? null,
        "Private IP address": a.PrivateIpAddress ?? null,
        "Association ID": a.AssociationId ?? null,
        "Network interface ID": a.NetworkInterfaceId ?? null,
        "Network interface owner account ID": a.NetworkInterfaceOwnerId ?? null,
        "Public IPv4 pool": a.PublicIpv4Pool ?? null,
        "Network border group": a.NetworkBorderGroup ?? null,
      },
      tabs: [tagsTab(a.Tags)],
    };
  },
  create: {
    title: "Allocate Elastic IP address",
    description: "Allocates an address from Amazon's pool of IPv4 addresses with AllocateAddress.",
    fields: [
      { name: "borderGroup", label: "Network border group", kind: "select", required: true, section: "Elastic IP address settings", options: async (ctx) => [{ value: ctx.region, label: ctx.region }], help: "The Region selected in the top bar." },
      { name: "name", label: "Name tag", kind: "text", section: "Tags - optional" },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags - optional" },
    ],
    async run(ctx, v) {
      const r = await ctx.clients.ec2.send(new AllocateAddressCommand({ Domain: "vpc", NetworkBorderGroup: text(v.borderGroup) || undefined, TagSpecifications: tagSpec("elastic-ip", withName(v.name, v.tags)) }));
      if (!r.AllocationId) throw new Error("AllocateAddress returned no allocation ID.");
      return r.AllocationId;
    },
  },
  actions: [
    {
      id: "associate",
      label: "Associate Elastic IP address",
      availableFor: (row) => !(row.associationId || row["Association ID"]),
      fields: [
        { name: "resourceType", label: "Resource type", kind: "radio", default: "instance", options: [{ value: "instance", label: "Instance" }, { value: "eni", label: "Network interface" }] },
        { name: "instanceId", label: "Instance", kind: "select", required: true, options: instanceOptions, showIf: { field: "resourceType", equals: "instance" } },
        { name: "eniId", label: "Network interface", kind: "select", required: true, options: eniOptions, showIf: { field: "resourceType", equals: "eni" }, help: "Its VPC needs an attached internet gateway." },
        { name: "privateIp", label: "Private IP address", kind: "text" },
        { name: "reassociate", label: "Allow this Elastic IP address to be reassociated", kind: "checkbox", default: false },
      ],
      async run(ctx, id, v) {
        const r = await ctx.clients.ec2.send(
          new AssociateAddressCommand({
            AllocationId: id,
            InstanceId: v.resourceType === "instance" ? text(v.instanceId) : undefined,
            NetworkInterfaceId: v.resourceType === "eni" ? text(v.eniId) : undefined,
            PrivateIpAddress: text(v.privateIp) || undefined,
            AllowReassociation: v.reassociate === true,
          })
        );
        return { message: `Associated. Association ID: ${r.AssociationId ?? "(none returned)"}.` };
      },
    },
    {
      id: "disassociate",
      label: "Disassociate Elastic IP address",
      availableFor: (row) => Boolean(row.associationId || row["Association ID"]),
      danger: true,
      confirm: "The instance or network interface loses this public address.",
      async run(ctx, id) {
        const a = one(await describeAddresses(ctx, [id]), "Elastic IP address", id);
        if (!a.AssociationId) throw new Error(`${a.PublicIp ?? id} is not associated.`);
        await ctx.clients.ec2.send(new DisassociateAddressCommand({ AssociationId: a.AssociationId }));
        return { message: `Disassociated ${a.PublicIp ?? id}.` };
      },
    },
    ...tagActions,
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.ec2.send(new ReleaseAddressCommand({ AllocationId: id }));
    },
  },
};

// ---- NAT gateways ----

export const natGateways: ResourceDef = {
  id: "nat-gateways",
  name: "NAT gateways",
  singular: "NAT gateway",
  idField: "id",
  description: "A NAT gateway lets instances in private subnets connect outside the VPC while blocking unsolicited inbound connections.",
  emptyText: "You don't have any NAT gateways in this Region.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "id", label: "NAT gateway ID", kind: "link" },
    { key: "connectivity", label: "Connectivity type", kind: "text" },
    { key: "state", label: "State", kind: "status" },
    { key: "message", label: "State message", kind: "text" },
    { key: "publicIp", label: "Primary public IPv4 address", kind: "text" },
    { key: "privateIp", label: "Primary private IPv4 address", kind: "text" },
    { key: "eni", label: "Primary network interface ID", kind: "text" },
    { key: "vpcId", label: "VPC", kind: "text" },
    { key: "subnetId", label: "Subnet", kind: "text" },
    { key: "created", label: "Created", kind: "date" },
  ],
  async list(ctx) {
    return (await describeNats(ctx)).map((n) => {
      const primary = n.NatGatewayAddresses?.find((a) => a.IsPrimary) ?? n.NatGatewayAddresses?.[0];
      return {
        name: nameOf(n.Tags),
        id: n.NatGatewayId ?? "",
        connectivity: n.ConnectivityType ?? null,
        state: n.State ?? null,
        message: n.FailureMessage ?? null,
        publicIp: primary?.PublicIp ?? null,
        privateIp: primary?.PrivateIp ?? null,
        eni: primary?.NetworkInterfaceId ?? null,
        vpcId: n.VpcId ?? null,
        subnetId: n.SubnetId ?? null,
        created: n.CreateTime ?? null,
      };
    });
  },
  async get(ctx, id) {
    const n = one(await describeNats(ctx, undefined, [id]), "NAT gateway", id);
    return {
      summary: {
        "NAT gateway ID": id,
        Name: nameOf(n.Tags),
        "Connectivity type": n.ConnectivityType ?? null,
        State: n.State ?? null,
        "State message": n.FailureMessage ?? null,
        VPC: n.VpcId ?? null,
        Subnet: n.SubnetId ?? null,
        Created: n.CreateTime ?? null,
        Deleted: n.DeleteTime ?? null,
      },
      tabs: [
        {
          id: "addresses",
          label: "Secondary IPv4 addresses",
          kind: "table",
          columns: [
            { key: "PublicIp", label: "Public IPv4 address", kind: "text" },
            { key: "PrivateIp", label: "Private IPv4 address", kind: "text" },
            { key: "AllocationId", label: "Allocation ID", kind: "text" },
            { key: "NetworkInterfaceId", label: "Network interface ID", kind: "text" },
            { key: "IsPrimary", label: "Primary", kind: "boolean" },
            { key: "Status", label: "Status", kind: "status" },
          ],
          data: n.NatGatewayAddresses ?? [],
          emptyText: "No addresses.",
        },
        tagsTab(n.Tags),
      ],
    };
  },
  create: {
    title: "Create NAT gateway",
    description: "Creates a NAT gateway with CreateNatGateway. A public NAT gateway goes in a public subnet and needs an Elastic IP; route private subnets' 0.0.0.0/0 to it.",
    fields: [
      { name: "name", label: "Name", kind: "text", section: "NAT gateway settings", placeholder: "my-nat-gateway-01" },
      { name: "subnetId", label: "Subnet", kind: "select", required: true, options: subnetOptions, section: "NAT gateway settings", help: "For a public NAT gateway, choose a public subnet (one that routes to an internet gateway)." },
      { name: "connectivity", label: "Connectivity type", kind: "radio", default: "public", section: "NAT gateway settings", options: [{ value: "public", label: "Public" }, { value: "private", label: "Private" }] },
      { name: "allocationId", label: "Elastic IP allocation ID", kind: "select", required: true, options: freeEipOptions, section: "NAT gateway settings", showIf: { field: "connectivity", equals: "public" } },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const isPublic = v.connectivity !== "private";
      let allocationId: string | undefined;
      if (isPublic) {
        allocationId = text(v.allocationId);
        if (allocationId === "new") {
          allocationId = (await ctx.clients.ec2.send(new AllocateAddressCommand({ Domain: "vpc" }))).AllocationId;
          if (!allocationId) throw new Error("AllocateAddress returned no allocation ID.");
        }
      }
      const r = await ctx.clients.ec2.send(
        new CreateNatGatewayCommand({ SubnetId: text(v.subnetId), ConnectivityType: (isPublic ? "public" : "private") as ConnectivityType, AllocationId: allocationId, TagSpecifications: tagSpec("natgateway", withName(v.name, v.tags)) })
      );
      const id = r.NatGateway?.NatGatewayId;
      if (!id) throw new Error("CreateNatGateway returned no ID.");
      return id;
    },
  },
  actions: tagActions,
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.ec2.send(new DeleteNatGatewayCommand({ NatGatewayId: id }));
    },
  },
};

// ---- DHCP option sets ----

function dhcpValue(d: { DhcpConfigurations?: { Key?: string; Values?: { Value?: string }[] }[] }, key: string): string | null {
  const c = d.DhcpConfigurations?.find((x) => x.Key === key);
  return c?.Values?.map((v) => v.Value).filter(Boolean).join(", ") || null;
}

export const dhcpOptionSets: ResourceDef = {
  id: "dhcp-option-sets",
  name: "DHCP option sets",
  singular: "DHCP option set",
  idField: "id",
  description: "Settings such as the domain name and DNS servers that instances in a VPC receive through DHCP.",
  emptyText: "You don't have any DHCP option sets.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "id", label: "DHCP option set ID", kind: "link" },
    { key: "domainName", label: "Domain name", kind: "text" },
    { key: "dns", label: "Domain name servers", kind: "text" },
    { key: "ntp", label: "NTP servers", kind: "text" },
    { key: "netbios", label: "NetBIOS name servers", kind: "text" },
    { key: "nodeType", label: "NetBIOS node type", kind: "text" },
    { key: "owner", label: "Owner", kind: "text" },
  ],
  async list(ctx) {
    return (await describeDhcp(ctx)).map((d) => ({
      name: nameOf(d.Tags),
      id: d.DhcpOptionsId ?? "",
      domainName: dhcpValue(d, "domain-name"),
      dns: dhcpValue(d, "domain-name-servers"),
      ntp: dhcpValue(d, "ntp-servers"),
      netbios: dhcpValue(d, "netbios-name-servers"),
      nodeType: dhcpValue(d, "netbios-node-type"),
      owner: d.OwnerId ?? null,
    }));
  },
  async get(ctx, id) {
    const d = one(await describeDhcp(ctx, [id]), "DHCP option set", id);
    return {
      summary: { "DHCP option set ID": id, Name: nameOf(d.Tags), "Domain name": dhcpValue(d, "domain-name"), "Domain name servers": dhcpValue(d, "domain-name-servers"), "NTP servers": dhcpValue(d, "ntp-servers"), "NetBIOS name servers": dhcpValue(d, "netbios-name-servers"), "NetBIOS node type": dhcpValue(d, "netbios-node-type"), Owner: d.OwnerId ?? null },
      tabs: [tagsTab(d.Tags)],
    };
  },
  create: {
    title: "Create DHCP option set",
    description: "Creates a DHCP option set with CreateDhcpOptions. Associate it with a VPC from Your VPCs > Edit VPC settings.",
    fields: [
      { name: "name", label: "DHCP option set name", kind: "text", section: "DHCP option set settings" },
      { name: "domainName", label: "Domain name", kind: "text", section: "DHCP options", placeholder: "example.com" },
      { name: "dns", label: "Domain name servers", kind: "text", section: "DHCP options", default: "AmazonProvidedDNS", help: "Comma-separated: AmazonProvidedDNS or up to four IPv4 addresses." },
      { name: "ntp", label: "NTP servers", kind: "text", section: "DHCP options", help: "Comma-separated IPv4 addresses." },
      { name: "netbios", label: "NetBIOS name servers", kind: "text", section: "DHCP options", help: "Comma-separated IPv4 addresses." },
      { name: "nodeType", label: "NetBIOS node type", kind: "select", section: "DHCP options", options: [{ value: "1", label: "1" }, { value: "2", label: "2 (recommended)" }, { value: "4", label: "4" }, { value: "8", label: "8" }] },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const configs: NewDhcpConfiguration[] = [
        { Key: "domain-name", Values: splitList(v.domainName) },
        { Key: "domain-name-servers", Values: splitList(v.dns) },
        { Key: "ntp-servers", Values: splitList(v.ntp) },
        { Key: "netbios-name-servers", Values: splitList(v.netbios) },
        { Key: "netbios-node-type", Values: splitList(v.nodeType) },
      ].filter((c) => (c.Values ?? []).length > 0);
      if (!configs.length) throw new Error("Set at least one DHCP option.");
      const r = await ctx.clients.ec2.send(new CreateDhcpOptionsCommand({ DhcpConfigurations: configs, TagSpecifications: tagSpec("dhcp-options", withName(v.name, v.tags)) }));
      const id = r.DhcpOptions?.DhcpOptionsId;
      if (!id) throw new Error("CreateDhcpOptions returned no ID.");
      return id;
    },
  },
  actions: tagActions,
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.ec2.send(new DeleteDhcpOptionsCommand({ DhcpOptionsId: id }));
    },
  },
};
