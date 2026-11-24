/** DMS replication instances, endpoints and subnet groups. */

import {
  CreateEndpointCommand,
  CreateReplicationInstanceCommand,
  CreateReplicationSubnetGroupCommand,
  DeleteEndpointCommand,
  DeleteReplicationInstanceCommand,
  DeleteReplicationSubnetGroupCommand,
  DescribeEndpointsCommand,
  DescribeReplicationInstancesCommand,
  DescribeReplicationSubnetGroupsCommand,
  type DmsSslModeValue,
  type Endpoint,
  type ReplicationEndpointTypeValue,
  type ReplicationInstance,
  type ReplicationSubnetGroup,
} from "@aws-sdk/client-database-migration-service";
import { DescribeSecurityGroupsCommand, DescribeSubnetsCommand } from "@aws-sdk/client-ec2";
import type { Ctx, Option, ResourceDef, Tag } from "../../console/types.ts";
import { defaultPort, endpointTypeLabel } from "./helpers.ts";

const IDENT = { pattern: "[a-zA-Z][a-zA-Z0-9]*(-[a-zA-Z0-9]+)*", message: "Letters, numbers and single hyphens, starting with a letter; no trailing hyphen." };
const optStr = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const optNum = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const strList = (v: unknown): string[] | undefined => (Array.isArray(v) && v.length ? v.filter((x): x is string => typeof x === "string") : undefined);
const tagsOf = (v: unknown): Tag[] | undefined => (Array.isArray(v) && v.length ? (v as Tag[]) : undefined);

type Filter = { Name: string; Values: string[] };

async function pages<T>(fetch: (marker: string | undefined) => Promise<{ items?: T[]; marker?: string }>): Promise<T[]> {
  const out: T[] = [];
  let marker: string | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await fetch(marker);
    out.push(...(r.items ?? []));
    if (!r.marker || r.marker === marker) break;
    marker = r.marker;
  }
  return out;
}

export function replicationInstances(ctx: Ctx, id?: string): Promise<ReplicationInstance[]> {
  const Filters: Filter[] | undefined = id ? [{ Name: "replication-instance-id", Values: [id] }] : undefined;
  return pages(async (Marker) => {
    const r = await ctx.clients.dms.send(new DescribeReplicationInstancesCommand({ Filters, Marker, MaxRecords: 100 }));
    return { items: r.ReplicationInstances, marker: r.Marker };
  });
}

export function endpoints(ctx: Ctx, id?: string): Promise<Endpoint[]> {
  const Filters: Filter[] | undefined = id ? [{ Name: "endpoint-id", Values: [id] }] : undefined;
  return pages(async (Marker) => {
    const r = await ctx.clients.dms.send(new DescribeEndpointsCommand({ Filters, Marker, MaxRecords: 100 }));
    return { items: r.Endpoints, marker: r.Marker };
  });
}

function subnetGroups(ctx: Ctx, id?: string): Promise<ReplicationSubnetGroup[]> {
  const Filters: Filter[] | undefined = id ? [{ Name: "replication-subnet-group-id", Values: [id] }] : undefined;
  return pages(async (Marker) => {
    const r = await ctx.clients.dms.send(new DescribeReplicationSubnetGroupsCommand({ Filters, Marker, MaxRecords: 100 }));
    return { items: r.ReplicationSubnetGroups, marker: r.Marker };
  });
}

async function subnetGroupOptions(ctx: Ctx): Promise<Option[]> {
  return (await subnetGroups(ctx))
    .filter((g) => g.ReplicationSubnetGroupIdentifier)
    .map((g) => ({ value: g.ReplicationSubnetGroupIdentifier as string, label: `${g.ReplicationSubnetGroupIdentifier} (${g.VpcId ?? ""})` }));
}

async function securityGroupOptions(ctx: Ctx): Promise<Option[]> {
  const groups = await pages(async (NextToken) => {
    const r = await ctx.clients.ec2.send(new DescribeSecurityGroupsCommand({ NextToken, MaxResults: 1000 }));
    return { items: r.SecurityGroups, marker: r.NextToken };
  });
  return groups.filter((g) => g.GroupId).map((g) => ({ value: g.GroupId as string, label: `${g.GroupName ?? g.GroupId} (${g.GroupId}, ${g.VpcId ?? ""})` }));
}

async function subnetOptions(ctx: Ctx): Promise<Option[]> {
  const subnets = await pages(async (NextToken) => {
    const r = await ctx.clients.ec2.send(new DescribeSubnetsCommand({ NextToken, MaxResults: 1000 }));
    return { items: r.Subnets, marker: r.NextToken };
  });
  return subnets.filter((s) => s.SubnetId).map((s) => ({ value: s.SubnetId as string, label: `${s.SubnetId} (${s.AvailabilityZone ?? "?"}, ${s.CidrBlock ?? ""}, ${s.VpcId ?? ""})` }));
}

async function arnFor<T>(items: Promise<T[]>, pick: (t: T) => string | undefined, what: string, id: string): Promise<string> {
  const [first] = await items;
  const arn = first ? pick(first) : undefined;
  if (!arn) throw new Error(`${what} ${id} was not found.`);
  return arn;
}

const INSTANCE_CLASSES: Option[] = ["dms.t3.micro", "dms.t3.small", "dms.t3.medium", "dms.t3.large", "dms.c5.large", "dms.c5.xlarge", "dms.r5.large", "dms.r5.xlarge"].map((c) => ({ value: c, label: c }));

export const instanceResource: ResourceDef = {
  id: "replication-instances",
  name: "Replication instances",
  singular: "replication instance",
  idField: "id",
  nameField: "id",
  description: "Replication instances run your database migration tasks.",
  emptyText: "No replication instances. Create one to run migration tasks.",
  columns: [
    { key: "id", label: "Name", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "class", label: "Class", kind: "text" },
    { key: "engineVersion", label: "Engine version", kind: "text" },
    { key: "zone", label: "Availability Zone", kind: "text" },
    { key: "multiAz", label: "Multi-AZ", kind: "boolean" },
    { key: "publicIp", label: "Public IP address", kind: "text" },
    { key: "storage", label: "Allocated storage (GB)", kind: "count" },
    { key: "created", label: "Created", kind: "date", hidden: true },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],
  async list(ctx) {
    return (await replicationInstances(ctx)).map((r) => ({
      id: r.ReplicationInstanceIdentifier ?? "",
      status: r.ReplicationInstanceStatus ?? null,
      class: r.ReplicationInstanceClass ?? null,
      engineVersion: r.EngineVersion ?? null,
      zone: r.AvailabilityZone ?? null,
      multiAz: r.MultiAZ ?? null,
      publicIp: r.ReplicationInstancePublicIpAddresses?.[0] ?? r.ReplicationInstancePublicIpAddress ?? null,
      storage: r.AllocatedStorage ?? null,
      created: r.InstanceCreateTime ?? null,
      arn: r.ReplicationInstanceArn ?? null,
    }));
  },
  async get(ctx, id) {
    const [r] = await replicationInstances(ctx, id);
    if (!r) throw new Error(`Replication instance ${id} was not found.`);
    return {
      summary: {
        Name: id,
        Status: r.ReplicationInstanceStatus ?? null,
        Class: r.ReplicationInstanceClass ?? null,
        "Engine version": r.EngineVersion ?? null,
        ARN: r.ReplicationInstanceArn ?? null,
        Created: r.InstanceCreateTime ?? null,
      },
      tabs: [
        {
          id: "details", label: "Details", kind: "keyvalue",
          data: {
            "Allocated storage (GB)": r.AllocatedStorage ?? null,
            "Multi-AZ": r.MultiAZ ? "Yes" : "No",
            "Availability Zone": r.AvailabilityZone ?? null,
            "Secondary Availability Zone": r.SecondaryAvailabilityZone ?? null,
            "Publicly accessible": r.PubliclyAccessible ? "Yes" : "No",
            "Public IP addresses": (r.ReplicationInstancePublicIpAddresses ?? []).join(", ") || null,
            "Private IP addresses": (r.ReplicationInstancePrivateIpAddresses ?? []).join(", ") || null,
            "Replication subnet group": r.ReplicationSubnetGroup?.ReplicationSubnetGroupIdentifier ?? null,
            "VPC": r.ReplicationSubnetGroup?.VpcId ?? null,
            "VPC security groups": r.VpcSecurityGroups?.map((g) => g.VpcSecurityGroupId).filter(Boolean).join(", ") || null,
            "KMS key": r.KmsKeyId ?? null,
            "Maintenance window": r.PreferredMaintenanceWindow ?? null,
            "Auto minor version upgrade": r.AutoMinorVersionUpgrade ? "Yes" : "No",
            "Network type": r.NetworkType ?? null,
          },
        },
      ],
    };
  },
  create: {
    title: "Create replication instance",
    description: "Creates a replication instance in the emulator with CreateReplicationInstance.",
    fields: [
      { name: "id", label: "Name", kind: "text", required: true, section: "Instance configuration", help: "Unique in this Region; stored in lowercase.", validate: IDENT },
      { name: "description", label: "Descriptive Amazon Resource Name (ARN)", kind: "text", section: "Instance configuration", help: "A friendly name to use instead of the default ARN." },
      { name: "class", label: "Instance class", kind: "select", required: true, default: "dms.t3.medium", options: INSTANCE_CLASSES, section: "Instance configuration" },
      { name: "engineVersion", label: "Engine version", kind: "text", section: "Instance configuration", placeholder: "3.5.4", help: "Leave empty for the default version." },
      { name: "multiAz", label: "High availability", kind: "radio", default: "single", section: "Instance configuration", options: [{ value: "single", label: "Dev or test workload (Single-AZ)" }, { value: "multi", label: "Production workload (Multi-AZ)" }] },
      { name: "storage", label: "Allocated storage (GiB)", kind: "number", default: 50, section: "Storage", validate: { min: 5, max: 6144, message: "Between 5 and 6144 GiB." } },
      { name: "subnetGroup", label: "Replication subnet group", kind: "select", default: "", options: subnetGroupOptions, section: "Connectivity and security", help: "Leave empty to use the default VPC." },
      { name: "publiclyAccessible", label: "Public accessible", kind: "checkbox", default: false, section: "Connectivity and security" },
      { name: "securityGroups", label: "VPC security groups", kind: "multiselect", options: securityGroupOptions, section: "Connectivity and security" },
      { name: "kmsKey", label: "AWS KMS key", kind: "text", section: "Connectivity and security", help: "Leave empty for the aws/dms key." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const id = String(v.id).toLowerCase();
      await ctx.clients.dms.send(new CreateReplicationInstanceCommand({
        ReplicationInstanceIdentifier: id,
        ReplicationInstanceClass: String(v.class),
        EngineVersion: optStr(v.engineVersion),
        MultiAZ: v.multiAz === "multi",
        AllocatedStorage: optNum(v.storage),
        ReplicationSubnetGroupIdentifier: optStr(v.subnetGroup),
        PubliclyAccessible: v.publiclyAccessible === true,
        VpcSecurityGroupIds: strList(v.securityGroups),
        KmsKeyId: optStr(v.kmsKey),
        ResourceIdentifier: optStr(v.description),
        Tags: tagsOf(v.tags),
      }));
      return id;
    },
  },
  delete: {
    confirmText: "name",
    async run(ctx, id) {
      const arn = await arnFor(replicationInstances(ctx, id), (r) => r.ReplicationInstanceArn, "Replication instance", id);
      await ctx.clients.dms.send(new DeleteReplicationInstanceCommand({ ReplicationInstanceArn: arn }));
    },
  },
};

const ENGINES: Option[] = [
  { value: "mysql", label: "MySQL" },
  { value: "mariadb", label: "MariaDB" },
  { value: "postgres", label: "PostgreSQL" },
  { value: "aurora", label: "Amazon Aurora MySQL" },
  { value: "aurora-postgresql", label: "Amazon Aurora PostgreSQL" },
  { value: "oracle", label: "Oracle" },
  { value: "sqlserver", label: "Microsoft SQL Server" },
];

export const endpointResource: ResourceDef = {
  id: "endpoints",
  name: "Endpoints",
  singular: "endpoint",
  idField: "id",
  nameField: "id",
  description: "Connection details for the source and target data stores of a migration.",
  emptyText: "No endpoints. Create a source and a target endpoint.",
  columns: [
    { key: "id", label: "Name", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "type", label: "Endpoint type", kind: "text" },
    { key: "engine", label: "Engine", kind: "text" },
    { key: "server", label: "Server name", kind: "text" },
    { key: "port", label: "Port", kind: "text" },
    { key: "database", label: "Database", kind: "text" },
    { key: "ssl", label: "SSL mode", kind: "text", hidden: true },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],
  async list(ctx) {
    return (await endpoints(ctx)).map((e) => ({
      id: e.EndpointIdentifier ?? "",
      status: e.Status ?? null,
      type: endpointTypeLabel(e.EndpointType),
      engine: e.EngineDisplayName ?? e.EngineName ?? null,
      server: e.ServerName ?? null,
      port: e.Port ?? null,
      database: e.DatabaseName ?? null,
      ssl: e.SslMode ?? null,
      arn: e.EndpointArn ?? null,
    }));
  },
  async get(ctx, id) {
    const [e] = await endpoints(ctx, id);
    if (!e) throw new Error(`Endpoint ${id} was not found.`);
    const engineSettings = Object.entries(e).find(([k, val]) => k.endsWith("Settings") && val && typeof val === "object");
    return {
      summary: {
        Name: id,
        Status: e.Status ?? null,
        "Endpoint type": endpointTypeLabel(e.EndpointType),
        Engine: e.EngineDisplayName ?? e.EngineName ?? null,
        ARN: e.EndpointArn ?? null,
      },
      tabs: [
        {
          id: "details", label: "Endpoint settings", kind: "keyvalue",
          data: {
            "Server name": e.ServerName ?? null,
            Port: e.Port ?? null,
            "User name": e.Username ?? null,
            "Database name": e.DatabaseName ?? null,
            "SSL mode": e.SslMode ?? null,
            "Extra connection attributes": e.ExtraConnectionAttributes ?? null,
            "KMS key": e.KmsKeyId ?? null,
            "Certificate ARN": e.CertificateArn ?? null,
            "Read only": e.IsReadOnly ? "Yes" : "No",
          },
        },
        {
          id: "engine-settings", label: "Engine settings", kind: "json",
          data: engineSettings ? { [engineSettings[0]]: engineSettings[1] } : null,
          emptyText: "No engine-specific settings were returned.",
        },
      ],
    };
  },
  create: {
    title: "Create endpoint",
    description: "Creates a source or target endpoint with CreateEndpoint.",
    fields: [
      { name: "type", label: "Endpoint type", kind: "radio", default: "source", section: "Endpoint type", options: [{ value: "source", label: "Source endpoint" }, { value: "target", label: "Target endpoint" }] },
      { name: "id", label: "Endpoint identifier", kind: "text", required: true, section: "Endpoint configuration", validate: IDENT },
      { name: "engine", label: "Source or target engine", kind: "select", required: true, default: "mysql", options: ENGINES, section: "Endpoint configuration" },
      { name: "server", label: "Server name", kind: "text", required: true, section: "Endpoint configuration", placeholder: "mydb.example.com" },
      { name: "port", label: "Port", kind: "number", section: "Endpoint configuration", help: "Leave empty for the engine's default port (MySQL/MariaDB/Aurora MySQL 3306, PostgreSQL 5432, Oracle 1521, SQL Server 1433).", validate: { min: 1, max: 65535, message: "Between 1 and 65535." } },
      { name: "username", label: "User name", kind: "text", required: true, section: "Endpoint configuration" },
      { name: "password", label: "Password", kind: "password", required: true, section: "Endpoint configuration", help: "Stored by DMS; never shown again." },
      { name: "database", label: "Database name", kind: "text", section: "Endpoint configuration" },
      {
        name: "ssl", label: "Secure Socket Layer (SSL) mode", kind: "select", default: "none", section: "Endpoint configuration",
        options: [{ value: "none", label: "none" }, { value: "require", label: "require" }, { value: "verify-ca", label: "verify-ca" }, { value: "verify-full", label: "verify-full" }],
      },
      { name: "extra", label: "Extra connection attributes", kind: "text", section: "Endpoint settings", placeholder: "parallelLoadThreads=1" },
      { name: "kmsKey", label: "AWS KMS key", kind: "text", section: "Endpoint settings", help: "Leave empty for the aws/dms key." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const id = String(v.id).toLowerCase();
      await ctx.clients.dms.send(new CreateEndpointCommand({
        EndpointIdentifier: id,
        EndpointType: (v.type === "target" ? "target" : "source") as ReplicationEndpointTypeValue,
        EngineName: String(v.engine),
        ServerName: String(v.server),
        Port: optNum(v.port) ?? defaultPort(String(v.engine)),
        Username: String(v.username),
        Password: String(v.password),
        DatabaseName: optStr(v.database),
        SslMode: (optStr(v.ssl) ?? "none") as DmsSslModeValue,
        ExtraConnectionAttributes: optStr(v.extra),
        KmsKeyId: optStr(v.kmsKey),
        Tags: tagsOf(v.tags),
      }));
      return id;
    },
  },
  delete: {
    confirmText: "name",
    async run(ctx, id) {
      const arn = await arnFor(endpoints(ctx, id), (e) => e.EndpointArn, "Endpoint", id);
      await ctx.clients.dms.send(new DeleteEndpointCommand({ EndpointArn: arn }));
    },
  },
};

export const subnetGroupResource: ResourceDef = {
  id: "subnet-groups",
  name: "Subnet groups",
  singular: "subnet group",
  idField: "id",
  nameField: "id",
  description: "Replication subnet groups say which VPC subnets a replication instance can use.",
  emptyText: "No replication subnet groups.",
  columns: [
    { key: "id", label: "Name", kind: "link" },
    { key: "description", label: "Description", kind: "text" },
    { key: "status", label: "Status", kind: "status" },
    { key: "vpc", label: "VPC", kind: "text" },
    { key: "subnets", label: "Subnets", kind: "count" },
  ],
  async list(ctx) {
    return (await subnetGroups(ctx)).map((g) => ({ id: g.ReplicationSubnetGroupIdentifier ?? "", description: g.ReplicationSubnetGroupDescription ?? null, status: g.SubnetGroupStatus ?? null, vpc: g.VpcId ?? null, subnets: g.Subnets?.length ?? 0 }));
  },
  async get(ctx, id) {
    const [g] = await subnetGroups(ctx, id);
    if (!g) throw new Error(`Subnet group ${id} was not found.`);
    return {
      summary: { Name: id, Description: g.ReplicationSubnetGroupDescription ?? null, Status: g.SubnetGroupStatus ?? null, VPC: g.VpcId ?? null },
      tabs: [
        {
          id: "subnets", label: "Subnets", kind: "table",
          columns: [{ key: "subnet", label: "Subnet ID", kind: "text" }, { key: "zone", label: "Availability Zone", kind: "text" }, { key: "status", label: "Status", kind: "status" }],
          data: (g.Subnets ?? []).map((s) => ({ subnet: s.SubnetIdentifier ?? "", zone: s.SubnetAvailabilityZone?.Name ?? null, status: s.SubnetStatus ?? null })),
          emptyText: "No subnets.",
        },
      ],
    };
  },
  create: {
    title: "Create subnet group",
    description: "Creates a replication subnet group with CreateReplicationSubnetGroup.",
    fields: [
      { name: "id", label: "Name", kind: "text", required: true, validate: IDENT, section: "Subnet group configuration" },
      { name: "description", label: "Description", kind: "text", required: true, section: "Subnet group configuration" },
      { name: "subnets", label: "Subnets", kind: "multiselect", required: true, options: subnetOptions, section: "Subnet group configuration", help: "Pick subnets in at least two Availability Zones of one VPC." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const id = String(v.id).toLowerCase();
      await ctx.clients.dms.send(new CreateReplicationSubnetGroupCommand({ ReplicationSubnetGroupIdentifier: id, ReplicationSubnetGroupDescription: String(v.description), SubnetIds: strList(v.subnets) ?? [], Tags: tagsOf(v.tags) }));
      return id;
    },
  },
  delete: {
    confirmText: "name",
    async run(ctx, id) {
      await ctx.clients.dms.send(new DeleteReplicationSubnetGroupCommand({ ReplicationSubnetGroupIdentifier: id }));
    },
  },
};
