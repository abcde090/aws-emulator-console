/** EventBridge event buses: default and custom, resource-based policy, send events, tags. */

import {
  CreateEventBusCommand,
  DeleteEventBusCommand,
  DescribeEventBusCommand,
  ListRulesCommand,
  ListTagsForResourceCommand,
  PutEventsCommand,
  PutPermissionCommand,
  RemovePermissionCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateEventBusCommand,
  type Rule,
} from "@aws-sdk/client-eventbridge";
import type { Ctx, ResourceDef, Tag } from "../../console/types.ts";
import { prettyJson, sameJson } from "../../console/values.ts";
import { manageTagsAction } from "../../console/tags.ts";
import { secondary, unavailableText } from "../../console/secondary.ts";
import { isoOrNull, jsonObjectText, parseJsonText, text } from "./helpers.ts";
import { busNames } from "./lookups.ts";

const BUS_NAME = "[A-Za-z0-9._-]{1,256}";

async function rulesOnBus(ctx: Ctx, name: string): Promise<Rule[]> {
  const out: Rule[] = [];
  let token: string | undefined;
  do {
    const page = await ctx.clients.eventbridge.send(new ListRulesCommand({ EventBusName: name, NextToken: token }));
    out.push(...(page.Rules ?? []));
    token = page.NextToken;
  } while (token);
  return out;
}

async function busArn(ctx: Ctx, name: string): Promise<string> {
  const bus = await ctx.clients.eventbridge.send(new DescribeEventBusCommand({ Name: name }));
  if (!bus.Arn) throw new Error("EventBridge returned no ARN for this bus.");
  return bus.Arn;
}

async function busTags(ctx: Ctx, arn: string): Promise<Tag[]> {
  const r = await ctx.clients.eventbridge.send(new ListTagsForResourceCommand({ ResourceARN: arn }));
  return (r.Tags ?? []).map((t) => ({ Key: t.Key ?? "", Value: t.Value ?? "" }));
}

export const eventBuses: ResourceDef = {
  id: "event-buses",
  name: "Event buses",
  singular: "event bus",
  idField: "name",
  nameField: "Name",
  description: "Routers that receive events and deliver them to the targets of matching rules.",
  emptyText: "No event buses.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "type", label: "Type", kind: "text" },
    { key: "arn", label: "ARN", kind: "arn" },
  ],

  async list(ctx) {
    return (await busNames(ctx)).map((b) => ({ name: b.name, arn: b.arn, type: b.name === "default" ? "Default" : b.name.startsWith("aws.partner/") ? "Partner" : "Custom" }));
  },

  async get(ctx, name) {
    const bus = await ctx.clients.eventbridge.send(new DescribeEventBusCommand({ Name: name }));
    const [rules, tags] = await Promise.all([secondary(rulesOnBus(ctx, name)), secondary(bus.Arn ? busTags(ctx, bus.Arn) : Promise.resolve([]))]);
    return {
      summary: {
        Name: bus.Name ?? name,
        ARN: bus.Arn ?? null,
        Description: bus.Description || "-",
        "Created": isoOrNull(bus.CreationTime),
        "Last modified": isoOrNull(bus.LastModifiedTime),
      },
      tabs: [
        {
          id: "rules",
          label: "Rules",
          kind: "table",
          columns: [
            { key: "name", label: "Name", kind: "text", href: "/eventbridge/rules/{arn}" },
            { key: "state", label: "Status", kind: "status" },
            { key: "type", label: "Type", kind: "text" },
            { key: "description", label: "Description", kind: "text" },
          ],
          data: rules.ok ? rules.value.map((r) => ({ name: r.Name ?? null, arn: r.Arn ?? null, state: r.State ?? null, type: r.ScheduleExpression ? "Scheduled" : "Standard", description: r.Description ?? null })) : [],
          emptyText: unavailableText(rules, "No rules on this event bus."),
        },
        {
          id: "policy",
          label: "Resource-based policy",
          kind: "json",
          data: parseJsonText(bus.Policy),
          description: "Lets other accounts or services send events to this bus.",
          emptyText: "No resource-based policy. Only this account can send events to the bus.",
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
      ],
    };
  },

  create: {
    title: "Create event bus",
    description: "Creates a custom event bus with CreateEventBus.",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, section: "Event bus detail", placeholder: "orders", help: "Up to 256 characters: letters, numbers, periods, hyphens and underscores. Can't be \"default\".", validate: { pattern: BUS_NAME, message: "Letters, numbers, . - _ only (up to 256)." } },
      { name: "description", label: "Description", kind: "text", section: "Event bus detail", validate: { max: 512, message: "At most 512 characters." } },
      { name: "policy", label: "Resource-based policy (JSON)", kind: "json", section: "Resource-based policy - optional", help: "Applied after the bus is created, with PutPermission." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags - optional" },
    ],
    async run(ctx, v) {
      const name = text(v.name);
      if (name === "default") throw new Error("\"default\" is reserved for the default event bus.");
      const tags = Array.isArray(v.tags) ? (v.tags as Tag[]) : [];
      await ctx.clients.eventbridge.send(new CreateEventBusCommand({ Name: name, Description: text(v.description) || undefined, Tags: tags.length ? tags : undefined }));
      const policy = jsonObjectText("Resource-based policy", v.policy);
      if (policy) await ctx.clients.eventbridge.send(new PutPermissionCommand({ EventBusName: name, Policy: policy }));
      return name;
    },
  },

  actions: [
    {
      id: "send-events",
      label: "Send events",
      fields: [
        { name: "source", label: "Event source", kind: "text", required: true, placeholder: "com.mycompany.orders", help: "Identifies the service that sent the event. Can't start with \"aws.\"." },
        { name: "detailType", label: "Detail type", kind: "text", required: true, placeholder: "Order Placed" },
        { name: "detail", label: "Event detail (JSON)", kind: "json", required: true, default: "{\n  \"orderId\": \"1234\"\n}" },
        { name: "resources", label: "Resources", kind: "text", help: "Comma-separated ARNs the event is about." },
      ],
      async run(ctx, name, v) {
        const r = await ctx.clients.eventbridge.send(
          new PutEventsCommand({
            Entries: [{
              EventBusName: name,
              Source: text(v.source),
              DetailType: text(v.detailType),
              Detail: jsonObjectText("Event detail", v.detail),
              Resources: text(v.resources) ? text(v.resources).split(",").map((s) => s.trim()).filter(Boolean) : undefined,
            }],
          })
        );
        const rows = (r.Entries ?? []).map((e, i) => ({ entry: i + 1, eventId: e.EventId ?? null, errorCode: e.ErrorCode ?? null, errorMessage: e.ErrorMessage ?? null }));
        return {
          message: (r.FailedEntryCount ?? 0) === 0 ? "Event sent successfully." : `${r.FailedEntryCount} event(s) failed.`,
          table: {
            rowKey: "entry",
            columns: [
              { key: "eventId", label: "Event ID", kind: "text" },
              { key: "errorCode", label: "Error code", kind: "text" },
              { key: "errorMessage", label: "Error message", kind: "text" },
            ],
            rows,
          },
        };
      },
    },
    {
      id: "edit-description",
      label: "Edit description",
      fields: [{ name: "description", label: "Description", kind: "text", help: "Leave empty to remove the description.", validate: { max: 512, message: "At most 512 characters." } }],
      async initialValues(ctx, name) {
        return { description: (await ctx.clients.eventbridge.send(new DescribeEventBusCommand({ Name: name }))).Description ?? "" };
      },
      async run(ctx, name, v) {
        const current = (await ctx.clients.eventbridge.send(new DescribeEventBusCommand({ Name: name }))).Description ?? "";
        const description = text(v.description);
        if (description === current) return { message: "No changes: the description is the same." };
        await ctx.clients.eventbridge.send(new UpdateEventBusCommand({ Name: name, Description: description }));
        return { message: "Description updated." };
      },
    },
    {
      id: "edit-policy",
      label: "Edit resource-based policy",
      fields: [{ name: "policy", label: "Resource-based policy (JSON)", kind: "json", required: true, help: "The bus's whole policy. Saving replaces it (PutPermission with Policy)." }],
      async initialValues(ctx, name) {
        return { policy: prettyJson((await ctx.clients.eventbridge.send(new DescribeEventBusCommand({ Name: name }))).Policy) };
      },
      async run(ctx, name, v) {
        const policy = jsonObjectText("Resource-based policy", v.policy);
        const current = (await ctx.clients.eventbridge.send(new DescribeEventBusCommand({ Name: name }))).Policy;
        if (sameJson(current, policy)) return { message: "No changes: the policy is the same." };
        await ctx.clients.eventbridge.send(new PutPermissionCommand({ EventBusName: name, Policy: policy }));
        return { message: "Resource-based policy updated." };
      },
    },
    {
      id: "remove-policy",
      label: "Remove resource-based policy",
      danger: true,
      confirm: "Removes every statement from this event bus's resource-based policy.",
      async run(ctx, name) {
        await ctx.clients.eventbridge.send(new RemovePermissionCommand({ EventBusName: name, RemoveAllPermissions: true }));
        return { message: "Resource-based policy removed." };
      },
    },
    manageTagsAction({
      async read(ctx, name) {
        return busTags(ctx, await busArn(ctx, name));
      },
      async tag(ctx, name, tags) {
        await ctx.clients.eventbridge.send(new TagResourceCommand({ ResourceARN: await busArn(ctx, name), Tags: tags }));
      },
      async untag(ctx, name, keys) {
        await ctx.clients.eventbridge.send(new UntagResourceCommand({ ResourceARN: await busArn(ctx, name), TagKeys: keys }));
      },
    }),
  ],

  delete: {
    confirmText: "name",
    async run(ctx, name) {
      if (name === "default") throw new Error("The default event bus can't be deleted.");
      await ctx.clients.eventbridge.send(new DeleteEventBusCommand({ Name: name }));
    },
  },
};
