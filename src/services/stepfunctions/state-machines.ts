/** AWS Step Functions state machines: create (ASL editor, role, type, logging), start executions. */

import {
  CreateStateMachineCommand,
  DeleteStateMachineCommand,
  DescribeStateMachineCommand,
  ListStateMachinesCommand,
  ListStateMachineVersionsCommand,
  ListTagsForResourceCommand,
  PublishStateMachineVersionCommand,
  StartExecutionCommand,
  StartSyncExecutionCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateStateMachineCommand,
  ValidateStateMachineDefinitionCommand,
  type DescribeStateMachineCommandOutput,
  type LogLevel,
  type LoggingConfiguration,
  type StateMachineListItem,
  type StateMachineVersionListItem,
  type UpdateStateMachineCommandInput,
} from "@aws-sdk/client-sfn";
import { DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import type { Ctx, FieldValues, Option, OptionsLoader, ResourceDef, Tag } from "../../console/types.ts";
import { roleOptions } from "../eventbridge/lookups.ts";
import { manageTagsAction } from "../../console/tags.ts";
import { secondary, unavailableText } from "../../console/secondary.ts";
import { HELLO_WORLD, isoOrNull, parseJsonText, statesOf, text } from "./helpers.ts";

const NAME = "[A-Za-z0-9_-]{1,80}";

export async function listStateMachines(ctx: Ctx): Promise<StateMachineListItem[]> {
  const out: StateMachineListItem[] = [];
  let token: string | undefined;
  do {
    const page = await ctx.clients.sfn.send(new ListStateMachinesCommand({ nextToken: token }));
    out.push(...(page.stateMachines ?? []));
    token = page.nextToken;
  } while (token);
  return out;
}

async function logGroupOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const page = await ctx.clients.logs.send(new DescribeLogGroupsCommand({ nextToken: token }));
    for (const g of page.logGroups ?? []) if (g.arn && g.logGroupName) out.push({ value: g.arn.endsWith(":*") ? g.arn : `${g.arn}:*`, label: g.logGroupName });
    token = page.nextToken;
  } while (token);
  return out;
}

async function describe(ctx: Ctx, arn: string): Promise<DescribeStateMachineCommandOutput> {
  return ctx.clients.sfn.send(new DescribeStateMachineCommand({ stateMachineArn: arn }));
}

async function versionsOf(ctx: Ctx, arn: string): Promise<StateMachineVersionListItem[]> {
  const out: StateMachineVersionListItem[] = [];
  let token: string | undefined;
  do {
    const page = await ctx.clients.sfn.send(new ListStateMachineVersionsCommand({ stateMachineArn: arn, nextToken: token }));
    out.push(...(page.stateMachineVersions ?? []));
    token = page.nextToken;
  } while (token);
  return out;
}

async function machineTags(ctx: Ctx, arn: string): Promise<Tag[]> {
  const r = await ctx.clients.sfn.send(new ListTagsForResourceCommand({ resourceArn: arn }));
  return (r.tags ?? []).map((t) => ({ Key: t.key ?? "", Value: t.value ?? "" }));
}

/** Options from `load`, plus the state machine's current value (when editing) if it is no longer listed. */
function withCurrent(load: (ctx: Ctx) => Promise<Option[]>, current: (d: DescribeStateMachineCommandOutput) => string | undefined): OptionsLoader {
  return async (ctx, id) => {
    const options = await load(ctx);
    if (!id) return options;
    const value = current(await describe(ctx, id));
    return value && !options.some((o) => o.value === value) ? [{ value, label: value }, ...options] : options;
  };
}

const logGroupOf = (log: LoggingConfiguration | undefined) => log?.destinations?.[0]?.cloudWatchLogsLogGroup?.logGroupArn ?? "";

const LOG_LEVELS = [{ value: "OFF", label: "OFF" }, { value: "ALL", label: "ALL" }, { value: "ERROR", label: "ERROR" }, { value: "FATAL", label: "FATAL" }];

/** Builds the logging configuration from the form; throws when a level needs a log group. */
function loggingFrom(v: FieldValues): LoggingConfiguration {
  const level = text(v.logLevel) || "OFF";
  if (level === "OFF") return { level: "OFF" };
  const group = text(v.logGroup);
  if (!group) throw new Error("Choose a log group, or set the log level to OFF.");
  return { level: level as LogLevel, includeExecutionData: v.includeData === true, destinations: [{ cloudWatchLogsLogGroup: { logGroupArn: group } }] };
}

function sameLogging(a: LoggingConfiguration | undefined, b: LoggingConfiguration): boolean {
  const level = a?.level ?? "OFF";
  if (level !== b.level) return false;
  return level === "OFF" || (Boolean(a?.includeExecutionData) === Boolean(b.includeExecutionData) && logGroupOf(a) === logGroupOf(b));
}

/** Runs ValidateStateMachineDefinition and turns its diagnostics into one error. */
export async function validateDefinition(ctx: Ctx, definition: string, type?: "STANDARD" | "EXPRESS"): Promise<void> {
  const r = await ctx.clients.sfn.send(new ValidateStateMachineDefinitionCommand({ definition, type }));
  const errors = (r.diagnostics ?? []).filter((d) => d.severity === "ERROR");
  if (r.result === "FAIL" || errors.length) {
    throw new Error(`The definition is not valid: ${errors.map((d) => `${d.code ?? "ERROR"} at ${d.location ?? "/"}: ${d.message ?? ""}`).join("; ")}`);
  }
}

export const stateMachines: ResourceDef = {
  id: "state-machines",
  name: "State machines",
  singular: "state machine",
  idField: "arn",
  nameField: "Name",
  description: "Workflows defined in Amazon States Language.",
  emptyText: "No state machines. Create a state machine to get started.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "type", label: "Type", kind: "text" },
    { key: "created", label: "Creation date", kind: "date" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    return (await listStateMachines(ctx)).map((s) => ({ name: s.name ?? null, arn: s.stateMachineArn ?? null, type: s.type === "EXPRESS" ? "Express" : "Standard", created: isoOrNull(s.creationDate) }));
  },

  async get(ctx, arn) {
    const d = await describe(ctx, arn);
    const [tags, versions] = await Promise.all([secondary(machineTags(ctx, arn)), secondary(versionsOf(ctx, arn))]);
    const log = d.loggingConfiguration;
    return {
      summary: {
        Name: d.name ?? null,
        ARN: d.stateMachineArn ?? arn,
        Type: d.type === "EXPRESS" ? "Express" : "Standard",
        Status: d.status ?? null,
        "IAM role ARN": d.roleArn ?? null,
        "Creation date": isoOrNull(d.creationDate),
        Description: d.description || "-",
        "X-Ray tracing": d.tracingConfiguration?.enabled ? "Enabled" : "Disabled",
      },
      tabs: [
        {
          id: "states",
          label: "States",
          kind: "table",
          columns: [
            { key: "name", label: "State", kind: "text" },
            { key: "type", label: "Type", kind: "text" },
            { key: "next", label: "Next", kind: "text" },
          ],
          data: statesOf(d.definition),
          description: "The top-level states of the definition and where each one goes next.",
          emptyText: "The definition has no states.",
        },
        { id: "definition", label: "Definition", kind: "json", data: parseJsonText(d.definition), emptyText: "No definition returned." },
        {
          id: "logging",
          label: "Logging",
          kind: "keyvalue",
          data: {
            "Log level": log?.level ?? "OFF",
            "Include execution data": log?.includeExecutionData ? "Yes" : "No",
            "Log group": log?.destinations?.[0]?.cloudWatchLogsLogGroup?.logGroupArn ?? "-",
          },
        },
        {
          id: "versions",
          label: "Versions",
          kind: "table",
          columns: [
            { key: "arn", label: "Version ARN", kind: "arn" },
            { key: "created", label: "Creation date", kind: "date" },
          ],
          data: versions.ok ? versions.value.map((v) => ({ arn: v.stateMachineVersionArn ?? null, created: isoOrNull(v.creationDate) })) : [],
          emptyText: unavailableText(versions, "No published versions. Use Actions > Publish version."),
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
    title: "Create state machine",
    description: "Validates the definition with ValidateStateMachineDefinition, then creates the state machine with CreateStateMachine.",
    fields: [
      { name: "name", label: "State machine name", kind: "text", required: true, section: "Details", placeholder: "MyStateMachine", validate: { pattern: NAME, message: "Up to 80 letters, numbers, hyphens or underscores." } },
      {
        name: "type", label: "State machine type", kind: "radio", default: "STANDARD", section: "Details",
        help: "You can't change the type after the state machine is created.",
        options: [
          { value: "STANDARD", label: "Standard: durable, exactly-once workflow execution, up to one year, full execution history" },
          { value: "EXPRESS", label: "Express: high-volume, at-least-once, up to five minutes; history goes to CloudWatch Logs only" },
        ],
      },
      { name: "definition", label: "Definition (Amazon States Language)", kind: "json", required: true, default: HELLO_WORLD, section: "Definition", help: "The workflow in Amazon States Language (JSON)." },
      { name: "roleArn", label: "Execution role", kind: "select", required: true, section: "Permissions", options: roleOptions, help: "Step Functions assumes this role to call other services. Its trust policy must allow states.amazonaws.com." },
      {
        name: "logLevel", label: "Log level", kind: "select", required: true, default: "OFF", section: "Logging", options: LOG_LEVELS,
        help: "Writes execution history events to CloudWatch Logs. The execution role needs CloudWatch Logs permissions.",
      },
      { name: "logGroup", label: "Log group", kind: "select", required: true, section: "Logging", options: logGroupOptions, showIf: { field: "logLevel", equals: ["ALL", "ERROR", "FATAL"] } },
      { name: "includeData", label: "Include execution data", kind: "checkbox", default: false, section: "Logging", help: "Log state input and output too.", showIf: { field: "logLevel", equals: ["ALL", "ERROR", "FATAL"] } },
      { name: "tracing", label: "Enable X-Ray tracing", kind: "checkbox", default: false, section: "Additional configuration" },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags - optional" },
    ],
    async run(ctx, v) {
      const definition = String(v.definition ?? "");
      const type = v.type === "EXPRESS" ? "EXPRESS" : "STANDARD";
      await validateDefinition(ctx, definition, type);
      const logging = loggingFrom(v);
      const tags = Array.isArray(v.tags) ? (v.tags as Tag[]) : [];
      const r = await ctx.clients.sfn.send(
        new CreateStateMachineCommand({
          name: text(v.name),
          type,
          definition,
          roleArn: text(v.roleArn),
          loggingConfiguration: logging.level === "OFF" ? undefined : logging,
          tracingConfiguration: v.tracing === true ? { enabled: true } : undefined,
          tags: tags.length ? tags.map((t) => ({ key: t.Key, value: t.Value })) : undefined,
        })
      );
      if (!r.stateMachineArn) throw new Error("Step Functions returned no state machine ARN.");
      return r.stateMachineArn;
    },
  },

  actions: [
    {
      id: "validate-definition",
      label: "Validate definition",
      hidden: true,
      fields: [{ name: "definition", label: "Definition", kind: "json", required: true }],
      async run(ctx, arn, v) {
        const d = await ctx.clients.sfn.send(new DescribeStateMachineCommand({ stateMachineArn: arn }));
        await validateDefinition(ctx, String(v.definition ?? ""), d.type === "EXPRESS" ? "EXPRESS" : "STANDARD");
        return { message: "The definition is valid (ValidateStateMachineDefinition returned OK)." };
      },
    },
    {
      id: "update-definition",
      label: "Save definition",
      hidden: true,
      fields: [{ name: "definition", label: "Definition", kind: "json", required: true }],
      async run(ctx, arn, v) {
        const definition = String(v.definition ?? "");
        const d = await ctx.clients.sfn.send(new DescribeStateMachineCommand({ stateMachineArn: arn }));
        await validateDefinition(ctx, definition, d.type === "EXPRESS" ? "EXPRESS" : "STANDARD");
        const r = await ctx.clients.sfn.send(new UpdateStateMachineCommand({ stateMachineArn: arn, definition }));
        return { message: `Definition saved. Revision ${r.revisionId ?? "-"}, updated ${isoOrNull(r.updateDate) ?? "-"}.` };
      },
    },
    {
      id: "start-execution",
      label: "Start execution",
      fields: [
        { name: "name", label: "Name", kind: "text", help: "Leave empty for a generated ID. Names are unique per state machine for 90 days.", validate: { pattern: NAME, message: "Up to 80 letters, numbers, hyphens or underscores." } },
        { name: "input", label: "Input (JSON)", kind: "json", default: '{\n  "Comment": "Insert your JSON here"\n}' },
      ],
      async run(ctx, arn, v) {
        const input = typeof v.input === "string" && v.input.trim() ? v.input : "{}";
        const d = await ctx.clients.sfn.send(new DescribeStateMachineCommand({ stateMachineArn: arn }));
        if (d.type === "EXPRESS") {
          const r = await ctx.clients.sfn.send(new StartSyncExecutionCommand({ stateMachineArn: arn, name: text(v.name) || undefined, input }));
          return {
            message: `Express execution finished with status ${r.status ?? "-"} (run synchronously with StartSyncExecution; Express executions have no stored history).`,
            json: { executionArn: r.executionArn, status: r.status, output: parseJsonText(r.output), error: r.error, cause: r.cause },
          };
        }
        const r = await ctx.clients.sfn.send(new StartExecutionCommand({ stateMachineArn: arn, name: text(v.name) || undefined, input }));
        return { message: `Execution started. Open the Executions tab (refresh) to follow it. ARN: ${r.executionArn ?? "-"}`, json: { executionArn: r.executionArn, startDate: isoOrNull(r.startDate) } };
      },
    },
    {
      id: "publish-version",
      label: "Publish version",
      fields: [{ name: "description", label: "Version description", kind: "text" }],
      async run(ctx, arn, v) {
        const r = await ctx.clients.sfn.send(new PublishStateMachineVersionCommand({ stateMachineArn: arn, description: text(v.description) || undefined }));
        return { message: `Published version ${r.stateMachineVersionArn ?? "-"}.` };
      },
    },
    {
      id: "edit-config",
      label: "Edit configuration",
      fields: [
        { name: "roleArn", label: "Execution role", kind: "select", required: true, section: "Permissions", options: withCurrent(roleOptions, (d) => d.roleArn), help: "Step Functions assumes this role to call other services." },
        { name: "logLevel", label: "Log level", kind: "select", required: true, default: "OFF", section: "Logging", options: LOG_LEVELS },
        { name: "logGroup", label: "Log group", kind: "select", required: true, section: "Logging", options: withCurrent(logGroupOptions, (d) => logGroupOf(d.loggingConfiguration) || undefined), showIf: { field: "logLevel", equals: ["ALL", "ERROR", "FATAL"] } },
        { name: "includeData", label: "Include execution data", kind: "checkbox", default: false, section: "Logging", showIf: { field: "logLevel", equals: ["ALL", "ERROR", "FATAL"] } },
        { name: "tracing", label: "Enable X-Ray tracing", kind: "checkbox", default: false, section: "Additional configuration" },
      ],
      async initialValues(ctx, arn) {
        const d = await describe(ctx, arn);
        const log = d.loggingConfiguration;
        return {
          roleArn: d.roleArn ?? "",
          logLevel: log?.level ?? "OFF",
          logGroup: logGroupOf(log),
          includeData: log?.includeExecutionData === true,
          tracing: d.tracingConfiguration?.enabled === true,
        };
      },
      async run(ctx, arn, v) {
        const d = await describe(ctx, arn);
        // UpdateStateMachine changes only what it is sent, so only changed settings are sent.
        const update: UpdateStateMachineCommandInput = { stateMachineArn: arn };
        const role = text(v.roleArn);
        if (role && role !== d.roleArn) update.roleArn = role;
        const logging = loggingFrom(v);
        if (!sameLogging(d.loggingConfiguration, logging)) update.loggingConfiguration = logging;
        const tracing = v.tracing === true;
        if (tracing !== (d.tracingConfiguration?.enabled === true)) update.tracingConfiguration = { enabled: tracing };
        const changed = Object.keys(update).filter((k) => k !== "stateMachineArn");
        if (!changed.length) return { message: "No changes to save." };
        await ctx.clients.sfn.send(new UpdateStateMachineCommand(update));
        return { message: `Updated ${changed.join(", ")}.` };
      },
    },
    manageTagsAction({
      read: machineTags,
      async tag(ctx, arn, tags) {
        await ctx.clients.sfn.send(new TagResourceCommand({ resourceArn: arn, tags: tags.map((t) => ({ key: t.Key, value: t.Value })) }));
      },
      async untag(ctx, arn, keys) {
        await ctx.clients.sfn.send(new UntagResourceCommand({ resourceArn: arn, tagKeys: keys }));
      },
    }),
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, arn) {
      await ctx.clients.sfn.send(new DeleteStateMachineCommand({ stateMachineArn: arn }));
    },
  },
};
