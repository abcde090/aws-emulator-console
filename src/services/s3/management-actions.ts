/**
 * The S3 bucket Management tab's actions: lifecycle rules, replication rules and inventory
 * configurations. They are hidden engine actions (validated field specs, initialValues for
 * the Edit dialogs), opened from the hand-built tab (ManagementTab.tsx). The action id is
 * the bucket for "Create", or joinId(bucket, rule) for "Edit" and "Delete".
 *
 * S3 stores each configuration as one document, so every save reads the current
 * configuration, changes one rule and writes the whole document back.
 */

import {
  DeleteBucketInventoryConfigurationCommand,
  DeleteBucketLifecycleCommand,
  DeleteBucketReplicationCommand,
  GetBucketInventoryConfigurationCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketReplicationCommand,
  GetBucketVersioningCommand,
  ListBucketsCommand,
  PutBucketInventoryConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketReplicationCommand,
  type LifecycleRule,
  type ReplicationConfiguration,
} from "@aws-sdk/client-s3";
import { optionalRead } from "../../console/secondary.ts";
import type { ActionDef, Ctx, FieldDef, FieldValues, Option } from "../../console/types.ts";
import { ID_SEP, splitId } from "../../console/values.ts";
import { roleOptions } from "../eventbridge/lookups.ts";
import {
  canonicalJson,
  checkPriorities,
  inventoryFromValues,
  inventoryValues,
  lifecycleRuleFromValues,
  lifecycleValues,
  nextPriority,
  normalisedLifecycleRule,
  normalisedReplicationRule,
  REPLICATION_CLASSES,
  replicationRuleFromValues,
  replicationValues,
  TRANSITION_CLASSES,
  TRANSITION_SLOTS,
  withRule,
} from "./management.ts";

/** "bucket" -> [bucket, null]; "bucket~rule" -> [bucket, rule]. Bucket names never contain "~". */
export function bucketAndRule(id: string): [string, string | null] {
  return id.includes(ID_SEP) ? splitId(id, "rule") : [id, null];
}

export async function readLifecycle(ctx: Ctx, bucket: string): Promise<{ rules: LifecycleRule[]; minSize: string | undefined }> {
  const r = await optionalRead(() => ctx.clients.s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket })), ["NoSuchLifecycleConfiguration"]);
  if (r.kind === "error") throw new Error(r.error);
  return r.kind === "missing" ? { rules: [], minSize: undefined } : { rules: r.value.Rules ?? [], minSize: r.value.TransitionDefaultMinimumObjectSize };
}

export async function readReplication(ctx: Ctx, bucket: string): Promise<ReplicationConfiguration | null> {
  const r = await optionalRead(() => ctx.clients.s3.send(new GetBucketReplicationCommand({ Bucket: bucket })), ["ReplicationConfigurationNotFoundError"]);
  if (r.kind === "error") throw new Error(r.error);
  return r.kind === "missing" ? null : r.value.ReplicationConfiguration ?? null;
}

async function versioningOf(ctx: Ctx, bucket: string): Promise<string> {
  return (await ctx.clients.s3.send(new GetBucketVersioningCommand({ Bucket: bucket }))).Status ?? "Disabled";
}

/** Buckets other than the one being configured (a replication destination can't be the source). */
async function otherBuckets(ctx: Ctx, id?: string): Promise<Option[]> {
  const source = id ? bucketAndRule(id)[0] : "";
  const r = await ctx.clients.s3.send(new ListBucketsCommand({ MaxBuckets: 1000 }));
  return (r.Buckets ?? []).filter((b) => b.Name && b.Name !== source).map((b) => ({ value: b.Name as string, label: b.Name as string }));
}

async function allBuckets(ctx: Ctx): Promise<Option[]> {
  const r = await ctx.clients.s3.send(new ListBucketsCommand({ MaxBuckets: 1000 }));
  return (r.Buckets ?? []).filter((b) => b.Name).map((b) => ({ value: b.Name as string, label: b.Name as string }));
}

const STATUS_FIELD: FieldDef = {
  name: "status", label: "Status", kind: "radio", default: "Enabled",
  options: [{ value: "Enabled", label: "Enabled" }, { value: "Disabled", label: "Disabled" }],
};

const SCOPE_FIELDS: FieldDef[] = [
  {
    name: "scope", label: "Choose a rule scope", kind: "radio", default: "filter",
    options: [{ value: "filter", label: "Limit the scope of this rule using one or more filters" }, { value: "all", label: "Apply to all objects in the bucket" }],
  },
  { name: "prefix", label: "Prefix", kind: "text", placeholder: "logs/", showIf: { field: "scope", equals: "filter" }, help: "Objects whose key starts with this prefix." },
  { name: "filterTags", label: "Object tags", kind: "tags", showIf: { field: "scope", equals: "filter" } },
];

function transitionSlots(prefix: "t" | "n", parent: string, daysLabel: string): FieldDef[] {
  const out: FieldDef[] = [];
  for (let i = 1; i <= TRANSITION_SLOTS; i++) {
    out.push({ name: `${prefix}${i}Class`, label: `Transition ${i}: storage class`, kind: "select", options: TRANSITION_CLASSES, showIf: { field: parent, equals: true }, default: i === 1 ? "STANDARD_IA" : undefined });
    out.push({ name: `${prefix}${i}Days`, label: `Transition ${i}: ${daysLabel}`, kind: "number", showIf: { field: parent, equals: true }, validate: { min: prefix === "t" ? 0 : 1, message: "Enter a whole number of days." } });
    if (prefix === "n") out.push({ name: `n${i}Newer`, label: `Transition ${i}: number of newer versions to retain`, kind: "number", showIf: { field: parent, equals: true }, validate: { min: 1, max: 100, message: "Enter 1-100 versions." } });
  }
  return out;
}

const LIFECYCLE_FIELDS: FieldDef[] = [
  { name: "ruleId", label: "Lifecycle rule name", kind: "text", required: true, help: "Up to 255 characters.", validate: { pattern: "[^~]{1,255}", message: "Up to 255 characters, without \"~\"." } },
  STATUS_FIELD,
  ...SCOPE_FIELDS,
  { name: "minSize", label: "Minimum object size (bytes)", kind: "number", showIf: { field: "scope", equals: "filter" }, validate: { min: 0, message: "Enter a size in bytes." } },
  { name: "maxSize", label: "Maximum object size (bytes)", kind: "number", showIf: { field: "scope", equals: "filter" }, validate: { min: 1, message: "Enter a size in bytes." } },
  { name: "transitionCurrent", label: "Move current versions of objects between storage classes", kind: "checkbox" },
  ...transitionSlots("t", "transitionCurrent", "days after object creation"),
  { name: "transitionNoncurrent", label: "Move noncurrent versions of objects between storage classes", kind: "checkbox" },
  ...transitionSlots("n", "transitionNoncurrent", "days after objects become noncurrent"),
  { name: "expireCurrent", label: "Expire current versions of objects", kind: "checkbox" },
  { name: "expireDays", label: "Days after object creation", kind: "number", showIf: { field: "expireCurrent", equals: true }, validate: { min: 1, message: "Enter at least 1 day." } },
  { name: "expireNoncurrent", label: "Permanently delete noncurrent versions of objects", kind: "checkbox" },
  { name: "noncurrentExpireDays", label: "Days after objects become noncurrent", kind: "number", showIf: { field: "expireNoncurrent", equals: true }, validate: { min: 1, message: "Enter at least 1 day." } },
  { name: "noncurrentExpireNewer", label: "Number of newer versions to retain", kind: "number", showIf: { field: "expireNoncurrent", equals: true }, validate: { min: 1, max: 100, message: "Enter 1-100 versions." } },
  { name: "deleteMarkers", label: "Delete expired object delete markers", kind: "checkbox", help: "Not available with \"Expire current versions\" or with tag or size filters." },
  { name: "abortMultipart", label: "Delete incomplete multipart uploads", kind: "checkbox", help: "Not available with tag or size filters." },
  { name: "abortDays", label: "Number of days", kind: "number", showIf: { field: "abortMultipart", equals: true }, validate: { min: 1, message: "Enter at least 1 day." } },
];

const REPLICATION_FIELDS: FieldDef[] = [
  { name: "ruleId", label: "Replication rule name", kind: "text", required: true, help: "Up to 255 characters.", validate: { pattern: "[^~]{1,255}", message: "Up to 255 characters, without \"~\"." } },
  STATUS_FIELD,
  { name: "priority", label: "Priority", kind: "number", required: true, help: "When rules overlap, the rule with the highest number wins. Each rule needs a unique priority.", validate: { min: 0, message: "Enter a whole number, 0 or more." } },
  ...SCOPE_FIELDS,
  { name: "destBucket", label: "Destination bucket", kind: "select", required: true, options: otherBuckets, help: "A bucket in this account. AWS requires Bucket Versioning on both the source and the destination." },
  { name: "role", label: "IAM role", kind: "select", required: true, options: roleOptions, help: "S3 assumes this role to replicate objects. One role applies to every replication rule in the bucket." },
  { name: "changeStorageClass", label: "Change the storage class for the replicated objects", kind: "checkbox" },
  { name: "storageClass", label: "Storage class", kind: "select", options: REPLICATION_CLASSES, default: "STANDARD", showIf: { field: "changeStorageClass", equals: true } },
  { name: "deleteMarkerReplication", label: "Delete marker replication", kind: "checkbox", help: "Replicate delete markers created by S3 delete operations. Not supported for rules with tag filters." },
];

const INVENTORY_FIELDS: FieldDef[] = [
  { name: "inventoryId", label: "Inventory configuration name", kind: "text", required: true, validate: { pattern: "[A-Za-z0-9._-]{1,64}", message: "1-64 letters, numbers, dots, hyphens or underscores." } },
  { name: "prefix", label: "Inventory scope prefix", kind: "text", help: "Leave empty to list every object in the bucket." },
  { name: "versions", label: "Object versions", kind: "radio", default: "Current", options: [{ value: "Current", label: "Current version only" }, { value: "All", label: "Include all versions" }] },
  { name: "destBucket", label: "Destination bucket", kind: "select", required: true, options: allBuckets },
  { name: "destPrefix", label: "Destination prefix", kind: "text" },
  { name: "frequency", label: "Frequency", kind: "radio", default: "Daily", options: [{ value: "Daily", label: "Daily" }, { value: "Weekly", label: "Weekly" }] },
  { name: "format", label: "Output format", kind: "radio", default: "CSV", options: [{ value: "CSV", label: "CSV" }, { value: "ORC", label: "Apache ORC" }, { value: "Parquet", label: "Apache Parquet" }] },
  { name: "enabled", label: "Enable this inventory configuration", kind: "checkbox", default: true },
  {
    name: "optionalFields", label: "Additional metadata fields", kind: "multiselect",
    options: ["Size", "LastModifiedDate", "StorageClass", "ETag", "IsMultipartUploaded", "ReplicationStatus", "EncryptionStatus", "ObjectLockRetainUntilDate", "ObjectLockMode", "ObjectLockLegalHoldStatus", "IntelligentTieringAccessTier", "BucketKeyStatus", "ChecksumAlgorithm"].map((f) => ({ value: f, label: f })),
  },
];

/** Delete dialogs ask for the rule's name, like the console's other deletes. */
const CONFIRM_FIELDS: FieldDef[] = [{ name: "confirm", label: "To confirm deletion, enter the name", kind: "text", required: true }];

function confirmed(v: FieldValues, name: string): void {
  if (v.confirm !== name) throw new Error(`Enter "${name}" to confirm deletion.`);
}

async function putLifecycle(ctx: Ctx, bucket: string, rules: LifecycleRule[], minSize: string | undefined): Promise<void> {
  if (rules.length === 0) {
    await ctx.clients.s3.send(new DeleteBucketLifecycleCommand({ Bucket: bucket }));
    return;
  }
  await ctx.clients.s3.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: { Rules: rules },
      ...(minSize ? { TransitionDefaultMinimumObjectSize: minSize as "all_storage_classes_128K" } : {}),
    })
  );
}

const lifecycleSave: ActionDef = {
  id: "lifecycle-save",
  label: "Save lifecycle rule",
  hidden: true,
  fields: LIFECYCLE_FIELDS,
  async initialValues(ctx, id) {
    const [bucket, ruleId] = bucketAndRule(id);
    if (ruleId === null) return {};
    const rule = (await readLifecycle(ctx, bucket)).rules.find((r) => r.ID === ruleId);
    if (!rule) throw new Error(`Lifecycle rule "${ruleId}" no longer exists. Reload the page.`);
    return lifecycleValues(rule);
  },
  async run(ctx, id, v) {
    const [bucket, ruleId] = bucketAndRule(id);
    const rule = lifecycleRuleFromValues(v);
    const current = await readLifecycle(ctx, bucket);
    if (ruleId !== null) {
      const before = current.rules.find((r) => r.ID === ruleId);
      if (before && normalisedLifecycleRule(before) === canonicalJson(rule)) return { message: "No changes to save." };
    }
    await putLifecycle(ctx, bucket, withRule(current.rules, rule, ruleId), current.minSize);
    return { message: ruleId === null ? `Created lifecycle rule "${rule.ID ?? ""}".` : `Saved lifecycle rule "${rule.ID ?? ""}".` };
  },
};

const lifecycleDelete: ActionDef = {
  id: "lifecycle-delete",
  label: "Delete lifecycle rule",
  hidden: true,
  danger: true,
  fields: CONFIRM_FIELDS,
  async run(ctx, id, v) {
    const [bucket, ruleId] = bucketAndRule(id);
    if (ruleId === null) throw new Error("Choose a lifecycle rule to delete.");
    confirmed(v, ruleId);
    const current = await readLifecycle(ctx, bucket);
    if (!current.rules.some((r) => r.ID === ruleId)) throw new Error(`Lifecycle rule "${ruleId}" no longer exists. Reload the page.`);
    await putLifecycle(ctx, bucket, current.rules.filter((r) => r.ID !== ruleId), current.minSize);
    return { message: `Deleted lifecycle rule "${ruleId}".` };
  },
};

const replicationSave: ActionDef = {
  id: "replication-save",
  label: "Save replication rule",
  hidden: true,
  fields: REPLICATION_FIELDS,
  async initialValues(ctx, id) {
    const [bucket, ruleId] = bucketAndRule(id);
    const config = await readReplication(ctx, bucket);
    const rules = config?.Rules ?? [];
    if (ruleId === null) return { priority: nextPriority(rules), ...(config?.Role ? { role: config.Role } : {}) };
    const rule = rules.find((r) => r.ID === ruleId);
    if (!rule) throw new Error(`Replication rule "${ruleId}" no longer exists. Reload the page.`);
    return replicationValues(rule, config?.Role);
  },
  async run(ctx, id, v) {
    const [bucket, ruleId] = bucketAndRule(id);
    const rule = replicationRuleFromValues(v, bucket);
    const role = typeof v.role === "string" ? v.role.trim() : "";
    if (role === "") throw new Error("Choose an IAM role.");
    const config = await readReplication(ctx, bucket);
    const rules = config?.Rules ?? [];
    if (ruleId !== null) {
      const before = rules.find((r) => r.ID === ruleId);
      if (before && config?.Role === role && normalisedReplicationRule(before, bucket) === canonicalJson(rule)) return { message: "No changes to save." };
    }
    // AWS refuses replication unless versioning is enabled on both buckets.
    const dest = String(v.destBucket);
    const [source, target] = await Promise.all([versioningOf(ctx, bucket), versioningOf(ctx, dest)]);
    if (source !== "Enabled") throw new Error("Replication requires versioning to be enabled for the source bucket. Enable Bucket Versioning on this bucket first.");
    if (target !== "Enabled") throw new Error(`Replication requires versioning to be enabled for the destination bucket. Enable Bucket Versioning on ${dest} first.`);
    const next = withRule(rules, rule, ruleId);
    checkPriorities(next);
    await ctx.clients.s3.send(new PutBucketReplicationCommand({ Bucket: bucket, ReplicationConfiguration: { Role: role, Rules: next } }));
    return { message: ruleId === null ? `Created replication rule "${rule.ID ?? ""}".` : `Saved replication rule "${rule.ID ?? ""}".` };
  },
};

const replicationDelete: ActionDef = {
  id: "replication-delete",
  label: "Delete replication rule",
  hidden: true,
  danger: true,
  fields: CONFIRM_FIELDS,
  async run(ctx, id, v) {
    const [bucket, ruleId] = bucketAndRule(id);
    if (ruleId === null) throw new Error("Choose a replication rule to delete.");
    confirmed(v, ruleId);
    const config = await readReplication(ctx, bucket);
    const rules = config?.Rules ?? [];
    if (!rules.some((r) => r.ID === ruleId)) throw new Error(`Replication rule "${ruleId}" no longer exists. Reload the page.`);
    const rest = rules.filter((r) => r.ID !== ruleId);
    if (rest.length === 0) await ctx.clients.s3.send(new DeleteBucketReplicationCommand({ Bucket: bucket }));
    else await ctx.clients.s3.send(new PutBucketReplicationCommand({ Bucket: bucket, ReplicationConfiguration: { Role: config?.Role, Rules: rest } }));
    return { message: `Deleted replication rule "${ruleId}".` };
  },
};

const inventorySave: ActionDef = {
  id: "inventory-save",
  label: "Save inventory configuration",
  hidden: true,
  fields: INVENTORY_FIELDS,
  async initialValues(ctx, id) {
    const [bucket, invId] = bucketAndRule(id);
    if (invId === null) return {};
    const r = await ctx.clients.s3.send(new GetBucketInventoryConfigurationCommand({ Bucket: bucket, Id: invId }));
    if (!r.InventoryConfiguration) throw new Error(`Inventory configuration "${invId}" no longer exists. Reload the page.`);
    return inventoryValues(r.InventoryConfiguration);
  },
  async run(ctx, id, v: FieldValues) {
    const [bucket, invId] = bucketAndRule(id);
    const config = inventoryFromValues(v);
    if (invId !== null) {
      if (config.Id !== invId) throw new Error("An inventory configuration can't be renamed. Create a new one instead.");
      const before = await ctx.clients.s3.send(new GetBucketInventoryConfigurationCommand({ Bucket: bucket, Id: invId }));
      if (before.InventoryConfiguration && canonicalJson(inventoryFromValues(inventoryValues(before.InventoryConfiguration))) === canonicalJson(config)) return { message: "No changes to save." };
    }
    await ctx.clients.s3.send(new PutBucketInventoryConfigurationCommand({ Bucket: bucket, Id: config.Id, InventoryConfiguration: config }));
    return { message: invId === null ? `Created inventory configuration "${config.Id ?? ""}".` : `Saved inventory configuration "${config.Id ?? ""}".` };
  },
};

const inventoryDelete: ActionDef = {
  id: "inventory-delete",
  label: "Delete inventory configuration",
  hidden: true,
  danger: true,
  fields: CONFIRM_FIELDS,
  async run(ctx, id, v) {
    const [bucket, invId] = bucketAndRule(id);
    if (invId === null) throw new Error("Choose an inventory configuration to delete.");
    confirmed(v, invId);
    await ctx.clients.s3.send(new DeleteBucketInventoryConfigurationCommand({ Bucket: bucket, Id: invId }));
    return { message: `Deleted inventory configuration "${invId}".` };
  },
};

export const managementActions: ActionDef[] = [lifecycleSave, lifecycleDelete, replicationSave, replicationDelete, inventorySave, inventoryDelete];
