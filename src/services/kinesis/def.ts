/**
 * Amazon Kinesis: Data Streams and Amazon Data Firehose streams. Every value comes from a
 * Kinesis or Firehose API response.
 */

import {
  AddTagsToStreamCommand,
  CreateStreamCommand,
  DecreaseStreamRetentionPeriodCommand,
  DeleteStreamCommand,
  DeregisterStreamConsumerCommand,
  DescribeStreamSummaryCommand,
  DisableEnhancedMonitoringCommand,
  EnableEnhancedMonitoringCommand,
  GetRecordsCommand,
  GetShardIteratorCommand,
  IncreaseStreamRetentionPeriodCommand,
  ListShardsCommand,
  ListStreamConsumersCommand,
  ListStreamsCommand,
  ListTagsForStreamCommand,
  PutRecordCommand,
  RegisterStreamConsumerCommand,
  RemoveTagsFromStreamCommand,
  StartStreamEncryptionCommand,
  StopStreamEncryptionCommand,
  UpdateShardCountCommand,
  UpdateStreamModeCommand,
  type MetricsName,
  type Shard,
  type ShardIteratorType,
  type StreamDescriptionSummary,
  type StreamSummary,
} from "@aws-sdk/client-kinesis";
import {
  CreateDeliveryStreamCommand,
  DeleteDeliveryStreamCommand,
  DescribeDeliveryStreamCommand,
  ListDeliveryStreamsCommand,
  ListTagsForDeliveryStreamCommand,
  PutRecordBatchCommand,
  PutRecordCommand as FirehosePutRecordCommand,
  StartDeliveryStreamEncryptionCommand,
  StopDeliveryStreamEncryptionCommand,
  TagDeliveryStreamCommand,
  UntagDeliveryStreamCommand,
  type CompressionFormat,
  type DeliveryStreamDescription,
} from "@aws-sdk/client-firehose";
import type { Ctx, Option, ResourceDef, Row, ServiceDef } from "../../console/types.ts";
import { optionalRead } from "../../console/secondary.ts";
import { bucketOptions, roleOptions } from "../efs/lookups.ts";
import { fieldTags, recordTagDiff, recordToTags, tagDiff, tagDiffMessage, tagRecord, tagsToRecord } from "../../console/tags.ts";
import { bytesToText, numberOr, plural, strList, text } from "../../console/values.ts";
import { SHARD_METRICS, lines, metricChanges, retentionChange } from "./helpers.ts";

const STREAM_NAME = "[a-zA-Z0-9_.-]{1,128}";
const MAX_READ = 100;

// ---------- data streams ----------

async function listedStreams(ctx: Ctx): Promise<StreamSummary[]> {
  const out: StreamSummary[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.kinesis.send(new ListStreamsCommand({ NextToken: token }));
    out.push(...(r.StreamSummaries ?? []).filter((s) => s.StreamName));
    token = r.HasMoreStreams ? r.NextToken : undefined;
  } while (token);
  return out;
}

/** Every tag on a stream (ListTagsForStream pages by the last key). */
async function streamTags(ctx: Ctx, name: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let start: string | undefined;
  for (;;) {
    const r = await ctx.clients.kinesis.send(new ListTagsForStreamCommand({ StreamName: name, ExclusiveStartTagKey: start }));
    const tags = r.Tags ?? [];
    for (const t of tags) if (t.Key) out[t.Key] = t.Value ?? "";
    if (!r.HasMoreTags || tags.length === 0) return out;
    start = tags[tags.length - 1].Key;
  }
}

/** Actions that change a stream need it ACTIVE (Kinesis refuses them while CREATING or UPDATING). */
const streamActive = (row: Row): boolean => (row.status ?? row.Status ?? "ACTIVE") === "ACTIVE";

async function summary(ctx: Ctx, name: string): Promise<StreamDescriptionSummary> {
  const r = await ctx.clients.kinesis.send(new DescribeStreamSummaryCommand({ StreamName: name }));
  if (!r.StreamDescriptionSummary) throw new Error(`Stream ${name} was not found.`);
  return r.StreamDescriptionSummary;
}

async function shards(ctx: Ctx, name: string): Promise<Shard[]> {
  const out: Shard[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.kinesis.send(new ListShardsCommand(token ? { NextToken: token } : { StreamName: name }));
    out.push(...(r.Shards ?? []));
    token = r.NextToken;
  } while (token);
  return out;
}

async function streamArnOptions(ctx: Ctx): Promise<Option[]> {
  return (await listedStreams(ctx)).flatMap((s) => (s.StreamARN && s.StreamName ? [{ value: s.StreamARN, label: s.StreamName }] : []));
}

/** Enhanced fan-out consumers of a stream (id), for the Deregister picker. */
async function consumerOptions(ctx: Ctx, name?: string): Promise<Option[]> {
  if (!name) return [];
  const arn = (await summary(ctx, name)).StreamARN;
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.kinesis.send(new ListStreamConsumersCommand({ StreamARN: arn, NextToken: token }));
    for (const c of r.Consumers ?? []) if (c.ConsumerName) out.push({ value: c.ConsumerName, label: `${c.ConsumerName} (${c.ConsumerStatus ?? "-"})` });
    token = r.NextToken;
  } while (token);
  return out;
}

function streamRow(s: StreamDescriptionSummary): Row {
  return {
    name: s.StreamName ?? null,
    status: s.StreamStatus ?? null,
    mode: s.StreamModeDetails?.StreamMode === "ON_DEMAND" ? "On-demand" : "Provisioned",
    shards: s.OpenShardCount ?? null,
    retention: s.RetentionPeriodHours ?? null,
    encryption: s.EncryptionType === "KMS" ? "Server-side encryption (KMS)" : "Disabled",
    consumers: s.ConsumerCount ?? 0,
    created: s.StreamCreationTimestamp ?? null,
    arn: s.StreamARN ?? null,
  };
}

const dataStreams: ResourceDef = {
  id: "data-streams",
  name: "Data streams",
  singular: "data stream",
  idField: "name",
  nameField: "Data stream name",
  description: "Real-time data streams split into shards. Producers put records; consumers read them in order per shard.",
  emptyText: "No data streams. Create a data stream to get started.",
  columns: [
    { key: "name", label: "Data stream name", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "mode", label: "Capacity mode", kind: "text" },
    { key: "shards", label: "Provisioned shards", kind: "count" },
    { key: "retention", label: "Data retention (hours)", kind: "count" },
    { key: "encryption", label: "Server-side encryption", kind: "text" },
    { key: "consumers", label: "Enhanced fan-out consumers", kind: "count", hidden: true },
    { key: "created", label: "Creation time", kind: "date" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const listed = await listedStreams(ctx);
    // DescribeStreamSummary adds shards, retention and encryption; if it is denied, show what ListStreams gave.
    return Promise.all(
      listed.map(async (l) => {
        const d = await optionalRead(() => summary(ctx, l.StreamName as string), []);
        if (d.kind === "value") return streamRow(d.value);
        return { ...streamRow({ StreamName: l.StreamName, StreamARN: l.StreamARN, StreamStatus: l.StreamStatus, StreamModeDetails: l.StreamModeDetails, StreamCreationTimestamp: l.StreamCreationTimestamp } as StreamDescriptionSummary), shards: null, retention: null, encryption: "Unavailable" };
      })
    );
  },

  async get(ctx, name) {
    const s = await summary(ctx, name);
    // While a stream is CREATING (or UPDATING), Kinesis refuses ListShards and friends with ResourceInUseException.
    const busy = ["ResourceInUseException"];
    const [shardRead, consumerRead, tagRead] = await Promise.all([
      optionalRead(() => shards(ctx, name), busy),
      optionalRead(async () => (s.StreamARN ? (await ctx.clients.kinesis.send(new ListStreamConsumersCommand({ StreamARN: s.StreamARN }))).Consumers ?? [] : []), busy),
      optionalRead(() => streamTags(ctx, name), busy),
    ]);
    const notReady = `Not available while the stream is ${s.StreamStatus ?? "changing"}. Refresh in a moment.`;
    const emptyText = (r: { kind: string; error?: string }, none: string) => (r.kind === "missing" ? notReady : r.kind === "error" ? `Unavailable: ${r.error}` : none);
    const sh = shardRead.kind === "value" ? shardRead.value : [];
    const consumers = { Consumers: consumerRead.kind === "value" ? consumerRead.value : [] };
    const tags = { Tags: tagRead.kind === "value" ? recordToTags(tagRead.value) : [] };
    const row = streamRow(s);
    const metrics = (s.EnhancedMonitoring ?? []).flatMap((m) => m.ShardLevelMetrics ?? []);
    return {
      summary: {
        "Data stream name": s.StreamName ?? name,
        Status: s.StreamStatus ?? null,
        "Capacity mode": row.mode,
        "Open shards": s.OpenShardCount ?? null,
        "Data retention period (hours)": s.RetentionPeriodHours ?? null,
        "Server-side encryption": s.EncryptionType === "KMS" ? `Enabled (${s.KeyId ?? "KMS"})` : "Disabled",
        "Creation time": s.StreamCreationTimestamp ?? null,
        ARN: s.StreamARN ?? null,
      },
      tabs: [
        {
          id: "shards",
          label: "Shards",
          kind: "table",
          columns: [
            { key: "id", label: "Shard ID", kind: "text" },
            { key: "state", label: "State", kind: "status" },
            { key: "parent", label: "Parent shard", kind: "text" },
            { key: "start", label: "Starting hash key", kind: "code" },
            { key: "end", label: "Ending hash key", kind: "code" },
          ],
          data: sh.map((x) => ({
            id: x.ShardId ?? null,
            state: x.SequenceNumberRange?.EndingSequenceNumber ? "CLOSED" : "OPEN",
            parent: x.ParentShardId ?? "-",
            start: x.HashKeyRange?.StartingHashKey ?? null,
            end: x.HashKeyRange?.EndingHashKey ?? null,
          })),
          description: "Each shard takes 1 MB/s or 1,000 records/s in and gives 2 MB/s out. Resharding closes parent shards.",
          emptyText: emptyText(shardRead, "No shards."),
        },
        {
          id: "consumers",
          label: "Enhanced fan-out",
          kind: "table",
          columns: [
            { key: "name", label: "Consumer name", kind: "text" },
            { key: "status", label: "Status", kind: "status" },
            { key: "created", label: "Registration time", kind: "date" },
            { key: "arn", label: "Consumer ARN", kind: "arn" },
          ],
          data: (consumers.Consumers ?? []).map((c) => ({ name: c.ConsumerName ?? null, status: c.ConsumerStatus ?? null, created: c.ConsumerCreationTimestamp ?? null, arn: c.ConsumerARN ?? null })),
          description: "Consumers with dedicated 2 MB/s per shard read throughput.",
          emptyText: emptyText(consumerRead, "No enhanced fan-out consumers."),
        },
        {
          id: "configuration",
          label: "Configuration",
          kind: "keyvalue",
          data: {
            "Enhanced (shard-level) metrics": metrics.length ? metrics.join(", ") : "Disabled",
            "Maximum record size (KiB)": s.MaxRecordSizeInKiB ?? null,
            "Enhanced fan-out consumers": s.ConsumerCount ?? 0,
          },
        },
        { id: "tags", label: "Tags", kind: "table", columns: [{ key: "Key", label: "Key", kind: "text" }, { key: "Value", label: "Value", kind: "text" }], data: tags.Tags, emptyText: emptyText(tagRead, "No tags.") },
      ],
    };
  },

  create: {
    title: "Create data stream",
    description: "Creates a data stream with CreateStream.",
    fields: [
      { name: "name", label: "Data stream name", kind: "text", required: true, section: "Data stream configuration", help: "Up to 128 letters, numbers, hyphens, underscores and periods.", validate: { pattern: STREAM_NAME, message: "Up to 128 letters, numbers, hyphens, underscores or periods." } },
      {
        name: "mode", label: "Capacity mode", kind: "radio", default: "ON_DEMAND", section: "Data stream capacity",
        options: [
          { value: "ON_DEMAND", label: "On-demand: scales automatically, pay per GB" },
          { value: "PROVISIONED", label: "Provisioned: you set the number of shards" },
        ],
      },
      { name: "shards", label: "Provisioned shards", kind: "number", default: 1, required: true, section: "Data stream capacity", showIf: { field: "mode", equals: "PROVISIONED" }, help: "Total write capacity: 1 MiB/s and 1,000 records/s per shard.", validate: { min: 1, max: 500, message: "Between 1 and 500 shards." } },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      const provisioned = v.mode === "PROVISIONED";
      await ctx.clients.kinesis.send(
        new CreateStreamCommand({ StreamName: name, ShardCount: provisioned ? numberOr(v.shards, 1) : undefined, StreamModeDetails: { StreamMode: provisioned ? "PROVISIONED" : "ON_DEMAND" }, Tags: tagRecord(v.tags) })
      );
      return name;
    },
  },

  actions: [
    {
      id: "put-record",
      label: "Put record",
      fields: [
        { name: "partitionKey", label: "Partition key", kind: "text", required: true, help: "Records with the same key go to the same shard, in order.", validate: { max: 256, message: "At most 256 characters." } },
        { name: "data", label: "Data", kind: "textarea", required: true, help: "Sent as UTF-8 bytes.", validate: { max: 1_000_000, message: "At most 1 MB." } },
      ],
      async run(ctx, name, v) {
        const r = await ctx.clients.kinesis.send(new PutRecordCommand({ StreamName: name, PartitionKey: String(v.partitionKey), Data: Buffer.from(String(v.data), "utf8") }));
        return { message: `Record put into ${r.ShardId ?? "-"}. Sequence number ${r.SequenceNumber ?? "-"}.` };
      },
    },
    {
      id: "get-records",
      label: "Get records (data viewer)",
      fields: [
        { name: "shardId", label: "Shard", kind: "text", placeholder: "All open shards", help: "A shard ID such as shardId-000000000000, or empty to read every shard." },
        {
          name: "iteratorType", label: "Starting position", kind: "select", required: true, default: "TRIM_HORIZON",
          options: [
            { value: "TRIM_HORIZON", label: "Trim horizon (oldest record)" },
            { value: "LATEST", label: "Latest (only new records)" },
            { value: "AT_SEQUENCE_NUMBER", label: "At sequence number" },
            { value: "AFTER_SEQUENCE_NUMBER", label: "After sequence number" },
            { value: "AT_TIMESTAMP", label: "At timestamp" },
          ],
        },
        { name: "sequenceNumber", label: "Sequence number", kind: "text", help: "For the sequence-number positions.", validate: { pattern: "\\d{1,128}", message: "Digits only." } },
        { name: "timestamp", label: "Timestamp", kind: "text", placeholder: "2026-11-23T10:00:00Z", help: "For At timestamp (ISO 8601)." },
        { name: "limit", label: "Maximum records per shard", kind: "number", default: 25, validate: { min: 1, max: MAX_READ, message: `Between 1 and ${MAX_READ}.` } },
      ],
      async run(ctx, name, v) {
        const type = (text(v.iteratorType) ?? "TRIM_HORIZON") as ShardIteratorType;
        const seq = text(v.sequenceNumber);
        if ((type === "AT_SEQUENCE_NUMBER" || type === "AFTER_SEQUENCE_NUMBER") && !seq) throw new Error("Enter a sequence number for this starting position.");
        let ts: Date | undefined;
        if (type === "AT_TIMESTAMP") {
          ts = new Date(text(v.timestamp) ?? "");
          if (Number.isNaN(ts.getTime())) throw new Error("Enter a timestamp such as 2026-11-23T10:00:00Z.");
        }
        const wanted = text(v.shardId);
        const ids = wanted ? [wanted] : (await shards(ctx, name)).filter((s) => !s.SequenceNumberRange?.EndingSequenceNumber).flatMap((s) => (s.ShardId ? [s.ShardId] : []));
        const limit = numberOr(v.limit, 25);
        const rows: Row[] = [];
        for (const shardId of ids) {
          const it = await ctx.clients.kinesis.send(new GetShardIteratorCommand({ StreamName: name, ShardId: shardId, ShardIteratorType: type, StartingSequenceNumber: seq, Timestamp: ts }));
          if (!it.ShardIterator) continue;
          const r = await ctx.clients.kinesis.send(new GetRecordsCommand({ ShardIterator: it.ShardIterator, Limit: limit }));
          for (const rec of r.Records ?? []) {
            const d = bytesToText(rec.Data);
            rows.push({ shardId, sequenceNumber: rec.SequenceNumber ?? "", partitionKey: rec.PartitionKey ?? null, arrived: rec.ApproximateArrivalTimestamp ?? null, data: d.text });
          }
        }
        return {
          message: `Read ${plural(rows.length, "record")} from ${plural(ids.length, "shard")} (one GetRecords call per shard).`,
          table: {
            rowKey: "sequenceNumber",
            emptyText: "No records at this position.",
            columns: [
              { key: "shardId", label: "Shard ID", kind: "text" },
              { key: "sequenceNumber", label: "Sequence number", kind: "code" },
              { key: "partitionKey", label: "Partition key", kind: "text" },
              { key: "arrived", label: "Approximate arrival", kind: "date" },
              { key: "data", label: "Data", kind: "code" },
            ],
            rows: rows.map((r) => ({ ...r, arrived: r.arrived instanceof Date ? r.arrived.toISOString() : r.arrived })),
          },
        };
      },
    },
    {
      id: "capacity",
      label: "Edit capacity",
      availableFor: streamActive,
      fields: [
        { name: "mode", label: "Capacity mode", kind: "radio", default: "PROVISIONED", options: [{ value: "ON_DEMAND", label: "On-demand" }, { value: "PROVISIONED", label: "Provisioned" }] },
        { name: "shards", label: "Provisioned shards", kind: "number", default: 1, required: true, showIf: { field: "mode", equals: "PROVISIONED" }, help: "Uniform scaling: at most double or half the current count per change.", validate: { min: 1, max: 500, message: "Between 1 and 500 shards." } },
      ],
      async initialValues(ctx, name) {
        const s = await summary(ctx, name);
        return { mode: s.StreamModeDetails?.StreamMode === "ON_DEMAND" ? "ON_DEMAND" : "PROVISIONED", shards: s.OpenShardCount ?? null };
      },
      async run(ctx, name, v) {
        const s = await summary(ctx, name);
        const current = s.StreamModeDetails?.StreamMode ?? "PROVISIONED";
        const wanted = v.mode === "ON_DEMAND" ? "ON_DEMAND" : "PROVISIONED";
        if (current !== wanted) {
          await ctx.clients.kinesis.send(new UpdateStreamModeCommand({ StreamARN: s.StreamARN, StreamModeDetails: { StreamMode: wanted } }));
          return { message: `Capacity mode change to ${wanted} requested.` };
        }
        if (wanted === "ON_DEMAND") return { message: "The stream is already on-demand." };
        const target = numberOr(v.shards, 1);
        if (target === s.OpenShardCount) return { message: `The stream already has ${plural(target ?? 0, "shard")}.` };
        const r = await ctx.clients.kinesis.send(new UpdateShardCountCommand({ StreamName: name, TargetShardCount: target, ScalingType: "UNIFORM_SCALING" }));
        return { message: `Resharding from ${r.CurrentShardCount ?? "-"} to ${r.TargetShardCount ?? "-"} shards.` };
      },
    },
    {
      id: "retention",
      label: "Edit data retention period",
      availableFor: streamActive,
      async initialValues(ctx, name) {
        return { hours: (await summary(ctx, name)).RetentionPeriodHours ?? 24 };
      },
      fields: [{ name: "hours", label: "Data retention period (hours)", kind: "number", default: 24, required: true, help: "24 hours to 365 days (8760 hours). Longer than 24 hours costs extra.", validate: { min: 24, max: 8760, message: "Between 24 and 8760 hours." } }],
      async run(ctx, name, v) {
        const target = numberOr(v.hours, 24) as number;
        const s = await summary(ctx, name);
        const change = retentionChange(s.RetentionPeriodHours, target);
        if (change === "increase") await ctx.clients.kinesis.send(new IncreaseStreamRetentionPeriodCommand({ StreamName: name, RetentionPeriodHours: target }));
        if (change === "decrease") await ctx.clients.kinesis.send(new DecreaseStreamRetentionPeriodCommand({ StreamName: name, RetentionPeriodHours: target }));
        return { message: change === "none" ? `Retention is already ${target} hours.` : `Retention period set to ${target} hours.` };
      },
    },
    {
      id: "encryption",
      label: "Edit encryption",
      availableFor: streamActive,
      async initialValues(ctx, name) {
        const s = await summary(ctx, name);
        return { enabled: s.EncryptionType === "KMS" ? "on" : "off", keyId: s.KeyId ?? "alias/aws/kinesis" };
      },
      fields: [
        { name: "enabled", label: "Server-side encryption", kind: "radio", default: "off", options: [{ value: "on", label: "Enabled" }, { value: "off", label: "Disabled" }] },
        { name: "keyId", label: "AWS KMS key", kind: "text", default: "alias/aws/kinesis", required: true, showIf: { field: "enabled", equals: "on" }, help: "alias/aws/kinesis is the AWS managed key." },
      ],
      async run(ctx, name, v) {
        const s = await summary(ctx, name);
        if (v.enabled === "on") {
          if (s.EncryptionType === "KMS" && s.KeyId === String(v.keyId)) return { message: "Encryption is already enabled with this key." };
          await ctx.clients.kinesis.send(new StartStreamEncryptionCommand({ StreamName: name, EncryptionType: "KMS", KeyId: String(v.keyId) }));
          return { message: "Server-side encryption enabled." };
        }
        if (s.EncryptionType !== "KMS" || !s.KeyId) return { message: "Encryption is already disabled." };
        await ctx.clients.kinesis.send(new StopStreamEncryptionCommand({ StreamName: name, EncryptionType: "KMS", KeyId: s.KeyId }));
        return { message: "Server-side encryption disabled." };
      },
    },
    {
      id: "monitoring",
      label: "Edit enhanced (shard-level) metrics",
      availableFor: streamActive,
      async initialValues(ctx, name) {
        const current = ((await summary(ctx, name)).EnhancedMonitoring ?? []).flatMap((m) => m.ShardLevelMetrics ?? []);
        return { metrics: current.includes("ALL") ? [...SHARD_METRICS] : current };
      },
      fields: [{ name: "metrics", label: "Shard-level metrics", kind: "multiselect", options: SHARD_METRICS.map((m) => ({ value: m, label: m })) }],
      async run(ctx, name, v) {
        const s = await summary(ctx, name);
        const current = (s.EnhancedMonitoring ?? []).flatMap((m) => m.ShardLevelMetrics ?? []);
        const { enable, disable } = metricChanges(current, strList(v.metrics));
        if (enable.length) await ctx.clients.kinesis.send(new EnableEnhancedMonitoringCommand({ StreamName: name, ShardLevelMetrics: enable as MetricsName[] }));
        if (disable.length) await ctx.clients.kinesis.send(new DisableEnhancedMonitoringCommand({ StreamName: name, ShardLevelMetrics: disable as MetricsName[] }));
        return { message: `Enabled ${enable.length ? enable.join(", ") : "nothing"}; disabled ${disable.length ? disable.join(", ") : "nothing"}.` };
      },
    },
    {
      id: "register-consumer",
      label: "Register enhanced fan-out consumer",
      fields: [{ name: "consumerName", label: "Consumer name", kind: "text", required: true, validate: { pattern: STREAM_NAME, message: "Up to 128 letters, numbers, hyphens, underscores or periods." } }],
      async run(ctx, name, v) {
        const s = await summary(ctx, name);
        const r = await ctx.clients.kinesis.send(new RegisterStreamConsumerCommand({ StreamARN: s.StreamARN, ConsumerName: String(v.consumerName) }));
        return { message: `Consumer ${r.Consumer?.ConsumerName ?? ""} registered (${r.Consumer?.ConsumerStatus ?? "-"}).` };
      },
    },
    {
      id: "deregister-consumer",
      label: "Deregister consumer",
      danger: true,
      availableFor: (row) => typeof row.consumers !== "number" || row.consumers > 0,
      fields: [{ name: "consumerName", label: "Consumer", kind: "select", required: true, options: consumerOptions }],
      async run(ctx, name, v) {
        const s = await summary(ctx, name);
        await ctx.clients.kinesis.send(new DeregisterStreamConsumerCommand({ StreamARN: s.StreamARN, ConsumerName: String(v.consumerName) }));
        return { message: `Consumer ${String(v.consumerName)} deregistration requested.` };
      },
    },
    {
      id: "tags",
      label: "Manage tags",
      fields: [{ name: "tags", label: "Tags", kind: "tags", help: "Remove a row to delete that tag." }],
      async initialValues(ctx, name) {
        return { tags: recordToTags(await streamTags(ctx, name)) };
      },
      async run(ctx, name, v) {
        const diff = recordTagDiff(await streamTags(ctx, name), tagsToRecord(fieldTags(v.tags)));
        if (diff.remove.length) await ctx.clients.kinesis.send(new RemoveTagsFromStreamCommand({ StreamName: name, TagKeys: diff.remove }));
        if (Object.keys(diff.set).length) await ctx.clients.kinesis.send(new AddTagsToStreamCommand({ StreamName: name, Tags: diff.set }));
        return { message: tagDiffMessage(diff) };
      },
    },
  ],

  delete: {
    confirmText: "name",
    async run(ctx, name) {
      await ctx.clients.kinesis.send(new DeleteStreamCommand({ StreamName: name, EnforceConsumerDeletion: true }));
    },
  },
};

// ---------- Firehose ----------

async function firehoseNames(ctx: Ctx): Promise<string[]> {
  const out: string[] = [];
  let start: string | undefined;
  for (;;) {
    const r = await ctx.clients.firehose.send(new ListDeliveryStreamsCommand({ ExclusiveStartDeliveryStreamName: start, Limit: 100 }));
    const names = r.DeliveryStreamNames ?? [];
    out.push(...names);
    if (!r.HasMoreDeliveryStreams || names.length === 0) return out;
    start = names[names.length - 1];
  }
}

/** Every tag on a Firehose stream (ListTagsForDeliveryStream pages by the last key). */
async function firehoseTags(ctx: Ctx, name: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let start: string | undefined;
  for (;;) {
    const r = await ctx.clients.firehose.send(new ListTagsForDeliveryStreamCommand({ DeliveryStreamName: name, ExclusiveStartTagKey: start }));
    const tags = r.Tags ?? [];
    for (const t of tags) if (t.Key) out[t.Key] = t.Value ?? "";
    if (!r.HasMoreTags || tags.length === 0) return out;
    start = tags[tags.length - 1].Key;
  }
}

async function describeFirehose(ctx: Ctx, name: string): Promise<DeliveryStreamDescription> {
  const r = await ctx.clients.firehose.send(new DescribeDeliveryStreamCommand({ DeliveryStreamName: name }));
  if (!r.DeliveryStreamDescription) throw new Error(`Firehose stream ${name} was not found.`);
  return r.DeliveryStreamDescription;
}

function destinationOf(d: DeliveryStreamDescription): { type: string; target: string | null } {
  const dest = d.Destinations?.[0];
  if (dest?.ExtendedS3DestinationDescription || dest?.S3DestinationDescription) return { type: "Amazon S3", target: (dest.ExtendedS3DestinationDescription ?? dest.S3DestinationDescription)?.BucketARN ?? null };
  if (dest?.RedshiftDestinationDescription) return { type: "Amazon Redshift", target: dest.RedshiftDestinationDescription.ClusterJDBCURL ?? null };
  if (dest?.HttpEndpointDestinationDescription) return { type: "HTTP endpoint", target: dest.HttpEndpointDestinationDescription.EndpointConfiguration?.Url ?? null };
  if (dest?.AmazonopensearchserviceDestinationDescription) return { type: "Amazon OpenSearch Service", target: dest.AmazonopensearchserviceDestinationDescription.DomainARN ?? null };
  return { type: dest ? "Other" : "-", target: null };
}

function firehoseRow(d: DeliveryStreamDescription): Row {
  const dest = destinationOf(d);
  return {
    name: d.DeliveryStreamName ?? null,
    status: d.DeliveryStreamStatus ?? null,
    source: d.DeliveryStreamType === "KinesisStreamAsSource" ? "Amazon Kinesis Data Streams" : d.DeliveryStreamType === "DirectPut" ? "Direct PUT" : d.DeliveryStreamType ?? null,
    destination: dest.type,
    target: dest.target,
    encryption: d.DeliveryStreamEncryptionConfiguration?.Status ?? null,
    created: d.CreateTimestamp ?? null,
    arn: d.DeliveryStreamARN ?? null,
  };
}

/** ENABLED or ENABLING counts as on. */
function firehoseEncrypted(d: DeliveryStreamDescription): boolean {
  const st = d.DeliveryStreamEncryptionConfiguration?.Status;
  return st === "ENABLED" || st === "ENABLING";
}

const COMPRESSION: Option[] = ["UNCOMPRESSED", "GZIP", "ZIP", "Snappy", "HADOOP_SNAPPY"].map((c) => ({ value: c, label: c === "UNCOMPRESSED" ? "Not enabled" : c }));

const firehoseStreams: ResourceDef = {
  id: "firehose",
  name: "Firehose streams",
  singular: "Firehose stream",
  idField: "name",
  nameField: "Firehose stream name",
  description: "Amazon Data Firehose: buffers streaming data and delivers it to destinations such as Amazon S3.",
  emptyText: "No Firehose streams.",
  columns: [
    { key: "name", label: "Firehose stream name", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "source", label: "Source", kind: "text" },
    { key: "destination", label: "Destination", kind: "text" },
    { key: "target", label: "Destination resource", kind: "arn", hidden: true },
    { key: "created", label: "Creation time", kind: "date" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const names = await firehoseNames(ctx);
    // If DescribeDeliveryStream is denied for a stream, still list it by name.
    return Promise.all(
      names.map(async (n) => {
        const d = await optionalRead(() => describeFirehose(ctx, n), []);
        return d.kind === "value" ? firehoseRow(d.value) : { name: n, status: null, source: null, destination: "Unavailable", target: null, created: null, arn: null };
      })
    );
  },

  async get(ctx, name) {
    const d = await describeFirehose(ctx, name);
    const tags = await optionalRead(() => firehoseTags(ctx, name), []);
    const row = firehoseRow(d);
    const s3 = d.Destinations?.[0]?.ExtendedS3DestinationDescription ?? d.Destinations?.[0]?.S3DestinationDescription;
    const enc = d.DeliveryStreamEncryptionConfiguration;
    return {
      summary: {
        "Firehose stream name": d.DeliveryStreamName ?? name,
        Status: d.DeliveryStreamStatus ?? null,
        Source: row.source,
        "Source stream": d.Source?.KinesisStreamSourceDescription?.KinesisStreamARN ?? "-",
        Destination: row.destination,
        "Creation time": d.CreateTimestamp ?? null,
        ARN: d.DeliveryStreamARN ?? null,
      },
      tabs: [
        {
          id: "destination",
          label: "Destination settings",
          kind: "keyvalue",
          data: s3
            ? {
                "S3 bucket": s3.BucketARN ?? null,
                "S3 bucket prefix": s3.Prefix ?? "-",
                "S3 bucket error output prefix": s3.ErrorOutputPrefix ?? "-",
                "Buffer size (MiB)": s3.BufferingHints?.SizeInMBs ?? null,
                "Buffer interval (seconds)": s3.BufferingHints?.IntervalInSeconds ?? null,
                Compression: s3.CompressionFormat ?? null,
                "IAM role": s3.RoleARN ?? null,
                "CloudWatch error logging": s3.CloudWatchLoggingOptions?.Enabled ?? false,
              }
            : {},
          emptyText: "This stream's destination isn't Amazon S3; see the JSON tab.",
        },
        {
          id: "encryption",
          label: "Server-side encryption",
          kind: "keyvalue",
          data: { Status: enc?.Status ?? "DISABLED", "Key type": enc?.KeyType ?? "-", "Key ARN": enc?.KeyARN ?? "-" },
        },
        { id: "tags", label: "Tags", kind: "table", columns: [{ key: "Key", label: "Key", kind: "text" }, { key: "Value", label: "Value", kind: "text" }], data: tags.kind === "value" ? recordToTags(tags.value) : [], emptyText: tags.kind === "error" ? `Tags are unavailable: ${tags.error}` : "No tags." },
        { id: "json", label: "JSON", kind: "json", data: d },
      ],
    };
  },

  create: {
    title: "Create Firehose stream",
    description: "Creates a Firehose stream that delivers to Amazon S3 with CreateDeliveryStream.",
    fields: [
      {
        name: "source", label: "Source", kind: "radio", default: "DirectPut", section: "Choose source and destination",
        options: [
          { value: "DirectPut", label: "Direct PUT: producers call PutRecord / PutRecordBatch" },
          { value: "KinesisStreamAsSource", label: "Amazon Kinesis Data Streams" },
        ],
      },
      { name: "streamArn", label: "Kinesis data stream", kind: "select", required: true, options: streamArnOptions, section: "Source settings", showIf: { field: "source", equals: "KinesisStreamAsSource" } },
      { name: "name", label: "Firehose stream name", kind: "text", required: true, section: "Firehose stream name", validate: { pattern: STREAM_NAME, message: "Up to 64 letters, numbers, hyphens, underscores or periods." } },
      { name: "bucket", label: "S3 bucket", kind: "select", required: true, options: bucketOptions, section: "Destination settings (Amazon S3)" },
      { name: "prefix", label: "S3 bucket prefix", kind: "text", section: "Destination settings (Amazon S3)", placeholder: "raw/", help: "By default objects go under YYYY/MM/dd/HH/." },
      { name: "errorPrefix", label: "S3 bucket error output prefix", kind: "text", section: "Destination settings (Amazon S3)", placeholder: "errors/" },
      { name: "bufferMb", label: "Buffer size (MiB)", kind: "number", default: 5, section: "Buffer hints, compression and encryption", validate: { min: 1, max: 128, message: "Between 1 and 128 MiB." } },
      { name: "bufferSeconds", label: "Buffer interval (seconds)", kind: "number", default: 300, section: "Buffer hints, compression and encryption", help: "Firehose delivers when either limit is reached.", validate: { min: 0, max: 900, message: "Between 0 and 900 seconds." } },
      { name: "compression", label: "Compression for data records", kind: "select", required: true, default: "UNCOMPRESSED", options: COMPRESSION, section: "Buffer hints, compression and encryption" },
      { name: "roleArn", label: "IAM role", kind: "select", required: true, options: (ctx: Ctx) => roleOptions(ctx, "firehose.amazonaws.com"), section: "Service access", help: "A role Firehose can assume (trust policy for firehose.amazonaws.com) that can write to the bucket and read the source stream." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      const role = String(v.roleArn);
      const fromStream = v.source === "KinesisStreamAsSource";
      await ctx.clients.firehose.send(
        new CreateDeliveryStreamCommand({
          DeliveryStreamName: name,
          DeliveryStreamType: fromStream ? "KinesisStreamAsSource" : "DirectPut",
          KinesisStreamSourceConfiguration: fromStream ? { KinesisStreamARN: String(v.streamArn), RoleARN: role } : undefined,
          ExtendedS3DestinationConfiguration: {
            RoleARN: role,
            BucketARN: `arn:aws:s3:::${String(v.bucket)}`,
            Prefix: text(v.prefix),
            ErrorOutputPrefix: text(v.errorPrefix),
            BufferingHints: { SizeInMBs: numberOr(v.bufferMb, 5), IntervalInSeconds: numberOr(v.bufferSeconds, 300) },
            CompressionFormat: (text(v.compression) ?? "UNCOMPRESSED") as CompressionFormat,
          },
          Tags: fieldTags(v.tags).length ? fieldTags(v.tags) : undefined,
        })
      );
      return name;
    },
  },

  actions: [
    {
      id: "put-record",
      label: "Put record",
      fields: [
        { name: "data", label: "Record data", kind: "textarea", required: true, help: "Sent as UTF-8. Firehose doesn't add separators, so end JSON records with a newline.", validate: { max: 1_000_000, message: "At most 1,000 KiB." } },
        { name: "newline", label: "Append a newline", kind: "checkbox", default: true },
      ],
      async run(ctx, name, v) {
        const body = `${String(v.data)}${v.newline === true ? "\n" : ""}`;
        const r = await ctx.clients.firehose.send(new FirehosePutRecordCommand({ DeliveryStreamName: name, Record: { Data: Buffer.from(body, "utf8") } }));
        return { message: `Record accepted. Record ID: ${r.RecordId ?? "-"}.` };
      },
    },
    {
      id: "put-batch",
      label: "Put record batch",
      fields: [{ name: "data", label: "Records (one per line)", kind: "textarea", required: true, help: "Up to 500 lines; each line becomes one record ending in a newline." }],
      async run(ctx, name, v) {
        const records = lines(String(v.data));
        if (records.length === 0) throw new Error("Enter at least one line.");
        if (records.length > 500) throw new Error("At most 500 records per batch.");
        const r = await ctx.clients.firehose.send(new PutRecordBatchCommand({ DeliveryStreamName: name, Records: records.map((l) => ({ Data: Buffer.from(`${l}\n`, "utf8") })) }));
        return { message: `${records.length - (r.FailedPutCount ?? 0)} of ${records.length} records accepted.` };
      },
    },
    {
      id: "encryption",
      label: "Edit server-side encryption",
      // Streams fed by a Kinesis data stream use that stream's encryption instead.
      availableFor: (row) => (row.source ?? row.Source) !== "Amazon Kinesis Data Streams",
      fields: [{ name: "enabled", label: "Server-side encryption", kind: "radio", default: "off", help: "Direct PUT sources only.", options: [{ value: "on", label: "Enabled (AWS owned key)" }, { value: "off", label: "Disabled" }] }],
      async initialValues(ctx, name) {
        return { enabled: firehoseEncrypted(await describeFirehose(ctx, name)) ? "on" : "off" };
      },
      async run(ctx, name, v) {
        if ((v.enabled === "on") === firehoseEncrypted(await describeFirehose(ctx, name))) return { message: `Server-side encryption is already ${v.enabled === "on" ? "enabled" : "disabled"}.` };
        if (v.enabled === "on") await ctx.clients.firehose.send(new StartDeliveryStreamEncryptionCommand({ DeliveryStreamName: name, DeliveryStreamEncryptionConfigurationInput: { KeyType: "AWS_OWNED_CMK" } }));
        else await ctx.clients.firehose.send(new StopDeliveryStreamEncryptionCommand({ DeliveryStreamName: name }));
        return { message: `Server-side encryption ${v.enabled === "on" ? "enable" : "disable"} requested.` };
      },
    },
    {
      id: "tags",
      label: "Manage tags",
      fields: [{ name: "tags", label: "Tags", kind: "tags", help: "Remove a row to delete that tag." }],
      async initialValues(ctx, name) {
        return { tags: recordToTags(await firehoseTags(ctx, name)) };
      },
      async run(ctx, name, v) {
        const diff = tagDiff(recordToTags(await firehoseTags(ctx, name)), fieldTags(v.tags));
        if (diff.remove.length) await ctx.clients.firehose.send(new UntagDeliveryStreamCommand({ DeliveryStreamName: name, TagKeys: diff.remove }));
        if (diff.set.length) await ctx.clients.firehose.send(new TagDeliveryStreamCommand({ DeliveryStreamName: name, Tags: diff.set }));
        return { message: tagDiffMessage(diff) };
      },
    },
  ],

  delete: {
    confirmText: "name",
    async run(ctx, name) {
      await ctx.clients.firehose.send(new DeleteDeliveryStreamCommand({ DeliveryStreamName: name }));
    },
  },
};

export const kinesisService: ServiceDef = {
  id: "kinesis",
  name: "Amazon Kinesis",
  category: "Analytics",
  description: "Collect, process and deliver real-time streaming data: Kinesis Data Streams and Amazon Data Firehose.",
  resources: [dataStreams, firehoseStreams],
  notSupported: ["Firehose delivery to S3: records are accepted, but no objects reached the bucket within 65 seconds when tested"],
};
