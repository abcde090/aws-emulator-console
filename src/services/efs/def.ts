/**
 * Amazon EFS: file systems, mount targets and access points. Every value comes from an EFS
 * (or EC2, for subnet and security group choices) API response.
 */

import { randomUUID } from "node:crypto";
import {
  CreateAccessPointCommand,
  CreateFileSystemCommand,
  CreateMountTargetCommand,
  CreateReplicationConfigurationCommand,
  DeleteAccessPointCommand,
  DeleteFileSystemCommand,
  DeleteFileSystemPolicyCommand,
  DeleteMountTargetCommand,
  DeleteReplicationConfigurationCommand,
  DescribeAccessPointsCommand,
  DescribeBackupPolicyCommand,
  DescribeFileSystemPolicyCommand,
  DescribeFileSystemsCommand,
  DescribeLifecycleConfigurationCommand,
  DescribeMountTargetSecurityGroupsCommand,
  DescribeMountTargetsCommand,
  DescribeReplicationConfigurationsCommand,
  ModifyMountTargetSecurityGroupsCommand,
  PutBackupPolicyCommand,
  PutFileSystemPolicyCommand,
  PutLifecycleConfigurationCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateFileSystemCommand,
  UpdateFileSystemProtectionCommand,
  type AccessPointDescription,
  type LifecyclePolicy,
  type FileSystemDescription,
  type MountTargetDescription,
  type ThroughputMode,
  type PerformanceMode,
} from "@aws-sdk/client-efs";
import type { Ctx, FieldDef, Option, ResourceDef, Row, ServiceDef } from "../../console/types.ts";
import { ARCHIVE_OPTIONS, IA_OPTIONS, PRIMARY_OPTIONS, lifecycleLabel, lifecyclePolicies, lifecycleValues, parseGidList, performanceLabel, posixUserLabel, throughputLabel } from "./helpers.ts";
import { optionalRead } from "../../console/secondary.ts";
import { availabilityZoneOptions, securityGroupOptions, subnetOptions } from "./lookups.ts";
import { fieldTags, nameTag, tagDiff, tagDiffMessage, tagPairs } from "../../console/tags.ts";
import { numberOr, parseJsonText, prettyJson, strList, text } from "../../console/values.ts";

const REPLICATION_REGIONS: Option[] = ["us-east-2", "us-west-1", "us-west-2", "eu-west-1", "eu-central-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1"].map((r) => ({ value: r, label: r }));

async function allFileSystems(ctx: Ctx): Promise<FileSystemDescription[]> {
  const out: FileSystemDescription[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.efs.send(new DescribeFileSystemsCommand({ Marker: marker }));
    out.push(...(r.FileSystems ?? []));
    marker = r.NextMarker;
  } while (marker);
  return out;
}

async function fileSystem(ctx: Ctx, id: string): Promise<FileSystemDescription> {
  const r = await ctx.clients.efs.send(new DescribeFileSystemsCommand({ FileSystemId: id }));
  const fs = r.FileSystems?.[0];
  if (!fs) throw new Error(`File system ${id} was not found.`);
  return fs;
}

async function fileSystemOptions(ctx: Ctx): Promise<Option[]> {
  return (await allFileSystems(ctx)).flatMap((f) => (f.FileSystemId ? [{ value: f.FileSystemId, label: f.Name ? `${f.Name} (${f.FileSystemId})` : f.FileSystemId }] : []));
}

async function mountTargetsOf(ctx: Ctx, fileSystemId: string): Promise<MountTargetDescription[]> {
  const out: MountTargetDescription[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.efs.send(new DescribeMountTargetsCommand({ FileSystemId: fileSystemId, Marker: marker }));
    out.push(...(r.MountTargets ?? []));
    marker = r.NextMarker;
  } while (marker);
  return out;
}

function mountTargetSecurityGroups(ctx: Ctx, mountTargetId: string) {
  return optionalRead(async () => (await ctx.clients.efs.send(new DescribeMountTargetSecurityGroupsCommand({ MountTargetId: mountTargetId }))).SecurityGroups ?? [], []);
}

/** "Not set" for the backup policy is PolicyNotFound: that means automatic backups are off. */
async function backupStatus(ctx: Ctx, id: string): Promise<"ENABLED" | "DISABLED"> {
  const r = await optionalRead(() => ctx.clients.efs.send(new DescribeBackupPolicyCommand({ FileSystemId: id })), ["PolicyNotFound"]);
  if (r.kind === "error") throw new Error(r.error);
  const st = r.kind === "value" ? r.value.BackupPolicy?.Status : undefined;
  return st === "ENABLED" || st === "ENABLING" ? "ENABLED" : "DISABLED";
}

async function currentLifecycle(ctx: Ctx, id: string) {
  return lifecycleValues((await ctx.clients.efs.send(new DescribeLifecycleConfigurationCommand({ FileSystemId: id }))).LifecyclePolicies);
}

const fsAvailable = (row: Row): boolean => (row.state ?? row["File system state"] ?? "available") === "available";

const WAIT_STEPS = 30;
const WAIT_MS = 500;

async function waitAvailable(ctx: Ctx, id: string): Promise<void> {
  for (let i = 0; i < WAIT_STEPS; i++) {
    const fs = await fileSystem(ctx, id);
    if (fs.LifeCycleState === "available") return;
    if (fs.LifeCycleState === "error" || fs.LifeCycleState === "deleted") throw new Error(`File system ${id} is ${fs.LifeCycleState}.`);
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
  }
  throw new Error(`File system ${id} was created but isn't available yet, so lifecycle management wasn't set. Set it with Actions → Edit lifecycle management.`);
}

function fileSystemRow(f: FileSystemDescription): Row {
  return {
    name: f.Name ?? nameTag(f.Tags) ?? null,
    fileSystemId: f.FileSystemId,
    encrypted: f.Encrypted ? "Encrypted" : "Unencrypted",
    size: f.SizeInBytes?.Value ?? null,
    sizeStandard: f.SizeInBytes?.ValueInStandard ?? null,
    sizeIA: f.SizeInBytes?.ValueInIA ?? null,
    sizeArchive: f.SizeInBytes?.ValueInArchive ?? null,
    performanceMode: performanceLabel(f.PerformanceMode),
    throughputMode: throughputLabel(f.ThroughputMode, f.ProvisionedThroughputInMibps),
    fileSystemType: f.AvailabilityZoneName ? `One Zone (${f.AvailabilityZoneName})` : "Regional",
    state: f.LifeCycleState ?? null,
    created: f.CreationTime ?? null,
    mountTargets: f.NumberOfMountTargets ?? 0,
    arn: f.FileSystemArn ?? null,
  };
}

function mountTargetRow(m: MountTargetDescription): Row {
  return {
    mountTargetId: m.MountTargetId,
    fileSystemId: m.FileSystemId,
    availabilityZone: m.AvailabilityZoneName ?? null,
    subnetId: m.SubnetId,
    ipAddress: m.IpAddress ?? null,
    networkInterfaceId: m.NetworkInterfaceId ?? null,
    vpcId: m.VpcId ?? null,
    state: m.LifeCycleState ?? null,
  };
}

function accessPointRow(a: AccessPointDescription): Row {
  const ci = a.RootDirectory?.CreationInfo;
  return {
    name: a.Name ?? nameTag(a.Tags) ?? null,
    accessPointId: a.AccessPointId ?? null,
    fileSystemId: a.FileSystemId ?? null,
    path: a.RootDirectory?.Path ?? "/",
    posixUser: posixUserLabel(a.PosixUser),
    creationInfo: ci ? `Owner ${ci.OwnerUid}:${ci.OwnerGid}, permissions ${ci.Permissions}` : null,
    state: a.LifeCycleState ?? null,
    arn: a.AccessPointArn ?? null,
  };
}

const lifecycleFields = (section?: string): FieldDef[] => [
  { name: "toIA", label: "Transition into Infrequent Access (IA)", kind: "select", required: true, default: "AFTER_30_DAYS", options: IA_OPTIONS, section, help: "Moves files that haven't been accessed for this long into the IA storage class." },
  { name: "toArchive", label: "Transition into Archive", kind: "select", required: true, default: "AFTER_90_DAYS", options: ARCHIVE_OPTIONS, section, help: "Archive needs Elastic throughput. Must be later than the IA transition." },
  { name: "toPrimary", label: "Transition into Standard", kind: "select", required: true, default: "NONE", options: PRIMARY_OPTIONS, section, help: "Moves files back to Standard when they are accessed." },
];

const throughputFields = (section?: string): FieldDef[] => [
  {
    name: "throughputMode", label: "Throughput mode", kind: "radio", default: "elastic", section,
    options: [
      { value: "elastic", label: "Elastic (recommended): scales with your workload, pay for what you use" },
      { value: "provisioned", label: "Provisioned: a fixed throughput you set" },
      { value: "bursting", label: "Bursting: throughput scales with the amount of data stored" },
    ],
  },
  { name: "provisionedMibps", label: "Provisioned throughput (MiB/s)", kind: "number", default: 1, required: true, section, showIf: { field: "throughputMode", equals: "provisioned" }, validate: { min: 1, max: 3414, message: "Between 1 and 3414 MiB/s." } },
];

const fileSystems: ResourceDef = {
  id: "file-systems",
  name: "File systems",
  singular: "file system",
  idField: "fileSystemId",
  nameField: "Name",
  description: "Serverless, elastic NFS file systems that EC2 instances, containers and Lambda functions mount through mount targets.",
  emptyText: "No file systems. Create a file system to get started.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "fileSystemId", label: "File system ID", kind: "link" },
    { key: "encrypted", label: "Encrypted", kind: "text" },
    { key: "size", label: "Total size", kind: "bytes" },
    { key: "sizeStandard", label: "Size in Standard", kind: "bytes" },
    { key: "sizeIA", label: "Size in IA", kind: "bytes" },
    { key: "sizeArchive", label: "Size in Archive", kind: "bytes", hidden: true },
    { key: "performanceMode", label: "Performance mode", kind: "text", hidden: true },
    { key: "throughputMode", label: "Throughput mode", kind: "text" },
    { key: "fileSystemType", label: "File system type", kind: "text" },
    { key: "mountTargets", label: "Mount targets", kind: "count" },
    { key: "state", label: "File system state", kind: "status" },
    { key: "created", label: "Creation time", kind: "date" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    return (await allFileSystems(ctx)).map(fileSystemRow);
  },

  async get(ctx, id) {
    const f = await fileSystem(ctx, id);
    const row = fileSystemRow(f);
    const [lifecycle, backup, policy, replication, mtRead, apRead] = await Promise.all([
      optionalRead(() => ctx.clients.efs.send(new DescribeLifecycleConfigurationCommand({ FileSystemId: id })), []),
      optionalRead(() => ctx.clients.efs.send(new DescribeBackupPolicyCommand({ FileSystemId: id })), ["PolicyNotFound"]),
      optionalRead(() => ctx.clients.efs.send(new DescribeFileSystemPolicyCommand({ FileSystemId: id })), ["PolicyNotFound"]),
      optionalRead(() => ctx.clients.efs.send(new DescribeReplicationConfigurationsCommand({ FileSystemId: id })), ["ReplicationNotFound"]),
      optionalRead(() => mountTargetsOf(ctx, id), []),
      optionalRead(() => ctx.clients.efs.send(new DescribeAccessPointsCommand({ FileSystemId: id })), []),
    ]);
    const lc = lifecycle.kind === "value" ? lifecycleValues(lifecycle.value.LifecyclePolicies) : null;
    const lcText = (k: "toIA" | "toArchive" | "toPrimary") => (lc ? lifecycleLabel(lc[k]) : `Unavailable: ${lifecycle.kind === "error" ? lifecycle.error : "-"}`);
    const mts = mtRead.kind === "value" ? mtRead.value : [];
    const sgs = await Promise.all(mts.map((m) => mountTargetSecurityGroups(ctx, m.MountTargetId as string).then((r) => (r.kind === "value" ? r.value.join(", ") : "Unavailable"))));
    const backupText = backup.kind === "value" ? backup.value.BackupPolicy?.Status ?? "-" : backup.kind === "missing" ? "Disabled" : `Could not read: ${backup.error}`;
    return {
      summary: {
        Name: row.name,
        "File system ID": f.FileSystemId,
        "File system state": f.LifeCycleState ?? null,
        "Performance mode": row.performanceMode,
        "Throughput mode": row.throughputMode,
        "File system type": row.fileSystemType,
        Encrypted: f.Encrypted ? `Encrypted (${f.KmsKeyId ?? "AWS managed key"})` : "Unencrypted",
        "Automatic backups": backupText,
        "Creation time": f.CreationTime ?? null,
        ARN: f.FileSystemArn ?? null,
      },
      tabs: [
        {
          id: "general",
          label: "General",
          kind: "keyvalue",
          data: {
            "Metered size (total)": f.SizeInBytes?.Value ?? 0,
            "Size in Standard (bytes)": f.SizeInBytes?.ValueInStandard ?? 0,
            "Size in Infrequent Access (bytes)": f.SizeInBytes?.ValueInIA ?? 0,
            "Size in Archive (bytes)": f.SizeInBytes?.ValueInArchive ?? 0,
            "Transition into IA": lcText("toIA"),
            "Transition into Archive": lcText("toArchive"),
            "Transition into Standard": lcText("toPrimary"),
            "Number of mount targets": f.NumberOfMountTargets ?? 0,
            "Availability Zone": f.AvailabilityZoneName ?? "Regional (all AZs)",
            "Replication overwrite protection": f.FileSystemProtection?.ReplicationOverwriteProtection ?? null,
            "Creation token": f.CreationToken,
            Owner: f.OwnerId,
          },
        },
        {
          id: "network",
          label: "Network",
          kind: "table",
          description: "One mount target per Availability Zone. Clients in the VPC mount the file system through the mount target in their AZ.",
          columns: [
            { key: "availabilityZone", label: "Availability zone", kind: "text" },
            { key: "mountTargetId", label: "Mount target ID", kind: "text" },
            { key: "subnetId", label: "Subnet ID", kind: "text" },
            { key: "state", label: "Mount target state", kind: "status" },
            { key: "ipAddress", label: "IP address", kind: "text" },
            { key: "networkInterfaceId", label: "Network interface ID", kind: "text" },
            { key: "securityGroups", label: "Security groups", kind: "text" },
          ],
          data: mts.map((m, i) => ({ ...mountTargetRow(m), securityGroups: sgs[i] })),
          emptyText: mtRead.kind === "error" ? `Mount targets are unavailable: ${mtRead.error}` : "No mount targets. Create one in Mount targets so instances can mount this file system.",
        },
        {
          id: "access-points",
          label: "Access points",
          kind: "table",
          columns: [
            { key: "name", label: "Name", kind: "text" },
            { key: "accessPointId", label: "Access point ID", kind: "text" },
            { key: "path", label: "Path", kind: "text" },
            { key: "posixUser", label: "POSIX user", kind: "text" },
            { key: "state", label: "State", kind: "status" },
          ],
          data: apRead.kind === "value" ? (apRead.value.AccessPoints ?? []).map(accessPointRow) : [],
          emptyText: apRead.kind === "error" ? `Access points are unavailable: ${apRead.error}` : "No access points.",
        },
        {
          id: "policy",
          label: "File system policy",
          kind: "json",
          data: policy.kind === "value" ? parseJsonText(policy.value.Policy) : policy.kind === "error" ? { error: policy.error } : null,
          emptyText: "No file system policy. Any client that can reach a mount target can mount it (subject to IAM).",
        },
        {
          id: "replication",
          label: "Replication",
          kind: "table",
          columns: [
            { key: "region", label: "Destination Region", kind: "text" },
            { key: "fileSystemId", label: "Destination file system", kind: "text" },
            { key: "status", label: "Replication state", kind: "status" },
            { key: "lastSync", label: "Last synced", kind: "date" },
          ],
          data:
            replication.kind === "value"
              ? (replication.value.Replications ?? []).flatMap((rep) => (rep.Destinations ?? []).map((d) => ({ region: d.Region, fileSystemId: d.FileSystemId, status: d.Status, lastSync: d.LastReplicatedTimestamp ?? null })))
              : [],
          description: replication.kind === "error" ? `Could not read replication: ${replication.error}` : undefined,
          emptyText: "This file system isn't replicated.",
        },
        {
          id: "tags",
          label: "Tags",
          kind: "table",
          columns: [
            { key: "Key", label: "Key", kind: "text" },
            { key: "Value", label: "Value", kind: "text" },
          ],
          data: f.Tags ?? [],
          emptyText: "No tags.",
        },
      ],
    };
  },

  create: {
    title: "Create file system",
    description: "Creates an EFS file system with CreateFileSystem, then sets its lifecycle management.",
    fields: [
      { name: "name", label: "Name", kind: "text", section: "General", placeholder: "my-file-system", help: "Saved as the Name tag.", validate: { max: 256, message: "At most 256 characters." } },
      {
        name: "fsType", label: "File system type", kind: "radio", default: "regional", section: "General",
        options: [
          { value: "regional", label: "Regional: stores data redundantly across multiple Availability Zones" },
          { value: "onezone", label: "One Zone: stores data in a single Availability Zone" },
        ],
      },
      { name: "az", label: "Availability Zone", kind: "select", required: true, options: availabilityZoneOptions, section: "General", showIf: { field: "fsType", equals: "onezone" } },
      { name: "backup", label: "Enable automatic backups", kind: "checkbox", default: true, section: "General", help: "Backs up the file system daily with AWS Backup." },
      ...lifecycleFields("Lifecycle management"),
      { name: "encrypted", label: "Enable encryption of data at rest", kind: "checkbox", default: true, section: "Encryption", help: "Uses the AWS managed key aws/elasticfilesystem. You can't change this later." },
      ...throughputFields("Performance settings"),
      {
        name: "performanceMode", label: "Performance mode", kind: "radio", default: "generalPurpose", section: "Performance settings",
        help: "Max I/O isn't available with Elastic throughput or One Zone file systems.",
        options: [
          { value: "generalPurpose", label: "General Purpose: lowest latency, recommended for most workloads" },
          { value: "maxIO", label: "Max I/O: higher aggregate throughput, higher latency" },
        ],
      },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const name = text(v.name);
      const tags = fieldTags(v.tags).filter((t) => t.Key !== "Name");
      const r = await ctx.clients.efs.send(
        new CreateFileSystemCommand({
          CreationToken: randomUUID(),
          PerformanceMode: (v.performanceMode === "maxIO" ? "maxIO" : "generalPurpose") as PerformanceMode,
          ThroughputMode: String(v.throughputMode ?? "elastic") as ThroughputMode,
          ProvisionedThroughputInMibps: v.throughputMode === "provisioned" ? numberOr(v.provisionedMibps) : undefined,
          Encrypted: v.encrypted === true,
          AvailabilityZoneName: v.fsType === "onezone" ? text(v.az) : undefined,
          Backup: v.backup === true,
          Tags: [...(name ? [{ Key: "Name", Value: name }] : []), ...tags],
        })
      );
      const fsId = r.FileSystemId;
      if (!fsId) throw new Error("EFS returned no file system ID.");
      const policies = lifecyclePolicies({ toIA: String(v.toIA ?? "NONE"), toArchive: String(v.toArchive ?? "NONE"), toPrimary: String(v.toPrimary ?? "NONE") });
      if (policies.length) {
        // Lifecycle can only be set once the file system is available.
        await waitAvailable(ctx, fsId);
        await ctx.clients.efs.send(new PutLifecycleConfigurationCommand({ FileSystemId: fsId, LifecyclePolicies: policies as LifecyclePolicy[] }));
      }
      return fsId;
    },
  },

  actions: [
    {
      id: "edit-throughput",
      label: "Edit performance settings",
      availableFor: fsAvailable,
      fields: throughputFields(),
      async initialValues(ctx, id) {
        const f = await fileSystem(ctx, id);
        return { throughputMode: f.ThroughputMode ?? "bursting", provisionedMibps: f.ProvisionedThroughputInMibps ?? 1 };
      },
      async run(ctx, id, v) {
        const f = await fileSystem(ctx, id);
        const mibps = v.throughputMode === "provisioned" ? numberOr(v.provisionedMibps) : undefined;
        if (v.throughputMode === f.ThroughputMode && (v.throughputMode !== "provisioned" || mibps === f.ProvisionedThroughputInMibps)) return { message: "No changes to save." };
        const r = await ctx.clients.efs.send(
          new UpdateFileSystemCommand({
            FileSystemId: id,
            ThroughputMode: String(v.throughputMode) as ThroughputMode,
            ProvisionedThroughputInMibps: mibps,
          })
        );
        return { message: `Throughput mode is now ${throughputLabel(r.ThroughputMode, r.ProvisionedThroughputInMibps) ?? "-"}. State: ${r.LifeCycleState ?? "-"}.` };
      },
    },
    {
      id: "edit-lifecycle",
      label: "Edit lifecycle management",
      availableFor: fsAvailable,
      fields: lifecycleFields(),
      async initialValues(ctx, id) {
        return { ...(await currentLifecycle(ctx, id)) };
      },
      async run(ctx, id, v) {
        const before = await currentLifecycle(ctx, id);
        if (before.toIA === v.toIA && before.toArchive === v.toArchive && before.toPrimary === v.toPrimary) return { message: "No changes to save." };
        const policies = lifecyclePolicies({ toIA: String(v.toIA ?? "NONE"), toArchive: String(v.toArchive ?? "NONE"), toPrimary: String(v.toPrimary ?? "NONE") });
        const r = await ctx.clients.efs.send(new PutLifecycleConfigurationCommand({ FileSystemId: id, LifecyclePolicies: policies as LifecyclePolicy[] }));
        const lc = lifecycleValues(r.LifecyclePolicies);
        return { message: `Lifecycle management saved. IA: ${lifecycleLabel(lc.toIA)}; Archive: ${lifecycleLabel(lc.toArchive)}; Standard: ${lifecycleLabel(lc.toPrimary)}.` };
      },
    },
    {
      id: "edit-backup",
      label: "Edit automatic backups",
      fields: [
        { name: "status", label: "Automatic backups", kind: "radio", default: "ENABLED", options: [{ value: "ENABLED", label: "Enabled" }, { value: "DISABLED", label: "Disabled" }] },
      ],
      async initialValues(ctx, id) {
        return { status: await backupStatus(ctx, id) };
      },
      async run(ctx, id, v) {
        const wanted = v.status === "DISABLED" ? "DISABLED" : "ENABLED";
        if ((await backupStatus(ctx, id)) === wanted) return { message: `Automatic backups are already ${wanted.toLowerCase()}.` };
        const r = await ctx.clients.efs.send(new PutBackupPolicyCommand({ FileSystemId: id, BackupPolicy: { Status: v.status === "DISABLED" ? "DISABLED" : "ENABLED" } }));
        return { message: `Backup policy status: ${r.BackupPolicy?.Status ?? "-"}.` };
      },
    },
    {
      id: "edit-policy",
      label: "Edit file system policy",
      fields: [{ name: "policy", label: "Policy (JSON)", kind: "json", required: true, help: "A resource policy, e.g. allowing elasticfilesystem:ClientMount or enforcing aws:SecureTransport." }],
      async initialValues(ctx, id) {
        const r = await optionalRead(() => ctx.clients.efs.send(new DescribeFileSystemPolicyCommand({ FileSystemId: id })), ["PolicyNotFound"]);
        if (r.kind === "error") throw new Error(r.error);
        return { policy: r.kind === "value" ? prettyJson(r.value.Policy) : "" };
      },
      async run(ctx, id, v) {
        const r = await ctx.clients.efs.send(new PutFileSystemPolicyCommand({ FileSystemId: id, Policy: String(v.policy) }));
        return { message: "File system policy saved.", json: parseJsonText(r.Policy) };
      },
    },
    {
      id: "delete-policy",
      label: "Delete file system policy",
      danger: true,
      confirm: "Removes the file system policy. Access is then controlled by IAM and network settings only.",
      async run(ctx, id) {
        await ctx.clients.efs.send(new DeleteFileSystemPolicyCommand({ FileSystemId: id }));
        return { message: "File system policy deleted." };
      },
    },
    {
      id: "create-replication",
      label: "Create replication",
      fields: [{ name: "region", label: "Destination Region", kind: "select", required: true, options: REPLICATION_REGIONS, help: "EFS creates a new, read-only destination file system in this Region." }],
      async run(ctx, id, v) {
        const r = await ctx.clients.efs.send(new CreateReplicationConfigurationCommand({ SourceFileSystemId: id, Destinations: [{ Region: String(v.region) }] }));
        const d = r.Destinations?.[0];
        return { message: `Replication created. Destination file system ${d?.FileSystemId ?? "-"} in ${d?.Region ?? "-"} (${d?.Status ?? "-"}).` };
      },
    },
    {
      id: "delete-replication",
      label: "Delete replication",
      danger: true,
      confirm: "Stops replication. The destination file system stays and becomes writeable.",
      async run(ctx, id) {
        await ctx.clients.efs.send(new DeleteReplicationConfigurationCommand({ SourceFileSystemId: id }));
        return { message: "Replication deletion requested." };
      },
    },
    {
      id: "edit-protection",
      label: "Edit replication overwrite protection",
      fields: [
        {
          name: "protection", label: "Replication overwrite protection", kind: "radio", default: "ENABLED",
          help: "Must be disabled before this file system can be a replication destination (or deleted while it is one).",
          options: [{ value: "ENABLED", label: "Enabled" }, { value: "DISABLED", label: "Disabled" }],
        },
      ],
      async initialValues(ctx, id) {
        const p = (await fileSystem(ctx, id)).FileSystemProtection?.ReplicationOverwriteProtection;
        return { protection: p === "DISABLED" ? "DISABLED" : "ENABLED" };
      },
      async run(ctx, id, v) {
        const wanted = v.protection === "DISABLED" ? "DISABLED" : "ENABLED";
        const p = (await fileSystem(ctx, id)).FileSystemProtection?.ReplicationOverwriteProtection;
        if ((p === "DISABLED" ? "DISABLED" : "ENABLED") === wanted) return { message: `Replication overwrite protection is already ${wanted}.` };
        const r = await ctx.clients.efs.send(new UpdateFileSystemProtectionCommand({ FileSystemId: id, ReplicationOverwriteProtection: v.protection === "DISABLED" ? "DISABLED" : "ENABLED" }));
        return { message: `Replication overwrite protection: ${r.ReplicationOverwriteProtection ?? "-"}.` };
      },
    },
    {
      id: "tags",
      label: "Manage tags",
      fields: [{ name: "tags", label: "Tags", kind: "tags", help: "The Name tag is the file system's name. Remove a row to delete that tag." }],
      async initialValues(ctx, id) {
        return { tags: tagPairs((await fileSystem(ctx, id)).Tags) };
      },
      async run(ctx, id, v) {
        const diff = tagDiff((await fileSystem(ctx, id)).Tags, fieldTags(v.tags));
        if (diff.remove.length) await ctx.clients.efs.send(new UntagResourceCommand({ ResourceId: id, TagKeys: diff.remove }));
        if (diff.set.length) await ctx.clients.efs.send(new TagResourceCommand({ ResourceId: id, Tags: diff.set }));
        return { message: tagDiffMessage(diff) };
      },
    },
  ],

  delete: {
    confirmText: "name",
    async run(ctx, id) {
      await ctx.clients.efs.send(new DeleteFileSystemCommand({ FileSystemId: id }));
    },
  },
};

const mountTargets: ResourceDef = {
  id: "mount-targets",
  name: "Mount targets",
  singular: "mount target",
  idField: "mountTargetId",
  description: "Network endpoints (one per Availability Zone) in your VPC subnets that NFS clients connect to.",
  emptyText: "No mount targets. Create a mount target in a subnet of each Availability Zone you use.",
  columns: [
    { key: "mountTargetId", label: "Mount target ID", kind: "link" },
    { key: "fileSystemId", label: "File system ID", kind: "text" },
    { key: "availabilityZone", label: "Availability zone", kind: "text" },
    { key: "subnetId", label: "Subnet ID", kind: "text" },
    { key: "ipAddress", label: "IP address", kind: "text" },
    { key: "networkInterfaceId", label: "Network interface ID", kind: "text", hidden: true },
    { key: "vpcId", label: "VPC", kind: "text" },
    { key: "state", label: "Mount target state", kind: "status" },
  ],

  async list(ctx) {
    const fss = await allFileSystems(ctx);
    const all = await Promise.all(fss.flatMap((f) => (f.FileSystemId ? [mountTargetsOf(ctx, f.FileSystemId)] : [])));
    return all.flat().map(mountTargetRow);
  },

  async get(ctx, id) {
    const r = await ctx.clients.efs.send(new DescribeMountTargetsCommand({ MountTargetId: id }));
    const m = r.MountTargets?.[0];
    if (!m) throw new Error(`Mount target ${id} was not found.`);
    const sgs = await mountTargetSecurityGroups(ctx, id);
    const row = mountTargetRow(m);
    return {
      summary: {
        "Mount target ID": m.MountTargetId,
        "File system ID": m.FileSystemId,
        "Mount target state": m.LifeCycleState ?? null,
        "Availability zone": `${m.AvailabilityZoneName ?? "-"} (${m.AvailabilityZoneId ?? "-"})`,
        "Subnet ID": m.SubnetId,
        VPC: row.vpcId,
        "IP address": m.IpAddress ?? null,
        "Network interface ID": m.NetworkInterfaceId ?? null,
        "DNS name": `${m.AvailabilityZoneName ?? ""}.${m.FileSystemId}.efs.${ctx.region}.amazonaws.com`,
      },
      tabs: [
        {
          id: "security-groups",
          label: "Security groups",
          kind: "table",
          columns: [{ key: "groupId", label: "Security group ID", kind: "text" }],
          data: sgs.kind === "value" ? sgs.value.map((g) => ({ groupId: g })) : [],
          description: "The security groups must allow inbound NFS (TCP 2049) from your clients.",
          emptyText: sgs.kind === "error" ? `Security groups are unavailable: ${sgs.error}` : "No security groups.",
        },
      ],
    };
  },

  create: {
    title: "Create mount target",
    description: "Creates a mount target with CreateMountTarget. A file system can have one mount target per Availability Zone.",
    fields: [
      { name: "fileSystemId", label: "File system", kind: "select", required: true, options: fileSystemOptions, section: "Network" },
      { name: "subnetId", label: "Subnet", kind: "select", required: true, options: subnetOptions, section: "Network", help: "The mount target is placed in this subnet's Availability Zone." },
      { name: "ipAddress", label: "IP address", kind: "text", section: "Network", placeholder: "Automatic", help: "Leave empty to get an address from the subnet automatically.", validate: { pattern: "\\d{1,3}(\\.\\d{1,3}){3}", message: "Enter an IPv4 address." } },
      { name: "securityGroups", label: "Security groups", kind: "multiselect", options: securityGroupOptions, section: "Network", help: "Up to 5. Leave empty to use the VPC's default security group." },
    ],
    async run(ctx, v) {
      const sgs = strList(v.securityGroups);
      if (sgs.length > 5) throw new Error("Choose at most 5 security groups.");
      const r = await ctx.clients.efs.send(
        new CreateMountTargetCommand({ FileSystemId: String(v.fileSystemId), SubnetId: String(v.subnetId), IpAddress: text(v.ipAddress), SecurityGroups: sgs.length ? sgs : undefined })
      );
      if (!r.MountTargetId) throw new Error("EFS returned no mount target ID.");
      return r.MountTargetId;
    },
  },

  actions: [
    {
      id: "manage-security-groups",
      label: "Manage security groups",
      fields: [{ name: "securityGroups", label: "Security groups", kind: "multiselect", required: true, options: securityGroupOptions, help: "Replaces the mount target's security groups (up to 5, same VPC)." }],
      async initialValues(ctx, id) {
        return { securityGroups: (await ctx.clients.efs.send(new DescribeMountTargetSecurityGroupsCommand({ MountTargetId: id }))).SecurityGroups ?? [] };
      },
      async run(ctx, id, v) {
        const sgs = strList(v.securityGroups);
        if (sgs.length > 5) throw new Error("Choose at most 5 security groups.");
        await ctx.clients.efs.send(new ModifyMountTargetSecurityGroupsCommand({ MountTargetId: id, SecurityGroups: sgs }));
        const now = await ctx.clients.efs.send(new DescribeMountTargetSecurityGroupsCommand({ MountTargetId: id }));
        return { message: `Security groups are now: ${(now.SecurityGroups ?? []).join(", ") || "none"}.` };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.efs.send(new DeleteMountTargetCommand({ MountTargetId: id }));
    },
  },
};

const accessPoints: ResourceDef = {
  id: "access-points",
  name: "Access points",
  singular: "access point",
  idField: "accessPointId",
  nameField: "Name",
  description: "Application-specific entry points into a file system that enforce a POSIX user and root directory.",
  emptyText: "No access points.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "accessPointId", label: "Access point ID", kind: "link" },
    { key: "fileSystemId", label: "File system ID", kind: "text" },
    { key: "path", label: "Path", kind: "text" },
    { key: "posixUser", label: "POSIX user", kind: "text" },
    { key: "creationInfo", label: "Root directory creation permissions", kind: "text" },
    { key: "state", label: "State", kind: "status" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const out: AccessPointDescription[] = [];
    let token: string | undefined;
    do {
      const r = await ctx.clients.efs.send(new DescribeAccessPointsCommand({ NextToken: token }));
      out.push(...(r.AccessPoints ?? []));
      token = r.NextToken;
    } while (token);
    return out.map(accessPointRow);
  },

  async get(ctx, id) {
    const r = await ctx.clients.efs.send(new DescribeAccessPointsCommand({ AccessPointId: id }));
    const a = r.AccessPoints?.[0];
    if (!a) throw new Error(`Access point ${id} was not found.`);
    const row = accessPointRow(a);
    return {
      summary: {
        Name: row.name,
        "Access point ID": a.AccessPointId ?? null,
        "File system ID": a.FileSystemId ?? null,
        State: a.LifeCycleState ?? null,
        "Root directory path": row.path,
        "POSIX user": row.posixUser ?? "Not enforced",
        "Root directory creation permissions": row.creationInfo ?? "-",
        ARN: a.AccessPointArn ?? null,
      },
      tabs: [
        {
          id: "tags",
          label: "Tags",
          kind: "table",
          columns: [
            { key: "Key", label: "Key", kind: "text" },
            { key: "Value", label: "Value", kind: "text" },
          ],
          data: a.Tags ?? [],
          emptyText: "No tags.",
        },
      ],
    };
  },

  create: {
    title: "Create access point",
    description: "Creates an access point with CreateAccessPoint.",
    fields: [
      { name: "fileSystemId", label: "File system", kind: "select", required: true, options: fileSystemOptions, section: "Details" },
      { name: "name", label: "Name", kind: "text", section: "Details", help: "Saved as the Name tag." },
      { name: "path", label: "Root directory path", kind: "text", default: "/", section: "Details", help: "Clients using this access point see this directory as the root.", validate: { pattern: "/.{0,99}", message: "Must start with / (at most 100 characters)." } },
      { name: "uid", label: "User ID", kind: "number", section: "POSIX user", help: "When set, every request through this access point runs as this user.", validate: { min: 0, max: 4294967295, message: "A POSIX user ID." } },
      { name: "gid", label: "Group ID", kind: "number", section: "POSIX user", validate: { min: 0, max: 4294967295, message: "A POSIX group ID." } },
      { name: "secondaryGids", label: "Secondary group IDs", kind: "text", section: "POSIX user", placeholder: "1001, 1002", help: "Comma-separated." },
      { name: "ownerUid", label: "Owner user ID", kind: "number", section: "Root directory creation permissions", help: "If the root directory doesn't exist, EFS creates it with this owner and permissions.", validate: { min: 0, max: 4294967295, message: "A POSIX user ID." } },
      { name: "ownerGid", label: "Owner group ID", kind: "number", section: "Root directory creation permissions", validate: { min: 0, max: 4294967295, message: "A POSIX group ID." } },
      { name: "permissions", label: "Access point permissions", kind: "text", section: "Root directory creation permissions", placeholder: "0755", validate: { pattern: "[0-7]{3,4}", message: "Octal permissions such as 755 or 0755." } },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const uid = numberOr(v.uid);
      const gid = numberOr(v.gid);
      if ((uid === undefined) !== (gid === undefined)) throw new Error("Enter both a user ID and a group ID for the POSIX user, or neither.");
      const ownerUid = numberOr(v.ownerUid);
      const ownerGid = numberOr(v.ownerGid);
      const perms = text(v.permissions);
      const anyCreation = ownerUid !== undefined || ownerGid !== undefined || perms !== undefined;
      if (anyCreation && (ownerUid === undefined || ownerGid === undefined || perms === undefined)) throw new Error("Root directory creation permissions need an owner user ID, owner group ID and permissions together.");
      const name = text(v.name);
      const r = await ctx.clients.efs.send(
        new CreateAccessPointCommand({
          ClientToken: randomUUID(),
          FileSystemId: String(v.fileSystemId),
          PosixUser: uid !== undefined && gid !== undefined ? { Uid: uid, Gid: gid, SecondaryGids: parseGidList(text(v.secondaryGids)) } : undefined,
          RootDirectory: {
            Path: text(v.path) ?? "/",
            CreationInfo: anyCreation ? { OwnerUid: ownerUid as number, OwnerGid: ownerGid as number, Permissions: perms as string } : undefined,
          },
          Tags: [...(name ? [{ Key: "Name", Value: name }] : []), ...fieldTags(v.tags).filter((t) => t.Key !== "Name")],
        })
      );
      if (!r.AccessPointId) throw new Error("EFS returned no access point ID.");
      return r.AccessPointId;
    },
  },

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.efs.send(new DeleteAccessPointCommand({ AccessPointId: id }));
    },
  },
};

export const efsService: ServiceDef = {
  id: "efs",
  name: "Amazon EFS",
  category: "Storage",
  description: "Serverless, fully elastic file storage for EC2, containers and Lambda, mounted over NFS.",
  resources: [fileSystems, accessPoints, mountTargets],
  notSupported: ["Account preferences (DescribeAccountPreferences)"],
};
