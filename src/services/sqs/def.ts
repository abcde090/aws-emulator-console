/**
 * Amazon SQS: queues. Reference definition for the console engine — every value comes
 * from an SQS API response, every control calls an SQS API.
 */

import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListQueuesCommand,
  ListQueueTagsCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
  TagQueueCommand,
  UntagQueueCommand,
} from "@aws-sdk/client-sqs";
import { errorMessage } from "../../console/serialize.ts";
import type { Ctx, FieldDef, Option, ResourceDef, Row, ServiceDef, Tag } from "../../console/types.ts";
import { fieldTags, noTagChanges, tagDiff, tagDiffMessage, tagsToRecord } from "../../console/tags.ts";
import { changedAttributes, createAttributes, editValuesFromAttributes, epochMillisToIso, epochSecondsToIso, num, queueNameFromUrl, str, strArray, parseJsonAttribute } from "./helpers.ts";

const QUEUE_NAME = "[A-Za-z0-9_-]{1,80}";

async function listQueueUrls(ctx: Ctx): Promise<string[]> {
  const urls: string[] = [];
  let token: string | undefined;
  do {
    const page = await ctx.clients.sqs.send(new ListQueuesCommand({ MaxResults: 1000, NextToken: token }));
    urls.push(...(page.QueueUrls ?? []));
    token = page.NextToken;
  } while (token);
  return urls;
}

async function attributes(ctx: Ctx, url: string): Promise<Record<string, string>> {
  const r = await ctx.clients.sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["All"] }));
  return r.Attributes ?? {};
}

async function queueUrl(ctx: Ctx, name: string): Promise<string> {
  const r = await ctx.clients.sqs.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!r.QueueUrl) throw new Error(`SQS returned no URL for queue ${name}`);
  return r.QueueUrl;
}

function queueRow(url: string, a: Record<string, string>): Row {
  const name = queueNameFromUrl(url);
  return {
    name,
    url,
    type: a.FifoQueue === "true" || name.endsWith(".fifo") ? "FIFO" : "Standard",
    messagesAvailable: num(a.ApproximateNumberOfMessages),
    messagesInFlight: num(a.ApproximateNumberOfMessagesNotVisible),
    created: epochSecondsToIso(a.CreatedTimestamp),
    arn: a.QueueArn ?? null,
    encryption: a.SqsManagedSseEnabled === "true" ? "SSE-SQS" : a.KmsMasterKeyId ? "SSE-KMS" : "Disabled",
  };
}

/** Attributes, or null when this identity may not read them (the queue is still listed). */
async function attributesOrNull(ctx: Ctx, url: string): Promise<Record<string, string> | null> {
  try {
    return await attributes(ctx, url);
  } catch {
    return null;
  }
}

async function dlqOptions(ctx: Ctx, id?: string): Promise<Option[]> {
  const urls = await listQueueUrls(ctx);
  const rows = await Promise.all(urls.map(async (url) => ({ url, arn: (await attributesOrNull(ctx, url))?.QueueArn })));
  // A queue can't be its own dead-letter queue.
  return rows.filter((r) => r.arn && queueNameFromUrl(r.url) !== id).map((r) => ({ value: r.arn as string, label: queueNameFromUrl(r.url) }));
}

async function queueTags(ctx: Ctx, url: string): Promise<Tag[]> {
  const r = await ctx.clients.sqs.send(new ListQueueTagsCommand({ QueueUrl: url }));
  return Object.entries(r.Tags ?? {})
    .map(([Key, Value]) => ({ Key, Value }))
    .sort((x, y) => x.Key.localeCompare(y.Key));
}

const editFields: FieldDef[] = [
  { name: "visibilityTimeout", label: "Visibility timeout (seconds)", kind: "number", required: true, default: 30, section: "Configuration", validate: { min: 0, max: 43200, message: "Between 0 seconds and 12 hours (43200)." } },
  { name: "messageRetentionPeriod", label: "Message retention period (seconds)", kind: "number", required: true, default: 345600, section: "Configuration", validate: { min: 60, max: 1209600, message: "Between 1 minute (60) and 14 days (1209600)." } },
  { name: "delaySeconds", label: "Delivery delay (seconds)", kind: "number", required: true, default: 0, section: "Configuration", validate: { min: 0, max: 900, message: "Between 0 and 15 minutes (900)." } },
  { name: "maximumMessageSize", label: "Maximum message size (bytes)", kind: "number", required: true, default: 1048576, section: "Configuration", validate: { min: 1024, max: 1048576, message: "Between 1 KiB (1024) and 1 MiB (1048576)." } },
  { name: "receiveWaitTime", label: "Receive message wait time (seconds)", kind: "number", required: true, default: 0, section: "Configuration", help: "Above 0 turns on long polling.", validate: { min: 0, max: 20, message: "Between 0 and 20 seconds." } },
  { name: "contentBasedDeduplication", label: "Content-based deduplication (FIFO queues only)", kind: "checkbox", default: false, section: "Configuration" },
  { name: "enableDlq", label: "Send undeliverable messages to a dead-letter queue", kind: "checkbox", default: false, section: "Dead-letter queue" },
  { name: "dlqArn", label: "Dead-letter queue", kind: "select", required: true, options: dlqOptions, section: "Dead-letter queue", showIf: { field: "enableDlq", equals: true }, help: "Must be the same type (Standard or FIFO) as this queue." },
  { name: "maxReceiveCount", label: "Maximum receives", kind: "number", required: true, default: 10, section: "Dead-letter queue", showIf: { field: "enableDlq", equals: true }, validate: { min: 1, max: 1000, message: "Between 1 and 1000." } },
];

const queues: ResourceDef = {
  id: "queues",
  name: "Queues",
  singular: "queue",
  idField: "name",
  nameField: "name",
  description: "Message queues that decouple the parts of an application.",
  emptyText: "No queues. Create a queue to get started.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "type", label: "Type", kind: "text" },
    { key: "created", label: "Created", kind: "date" },
    { key: "messagesAvailable", label: "Messages available", kind: "count" },
    { key: "messagesInFlight", label: "Messages in flight", kind: "count" },
    { key: "encryption", label: "Encryption", kind: "text" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const urls = await listQueueUrls(ctx);
    // A queue whose attributes this identity can't read is still listed, by name.
    return Promise.all(urls.map(async (url) => queueRow(url, (await attributesOrNull(ctx, url)) ?? {})));
  },

  async get(ctx, name) {
    const url = await queueUrl(ctx, name);
    const a = await attributes(ctx, url);
    let tagError: string | null = null;
    const tags = await queueTags(ctx, url).catch((err: unknown) => {
      tagError = errorMessage(err);
      return [] as Tag[];
    });
    const redrive = parseJsonAttribute(a.RedrivePolicy);
    const redriveAllow = parseJsonAttribute(a.RedriveAllowPolicy);
    const row = queueRow(url, a);
    return {
      summary: { Name: row.name, Type: row.type, ARN: row.arn, URL: url, Encryption: row.encryption, Created: row.created },
      tabs: [
        {
          id: "details",
          label: "Details",
          kind: "keyvalue",
          data: {
            "Messages available": row.messagesAvailable,
            "Messages in flight": row.messagesInFlight,
            "Messages delayed": num(a.ApproximateNumberOfMessagesDelayed),
            "Visibility timeout (seconds)": num(a.VisibilityTimeout),
            "Message retention period (seconds)": num(a.MessageRetentionPeriod),
            "Delivery delay (seconds)": num(a.DelaySeconds),
            "Maximum message size (bytes)": num(a.MaximumMessageSize),
            "Receive message wait time (seconds)": num(a.ReceiveMessageWaitTimeSeconds),
            "Content-based deduplication": a.FifoQueue === "true" ? a.ContentBasedDeduplication === "true" : "Not a FIFO queue",
            "Last updated": epochSecondsToIso(a.LastModifiedTimestamp),
          },
        },
        {
          id: "attributes",
          label: "Attributes",
          kind: "table",
          columns: [
            { key: "name", label: "Attribute", kind: "text" },
            { key: "value", label: "Value", kind: "code" },
          ],
          data: Object.entries(a).sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => ({ name: k, value: v })),
          description: "Every attribute GetQueueAttributes returned for this queue.",
        },
        {
          id: "policy",
          label: "Access policy",
          kind: "json",
          data: parseJsonAttribute(a.Policy),
          emptyText: "This queue has no access policy. Only the queue owner can use it.",
        },
        {
          id: "redrive",
          label: "Dead-letter queue",
          kind: "keyvalue",
          data: redrive && typeof redrive === "object"
            ? {
                "Dead-letter queue": str((redrive as Record<string, unknown>).deadLetterTargetArn),
                "Maximum receives": num((redrive as Record<string, unknown>).maxReceiveCount),
                "Redrive allow policy": redriveAllow ? JSON.stringify(redriveAllow) : "Not set",
              }
            : {},
          emptyText: "No dead-letter queue is configured for this queue.",
        },
        {
          id: "tags",
          label: "Tags",
          kind: "table",
          columns: [
            { key: "Key", label: "Key", kind: "text" },
            { key: "Value", label: "Value", kind: "text" },
          ],
          data: tags,
          emptyText: tagError ? `Could not read tags: ${tagError}` : "No tags.",
        },
      ],
    };
  },

  create: {
    title: "Create queue",
    description: "Creates an SQS queue in the emulator with CreateQueue.",
    fields: [
      {
        name: "type", label: "Type", kind: "radio", default: "standard", section: "Details",
        help: "You can't change the queue type after you create a queue.",
        options: [
          { value: "standard", label: "Standard: at-least-once delivery, best-effort ordering" },
          { value: "fifo", label: "FIFO: first-in-first-out delivery, exactly-once processing" },
        ],
      },
      {
        name: "name", label: "Name", kind: "text", required: true, section: "Details", placeholder: "MyQueue",
        help: "Up to 80 characters: letters, numbers, hyphens and underscores. A FIFO queue name must end with .fifo.",
        validate: { pattern: `${QUEUE_NAME}(\\.fifo)?`, message: "Use up to 80 letters, numbers, hyphens or underscores (plus .fifo for FIFO queues)." },
      },
      { name: "visibilityTimeout", label: "Visibility timeout (seconds)", kind: "number", default: 30, section: "Configuration", validate: { min: 0, max: 43200, message: "Between 0 seconds and 12 hours (43200)." } },
      { name: "messageRetentionPeriod", label: "Message retention period (seconds)", kind: "number", default: 345600, section: "Configuration", help: "Default 4 days.", validate: { min: 60, max: 1209600, message: "Between 1 minute (60) and 14 days (1209600)." } },
      { name: "delaySeconds", label: "Delivery delay (seconds)", kind: "number", default: 0, section: "Configuration", validate: { min: 0, max: 900, message: "Between 0 and 15 minutes (900)." } },
      { name: "maximumMessageSize", label: "Maximum message size (bytes)", kind: "number", default: 1048576, section: "Configuration", validate: { min: 1024, max: 1048576, message: "Between 1 KiB (1024) and 1 MiB (1048576)." } },
      { name: "receiveWaitTime", label: "Receive message wait time (seconds)", kind: "number", default: 0, section: "Configuration", help: "Above 0 turns on long polling.", validate: { min: 0, max: 20, message: "Between 0 and 20 seconds." } },
      { name: "contentBasedDeduplication", label: "Content-based deduplication", kind: "checkbox", default: false, section: "Configuration", showIf: { field: "type", equals: "fifo" }, help: "Uses a SHA-256 hash of the body as the deduplication ID." },
      { name: "enableDlq", label: "Send undeliverable messages to a dead-letter queue", kind: "checkbox", default: false, section: "Dead-letter queue" },
      { name: "dlqArn", label: "Dead-letter queue", kind: "select", required: true, options: dlqOptions, section: "Dead-letter queue", showIf: { field: "enableDlq", equals: true }, help: "Must be the same type (Standard or FIFO) as this queue." },
      { name: "maxReceiveCount", label: "Maximum receives", kind: "number", default: 10, section: "Dead-letter queue", showIf: { field: "enableDlq", equals: true }, validate: { min: 1, max: 1000, message: "Between 1 and 1000." } },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      if (v.type === "fifo" && !name.endsWith(".fifo")) throw new Error("A FIFO queue name must end with .fifo.");
      if (v.type !== "fifo" && name.endsWith(".fifo")) throw new Error("Only FIFO queue names may end with .fifo. Choose the FIFO type or change the name.");
      const tags = Array.isArray(v.tags) ? Object.fromEntries((v.tags as Tag[]).map((t) => [t.Key, t.Value])) : undefined;
      await ctx.clients.sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: createAttributes(v), tags: tags && Object.keys(tags).length ? tags : undefined }));
      return name;
    },
  },

  actions: [
    {
      id: "edit",
      label: "Edit",
      fields: editFields,
      async initialValues(ctx, name) {
        return editValuesFromAttributes(await attributes(ctx, await queueUrl(ctx, name)));
      },
      async run(ctx, name, v) {
        const url = await queueUrl(ctx, name);
        const changed = changedAttributes(await attributes(ctx, url), v);
        const keys = Object.keys(changed);
        if (keys.length === 0) return { message: "No changes to save." };
        await ctx.clients.sqs.send(new SetQueueAttributesCommand({ QueueUrl: url, Attributes: changed }));
        return { message: `Saved ${keys.join(", ")}.` };
      },
    },
    {
      id: "tags",
      label: "Edit tags",
      fields: [{ name: "tags", label: "Tags", kind: "tags", help: "The queue's current tags. Add, change or remove tags." }],
      async initialValues(ctx, name) {
        return { tags: await queueTags(ctx, await queueUrl(ctx, name)) };
      },
      async run(ctx, name, v) {
        const url = await queueUrl(ctx, name);
        const diff = tagDiff(await queueTags(ctx, url), fieldTags(v.tags));
        if (noTagChanges(diff)) return { message: tagDiffMessage(diff) };
        if (diff.set.length) await ctx.clients.sqs.send(new TagQueueCommand({ QueueUrl: url, Tags: tagsToRecord(diff.set) }));
        if (diff.remove.length) await ctx.clients.sqs.send(new UntagQueueCommand({ QueueUrl: url, TagKeys: diff.remove }));
        return { message: tagDiffMessage(diff) };
      },
    },
    {
      id: "send",
      label: "Send message",
      fields: [
        { name: "body", label: "Message body", kind: "textarea", required: true, validate: { max: 262144, message: "At most 256 KiB." } },
        { name: "delaySeconds", label: "Delivery delay (seconds)", kind: "number", help: "Standard queues only. Leave empty to use the queue's delay.", validate: { min: 0, max: 900, message: "Between 0 and 900." } },
        { name: "groupId", label: "Message group ID", kind: "text", help: "Required for FIFO queues." },
        { name: "dedupId", label: "Message deduplication ID", kind: "text", help: "FIFO queues without content-based deduplication need one." },
      ],
      async run(ctx, name, v) {
        const url = await queueUrl(ctx, name);
        const r = await ctx.clients.sqs.send(
          new SendMessageCommand({
            QueueUrl: url,
            MessageBody: String(v.body),
            DelaySeconds: typeof v.delaySeconds === "number" ? v.delaySeconds : undefined,
            MessageGroupId: typeof v.groupId === "string" && v.groupId !== "" ? v.groupId : undefined,
            MessageDeduplicationId: typeof v.dedupId === "string" && v.dedupId !== "" ? v.dedupId : undefined,
          })
        );
        return { message: `Message sent. Message ID: ${r.MessageId ?? "(none returned)"}`, json: { MessageId: r.MessageId, MD5OfMessageBody: r.MD5OfMessageBody, SequenceNumber: r.SequenceNumber } };
      },
    },
    {
      id: "poll",
      label: "Poll for messages",
      fields: [
        { name: "maxMessages", label: "Maximum messages", kind: "number", default: 10, validate: { min: 1, max: 10, message: "Between 1 and 10." } },
        { name: "waitTime", label: "Wait time (seconds)", kind: "number", default: 1, validate: { min: 0, max: 20, message: "Between 0 and 20." } },
      ],
      async run(ctx, name, v) {
        const url = await queueUrl(ctx, name);
        const r = await ctx.clients.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: url,
            MaxNumberOfMessages: typeof v.maxMessages === "number" ? v.maxMessages : 10,
            WaitTimeSeconds: typeof v.waitTime === "number" ? v.waitTime : 1,
            MessageSystemAttributeNames: ["All"],
            MessageAttributeNames: ["All"],
          })
        );
        const rows = (r.Messages ?? []).map((m) => ({
          messageId: m.MessageId ?? "",
          body: m.Body ?? "",
          sent: epochMillisToIso(m.Attributes?.SentTimestamp),
          receiveCount: num(m.Attributes?.ApproximateReceiveCount),
          groupId: m.Attributes?.MessageGroupId ?? null,
          receiptHandle: m.ReceiptHandle ?? "",
        }));
        return {
          message: `Received ${rows.length} message${rows.length === 1 ? "" : "s"}. They stay invisible for the queue's visibility timeout unless you delete them.`,
          table: {
            rowKey: "receiptHandle",
            emptyText: "No messages were received.",
            columns: [
              { key: "messageId", label: "ID", kind: "text" },
              { key: "sent", label: "Sent", kind: "date" },
              { key: "receiveCount", label: "Receive count", kind: "count" },
              { key: "groupId", label: "Message group ID", kind: "text" },
              { key: "body", label: "Body", kind: "code" },
            ],
            rows,
            selectionAction: { actionId: "delete-messages", label: "Delete", danger: true, valuesField: "receiptHandles" },
          },
        };
      },
    },
    {
      id: "delete-messages",
      label: "Delete messages",
      hidden: true,
      danger: true,
      fields: [{ name: "receiptHandles", label: "Messages", kind: "multiselect", required: true }],
      async run(ctx, name, v) {
        const url = await queueUrl(ctx, name);
        const handles = strArray(v.receiptHandles);
        let deleted = 0;
        const failures: string[] = [];
        for (let i = 0; i < handles.length; i += 10) {
          const chunk = handles.slice(i, i + 10);
          const r = await ctx.clients.sqs.send(
            new DeleteMessageBatchCommand({ QueueUrl: url, Entries: chunk.map((h, j) => ({ Id: `m${i + j}`, ReceiptHandle: h })) })
          );
          deleted += r.Successful?.length ?? 0;
          for (const f of r.Failed ?? []) failures.push(`${f.Code ?? "Error"}: ${f.Message ?? ""}`);
        }
        if (failures.length) throw new Error(`Deleted ${deleted}; ${failures.length} failed: ${failures.join("; ")}`);
        return { message: `Deleted ${deleted} message${deleted === 1 ? "" : "s"}.` };
      },
    },
    {
      id: "purge",
      label: "Purge",
      danger: true,
      confirm: "Purging deletes every message in the queue. This can't be undone.",
      async run(ctx, name) {
        await ctx.clients.sqs.send(new PurgeQueueCommand({ QueueUrl: await queueUrl(ctx, name) }));
        return { message: `Purge requested for ${name}.` };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, name) {
      await ctx.clients.sqs.send(new DeleteQueueCommand({ QueueUrl: await queueUrl(ctx, name) }));
    },
  },
};

export const sqsService: ServiceDef = {
  id: "sqs",
  name: "Amazon SQS",
  category: "Application Integration",
  description: "Fully managed message queues for microservices, distributed systems and serverless applications.",
  resources: [queues],
};
