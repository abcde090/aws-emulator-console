/** Live options for EventBridge and Scheduler forms, and the shared target fields. */

import { ListArchivesCommand, ListEventBusesCommand, type Target } from "@aws-sdk/client-eventbridge";
import { ListRolesCommand } from "@aws-sdk/client-iam";
import { ListScheduleGroupsCommand } from "@aws-sdk/client-scheduler";
import { ListStateMachinesCommand } from "@aws-sdk/client-sfn";
import type { Ctx, FieldDef, FieldValues, Option } from "../../console/types.ts";
import { functionOptions, queueOptions, topicOptions } from "../sns/lookups.ts";
import { jsonObjectText, parseInputPaths, text } from "./helpers.ts";

export async function busNames(ctx: Ctx): Promise<{ name: string; arn: string }[]> {
  const out: { name: string; arn: string }[] = [];
  let token: string | undefined;
  do {
    const page = await ctx.clients.eventbridge.send(new ListEventBusesCommand({ NextToken: token }));
    for (const b of page.EventBuses ?? []) if (b.Name && b.Arn) out.push({ name: b.Name, arn: b.Arn });
    token = page.NextToken;
  } while (token);
  return out;
}

export async function busOptions(ctx: Ctx): Promise<Option[]> {
  return (await busNames(ctx)).map((b) => ({ value: b.name, label: b.name }));
}

export async function busArnOptions(ctx: Ctx): Promise<Option[]> {
  return (await busNames(ctx)).map((b) => ({ value: b.arn, label: b.name }));
}

export async function archiveOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const page = await ctx.clients.eventbridge.send(new ListArchivesCommand({ NextToken: token }));
    for (const a of page.Archives ?? []) if (a.ArchiveName) out.push({ value: a.ArchiveName, label: a.ArchiveName });
    token = page.NextToken;
  } while (token);
  return out;
}

export async function stateMachineOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const page = await ctx.clients.sfn.send(new ListStateMachinesCommand({ nextToken: token }));
    for (const s of page.stateMachines ?? []) if (s.stateMachineArn) out.push({ value: s.stateMachineArn, label: s.name ?? s.stateMachineArn });
    token = page.nextToken;
  } while (token);
  return out;
}

export async function roleOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let marker: string | undefined;
  do {
    const page = await ctx.clients.iam.send(new ListRolesCommand({ Marker: marker }));
    for (const r of page.Roles ?? []) if (r.Arn) out.push({ value: r.Arn, label: r.RoleName ?? r.Arn });
    marker = page.IsTruncated ? page.Marker : undefined;
  } while (marker);
  return out;
}

export async function scheduleGroupOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const page = await ctx.clients.scheduler.send(new ListScheduleGroupsCommand({ NextToken: token }));
    for (const g of page.ScheduleGroups ?? []) if (g.Name) out.push({ value: g.Name, label: g.Name });
    token = page.NextToken;
  } while (token);
  return out;
}

const KINDS = [
  { value: "sqs", label: "SQS queue" },
  { value: "sns", label: "SNS topic" },
  { value: "lambda", label: "Lambda function" },
  { value: "sfn", label: "Step Functions state machine" },
  { value: "bus", label: "EventBridge event bus" },
];

/** Target picker fields. `withNone` adds "No target" for rule creation. */
export function targetFields(section: string, withNone: boolean): FieldDef[] {
  const pick = (kind: string, label: string, options: FieldDef["options"], help: string): FieldDef => ({
    name: `target_${kind}`, label, kind: "select", required: true, section, showIf: { field: "targetKind", equals: kind }, options, help,
  });
  return [
    {
      name: "targetKind", label: "Target type", kind: "select", required: true, default: withNone ? "none" : "sqs", section,
      options: withNone ? [{ value: "none", label: "No target (add targets later)" }, ...KINDS] : KINDS,
      help: "The AWS service that receives matched events.",
    },
    pick("sqs", "Queue", queueOptions, "The queue's access policy must allow events.amazonaws.com to call sqs:SendMessage."),
    pick("sns", "Topic", topicOptions, "The topic's access policy must allow events.amazonaws.com to call sns:Publish."),
    pick("lambda", "Function", functionOptions, "The function's resource policy must allow events.amazonaws.com to invoke it."),
    pick("sfn", "State machine", stateMachineOptions, "Needs an execution role that EventBridge can assume and that allows states:StartExecution."),
    pick("bus", "Event bus", busArnOptions, "Sends the event to another event bus. Needs an execution role that allows events:PutEvents."),
    { name: "targetRoleArn", label: "Execution role", kind: "select", section, options: roleOptions, help: "The IAM role EventBridge assumes to call the target. Required for Step Functions and event bus targets; its trust policy must allow events.amazonaws.com." },
    {
      name: "inputMode", label: "Configure target input", kind: "radio", default: "matched", section,
      options: [
        { value: "matched", label: "Matched events" },
        { value: "constant", label: "Constant (JSON text)" },
        { value: "transformer", label: "Input transformer" },
      ],
    },
    { name: "constantInput", label: "Constant input (JSON)", kind: "json", section, showIf: { field: "inputMode", equals: "constant" }, required: true, placeholder: '{ "action": "refresh" }' },
    { name: "inputPaths", label: "Input path", kind: "json", section, showIf: { field: "inputMode", equals: "transformer" }, placeholder: '{ "source": "$.source", "id": "$.detail.id" }', help: "Names mapped to JSONPath expressions in the event." },
    { name: "inputTemplate", label: "Template", kind: "textarea", required: true, section, showIf: { field: "inputMode", equals: "transformer" }, placeholder: '"Order <id> came from <source>"', help: "The text or JSON sent to the target; use <name> for values from the input path." },
  ];
}

/** Builds a PutTargets entry from targetFields values; null when "No target" was chosen. */
export function buildTarget(v: FieldValues, id: string): Target | null {
  const kind = text(v.targetKind);
  if (kind === "none" || kind === "") return null;
  const arn = text(v[`target_${kind}`]);
  if (!arn) throw new Error("Choose the target resource.");
  const role = text(v.targetRoleArn);
  if ((kind === "sfn" || kind === "bus") && !role) throw new Error("Choose an execution role for this target type.");
  const target: Target = { Id: id, Arn: arn, RoleArn: role || undefined };
  if (v.inputMode === "constant") target.Input = jsonObjectText("Constant input", v.constantInput);
  if (v.inputMode === "transformer") {
    const template = typeof v.inputTemplate === "string" ? v.inputTemplate : "";
    if (!template.trim()) throw new Error("Enter an input template.");
    target.InputTransformer = { InputPathsMap: parseInputPaths(v.inputPaths), InputTemplate: template };
  }
  return target;
}
