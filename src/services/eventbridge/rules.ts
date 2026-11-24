/** EventBridge rules: event pattern and schedule rules, targets, test-event-pattern, enable/disable. */

import {
  DeleteRuleCommand,
  DescribeRuleCommand,
  DisableRuleCommand,
  EnableRuleCommand,
  ListRulesCommand,
  ListTagsForResourceCommand,
  ListTargetsByRuleCommand,
  PutRuleCommand,
  PutTargetsCommand,
  RemoveTargetsCommand,
  TagResourceCommand,
  TestEventPatternCommand,
  UntagResourceCommand,
  type DescribeRuleCommandOutput,
  type Rule,
  type Target,
} from "@aws-sdk/client-eventbridge";
import type { Ctx, Option, ResourceDef, Row, Tag } from "../../console/types.ts";
import { prettyJson, sameJson } from "../../console/values.ts";
import { manageTagsAction } from "../../console/tags.ts";
import { secondary, unavailableText } from "../../console/secondary.ts";
import { canDisable, canEnable, jsonObjectText, parseJsonText, parseRuleArn, patternFromForm, targetType, text } from "./helpers.ts";
import { buildTarget, busNames, busOptions, targetFields } from "./lookups.ts";

const RULE_NAME = "[A-Za-z0-9._-]{1,64}";

function ruleRef(arn: string): { bus: string; name: string } {
  const r = parseRuleArn(arn);
  if (!r) throw new Error(`Not a rule ARN: ${arn}`);
  return r;
}

async function targetsOf(ctx: Ctx, bus: string, name: string): Promise<Target[]> {
  const out: Target[] = [];
  let token: string | undefined;
  do {
    const page = await ctx.clients.eventbridge.send(new ListTargetsByRuleCommand({ Rule: name, EventBusName: bus, NextToken: token }));
    out.push(...(page.Targets ?? []));
    token = page.NextToken;
  } while (token);
  return out;
}

async function describeRule(ctx: Ctx, arn: string): Promise<DescribeRuleCommandOutput> {
  const { bus, name } = ruleRef(arn);
  return ctx.clients.eventbridge.send(new DescribeRuleCommand({ Name: name, EventBusName: bus }));
}

/** PutRule replaces the rule's settings, so an edit resends the current ones with only the user's changes. */
async function putRuleWith(ctx: Ctx, arn: string, rule: DescribeRuleCommandOutput, changes: { Description?: string; EventPattern?: string; ScheduleExpression?: string }): Promise<void> {
  const { bus, name } = ruleRef(arn);
  await ctx.clients.eventbridge.send(
    new PutRuleCommand({
      Name: name,
      EventBusName: bus,
      Description: changes.Description ?? rule.Description,
      EventPattern: changes.EventPattern ?? rule.EventPattern,
      ScheduleExpression: changes.ScheduleExpression ?? rule.ScheduleExpression,
      State: rule.State,
      RoleArn: rule.RoleArn,
    })
  );
}

async function ruleTags(ctx: Ctx, arn: string): Promise<Tag[]> {
  const r = await ctx.clients.eventbridge.send(new ListTagsForResourceCommand({ ResourceARN: arn }));
  return (r.Tags ?? []).map((t) => ({ Key: t.Key ?? "", Value: t.Value ?? "" }));
}

/** The rule's targets, for the Remove target picker. */
async function targetOptions(ctx: Ctx, arn?: string): Promise<Option[]> {
  if (!arn) return [];
  const { bus, name } = ruleRef(arn);
  return (await targetsOf(ctx, bus, name)).filter((t) => t.Id).map((t) => ({ value: t.Id as string, label: `${t.Id} (${t.Arn ? targetType(t.Arn) : "target"}: ${t.Arn ?? "-"})` }));
}

const isScheduled = (row: Row) => String(row.type ?? row.Type ?? "") === "Scheduled";

function ruleRow(r: Rule): Row {
  return {
    name: r.Name ?? null,
    arn: r.Arn ?? null,
    bus: r.EventBusName ?? "default",
    state: r.State ?? null,
    type: r.ScheduleExpression ? "Scheduled" : "Standard",
    description: r.Description ?? null,
  };
}

function describeInput(t: Target): string {
  if (t.InputTransformer) return "Input transformer";
  if (t.Input !== undefined) return "Constant (JSON text)";
  if (t.InputPath !== undefined) return `Part of the matched event (${t.InputPath})`;
  return "Matched event";
}

const SAMPLE_EVENT = `{
  "version": "0",
  "id": "6a7e8feb-b491-4cf7-a9f1-bf3703467718",
  "detail-type": "Order Placed",
  "source": "com.mycompany.orders",
  "account": "000000000000",
  "time": "2026-01-01T12:00:00Z",
  "region": "us-east-1",
  "resources": [],
  "detail": { "orderId": "1234" }
}`;

export const rules: ResourceDef = {
  id: "rules",
  name: "Rules",
  singular: "rule",
  idField: "arn",
  nameField: "Name",
  description: "Rules match incoming events (or run on a schedule) and send them to targets.",
  emptyText: "No rules. Create a rule to route events to a target.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "bus", label: "Event bus", kind: "text" },
    { key: "state", label: "Status", kind: "status" },
    { key: "type", label: "Type", kind: "text" },
    { key: "description", label: "Description", kind: "text" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const buses = await busNames(ctx);
    const rows: Row[] = [];
    for (const b of buses) {
      let token: string | undefined;
      do {
        const page = await ctx.clients.eventbridge.send(new ListRulesCommand({ EventBusName: b.name, NextToken: token }));
        rows.push(...(page.Rules ?? []).filter((r) => r.Arn).map(ruleRow));
        token = page.NextToken;
      } while (token);
    }
    return rows;
  },

  async get(ctx, arn) {
    const { bus, name } = ruleRef(arn);
    const r = await ctx.clients.eventbridge.send(new DescribeRuleCommand({ Name: name, EventBusName: bus }));
    const [targetsResult, tags] = await Promise.all([secondary(targetsOf(ctx, bus, name)), secondary(ruleTags(ctx, arn))]);
    const targets = targetsResult.ok ? targetsResult.value : [];
    return {
      summary: {
        Name: r.Name ?? name,
        "Event bus": r.EventBusName ?? bus,
        Status: r.State ?? null,
        Type: r.ScheduleExpression ? "Scheduled" : "Standard",
        "Rule ARN": r.Arn ?? arn,
        Description: r.Description || "-",
        ...(r.ScheduleExpression ? { "Schedule expression": r.ScheduleExpression } : {}),
        "Execution role": r.RoleArn ?? "-",
        "Created by": r.CreatedBy ?? null,
      },
      tabs: [
        {
          id: "targets",
          label: targetsResult.ok ? `Targets (${targets.length})` : "Targets",
          kind: "table",
          columns: [
            { key: "id", label: "Target ID", kind: "text" },
            { key: "type", label: "Type", kind: "text" },
            { key: "arn", label: "ARN", kind: "arn" },
            { key: "input", label: "Input", kind: "text" },
            { key: "detail", label: "Input value / template", kind: "code" },
            { key: "role", label: "Role", kind: "text" },
          ],
          data: targets.map((t) => ({
            id: t.Id ?? null,
            type: t.Arn ? targetType(t.Arn) : null,
            arn: t.Arn ?? null,
            input: describeInput(t),
            detail: t.InputTransformer ? `${JSON.stringify(t.InputTransformer.InputPathsMap ?? {})}\n${t.InputTransformer.InputTemplate ?? ""}` : t.Input ?? null,
            role: t.RoleArn ?? null,
          })),
          emptyText: unavailableText(targetsResult, "No targets. Use Actions > Add target."),
        },
        {
          id: "pattern",
          label: "Event pattern",
          kind: "json",
          data: parseJsonText(r.EventPattern),
          emptyText: r.ScheduleExpression ? `This rule runs on a schedule: ${r.ScheduleExpression}` : "No event pattern.",
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
    title: "Create rule",
    description: "Creates a rule with PutRule and, if you choose one, adds a target with PutTargets.",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, section: "Rule detail", placeholder: "order-placed", validate: { pattern: RULE_NAME, message: "Up to 64 letters, numbers, . - _" } },
      { name: "description", label: "Description", kind: "text", section: "Rule detail", validate: { max: 512, message: "At most 512 characters." } },
      { name: "bus", label: "Event bus", kind: "select", required: true, default: "default", section: "Rule detail", options: busOptions },
      { name: "enabled", label: "Enable the rule on the selected event bus", kind: "checkbox", default: true, section: "Rule detail" },
      {
        name: "ruleType", label: "Rule type", kind: "radio", default: "form", section: "Rule detail",
        help: "A rule with an event pattern runs when an event matches it; a schedule rule runs on a schedule (default event bus only).",
        options: [
          { value: "form", label: "Rule with an event pattern: use pattern form" },
          { value: "json", label: "Rule with an event pattern: custom pattern (JSON editor)" },
          { value: "schedule", label: "Schedule: a rule that runs on a regular schedule" },
        ],
      },
      { name: "source", label: "Event source", kind: "text", section: "Event pattern", showIf: { field: "ruleType", equals: "form" }, placeholder: "com.mycompany.orders", help: "Comma-separate several sources. AWS services use aws.<service>, for example aws.ec2." },
      { name: "detailType", label: "Event type (detail-type)", kind: "text", section: "Event pattern", showIf: { field: "ruleType", equals: "form" }, placeholder: "Order Placed", help: "Comma-separate several detail types." },
      { name: "pattern", label: "Event pattern (JSON)", kind: "json", required: true, section: "Event pattern", showIf: { field: "ruleType", equals: "json" }, default: '{\n  "source": ["com.mycompany.orders"],\n  "detail-type": ["Order Placed"]\n}' },
      { name: "schedule", label: "Schedule expression", kind: "text", required: true, section: "Schedule pattern", showIf: { field: "ruleType", equals: "schedule" }, placeholder: "rate(5 minutes)", help: "rate(value unit), for example rate(5 minutes), or cron(minutes hours day-of-month month day-of-week year), for example cron(0 12 * * ? *).", validate: { pattern: "(rate|cron)\\(.+\\)", message: "Use rate(...) or cron(...)." } },
      ...targetFields("Target - optional", true),
      { name: "tags", label: "Tags", kind: "tags", section: "Tags - optional" },
    ],
    async run(ctx, v) {
      const name = text(v.name);
      const bus = text(v.bus) || "default";
      const scheduled = v.ruleType === "schedule";
      if (scheduled && bus !== "default") throw new Error("Schedule rules can only be created on the default event bus.");
      const pattern = scheduled ? undefined : v.ruleType === "json" ? jsonObjectText("Event pattern", v.pattern) : patternFromForm(text(v.source), text(v.detailType));
      const tags = Array.isArray(v.tags) ? (v.tags as Tag[]) : [];
      const target = buildTarget(v, "Target0");
      const r = await ctx.clients.eventbridge.send(
        new PutRuleCommand({
          Name: name,
          EventBusName: bus,
          Description: text(v.description) || undefined,
          EventPattern: pattern,
          ScheduleExpression: scheduled ? text(v.schedule) : undefined,
          State: v.enabled === false ? "DISABLED" : "ENABLED",
          Tags: tags.length ? tags : undefined,
        })
      );
      if (!r.RuleArn) throw new Error("EventBridge returned no rule ARN.");
      if (target) {
        const t = await ctx.clients.eventbridge.send(new PutTargetsCommand({ Rule: name, EventBusName: bus, Targets: [target] }));
        if (t.FailedEntryCount) throw new Error(`The rule was created, but the target failed: ${(t.FailedEntries ?? []).map((f) => `${f.ErrorCode}: ${f.ErrorMessage}`).join("; ")}`);
      }
      return r.RuleArn;
    },
  },

  actions: [
    {
      id: "enable",
      label: "Enable",
      availableFor: canEnable,
      async run(ctx, arn) {
        const { bus, name } = ruleRef(arn);
        await ctx.clients.eventbridge.send(new EnableRuleCommand({ Name: name, EventBusName: bus }));
        return { message: `Rule ${name} enabled.` };
      },
    },
    {
      id: "disable",
      label: "Disable",
      availableFor: canDisable,
      confirm: "A disabled rule stops sending events to its targets.",
      async run(ctx, arn) {
        const { bus, name } = ruleRef(arn);
        await ctx.clients.eventbridge.send(new DisableRuleCommand({ Name: name, EventBusName: bus }));
        return { message: `Rule ${name} disabled.` };
      },
    },
    {
      id: "test-pattern",
      label: "Test event pattern",
      fields: [{ name: "event", label: "Sample event (JSON)", kind: "json", required: true, default: SAMPLE_EVENT, help: "A full event, including id, account, source, time, region, resources, detail-type and detail." }],
      async run(ctx, arn, v) {
        const { bus, name } = ruleRef(arn);
        const rule = await ctx.clients.eventbridge.send(new DescribeRuleCommand({ Name: name, EventBusName: bus }));
        if (!rule.EventPattern) throw new Error("This rule has no event pattern to test (it is a schedule rule).");
        const r = await ctx.clients.eventbridge.send(new TestEventPatternCommand({ EventPattern: rule.EventPattern, Event: jsonObjectText("Sample event", v.event) }));
        return { message: r.Result ? "Sample event matched the event pattern." : "Sample event did not match the event pattern." };
      },
    },
    {
      id: "edit-description",
      label: "Edit description",
      fields: [{ name: "description", label: "Description", kind: "text", help: "Leave empty to remove the description.", validate: { max: 512, message: "At most 512 characters." } }],
      async initialValues(ctx, arn) {
        return { description: (await describeRule(ctx, arn)).Description ?? "" };
      },
      async run(ctx, arn, v) {
        const r = await describeRule(ctx, arn);
        const description = text(v.description);
        if (description === (r.Description ?? "")) return { message: "No changes: the description is the same." };
        await putRuleWith(ctx, arn, r, { Description: description });
        return { message: "Description updated." };
      },
    },
    {
      id: "edit-schedule",
      label: "Edit schedule expression",
      availableFor: isScheduled,
      fields: [{ name: "schedule", label: "Schedule expression", kind: "text", required: true, help: "rate(value unit), for example rate(5 minutes), or cron(minutes hours day-of-month month day-of-week year).", validate: { pattern: "(rate|cron)\\(.+\\)", message: "Use rate(...) or cron(...)." } }],
      async initialValues(ctx, arn) {
        return { schedule: (await describeRule(ctx, arn)).ScheduleExpression ?? "" };
      },
      async run(ctx, arn, v) {
        const r = await describeRule(ctx, arn);
        if (!r.ScheduleExpression) throw new Error("This rule has an event pattern, not a schedule.");
        const schedule = text(v.schedule);
        if (schedule === r.ScheduleExpression) return { message: "No changes: the schedule is the same." };
        await putRuleWith(ctx, arn, r, { ScheduleExpression: schedule });
        return { message: `Schedule changed to ${schedule}.` };
      },
    },
    {
      id: "edit-pattern",
      label: "Edit event pattern",
      availableFor: (row) => !isScheduled(row),
      fields: [{ name: "pattern", label: "Event pattern (JSON)", kind: "json", required: true, help: "The rule's whole event pattern. Saving replaces it (PutRule)." }],
      async initialValues(ctx, arn) {
        return { pattern: prettyJson((await describeRule(ctx, arn)).EventPattern) };
      },
      async run(ctx, arn, v) {
        const rule = await describeRule(ctx, arn);
        if (rule.ScheduleExpression) throw new Error("This is a schedule rule; it has no event pattern.");
        const pattern = jsonObjectText("Event pattern", v.pattern);
        if (sameJson(rule.EventPattern, pattern)) return { message: "No changes: the event pattern is the same." };
        await putRuleWith(ctx, arn, rule, { EventPattern: pattern });
        return { message: "Event pattern updated." };
      },
    },
    {
      id: "add-target",
      label: "Add target",
      fields: [
        { name: "targetId", label: "Target ID", kind: "text", required: true, help: "Unique within the rule.", validate: { pattern: "[A-Za-z0-9._-]{1,64}", message: "Up to 64 letters, numbers, . - _" } },
        ...targetFields("Target", false),
      ],
      async run(ctx, arn, v) {
        const { bus, name } = ruleRef(arn);
        const target = buildTarget(v, text(v.targetId));
        if (!target) throw new Error("Choose a target.");
        const r = await ctx.clients.eventbridge.send(new PutTargetsCommand({ Rule: name, EventBusName: bus, Targets: [target] }));
        if (r.FailedEntryCount) throw new Error((r.FailedEntries ?? []).map((f) => `${f.ErrorCode}: ${f.ErrorMessage}`).join("; "));
        return { message: `Target ${target.Id} added.` };
      },
    },
    {
      id: "remove-target",
      label: "Remove target",
      danger: true,
      fields: [{ name: "targetId", label: "Target", kind: "select", required: true, options: targetOptions, help: "One of this rule's targets (Targets tab)." }],
      async run(ctx, arn, v) {
        const { bus, name } = ruleRef(arn);
        const r = await ctx.clients.eventbridge.send(new RemoveTargetsCommand({ Rule: name, EventBusName: bus, Ids: [text(v.targetId)] }));
        if (r.FailedEntryCount) throw new Error((r.FailedEntries ?? []).map((f) => `${f.ErrorCode}: ${f.ErrorMessage}`).join("; "));
        return { message: `Target ${text(v.targetId)} removed.` };
      },
    },
    manageTagsAction({
      read: ruleTags,
      async tag(ctx, arn, tags) {
        await ctx.clients.eventbridge.send(new TagResourceCommand({ ResourceARN: arn, Tags: tags }));
      },
      async untag(ctx, arn, keys) {
        await ctx.clients.eventbridge.send(new UntagResourceCommand({ ResourceARN: arn, TagKeys: keys }));
      },
    }),
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, arn) {
      const { bus, name } = ruleRef(arn);
      // EventBridge refuses to delete a rule that still has targets; the console removes them first.
      const ids = (await targetsOf(ctx, bus, name)).map((t) => t.Id).filter((id): id is string => Boolean(id));
      if (ids.length) await ctx.clients.eventbridge.send(new RemoveTargetsCommand({ Rule: name, EventBusName: bus, Ids: ids }));
      await ctx.clients.eventbridge.send(new DeleteRuleCommand({ Name: name, EventBusName: bus }));
    },
  },
};
