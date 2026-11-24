/**
 * The DynamoDB table's Actions menu. Every "Edit …" dialog opens with the table's current
 * settings (initialValues) and a save without changes sends nothing.
 */

import { fieldTags, tagDiff, tagDiffMessage, tagPairs } from "../../console/tags.ts";
import {
  CreateBackupCommand,
  DeleteResourcePolicyCommand,
  DescribeContinuousBackupsCommand,
  DescribeContributorInsightsCommand,
  DescribeKinesisStreamingDestinationCommand,
  DescribeTimeToLiveCommand,
  DisableKinesisStreamingDestinationCommand,
  EnableKinesisStreamingDestinationCommand,
  GetResourcePolicyCommand,
  ListTagsOfResourceCommand,
  PutResourcePolicyCommand,
  RestoreTableToPointInTimeCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateContinuousBackupsCommand,
  UpdateContributorInsightsCommand,
  UpdateTableCommand,
  UpdateTimeToLiveCommand,
  type AttributeDefinition,
  type StreamViewType,
  type TableClass,
  type Tag as DynamoTag,
} from "@aws-sdk/client-dynamodb";
import type { ActionDef, Ctx, FieldValues, Option } from "../../console/types.ts";
import { BACKUP_NAME, restoreFields } from "./backups.ts";
import { exportFields, runExport } from "./exports.ts";
import { optionalRead } from "../../console/secondary.ts";
import { describeTable, kinesisStreamOptions, kmsKeyOptions, numberOr, optionalText, parseDateTime,  text } from "./shared.ts";
import { ENCRYPTION, KEY_TYPES, PROJECTIONS, REGION_OPTIONS, addDef, projection, sseSpec } from "./table-form.ts";
import { attrType, capacityMode } from "./table-info.ts";
import {
  capacityValues,
  encryptionValue,
  insightsOn,
  prettyPolicy,
  sameCapacity,
  sameEncryption,
  sameJson,
  streamValues,
  ttlOn,
  type CapacityModeValue,
} from "./table-edits.ts";

const UNCHANGED = "No changes to save.";
const CAPACITY_RULE = { min: 1, max: 40000, message: "Between 1 and 40,000." };
const TABLE_CLASSES: Option[] = [
  { value: "STANDARD", label: "DynamoDB Standard" },
  { value: "STANDARD_INFREQUENT_ACCESS", label: "DynamoDB Standard-IA" },
];
const STREAM_VIEWS: Option[] = [
  { value: "KEYS_ONLY", label: "Key attributes only" },
  { value: "NEW_IMAGE", label: "New image" },
  { value: "OLD_IMAGE", label: "Old image" },
  { value: "NEW_AND_OLD_IMAGES", label: "New and old images" },
];

async function tableArn(ctx: Ctx, name: string): Promise<string> {
  const arn = (await describeTable(ctx, name)).TableArn;
  if (!arn) throw new Error(`DynamoDB returned no ARN for table ${name}.`);
  return arn;
}

async function currentTags(ctx: Ctx, arn: string): Promise<DynamoTag[]> {
  const out: DynamoTag[] = [];
  let next: string | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await ctx.clients.dynamodb.send(new ListTagsOfResourceCommand({ ResourceArn: arn, NextToken: next }));
    out.push(...(r.Tags ?? []));
    if (!r.NextToken || r.NextToken === next) break;
    next = r.NextToken;
  }
  return out;
}

async function pitrState(ctx: Ctx, name: string): Promise<{ enabled: boolean; days: number }> {
  const r = await ctx.clients.dynamodb.send(new DescribeContinuousBackupsCommand({ TableName: name }));
  const d = r.ContinuousBackupsDescription?.PointInTimeRecoveryDescription;
  return { enabled: d?.PointInTimeRecoveryStatus === "ENABLED", days: d?.RecoveryPeriodInDays ?? 35 };
}

async function ttlState(ctx: Ctx, name: string): Promise<{ enabled: boolean; attribute: string }> {
  const d = (await ctx.clients.dynamodb.send(new DescribeTimeToLiveCommand({ TableName: name }))).TimeToLiveDescription;
  return { enabled: ttlOn(d?.TimeToLiveStatus), attribute: d?.AttributeName ?? "" };
}

async function insightsState(ctx: Ctx, name: string): Promise<boolean> {
  return insightsOn((await ctx.clients.dynamodb.send(new DescribeContributorInsightsCommand({ TableName: name }))).ContributorInsightsStatus);
}

async function policyText(ctx: Ctx, name: string): Promise<string | undefined> {
  const arn = await tableArn(ctx, name);
  const r = await optionalRead(() => ctx.clients.dynamodb.send(new GetResourcePolicyCommand({ ResourceArn: arn })), ["PolicyNotFoundException"]);
  if (r.kind === "error") throw new Error(`Could not read the current policy: ${r.error}`);
  return r.kind === "value" ? r.value.Policy : undefined;
}

/** Customer managed key ARNs, or null when the keys can't be listed (e.g. a denied kms:ListKeys). */
async function customerKeyArns(ctx: Ctx): Promise<Set<string> | null> {
  try {
    return new Set((await kmsKeyOptions(ctx)).map((o) => o.value));
  } catch {
    return null;
  }
}

/** The table's global secondary indexes, for the Delete index picker. */
async function gsiOptions(ctx: Ctx, name?: string): Promise<Option[]> {
  if (!name) return [];
  return ((await describeTable(ctx, name)).GlobalSecondaryIndexes ?? []).filter((g) => g.IndexName).map((g) => ({ value: g.IndexName as string, label: `${g.IndexName} (${g.IndexStatus ?? ""})` }));
}

/** The table's replica Regions, for the Delete replica picker. */
async function replicaOptions(ctx: Ctx, name?: string): Promise<Option[]> {
  if (!name) return [];
  return ((await describeTable(ctx, name)).Replicas ?? []).filter((r) => r.RegionName).map((r) => ({ value: r.RegionName as string, label: `${r.RegionName} (${r.ReplicaStatus ?? ""})` }));
}

/** The table's active Kinesis destinations, for Turn off Kinesis data stream. */
async function kinesisDestinationOptions(ctx: Ctx, name?: string): Promise<Option[]> {
  if (!name) return [];
  const r = await ctx.clients.dynamodb.send(new DescribeKinesisStreamingDestinationCommand({ TableName: name }));
  return (r.KinesisDataStreamDestinations ?? [])
    .filter((d) => d.StreamArn && (d.DestinationStatus === "ACTIVE" || d.DestinationStatus === "ENABLING"))
    .map((d) => ({ value: d.StreamArn as string, label: `${d.StreamArn?.split("/").pop() ?? d.StreamArn} (${d.DestinationStatus ?? ""})` }));
}

const capacityAction: ActionDef = {
  id: "capacity",
  label: "Edit read/write capacity",
  fields: [
    { name: "capacityMode", label: "Capacity mode", kind: "radio", required: true, default: "PAY_PER_REQUEST", options: [{ value: "PAY_PER_REQUEST", label: "On-demand" }, { value: "PROVISIONED", label: "Provisioned" }] },
    { name: "rcu", label: "Read capacity units", kind: "number", required: true, default: 5, showIf: { field: "capacityMode", equals: "PROVISIONED" }, validate: CAPACITY_RULE, help: "Also applied to every global secondary index." },
    { name: "wcu", label: "Write capacity units", kind: "number", required: true, default: 5, showIf: { field: "capacityMode", equals: "PROVISIONED" }, validate: CAPACITY_RULE },
  ],
  async initialValues(ctx, name) {
    return { ...capacityValues(await describeTable(ctx, name)) };
  },
  async run(ctx, name, v) {
    const t = await describeTable(ctx, name);
    const mode: CapacityModeValue = v.capacityMode === "PROVISIONED" ? "PROVISIONED" : "PAY_PER_REQUEST";
    const wanted = { capacityMode: mode, rcu: numberOr(v.rcu, 5), wcu: numberOr(v.wcu, 5) };
    if (sameCapacity(capacityValues(t), wanted)) return { message: UNCHANGED };
    if (mode === "PAY_PER_REQUEST") {
      await ctx.clients.dynamodb.send(new UpdateTableCommand({ TableName: name, BillingMode: "PAY_PER_REQUEST" }));
      return { message: `${name} now uses on-demand capacity.` };
    }
    const pt = { ReadCapacityUnits: wanted.rcu, WriteCapacityUnits: wanted.wcu };
    await ctx.clients.dynamodb.send(
      new UpdateTableCommand({
        TableName: name,
        BillingMode: "PROVISIONED",
        ProvisionedThroughput: pt,
        GlobalSecondaryIndexUpdates: t.GlobalSecondaryIndexes?.length ? t.GlobalSecondaryIndexes.map((g) => ({ Update: { IndexName: g.IndexName ?? "", ProvisionedThroughput: pt } })) : undefined,
      })
    );
    return { message: `${name} now uses provisioned capacity: ${pt.ReadCapacityUnits} RCU, ${pt.WriteCapacityUnits} WCU.` };
  },
};

const createIndexAction: ActionDef = {
  id: "create-index",
  label: "Create index",
  fields: [
    { name: "indexName", label: "Index name", kind: "text", required: true, validate: { pattern: "[a-zA-Z0-9_.-]{3,255}", message: "3-255 letters, numbers, underscores, hyphens or periods." } },
    { name: "pk", label: "Partition key", kind: "text", required: true },
    { name: "pkType", label: "Partition key type", required: true, kind: "select", default: "S", options: KEY_TYPES },
    { name: "sk", label: "Sort key", kind: "text" },
    { name: "skType", label: "Sort key type", required: true, kind: "select", default: "S", options: KEY_TYPES },
    { name: "idxProjection", label: "Attribute projections", required: true, kind: "select", default: "ALL", options: PROJECTIONS },
    { name: "idxNonKey", label: "Projected attributes", kind: "text", showIf: { field: "idxProjection", equals: "INCLUDE" }, help: "Comma-separated attribute names." },
  ],
  async run(ctx, name, v) {
    const t = await describeTable(ctx, name);
    const pk = text(v.pk);
    const sk = optionalText(v.sk);
    let defs: AttributeDefinition[] = [];
    for (const [n, type] of [[pk, text(v.pkType)], ...(sk ? [[sk, text(v.skType)]] : [])] as [string, string][]) {
      const existing = attrType(t.AttributeDefinitions, n);
      if (existing && existing !== type) throw new Error(`Attribute ${n} is already defined as ${existing}.`);
      defs = addDef(defs, n, type);
    }
    const provisioned = capacityMode(t) === "Provisioned";
    await ctx.clients.dynamodb.send(
      new UpdateTableCommand({
        TableName: name,
        AttributeDefinitions: defs,
        GlobalSecondaryIndexUpdates: [
          {
            Create: {
              IndexName: text(v.indexName),
              KeySchema: [{ AttributeName: pk, KeyType: "HASH" }, ...(sk ? [{ AttributeName: sk, KeyType: "RANGE" as const }] : [])],
              Projection: projection(v, "idx"),
              ProvisionedThroughput: provisioned ? { ReadCapacityUnits: t.ProvisionedThroughput?.ReadCapacityUnits ?? 5, WriteCapacityUnits: t.ProvisionedThroughput?.WriteCapacityUnits ?? 5 } : undefined,
            },
          },
        ],
      })
    );
    return { message: `Creating index ${text(v.indexName)}. It shows as CREATING on the Indexes tab until it is ready.` };
  },
};

const deleteIndexAction: ActionDef = {
  id: "delete-index",
  label: "Delete index",
  danger: true,
  fields: [{ name: "indexName", label: "Global secondary index", kind: "select", required: true, options: gsiOptions, help: "Local secondary indexes can't be deleted." }],
  availableFor: (row) => row.indexes === undefined || Number(row.indexes) > 0,
  async run(ctx, name, v) {
    await ctx.clients.dynamodb.send(new UpdateTableCommand({ TableName: name, GlobalSecondaryIndexUpdates: [{ Delete: { IndexName: text(v.indexName) } }] }));
    return { message: `Deleting index ${text(v.indexName)}.` };
  },
};

const pitrAction: ActionDef = {
  id: "pitr",
  label: "Edit point-in-time recovery",
  fields: [
    { name: "enabled", label: "Turn on point-in-time recovery", kind: "checkbox", default: false },
    { name: "days", label: "Backup recovery period (days)", kind: "number", required: true, default: 35, showIf: { field: "enabled", equals: true }, validate: { min: 1, max: 35, message: "Between 1 and 35 days." } },
  ],
  async initialValues(ctx, name) {
    return { ...(await pitrState(ctx, name)) };
  },
  async run(ctx, name, v) {
    const on = v.enabled === true;
    const days = numberOr(v.days, 35);
    const now = await pitrState(ctx, name);
    if (now.enabled === on && (!on || now.days === days)) return { message: UNCHANGED };
    const r = await ctx.clients.dynamodb.send(
      new UpdateContinuousBackupsCommand({ TableName: name, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: on, RecoveryPeriodInDays: on ? days : undefined } })
    );
    return { message: `Point-in-time recovery is ${r.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus ?? (on ? "ENABLED" : "DISABLED")}.` };
  },
};

const backupAction: ActionDef = {
  id: "backup",
  label: "Create backup",
  fields: [{ name: "backupName", label: "Backup name", kind: "text", required: true, validate: { pattern: BACKUP_NAME, message: "3-255 letters, numbers, underscores, hyphens or dots." } }],
  async run(ctx, name, v) {
    const r = await ctx.clients.dynamodb.send(new CreateBackupCommand({ TableName: name, BackupName: text(v.backupName) }));
    return { message: `Backup ${r.BackupDetails?.BackupName ?? ""} is ${r.BackupDetails?.BackupStatus ?? "being created"}.`, json: r.BackupDetails };
  },
};

const restorePitrAction: ActionDef = {
  id: "restore-pitr",
  label: "Restore to point in time",
  fields: [
    ...restoreFields,
    { name: "latest", label: "Restore to the latest restorable time", kind: "checkbox", default: true },
    { name: "restoreTime", label: "Restore date and time (UTC)", kind: "text", required: true, placeholder: "2026-11-23T10:00:00Z", showIf: { field: "latest", equals: false } },
  ],
  async run(ctx, name, v) {
    const latest = v.latest === true;
    const r = await ctx.clients.dynamodb.send(
      new RestoreTableToPointInTimeCommand({
        SourceTableName: name,
        TargetTableName: text(v.targetTable),
        UseLatestRestorableTime: latest || undefined,
        RestoreDateTime: latest ? undefined : parseDateTime(v.restoreTime, "Restore date and time"),
      })
    );
    return { message: `Restoring ${name} to new table ${r.TableDescription?.TableName ?? text(v.targetTable)} (status ${r.TableDescription?.TableStatus ?? "unknown"}).` };
  },
};

const exportAction: ActionDef = {
  id: "export",
  label: "Export to S3",
  fields: exportFields,
  async run(ctx, name, v) {
    const e = await runExport(ctx, name, v);
    return { message: `Export ${e.ExportStatus ?? "started"}. Follow it on the Exports to S3 page.`, json: { ExportArn: e.ExportArn, ExportStatus: e.ExportStatus, S3Bucket: e.S3Bucket } };
  },
};

const ttlAction: ActionDef = {
  id: "ttl",
  label: "Edit Time to Live (TTL)",
  fields: [
    { name: "enabled", label: "Turn on TTL", kind: "checkbox", default: false },
    { name: "attribute", label: "TTL attribute name", kind: "text", required: true, default: "ttl", help: "A Number attribute holding the expiry time in epoch seconds. To turn TTL off, keep the current TTL attribute." },
  ],
  async initialValues(ctx, name) {
    const s = await ttlState(ctx, name);
    return { enabled: s.enabled, attribute: s.attribute || "ttl" };
  },
  async run(ctx, name, v) {
    const on = v.enabled === true;
    const attribute = text(v.attribute);
    const now = await ttlState(ctx, name);
    if (now.enabled === on && (!on || now.attribute === attribute)) return { message: UNCHANGED };
    const r = await ctx.clients.dynamodb.send(new UpdateTimeToLiveCommand({ TableName: name, TimeToLiveSpecification: { Enabled: on, AttributeName: attribute } }));
    return { message: `TTL ${r.TimeToLiveSpecification?.Enabled ? "turned on" : "turned off"} for attribute ${r.TimeToLiveSpecification?.AttributeName ?? attribute}.` };
  },
};

const streamAction: ActionDef = {
  id: "stream",
  label: "Edit DynamoDB stream",
  fields: [
    { name: "enabled", label: "Turn on DynamoDB stream", kind: "checkbox", default: false },
    { name: "viewType", label: "View type", kind: "radio", default: "NEW_AND_OLD_IMAGES", showIf: { field: "enabled", equals: true }, options: STREAM_VIEWS, help: "To change the view type of an active stream, turn the stream off first." },
  ],
  async initialValues(ctx, name) {
    return { ...streamValues(await describeTable(ctx, name)) };
  },
  async run(ctx, name, v) {
    const on = v.enabled === true;
    const viewType = text(v.viewType) || "NEW_AND_OLD_IMAGES";
    const now = streamValues(await describeTable(ctx, name));
    if (now.enabled === on && (!on || now.viewType === viewType)) return { message: UNCHANGED };
    await ctx.clients.dynamodb.send(
      new UpdateTableCommand({ TableName: name, StreamSpecification: on ? { StreamEnabled: true, StreamViewType: viewType as StreamViewType } : { StreamEnabled: false } })
    );
    return { message: on ? `DynamoDB stream turned on (${viewType}).` : "DynamoDB stream turned off." };
  },
};

const kinesisOnAction: ActionDef = {
  id: "kinesis-on",
  label: "Turn on Kinesis data stream",
  fields: [{ name: "stream", label: "Destination Kinesis data stream", kind: "select", required: true, options: kinesisStreamOptions }],
  async run(ctx, name, v) {
    const r = await ctx.clients.dynamodb.send(new EnableKinesisStreamingDestinationCommand({ TableName: name, StreamArn: text(v.stream) }));
    return { message: `Kinesis streaming destination ${r.DestinationStatus ?? "requested"}.` };
  },
};

const kinesisOffAction: ActionDef = {
  id: "kinesis-off",
  label: "Turn off Kinesis data stream",
  fields: [{ name: "stream", label: "Kinesis data stream", kind: "select", required: true, options: kinesisDestinationOptions, help: "The table's active Kinesis streaming destinations." }],
  async run(ctx, name, v) {
    const r = await ctx.clients.dynamodb.send(new DisableKinesisStreamingDestinationCommand({ TableName: name, StreamArn: text(v.stream) }));
    return { message: `Kinesis streaming destination ${r.DestinationStatus ?? "turned off"}.` };
  },
};

const addReplicaAction: ActionDef = {
  id: "add-replica",
  label: "Create replica",
  fields: [{ name: "region", label: "Replica Region", kind: "select", required: true, options: REGION_OPTIONS, help: "Makes this a global table (version 2019.11.21)." }],
  async run(ctx, name, v) {
    await ctx.clients.dynamodb.send(new UpdateTableCommand({ TableName: name, ReplicaUpdates: [{ Create: { RegionName: text(v.region) } }] }));
    return { message: `Creating a replica in ${text(v.region)}. See the Global tables tab.` };
  },
};

const deleteReplicaAction: ActionDef = {
  id: "delete-replica",
  label: "Delete replica",
  danger: true,
  fields: [{ name: "region", label: "Replica Region", kind: "select", required: true, options: replicaOptions }],
  availableFor: (row) => row.replicas === undefined || (row.replicas !== null && row.replicas !== ""),
  async run(ctx, name, v) {
    await ctx.clients.dynamodb.send(new UpdateTableCommand({ TableName: name, ReplicaUpdates: [{ Delete: { RegionName: text(v.region) } }] }));
    return { message: `Deleting the replica in ${text(v.region)}.` };
  },
};

const policyAction: ActionDef = {
  id: "policy",
  label: "Edit resource-based policy",
  fields: [{ name: "policy", label: "Policy", kind: "json", required: true, help: "A resource-based policy for this table." }],
  async initialValues(ctx, name): Promise<FieldValues> {
    const p = await policyText(ctx, name);
    return p ? { policy: prettyPolicy(p) } : {};
  },
  async run(ctx, name, v) {
    const wanted = String(v.policy);
    if (sameJson(await policyText(ctx, name), wanted)) return { message: UNCHANGED };
    const r = await ctx.clients.dynamodb.send(new PutResourcePolicyCommand({ ResourceArn: await tableArn(ctx, name), Policy: wanted }));
    return { message: `Policy saved (revision ${r.RevisionId ?? "-"}).` };
  },
};

const deletePolicyAction: ActionDef = {
  id: "delete-policy",
  label: "Delete resource-based policy",
  danger: true,
  confirm: "This removes the table's resource-based policy.",
  async run(ctx, name) {
    await ctx.clients.dynamodb.send(new DeleteResourcePolicyCommand({ ResourceArn: await tableArn(ctx, name) }));
    return { message: "Resource-based policy deleted." };
  },
};

const encryptionAction: ActionDef = {
  id: "encryption",
  label: "Edit encryption",
  fields: [
    { name: "encryption", label: "Encryption key management", kind: "radio", required: true, default: "OWNED", options: ENCRYPTION },
    { name: "kmsKey", label: "AWS KMS key", kind: "select", required: true, options: kmsKeyOptions, showIf: { field: "encryption", equals: "CMK" } },
  ],
  async initialValues(ctx, name) {
    const [t, keys] = await Promise.all([describeTable(ctx, name), customerKeyArns(ctx)]);
    const now = encryptionValue(t, keys);
    return now.encryption === "CMK" ? { ...now } : { encryption: now.encryption };
  },
  async run(ctx, name, v) {
    const [t, keys] = await Promise.all([describeTable(ctx, name), customerKeyArns(ctx)]);
    if (sameEncryption(encryptionValue(t, keys), { encryption: text(v.encryption), kmsKey: text(v.kmsKey) })) return { message: UNCHANGED };
    await ctx.clients.dynamodb.send(new UpdateTableCommand({ TableName: name, SSESpecification: sseSpec(v) ?? { Enabled: false } }));
    return { message: "Encryption settings saved." };
  },
};

const deletionProtectionAction: ActionDef = {
  id: "deletion-protection",
  label: "Edit deletion protection",
  fields: [{ name: "enabled", label: "Turn on deletion protection", kind: "checkbox", default: false }],
  async initialValues(ctx, name) {
    return { enabled: (await describeTable(ctx, name)).DeletionProtectionEnabled === true };
  },
  async run(ctx, name, v) {
    const on = v.enabled === true;
    if ((await describeTable(ctx, name)).DeletionProtectionEnabled === on) return { message: UNCHANGED };
    const r = await ctx.clients.dynamodb.send(new UpdateTableCommand({ TableName: name, DeletionProtectionEnabled: on }));
    return { message: `Deletion protection is ${r.TableDescription?.DeletionProtectionEnabled ? "on" : "off"}.` };
  },
};

const tableClassAction: ActionDef = {
  id: "table-class",
  label: "Edit table class",
  fields: [{ name: "tableClass", label: "Table class", kind: "radio", required: true, default: "STANDARD", options: TABLE_CLASSES }],
  async initialValues(ctx, name) {
    return { tableClass: (await describeTable(ctx, name)).TableClassSummary?.TableClass || "STANDARD" };
  },
  async run(ctx, name, v) {
    const wanted = text(v.tableClass) || "STANDARD";
    if (((await describeTable(ctx, name)).TableClassSummary?.TableClass || "STANDARD") === wanted) return { message: UNCHANGED };
    await ctx.clients.dynamodb.send(new UpdateTableCommand({ TableName: name, TableClass: wanted as TableClass }));
    return { message: `Table class changed to ${wanted === "STANDARD" ? "DynamoDB Standard" : "DynamoDB Standard-IA"}.` };
  },
};

const insightsAction: ActionDef = {
  id: "contributor-insights",
  label: "Edit CloudWatch Contributor Insights",
  fields: [{ name: "enabled", label: "Turn on CloudWatch Contributor Insights", kind: "checkbox", default: false }],
  async initialValues(ctx, name) {
    return { enabled: await insightsState(ctx, name) };
  },
  async run(ctx, name, v) {
    const on = v.enabled === true;
    if ((await insightsState(ctx, name)) === on) return { message: UNCHANGED };
    const r = await ctx.clients.dynamodb.send(new UpdateContributorInsightsCommand({ TableName: name, ContributorInsightsAction: on ? "ENABLE" : "DISABLE" }));
    return { message: `Contributor Insights is ${r.ContributorInsightsStatus ?? "updating"}.` };
  },
};

const tagsAction: ActionDef = {
  id: "tags",
  label: "Manage tags",
  fields: [{ name: "tags", label: "Tags", kind: "tags", help: "Add, change or remove the table's tags." }],
  async initialValues(ctx, name) {
    const tags = await currentTags(ctx, await tableArn(ctx, name));
    return { tags: tagPairs(tags) };
  },
  async run(ctx, name, v) {
    const arn = await tableArn(ctx, name);
    const diff = tagDiff(await currentTags(ctx, arn), fieldTags(v.tags));
    if (diff.remove.length) await ctx.clients.dynamodb.send(new UntagResourceCommand({ ResourceArn: arn, TagKeys: diff.remove }));
    if (diff.set.length) await ctx.clients.dynamodb.send(new TagResourceCommand({ ResourceArn: arn, Tags: diff.set }));
    return { message: tagDiffMessage(diff) };
  },
};

export function tableActions(): ActionDef[] {
  return [
    capacityAction,
    createIndexAction,
    deleteIndexAction,
    pitrAction,
    backupAction,
    restorePitrAction,
    exportAction,
    ttlAction,
    streamAction,
    kinesisOnAction,
    kinesisOffAction,
    addReplicaAction,
    deleteReplicaAction,
    policyAction,
    deletePolicyAction,
    encryptionAction,
    deletionProtectionAction,
    tableClassAction,
    insightsAction,
    tagsAction,
  ];
}
