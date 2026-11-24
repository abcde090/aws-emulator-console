/** Route tables: routes editor (add, replace, remove), subnet associations, main route table. */

import {
  AssociateRouteTableCommand,
  CreateRouteCommand,
  CreateRouteTableCommand,
  DeleteRouteCommand,
  DeleteRouteTableCommand,
  DisassociateRouteTableCommand,
  ReplaceRouteCommand,
  ReplaceRouteTableAssociationCommand,
  type Route,
  type RouteTable,
} from "@aws-sdk/client-ec2";
import type { Ctx, Option, Row, ResourceDef } from "../../console/types.ts";
import { byVpc, describeRouteTables, describeSubnets, one, routeTargetOptions, strings, subnetOptions, tagActions, tagsTab, tagSpec, text, vpcOptions } from "./ec2.ts";
import { destinationParam, nameOf, routeDestination, routeTarget, targetParam, withName } from "./helpers.ts";

const DEST_PATTERN = "(\\d{1,3}(\\.\\d{1,3}){3}/\\d{1,2})|([0-9a-fA-F:]+/\\d{1,3})|(pl-[0-9a-z]+)";

function routeRow(r: Route): Row {
  return {
    destination: routeDestination(r),
    target: routeTarget(r),
    state: r.State ?? null,
    propagated: r.Origin === "EnableVgwRoutePropagation" ? "Yes" : "No",
    origin: r.Origin ?? null,
  };
}

const ROUTE_COLUMNS = [
  { key: "destination", label: "Destination", kind: "text" as const },
  { key: "target", label: "Target", kind: "text" as const },
  { key: "state", label: "Status", kind: "status" as const },
  { key: "propagated", label: "Propagated", kind: "text" as const },
  { key: "origin", label: "Route Origin", kind: "text" as const },
];

const isMain = (t: RouteTable): boolean => Boolean(t.Associations?.some((a) => a.Main));
const explicitSubnets = (t: RouteTable) => (t.Associations ?? []).filter((a) => a.SubnetId);

const getTable = async (ctx: Parameters<ResourceDef["list"]>[0], id: string) => one(await describeRouteTables(ctx, undefined, [id]), "Route table", id);

/** Subnets in the route table's VPC (all subnets without a route table id). */
async function tableSubnetOptions(ctx: Ctx, id?: string): Promise<Option[]> {
  if (!id) return subnetOptions(ctx);
  const t = await getTable(ctx, id);
  return (await describeSubnets(ctx, byVpc(t.VpcId ?? ""))).filter((s) => s.SubnetId).map((s) => ({ value: s.SubnetId as string, label: `${s.SubnetId}${nameOf(s.Tags) ? ` (${nameOf(s.Tags)})` : ""} | ${s.CidrBlock ?? ""}` }));
}

/** The table's routes that can be edited (not the local route). */
async function editableRouteOptions(ctx: Ctx, id?: string): Promise<Option[]> {
  if (!id) return [];
  const t = await getTable(ctx, id);
  return (t.Routes ?? [])
    .filter((r) => r.GatewayId !== "local" && r.Origin !== "CreateRouteTable")
    .map((r) => ({ value: routeDestination(r), label: `${routeDestination(r)} → ${routeTarget(r)}` }))
    .filter((o) => o.value);
}

export const routeTables: ResourceDef = {
  id: "route-tables",
  name: "Route tables",
  singular: "route table",
  idField: "routeTableId",
  description: "A route table contains routes that determine where network traffic from your subnets or gateways is directed.",
  emptyText: "You don't have any route tables in this Region.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "routeTableId", label: "Route table ID", kind: "link" },
    { key: "subnets", label: "Explicit subnet associations", kind: "text" },
    { key: "edges", label: "Edge associations", kind: "text" },
    { key: "main", label: "Main", kind: "boolean" },
    { key: "vpcId", label: "VPC", kind: "text" },
    { key: "owner", label: "Owner ID", kind: "text" },
  ],
  async list(ctx) {
    return (await describeRouteTables(ctx)).map((t) => ({
      name: nameOf(t.Tags),
      routeTableId: t.RouteTableId ?? "",
      subnets: explicitSubnets(t).map((a) => a.SubnetId).join(", ") || null,
      edges: (t.Associations ?? []).filter((a) => a.GatewayId).map((a) => a.GatewayId).join(", ") || null,
      main: isMain(t),
      vpcId: t.VpcId ?? null,
      owner: t.OwnerId ?? null,
    }));
  },
  async get(ctx, id) {
    const t = await getTable(ctx, id);
    const vpcSubnets = isMain(t) ? await describeSubnets(ctx, byVpc(t.VpcId ?? "")) : [];
    const others = await (isMain(t) ? describeRouteTables(ctx, byVpc(t.VpcId ?? "")) : Promise.resolve([]));
    const explicitlyElsewhere = new Set(others.flatMap((o) => (o.RouteTableId === id ? [] : explicitSubnets(o).map((a) => a.SubnetId))));
    return {
      summary: {
        "Route table ID": id,
        Name: nameOf(t.Tags),
        Main: isMain(t) ? "Yes" : "No",
        "Explicit subnet associations": explicitSubnets(t).length,
        "Edge associations": (t.Associations ?? []).filter((a) => a.GatewayId).length,
        VPC: t.VpcId ?? null,
        "Owner ID": t.OwnerId ?? null,
      },
      tabs: [
        { id: "routes", label: "Routes", kind: "table", columns: ROUTE_COLUMNS, data: (t.Routes ?? []).map(routeRow), emptyText: "No routes." },
        {
          id: "subnet-associations",
          label: "Subnet associations",
          kind: "table",
          description: isMain(t) ? "Explicit associations. Subnets of this VPC without an explicit association also use this main route table:" : "Subnets explicitly associated with this route table.",
          columns: [
            { key: "subnet", label: "Subnet ID", kind: "text" },
            { key: "kind", label: "Association", kind: "text" },
            { key: "association", label: "Association ID", kind: "text" },
          ],
          data: [
            ...explicitSubnets(t).map((a) => ({ subnet: a.SubnetId ?? "", kind: "Explicit", association: a.RouteTableAssociationId ?? null })),
            ...vpcSubnets.filter((s) => s.SubnetId && !explicitlyElsewhere.has(s.SubnetId) && !explicitSubnets(t).some((a) => a.SubnetId === s.SubnetId)).map((s) => ({ subnet: s.SubnetId ?? "", kind: "Implicit (main route table)", association: null })),
          ],
          emptyText: "No subnet associations.",
        },
        {
          id: "edge-associations",
          label: "Edge associations",
          kind: "table",
          columns: [
            { key: "gateway", label: "Gateway ID", kind: "text" },
            { key: "association", label: "Association ID", kind: "text" },
          ],
          data: (t.Associations ?? []).filter((a) => a.GatewayId).map((a) => ({ gateway: a.GatewayId ?? "", association: a.RouteTableAssociationId ?? null })),
          emptyText: "No edge associations.",
        },
        {
          id: "propagation",
          label: "Route propagation",
          kind: "table",
          columns: [{ key: "GatewayId", label: "Virtual private gateway", kind: "text" }],
          data: t.PropagatingVgws ?? [],
          emptyText: "No route propagation.",
        },
        tagsTab(t.Tags),
      ],
    };
  },
  create: {
    title: "Create route table",
    description: "Creates a route table with CreateRouteTable. It starts with the local route for the VPC's CIDR blocks.",
    fields: [
      { name: "name", label: "Name", kind: "text", section: "Route table settings", placeholder: "my-route-table-01" },
      { name: "vpcId", label: "VPC", kind: "select", required: true, options: vpcOptions, section: "Route table settings", help: "The VPC to use for this route table." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const r = await ctx.clients.ec2.send(new CreateRouteTableCommand({ VpcId: text(v.vpcId), TagSpecifications: tagSpec("route-table", withName(v.name, v.tags)) }));
      const id = r.RouteTable?.RouteTableId;
      if (!id) throw new Error("CreateRouteTable returned no ID.");
      return id;
    },
  },
  actions: [
    {
      id: "add-route",
      label: "Add route",
      fields: [
        { name: "destination", label: "Destination", kind: "text", required: true, placeholder: "0.0.0.0/0", help: "An IPv4 or IPv6 CIDR block, or a prefix list ID.", validate: { pattern: DEST_PATTERN, message: "Enter a CIDR block such as 0.0.0.0/0, ::/0 or a prefix list ID (pl-...)." } },
        { name: "target", label: "Target", kind: "select", required: true, options: routeTargetOptions, help: "Where traffic for the destination goes. The target must be in (or attached to) this route table's VPC." },
      ],
      async run(ctx, id, v) {
        await ctx.clients.ec2.send(new CreateRouteCommand({ RouteTableId: id, ...destinationParam(text(v.destination)), ...targetParam(text(v.target)) }));
        return { message: `Added route ${text(v.destination)} → ${text(v.target)}.` };
      },
    },
    {
      id: "replace-route",
      label: "Edit route target",
      fields: [
        { name: "destination", label: "Route", kind: "select", required: true, options: editableRouteOptions, help: "An existing route of this table. The local route can't be changed." },
        { name: "target", label: "New target", kind: "select", required: true, options: routeTargetOptions },
      ],
      async run(ctx, id, v) {
        await ctx.clients.ec2.send(new ReplaceRouteCommand({ RouteTableId: id, ...destinationParam(text(v.destination)), ...targetParam(text(v.target)) }));
        return { message: `Route ${text(v.destination)} now goes to ${text(v.target)}.` };
      },
    },
    {
      id: "remove-routes",
      label: "Remove routes",
      async run(ctx, id) {
        const t = await getTable(ctx, id);
        const rows = (t.Routes ?? []).filter((r) => r.GatewayId !== "local" && r.Origin !== "CreateRouteTable").map(routeRow);
        return {
          message: "Select routes to remove. The local route can't be removed.",
          table: { columns: ROUTE_COLUMNS, rows, rowKey: "destination", emptyText: "No routes that can be removed.", selectionAction: { actionId: "delete-routes", label: "Remove", danger: true, valuesField: "destinations" } },
        };
      },
    },
    {
      id: "delete-routes",
      label: "Remove selected routes",
      hidden: true,
      danger: true,
      fields: [{ name: "destinations", label: "Destinations", kind: "multiselect", required: true }],
      async run(ctx, id, v) {
        const dests = strings(v.destinations);
        for (const d of dests) await ctx.clients.ec2.send(new DeleteRouteCommand({ RouteTableId: id, ...destinationParam(d) }));
        return { message: `Removed ${dests.length} route${dests.length === 1 ? "" : "s"}.` };
      },
    },
    {
      id: "associate-subnets",
      label: "Edit subnet associations",
      fields: [{ name: "subnetIds", label: "Explicitly associated subnets", kind: "multiselect", options: tableSubnetOptions, help: "Selected subnets move to this route table (a previous explicit association is replaced). Subnets you clear go back to the VPC's main route table." }],
      initialValues: async (ctx, id) => ({ subnetIds: explicitSubnets(await getTable(ctx, id)).map((a) => a.SubnetId ?? "").filter(Boolean) }),
      async run(ctx, id, v) {
        const wanted = strings(v.subnetIds);
        const t = await getTable(ctx, id);
        const mine = explicitSubnets(t);
        const add = wanted.filter((s) => !mine.some((a) => a.SubnetId === s));
        const remove = mine.filter((a) => a.SubnetId && !wanted.includes(a.SubnetId));
        if (!add.length && !remove.length) return { message: `No subnet association changes on ${id}.` };
        const tables = add.length ? await describeRouteTables(ctx, byVpc(t.VpcId ?? "")) : [];
        for (const subnetId of add) {
          const current = tables.flatMap((x) => x.Associations ?? []).find((a) => a.SubnetId === subnetId);
          if (current?.RouteTableAssociationId) await ctx.clients.ec2.send(new ReplaceRouteTableAssociationCommand({ AssociationId: current.RouteTableAssociationId, RouteTableId: id }));
          else await ctx.clients.ec2.send(new AssociateRouteTableCommand({ RouteTableId: id, SubnetId: subnetId }));
        }
        for (const a of remove) if (a.RouteTableAssociationId) await ctx.clients.ec2.send(new DisassociateRouteTableCommand({ AssociationId: a.RouteTableAssociationId }));
        return { message: `Associated ${add.length} subnet${add.length === 1 ? "" : "s"} with ${id}${remove.length ? `; ${remove.length} now use the main route table` : ""}.` };
      },
    },
    {
      id: "disassociate",
      label: "Remove subnet associations",
      async run(ctx, id) {
        const t = await getTable(ctx, id);
        const rows = explicitSubnets(t).map((a) => ({ subnet: a.SubnetId ?? "", association: a.RouteTableAssociationId ?? "" }));
        return {
          message: "Select subnets to disassociate. They then use the VPC's main route table.",
          table: {
            columns: [
              { key: "subnet", label: "Subnet ID", kind: "text" },
              { key: "association", label: "Association ID", kind: "text" },
            ],
            rows,
            rowKey: "association",
            emptyText: "No explicit subnet associations.",
            selectionAction: { actionId: "disassociate-selected", label: "Disassociate", danger: true, valuesField: "associations" },
          },
        };
      },
    },
    {
      id: "disassociate-selected",
      label: "Disassociate selected subnets",
      hidden: true,
      danger: true,
      fields: [{ name: "associations", label: "Associations", kind: "multiselect", required: true }],
      async run(ctx, id, v) {
        const t = await getTable(ctx, id);
        const mine = new Set(explicitSubnets(t).map((a) => a.RouteTableAssociationId));
        const ids = strings(v.associations).filter((a) => mine.has(a));
        for (const a of ids) await ctx.clients.ec2.send(new DisassociateRouteTableCommand({ AssociationId: a }));
        return { message: `Disassociated ${ids.length} subnet${ids.length === 1 ? "" : "s"}.` };
      },
    },
    {
      id: "set-main",
      label: "Set main route table",
      availableFor: (row) => row.main !== true && row.Main !== "Yes",
      confirm: "Subnets without an explicit association will use this route table instead of the current main route table.",
      async run(ctx, id) {
        const t = await getTable(ctx, id);
        if (isMain(t)) return { message: `${id} is already the main route table.` };
        const main = (await describeRouteTables(ctx, byVpc(t.VpcId ?? ""))).flatMap((x) => x.Associations ?? []).find((a) => a.Main);
        if (!main?.RouteTableAssociationId) throw new Error("The VPC's main route table association was not found.");
        await ctx.clients.ec2.send(new ReplaceRouteTableAssociationCommand({ AssociationId: main.RouteTableAssociationId, RouteTableId: id }));
        return { message: `${id} is now the main route table of ${t.VpcId ?? "its VPC"}.` };
      },
    },
    ...tagActions,
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.ec2.send(new DeleteRouteTableCommand({ RouteTableId: id }));
    },
  },
};
