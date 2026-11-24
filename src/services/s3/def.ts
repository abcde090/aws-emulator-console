/**
 * Amazon S3: buckets. The bucket detail screen is hand-built (src/app/s3/buckets/[bucket])
 * because it holds the object browser; its Properties and Permissions tabs come from get().
 */

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteBucketPolicyCommand,
  DeleteBucketTaggingCommand,
  DeleteObjectsCommand,
  GetBucketEncryptionCommand,
  GetBucketPolicyCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  ListBucketsCommand,
  ListObjectVersionsCommand,
  PutBucketEncryptionCommand,
  PutBucketPolicyCommand,
  PutBucketTaggingCommand,
  PutBucketVersioningCommand,
  PutPublicAccessBlockCommand,
  type PublicAccessBlockConfiguration,
} from "@aws-sdk/client-s3";
import type { Ctx, FieldDef, FieldValues, ResourceDef, Row, ServiceDef, Tag } from "../../console/types.ts";
import { optionalRead, type Optional } from "../../console/secondary.ts";
import { describeOptional, parseJsonText } from "./optional.ts";
import { fieldTags, noTagChanges, tagDiff, tagDiffMessage } from "../../console/tags.ts";
import { managementActions } from "./management-actions.ts";

const BUCKET_NAME = "(?!xn--)(?!sthree-)(?!.*\\.\\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]";

const BPA_FIELDS: { name: keyof PublicAccessBlockConfiguration; label: string }[] = [
  { name: "BlockPublicAcls", label: "Block public access granted through new access control lists (ACLs)" },
  { name: "IgnorePublicAcls", label: "Block public access granted through any access control lists (ACLs)" },
  { name: "BlockPublicPolicy", label: "Block public access granted through new public bucket or access point policies" },
  { name: "RestrictPublicBuckets", label: "Block public and cross-account access through any public bucket or access point policies" },
];


async function readBucketTags(ctx: Ctx, bucket: string): Promise<Tag[]> {
  const tags = await optionalRead(() => ctx.clients.s3.send(new GetBucketTaggingCommand({ Bucket: bucket })), ["NoSuchTagSet"]);
  if (tags.kind === "error") throw new Error(tags.error);
  return tags.kind === "value" ? (tags.value.TagSet ?? []).map((t) => ({ Key: t.Key ?? "", Value: t.Value ?? "" })) : [];
}

async function readBucket(ctx: Ctx, bucket: string) {
  const s3 = ctx.clients.s3;
  const [versioning, encryption, tags, bpa, policy] = await Promise.all([
    optionalRead(() => s3.send(new GetBucketVersioningCommand({ Bucket: bucket })), []),
    optionalRead(() => s3.send(new GetBucketEncryptionCommand({ Bucket: bucket })), ["ServerSideEncryptionConfigurationNotFoundError"]),
    optionalRead(() => s3.send(new GetBucketTaggingCommand({ Bucket: bucket })), ["NoSuchTagSet"]),
    optionalRead(() => s3.send(new GetPublicAccessBlockCommand({ Bucket: bucket })), ["NoSuchPublicAccessBlockConfiguration"]),
    optionalRead(() => s3.send(new GetBucketPolicyCommand({ Bucket: bucket })), ["NoSuchBucketPolicy"]),
  ]);
  return { versioning, encryption, tags, bpa, policy };
}

function encryptionText(enc: Optional<{ ServerSideEncryptionConfiguration?: { Rules?: { ApplyServerSideEncryptionByDefault?: { SSEAlgorithm?: string; KMSMasterKeyID?: string }; BucketKeyEnabled?: boolean }[] } }>): Row {
  if (enc.kind !== "value") return { "Default encryption": describeOptional(enc, "Not configured") };
  const rule = enc.value.ServerSideEncryptionConfiguration?.Rules?.[0];
  const algo = rule?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm;
  return {
    "Encryption type": algo === "AES256" ? "Server-side encryption with Amazon S3 managed keys (SSE-S3)" : algo === "aws:kms" ? "Server-side encryption with AWS KMS keys (SSE-KMS)" : algo ?? "Not set",
    "KMS key": rule?.ApplyServerSideEncryptionByDefault?.KMSMasterKeyID ?? null,
    "Bucket Key": rule?.BucketKeyEnabled === undefined ? null : rule.BucketKeyEnabled ? "Enabled" : "Disabled",
  };
}

function bpaRow(bpa: Optional<{ PublicAccessBlockConfiguration?: PublicAccessBlockConfiguration }>): Row {
  if (bpa.kind !== "value") {
    return { "Block all public access": bpa.kind === "missing" ? "Off (no public access block configuration)" : describeOptional(bpa, "") };
  }
  const c = bpa.value.PublicAccessBlockConfiguration ?? {};
  const all = BPA_FIELDS.every((f) => c[f.name] === true);
  return { "Block all public access": all ? "On" : "Off", ...Object.fromEntries(BPA_FIELDS.map((f) => [f.label, c[f.name] === true ? "On" : "Off"])) };
}

async function emptyBucket(ctx: Ctx, bucket: string): Promise<number> {
  let deleted = 0;
  let keyMarker: string | undefined;
  let versionMarker: string | undefined;
  for (;;) {
    const page = await ctx.clients.s3.send(new ListObjectVersionsCommand({ Bucket: bucket, KeyMarker: keyMarker, VersionIdMarker: versionMarker }));
    const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]
      .filter((o) => o.Key !== undefined)
      .map((o) => ({ Key: o.Key as string, VersionId: o.VersionId && o.VersionId !== "null" ? o.VersionId : undefined }));
    for (let i = 0; i < objects.length; i += 1000) {
      const r = await ctx.clients.s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects.slice(i, i + 1000), Quiet: false } }));
      deleted += r.Deleted?.length ?? 0;
      if (r.Errors?.length) throw new Error(`Deleted ${deleted}; ${r.Errors.length} failed: ${r.Errors.map((e) => `${e.Key}: ${e.Code}`).join(", ")}`);
    }
    if (!page.IsTruncated) return deleted;
    keyMarker = page.NextKeyMarker;
    versionMarker = page.NextVersionIdMarker;
  }
}

async function applyBucketSettings(ctx: Ctx, bucket: string, v: FieldValues): Promise<void> {
  const s3 = ctx.clients.s3;
  if (v.blockAll === true) {
    await s3.send(new PutPublicAccessBlockCommand({ Bucket: bucket, PublicAccessBlockConfiguration: Object.fromEntries(BPA_FIELDS.map((f) => [f.name, true])) }));
  }
  if (v.versioning === true) await s3.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));
  if (v.encryption === "aws:kms") {
    await s3.send(new PutBucketEncryptionCommand({ Bucket: bucket, ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms", KMSMasterKeyID: typeof v.kmsKey === "string" && v.kmsKey ? v.kmsKey : undefined }, BucketKeyEnabled: true }] } }));
  } else if (v.encryption === "AES256") {
    await s3.send(new PutBucketEncryptionCommand({ Bucket: bucket, ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] } }));
  }
  const tags = fieldTags(v.tags);
  if (tags.length) await s3.send(new PutBucketTaggingCommand({ Bucket: bucket, Tagging: { TagSet: tags } }));
}

const encryptionFields: FieldDef[] = [
  {
    name: "encryption", label: "Encryption type", kind: "radio", default: "AES256", section: "Default encryption",
    options: [
      { value: "AES256", label: "Server-side encryption with Amazon S3 managed keys (SSE-S3)" },
      { value: "aws:kms", label: "Server-side encryption with AWS Key Management Service keys (SSE-KMS)" },
    ],
  },
  { name: "kmsKey", label: "AWS KMS key ARN or ID", kind: "text", section: "Default encryption", showIf: { field: "encryption", equals: "aws:kms" }, help: "Leave empty for the AWS managed key (aws/s3)." },
];

const buckets: ResourceDef = {
  id: "buckets",
  name: "Buckets",
  singular: "bucket",
  idField: "name",
  nameField: "name",
  description: "Buckets are containers for data stored in S3.",
  emptyText: "You don't have any buckets.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "region", label: "AWS Region", kind: "text" },
    { key: "created", label: "Creation date", kind: "date" },
  ],

  async list(ctx) {
    const rows: Row[] = [];
    let token: string | undefined;
    do {
      const r = await ctx.clients.s3.send(new ListBucketsCommand({ ContinuationToken: token, MaxBuckets: 1000 }));
      for (const b of r.Buckets ?? []) rows.push({ name: b.Name ?? "", region: b.BucketRegion ?? null, created: b.CreationDate ?? null });
      token = r.ContinuationToken;
    } while (token);
    return rows;
  },

  async get(ctx, bucket) {
    const { versioning, encryption, tags, bpa, policy } = await readBucket(ctx, bucket);
    const versioningStatus = versioning.kind === "value" ? versioning.value.Status ?? "Disabled" : describeOptional(versioning, "Disabled");
    return {
      summary: { Name: bucket, ARN: `arn:aws:s3:::${bucket}`, "Bucket Versioning": versioningStatus },
      tabs: [
        {
          id: "properties",
          label: "Properties",
          kind: "keyvalue",
          data: {
            "Bucket Versioning": versioningStatus,
            "MFA delete": versioning.kind === "value" ? versioning.value.MFADelete ?? "Disabled" : null,
            ...encryptionText(encryption),
          },
        },
        {
          id: "tags",
          label: "Tags",
          kind: "table",
          columns: [
            { key: "Key", label: "Key", kind: "text" },
            { key: "Value", label: "Value", kind: "text" },
          ],
          data: tags.kind === "value" ? tags.value.TagSet ?? [] : [],
          emptyText: tags.kind === "error" ? `Could not read tags: ${tags.error}` : "No tags are associated with this bucket.",
        },
        { id: "permissions", label: "Block public access", kind: "keyvalue", data: bpaRow(bpa) },
        {
          id: "policy",
          label: "Bucket policy",
          kind: "json",
          data: policy.kind === "value" ? parseJsonText(policy.value.Policy) : null,
          emptyText: policy.kind === "error" ? `Could not read the bucket policy: ${policy.error}` : "No policy to display.",
        },
      ],
    };
  },

  create: {
    title: "Create bucket",
    description: "Creates an S3 bucket in the emulator with CreateBucket, then applies the settings below.",
    fields: [
      {
        name: "name", label: "Bucket name", kind: "text", required: true, section: "General configuration", placeholder: "my-bucket",
        help: "3-63 characters: lowercase letters, numbers, dots and hyphens. Must start and end with a letter or number.",
        validate: { pattern: BUCKET_NAME, message: "Bucket names are 3-63 lowercase letters, numbers, dots or hyphens, starting and ending with a letter or number." },
      },
      { name: "blockAll", label: "Block all public access", kind: "checkbox", default: true, section: "Block Public Access settings for this bucket" },
      { name: "versioning", label: "Enable Bucket Versioning", kind: "checkbox", default: false, section: "Bucket Versioning" },
      ...encryptionFields,
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      await ctx.clients.s3.send(new CreateBucketCommand({ Bucket: name }));
      await applyBucketSettings(ctx, name, v);
      return name;
    },
  },

  actions: [
    {
      id: "versioning",
      label: "Edit Bucket Versioning",
      fields: [
        {
          name: "status", label: "Bucket Versioning", kind: "radio", required: true, default: "Enabled",
          help: "A bucket that has never had versioning is unversioned; once enabled, versioning can only be suspended.",
          options: [{ value: "Enabled", label: "Enable" }, { value: "Suspended", label: "Suspend" }],
        },
      ],
      async initialValues(ctx, bucket) {
        const r = await ctx.clients.s3.send(new GetBucketVersioningCommand({ Bucket: bucket }));
        // Never versioned: nothing is selected, so saving without a choice changes nothing.
        return { status: r.Status ?? "" };
      },
      async run(ctx, bucket, v) {
        const status = v.status === "Suspended" ? "Suspended" : "Enabled";
        const current = await ctx.clients.s3.send(new GetBucketVersioningCommand({ Bucket: bucket }));
        if (current.Status === status) return { message: `Bucket Versioning is already ${status}; nothing changed.` };
        await ctx.clients.s3.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: status } }));
        return { message: `Bucket Versioning is now ${status}.` };
      },
    },
    {
      id: "encryption",
      label: "Edit default encryption",
      fields: encryptionFields,
      async initialValues(ctx, bucket) {
        const enc = await optionalRead(() => ctx.clients.s3.send(new GetBucketEncryptionCommand({ Bucket: bucket })), ["ServerSideEncryptionConfigurationNotFoundError"]);
        if (enc.kind === "error") throw new Error(enc.error);
        const d = enc.kind === "value" ? enc.value.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault : undefined;
        return { encryption: d?.SSEAlgorithm === "aws:kms" ? "aws:kms" : "AES256", kmsKey: d?.KMSMasterKeyID ?? "" };
      },
      async run(ctx, bucket, v) {
        await applyBucketSettings(ctx, bucket, { encryption: v.encryption, kmsKey: v.kmsKey });
        return { message: "Default encryption saved." };
      },
    },
    {
      id: "tags",
      label: "Edit tags",
      fields: [{ name: "tags", label: "Tags", kind: "tags", help: "The bucket's current tags. Add, change or remove tags; remove all to delete the tag set." }],
      async initialValues(ctx, bucket) {
        return { tags: await readBucketTags(ctx, bucket) };
      },
      async run(ctx, bucket, v) {
        const tags = fieldTags(v.tags);
        const diff = tagDiff(await readBucketTags(ctx, bucket), tags);
        if (noTagChanges(diff)) return { message: tagDiffMessage(diff) };
        // S3 has no per-tag API for buckets: PutBucketTagging replaces the set, so send
        // the current tags with the user's edits applied (the dialog starts from them).
        if (tags.length === 0) await ctx.clients.s3.send(new DeleteBucketTaggingCommand({ Bucket: bucket }));
        else await ctx.clients.s3.send(new PutBucketTaggingCommand({ Bucket: bucket, Tagging: { TagSet: tags } }));
        return { message: tagDiffMessage(diff) };
      },
    },
    {
      id: "public-access",
      label: "Edit Block Public Access",
      fields: BPA_FIELDS.map((f) => ({ name: f.name, label: f.label, kind: "checkbox" as const, default: true })),
      async initialValues(ctx, bucket) {
        const bpa = await optionalRead(() => ctx.clients.s3.send(new GetPublicAccessBlockCommand({ Bucket: bucket })), ["NoSuchPublicAccessBlockConfiguration"]);
        if (bpa.kind === "error") throw new Error(bpa.error);
        const c = bpa.kind === "value" ? bpa.value.PublicAccessBlockConfiguration ?? {} : {};
        return Object.fromEntries(BPA_FIELDS.map((f) => [f.name, c[f.name] === true]));
      },
      async run(ctx, bucket, v) {
        const config = Object.fromEntries(BPA_FIELDS.map((f) => [f.name, v[f.name] === true]));
        await ctx.clients.s3.send(new PutPublicAccessBlockCommand({ Bucket: bucket, PublicAccessBlockConfiguration: config }));
        return { message: "Block Public Access settings saved." };
      },
    },
    {
      id: "policy",
      label: "Edit bucket policy",
      fields: [{ name: "policy", label: "Policy", kind: "json", required: true, help: "A bucket policy JSON document." }],
      async initialValues(ctx, bucket) {
        const policy = await optionalRead(() => ctx.clients.s3.send(new GetBucketPolicyCommand({ Bucket: bucket })), ["NoSuchBucketPolicy"]);
        if (policy.kind === "error") throw new Error(policy.error);
        if (policy.kind === "missing") return { policy: "" };
        const parsed = parseJsonText(policy.value.Policy);
        return { policy: typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2) };
      },
      async run(ctx, bucket, v) {
        await ctx.clients.s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: String(v.policy) }));
        return { message: "Bucket policy saved." };
      },
    },
    {
      id: "delete-policy",
      label: "Delete bucket policy",
      danger: true,
      confirm: "This removes the bucket policy.",
      async run(ctx, bucket) {
        await ctx.clients.s3.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
        return { message: "Bucket policy deleted." };
      },
    },
    {
      id: "empty",
      label: "Empty",
      danger: true,
      confirm: "Emptying deletes every object and object version in the bucket. This can't be undone.",
      async run(ctx, bucket) {
        const n = await emptyBucket(ctx, bucket);
        return { message: `Deleted ${n} object${n === 1 ? "" : "s"} and versions.` };
      },
    },
    // Lifecycle, replication and inventory: opened from the Management tab.
    ...managementActions,
  ],

  delete: {
    confirmText: "name",
    async run(ctx, bucket) {
      await ctx.clients.s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    },
  },
  detailHref: "buckets/{id}",
};

export const s3Service: ServiceDef = {
  id: "s3",
  name: "Amazon S3",
  category: "Storage",
  description: "Object storage built to retrieve any amount of data from anywhere.",
  resources: [buckets],
};
