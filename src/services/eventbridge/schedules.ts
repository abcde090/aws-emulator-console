/** EventBridge Scheduler: schedules (one-time, rate, cron) and schedule groups. */

import {
  CreateScheduleCommand,
  CreateScheduleGroupCommand,
  DeleteScheduleCommand,
  DeleteScheduleGroupCommand,
  GetScheduleCommand,
  GetScheduleGroupCommand,
  ListSchedulesCommand,
  ListScheduleGroupsCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateScheduleCommand,
  type FlexibleTimeWindow,
  type GetScheduleCommandOutput,
  type RetryPolicy,
  type ScheduleSummary,
  type Target,
  type UpdateScheduleCommandInput,
} from "@aws-sdk/client-scheduler";
import type { Ctx, FieldDef, FieldValues, Option, OptionsLoader, ResourceDef, Tag } from "../../console/types.ts";
import { prettyJson, sameJson } from "../../console/values.ts";
import { functionOptions, queueOptions, topicOptions } from "../sns/lookups.ts";
import { manageTagsAction } from "../../console/tags.ts";
import { secondary, unavailableText } from "../../console/secondary.ts";
import { canDisable, canEnable, isoOrNull, jsonObjectText, parseJsonText, parseScheduleExpression, parseScheduleId, scheduleExpression, scheduleId, targetType, text } from "./helpers.ts";
import { busArnOptions, roleOptions, scheduleGroupOptions, stateMachineOptions } from "./lookups.ts";

const NAME = "[0-9a-zA-Z._-]{1,64}";

async function getSchedule(ctx: Ctx, id: string): Promise<GetScheduleCommandOutput> {
  const { group, name } = parseScheduleId(id);
  return ctx.clients.scheduler.send(new GetScheduleCommand({ Name: name, GroupName: group }));
}

/** UpdateSchedule replaces the whole schedule: every edit resends the current settings with only the changes applied. */
function updateInput(s: GetScheduleCommandOutput, changes: Partial<UpdateScheduleCommandInput>): UpdateScheduleCommandInput {
  if (!s.Name || !s.ScheduleExpression || !s.Target || !s.FlexibleTimeWindow) throw new Error("Scheduler returned an incomplete schedule.");
  return {
    Name: s.Name,
    GroupName: s.GroupName,
    ScheduleExpression: s.ScheduleExpression,
    ScheduleExpressionTimezone: s.ScheduleExpressionTimezone,
    StartDate: s.StartDate,
    EndDate: s.EndDate,
    Description: s.Description,
    Target: s.Target,
    FlexibleTimeWindow: s.FlexibleTimeWindow,
    KmsKeyArn: s.KmsKeyArn,
    ActionAfterCompletion: s.ActionAfterCompletion,
    State: s.State,
    ...changes,
  };
}

async function setState(ctx: Ctx, id: string, state: "ENABLED" | "DISABLED"): Promise<void> {
  await ctx.clients.scheduler.send(new UpdateScheduleCommand(updateInput(await getSchedule(ctx, id), { State: state })));
}

const RETRY_DEFAULTS = { attempts: 185, maxAge: 86400 };

const FLEX_OPTIONS: Option[] = [
  { value: "OFF", label: "Off" }, { value: "1", label: "1 minute" }, { value: "5", label: "5 minutes" }, { value: "10", label: "10 minutes" },
  { value: "15", label: "15 minutes" }, { value: "30", label: "30 minutes" }, { value: "60", label: "1 hour" }, { value: "240", label: "4 hours" },
];

function flexValue(w: FlexibleTimeWindow | undefined): string {
  return w?.Mode === "FLEXIBLE" && w.MaximumWindowInMinutes ? String(w.MaximumWindowInMinutes) : "OFF";
}

function flexWindow(v: unknown): FlexibleTimeWindow {
  const flex = text(v);
  return flex === "OFF" || flex === "" ? { Mode: "OFF" } : { Mode: "FLEXIBLE", MaximumWindowInMinutes: Number(flex) };
}

/** Options from `load`, plus the schedule's current value (when editing) if it is no longer listed. */
function withCurrent(load: (ctx: Ctx) => Promise<Option[]>, current: (s: GetScheduleCommandOutput) => string | undefined, label: (v: string) => string = (v) => v): OptionsLoader {
  return async (ctx, id) => {
    const options = await load(ctx);
    if (!id) return options;
    const value = current(await getSchedule(ctx, id));
    return value && !options.some((o) => o.value === value) ? [{ value, label: label(value) }, ...options] : options;
  };
}

/** Schedule pattern fields, shared by Create schedule and Edit schedule. */
function patternFields(editing: boolean): FieldDef[] {
  const section = "Schedule pattern";
  return [
    {
      name: "kind", label: "Occurrence", kind: "radio", default: "at", section,
      options: [
        { value: "at", label: "One-time schedule" },
        { value: "rate", label: "Recurring schedule: rate-based" },
        { value: "cron", label: "Recurring schedule: cron-based" },
      ],
    },
    { name: "at", label: "Date and time", kind: "text", required: true, section, showIf: { field: "kind", equals: "at" }, placeholder: "2026-12-31T09:00:00", help: "yyyy-mm-ddThh:mm:ss in the time zone below." },
    { name: "rateValue", label: "Rate value", kind: "number", required: true, default: 5, section, showIf: { field: "kind", equals: "rate" }, validate: { min: 1, max: 1000000, message: "At least 1." } },
    { name: "rateUnit", label: "Rate unit", kind: "select", required: true, default: "minutes", section, showIf: { field: "kind", equals: "rate" }, options: [
      { value: "minutes", label: "minutes" }, { value: "hours", label: "hours" }, { value: "days", label: "days" },
    ] },
    { name: "cron", label: "Cron expression", kind: "text", required: true, section, showIf: { field: "kind", equals: "cron" }, placeholder: "0 12 * * ? *", help: "Six fields: minutes hours day-of-month month day-of-week year." },
    editing
      ? { name: "timezone", label: "Time zone", kind: "text", section, help: "An IANA time zone, for example UTC or Australia/Sydney. Empty means UTC." }
      : { name: "timezone", label: "Time zone", kind: "text", default: "UTC", section, help: "An IANA time zone, for example UTC or Australia/Sydney." },
    {
      name: "flex", label: "Flexible time window", kind: "select", required: true, default: "OFF", section,
      help: "Scheduler invokes the target at some point within the window after the scheduled time.",
      options: editing ? withCurrent(async () => FLEX_OPTIONS, (s) => flexValue(s.FlexibleTimeWindow), (v) => `${v} minutes`) : FLEX_OPTIONS,
    },
  ];
}

/** Payload, role, retry policy and dead-letter queue fields, shared by create and edit. */
function targetSettingsFields(editing: boolean): FieldDef[] {
  const retrySection = "Retry policy and dead-letter queue";
  return [
    { name: "input", label: "Payload (JSON)", kind: "json", section: "Target", placeholder: '{ "job": "nightly-report" }' },
    {
      name: "roleArn", label: "Execution role", kind: "select", required: true, section: "Permissions",
      options: editing ? withCurrent(roleOptions, (s) => s.Target?.RoleArn) : roleOptions,
      help: "Scheduler assumes this role to call the target. It needs the target's action (for example sqs:SendMessage).",
    },
    { name: "retries", label: "Retry attempts", kind: "number", default: RETRY_DEFAULTS.attempts, section: retrySection, validate: { min: 0, max: 185, message: "Between 0 and 185." } },
    { name: "maxAge", label: "Maximum age of event (seconds)", kind: "number", default: RETRY_DEFAULTS.maxAge, section: retrySection, validate: { min: 60, max: 86400, message: "Between 60 and 86400." } },
    { name: "dlqArn", label: "Dead-letter queue", kind: "select", section: retrySection, options: editing ? withCurrent(async (ctx) => [{ value: "", label: "None" }, ...(await queueOptions(ctx))], (s) => s.Target?.DeadLetterConfig?.Arn) : queueOptions },
    { name: "deleteAfter", label: "Delete the schedule after it completes", kind: "checkbox", default: false, section: "Schedule completion" },
    { name: "enabled", label: "Enable schedule", kind: "checkbox", default: true, section: "Schedule state" },
  ];
}

function retryPolicy(current: RetryPolicy | undefined, v: FieldValues): RetryPolicy | undefined {
  const attempts = typeof v.retries === "number" ? v.retries : undefined;
  const maxAge = typeof v.maxAge === "number" ? v.maxAge : undefined;
  // A schedule without a retry policy uses the defaults; leaving them as they are adds nothing.
  if (!current && (attempts ?? RETRY_DEFAULTS.attempts) === RETRY_DEFAULTS.attempts && (maxAge ?? RETRY_DEFAULTS.maxAge) === RETRY_DEFAULTS.maxAge) return undefined;
  return { MaximumRetryAttempts: attempts, MaximumEventAgeInSeconds: maxAge };
}

/** Current schedule settings as Edit schedule field values. */
async function scheduleValues(ctx: Ctx, id: string): Promise<FieldValues> {
  const s = await getSchedule(ctx, id);
  const p = parseScheduleExpression(s.ScheduleExpression ?? "");
  const t = s.Target;
  return {
    description: s.Description ?? "",
    kind: p.kind,
    at: p.at,
    rateValue: p.rateValue,
    rateUnit: p.rateUnit,
    cron: p.cron,
    timezone: s.ScheduleExpressionTimezone ?? "",
    flex: flexValue(s.FlexibleTimeWindow),
    input: prettyJson(t?.Input),
    roleArn: t?.RoleArn ?? "",
    retries: t?.RetryPolicy?.MaximumRetryAttempts ?? RETRY_DEFAULTS.attempts,
    maxAge: t?.RetryPolicy?.MaximumEventAgeInSeconds ?? RETRY_DEFAULTS.maxAge,
    dlqArn: t?.DeadLetterConfig?.Arn ?? "",
    deleteAfter: s.ActionAfterCompletion === "DELETE",
    enabled: s.State !== "DISABLED",
  };
}

/** Applies the Edit schedule form to the current schedule; null when nothing changed. */
function editedSchedule(s: GetScheduleCommandOutput, v: FieldValues): UpdateScheduleCommandInput | null {
  const current = s.Target as Target;
  const rawInput = typeof v.input === "string" ? v.input : "";
  const dlq = text(v.dlqArn);
  const target: Target = {
    ...current,
    RoleArn: text(v.roleArn) || current.RoleArn,
    Input: sameJson(current.Input, rawInput) ? current.Input : jsonObjectText("Payload", rawInput),
    RetryPolicy: retryPolicy(current.RetryPolicy, v),
    DeadLetterConfig: dlq ? { Arn: dlq } : undefined,
  };
  const expression = scheduleExpression(text(v.kind), v);
  const flex = flexWindow(v.flex);
  const changes: Partial<UpdateScheduleCommandInput> = {
    Description: text(v.description) || undefined,
    ScheduleExpression: expression,
    ScheduleExpressionTimezone: text(v.timezone) || undefined,
    FlexibleTimeWindow: flexValue(flex) === flexValue(s.FlexibleTimeWindow) ? s.FlexibleTimeWindow : flex,
    Target: sameJson(JSON.stringify(target), JSON.stringify(current)) ? current : target,
    ActionAfterCompletion: v.deleteAfter === true ? "DELETE" : (s.ActionAfterCompletion ?? "NONE") === "NONE" ? s.ActionAfterCompletion : "NONE",
    State: v.enabled === false ? "DISABLED" : "ENABLED",
  };
  const unchanged =
    (changes.Description ?? "") === (s.Description ?? "") &&
    expression === s.ScheduleExpression &&
    (changes.ScheduleExpressionTimezone ?? "") === (s.ScheduleExpressionTimezone ?? "") &&
    changes.FlexibleTimeWindow === s.FlexibleTimeWindow &&
    changes.Target === current &&
    changes.ActionAfterCompletion === s.ActionAfterCompletion &&
    changes.State === (s.State ?? "ENABLED");
  return unchanged ? null : updateInput(s, changes);
}

const TARGETS = [
  { value: "sqs", label: "Amazon SQS SendMessage" },
  { value: "sns", label: "Amazon SNS Publish" },
  { value: "lambda", label: "AWS Lambda Invoke" },
  { value: "sfn", label: "AWS Step Functions StartExecution" },
  { value: "bus", label: "Amazon EventBridge PutEvents" },
];

export const schedules: ResourceDef = {
  id: "schedules",
  name: "Schedules",
  singular: "schedule",
  idField: "id",
  nameField: "Schedule name",
  description: "EventBridge Scheduler invokes a target once or on a recurring schedule.",
  emptyText: "No schedules.",
  columns: [
    { key: "name", label: "Schedule name", kind: "link" },
    { key: "group", label: "Schedule group", kind: "text" },
    { key: "state", label: "Status", kind: "status" },
    { key: "target", label: "Target", kind: "text" },
    { key: "modified", label: "Last modified", kind: "date" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const out: ScheduleSummary[] = [];
    let token: string | undefined;
    do {
      const page = await ctx.clients.scheduler.send(new ListSchedulesCommand({ NextToken: token }));
      out.push(...(page.Schedules ?? []));
      token = page.NextToken;
    } while (token);
    return out
      .filter((s) => s.Name)
      .map((s) => ({
        id: scheduleId(s.GroupName ?? "default", s.Name as string),
        name: s.Name,
        group: s.GroupName ?? "default",
        state: s.State ?? null,
        target: s.Target?.Arn ? targetType(s.Target.Arn) : null,
        modified: isoOrNull(s.LastModificationDate),
        arn: s.Arn ?? null,
      }));
  },

  async get(ctx, id) {
    const s = await getSchedule(ctx, id);
    const t = s.Target;
    return {
      summary: {
        "Schedule name": s.Name ?? null,
        "Schedule group": s.GroupName ?? null,
        Status: s.State ?? null,
        ARN: s.Arn ?? null,
        Description: s.Description || "-",
        "Schedule expression": s.ScheduleExpression ?? null,
        "Time zone": s.ScheduleExpressionTimezone ?? "UTC",
        "Flexible time window": s.FlexibleTimeWindow?.Mode === "FLEXIBLE" ? `${s.FlexibleTimeWindow.MaximumWindowInMinutes ?? "-"} minutes` : "Off",
        "Action after completion": s.ActionAfterCompletion ?? "NONE",
        "Start date": isoOrNull(s.StartDate),
        "End date": isoOrNull(s.EndDate),
        Created: isoOrNull(s.CreationDate),
        "Last modified": isoOrNull(s.LastModificationDate),
      },
      tabs: [
        {
          id: "target",
          label: "Target",
          kind: "keyvalue",
          data: t
            ? {
                "Target type": t.Arn ? targetType(t.Arn) : null,
                "Target ARN": t.Arn ?? null,
                "Execution role": t.RoleArn ?? null,
                "Retry attempts": t.RetryPolicy?.MaximumRetryAttempts ?? "Default (185)",
                "Maximum age of event (seconds)": t.RetryPolicy?.MaximumEventAgeInSeconds ?? "Default (86400)",
                "Dead-letter queue": t.DeadLetterConfig?.Arn ?? "None",
              }
            : {},
          emptyText: "No target.",
        },
        { id: "input", label: "Payload", kind: "json", data: parseJsonText(t?.Input), emptyText: "No payload. The target gets an empty input." },
      ],
    };
  },

  create: {
    title: "Create schedule",
    description: "Creates a schedule with CreateSchedule. Scheduler assumes the execution role to call the target, so the role must trust scheduler.amazonaws.com and allow the target action.",
    fields: [
      { name: "name", label: "Schedule name", kind: "text", required: true, section: "Schedule name and description", validate: { pattern: NAME, message: "Up to 64 letters, numbers, . - _" } },
      { name: "description", label: "Description", kind: "text", section: "Schedule name and description" },
      { name: "group", label: "Schedule group", kind: "select", required: true, default: "default", section: "Schedule name and description", options: scheduleGroupOptions },
      ...patternFields(false),
      { name: "targetKind", label: "Target API", kind: "select", required: true, default: "sqs", section: "Target", options: TARGETS },
      { name: "target_sqs", label: "SQS queue", kind: "select", required: true, section: "Target", showIf: { field: "targetKind", equals: "sqs" }, options: queueOptions },
      { name: "target_sns", label: "SNS topic", kind: "select", required: true, section: "Target", showIf: { field: "targetKind", equals: "sns" }, options: topicOptions },
      { name: "target_lambda", label: "Lambda function", kind: "select", required: true, section: "Target", showIf: { field: "targetKind", equals: "lambda" }, options: functionOptions },
      { name: "target_sfn", label: "State machine", kind: "select", required: true, section: "Target", showIf: { field: "targetKind", equals: "sfn" }, options: stateMachineOptions },
      { name: "target_bus", label: "Event bus", kind: "select", required: true, section: "Target", showIf: { field: "targetKind", equals: "bus" }, options: busArnOptions },
      ...targetSettingsFields(false),
    ],
    async run(ctx, v) {
      const kind = text(v.kind);
      const name = text(v.name);
      const group = text(v.group) || "default";
      const targetArn = text(v[`target_${text(v.targetKind)}`]);
      if (!targetArn) throw new Error("Choose a target.");
      const dlq = text(v.dlqArn);
      const input = jsonObjectText("Payload", v.input);
      await ctx.clients.scheduler.send(
        new CreateScheduleCommand({
          Name: name,
          GroupName: group,
          Description: text(v.description) || undefined,
          ScheduleExpression: scheduleExpression(kind, v),
          ScheduleExpressionTimezone: text(v.timezone) || undefined,
          FlexibleTimeWindow: flexWindow(v.flex),
          Target: {
            Arn: targetArn,
            RoleArn: text(v.roleArn),
            Input: input,
            RetryPolicy: retryPolicy(undefined, v),
            DeadLetterConfig: dlq ? { Arn: dlq } : undefined,
            ...(text(v.targetKind) === "bus" ? { EventBridgeParameters: { Source: "scheduler.console", DetailType: "Scheduled Event" } } : {}),
          },
          ActionAfterCompletion: v.deleteAfter === true ? "DELETE" : "NONE",
          State: v.enabled === false ? "DISABLED" : "ENABLED",
        })
      );
      return scheduleId(group, name);
    },
  },

  actions: [
    {
      id: "edit",
      label: "Edit schedule",
      fields: [
        { name: "description", label: "Description", kind: "text", section: "Schedule name and description" },
        ...patternFields(true),
        ...targetSettingsFields(true),
      ],
      initialValues: scheduleValues,
      async run(ctx, id, v) {
        const update = editedSchedule(await getSchedule(ctx, id), v);
        if (!update) return { message: "No changes to save." };
        await ctx.clients.scheduler.send(new UpdateScheduleCommand(update));
        return { message: "Schedule updated." };
      },
    },
    { id: "enable", label: "Enable", availableFor: canEnable, async run(ctx, id) { await setState(ctx, id, "ENABLED"); return { message: "Schedule enabled." }; } },
    { id: "disable", label: "Disable", availableFor: canDisable, async run(ctx, id) { await setState(ctx, id, "DISABLED"); return { message: "Schedule disabled." }; } },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      const { group, name } = parseScheduleId(id);
      await ctx.clients.scheduler.send(new DeleteScheduleCommand({ Name: name, GroupName: group }));
    },
  },
};

async function groupTags(ctx: Ctx, arn: string): Promise<Tag[]> {
  const r = await ctx.clients.scheduler.send(new ListTagsForResourceCommand({ ResourceArn: arn }));
  return (r.Tags ?? []).map((t) => ({ Key: t.Key ?? "", Value: t.Value ?? "" }));
}

async function groupArn(ctx: Ctx, name: string): Promise<string> {
  const g = await ctx.clients.scheduler.send(new GetScheduleGroupCommand({ Name: name }));
  if (!g.Arn) throw new Error("Scheduler returned no ARN for this group.");
  return g.Arn;
}

export const scheduleGroups: ResourceDef = {
  id: "schedule-groups",
  name: "Schedule groups",
  singular: "schedule group",
  idField: "name",
  nameField: "Name",
  description: "Groups organise schedules; deleting a group deletes its schedules.",
  emptyText: "No schedule groups.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "state", label: "Status", kind: "status" },
    { key: "created", label: "Creation date", kind: "date" },
    { key: "arn", label: "ARN", kind: "arn" },
  ],

  async list(ctx) {
    const out = [];
    let token: string | undefined;
    do {
      const page = await ctx.clients.scheduler.send(new ListScheduleGroupsCommand({ NextToken: token }));
      for (const g of page.ScheduleGroups ?? []) out.push({ name: g.Name ?? null, state: g.State ?? null, created: isoOrNull(g.CreationDate), arn: g.Arn ?? null });
      token = page.NextToken;
    } while (token);
    return out;
  },

  async get(ctx, name) {
    const g = await ctx.clients.scheduler.send(new GetScheduleGroupCommand({ Name: name }));
    const tags = await secondary(g.Arn ? groupTags(ctx, g.Arn) : Promise.resolve([]));
    return {
      summary: { Name: g.Name ?? name, ARN: g.Arn ?? null, Status: g.State ?? null, "Creation date": isoOrNull(g.CreationDate), "Last modified": isoOrNull(g.LastModificationDate) },
      tabs: [
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
    title: "Create schedule group",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, validate: { pattern: NAME, message: "Up to 64 letters, numbers, . - _" } },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags - optional" },
    ],
    async run(ctx, v) {
      const name = text(v.name);
      const tags = Array.isArray(v.tags) ? (v.tags as Tag[]) : [];
      await ctx.clients.scheduler.send(new CreateScheduleGroupCommand({ Name: name, Tags: tags.length ? tags : undefined }));
      return name;
    },
  },

  actions: [
    manageTagsAction({
      async read(ctx, name) {
        return groupTags(ctx, await groupArn(ctx, name));
      },
      async tag(ctx, name, tags) {
        await ctx.clients.scheduler.send(new TagResourceCommand({ ResourceArn: await groupArn(ctx, name), Tags: tags }));
      },
      async untag(ctx, name, keys) {
        await ctx.clients.scheduler.send(new UntagResourceCommand({ ResourceArn: await groupArn(ctx, name), TagKeys: keys }));
      },
    }),
  ],

  delete: {
    confirmText: "name",
    async run(ctx, name) {
      if (name === "default") throw new Error("The default schedule group can't be deleted.");
      await ctx.clients.scheduler.send(new DeleteScheduleGroupCommand({ Name: name }));
    },
  },
};
