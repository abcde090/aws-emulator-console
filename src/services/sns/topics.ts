/** Amazon SNS topics: standard and FIFO, publish, subscriptions, policies, encryption and tags. */

import {
  CreateTopicCommand,
  DeleteTopicCommand,
  GetTopicAttributesCommand,
  ListSubscriptionsByTopicCommand,
  ListTagsForResourceCommand,
  PublishCommand,
  SetTopicAttributesCommand,
  TagResourceCommand,
  UntagResourceCommand,
  type Subscription,
} from "@aws-sdk/client-sns";
import type { Ctx, FieldValues, ResourceDef, Row, Tag } from "../../console/types.ts";
import { parseJsonText, prettyJson, sameJson } from "../../console/values.ts";
import { isFifoTopic, lastArnSegment, normaliseJsonObject, num, parseMessageAttributes, text } from "./helpers.ts";
import { listTopicArns } from "./lookups.ts";
import { manageTagsAction } from "../../console/tags.ts";
import { secondary, unavailableText } from "../../console/secondary.ts";
import { subscribe, subscriptionFields, subscriptionRow } from "./subscriptions.ts";

const TOPIC_NAME = "[A-Za-z0-9_-]{1,256}";

async function attributes(ctx: Ctx, arn: string): Promise<Record<string, string>> {
  const r = await ctx.clients.sns.send(new GetTopicAttributesCommand({ TopicArn: arn }));
  return r.Attributes ?? {};
}

function topicRow(arn: string, a: Record<string, string>): Row {
  const name = lastArnSegment(arn);
  return {
    name,
    arn,
    type: isFifoTopic(a, name) ? "FIFO" : "Standard",
    displayName: a.DisplayName || null,
    confirmed: num(a.SubscriptionsConfirmed),
    pending: num(a.SubscriptionsPending),
    encryption: a.KmsMasterKeyId ? "Enabled" : "Disabled",
  };
}

async function topicTags(ctx: Ctx, arn: string): Promise<Tag[]> {
  const r = await ctx.clients.sns.send(new ListTagsForResourceCommand({ ResourceArn: arn }));
  return (r.Tags ?? []).map((t) => ({ Key: t.Key ?? "", Value: t.Value ?? "" }));
}

/** Sets one topic attribute unless it already has that value. */
async function setTopicAttribute(ctx: Ctx, arn: string, name: string, value: string, same: (current: string | undefined) => boolean): Promise<boolean> {
  if (same((await attributes(ctx, arn))[name])) return false;
  await ctx.clients.sns.send(new SetTopicAttributesCommand({ TopicArn: arn, AttributeName: name, AttributeValue: value }));
  return true;
}

async function topicSubscriptions(ctx: Ctx, arn: string): Promise<Subscription[]> {
  const subs: Subscription[] = [];
  let token: string | undefined;
  do {
    const page = await ctx.clients.sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: arn, NextToken: token }));
    subs.push(...(page.Subscriptions ?? []));
    token = page.NextToken;
  } while (token);
  return subs;
}

function createAttributes(v: FieldValues): Record<string, string> {
  const attrs: Record<string, string> = {};
  const display = text(v.displayName);
  if (display) attrs.DisplayName = display;
  if (v.type === "fifo") {
    attrs.FifoTopic = "true";
    if (v.contentBasedDeduplication === true) attrs.ContentBasedDeduplication = "true";
  }
  if (v.encryption === true) attrs.KmsMasterKeyId = text(v.kmsKey) || "alias/aws/sns";
  const policy = normaliseJsonObject("Access policy", v.accessPolicy);
  if (policy) attrs.Policy = policy;
  const delivery = normaliseJsonObject("Delivery policy", v.deliveryPolicy);
  if (delivery) attrs.DeliveryPolicy = delivery;
  return attrs;
}

export const topics: ResourceDef = {
  id: "topics",
  name: "Topics",
  singular: "topic",
  idField: "arn",
  nameField: "Name",
  description: "Communication channels that fan messages out to subscribed endpoints.",
  emptyText: "No topics. Create a topic to get started.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "type", label: "Type", kind: "text" },
    { key: "arn", label: "ARN", kind: "arn" },
    { key: "displayName", label: "Display name", kind: "text", hidden: true },
    { key: "confirmed", label: "Subscriptions confirmed", kind: "count", hidden: true },
  ],

  async list(ctx) {
    const arns = await listTopicArns(ctx);
    // A denied GetTopicAttributes still lists the topic (from ListTopics), without its attributes.
    return Promise.all(
      arns.map(async (arn) => {
        const a = await secondary(attributes(ctx, arn));
        if (a.ok) return topicRow(arn, a.value);
        const name = lastArnSegment(arn);
        return { name, arn, type: name.endsWith(".fifo") ? "FIFO" : "Standard", displayName: null, confirmed: null, pending: null, encryption: null };
      })
    );
  },

  async get(ctx, arn) {
    const a = await attributes(ctx, arn);
    const [subs, tags] = await Promise.all([secondary(topicSubscriptions(ctx, arn)), secondary(topicTags(ctx, arn))]);
    const row = topicRow(arn, a);
    return {
      summary: {
        Name: row.name,
        ARN: arn,
        Type: row.type,
        "Display name": a.DisplayName || "-",
        "Topic owner": a.Owner ?? null,
        ...(row.type === "FIFO" ? { "Content-based message deduplication": a.ContentBasedDeduplication === "true" ? "Enabled" : "Disabled" } : {}),
      },
      tabs: [
        {
          id: "subscriptions",
          label: subs.ok ? `Subscriptions (${subs.value.length})` : "Subscriptions",
          kind: "table",
          columns: [
            { key: "shortId", label: "ID", kind: "text" },
            { key: "endpoint", label: "Endpoint", kind: "text" },
            { key: "status", label: "Status", kind: "status" },
            { key: "protocol", label: "Protocol", kind: "text" },
          ],
          data: subs.ok ? subs.value.map(subscriptionRow) : [],
          description: subs.ok ? `Confirmed: ${a.SubscriptionsConfirmed ?? "-"} · Pending: ${a.SubscriptionsPending ?? "-"} · Deleted: ${a.SubscriptionsDeleted ?? "-"}. Open Subscriptions in the left menu to see or edit one.` : undefined,
          emptyText: unavailableText(subs, "No subscriptions. Use Actions > Create subscription."),
        },
        {
          id: "policy",
          label: "Access policy",
          kind: "json",
          data: parseJsonText(a.Policy),
          description: "Who can publish to and subscribe to this topic.",
          emptyText: "No access policy.",
        },
        {
          id: "delivery",
          label: "Delivery policy (HTTP/S)",
          kind: "json",
          data: parseJsonText(a.DeliveryPolicy) ?? parseJsonText(a.EffectiveDeliveryPolicy),
          description: a.DeliveryPolicy ? "The delivery policy set on this topic." : "No delivery policy is set; this is the effective (default) policy SNS reported.",
          emptyText: "No delivery policy.",
        },
        {
          id: "encryption",
          label: "Encryption",
          kind: "keyvalue",
          data: { Encryption: a.KmsMasterKeyId ? "Enabled" : "Disabled", "AWS KMS key": a.KmsMasterKeyId || "-" },
        },
        {
          id: "tags",
          label: "Tags",
          kind: "table",
          columns: [
            { key: "Key", label: "Key", kind: "text" },
            { key: "Value", label: "Value", kind: "text" },
          ],
          data: tags.ok ? tags.value : [],
          emptyText: unavailableText(tags, "No tags."),
        },
        {
          id: "attributes",
          label: "Attributes",
          kind: "table",
          columns: [
            { key: "name", label: "Attribute", kind: "text" },
            { key: "value", label: "Value", kind: "code" },
          ],
          data: Object.entries(a).sort(([x], [y]) => x.localeCompare(y)).map(([name, value]) => ({ name, value })),
          description: "Every attribute GetTopicAttributes returned for this topic.",
        },
      ],
    };
  },

  create: {
    title: "Create topic",
    description: "Creates an SNS topic in the emulator with CreateTopic.",
    fields: [
      {
        name: "type", label: "Type", kind: "radio", default: "standard", section: "Details",
        help: "You can't modify the topic type after you create a topic.",
        options: [
          { value: "fifo", label: "FIFO: strictly-preserved message ordering, exactly-once delivery, subscription protocols: SQS" },
          { value: "standard", label: "Standard: best-effort ordering, at-least-once delivery, subscription protocols: SQS, Lambda, HTTP/S, SMS, email, mobile app endpoints" },
        ],
      },
      {
        name: "name", label: "Name", kind: "text", required: true, section: "Details", placeholder: "MyTopic",
        help: "Up to 256 characters: letters, numbers, hyphens and underscores. A FIFO topic name must end with .fifo.",
        validate: { pattern: `${TOPIC_NAME}(\\.fifo)?`, message: "Use up to 256 letters, numbers, hyphens or underscores (plus .fifo for FIFO topics)." },
      },
      { name: "displayName", label: "Display name", kind: "text", section: "Details", placeholder: "My Topic", help: "To use this topic with SMS subscriptions, enter a display name. Only the first 10 characters are shown in an SMS message.", validate: { max: 100, message: "At most 100 characters." } },
      { name: "contentBasedDeduplication", label: "Content-based message deduplication", kind: "checkbox", default: false, section: "Details", showIf: { field: "type", equals: "fifo" }, help: "SNS uses a SHA-256 hash of the message body as the deduplication ID." },
      { name: "encryption", label: "Enable encryption", kind: "checkbox", default: false, section: "Encryption - optional", help: "Server-side encryption with an AWS KMS key." },
      { name: "kmsKey", label: "AWS KMS key", kind: "text", default: "alias/aws/sns", section: "Encryption - optional", showIf: { field: "encryption", equals: true }, help: "A key ID, alias or ARN. alias/aws/sns is the AWS managed key for SNS." },
      { name: "accessPolicy", label: "Access policy (JSON)", kind: "json", section: "Access policy - optional", help: "Leave empty for the basic policy: only the topic owner can publish and subscribe." },
      { name: "deliveryPolicy", label: "Delivery policy (JSON)", kind: "json", section: "Delivery policy (HTTP/S) - optional", placeholder: '{\n  "http": {\n    "defaultHealthyRetryPolicy": { "numRetries": 3, "minDelayTarget": 20, "maxDelayTarget": 20, "backoffFunction": "linear" }\n  }\n}', help: "Retry behaviour for HTTP/S endpoints." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags - optional" },
    ],
    async run(ctx, v) {
      const name = text(v.name);
      if (v.type === "fifo" && !name.endsWith(".fifo")) throw new Error("A FIFO topic name must end with .fifo.");
      if (v.type !== "fifo" && name.endsWith(".fifo")) throw new Error("Only FIFO topic names can end with .fifo.");
      const tags = Array.isArray(v.tags) ? (v.tags as Tag[]) : [];
      const r = await ctx.clients.sns.send(new CreateTopicCommand({ Name: name, Attributes: createAttributes(v), Tags: tags.length ? tags : undefined }));
      if (!r.TopicArn) throw new Error("SNS returned no topic ARN.");
      return r.TopicArn;
    },
  },

  actions: [
    {
      id: "publish",
      label: "Publish message",
      fields: [
        { name: "subject", label: "Subject", kind: "text", help: "Used as the email subject for email endpoints. Up to 100 printable ASCII characters.", validate: { max: 100, message: "At most 100 characters." } },
        { name: "structure", label: "Message structure", kind: "radio", default: "identical", options: [
          { value: "identical", label: "Identical payload for all delivery protocols" },
          { value: "json", label: "Custom payload for each delivery protocol (JSON with a \"default\" key)" },
        ] },
        { name: "body", label: "Message body", kind: "textarea", required: true, help: "Up to 256 KB." },
        { name: "groupId", label: "Message group ID", kind: "text", help: "Required for FIFO topics. Messages in the same group are delivered in order." },
        { name: "dedupId", label: "Message deduplication ID", kind: "text", help: "FIFO topics without content-based deduplication need one." },
        { name: "attributes", label: "Message attributes (JSON)", kind: "json", placeholder: '{\n  "eventType": "order_placed",\n  "price": 25,\n  "colors": ["red", "blue"]\n}', help: "Name/value pairs. Strings become String, numbers Number, arrays String.Array. Subscription filter policies match on these." },
      ],
      async run(ctx, arn, v) {
        const json = v.structure === "json";
        if (json) normaliseJsonObject("Message body", v.body);
        const attrs = parseMessageAttributes(typeof v.attributes === "string" ? v.attributes : "");
        const r = await ctx.clients.sns.send(
          new PublishCommand({
            TopicArn: arn,
            Message: String(v.body),
            Subject: text(v.subject) || undefined,
            MessageStructure: json ? "json" : undefined,
            MessageGroupId: text(v.groupId) || undefined,
            MessageDeduplicationId: text(v.dedupId) || undefined,
            MessageAttributes: Object.keys(attrs).length ? attrs : undefined,
          })
        );
        return {
          message: `Message published to topic ${lastArnSegment(arn)}. Message ID: ${r.MessageId ?? "(none returned)"}`,
          json: { MessageId: r.MessageId, SequenceNumber: r.SequenceNumber },
        };
      },
    },
    {
      id: "subscribe",
      label: "Create subscription",
      fields: subscriptionFields(false),
      async run(ctx, arn, v) {
        const id = await subscribe(ctx, arn, v);
        return { message: id.startsWith("arn:") ? `Subscription created: ${id}` : "Subscription created. It stays pending until the endpoint confirms it." };
      },
    },
    {
      id: "edit-display-name",
      label: "Edit display name",
      fields: [{ name: "displayName", label: "Display name", kind: "text", help: "Leave empty to remove the display name.", validate: { max: 100, message: "At most 100 characters." } }],
      async initialValues(ctx, arn) {
        return { displayName: (await attributes(ctx, arn)).DisplayName ?? "" };
      },
      async run(ctx, arn, v) {
        const value = text(v.displayName);
        const changed = await setTopicAttribute(ctx, arn, "DisplayName", value, (cur) => (cur ?? "") === value);
        return { message: changed ? "Display name updated." : "No changes: the display name is already set to that." };
      },
    },
    {
      id: "edit-access-policy",
      label: "Edit access policy",
      fields: [{ name: "policy", label: "Access policy (JSON)", kind: "json", required: true, help: "The topic's whole access policy. Saving replaces it." }],
      async initialValues(ctx, arn) {
        return { policy: prettyJson((await attributes(ctx, arn)).Policy) };
      },
      async run(ctx, arn, v) {
        const value = normaliseJsonObject("Access policy", v.policy) ?? "";
        const changed = await setTopicAttribute(ctx, arn, "Policy", value, (cur) => sameJson(cur, value));
        return { message: changed ? "Access policy updated." : "No changes: the access policy is the same." };
      },
    },
    {
      id: "edit-delivery-policy",
      label: "Edit delivery policy",
      fields: [{ name: "policy", label: "Delivery policy (JSON)", kind: "json", help: 'Retry behaviour for HTTP/S endpoints, for example {"http":{"defaultHealthyRetryPolicy":{"numRetries":5,"minDelayTarget":20,"maxDelayTarget":20}}}. Leave empty to remove it and use the default policy.' }],
      async initialValues(ctx, arn) {
        return { policy: prettyJson((await attributes(ctx, arn)).DeliveryPolicy) };
      },
      async run(ctx, arn, v) {
        const value = normaliseJsonObject("Delivery policy", v.policy) ?? "";
        const changed = await setTopicAttribute(ctx, arn, "DeliveryPolicy", value, (cur) => sameJson(cur, value));
        return { message: changed ? (value ? "Delivery policy updated." : "Delivery policy removed.") : "No changes: the delivery policy is the same." };
      },
    },
    {
      id: "edit-encryption",
      label: "Edit encryption",
      fields: [
        { name: "encryption", label: "Enable encryption", kind: "checkbox", default: false },
        { name: "kmsKey", label: "AWS KMS key", kind: "text", required: true, default: "alias/aws/sns", showIf: { field: "encryption", equals: true }, help: "A key ID, alias or ARN. alias/aws/sns is the AWS managed key for SNS." },
      ],
      async initialValues(ctx, arn) {
        const key = (await attributes(ctx, arn)).KmsMasterKeyId ?? "";
        return { encryption: key !== "", kmsKey: key || "alias/aws/sns" };
      },
      async run(ctx, arn, v) {
        const key = v.encryption === true ? text(v.kmsKey) || "alias/aws/sns" : "";
        const changed = await setTopicAttribute(ctx, arn, "KmsMasterKeyId", key, (cur) => (cur ?? "") === key);
        if (!changed) return { message: "No changes: encryption is already set that way." };
        return { message: key ? `Encryption enabled with ${key}.` : "Encryption disabled." };
      },
    },
    manageTagsAction({
      read: topicTags,
      async tag(ctx, arn, tags) {
        await ctx.clients.sns.send(new TagResourceCommand({ ResourceArn: arn, Tags: tags }));
      },
      async untag(ctx, arn, keys) {
        await ctx.clients.sns.send(new UntagResourceCommand({ ResourceArn: arn, TagKeys: keys }));
      },
    }),
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, arn) {
      await ctx.clients.sns.send(new DeleteTopicCommand({ TopicArn: arn }));
    },
  },
};
