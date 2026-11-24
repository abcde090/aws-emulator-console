/**
 * AWS Fault Injection Service: experiment templates (action, target, stop condition),
 * starting experiments, and experiments with their action states.
 */

import {
  CreateExperimentTemplateCommand,
  DeleteExperimentTemplateCommand,
  GetActionCommand,
  GetExperimentCommand,
  GetExperimentTemplateCommand,
  ListActionsCommand,
  ListExperimentResolvedTargetsCommand,
  ListExperimentsCommand,
  ListExperimentTemplatesCommand,
  StartExperimentCommand,
  StopExperimentCommand,
  UpdateExperimentTemplateCommand,
  type CreateExperimentTemplateTargetInput,
  type EmptyTargetResolutionMode,
  type ExperimentSummary,
  type ExperimentTemplate,
} from "@aws-sdk/client-fis";
import { DescribeAlarmsCommand } from "@aws-sdk/client-cloudwatch";
import { ListRolesCommand } from "@aws-sdk/client-iam";
import type { Ctx, Option, ResourceDef, Row, ServiceDef } from "../../console/types.ts";
import { actionParameters, selectionMode, targetSpec } from "./helpers.ts";

async function actionOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.fis.send(new ListActionsCommand({ nextToken: token, maxResults: 100 }));
    for (const a of r.actions ?? []) if (a.id) out.push({ value: a.id, label: a.description ? `${a.id} - ${a.description}` : a.id });
    token = r.nextToken;
  } while (token);
  return out.sort((a, b) => a.value.localeCompare(b.value));
}

async function roleOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let marker: string | undefined;
  do {
    const r = await ctx.clients.iam.send(new ListRolesCommand({ Marker: marker }));
    for (const x of r.Roles ?? []) if (x.Arn) out.push({ value: x.Arn, label: x.RoleName ?? x.Arn });
    marker = r.IsTruncated ? r.Marker : undefined;
  } while (marker);
  return out;
}

async function alarmOptions(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.cloudwatch.send(new DescribeAlarmsCommand({ AlarmTypes: ["MetricAlarm", "CompositeAlarm"], NextToken: token }));
    for (const a of [...(r.MetricAlarms ?? []), ...(r.CompositeAlarms ?? [])]) if (a.AlarmArn) out.push({ value: a.AlarmArn, label: a.AlarmName ?? a.AlarmArn });
    token = r.NextToken;
  } while (token);
  return out;
}

async function getTemplate(ctx: Ctx, id: string): Promise<ExperimentTemplate> {
  const t = (await ctx.clients.fis.send(new GetExperimentTemplateCommand({ id }))).experimentTemplate;
  if (!t) throw new Error(`ResourceNotFoundException: experiment template ${id}`);
  return t;
}

const RUNNING_STATES = ["pending", "initiating", "running"];

/** IAM roles, plus the template's current role (kept selectable even if IAM no longer lists it). */
async function templateRoleOptions(ctx: Ctx, id?: string): Promise<Option[]> {
  const roles = await roleOptions(ctx);
  if (!id) return roles;
  const current = (await getTemplate(ctx, id)).roleArn;
  return current && !roles.some((r) => r.value === current) ? [...roles, { value: current, label: current }] : roles;
}

function experimentRow(e: ExperimentSummary): Row {
  return {
    id: e.id ?? "",
    template: e.experimentTemplateId ?? null,
    status: e.state?.status ?? null,
    reason: e.state?.reason ?? null,
    created: e.creationTime ?? null,
    name: e.tags?.Name ?? null,
  };
}

const EXPERIMENT_COLUMNS = [
  { key: "id", label: "Experiment ID", kind: "link" as const },
  { key: "name", label: "Name", kind: "text" as const },
  { key: "template", label: "Experiment template ID", kind: "text" as const },
  { key: "status", label: "State", kind: "status" as const },
  { key: "created", label: "Creation time", kind: "date" as const },
];

async function experiments(ctx: Ctx, templateId?: string): Promise<Row[]> {
  const rows: Row[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.fis.send(new ListExperimentsCommand({ nextToken: token, maxResults: 100, experimentTemplateId: templateId }));
    rows.push(...(r.experiments ?? []).map(experimentRow));
    token = r.nextToken;
  } while (token);
  return rows.sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

const hasTarget = { field: "targetMethod", equals: "tags" };
const byArns = { field: "targetMethod", equals: "arns" };
const byAlarm = { field: "stopSource", equals: "alarm" };

const templates: ResourceDef = {
  id: "experiment-templates",
  name: "Experiment templates",
  singular: "experiment template",
  idField: "id",
  nameField: "id",
  description: "Templates define the fault actions, the target resources and the stop conditions of an experiment.",
  emptyText: "No experiment templates. Create an experiment template to start injecting faults.",
  columns: [
    { key: "id", label: "Experiment template ID", kind: "link" },
    { key: "name", label: "Name", kind: "text" },
    { key: "description", label: "Description", kind: "text" },
    { key: "created", label: "Creation time", kind: "date" },
    { key: "updated", label: "Last update time", kind: "date" },
  ],
  async list(ctx) {
    const rows: Row[] = [];
    let token: string | undefined;
    do {
      const r = await ctx.clients.fis.send(new ListExperimentTemplatesCommand({ nextToken: token, maxResults: 100 }));
      rows.push(...(r.experimentTemplates ?? []).map((t) => ({ id: t.id ?? "", name: t.tags?.Name ?? null, description: t.description ?? null, created: t.creationTime ?? null, updated: t.lastUpdateTime ?? null })));
      token = r.nextToken;
    } while (token);
    return rows;
  },
  async get(ctx, id) {
    // The template's experiments are secondary: a denied ListExperiments marks that tab unavailable.
    const [r, runsR] = await Promise.all([
      ctx.clients.fis.send(new GetExperimentTemplateCommand({ id })),
      experiments(ctx, id).then(
        (rows) => ({ rows, error: null as string | null }),
        (err: unknown) => ({ rows: [] as Row[], error: err instanceof Error ? err.message : String(err) })
      ),
    ]);
    const runs = runsR.rows;
    const t = r.experimentTemplate;
    if (!t) throw new Error(`ResourceNotFoundException: experiment template ${id}`);
    return {
      summary: {
        "Experiment template ID": id,
        Name: t.tags?.Name ?? null,
        Description: t.description ?? null,
        "IAM role": t.roleArn ?? null,
        "Empty target resolution mode": t.experimentOptions?.emptyTargetResolutionMode ?? null,
        "Account targeting": t.experimentOptions?.accountTargeting ?? null,
        Created: t.creationTime ?? null,
        "Last updated": t.lastUpdateTime ?? null,
        ARN: t.arn ?? null,
      },
      tabs: [
        {
          id: "actions",
          label: "Actions",
          kind: "table",
          data: Object.entries(t.actions ?? {}).map(([name, a]) => ({
            name,
            action: a.actionId ?? null,
            parameters: Object.entries(a.parameters ?? {}).map(([k, v]) => `${k}=${v}`).join(", "),
            targets: Object.entries(a.targets ?? {}).map(([k, v]) => `${k}: ${v}`).join(", "),
            startAfter: (a.startAfter ?? []).join(", "),
          })),
          columns: [
            { key: "name", label: "Name", kind: "text" },
            { key: "action", label: "Action type", kind: "code" },
            { key: "parameters", label: "Parameters", kind: "code" },
            { key: "targets", label: "Target", kind: "text" },
            { key: "startAfter", label: "Start after", kind: "text" },
          ],
        },
        {
          id: "targets",
          label: "Targets",
          kind: "table",
          data: Object.entries(t.targets ?? {}).map(([name, x]) => ({
            name,
            type: x.resourceType ?? null,
            mode: x.selectionMode ?? null,
            tags: Object.entries(x.resourceTags ?? {}).map(([k, v]) => `${k}=${v}`).join(", "),
            arns: (x.resourceArns ?? []).join(", "),
          })),
          columns: [
            { key: "name", label: "Name", kind: "text" },
            { key: "type", label: "Resource type", kind: "text" },
            { key: "mode", label: "Selection mode", kind: "text" },
            { key: "tags", label: "Resource tags", kind: "text" },
            { key: "arns", label: "Resource ARNs", kind: "arn" },
          ],
          emptyText: "This template has no targets.",
        },
        {
          id: "stop",
          label: "Stop conditions",
          kind: "table",
          data: (t.stopConditions ?? []).filter((s) => s.source !== "none").map((s) => ({ source: s.source ?? null, value: s.value ?? null })),
          columns: [
            { key: "source", label: "Source", kind: "text" },
            { key: "value", label: "CloudWatch alarm", kind: "arn" },
          ],
          emptyText: "No stop conditions: the experiment runs until its actions finish or you stop it.",
        },
        { id: "experiments", label: "Experiments", kind: "table", data: runs, columns: EXPERIMENT_COLUMNS.map((c) => (c.kind === "link" ? { ...c, kind: "text" as const } : c)), emptyText: "This template has not been run.", description: runsR.error ? `Unavailable: ${runsR.error}` : undefined },
        { id: "json", label: "Template JSON", kind: "json", data: t },
      ],
    };
  },
  create: {
    title: "Create experiment template",
    description: "One action and its target. Add more actions with the AWS CLI (create-experiment-template).",
    fields: [
      { name: "name", label: "Name", kind: "text", section: "Description and name", help: "Stored as the Name tag." },
      { name: "description", label: "Description", kind: "text", required: true, section: "Description and name", validate: { max: 512, message: "Up to 512 characters." } },
      { name: "actionId", label: "Action type", kind: "select", required: true, section: "Actions", options: actionOptions },
      { name: "actionName", label: "Action name", kind: "text", required: true, default: "action1", section: "Actions", validate: { pattern: "[A-Za-z0-9_-]{1,64}", message: "Letters, numbers, - and _." } },
      { name: "actionParameters", label: "Action parameters", kind: "json", section: "Actions", default: '{\n  "duration": "PT5M"\n}', help: "JSON object of the action's parameters, e.g. {\"duration\": \"PT5M\"} for aws:fis:wait or {\"startInstancesAfterDuration\": \"PT2M\"} for aws:ec2:stop-instances." },
      {
        name: "targetMethod",
        label: "Target method",
        kind: "radio",
        section: "Targets",
        default: "tags",
        help: "Only for actions that act on resources; the resource type comes from the action.",
        options: [
          { value: "tags", label: "Resource tags" },
          { value: "arns", label: "Resource ARNs" },
          { value: "none", label: "No target (actions such as aws:fis:wait)" },
        ],
      },
      { name: "targetTags", label: "Resource tags", kind: "text", section: "Targets", showIf: hasTarget, placeholder: "chaos=ready", help: "Key=Value, several separated by commas." },
      { name: "targetArns", label: "Resource ARNs", kind: "textarea", section: "Targets", showIf: byArns, help: "One ARN per line." },
      { name: "selection", label: "Selection mode", kind: "text", section: "Targets", default: "ALL", help: "ALL, COUNT(n) or PERCENT(n)." },
      {
        name: "emptyMode",
        label: "Empty target resolution mode",
        kind: "select",
        section: "Targets",
        default: "fail",
        options: [
          { value: "fail", label: "Fail - fail the experiment if a target resolves to no resources" },
          { value: "skip", label: "Skip - skip actions whose target resolves to no resources" },
        ],
      },
      {
        name: "stopSource",
        label: "Stop conditions",
        kind: "radio",
        section: "Stop conditions",
        default: "none",
        options: [
          { value: "none", label: "None" },
          { value: "alarm", label: "Stop when a CloudWatch alarm goes to ALARM" },
        ],
      },
      { name: "alarm", label: "CloudWatch alarm", kind: "select", section: "Stop conditions", showIf: byAlarm, required: true, options: alarmOptions },
      { name: "role", label: "IAM role", kind: "select", required: true, section: "Service access", options: roleOptions, help: "The role FIS assumes to run the actions." },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const actionId = String(v.actionId);
      const action = (await ctx.clients.fis.send(new GetActionCommand({ id: actionId }))).action;
      const targetKeys = Object.entries(action?.targets ?? {});
      const method = String(v.targetMethod);
      const actionName = String(v.actionName);
      const targets: Record<string, CreateExperimentTemplateTargetInput> = {};
      const actionTargets: Record<string, string> = {};
      if (targetKeys.length > 0) {
        if (method === "none") throw new Error(`${actionId} needs a target (${targetKeys.map(([k, t]) => `${k}: ${t.resourceType}`).join(", ")}). Choose resource tags or ARNs.`);
        const [key, info] = targetKeys[0];
        const spec = targetSpec(method, String(v.targetTags ?? ""), String(v.targetArns ?? ""));
        targets[`${key}-target-1`] = { resourceType: info.resourceType ?? "", selectionMode: selectionMode(String(v.selection ?? "ALL")), ...spec };
        actionTargets[key] = `${key}-target-1`;
      }
      const tags: Record<string, string> = Object.fromEntries(((v.tags as { Key: string; Value: string }[] | null) ?? []).map((t) => [t.Key, t.Value]));
      if (typeof v.name === "string" && v.name !== "") tags.Name = v.name;
      const r = await ctx.clients.fis.send(
        new CreateExperimentTemplateCommand({
          description: String(v.description),
          roleArn: String(v.role),
          actions: { [actionName]: { actionId, parameters: actionParameters(String(v.actionParameters ?? "")), targets: Object.keys(actionTargets).length ? actionTargets : undefined } },
          targets,
          stopConditions: v.stopSource === "alarm" ? [{ source: "aws:cloudwatch:alarm", value: String(v.alarm) }] : [{ source: "none" }],
          experimentOptions: { emptyTargetResolutionMode: String(v.emptyMode ?? "fail") as EmptyTargetResolutionMode },
          tags: Object.keys(tags).length ? tags : undefined,
        })
      );
      if (!r.experimentTemplate?.id) throw new Error("FIS returned no template ID.");
      return r.experimentTemplate.id;
    },
  },
  actions: [
    {
      id: "start",
      label: "Start experiment",
      confirm: "Starts an experiment from this template. Its actions really run against the targets.",
      fields: [{ name: "name", label: "Experiment name", kind: "text", help: "Stored as the experiment's Name tag." }],
      async run(ctx, id, v) {
        const r = await ctx.clients.fis.send(new StartExperimentCommand({ experimentTemplateId: id, tags: typeof v.name === "string" && v.name !== "" ? { Name: v.name } : undefined }));
        return { message: `Started experiment ${r.experiment?.id ?? ""}: ${r.experiment?.state?.status ?? "initiating"}. See Experiments.` };
      },
    },
    {
      id: "edit",
      label: "Update description and options",
      fields: [
        { name: "description", label: "Description", kind: "text", required: true, validate: { max: 512, message: "Up to 512 characters." } },
        {
          name: "emptyMode",
          label: "Empty target resolution mode",
          kind: "select",
          required: true,
          default: "fail",
          options: [
            { value: "fail", label: "Fail - fail the experiment if a target resolves to no resources" },
            { value: "skip", label: "Skip - skip actions whose target resolves to no resources" },
          ],
        },
        { name: "role", label: "IAM role", kind: "select", required: true, options: templateRoleOptions, help: "The role FIS assumes to run the actions." },
      ],
      async initialValues(ctx, id) {
        const t = await getTemplate(ctx, id);
        return { description: t.description ?? "", emptyMode: t.experimentOptions?.emptyTargetResolutionMode ?? "fail", role: t.roleArn ?? "" };
      },
      async run(ctx, id, v) {
        const t = await getTemplate(ctx, id);
        const description = String(v.description);
        const emptyMode = String(v.emptyMode) as EmptyTargetResolutionMode;
        const role = String(v.role);
        const changed = description !== (t.description ?? "") || emptyMode !== (t.experimentOptions?.emptyTargetResolutionMode ?? "fail") || role !== (t.roleArn ?? "");
        if (!changed) return { message: "No changes: the experiment template is unchanged." };
        await ctx.clients.fis.send(
          new UpdateExperimentTemplateCommand({
            id,
            description: description !== (t.description ?? "") ? description : undefined,
            roleArn: role !== (t.roleArn ?? "") ? role : undefined,
            experimentOptions: emptyMode !== (t.experimentOptions?.emptyTargetResolutionMode ?? "fail") ? { emptyTargetResolutionMode: emptyMode } : undefined,
          })
        );
        return { message: `Experiment template ${id} updated.` };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      await ctx.clients.fis.send(new DeleteExperimentTemplateCommand({ id }));
    },
  },
};

const experimentsResource: ResourceDef = {
  id: "experiments",
  name: "Experiments",
  singular: "experiment",
  idField: "id",
  nameField: "id",
  description: "Runs of experiment templates and their state.",
  emptyText: "No experiments. Start an experiment from an experiment template.",
  columns: EXPERIMENT_COLUMNS,
  list: (ctx) => experiments(ctx),
  async get(ctx, id) {
    const [r, resolved] = await Promise.all([
      ctx.clients.fis.send(new GetExperimentCommand({ id })),
      // While FIS is still resolving targets this call fails; the tab shows why instead.
      ctx.clients.fis.send(new ListExperimentResolvedTargetsCommand({ experimentId: id })).then(
        (x) => ({ targets: x.resolvedTargets ?? [], error: null as string | null }),
        (err: unknown) => ({ targets: [], error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) })
      ),
    ]);
    const e = r.experiment;
    if (!e) throw new Error(`ResourceNotFoundException: experiment ${id}`);
    return {
      summary: {
        "Experiment ID": id,
        Name: e.tags?.Name ?? null,
        State: e.state?.status ?? null,
        "State reason": e.state?.reason ?? null,
        "Experiment template ID": e.experimentTemplateId ?? null,
        "IAM role": e.roleArn ?? null,
        "Start time": e.startTime ?? null,
        "End time": e.endTime ?? null,
        ARN: e.arn ?? null,
      },
      tabs: [
        {
          id: "actions",
          label: "Actions",
          kind: "table",
          data: Object.entries(e.actions ?? {}).map(([name, a]) => ({ name, action: a.actionId ?? null, status: a.state?.status ?? null, reason: a.state?.reason ?? null, start: a.startTime ?? null, end: a.endTime ?? null })),
          columns: [
            { key: "name", label: "Action name", kind: "text" },
            { key: "action", label: "Action type", kind: "code" },
            { key: "status", label: "State", kind: "status" },
            { key: "reason", label: "Reason", kind: "text" },
            { key: "start", label: "Start time", kind: "date" },
            { key: "end", label: "End time", kind: "date" },
          ],
        },
        {
          id: "resolved",
          label: "Resolved targets",
          kind: "table",
          data: resolved.targets.map((t) => ({ name: t.targetName ?? null, type: t.resourceType ?? null, info: JSON.stringify(t.targetInformation ?? {}) })),
          columns: [
            { key: "name", label: "Target name", kind: "text" },
            { key: "type", label: "Resource type", kind: "text" },
            { key: "info", label: "Target information", kind: "code" },
          ],
          emptyText: resolved.error ?? "No resources were resolved for this experiment.",
        },
        { id: "stop", label: "Stop conditions", kind: "json", data: e.stopConditions ?? [] },
      ],
    };
  },
  actions: [
    {
      id: "stop",
      label: "Stop experiment",
      danger: true,
      availableFor: (row) => {
        const st = row.status ?? row.State;
        return st === undefined || st === null || RUNNING_STATES.includes(String(st));
      },
      confirm: "Stops the experiment. Actions that support rollback undo their changes.",
      async run(ctx, id) {
        const r = await ctx.clients.fis.send(new StopExperimentCommand({ id }));
        return { message: `Experiment ${id} is ${r.experiment?.state?.status ?? "stopping"}.` };
      },
    },
  ],
};

export const fisService: ServiceDef = {
  id: "fis",
  name: "AWS Fault Injection Service",
  category: "Management & Governance",
  description: "Run controlled fault injection (chaos engineering) experiments to test how your workloads respond.",
  resources: [templates, experimentsResource],
  notSupported: [],
};
