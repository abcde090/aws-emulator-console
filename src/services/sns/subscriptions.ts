/** Amazon SNS subscriptions: list, detail, create (Subscribe), edit, confirm and delete. */

import {
  ConfirmSubscriptionCommand,
  GetSubscriptionAttributesCommand,
  ListSubscriptionsCommand,
  SetSubscriptionAttributesCommand,
  SubscribeCommand,
  UnsubscribeCommand,
  type Subscription,
} from "@aws-sdk/client-sns";
import type { Ctx, FieldDef, FieldValues, Option, ResourceDef, Row } from "../../console/types.ts";
import { parseJsonText, prettyJson, sameJson } from "../../console/values.ts";
import { lastArnSegment, normaliseJsonObject, parsePendingId, subscriptionRowId, text } from "./helpers.ts";
import { functionOptions, queueOptions, topicOptions } from "./lookups.ts";

const PROTOCOLS = [
  { value: "sqs", label: "Amazon SQS" },
  { value: "lambda", label: "AWS Lambda" },
  { value: "http", label: "HTTP" },
  { value: "https", label: "HTTPS" },
  { value: "email", label: "Email" },
  { value: "email-json", label: "Email-JSON" },
  { value: "sms", label: "SMS" },
  { value: "application", label: "Platform application endpoint" },
  { value: "firehose", label: "Amazon Data Firehose" },
];

/** One endpoint field per protocol, so each shows the right input. */
const ENDPOINT_FIELD: Record<string, string> = {
  sqs: "endpointSqs",
  lambda: "endpointLambda",
  http: "endpointHttp",
  https: "endpointHttps",
  email: "endpointEmail",
  "email-json": "endpointEmailJson",
  sms: "endpointSms",
  application: "endpointApplication",
  firehose: "endpointFirehose",
};

export async function listAllSubscriptions(ctx: Ctx): Promise<Subscription[]> {
  const subs: Subscription[] = [];
  let token: string | undefined;
  do {
    const page = await ctx.clients.sns.send(new ListSubscriptionsCommand({ NextToken: token }));
    subs.push(...(page.Subscriptions ?? []));
    token = page.NextToken;
  } while (token);
  return subs;
}

export function subscriptionRow(s: Subscription): Row {
  const confirmed = (s.SubscriptionArn ?? "").startsWith("arn:");
  return {
    id: subscriptionRowId(s),
    shortId: confirmed ? lastArnSegment(s.SubscriptionArn ?? "") : "Pending confirmation",
    endpoint: s.Endpoint ?? null,
    status: confirmed ? "Confirmed" : "Pending confirmation",
    protocol: s.Protocol ?? null,
    topic: s.TopicArn ? lastArnSegment(s.TopicArn) : null,
    topicArn: s.TopicArn ?? null,
    arn: confirmed ? s.SubscriptionArn : null,
  };
}

export function subscriptionFields(withTopic: boolean): FieldDef[] {
  const topic: FieldDef[] = withTopic
    ? [{ name: "topicArn", label: "Topic ARN", kind: "select", required: true, section: "Details", options: topicOptions, help: "The topic this endpoint subscribes to." }]
    : [];
  const endpointText = (protocol: string, label: string, placeholder: string, help: string): FieldDef => ({
    name: ENDPOINT_FIELD[protocol], label: "Endpoint", kind: "text", required: true, section: "Details",
    showIf: { field: "protocol", equals: protocol }, placeholder, help: `${label}: ${help}`,
  });
  return [
    ...topic,
    { name: "protocol", label: "Protocol", kind: "select", required: true, default: "sqs", section: "Details", options: PROTOCOLS, help: "The type of endpoint to subscribe." },
    { name: ENDPOINT_FIELD.sqs, label: "Endpoint", kind: "select", required: true, section: "Details", showIf: { field: "protocol", equals: "sqs" }, options: queueOptions, help: "The SQS queue that receives the notifications. Its access policy must allow sns.amazonaws.com to call sqs:SendMessage, or SNS can't deliver." },
    { name: ENDPOINT_FIELD.lambda, label: "Endpoint", kind: "select", required: true, section: "Details", showIf: { field: "protocol", equals: "lambda" }, options: functionOptions, help: "The Lambda function that is invoked for each notification." },
    endpointText("http", "HTTP", "http://example.com/notify", "a URL beginning with http://"),
    endpointText("https", "HTTPS", "https://example.com/notify", "a URL beginning with https://"),
    endpointText("email", "Email", "user@example.com", "an email address"),
    endpointText("email-json", "Email-JSON", "user@example.com", "an email address"),
    endpointText("sms", "SMS", "+15555550100", "a phone number in E.164 format"),
    endpointText("application", "Platform endpoint", "arn:aws:sns:us-east-1:000000000000:endpoint/...", "the ARN of a mobile app endpoint"),
    endpointText("firehose", "Firehose", "arn:aws:firehose:us-east-1:000000000000:deliverystream/...", "the ARN of a Firehose delivery stream"),
    { name: "subscriptionRoleArn", label: "Subscription role ARN", kind: "text", section: "Details", showIf: { field: "protocol", equals: "firehose" }, required: true, help: "An IAM role that lets SNS write to the delivery stream." },
    { name: "rawMessageDelivery", label: "Enable raw message delivery", kind: "checkbox", default: false, section: "Details", help: "Deliver the message body as is, without the SNS JSON envelope. Applies to Amazon SQS, HTTP/S and Firehose endpoints." },
    { name: "filterPolicyScope", label: "Filter policy scope", kind: "radio", default: "MessageAttributes", section: "Subscription filter policy - optional", options: [
      { value: "MessageAttributes", label: "Message attributes" },
      { value: "MessageBody", label: "Message body" },
    ], help: "Which part of each message the filter policy is matched against." },
    { name: "filterPolicy", label: "Filter policy (JSON)", kind: "json", section: "Subscription filter policy - optional", placeholder: '{\n  "eventType": ["order_placed"]\n}', help: "The subscriber receives only messages that match this policy. Leave empty to receive every message." },
    { name: "dlqArn", label: "Dead-letter queue (redrive policy)", kind: "select", section: "Redrive policy (dead-letter queue) - optional", options: queueOptions, help: "Messages that can't be delivered after retries are sent to this SQS queue." },
  ];
}

export async function subscribe(ctx: Ctx, topicArn: string, v: FieldValues): Promise<string> {
  const protocol = text(v.protocol);
  const field = ENDPOINT_FIELD[protocol];
  if (!field) throw new Error("Choose a protocol.");
  const endpoint = text(v[field]);
  if (!endpoint) throw new Error("Enter an endpoint.");
  const attributes: Record<string, string> = {};
  if (v.rawMessageDelivery === true) attributes.RawMessageDelivery = "true";
  const filter = normaliseJsonObject("Filter policy", v.filterPolicy);
  if (filter) {
    attributes.FilterPolicy = filter;
    attributes.FilterPolicyScope = text(v.filterPolicyScope) || "MessageAttributes";
  }
  const dlq = text(v.dlqArn);
  if (dlq) attributes.RedrivePolicy = JSON.stringify({ deadLetterTargetArn: dlq });
  const role = text(v.subscriptionRoleArn);
  if (protocol === "firehose" && role) attributes.SubscriptionRoleArn = role;
  const r = await ctx.clients.sns.send(
    new SubscribeCommand({ TopicArn: topicArn, Protocol: protocol, Endpoint: endpoint, Attributes: Object.keys(attributes).length ? attributes : undefined, ReturnSubscriptionArn: true })
  );
  const arn = r.SubscriptionArn ?? "";
  if (arn.startsWith("arn:")) return arn;
  return subscriptionRowId({ SubscriptionArn: arn, TopicArn: topicArn, Protocol: protocol, Endpoint: endpoint });
}

async function pendingDetail(ctx: Ctx, id: string) {
  const p = parsePendingId(id);
  const found = p ? (await listAllSubscriptions(ctx)).find((s) => subscriptionRowId(s) === id) : undefined;
  if (!p || !found) throw new Error("NotFound: this subscription no longer exists, or it was confirmed and now has an ARN. Go back to the list.");
  return {
    summary: { ID: "Pending confirmation", Status: "Pending confirmation", Protocol: found.Protocol ?? null, Endpoint: found.Endpoint ?? null, Topic: found.TopicArn ?? null, Owner: found.Owner ?? null },
    tabs: [],
  };
}

async function subscriptionAttributes(ctx: Ctx, arn: string): Promise<Record<string, string>> {
  if (!arn.startsWith("arn:")) throw new Error("A subscription that is pending confirmation has no attributes to edit yet.");
  return (await ctx.clients.sns.send(new GetSubscriptionAttributesCommand({ SubscriptionArn: arn }))).Attributes ?? {};
}

function dlqOf(redrivePolicy: string | undefined): string {
  const p = parseJsonText(redrivePolicy);
  return p && typeof p === "object" && typeof (p as { deadLetterTargetArn?: unknown }).deadLetterTargetArn === "string" ? (p as { deadLetterTargetArn: string }).deadLetterTargetArn : "";
}

/**
 * Edit dialog choices for the dead-letter queue: "None" (removes it; the engine hides its own
 * "-" once the field is prefilled), the current queue if it is no longer listed, then the queues.
 */
async function dlqOptions(ctx: Ctx, id?: string): Promise<Option[]> {
  const queues = await queueOptions(ctx);
  const none = { value: "", label: "None" };
  if (!id?.startsWith("arn:")) return [none, ...queues];
  const current = dlqOf((await subscriptionAttributes(ctx, id)).RedrivePolicy);
  return current && !queues.some((q) => q.value === current) ? [none, { value: current, label: lastArnSegment(current) }, ...queues] : [none, ...queues];
}

const isPending = (row: Row) => String(row.status ?? row.Status ?? "").startsWith("Pending");

export const subscriptions: ResourceDef = {
  id: "subscriptions",
  name: "Subscriptions",
  singular: "subscription",
  idField: "id",
  nameField: "ID",
  description: "Endpoints that receive the messages published to a topic.",
  emptyText: "No subscriptions. Create a subscription to send a topic's messages to an endpoint.",
  columns: [
    { key: "shortId", label: "ID", kind: "link" },
    { key: "endpoint", label: "Endpoint", kind: "text" },
    { key: "status", label: "Status", kind: "status" },
    { key: "protocol", label: "Protocol", kind: "text" },
    { key: "topic", label: "Topic", kind: "text" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    return (await listAllSubscriptions(ctx)).map(subscriptionRow);
  },

  async get(ctx, id) {
    if (!id.startsWith("arn:")) return pendingDetail(ctx, id);
    const r = await ctx.clients.sns.send(new GetSubscriptionAttributesCommand({ SubscriptionArn: id }));
    const a = r.Attributes ?? {};
    const pending = a.PendingConfirmation === "true";
    return {
      summary: {
        ID: lastArnSegment(id),
        ARN: id,
        Endpoint: a.Endpoint ?? null,
        Topic: a.TopicArn ?? null,
        Protocol: a.Protocol ?? null,
        Status: pending ? "Pending confirmation" : "Confirmed",
        "Subscription principal": a.SubscriptionPrincipal ?? null,
        "Raw message delivery": a.RawMessageDelivery === "true" ? "Enabled" : "Disabled",
      },
      tabs: [
        {
          id: "filter",
          label: "Subscription filter policy",
          kind: "json",
          data: parseJsonText(a.FilterPolicy),
          description: a.FilterPolicy ? `Filter policy scope: ${a.FilterPolicyScope ?? "MessageAttributes"}` : undefined,
          emptyText: "No filter policy. This subscription receives every message published to the topic.",
        },
        {
          id: "redrive",
          label: "Redrive policy (dead-letter queue)",
          kind: "json",
          data: parseJsonText(a.RedrivePolicy),
          emptyText: "No dead-letter queue is configured for this subscription.",
        },
        {
          id: "delivery",
          label: "Delivery policy",
          kind: "json",
          data: parseJsonText(a.EffectiveDeliveryPolicy ?? a.DeliveryPolicy),
          emptyText: "No delivery policy. Delivery policies apply to HTTP/S subscriptions.",
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
          description: "Every attribute GetSubscriptionAttributes returned.",
        },
      ],
    };
  },

  create: {
    title: "Create subscription",
    description: "Subscribes an endpoint to a topic with Subscribe. Email, HTTP/S and SMS endpoints stay pending until they confirm.",
    fields: subscriptionFields(true),
    async run(ctx, v) {
      const topic = text(v.topicArn);
      if (!topic) throw new Error("Choose a topic.");
      return subscribe(ctx, topic, v);
    },
  },

  actions: [
    {
      id: "edit",
      label: "Edit",
      availableFor: (row) => !isPending(row),
      fields: [
        { name: "rawMessageDelivery", label: "Enable raw message delivery", kind: "checkbox", default: false, help: "Deliver the message body as is, without the SNS JSON envelope. Applies to Amazon SQS, HTTP/S and Firehose endpoints." },
        { name: "filterPolicyScope", label: "Filter policy scope", kind: "radio", default: "MessageAttributes", options: [
          { value: "MessageAttributes", label: "Message attributes" },
          { value: "MessageBody", label: "Message body" },
        ] },
        { name: "filterPolicy", label: "Filter policy (JSON)", kind: "json", help: "Leave empty to remove the filter policy; the subscriber then receives every message." },
        { name: "dlqArn", label: "Dead-letter queue (redrive policy)", kind: "select", options: dlqOptions, help: "Messages that can't be delivered after retries are sent to this SQS queue." },
        { name: "deliveryPolicy", label: "Delivery policy (JSON)", kind: "json", help: "Retry policy for HTTP/S subscriptions only." },
      ],
      async initialValues(ctx, id) {
        const a = await subscriptionAttributes(ctx, id);
        return {
          rawMessageDelivery: a.RawMessageDelivery === "true",
          filterPolicyScope: a.FilterPolicyScope || "MessageAttributes",
          filterPolicy: prettyJson(a.FilterPolicy),
          dlqArn: dlqOf(a.RedrivePolicy),
          deliveryPolicy: prettyJson(a.DeliveryPolicy),
        };
      },
      async run(ctx, id, v) {
        const a = await subscriptionAttributes(ctx, id);
        // Only attributes the user changed are sent, one SetSubscriptionAttributes call each.
        const changes: [string, string][] = [];
        const raw = v.rawMessageDelivery === true ? "true" : "false";
        if (raw !== (a.RawMessageDelivery === "true" ? "true" : "false")) changes.push(["RawMessageDelivery", raw]);
        const filter = normaliseJsonObject("Filter policy", v.filterPolicy) ?? "";
        if (!sameJson(a.FilterPolicy, filter)) changes.push(["FilterPolicy", filter]);
        const scope = text(v.filterPolicyScope) || "MessageAttributes";
        if (filter && scope !== (a.FilterPolicyScope || "MessageAttributes")) changes.push(["FilterPolicyScope", scope]);
        const dlq = text(v.dlqArn);
        if (dlq !== dlqOf(a.RedrivePolicy)) changes.push(["RedrivePolicy", dlq ? JSON.stringify({ deadLetterTargetArn: dlq }) : ""]);
        const delivery = normaliseJsonObject("Delivery policy", v.deliveryPolicy) ?? "";
        if (!sameJson(a.DeliveryPolicy, delivery)) changes.push(["DeliveryPolicy", delivery]);
        if (!changes.length) return { message: "No changes to save." };
        for (const [name, value] of changes) {
          await ctx.clients.sns.send(new SetSubscriptionAttributesCommand({ SubscriptionArn: id, AttributeName: name, AttributeValue: value }));
        }
        return { message: `Updated ${changes.map(([name]) => name).join(", ")}.` };
      },
    },
    {
      id: "confirm",
      label: "Confirm subscription",
      availableFor: isPending,
      fields: [
        { name: "token", label: "Token", kind: "text", required: true, help: "The token from the confirmation message SNS sent to the endpoint (the Token field, or the token= parameter of SubscribeURL)." },
      ],
      async run(ctx, id, v) {
        const p = parsePendingId(id);
        const topicArn = p?.topicArn ?? (id.startsWith("arn:") ? id.split(":").slice(0, 6).join(":") : "");
        const r = await ctx.clients.sns.send(new ConfirmSubscriptionCommand({ TopicArn: topicArn, Token: text(v.token) }));
        return { message: `Subscription confirmed: ${r.SubscriptionArn ?? "(no ARN returned)"}` };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      if (!id.startsWith("arn:")) throw new Error("SNS can't delete a subscription that is still pending confirmation; it expires after 3 days if not confirmed.");
      await ctx.clients.sns.send(new UnsubscribeCommand({ SubscriptionArn: id }));
    },
  },
};
