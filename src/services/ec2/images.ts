/**
 * AMIs (images owned by this account) and the AMI Catalog (Quick Start images owned by Amazon).
 * AWS Emulator does not implement CreateImage or DeregisterImage, so images are made with
 * RegisterImage (from an EBS snapshot) or CopyImage, and can't be deregistered.
 */

import { CopyImageCommand, CreateTagsCommand, DescribeImageAttributeCommand, DescribeImagesCommand, DescribeSnapshotsCommand, RegisterImageCommand, type Image } from "@aws-sdk/client-ec2";
import type { Ctx, Detail, Option, ResourceDef, Row, Tag } from "../../console/types.ts";
import { amiFamily, nameTag, tagRows } from "./helpers.ts";
import { VOLUME_TYPES } from "./launch.ts";

function imageRow(i: Image): Row {
  return {
    name: nameTag(i.Tags),
    amiName: i.Name ?? null,
    imageId: i.ImageId ?? "",
    source: i.ImageLocation ?? null,
    owner: i.OwnerId ?? null,
    visibility: i.Public ? "Public" : "Private",
    status: i.State ?? null,
    created: i.CreationDate ?? null,
    platform: i.PlatformDetails ?? null,
    rootDeviceType: i.RootDeviceType ?? null,
    architecture: i.Architecture ?? null,
    family: amiFamily(i),
    description: i.Description ?? null,
  };
}

async function oneImage(ctx: Ctx, id: string): Promise<Image> {
  const img = (await ctx.clients.ec2.send(new DescribeImagesCommand({ ImageIds: [id] }))).Images?.[0];
  if (!img) throw new Error(`AMI ${id} was not found.`);
  return img;
}

async function imageDetail(ctx: Ctx, id: string): Promise<Detail> {
  const i = await oneImage(ctx, id);
  const perms = await ctx.clients.ec2.send(new DescribeImageAttributeCommand({ ImageId: id, Attribute: "launchPermission" })).catch(() => null);
  return {
    summary: { "AMI ID": id, "AMI name": i.Name ?? null, Owner: i.OwnerId ?? null, Status: i.State ?? null, Architecture: i.Architecture ?? null, "Platform details": i.PlatformDetails ?? null },
    tabs: [
      {
        id: "details",
        label: "Details",
        kind: "keyvalue",
        data: {
          Description: i.Description ?? null,
          "Source (image location)": i.ImageLocation ?? null,
          Visibility: i.Public ? "Public" : "Private",
          "Creation date": i.CreationDate ?? null,
          "Root device name": i.RootDeviceName ?? null,
          "Root device type": i.RootDeviceType ?? null,
          "Virtualization type": i.VirtualizationType ?? null,
          "Boot mode": i.BootMode ?? null,
          "ENA support": i.EnaSupport ?? null,
          "Usage operation": i.UsageOperation ?? null,
          "Deregistration protection": i.DeregistrationProtection ?? null,
          "Free tier eligible": (i as Image & { FreeTierEligible?: boolean }).FreeTierEligible ?? null,
          "Quick Start family": amiFamily(i),
        },
      },
      {
        id: "storage",
        label: "Storage",
        kind: "table",
        columns: [
          { key: "device", label: "Device name", kind: "text" },
          { key: "snapshot", label: "Snapshot", kind: "text" },
          { key: "size", label: "Size (GiB)", kind: "count" },
          { key: "type", label: "Volume type", kind: "text" },
          { key: "encrypted", label: "Encrypted", kind: "boolean" },
          { key: "deleteOnTermination", label: "Delete on termination", kind: "boolean" },
        ],
        data: (i.BlockDeviceMappings ?? []).map((b) => ({ device: b.DeviceName ?? null, snapshot: b.Ebs?.SnapshotId ?? null, size: b.Ebs?.VolumeSize ?? null, type: b.Ebs?.VolumeType ?? null, encrypted: b.Ebs?.Encrypted ?? null, deleteOnTermination: b.Ebs?.DeleteOnTermination ?? null })),
        emptyText: "No block device mappings.",
      },
      { id: "permissions", label: "Permissions", kind: "json", data: perms ? perms.LaunchPermissions ?? [] : null, description: "Launch permissions from DescribeImageAttribute.", emptyText: "Launch permissions could not be read." },
      { id: "tags", label: "Tags", kind: "table", columns: [{ key: "Key", label: "Key", kind: "text" }, { key: "Value", label: "Value", kind: "text" }], data: tagRows(i.Tags), emptyText: "No tags." },
    ],
  };
}

const IMAGE_COLUMNS = [
  { key: "name", label: "Name", kind: "text" as const },
  { key: "amiName", label: "AMI name", kind: "text" as const },
  { key: "imageId", label: "AMI ID", kind: "link" as const },
  { key: "source", label: "Source", kind: "text" as const },
  { key: "owner", label: "Owner", kind: "text" as const },
  { key: "visibility", label: "Visibility", kind: "text" as const },
  { key: "status", label: "Status", kind: "status" as const },
  { key: "created", label: "Creation date", kind: "date" as const },
  { key: "platform", label: "Platform", kind: "text" as const },
  { key: "architecture", label: "Architecture", kind: "text" as const },
  { key: "rootDeviceType", label: "Root device type", kind: "text" as const },
];

async function selfSnapshotOptions(ctx: Ctx): Promise<Option[]> {
  const r = await ctx.clients.ec2.send(new DescribeSnapshotsCommand({ OwnerIds: ["self"] }));
  return (r.Snapshots ?? []).filter((s) => s.SnapshotId).map((s) => ({ value: s.SnapshotId as string, label: `${s.SnapshotId} - ${s.VolumeSize ?? "?"} GiB ${s.Description ? `(${s.Description})` : ""}` }));
}

const copyAction = {
  id: "copy",
  label: "Copy AMI",
  fields: [
    { name: "name", label: "AMI copy name", kind: "text" as const, required: true, validate: { pattern: "[a-zA-Z0-9()\\[\\] ./'@_-]{3,128}", message: "3-128 letters, numbers and ( ) [ ] space . / ' @ _ -" } },
    { name: "description", label: "AMI copy description", kind: "text" as const },
    { name: "encrypted", label: "Encrypt EBS snapshots of AMI copy", kind: "checkbox" as const, default: false },
  ],
  async run(ctx: Ctx, id: string, v: Record<string, unknown>) {
    const r = await ctx.clients.ec2.send(
      new CopyImageCommand({ SourceImageId: id, SourceRegion: ctx.region, Name: String(v.name), Description: typeof v.description === "string" && v.description ? v.description : undefined, Encrypted: v.encrypted === true || undefined })
    );
    return { message: `Copying AMI ${id} to ${r.ImageId ?? "(no ID returned)"} in ${ctx.region}.` };
  },
};

export const amis: ResourceDef = {
  id: "amis",
  name: "AMIs",
  singular: "AMI",
  idField: "imageId",
  nameField: "AMI name",
  description: "Amazon Machine Images owned by me. Public Amazon images are on the AMI Catalog page.",
  emptyText: "You don't own any AMIs. Register one from an EBS snapshot, or copy one from the AMI Catalog.",
  columns: IMAGE_COLUMNS,
  async list(ctx) {
    const r = await ctx.clients.ec2.send(new DescribeImagesCommand({ Owners: ["self"] }));
    return (r.Images ?? []).map(imageRow);
  },
  get: imageDetail,
  create: {
    title: "Register image",
    description: "Registers an AMI from an EBS snapshot with RegisterImage. (To make an image from an instance you'd use Create image, which AWS Emulator doesn't implement.)",
    fields: [
      { name: "name", label: "Image name", kind: "text", required: true, section: "Image details", validate: { pattern: "[a-zA-Z0-9()\\[\\] ./'@_-]{3,128}", message: "3-128 letters, numbers and ( ) [ ] space . / ' @ _ -" } },
      { name: "description", label: "Image description", kind: "text", section: "Image details" },
      { name: "architecture", label: "Architecture", kind: "radio", default: "x86_64", section: "Image details", options: [{ value: "x86_64", label: "64-bit (x86)" }, { value: "arm64", label: "64-bit (Arm)" }] },
      { name: "rootDevice", label: "Root device name", kind: "text", default: "/dev/xvda", required: true, section: "Root volume" },
      { name: "snapshotId", label: "Snapshot", kind: "select", required: true, options: selfSnapshotOptions, section: "Root volume" },
      { name: "volumeType", label: "Volume type", kind: "select", default: "gp3", options: VOLUME_TYPES.map((t) => ({ value: t, label: t })), section: "Root volume" },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const r = await ctx.clients.ec2.send(
        new RegisterImageCommand({
          Name: String(v.name),
          Description: typeof v.description === "string" && v.description ? v.description : undefined,
          Architecture: v.architecture === "arm64" ? "arm64" : "x86_64",
          VirtualizationType: "hvm",
          RootDeviceName: String(v.rootDevice),
          BlockDeviceMappings: [{ DeviceName: String(v.rootDevice), Ebs: { SnapshotId: String(v.snapshotId), VolumeType: (typeof v.volumeType === "string" && v.volumeType ? v.volumeType : undefined) as never, DeleteOnTermination: true } }],
        })
      );
      if (!r.ImageId) throw new Error("RegisterImage returned no image ID.");
      const tags = Array.isArray(v.tags) ? (v.tags as Tag[]) : [];
      if (tags.length) await ctx.clients.ec2.send(new CreateTagsCommand({ Resources: [r.ImageId], Tags: tags }));
      return r.ImageId;
    },
  },
  actions: [copyAction],
};

export const amiCatalog: ResourceDef = {
  id: "ami-catalog",
  name: "AMI Catalog",
  singular: "AMI",
  idField: "imageId",
  nameField: "AMI name",
  description: "Quick Start AMIs owned by Amazon, from DescribeImages. Launch one from Instances › Launch instances.",
  emptyText: "DescribeImages returned no Amazon-owned images.",
  columns: [
    { key: "family", label: "Quick Start", kind: "text" },
    { key: "amiName", label: "AMI name", kind: "text" },
    { key: "imageId", label: "AMI ID", kind: "link" },
    { key: "architecture", label: "Architecture", kind: "text" },
    { key: "platform", label: "Platform", kind: "text" },
    { key: "created", label: "Publish date", kind: "date" },
    { key: "description", label: "Description", kind: "text", hidden: true },
  ],
  async list(ctx) {
    const r = await ctx.clients.ec2.send(new DescribeImagesCommand({ Owners: ["amazon"] }));
    return (r.Images ?? []).map(imageRow).sort((a, b) => String(b.created ?? "").localeCompare(String(a.created ?? "")));
  },
  get: imageDetail,
  actions: [copyAction],
};
