/** Network & Security: Elastic IPs, Placement groups and Network interfaces. */

import {
  AllocateAddressCommand,
  AssociateAddressCommand,
  AttachNetworkInterfaceCommand,
  CreateNetworkInterfaceCommand,
  CreatePlacementGroupCommand,
  DeletePlacementGroupCommand,
  DeleteNetworkInterfaceCommand,
  DescribeAddressesCommand,
  DescribeNetworkInterfacesCommand,
  DescribePlacementGroupsCommand,
  DetachNetworkInterfaceCommand,
  DisassociateAddressCommand,
  ModifyNetworkInterfaceAttributeCommand,
  ReleaseAddressCommand,
  type Address,
  type NetworkInterface,
} from "@aws-sdk/client-ec2";
import type { Ctx, ResourceDef, Row, Tag } from "../../console/types.ts";
import { nameTag, strList, tagRows, withName } from "./helpers.ts";
import { liveInstanceOptions, networkInterfaceOptions, securityGroupOptions, subnetOptions, tagSpec } from "./options.ts";

const TAG_COLUMNS = [
  { key: "Key", label: "Key", kind: "text" as const },
  { key: "Value", label: "Value", kind: "text" as const },
];
const tagsOf = (v: unknown): Tag[] => (Array.isArray(v) ? (v as Tag[]) : []);

// ---- Elastic IPs ----

function addressRow(a: Address): Row {
  return {
    name: nameTag(a.Tags),
    publicIp: a.PublicIp ?? null,
    type: "Public IP",
    allocationId: a.AllocationId ?? "",
    instanceId: a.InstanceId ?? null,
    privateIp: a.PrivateIpAddress ?? null,
    associationId: a.AssociationId ?? null,
    eni: a.NetworkInterfaceId ?? null,
    borderGroup: a.NetworkBorderGroup ?? null,
    domain: a.Domain ?? null,
  };
}

async function oneAddress(ctx: Ctx, id: string): Promise<Address> {
  const a = (await ctx.clients.ec2.send(new DescribeAddressesCommand({ AllocationIds: [id] }))).Addresses?.[0];
  if (!a) throw new Error(`Elastic IP ${id} was not found.`);
  return a;
}

export const elasticIps: ResourceDef = {
  id: "elastic-ips",
  name: "Elastic IPs",
  singular: "Elastic IP address",
  idField: "allocationId",
  nameField: "Allocated IPv4 address",
  description: "Static public IPv4 addresses you can move between instances and network interfaces.",
  emptyText: "You don't have any Elastic IP addresses.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "publicIp", label: "Allocated IPv4 address", kind: "text" },
    { key: "type", label: "Type", kind: "text" },
    { key: "allocationId", label: "Allocation ID", kind: "link" },
    { key: "instanceId", label: "Associated instance ID", kind: "text" },
    { key: "privateIp", label: "Private IP address", kind: "text" },
    { key: "associationId", label: "Association ID", kind: "text" },
    { key: "eni", label: "Network interface ID", kind: "text" },
    { key: "borderGroup", label: "Network border group", kind: "text" },
  ],
  async list(ctx) {
    return ((await ctx.clients.ec2.send(new DescribeAddressesCommand({}))).Addresses ?? []).map(addressRow);
  },
  async get(ctx, id) {
    const a = await oneAddress(ctx, id);
    const row = addressRow(a);
    return {
      summary: { "Allocated IPv4 address": a.PublicIp ?? null, "Allocation ID": id, Type: "Public IP", Scope: a.Domain ?? null, "Associated instance ID": row.instanceId, "Network interface ID": row.eni },
      tabs: [
        { id: "details", label: "Details", kind: "keyvalue", data: { "Association ID": row.associationId, "Private IP address": row.privateIp, "Network interface owner": a.NetworkInterfaceOwnerId ?? null, "Network border group": row.borderGroup, "Public IPv4 pool": a.PublicIpv4Pool ?? null } },
        { id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: tagRows(a.Tags), emptyText: "No tags." },
      ],
    };
  },
  create: {
    title: "Allocate Elastic IP address",
    description: "Allocates a public IPv4 address from Amazon's pool with AllocateAddress.",
    fields: [
      { name: "borderGroup", label: "Network border group", kind: "select", required: true, section: "Elastic IP address settings", options: async (ctx) => [{ value: ctx.region, label: ctx.region }], help: "The Region selected in the top bar." },
      { name: "pool", label: "Public IPv4 address pool", kind: "radio", default: "amazon", section: "Elastic IP address settings", options: [{ value: "amazon", label: "Amazon's pool of IPv4 addresses" }] },
      { name: "name", label: "Name", kind: "text", section: "Tags" },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const r = await ctx.clients.ec2.send(new AllocateAddressCommand({ Domain: "vpc", NetworkBorderGroup: String(v.borderGroup || ctx.region), TagSpecifications: tagSpec("elastic-ip", withName(v.name, tagsOf(v.tags))) }));
      if (!r.AllocationId) throw new Error("AllocateAddress returned no allocation ID.");
      return r.AllocationId;
    },
  },
  actions: [
    {
      id: "associate",
      label: "Associate Elastic IP address",
      fields: [
        { name: "resourceType", label: "Resource type", kind: "radio", default: "instance", options: [{ value: "instance", label: "Instance" }, { value: "eni", label: "Network interface" }] },
        { name: "instanceId", label: "Instance", kind: "select", required: true, options: liveInstanceOptions, showIf: { field: "resourceType", equals: "instance" } },
        { name: "eni", label: "Network interface", kind: "select", required: true, options: networkInterfaceOptions, showIf: { field: "resourceType", equals: "eni" } },
        { name: "privateIp", label: "Private IP address", kind: "text", help: "Optional: a private IP of the instance or interface.", validate: { pattern: "\\d{1,3}(\\.\\d{1,3}){3}", message: "An IPv4 address." } },
        { name: "reassociate", label: "Allow this Elastic IP address to be reassociated", kind: "checkbox", default: false },
      ],
      async run(ctx, id, v) {
        const r = await ctx.clients.ec2.send(
          new AssociateAddressCommand({
            AllocationId: id,
            InstanceId: v.resourceType === "instance" ? String(v.instanceId) : undefined,
            NetworkInterfaceId: v.resourceType === "eni" ? String(v.eni) : undefined,
            PrivateIpAddress: typeof v.privateIp === "string" && v.privateIp ? v.privateIp : undefined,
            AllowReassociation: v.reassociate === true,
          })
        );
        return { message: `Elastic IP address associated. Association ID: ${r.AssociationId ?? "-"}.` };
      },
    },
    {
      id: "disassociate",
      label: "Disassociate Elastic IP address",
      confirm: "The instance or network interface loses this public address.",
      async run(ctx, id) {
        const a = await oneAddress(ctx, id);
        if (!a.AssociationId) throw new Error("This Elastic IP address is not associated.");
        await ctx.clients.ec2.send(new DisassociateAddressCommand({ AssociationId: a.AssociationId }));
        return { message: `Disassociated ${a.PublicIp ?? id}.` };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.ec2.send(new ReleaseAddressCommand({ AllocationId: id }));
    },
  },
};

// ---- Placement groups ----

export const placementGroups: ResourceDef = {
  id: "placement-groups",
  name: "Placement Groups",
  singular: "placement group",
  idField: "groupName",
  nameField: "Group name",
  description: "Influence how instances are placed on hardware: cluster, spread or partition.",
  emptyText: "You don't have any placement groups.",
  columns: [
    { key: "groupName", label: "Group name", kind: "link" },
    { key: "groupId", label: "Group ID", kind: "text" },
    { key: "strategy", label: "Strategy", kind: "text" },
    { key: "state", label: "State", kind: "status" },
    { key: "partitions", label: "Partition count", kind: "count" },
    { key: "spreadLevel", label: "Spread level", kind: "text" },
    { key: "arn", label: "Group ARN", kind: "arn", hidden: true },
  ],
  async list(ctx) {
    return ((await ctx.clients.ec2.send(new DescribePlacementGroupsCommand({}))).PlacementGroups ?? []).map((g) => ({
      groupName: g.GroupName ?? "",
      groupId: g.GroupId ?? null,
      strategy: g.Strategy ?? null,
      state: g.State ?? null,
      partitions: g.PartitionCount ?? null,
      spreadLevel: g.SpreadLevel ?? null,
      arn: g.GroupArn ?? null,
    }));
  },
  async get(ctx, id) {
    const g = (await ctx.clients.ec2.send(new DescribePlacementGroupsCommand({ GroupNames: [id] }))).PlacementGroups?.[0];
    if (!g) throw new Error(`Placement group ${id} was not found.`);
    return {
      summary: { "Group name": g.GroupName ?? id, "Group ID": g.GroupId ?? null, Strategy: g.Strategy ?? null, State: g.State ?? null, "Partition count": g.PartitionCount ?? null, "Spread level": g.SpreadLevel ?? null, ARN: g.GroupArn ?? null },
      tabs: [{ id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: tagRows(g.Tags), emptyText: "No tags." }],
    };
  },
  create: {
    title: "Create placement group",
    description: "Creates a placement group with CreatePlacementGroup.",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, section: "Placement group settings", validate: { pattern: "[\\x20-\\x7E]{1,255}", message: "Up to 255 ASCII characters." } },
      {
        name: "strategy", label: "Placement strategy", kind: "select", required: true, default: "cluster", section: "Placement group settings",
        options: [
          { value: "cluster", label: "Cluster: packs instances close together in one AZ (low latency)" },
          { value: "spread", label: "Spread: places instances on distinct hardware" },
          { value: "partition", label: "Partition: spreads instances across logical partitions" },
        ],
      },
      { name: "spreadLevel", label: "Spread level", kind: "select", default: "rack", section: "Placement group settings", showIf: { field: "strategy", equals: "spread" }, options: [{ value: "rack", label: "Rack - No restrictions" }, { value: "host", label: "Host - for Outposts only" }] },
      { name: "partitions", label: "Number of partitions", kind: "number", default: 2, section: "Placement group settings", showIf: { field: "strategy", equals: "partition" }, validate: { min: 1, max: 7, message: "Between 1 and 7." } },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const strategy = String(v.strategy) as "cluster" | "spread" | "partition";
      await ctx.clients.ec2.send(
        new CreatePlacementGroupCommand({
          GroupName: String(v.name),
          Strategy: strategy,
          SpreadLevel: strategy === "spread" ? (String(v.spreadLevel || "rack") as "rack" | "host") : undefined,
          PartitionCount: strategy === "partition" && typeof v.partitions === "number" ? v.partitions : undefined,
          TagSpecifications: tagSpec("placement-group", tagsOf(v.tags)),
        })
      );
      return String(v.name);
    },
  },
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.ec2.send(new DeletePlacementGroupCommand({ GroupName: id }));
    },
  },
};

// ---- Network interfaces ----

function eniRow(n: NetworkInterface): Row {
  return {
    name: nameTag(n.TagSet),
    eniId: n.NetworkInterfaceId ?? "",
    subnetId: n.SubnetId ?? null,
    vpcId: n.VpcId ?? null,
    az: n.AvailabilityZone ?? null,
    groups: (n.Groups ?? []).map((g) => g.GroupName).join(", ") || null,
    interfaceType: n.InterfaceType ?? null,
    description: n.Description || null,
    instanceId: n.Attachment?.InstanceId ?? null,
    status: n.Status ?? null,
    publicIp: n.Association?.PublicIp ?? null,
    privateIp: n.PrivateIpAddress ?? null,
    sourceDest: n.SourceDestCheck ?? null,
  };
}

/** Security groups in the network interface's VPC. */
async function eniGroupOptions(ctx: Ctx, id?: string) {
  const all = await securityGroupOptions(ctx);
  if (!id) return all;
  const vpc = (await oneEni(ctx, id)).VpcId;
  return vpc ? all.filter((o) => o.label.endsWith(` - ${vpc}`)) : all;
}

async function oneEni(ctx: Ctx, id: string): Promise<NetworkInterface> {
  const n = (await ctx.clients.ec2.send(new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [id] }))).NetworkInterfaces?.[0];
  if (!n) throw new Error(`Network interface ${id} was not found.`);
  return n;
}

export const networkInterfaces: ResourceDef = {
  id: "network-interfaces",
  name: "Network Interfaces",
  singular: "network interface",
  idField: "eniId",
  nameField: "Network interface ID",
  description: "Elastic network interfaces (ENIs): virtual network cards for instances and AWS services.",
  emptyText: "You don't have any network interfaces.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "eniId", label: "Network interface ID", kind: "link" },
    { key: "subnetId", label: "Subnet ID", kind: "text" },
    { key: "vpcId", label: "VPC ID", kind: "text" },
    { key: "az", label: "Availability Zone", kind: "text" },
    { key: "groups", label: "Security group names", kind: "text" },
    { key: "interfaceType", label: "Interface Type", kind: "text" },
    { key: "description", label: "Description", kind: "text" },
    { key: "instanceId", label: "Instance ID", kind: "text" },
    { key: "status", label: "Status", kind: "status" },
    { key: "publicIp", label: "Public IPv4 address", kind: "text" },
    { key: "privateIp", label: "Primary private IPv4 address", kind: "text" },
  ],
  async list(ctx) {
    return ((await ctx.clients.ec2.send(new DescribeNetworkInterfacesCommand({}))).NetworkInterfaces ?? []).map(eniRow);
  },
  async get(ctx, id) {
    const n = await oneEni(ctx, id);
    const row = eniRow(n);
    return {
      summary: { "Network interface ID": id, Description: row.description, Status: row.status, "Interface type": row.interfaceType, "VPC ID": row.vpcId, "Subnet ID": row.subnetId },
      tabs: [
        {
          id: "details",
          label: "Details",
          kind: "keyvalue",
          data: {
            "Availability Zone": row.az,
            "Primary private IPv4 address": row.privateIp,
            "Private IPv4 DNS": n.PrivateDnsName ?? null,
            "Public IPv4 address": row.publicIp,
            "MAC address": n.MacAddress ?? null,
            "Source/dest. check": n.SourceDestCheck ?? null,
            "Requester managed": n.RequesterManaged ?? null,
            Owner: n.OwnerId ?? null,
            "Instance ID": row.instanceId,
            "Attachment ID": n.Attachment?.AttachmentId ?? null,
            "Device index": n.Attachment?.DeviceIndex ?? null,
            "Delete on termination": n.Attachment?.DeleteOnTermination ?? null,
            "Security groups": (n.Groups ?? []).map((g) => `${g.GroupId} (${g.GroupName})`).join(", ") || null,
          },
        },
        { id: "ips", label: "Private IP addresses", kind: "table", columns: [{ key: "ip", label: "Private IPv4 address", kind: "text" }, { key: "primary", label: "Primary", kind: "boolean" }, { key: "public", label: "Public IPv4 address", kind: "text" }], data: (n.PrivateIpAddresses ?? []).map((p) => ({ ip: p.PrivateIpAddress ?? null, primary: p.Primary ?? null, public: p.Association?.PublicIp ?? null })), emptyText: "No private IP addresses." },
        { id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: tagRows(n.TagSet), emptyText: "No tags." },
      ],
    };
  },
  create: {
    title: "Create network interface",
    description: "Creates an elastic network interface with CreateNetworkInterface.",
    fields: [
      { name: "description", label: "Description", kind: "text", section: "Details", validate: { max: 255, message: "At most 255 characters." } },
      { name: "subnetId", label: "Subnet", kind: "select", required: true, options: subnetOptions, section: "Details" },
      { name: "ipMode", label: "Private IPv4 address", kind: "radio", default: "auto", section: "Details", options: [{ value: "auto", label: "Auto-assign" }, { value: "custom", label: "Custom" }] },
      { name: "privateIp", label: "IPv4 address", kind: "text", required: true, section: "Details", showIf: { field: "ipMode", equals: "custom" }, validate: { pattern: "\\d{1,3}(\\.\\d{1,3}){3}", message: "An IPv4 address in the subnet's range." } },
      { name: "groups", label: "Security groups", kind: "multiselect", options: securityGroupOptions, section: "Security groups", help: "Groups must be in the subnet's VPC. None selected uses the VPC's default group." },
      { name: "name", label: "Name", kind: "text", section: "Tags" },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const groups = strList(v.groups);
      const r = await ctx.clients.ec2.send(
        new CreateNetworkInterfaceCommand({
          SubnetId: String(v.subnetId),
          Description: typeof v.description === "string" && v.description ? v.description : undefined,
          PrivateIpAddress: v.ipMode === "custom" ? String(v.privateIp) : undefined,
          Groups: groups.length ? groups : undefined,
          TagSpecifications: tagSpec("network-interface", withName(v.name, tagsOf(v.tags))),
        })
      );
      const id = r.NetworkInterface?.NetworkInterfaceId;
      if (!id) throw new Error("CreateNetworkInterface returned no ID.");
      return id;
    },
  },
  actions: [
    {
      id: "attach",
      label: "Attach",
      fields: [
        { name: "instanceId", label: "Instance", kind: "select", required: true, options: liveInstanceOptions, help: "Must be in the same Availability Zone." },
        { name: "deviceIndex", label: "Device index", kind: "number", default: 1, validate: { min: 1, max: 15, message: "Between 1 and 15." } },
      ],
      async run(ctx, id, v) {
        const r = await ctx.clients.ec2.send(new AttachNetworkInterfaceCommand({ NetworkInterfaceId: id, InstanceId: String(v.instanceId), DeviceIndex: typeof v.deviceIndex === "number" ? v.deviceIndex : 1 }));
        return { message: `Attached. Attachment ID: ${r.AttachmentId ?? "-"}.` };
      },
    },
    {
      id: "detach",
      label: "Detach",
      fields: [{ name: "force", label: "Force detachment", kind: "checkbox", default: false }],
      async run(ctx, id, v) {
        const n = await oneEni(ctx, id);
        if (!n.Attachment?.AttachmentId) throw new Error("This network interface is not attached.");
        await ctx.clients.ec2.send(new DetachNetworkInterfaceCommand({ AttachmentId: n.Attachment.AttachmentId, Force: v.force === true || undefined }));
        return { message: `Detaching from ${n.Attachment.InstanceId ?? "the instance"}.` };
      },
    },
    {
      id: "security-groups",
      label: "Change security groups",
      fields: [{ name: "groups", label: "Security groups", kind: "multiselect", required: true, options: eniGroupOptions, help: "Security groups in the network interface's VPC." }],
      async initialValues(ctx, id) {
        return { groups: ((await oneEni(ctx, id)).Groups ?? []).map((g) => g.GroupId).filter((g): g is string => Boolean(g)) };
      },
      async run(ctx, id, v) {
        await ctx.clients.ec2.send(new ModifyNetworkInterfaceAttributeCommand({ NetworkInterfaceId: id, Groups: strList(v.groups) }));
        return { message: "Security groups changed." };
      },
    },
    {
      id: "source-dest",
      label: "Change source/dest. check",
      fields: [{ name: "enabled", label: "Source/destination checking: Enable", kind: "checkbox", default: true, help: "Turn off for NAT instances and appliances that forward traffic." }],
      async initialValues(ctx, id) {
        return { enabled: (await oneEni(ctx, id)).SourceDestCheck !== false };
      },
      async run(ctx, id, v) {
        await ctx.clients.ec2.send(new ModifyNetworkInterfaceAttributeCommand({ NetworkInterfaceId: id, SourceDestCheck: { Value: v.enabled === true } }));
        return { message: `Source/dest. check ${v.enabled === true ? "enabled" : "disabled"}.` };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.ec2.send(new DeleteNetworkInterfaceCommand({ NetworkInterfaceId: id }));
    },
  },
};
