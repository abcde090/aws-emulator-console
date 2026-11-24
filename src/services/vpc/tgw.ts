/** Transit gateways, their VPC attachments and their route tables (associations, propagations, static routes). */

import {
  AssociateTransitGatewayRouteTableCommand,
  CreateTransitGatewayCommand,
  CreateTransitGatewayRouteCommand,
  CreateTransitGatewayRouteTableCommand,
  CreateTransitGatewayVpcAttachmentCommand,
  DeleteTransitGatewayCommand,
  DeleteTransitGatewayRouteTableCommand,
  DeleteTransitGatewayVpcAttachmentCommand,
  DescribeTransitGatewayRouteTablesCommand,
  DisableTransitGatewayRouteTablePropagationCommand,
  EnableTransitGatewayRouteTablePropagationCommand,
  GetTransitGatewayRouteTableAssociationsCommand,
  GetTransitGatewayRouteTablePropagationsCommand,
  SearchTransitGatewayRoutesCommand,
  type TransitGatewayRouteTable,
} from "@aws-sdk/client-ec2";
import type { Ctx, ResourceDef } from "../../console/types.ts";
import { collect, describeTgwAttachments, describeTgws, numOrUndef, one, strings, subnetOptions, tagActions, tagsTab, tagSpec, text, tgwAttachmentOptions, tgwOptions, vpcOptions } from "./ec2.ts";
import { nameOf, withName } from "./helpers.ts";

const enable = (v: unknown): "enable" | "disable" => (v === true ? "enable" : "disable");

export const transitGateways: ResourceDef = {
  id: "transit-gateways",
  name: "Transit gateways",
  singular: "transit gateway",
  idField: "id",
  description: "A transit gateway is a regional hub that connects VPCs and on-premises networks, with its own route tables.",
  emptyText: "You don't have any transit gateways in this Region.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "id", label: "Transit gateway ID", kind: "link" },
    { key: "owner", label: "Owner ID", kind: "text" },
    { key: "state", label: "State", kind: "status" },
    { key: "asn", label: "Amazon side ASN", kind: "text" },
    { key: "description", label: "Description", kind: "text" },
  ],
  async list(ctx) {
    return (await describeTgws(ctx)).map((t) => ({
      name: nameOf(t.Tags),
      id: t.TransitGatewayId ?? "",
      owner: t.OwnerId ?? null,
      state: t.State ?? null,
      asn: t.Options?.AmazonSideAsn !== undefined ? String(t.Options.AmazonSideAsn) : null,
      description: t.Description ?? null,
    }));
  },
  async get(ctx, id) {
    const t = one(await describeTgws(ctx, [id]), "Transit gateway", id);
    const o = t.Options ?? {};
    const attachments = await describeTgwAttachments(ctx, [{ Name: "transit-gateway-id", Values: [id] }]);
    return {
      summary: {
        "Transit gateway ID": id,
        Name: nameOf(t.Tags),
        State: t.State ?? null,
        "Transit gateway ARN": t.TransitGatewayArn ?? null,
        Description: t.Description ?? null,
        "Owner ID": t.OwnerId ?? null,
        "Amazon ASN": o.AmazonSideAsn ?? null,
        "DNS support": o.DnsSupport ?? null,
        "VPN ECMP support": o.VpnEcmpSupport ?? null,
        "Default association route table": o.DefaultRouteTableAssociation ?? null,
        "Association route table ID": o.AssociationDefaultRouteTableId ?? null,
        "Default propagation route table": o.DefaultRouteTablePropagation ?? null,
        "Propagation route table ID": o.PropagationDefaultRouteTableId ?? null,
        "Auto accept shared attachments": o.AutoAcceptSharedAttachments ?? null,
        "Multicast support": o.MulticastSupport ?? null,
        "Created": t.CreationTime ?? null,
      },
      tabs: [
        {
          id: "attachments",
          label: "Attachments",
          kind: "table",
          columns: [
            { key: "TransitGatewayAttachmentId", label: "Attachment ID", kind: "text" },
            { key: "ResourceType", label: "Resource type", kind: "text" },
            { key: "ResourceId", label: "Resource ID", kind: "text" },
            { key: "State", label: "State", kind: "status" },
          ],
          data: attachments,
          emptyText: "No attachments.",
        },
        tagsTab(t.Tags),
      ],
    };
  },
  create: {
    title: "Create transit gateway",
    description: "Creates a transit gateway with CreateTransitGateway.",
    fields: [
      { name: "name", label: "Name tag", kind: "text", section: "Details - optional", placeholder: "my-transit-gateway" },
      { name: "description", label: "Description", kind: "text", section: "Details - optional" },
      { name: "asn", label: "Amazon side Autonomous System Number (ASN)", kind: "number", section: "Configure the transit gateway", help: "Leave empty for the default (64512). Private ASNs: 64512-65534 or 4200000000-4294967294.", validate: { min: 64512, max: 4294967294, message: "Use a private ASN: 64512-65534 or 4200000000-4294967294." } },
      { name: "dns", label: "DNS support", kind: "checkbox", default: true, section: "Configure the transit gateway" },
      { name: "ecmp", label: "VPN ECMP support", kind: "checkbox", default: true, section: "Configure the transit gateway" },
      { name: "defaultAssociation", label: "Default route table association", kind: "checkbox", default: true, section: "Configure the transit gateway", help: "New attachments are associated with the default route table." },
      { name: "defaultPropagation", label: "Default route table propagation", kind: "checkbox", default: true, section: "Configure the transit gateway", help: "New attachments propagate their routes to the default route table." },
      { name: "multicast", label: "Multicast support", kind: "checkbox", default: false, section: "Configure the transit gateway" },
      { name: "autoAccept", label: "Auto accept shared attachments", kind: "checkbox", default: false, section: "Configure cross-account sharing options" },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const r = await ctx.clients.ec2.send(
        new CreateTransitGatewayCommand({
          Description: text(v.description) || undefined,
          Options: {
            AmazonSideAsn: numOrUndef(v.asn),
            DnsSupport: enable(v.dns),
            VpnEcmpSupport: enable(v.ecmp),
            DefaultRouteTableAssociation: enable(v.defaultAssociation),
            DefaultRouteTablePropagation: enable(v.defaultPropagation),
            MulticastSupport: enable(v.multicast),
            AutoAcceptSharedAttachments: enable(v.autoAccept),
          },
          TagSpecifications: tagSpec("transit-gateway", withName(v.name, v.tags)),
        })
      );
      const id = r.TransitGateway?.TransitGatewayId;
      if (!id) throw new Error("CreateTransitGateway returned no ID.");
      return id;
    },
  },
  actions: tagActions,
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.ec2.send(new DeleteTransitGatewayCommand({ TransitGatewayId: id }));
    },
  },
};

export const tgwAttachments: ResourceDef = {
  id: "transit-gateway-attachments",
  name: "Transit gateway attachments",
  singular: "transit gateway attachment",
  idField: "id",
  description: "Attachments connect a VPC, VPN or peer transit gateway to a transit gateway.",
  emptyText: "You don't have any transit gateway attachments.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "id", label: "Transit gateway attachment ID", kind: "link" },
    { key: "tgwId", label: "Transit gateway ID", kind: "text" },
    { key: "resourceType", label: "Resource type", kind: "text" },
    { key: "resourceId", label: "Resource ID", kind: "text" },
    { key: "state", label: "State", kind: "status" },
    { key: "routeTable", label: "Association route table ID", kind: "text" },
    { key: "associationState", label: "Association state", kind: "status" },
  ],
  async list(ctx) {
    return (await describeTgwAttachments(ctx)).map((a) => ({
      name: nameOf(a.Tags),
      id: a.TransitGatewayAttachmentId ?? "",
      tgwId: a.TransitGatewayId ?? null,
      resourceType: a.ResourceType ?? null,
      resourceId: a.ResourceId ?? null,
      state: a.State ?? null,
      routeTable: a.Association?.TransitGatewayRouteTableId ?? null,
      associationState: a.Association?.State ?? null,
    }));
  },
  async get(ctx, id) {
    const a = one(await describeTgwAttachments(ctx, undefined, [id]), "Transit gateway attachment", id);
    return {
      summary: {
        "Transit gateway attachment ID": id,
        Name: nameOf(a.Tags),
        "Transit gateway ID": a.TransitGatewayId ?? null,
        "Resource type": a.ResourceType ?? null,
        "Resource ID": a.ResourceId ?? null,
        State: a.State ?? null,
        "Association route table ID": a.Association?.TransitGatewayRouteTableId ?? null,
        "Association state": a.Association?.State ?? null,
        Created: a.CreationTime ?? null,
      },
      tabs: [tagsTab(a.Tags)],
    };
  },
  create: {
    title: "Create transit gateway attachment",
    description: "Attaches a VPC to a transit gateway with CreateTransitGatewayVpcAttachment. (VPN attachments are created from Site-to-Site VPN connections.)",
    fields: [
      { name: "name", label: "Name tag", kind: "text", section: "Details" },
      { name: "tgwId", label: "Transit gateway ID", kind: "select", required: true, options: tgwOptions, section: "Details" },
      { name: "type", label: "Attachment type", kind: "select", default: "vpc", options: [{ value: "vpc", label: "VPC" }], section: "Details" },
      { name: "vpcId", label: "VPC ID", kind: "select", required: true, options: vpcOptions, section: "VPC attachment" },
      { name: "subnetIds", label: "Subnet IDs", kind: "multiselect", required: true, options: subnetOptions, section: "VPC attachment", help: "One subnet per Availability Zone, in the chosen VPC. The transit gateway places a network interface in each." },
      { name: "dns", label: "DNS support", kind: "checkbox", default: true, section: "VPC attachment" },
      { name: "ipv6", label: "IPv6 support", kind: "checkbox", default: false, section: "VPC attachment" },
      { name: "appliance", label: "Appliance Mode support", kind: "checkbox", default: false, section: "VPC attachment", help: "Keeps a flow in one Availability Zone, for stateful appliances." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const r = await ctx.clients.ec2.send(
        new CreateTransitGatewayVpcAttachmentCommand({
          TransitGatewayId: text(v.tgwId),
          VpcId: text(v.vpcId),
          SubnetIds: strings(v.subnetIds),
          Options: { DnsSupport: enable(v.dns), Ipv6Support: enable(v.ipv6), ApplianceModeSupport: enable(v.appliance) },
          TagSpecifications: tagSpec("transit-gateway-attachment", withName(v.name, v.tags)),
        })
      );
      const id = r.TransitGatewayVpcAttachment?.TransitGatewayAttachmentId;
      if (!id) throw new Error("CreateTransitGatewayVpcAttachment returned no ID.");
      return id;
    },
  },
  actions: tagActions,
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.ec2.send(new DeleteTransitGatewayVpcAttachmentCommand({ TransitGatewayAttachmentId: id }));
    },
  },
};

async function describeTgwRouteTables(ctx: Ctx, ids?: string[]): Promise<TransitGatewayRouteTable[]> {
  return collect(async (t) => {
    const r = await ctx.clients.ec2.send(new DescribeTransitGatewayRouteTablesCommand({ TransitGatewayRouteTableIds: ids, NextToken: t }));
    return { items: r.TransitGatewayRouteTables, next: r.NextToken };
  });
}

const ATTACHMENT_COLUMNS = [
  { key: "TransitGatewayAttachmentId", label: "Attachment ID", kind: "text" as const },
  { key: "ResourceType", label: "Resource type", kind: "text" as const },
  { key: "ResourceId", label: "Resource ID", kind: "text" as const },
  { key: "State", label: "State", kind: "status" as const },
];

async function propagations(ctx: Ctx, id: string) {
  return collect(async (t) => {
    const r = await ctx.clients.ec2.send(new GetTransitGatewayRouteTablePropagationsCommand({ TransitGatewayRouteTableId: id, NextToken: t }));
    return { items: r.TransitGatewayRouteTablePropagations, next: r.NextToken };
  });
}

export const tgwRouteTables: ResourceDef = {
  id: "transit-gateway-route-tables",
  name: "Transit gateway route tables",
  singular: "transit gateway route table",
  idField: "id",
  description: "Each attachment is associated with one route table; attachments can propagate routes to many.",
  emptyText: "You don't have any transit gateway route tables.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "id", label: "Transit gateway route table ID", kind: "link" },
    { key: "tgwId", label: "Transit gateway ID", kind: "text" },
    { key: "state", label: "State", kind: "status" },
    { key: "defaultAssociation", label: "Default association route table", kind: "boolean" },
    { key: "defaultPropagation", label: "Default propagation route table", kind: "boolean" },
  ],
  async list(ctx) {
    return (await describeTgwRouteTables(ctx)).map((t) => ({
      name: nameOf(t.Tags),
      id: t.TransitGatewayRouteTableId ?? "",
      tgwId: t.TransitGatewayId ?? null,
      state: t.State ?? null,
      defaultAssociation: t.DefaultAssociationRouteTable ?? false,
      defaultPropagation: t.DefaultPropagationRouteTable ?? false,
    }));
  },
  async get(ctx, id) {
    const t = one(await describeTgwRouteTables(ctx, [id]), "Transit gateway route table", id);
    const [assoc, props, routes] = await Promise.all([
      collect(async (tok) => {
        const r = await ctx.clients.ec2.send(new GetTransitGatewayRouteTableAssociationsCommand({ TransitGatewayRouteTableId: id, NextToken: tok }));
        return { items: r.Associations, next: r.NextToken };
      }),
      propagations(ctx, id),
      ctx.clients.ec2.send(new SearchTransitGatewayRoutesCommand({ TransitGatewayRouteTableId: id, Filters: [{ Name: "type", Values: ["static", "propagated"] }] })),
    ]);
    return {
      summary: {
        "Transit gateway route table ID": id,
        Name: nameOf(t.Tags),
        "Transit gateway ID": t.TransitGatewayId ?? null,
        State: t.State ?? null,
        "Default association route table": t.DefaultAssociationRouteTable ? "Yes" : "No",
        "Default propagation route table": t.DefaultPropagationRouteTable ? "Yes" : "No",
        Created: t.CreationTime ?? null,
      },
      tabs: [
        { id: "associations", label: "Associations", kind: "table", columns: ATTACHMENT_COLUMNS, data: assoc, emptyText: "No associations." },
        { id: "propagations", label: "Propagations", kind: "table", columns: ATTACHMENT_COLUMNS, data: props, emptyText: "No propagations." },
        {
          id: "routes",
          label: "Routes",
          kind: "table",
          columns: [
            { key: "cidr", label: "CIDR", kind: "text" },
            { key: "attachment", label: "Attachment", kind: "text" },
            { key: "resource", label: "Resource ID", kind: "text" },
            { key: "type", label: "Route type", kind: "text" },
            { key: "state", label: "Route state", kind: "status" },
          ],
          data: (routes.Routes ?? []).map((r) => ({
            cidr: r.DestinationCidrBlock ?? r.PrefixListId ?? null,
            attachment: r.TransitGatewayAttachments?.map((a) => a.TransitGatewayAttachmentId).join(", ") || null,
            resource: r.TransitGatewayAttachments?.map((a) => a.ResourceId).join(", ") || null,
            type: r.Type ?? null,
            state: r.State ?? null,
          })),
          emptyText: "No routes.",
        },
        tagsTab(t.Tags),
      ],
    };
  },
  create: {
    title: "Create transit gateway route table",
    fields: [
      { name: "name", label: "Name tag", kind: "text", section: "Details" },
      { name: "tgwId", label: "Transit gateway ID", kind: "select", required: true, options: tgwOptions, section: "Details" },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const r = await ctx.clients.ec2.send(new CreateTransitGatewayRouteTableCommand({ TransitGatewayId: text(v.tgwId), TagSpecifications: tagSpec("transit-gateway-route-table", withName(v.name, v.tags)) }));
      const id = r.TransitGatewayRouteTable?.TransitGatewayRouteTableId;
      if (!id) throw new Error("CreateTransitGatewayRouteTable returned no ID.");
      return id;
    },
  },
  actions: [
    {
      id: "associate",
      label: "Create association",
      fields: [{ name: "attachmentId", label: "Attachment", kind: "select", required: true, options: tgwAttachmentOptions, help: "An attachment can be associated with only one route table." }],
      async run(ctx, id, v) {
        const r = await ctx.clients.ec2.send(new AssociateTransitGatewayRouteTableCommand({ TransitGatewayRouteTableId: id, TransitGatewayAttachmentId: text(v.attachmentId) }));
        return { message: `Association ${r.Association?.State ?? "requested"} for ${text(v.attachmentId)}.` };
      },
    },
    {
      id: "propagate",
      label: "Create propagation",
      fields: [{ name: "attachmentId", label: "Attachment", kind: "select", required: true, options: tgwAttachmentOptions, help: "The attachment's CIDRs are added to this route table as propagated routes." }],
      async run(ctx, id, v) {
        const r = await ctx.clients.ec2.send(new EnableTransitGatewayRouteTablePropagationCommand({ TransitGatewayRouteTableId: id, TransitGatewayAttachmentId: text(v.attachmentId) }));
        return { message: `Propagation ${r.Propagation?.State ?? "requested"} for ${text(v.attachmentId)}.` };
      },
    },
    {
      id: "remove-propagations",
      label: "Delete propagation",
      async run(ctx, id) {
        const rows = (await propagations(ctx, id)).map((p) => ({ ...p, TransitGatewayAttachmentId: p.TransitGatewayAttachmentId ?? "" }));
        return { message: "Select propagations to delete.", table: { columns: ATTACHMENT_COLUMNS, rows, rowKey: "TransitGatewayAttachmentId", emptyText: "No propagations.", selectionAction: { actionId: "disable-propagations", label: "Delete", danger: true, valuesField: "attachments" } } };
      },
    },
    {
      id: "disable-propagations",
      label: "Delete selected propagations",
      hidden: true,
      danger: true,
      fields: [{ name: "attachments", label: "Attachments", kind: "multiselect", required: true }],
      async run(ctx, id, v) {
        const ids = strings(v.attachments);
        for (const a of ids) await ctx.clients.ec2.send(new DisableTransitGatewayRouteTablePropagationCommand({ TransitGatewayRouteTableId: id, TransitGatewayAttachmentId: a }));
        return { message: `Deleted ${ids.length} propagation${ids.length === 1 ? "" : "s"}.` };
      },
    },
    {
      id: "static-route",
      label: "Create static route",
      fields: [
        { name: "cidr", label: "CIDR", kind: "text", required: true, placeholder: "10.0.0.0/16", validate: { pattern: "\\d{1,3}(\\.\\d{1,3}){3}/\\d{1,2}", message: "Enter an IPv4 CIDR block." } },
        { name: "type", label: "Type", kind: "radio", default: "active", options: [{ value: "active", label: "Active" }, { value: "blackhole", label: "Blackhole (drop matching traffic)" }] },
        { name: "attachmentId", label: "Choose attachment", kind: "select", required: true, options: tgwAttachmentOptions, showIf: { field: "type", equals: "active" } },
      ],
      async run(ctx, id, v) {
        const blackhole = v.type === "blackhole";
        const r = await ctx.clients.ec2.send(
          new CreateTransitGatewayRouteCommand({ TransitGatewayRouteTableId: id, DestinationCidrBlock: text(v.cidr), Blackhole: blackhole || undefined, TransitGatewayAttachmentId: blackhole ? undefined : text(v.attachmentId) })
        );
        return { message: `Route ${text(v.cidr)} is ${r.Route?.State ?? "created"}.` };
      },
    },
    ...tagActions,
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.ec2.send(new DeleteTransitGatewayRouteTableCommand({ TransitGatewayRouteTableId: id }));
    },
  },
};
