/** Elastic Block Store: Volumes and Snapshots. */

import { ec2TagAction } from "./tag-action.ts";
import {
  AttachVolumeCommand,
  CopySnapshotCommand,
  CreateSnapshotCommand,
  CreateVolumeCommand,
  DeleteSnapshotCommand,
  DeleteVolumeCommand,
  DescribeSnapshotsCommand,
  DescribeVolumesCommand,
  DescribeVolumesModificationsCommand,
  DetachVolumeCommand,
  ModifyVolumeCommand,
  RegisterImageCommand,
  type Snapshot,
  type Volume,
  type VolumeType,
} from "@aws-sdk/client-ec2";
import type { Ctx, FieldDef, FieldValues, Option, ResourceDef, Row, Tag } from "../../console/types.ts";
import { nameTag, tagRows, withName } from "./helpers.ts";
import { VOLUME_TYPES } from "./launch.ts";
import { availabilityZoneOptions, availableVolumeOptions, liveInstanceOptions, tagSpec } from "./options.ts";

const TAG_COLUMNS = [
  { key: "Key", label: "Key", kind: "text" as const },
  { key: "Value", label: "Value", kind: "text" as const },
];

const typeOptions: Option[] = [
  { value: "gp3", label: "General Purpose SSD (gp3)" },
  { value: "gp2", label: "General Purpose SSD (gp2)" },
  { value: "io1", label: "Provisioned IOPS SSD (io1)" },
  { value: "io2", label: "Provisioned IOPS SSD (io2)" },
  { value: "st1", label: "Throughput Optimized HDD (st1)" },
  { value: "sc1", label: "Cold HDD (sc1)" },
  { value: "standard", label: "Magnetic (standard)" },
];

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const tagsOf = (v: unknown): Tag[] => (Array.isArray(v) ? (v as Tag[]) : []);

/** IOPS and throughput only apply to some volume types; sending them for others is an error. */
function performance(type: string | undefined, v: FieldValues): { Iops?: number; Throughput?: number } {
  return {
    Iops: type === "gp3" || type === "io1" || type === "io2" ? num(v.iops) : undefined,
    Throughput: type === "gp3" ? num(v.throughput) : undefined,
  };
}

const perfFields = (section?: string): FieldDef[] => [
  { name: "iops", label: "IOPS", kind: "number", section, help: "gp3: 3000-16000 (default 3000). io1/io2: up to 64000. Ignored for other types.", validate: { min: 100, max: 256000, message: "Between 100 and 256000." } },
  { name: "throughput", label: "Throughput (MiB/s)", kind: "number", section, help: "gp3 only: 125-1000 (default 125).", validate: { min: 125, max: 2000, message: "Between 125 and 2000 MiB/s." } },
];

async function oneVolume(ctx: Ctx, id: string): Promise<Volume> {
  const v = (await ctx.clients.ec2.send(new DescribeVolumesCommand({ VolumeIds: [id] }))).Volumes?.[0];
  if (!v) throw new Error(`Volume ${id} was not found.`);
  return v;
}

function volumeRow(v: Volume): Row {
  return {
    name: nameTag(v.Tags),
    volumeId: v.VolumeId ?? "",
    type: v.VolumeType ?? null,
    size: v.Size ?? null,
    iops: v.Iops ?? null,
    throughput: v.Throughput ?? null,
    snapshot: v.SnapshotId || null,
    created: v.CreateTime ?? null,
    az: v.AvailabilityZone ?? null,
    state: v.State ?? null,
    attached: (v.Attachments ?? []).map((a) => `${a.InstanceId}:${a.Device} (${a.State})`).join(", ") || null,
    encryption: v.Encrypted ? "Encrypted" : "Not encrypted",
    multiAttach: v.MultiAttachEnabled ?? null,
  };
}

async function snapshotOptions(ctx: Ctx): Promise<Option[]> {
  const r = await ctx.clients.ec2.send(new DescribeSnapshotsCommand({ OwnerIds: ["self"] }));
  return (r.Snapshots ?? []).filter((s) => s.SnapshotId).map((s) => ({ value: s.SnapshotId as string, label: `${s.SnapshotId} - ${s.VolumeSize ?? "?"} GiB${s.Description ? ` (${s.Description})` : ""}` }));
}

export const volumes: ResourceDef = {
  id: "volumes",
  name: "Volumes",
  singular: "volume",
  idField: "volumeId",
  nameField: "Volume ID",
  description: "Block storage volumes you attach to instances in the same Availability Zone.",
  emptyText: "You don't have any volumes in this region.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "volumeId", label: "Volume ID", kind: "link" },
    { key: "type", label: "Type", kind: "text" },
    { key: "size", label: "Size (GiB)", kind: "count" },
    { key: "iops", label: "IOPS", kind: "count" },
    { key: "throughput", label: "Throughput", kind: "count" },
    { key: "snapshot", label: "Snapshot ID", kind: "text" },
    { key: "created", label: "Created", kind: "date" },
    { key: "az", label: "Availability Zone", kind: "text" },
    { key: "state", label: "Volume state", kind: "status" },
    { key: "attached", label: "Attached resources", kind: "text" },
    { key: "encryption", label: "Encryption", kind: "text" },
  ],
  async list(ctx) {
    const out: Row[] = [];
    let token: string | undefined;
    do {
      const r = await ctx.clients.ec2.send(new DescribeVolumesCommand({ NextToken: token }));
      out.push(...(r.Volumes ?? []).map(volumeRow));
      token = r.NextToken;
    } while (token);
    return out.sort((a, b) => String(b.created ?? "").localeCompare(String(a.created ?? "")));
  },
  async get(ctx, id) {
    const v = await oneVolume(ctx, id);
    const mods = await ctx.clients.ec2.send(new DescribeVolumesModificationsCommand({ VolumeIds: [id] })).catch(() => ({ VolumesModifications: [] }));
    const row = volumeRow(v);
    return {
      summary: { "Volume ID": id, Name: row.name, "Volume state": v.State ?? null, Type: v.VolumeType ?? null, "Size (GiB)": v.Size ?? null, "Availability Zone": v.AvailabilityZone ?? null },
      tabs: [
        {
          id: "details",
          label: "Details",
          kind: "keyvalue",
          data: { IOPS: v.Iops ?? null, Throughput: v.Throughput ?? null, Snapshot: v.SnapshotId || null, Created: v.CreateTime ?? null, Encryption: row.encryption, "KMS key ID": v.KmsKeyId ?? null, "Multi-Attach enabled": v.MultiAttachEnabled ?? null, "Fast snapshot restored": v.FastRestored ?? null },
        },
        {
          id: "attachments",
          label: "Attachments",
          kind: "table",
          columns: [
            { key: "instance", label: "Instance ID", kind: "text" },
            { key: "device", label: "Device name", kind: "text" },
            { key: "state", label: "Attachment state", kind: "status" },
            { key: "time", label: "Attach time", kind: "date" },
            { key: "deleteOnTermination", label: "Delete on termination", kind: "boolean" },
          ],
          data: (v.Attachments ?? []).map((a) => ({ instance: a.InstanceId ?? null, device: a.Device ?? null, state: a.State ?? null, time: a.AttachTime ?? null, deleteOnTermination: a.DeleteOnTermination ?? null })),
          emptyText: "This volume is not attached to an instance.",
        },
        {
          id: "modifications",
          label: "Modifications",
          kind: "table",
          columns: [
            { key: "state", label: "Modification state", kind: "status" },
            { key: "progress", label: "Progress (%)", kind: "count" },
            { key: "from", label: "Original", kind: "text" },
            { key: "to", label: "Target", kind: "text" },
            { key: "start", label: "Start time", kind: "date" },
          ],
          data: (mods.VolumesModifications ?? []).map((m) => ({
            state: m.ModificationState ?? null,
            progress: m.Progress ?? null,
            from: `${m.OriginalVolumeType ?? "?"}, ${m.OriginalSize ?? "?"} GiB, ${m.OriginalIops ?? "-"} IOPS`,
            to: `${m.TargetVolumeType ?? "?"}, ${m.TargetSize ?? "?"} GiB, ${m.TargetIops ?? "-"} IOPS`,
            start: m.StartTime ?? null,
          })),
          emptyText: "This volume has not been modified.",
        },
        { id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: tagRows(v.Tags), emptyText: "No tags." },
      ],
    };
  },
  create: {
    title: "Create volume",
    description: "Creates an EBS volume with CreateVolume.",
    fields: [
      { name: "type", label: "Volume type", kind: "select", default: "gp3", required: true, options: typeOptions, section: "Volume settings" },
      { name: "size", label: "Size (GiB)", kind: "number", default: 100, required: true, section: "Volume settings", validate: { min: 1, max: 65536, message: "Between 1 and 65536 GiB." } },
      ...perfFields("Volume settings"),
      { name: "az", label: "Availability Zone", kind: "select", required: true, options: availabilityZoneOptions, section: "Volume settings" },
      { name: "snapshotId", label: "Snapshot ID", kind: "select", default: "", options: snapshotOptions, section: "Volume settings", help: "Don't create volume from a snapshot (-), or pick one of your snapshots." },
      { name: "encrypted", label: "Encrypt this volume", kind: "checkbox", default: false, section: "Volume settings" },
      { name: "name", label: "Name", kind: "text", section: "Tags" },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const type = text(v.type);
      const r = await ctx.clients.ec2.send(
        new CreateVolumeCommand({
          VolumeType: type as VolumeType,
          Size: num(v.size),
          AvailabilityZone: String(v.az),
          SnapshotId: text(v.snapshotId),
          Encrypted: v.encrypted === true || undefined,
          ...performance(type, v),
          TagSpecifications: tagSpec("volume", withName(v.name, tagsOf(v.tags))),
        })
      );
      if (!r.VolumeId) throw new Error("CreateVolume returned no volume ID.");
      return r.VolumeId;
    },
  },
  actions: [
    {
      id: "modify",
      label: "Modify volume",
      fields: [
        { name: "type", label: "Volume type", kind: "select", required: true, default: "gp3", options: typeOptions },
        { name: "size", label: "Size (GiB)", kind: "number", help: "You can only increase the size.", validate: { min: 1, max: 65536, message: "Between 1 and 65536 GiB." } },
        ...perfFields(),
      ],
      async initialValues(ctx, id) {
        const vol = await oneVolume(ctx, id);
        return { type: vol.VolumeType ?? "gp3", size: vol.Size ?? null, iops: vol.Iops ?? null, throughput: vol.Throughput ?? null };
      },
      async run(ctx, id, v) {
        const type = text(v.type);
        const cur = await oneVolume(ctx, id);
        const perf = performance(type, v);
        // ModifyVolume gets only what changed; an unchanged save sends nothing.
        const change = {
          VolumeType: type && type !== cur.VolumeType ? (type as VolumeType) : undefined,
          Size: num(v.size) !== undefined && num(v.size) !== cur.Size ? num(v.size) : undefined,
          Iops: perf.Iops !== undefined && perf.Iops !== cur.Iops ? perf.Iops : undefined,
          Throughput: perf.Throughput !== undefined && perf.Throughput !== cur.Throughput ? perf.Throughput : undefined,
        };
        if (Object.values(change).every((x) => x === undefined)) return { message: "No changes to the volume." };
        const r = await ctx.clients.ec2.send(new ModifyVolumeCommand({ VolumeId: id, ...change }));
        const m = r.VolumeModification;
        return { message: `Modification ${m?.ModificationState ?? "requested"}: ${m?.TargetVolumeType ?? type}, ${m?.TargetSize ?? "?"} GiB.` };
      },
    },
    {
      id: "snapshot",
      label: "Create snapshot",
      fields: [
        { name: "description", label: "Description", kind: "text", validate: { max: 255, message: "At most 255 characters." } },
        { name: "name", label: "Name", kind: "text" },
      ],
      async run(ctx, id, v) {
        const r = await ctx.clients.ec2.send(new CreateSnapshotCommand({ VolumeId: id, Description: text(v.description), TagSpecifications: tagSpec("snapshot", withName(v.name, [])) }));
        return { message: `Created snapshot ${r.SnapshotId ?? "?"} (${r.State ?? "pending"}).` };
      },
    },
    {
      id: "attach",
      label: "Attach volume",
      fields: [
        { name: "instanceId", label: "Instance", kind: "select", required: true, options: liveInstanceOptions, help: "Only instances in the same Availability Zone as the volume can be used." },
        { name: "device", label: "Device name", kind: "text", required: true, default: "/dev/sdf", validate: { pattern: "/dev/(sd[f-p]|xvd[f-p][a-z]?|sd[b-z]|xvd[b-z])\\d*", message: "Use a name such as /dev/sdf through /dev/sdp." } },
      ],
      async run(ctx, id, v) {
        const r = await ctx.clients.ec2.send(new AttachVolumeCommand({ VolumeId: id, InstanceId: String(v.instanceId), Device: String(v.device) }));
        return { message: `Attaching ${id} to ${r.InstanceId} as ${r.Device} (${r.State}).` };
      },
    },
    {
      id: "detach",
      label: "Detach volume",
      confirm: "Unmount the volume in the operating system first, or you may lose data.",
      fields: [{ name: "force", label: "Force detach", kind: "checkbox", default: false, help: "Use only as a last resort; data may be lost." }],
      async run(ctx, id, v) {
        const r = await ctx.clients.ec2.send(new DetachVolumeCommand({ VolumeId: id, Force: v.force === true || undefined }));
        return { message: `Detaching ${id} from ${r.InstanceId ?? "?"} (${r.State ?? "detaching"}).` };
      },
    },
    ec2TagAction("volume", async (ctx, id) => (await oneVolume(ctx, id)).Tags),
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.ec2.send(new DeleteVolumeCommand({ VolumeId: id }));
    },
  },
};

// ---- Snapshots ----

function snapshotRow(s: Snapshot): Row {
  return {
    name: nameTag(s.Tags),
    snapshotId: s.SnapshotId ?? "",
    size: s.VolumeSize ?? null,
    description: s.Description || null,
    tier: s.StorageTier ?? null,
    status: s.State ?? null,
    started: s.StartTime ?? null,
    progress: s.Progress || null,
    encryption: s.Encrypted ? "Encrypted" : "Not encrypted",
    volumeId: s.VolumeId ?? null,
    owner: s.OwnerId ?? null,
  };
}

async function oneSnapshot(ctx: Ctx, id: string): Promise<Snapshot> {
  const s = (await ctx.clients.ec2.send(new DescribeSnapshotsCommand({ SnapshotIds: [id] }))).Snapshots?.[0];
  if (!s) throw new Error(`Snapshot ${id} was not found.`);
  return s;
}

export const snapshots: ResourceDef = {
  id: "snapshots",
  name: "Snapshots",
  singular: "snapshot",
  idField: "snapshotId",
  nameField: "Snapshot ID",
  description: "Point-in-time backups of EBS volumes, owned by me.",
  emptyText: "You don't own any snapshots in this region.",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "snapshotId", label: "Snapshot ID", kind: "link" },
    { key: "size", label: "Volume size (GiB)", kind: "count" },
    { key: "description", label: "Description", kind: "text" },
    { key: "tier", label: "Storage tier", kind: "text" },
    { key: "status", label: "Snapshot status", kind: "status" },
    { key: "started", label: "Started", kind: "date" },
    { key: "progress", label: "Progress", kind: "text" },
    { key: "encryption", label: "Encryption", kind: "text" },
    { key: "volumeId", label: "Source volume", kind: "text" },
  ],
  async list(ctx) {
    const out: Row[] = [];
    let token: string | undefined;
    do {
      const r = await ctx.clients.ec2.send(new DescribeSnapshotsCommand({ OwnerIds: ["self"], NextToken: token }));
      out.push(...(r.Snapshots ?? []).map(snapshotRow));
      token = r.NextToken;
    } while (token);
    return out.sort((a, b) => String(b.started ?? "").localeCompare(String(a.started ?? "")));
  },
  async get(ctx, id) {
    const s = await oneSnapshot(ctx, id);
    const row = snapshotRow(s);
    return {
      summary: { "Snapshot ID": id, Name: row.name, "Snapshot status": s.State ?? null, "Volume size (GiB)": s.VolumeSize ?? null, Progress: s.Progress || null, Owner: s.OwnerId ?? null },
      tabs: [
        { id: "details", label: "Details", kind: "keyvalue", data: { Description: s.Description || null, "Source volume": s.VolumeId ?? null, Started: s.StartTime ?? null, Encryption: row.encryption, "KMS key ID": s.KmsKeyId ?? null, "Storage tier": s.StorageTier ?? null, "State message": s.StateMessage ?? null } },
        { id: "tags", label: "Tags", kind: "table", columns: TAG_COLUMNS, data: tagRows(s.Tags), emptyText: "No tags." },
      ],
    };
  },
  create: {
    title: "Create snapshot",
    description: "Creates a snapshot of an EBS volume with CreateSnapshot.",
    fields: [
      { name: "resourceType", label: "Resource type", kind: "radio", default: "volume", section: "Details", options: [{ value: "volume", label: "Volume: create a snapshot of a single volume" }] },
      { name: "volumeId", label: "Volume ID", kind: "select", required: true, options: availableVolumeOptions, section: "Details" },
      { name: "description", label: "Description", kind: "text", section: "Details", validate: { max: 255, message: "At most 255 characters." } },
      { name: "name", label: "Name", kind: "text", section: "Tags" },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const r = await ctx.clients.ec2.send(new CreateSnapshotCommand({ VolumeId: String(v.volumeId), Description: text(v.description), TagSpecifications: tagSpec("snapshot", withName(v.name, tagsOf(v.tags))) }));
      if (!r.SnapshotId) throw new Error("CreateSnapshot returned no snapshot ID.");
      return r.SnapshotId;
    },
  },
  actions: [
    {
      id: "copy",
      label: "Copy snapshot",
      fields: [
        { name: "description", label: "Description", kind: "text", help: "The copy is made in the Region selected in the top bar, from the same Region." },
        { name: "encrypted", label: "Encrypt this snapshot", kind: "checkbox", default: false },
      ],
      async run(ctx, id, v) {
        const r = await ctx.clients.ec2.send(new CopySnapshotCommand({ SourceSnapshotId: id, SourceRegion: ctx.region, Description: text(v.description), Encrypted: v.encrypted === true || undefined }));
        return { message: `Copy started: ${r.SnapshotId ?? "(no ID returned)"} in ${ctx.region}.` };
      },
    },
    {
      id: "create-volume",
      label: "Create volume from snapshot",
      fields: [
        { name: "az", label: "Availability Zone", kind: "select", required: true, options: availabilityZoneOptions },
        { name: "type", label: "Volume type", kind: "select", required: true, default: "gp3", options: typeOptions },
        { name: "size", label: "Size (GiB)", kind: "number", help: "At least the snapshot size. Leave empty to use it.", validate: { min: 1, max: 65536, message: "Between 1 and 65536 GiB." } },
      ],
      async run(ctx, id, v) {
        const r = await ctx.clients.ec2.send(new CreateVolumeCommand({ SnapshotId: id, AvailabilityZone: String(v.az), VolumeType: text(v.type) as VolumeType, Size: num(v.size) }));
        return { message: `Created volume ${r.VolumeId ?? "?"} (${r.State ?? "creating"}).` };
      },
    },
    {
      id: "create-image",
      label: "Create image from snapshot",
      fields: [
        { name: "name", label: "Image name", kind: "text", required: true, validate: { pattern: "[a-zA-Z0-9()\\[\\] ./'@_-]{3,128}", message: "3-128 letters, numbers and ( ) [ ] space . / ' @ _ -" } },
        { name: "description", label: "Description", kind: "text" },
        { name: "architecture", label: "Architecture", kind: "radio", default: "x86_64", options: [{ value: "x86_64", label: "x86_64" }, { value: "arm64", label: "arm64" }] },
        { name: "rootDevice", label: "Root device name", kind: "text", default: "/dev/xvda", required: true },
        { name: "volumeType", label: "Volume type", kind: "select", default: "gp3", options: VOLUME_TYPES.map((t) => ({ value: t, label: t })) },
      ],
      async run(ctx, id, v) {
        const device = String(v.rootDevice);
        const r = await ctx.clients.ec2.send(
          new RegisterImageCommand({ Name: String(v.name), Description: text(v.description), Architecture: v.architecture === "arm64" ? "arm64" : "x86_64", VirtualizationType: "hvm", RootDeviceName: device, BlockDeviceMappings: [{ DeviceName: device, Ebs: { SnapshotId: id, VolumeType: text(v.volumeType) as VolumeType, DeleteOnTermination: true } }] })
        );
        return { message: `Registered AMI ${r.ImageId ?? "?"}.` };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.ec2.send(new DeleteSnapshotCommand({ SnapshotId: id }));
    },
  },
};
