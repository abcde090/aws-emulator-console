/**
 * AWS CloudFormation: stacks, StackSets and exports. Stack create and change set create are
 * hand-built wizards (src/app/cloudformation/...) because their parameter forms come from
 * the template; they submit through this definition's create and hidden actions, so every
 * call is validated and permission-checked the same way.
 */

import {
  CancelUpdateStackCommand,
  ContinueUpdateRollbackCommand,
  CreateChangeSetCommand,
  CreateStackCommand,
  CreateStackInstancesCommand,
  CreateStackSetCommand,
  DeleteChangeSetCommand,
  DeleteStackCommand,
  DeleteStackInstancesCommand,
  DeleteStackSetCommand,
  DescribeStackDriftDetectionStatusCommand,
  DescribeStackEventsCommand,
  DescribeStackResourceDriftsCommand,
  DescribeStacksCommand,
  DescribeStackSetCommand,
  DescribeTypeCommand,
  ListTypesCommand,
  DetectStackDriftCommand,
  DetectStackSetDriftCommand,
  ExecuteChangeSetCommand,
  GetStackPolicyCommand,
  GetTemplateCommand,
  ListChangeSetsCommand,
  ListExportsCommand,
  ListImportsCommand,
  ListStackInstancesCommand,
  ListStackResourcesCommand,
  ListStacksCommand,
  ListStackSetOperationResultsCommand,
  ListStackSetOperationsCommand,
  ListStackSetsCommand,
  RollbackStackCommand,
  SetStackPolicyCommand,
  UpdateStackCommand,
  UpdateStackSetCommand,
  UpdateTerminationProtectionCommand,
  type Capability as SdkCapability,
  type Export,
  type OnFailure,
  type StackStatus,
} from "@aws-sdk/client-cloudformation";
import { DescribeRegionsCommand } from "@aws-sdk/client-ec2";
import type { ColumnDef, Ctx, FieldDef, FieldValues, Option, ResourceDef, Row, ServiceDef, Tag } from "../../console/types.ts";
import {
  ACTIVE_STACK_STATUSES,
  CAPABILITIES,
  CAPABILITY_TEXT,
  CHANGE_SET_NAME,
  driftRows,
  formatTemplate,
  isCapability,
  parseAccounts,
  parseParameters,
  STACK_NAME,
  stackNameFromId,
  templateSource,
} from "./helpers.ts";
import { secondary } from "../../console/secondary.ts";

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const tagList = (v: unknown): Tag[] | undefined => (Array.isArray(v) && v.length ? (v as Tag[]) : undefined);
const capabilities = (v: unknown): SdkCapability[] | undefined => {
  const caps = strings(v).filter(isCapability);
  return caps.length ? (caps as SdkCapability[]) : undefined;
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const capabilityOptions: Option[] = CAPABILITIES.map((c) => ({ value: c, label: `${c}: ${CAPABILITY_TEXT[c]}` }));

const kvColumns: ColumnDef[] = [
  { key: "Key", label: "Key", kind: "text" },
  { key: "Value", label: "Value", kind: "text" },
];

async function regionOptions(ctx: Ctx): Promise<Option[]> {
  const r = await ctx.clients.ec2.send(new DescribeRegionsCommand({}));
  return (r.Regions ?? [])
    .map((x) => x.RegionName)
    .filter((n): n is string => typeof n === "string")
    .sort()
    .map((n) => ({ value: n, label: n }));
}

// ---------------------------------------------------------------- stacks

async function describeStack(ctx: Ctx, name: string) {
  const r = await ctx.clients.cloudformation.send(new DescribeStacksCommand({ StackName: name }));
  const s = r.Stacks?.[0];
  if (!s) throw new Error(`Stack ${name} does not exist.`);
  return s;
}

async function allPages<T>(fetch: (token: string | undefined) => Promise<{ items: T[]; next?: string }>, max = 20): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  for (let i = 0; i < max; i++) {
    const page = await fetch(token);
    out.push(...page.items);
    token = page.next;
    if (!token) break;
  }
  return out;
}

async function waitForDrift(ctx: Ctx, detectionId: string) {
  for (let i = 0; i < 20; i++) {
    const s = await ctx.clients.cloudformation.send(new DescribeStackDriftDetectionStatusCommand({ StackDriftDetectionId: detectionId }));
    if (s.DetectionStatus !== "DETECTION_IN_PROGRESS") return s;
    await sleep(500);
  }
  return null;
}

const driftColumns: ColumnDef[] = [
  { key: "logicalId", label: "Logical ID", kind: "text" },
  { key: "physicalId", label: "Physical ID", kind: "code" },
  { key: "resourceType", label: "Type", kind: "text" },
  { key: "driftStatus", label: "Drift status", kind: "status" },
  { key: "lastCheck", label: "Last check time", kind: "date" },
  { key: "differences", label: "Property differences", kind: "code" },
];

const changeSetFields: FieldDef[] = [
  { name: "changeSetName", label: "Change set name", kind: "text", required: true, validate: { pattern: CHANGE_SET_NAME, message: "Start with a letter; use letters, numbers and hyphens (up to 128)." } },
  { name: "description", label: "Description", kind: "textarea" },
  {
    name: "templateSource", label: "Template", kind: "radio", default: "current",
    options: [
      { value: "current", label: "Use current template" },
      { value: "body", label: "Replace current template: paste the template" },
      { value: "url", label: "Replace current template: Amazon S3 URL" },
    ],
  },
  { name: "templateBody", label: "Template body", kind: "textarea", showIf: { field: "templateSource", equals: "body" } },
  { name: "templateUrl", label: "Amazon S3 URL", kind: "text", showIf: { field: "templateSource", equals: "url" } },
  { name: "parameters", label: "Parameters", kind: "json", help: 'List form: [{"ParameterKey":"K","ParameterValue":"V"} or {"ParameterKey":"K","UsePreviousValue":true}]' },
  { name: "capabilities", label: "Capabilities", kind: "multiselect", options: capabilityOptions },
];

/** A direct update (UpdateStack): the template choice and parameters of the update wizard. */
const updateStackFields: FieldDef[] = changeSetFields.filter((f) => f.name !== "changeSetName" && f.name !== "description");

/** True when the row's status (list row "status" or detail summary "Status") is one of `statuses`; true when unknown. */
function statusIn(row: Row, statuses: string[]): boolean {
  const st = row.status ?? row.Status;
  return st === undefined || st === null || statuses.includes(String(st));
}

const changeSetNameField: FieldDef[] = [{ name: "changeSetName", label: "Change set name", kind: "text", required: true, validate: { pattern: CHANGE_SET_NAME, message: "Not a change set name." } }];

const stacks: ResourceDef = {
  id: "stacks",
  name: "Stacks",
  singular: "stack",
  idField: "name",
  nameField: "Stack name",
  description: "Stacks manage the AWS resources declared in a template as a single unit. Deleted stacks are not listed.",
  emptyText: "No stacks to display. Create a stack to get started.",
  columns: [
    { key: "name", label: "Stack name", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "created", label: "Created time", kind: "date" },
    { key: "updated", label: "Last updated", kind: "date" },
    { key: "drift", label: "Drift status", kind: "status" },
    { key: "description", label: "Description", kind: "text" },
    { key: "id", label: "Stack ID", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const summaries = await allPages(async (token) => {
      const r = await ctx.clients.cloudformation.send(new ListStacksCommand({ NextToken: token, StackStatusFilter: [...ACTIVE_STACK_STATUSES] as StackStatus[] }));
      return { items: r.StackSummaries ?? [], next: r.NextToken };
    });
    return summaries.map((s) => ({
      name: s.StackName ?? null,
      status: s.StackStatus ?? null,
      created: s.CreationTime ?? null,
      updated: s.LastUpdatedTime ?? null,
      drift: s.DriftInformation?.StackDriftStatus ?? null,
      description: s.TemplateDescription ?? null,
      id: s.StackId ?? null,
    }));
  },

  async get(ctx, name) {
    const cf = ctx.clients.cloudformation;
    const s = await describeStack(ctx, name);
    // Secondary reads: a denied one marks its tab unavailable instead of failing the stack page.
    const [eventsR, resourcesR, templateR, changeSetsR, driftsR, policyR] = await Promise.all([
      secondary(cf.send(new DescribeStackEventsCommand({ StackName: name })).then((r) => r.StackEvents ?? [])),
      secondary(
        allPages(async (token) => {
          const r = await cf.send(new ListStackResourcesCommand({ StackName: name, NextToken: token }));
          return { items: r.StackResourceSummaries ?? [], next: r.NextToken };
        })
      ),
      secondary(cf.send(new GetTemplateCommand({ StackName: name, TemplateStage: "Original" })).then((r) => r.TemplateBody)),
      secondary(cf.send(new ListChangeSetsCommand({ StackName: name })).then((r) => r.Summaries ?? [])),
      secondary(
        s.DriftInformation?.StackDriftStatus && s.DriftInformation.StackDriftStatus !== "NOT_CHECKED"
          ? cf.send(new DescribeStackResourceDriftsCommand({ StackName: name })).then((r) => r.StackResourceDrifts)
          : Promise.resolve(undefined)
      ),
      secondary(cf.send(new GetStackPolicyCommand({ StackName: name })).then((r) => r.StackPolicyBody)),
    ]);
    const unavailable = (r: { ok: boolean; error?: string }) => (r.ok ? undefined : `Unavailable: ${r.error}`);
    const events = eventsR.ok ? eventsR.value : [];
    const resources = resourcesR.ok ? resourcesR.value : [];
    const changeSets = changeSetsR.ok ? changeSetsR.value : [];
    return {
      summary: {
        "Stack name": s.StackName ?? name,
        Status: s.StackStatus ?? null,
        "Status reason": s.StackStatusReason ?? null,
        "Stack ID": s.StackId ?? null,
        Description: s.Description ?? null,
        "Created time": s.CreationTime ?? null,
        "Updated time": s.LastUpdatedTime ?? null,
      },
      tabs: [
        {
          id: "info",
          label: "Stack info",
          kind: "keyvalue",
          data: {
            "Termination protection": s.EnableTerminationProtection === true ? "Activated" : "Deactivated",
            "Drift status": s.DriftInformation?.StackDriftStatus ?? null,
            "Last drift check time": s.DriftInformation?.LastCheckTimestamp ?? null,
            "Rollback on failure": s.DisableRollback === true ? "Disabled (preserve successfully provisioned resources)" : "Enabled (roll back all stack resources)",
            "IAM role": s.RoleARN ?? null,
            "Root stack": s.RootId ?? null,
            "Parent stack": s.ParentId ?? null,
            Capabilities: (s.Capabilities ?? []).join(", ") || null,
            "SNS topic ARNs": (s.NotificationARNs ?? []).join(", ") || null,
            "Stack policy": policyR.ok ? policyR.value ?? "No stack policy" : "Unavailable",
            Tags: (s.Tags ?? []).map((t) => `${t.Key}=${t.Value}`).join(", ") || null,
          },
        },
        {
          id: "events",
          label: "Events",
          kind: "table",
          columns: [
            { key: "timestamp", label: "Timestamp", kind: "date" },
            { key: "logicalId", label: "Logical ID", kind: "text" },
            { key: "status", label: "Status", kind: "status" },
            { key: "reason", label: "Status reason", kind: "text" },
            { key: "type", label: "Type", kind: "text" },
          ],
          description: unavailable(eventsR),
          data: events.map((e) => ({
            timestamp: e.Timestamp ?? null,
            logicalId: e.LogicalResourceId ?? null,
            status: e.ResourceStatus ?? null,
            reason: e.ResourceStatusReason ?? null,
            type: e.ResourceType ?? null,
          })),
          emptyText: "No events.",
        },
        {
          id: "resources",
          label: "Resources",
          kind: "table",
          columns: [
            { key: "logicalId", label: "Logical ID", kind: "text" },
            { key: "physicalId", label: "Physical ID", kind: "code" },
            { key: "type", label: "Type", kind: "text" },
            { key: "status", label: "Status", kind: "status" },
            { key: "reason", label: "Status reason", kind: "text" },
            { key: "drift", label: "Drift status", kind: "status" },
          ],
          description: unavailable(resourcesR),
          data: resources.map((r) => ({
            logicalId: r.LogicalResourceId ?? null,
            physicalId: r.PhysicalResourceId ?? null,
            type: r.ResourceType ?? null,
            status: r.ResourceStatus ?? null,
            reason: r.ResourceStatusReason ?? null,
            drift: r.DriftInformation?.StackResourceDriftStatus ?? null,
          })),
          emptyText: "No resources.",
        },
        {
          id: "outputs",
          label: "Outputs",
          kind: "table",
          columns: [
            { key: "key", label: "Key", kind: "text" },
            { key: "value", label: "Value", kind: "code" },
            { key: "description", label: "Description", kind: "text" },
            { key: "exportName", label: "Export name", kind: "text" },
          ],
          data: (s.Outputs ?? []).map((o) => ({ key: o.OutputKey ?? null, value: o.OutputValue ?? null, description: o.Description ?? null, exportName: o.ExportName ?? null })),
          emptyText: "No outputs. Add an Outputs section to the template to show values here.",
        },
        {
          id: "parameters",
          label: "Parameters",
          kind: "table",
          columns: [
            { key: "key", label: "Key", kind: "text" },
            { key: "value", label: "Value", kind: "code" },
            { key: "resolved", label: "Resolved value", kind: "code" },
          ],
          data: (s.Parameters ?? []).map((p) => ({ key: p.ParameterKey ?? null, value: p.ParameterValue ?? null, resolved: p.ResolvedValue ?? null })),
          emptyText: "No parameters.",
        },
        {
          id: "template",
          label: "Template",
          kind: "text",
          data: templateR.ok ? formatTemplate(templateR.value) : "",
          description: unavailable(templateR),
          emptyText: templateR.ok ? "No template was returned." : "The template is unavailable.",
        },
        {
          id: "changesets",
          label: "Change sets",
          kind: "table",
          columns: [
            { key: "name", label: "Change set name", kind: "link" },
            { key: "created", label: "Created time", kind: "date" },
            { key: "status", label: "Status", kind: "status" },
            { key: "execution", label: "Execution status", kind: "status" },
            { key: "description", label: "Description", kind: "text" },
          ],
          description: unavailable(changeSetsR),
          data: changeSets.map((c) => ({
            name: c.ChangeSetName ?? null,
            created: c.CreationTime ?? null,
            status: c.Status ?? null,
            execution: c.ExecutionStatus ?? null,
            description: c.Description ?? null,
          })),
          emptyText: "No change sets. Create a change set to preview how an update changes your stack.",
        },
        {
          id: "drifts",
          label: "Drifts",
          kind: "table",
          description: unavailable(driftsR) ?? `Stack drift status: ${s.DriftInformation?.StackDriftStatus ?? "NOT_CHECKED"}. Run "Detect drift" from Stack actions to check again.`,
          columns: driftColumns,
          data: driftRows(driftsR.ok ? driftsR.value : undefined),
          emptyText: "Drift has not been checked for this stack.",
        },
      ],
    };
  },

  create: {
    title: "Create stack",
    description: "Provisions the resources in a template with CreateStack.",
    fields: [
      { name: "stackName", label: "Stack name", kind: "text", required: true, section: "Stack name", validate: { pattern: STACK_NAME, message: "Start with a letter; use letters, numbers and hyphens (up to 128)." } },
      {
        name: "templateSource", label: "Template source", kind: "radio", default: "body", section: "Specify template",
        options: [
          { value: "body", label: "Paste a template (JSON or YAML)" },
          { value: "url", label: "Amazon S3 URL" },
        ],
      },
      { name: "templateBody", label: "Template body", kind: "textarea", section: "Specify template", showIf: { field: "templateSource", equals: "body" } },
      { name: "templateUrl", label: "Amazon S3 URL", kind: "text", section: "Specify template", showIf: { field: "templateSource", equals: "url" } },
      { name: "parameters", label: "Parameters", kind: "json", section: "Parameters", help: '{"Key": "Value"} or the API list form.' },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
      { name: "terminationProtection", label: "Termination protection", kind: "checkbox", default: false, section: "Stack failure options", help: "Prevents the stack from being deleted." },
      {
        name: "onFailure", label: "Behavior on provisioning failure", kind: "radio", default: "ROLLBACK", section: "Stack failure options",
        options: [
          { value: "ROLLBACK", label: "Roll back all stack resources" },
          { value: "DO_NOTHING", label: "Preserve successfully provisioned resources" },
          { value: "DELETE", label: "Delete all stack resources" },
        ],
      },
      { name: "capabilities", label: "Capabilities", kind: "multiselect", section: "Capabilities", options: capabilityOptions },
    ],
    async run(ctx, v) {
      const name = String(v.stackName);
      await ctx.clients.cloudformation.send(
        new CreateStackCommand({
          StackName: name,
          ...templateSource(v.templateSource, v.templateBody, v.templateUrl),
          Parameters: parseParameters(v.parameters),
          Tags: tagList(v.tags),
          EnableTerminationProtection: v.terminationProtection === true,
          OnFailure: (typeof v.onFailure === "string" ? v.onFailure : "ROLLBACK") as OnFailure,
          Capabilities: capabilities(v.capabilities),
        })
      );
      return name;
    },
  },

  actions: [
    {
      id: "detect-drift",
      label: "Detect drift",
      async run(ctx, name) {
        const r = await ctx.clients.cloudformation.send(new DetectStackDriftCommand({ StackName: name }));
        const status = r.StackDriftDetectionId ? await waitForDrift(ctx, r.StackDriftDetectionId) : null;
        if (!status) return { message: `Drift detection started (ID ${r.StackDriftDetectionId ?? "-"}). Refresh the Drifts tab for results.` };
        const drifts = await ctx.clients.cloudformation.send(new DescribeStackResourceDriftsCommand({ StackName: name }));
        return {
          message: `Drift detection ${status.DetectionStatus ?? "finished"}: stack drift status ${status.StackDriftStatus ?? "-"}, ${plural(status.DriftedStackResourceCount ?? 0, "drifted resource")}.${status.DetectionStatusReason ? ` ${status.DetectionStatusReason}` : ""}`,
          table: { columns: driftColumns, rows: driftRows(drifts.StackResourceDrifts), rowKey: "logicalId", emptyText: "No resources were checked." },
        };
      },
    },
    {
      id: "termination-protection",
      label: "Edit termination protection",
      fields: [
        {
          name: "enabled", label: "Termination protection", kind: "radio", default: "true",
          options: [
            { value: "true", label: "Activated" },
            { value: "false", label: "Deactivated" },
          ],
        },
      ],
      async initialValues(ctx, name) {
        return { enabled: (await describeStack(ctx, name)).EnableTerminationProtection === true ? "true" : "false" };
      },
      async run(ctx, name, v) {
        const on = v.enabled === "true";
        await ctx.clients.cloudformation.send(new UpdateTerminationProtectionCommand({ StackName: name, EnableTerminationProtection: on }));
        return { message: `Termination protection ${on ? "activated" : "deactivated"} for ${name}.` };
      },
    },
    {
      id: "stack-policy",
      label: "Edit stack policy",
      fields: [{ name: "policy", label: "Stack policy", kind: "json", required: true, placeholder: '{"Statement":[{"Effect":"Allow","Action":"Update:*","Principal":"*","Resource":"*"}]}', help: "Protects stack resources from unintentional updates. A stack policy can't be removed, only replaced." }],
      async initialValues(ctx, name): Promise<FieldValues> {
        const body = (await ctx.clients.cloudformation.send(new GetStackPolicyCommand({ StackName: name }))).StackPolicyBody;
        if (!body) return {};
        try {
          return { policy: JSON.stringify(JSON.parse(body), null, 2) };
        } catch {
          return { policy: body };
        }
      },
      async run(ctx, name, v) {
        await ctx.clients.cloudformation.send(new SetStackPolicyCommand({ StackName: name, StackPolicyBody: String(v.policy) }));
        return { message: `Stack policy set for ${name}.` };
      },
    },
    {
      id: "rollback",
      label: "Roll back",
      availableFor: (row) => statusIn(row, ["CREATE_FAILED", "UPDATE_FAILED"]),
      confirm: "Rolls the stack back to its last stable state (RollbackStack). Only stacks in CREATE_FAILED or UPDATE_FAILED can be rolled back.",
      async run(ctx, name) {
        await ctx.clients.cloudformation.send(new RollbackStackCommand({ StackName: name }));
        return { message: `Rollback started for ${name}.` };
      },
    },
    {
      id: "cancel-update",
      label: "Cancel update stack",
      availableFor: (row) => statusIn(row, ["UPDATE_IN_PROGRESS"]),
      confirm: "Cancels an update in progress and rolls the stack back (CancelUpdateStack).",
      async run(ctx, name) {
        await ctx.clients.cloudformation.send(new CancelUpdateStackCommand({ StackName: name }));
        return { message: `Update cancel requested for ${name}.` };
      },
    },
    {
      id: "continue-rollback",
      label: "Continue update rollback",
      availableFor: (row) => statusIn(row, ["UPDATE_ROLLBACK_FAILED"]),
      confirm: "Continues rolling back a stack in UPDATE_ROLLBACK_FAILED (ContinueUpdateRollback).",
      async run(ctx, name) {
        await ctx.clients.cloudformation.send(new ContinueUpdateRollbackCommand({ StackName: name }));
        return { message: `Update rollback continued for ${name}.` };
      },
    },
    {
      id: "create-change-set",
      label: "Create change set",
      hidden: true,
      fields: changeSetFields,
      async run(ctx, name, v) {
        const r = await ctx.clients.cloudformation.send(
          new CreateChangeSetCommand({
            StackName: name,
            ChangeSetName: String(v.changeSetName),
            Description: text(v.description),
            ...templateSource(v.templateSource, v.templateBody, v.templateUrl, true),
            Parameters: parseParameters(v.parameters),
            Capabilities: capabilities(v.capabilities),
            ChangeSetType: "UPDATE",
          })
        );
        return { message: `Created change set ${String(v.changeSetName)}.`, json: { Id: r.Id ?? null, StackId: r.StackId ?? null } };
      },
    },
    {
      id: "update-stack",
      label: "Update stack",
      hidden: true,
      fields: updateStackFields,
      async run(ctx, name, v) {
        const r = await ctx.clients.cloudformation.send(
          new UpdateStackCommand({
            StackName: name,
            ...templateSource(v.templateSource, v.templateBody, v.templateUrl, true),
            Parameters: parseParameters(v.parameters),
            Capabilities: capabilities(v.capabilities),
          })
        );
        return { message: `Update started for ${name}. CloudFormation is updating its resources; see the Events tab.`, json: { StackId: r.StackId ?? null } };
      },
    },
    {
      id: "execute-change-set",
      label: "Execute change set",
      hidden: true,
      fields: changeSetNameField,
      async run(ctx, name, v) {
        await ctx.clients.cloudformation.send(new ExecuteChangeSetCommand({ StackName: name, ChangeSetName: String(v.changeSetName) }));
        return { message: `Executing change set ${String(v.changeSetName)} on ${name}.` };
      },
    },
    {
      id: "delete-change-set",
      label: "Delete change set",
      hidden: true,
      danger: true,
      fields: changeSetNameField,
      async run(ctx, name, v) {
        await ctx.clients.cloudformation.send(new DeleteChangeSetCommand({ StackName: name, ChangeSetName: String(v.changeSetName) }));
        return { message: `Deleted change set ${String(v.changeSetName)}.` };
      },
    },
  ],

  delete: {
    async run(ctx, name) {
      await ctx.clients.cloudformation.send(new DeleteStackCommand({ StackName: name }));
    },
  },
};

// ---------------------------------------------------------------- StackSets

const operationColumns: ColumnDef[] = [
  { key: "operationId", label: "Operation ID", kind: "code" },
  { key: "action", label: "Action", kind: "text" },
  { key: "status", label: "Status", kind: "status" },
  { key: "created", label: "Created time", kind: "date" },
  { key: "ended", label: "End time", kind: "date" },
  { key: "reason", label: "Status reason", kind: "text" },
];

async function listOperations(ctx: Ctx, name: string): Promise<Row[]> {
  const ops = await allPages(async (token) => {
    const r = await ctx.clients.cloudformation.send(new ListStackSetOperationsCommand({ StackSetName: name, NextToken: token }));
    return { items: r.Summaries ?? [], next: r.NextToken };
  });
  return ops.map((o) => ({
    operationId: o.OperationId ?? null,
    action: o.Action ?? null,
    status: o.Status ?? null,
    created: o.CreationTimestamp ?? null,
    ended: o.EndTimestamp ?? null,
    reason: o.StatusReason ?? null,
  }));
}

const deploymentFields: FieldDef[] = [
  { name: "accounts", label: "Account numbers", kind: "textarea", required: true, help: "Comma-separated 12-digit AWS account IDs. The emulator's account is 000000000000." },
  { name: "regions", label: "Specify regions", kind: "multiselect", required: true, options: regionOptions },
  { name: "maxConcurrent", label: "Maximum concurrent accounts (number)", kind: "number", default: 1, validate: { min: 1, max: 100, message: "Between 1 and 100." } },
  { name: "failureTolerance", label: "Failure tolerance (number)", kind: "number", default: 0, validate: { min: 0, max: 100, message: "Between 0 and 100." } },
];

function operationPreferences(v: FieldValues) {
  return {
    MaxConcurrentCount: typeof v.maxConcurrent === "number" ? v.maxConcurrent : 1,
    FailureToleranceCount: typeof v.failureTolerance === "number" ? v.failureTolerance : 0,
  };
}

const stacksets: ResourceDef = {
  id: "stacksets",
  name: "StackSets",
  singular: "StackSet",
  idField: "name",
  nameField: "StackSet name",
  description: "StackSets deploy one template to stacks in several accounts and Regions. Deleted StackSets are not listed.",
  emptyText: "No StackSets. Create a StackSet to deploy stacks across accounts and Regions.",
  columns: [
    { key: "name", label: "StackSet name", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "description", label: "Description", kind: "text" },
    { key: "drift", label: "Drift status", kind: "status" },
    { key: "permissionModel", label: "Permission model", kind: "text" },
    { key: "id", label: "StackSet ID", kind: "code", hidden: true },
  ],

  async list(ctx) {
    const sets = await allPages(async (token) => {
      const r = await ctx.clients.cloudformation.send(new ListStackSetsCommand({ NextToken: token, Status: "ACTIVE" }));
      return { items: r.Summaries ?? [], next: r.NextToken };
    });
    return sets.map((s) => ({
      name: s.StackSetName ?? null,
      status: s.Status ?? null,
      description: s.Description ?? null,
      drift: s.DriftStatus ?? null,
      permissionModel: s.PermissionModel ?? null,
      id: s.StackSetId ?? null,
    }));
  },

  async get(ctx, name) {
    const cf = ctx.clients.cloudformation;
    const [set, instancesR, operationsR] = await Promise.all([
      cf.send(new DescribeStackSetCommand({ StackSetName: name })),
      secondary(
        allPages(async (token) => {
          const r = await cf.send(new ListStackInstancesCommand({ StackSetName: name, NextToken: token }));
          return { items: r.Summaries ?? [], next: r.NextToken };
        })
      ),
      secondary(listOperations(ctx, name)),
    ]);
    const instances = instancesR.ok ? instancesR.value : [];
    const operations = operationsR.ok ? operationsR.value : [];
    const s = set.StackSet;
    if (!s) throw new Error(`StackSet ${name} not found.`);
    const drift = s.StackSetDriftDetectionDetails;
    return {
      summary: {
        "StackSet name": s.StackSetName ?? name,
        Status: s.Status ?? null,
        "StackSet ID": s.StackSetId ?? null,
        "StackSet ARN": s.StackSetARN ?? null,
        Description: s.Description ?? null,
        "Permission model": s.PermissionModel ?? null,
      },
      tabs: [
        {
          id: "info",
          label: "StackSet info",
          kind: "keyvalue",
          data: {
            "Administration role ARN": s.AdministrationRoleARN ?? null,
            "Execution role name": s.ExecutionRoleName ?? null,
            Capabilities: (s.Capabilities ?? []).join(", ") || null,
            "Auto-deployment": s.AutoDeployment ? (s.AutoDeployment.Enabled ? "Activated" : "Deactivated") : null,
            "Managed execution": s.ManagedExecution?.Active === true ? "Active" : "Inactive",
            "Drift status": drift?.DriftStatus ?? null,
            "Last drift check time": drift?.LastDriftCheckTimestamp ?? null,
            "Stack instances": drift?.TotalStackInstancesCount ?? instances.length,
            "Drifted stack instances": drift?.DriftedStackInstancesCount ?? null,
          },
        },
        {
          id: "instances",
          label: "Stack instances",
          kind: "table",
          columns: [
            { key: "account", label: "AWS account", kind: "text" },
            { key: "region", label: "AWS Region", kind: "text" },
            { key: "stackId", label: "Stack ID", kind: "arn" },
            { key: "status", label: "Status", kind: "status" },
            { key: "detailed", label: "Detailed status", kind: "status" },
            { key: "drift", label: "Drift status", kind: "status" },
            { key: "reason", label: "Status reason", kind: "text" },
          ],
          description: instancesR.ok ? undefined : `Unavailable: ${instancesR.error}`,
          data: instances.map((i) => ({
            account: i.Account ?? null,
            region: i.Region ?? null,
            stackId: i.StackId ?? null,
            status: i.Status ?? null,
            detailed: i.StackInstanceStatus?.DetailedStatus ?? null,
            drift: i.DriftStatus ?? null,
            reason: i.StatusReason ?? null,
          })),
          emptyText: 'No stack instances. Use "Add stacks to StackSet" to deploy stacks.',
        },
        { id: "operations", label: "Operations", kind: "table", columns: operationColumns, data: operations, emptyText: "No operations.", description: operationsR.ok ? undefined : `Unavailable: ${operationsR.error}` },
        {
          id: "parameters",
          label: "Parameters",
          kind: "table",
          columns: [
            { key: "key", label: "Key", kind: "text" },
            { key: "value", label: "Value", kind: "code" },
          ],
          data: (s.Parameters ?? []).map((p) => ({ key: p.ParameterKey ?? null, value: p.ParameterValue ?? null })),
          emptyText: "No parameters.",
        },
        { id: "template", label: "Template", kind: "text", data: formatTemplate(s.TemplateBody), emptyText: "No template was returned." },
        { id: "tags", label: "Tags", kind: "table", columns: kvColumns, data: s.Tags ?? [], emptyText: "No tags." },
      ],
    };
  },

  create: {
    title: "Create StackSet",
    description: "Creates a StackSet with CreateStackSet. Add stack instances afterwards with \"Add stacks to StackSet\".",
    fields: [
      {
        name: "permissionModel", label: "Permissions", kind: "radio", default: "SELF_MANAGED", section: "Permissions",
        options: [
          { value: "SELF_MANAGED", label: "Self-service permissions: you create the administration and execution roles" },
          { value: "SERVICE_MANAGED", label: "Service-managed permissions: StackSets uses AWS Organizations to create the roles" },
        ],
      },
      { name: "adminRoleArn", label: "IAM admin role ARN", kind: "text", section: "Permissions", showIf: { field: "permissionModel", equals: "SELF_MANAGED" }, help: "Defaults to AWSCloudFormationStackSetAdministrationRole." },
      { name: "executionRoleName", label: "IAM execution role name", kind: "text", section: "Permissions", default: "AWSCloudFormationStackSetExecutionRole", showIf: { field: "permissionModel", equals: "SELF_MANAGED" } },
      {
        name: "templateSource", label: "Template source", kind: "radio", default: "body", section: "Specify template",
        options: [
          { value: "body", label: "Paste a template (JSON or YAML)" },
          { value: "url", label: "Amazon S3 URL" },
        ],
      },
      { name: "templateBody", label: "Template body", kind: "textarea", section: "Specify template", showIf: { field: "templateSource", equals: "body" } },
      { name: "templateUrl", label: "Amazon S3 URL", kind: "text", section: "Specify template", showIf: { field: "templateSource", equals: "url" } },
      { name: "name", label: "StackSet name", kind: "text", required: true, section: "StackSet details", validate: { pattern: STACK_NAME, message: "Start with a letter; use letters, numbers and hyphens (up to 128)." } },
      { name: "description", label: "StackSet description", kind: "textarea", section: "StackSet details" },
      { name: "parameters", label: "Parameters", kind: "json", section: "StackSet details", placeholder: '{"Key": "Value"}', help: "Values for the template's parameters, as a JSON object." },
      { name: "capabilities", label: "Capabilities", kind: "multiselect", section: "Configure StackSet options", options: capabilityOptions },
      { name: "tags", label: "Tags", kind: "tags", section: "Configure StackSet options" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      const source = templateSource(v.templateSource, v.templateBody, v.templateUrl);
      const selfManaged = v.permissionModel !== "SERVICE_MANAGED";
      await ctx.clients.cloudformation.send(
        new CreateStackSetCommand({
          StackSetName: name,
          Description: text(v.description),
          ...("UsePreviousTemplate" in source ? {} : source),
          Parameters: parseParameters(v.parameters),
          Capabilities: capabilities(v.capabilities),
          Tags: tagList(v.tags),
          PermissionModel: selfManaged ? "SELF_MANAGED" : "SERVICE_MANAGED",
          AdministrationRoleARN: selfManaged ? text(v.adminRoleArn) : undefined,
          ExecutionRoleName: selfManaged ? text(v.executionRoleName) : undefined,
          AutoDeployment: selfManaged ? undefined : { Enabled: true, RetainStacksOnAccountRemoval: false },
        })
      );
      return name;
    },
  },

  actions: [
    {
      id: "add-stacks",
      label: "Add stacks to StackSet",
      fields: deploymentFields,
      async run(ctx, name, v) {
        const r = await ctx.clients.cloudformation.send(
          new CreateStackInstancesCommand({ StackSetName: name, Accounts: parseAccounts(v.accounts), Regions: strings(v.regions), OperationPreferences: operationPreferences(v) })
        );
        return { message: `Started operation ${r.OperationId ?? "-"} to add stack instances. See the Operations tab for its status.` };
      },
    },
    {
      id: "delete-stacks",
      label: "Delete stacks from StackSet",
      danger: true,
      fields: [
        ...deploymentFields,
        { name: "retain", label: "Retain stacks", kind: "checkbox", default: false, help: "Removes the stacks from the StackSet but keeps them and their resources." },
      ],
      async run(ctx, name, v) {
        const r = await ctx.clients.cloudformation.send(
          new DeleteStackInstancesCommand({ StackSetName: name, Accounts: parseAccounts(v.accounts), Regions: strings(v.regions), RetainStacks: v.retain === true, OperationPreferences: operationPreferences(v) })
        );
        return { message: `Started operation ${r.OperationId ?? "-"} to delete stack instances.` };
      },
    },
    {
      id: "edit",
      label: "Edit StackSet details",
      fields: [
        {
          name: "templateSource", label: "Template", kind: "radio", default: "current",
          options: [
            { value: "current", label: "Use current template" },
            { value: "body", label: "Replace current template: paste the template" },
            { value: "url", label: "Replace current template: Amazon S3 URL" },
          ],
        },
        { name: "templateBody", label: "Template body", kind: "textarea", showIf: { field: "templateSource", equals: "body" } },
        { name: "templateUrl", label: "Amazon S3 URL", kind: "text", showIf: { field: "templateSource", equals: "url" } },
        { name: "description", label: "StackSet description", kind: "textarea" },
        { name: "parameters", label: "Parameters", kind: "json", help: 'Values as {"Key": "Value"}, or the list form with UsePreviousValue. Leave empty to keep the current values.' },
        { name: "capabilities", label: "Capabilities", kind: "multiselect", options: capabilityOptions },
        { name: "maxConcurrent", label: "Maximum concurrent accounts (number)", kind: "number", default: 1, validate: { min: 1, max: 100, message: "Between 1 and 100." } },
        { name: "failureTolerance", label: "Failure tolerance (number)", kind: "number", default: 0, validate: { min: 0, max: 100, message: "Between 0 and 100." } },
      ],
      async initialValues(ctx, name) {
        const s = (await ctx.clients.cloudformation.send(new DescribeStackSetCommand({ StackSetName: name }))).StackSet;
        const params = Object.fromEntries((s?.Parameters ?? []).filter((p) => p.ParameterKey).map((p) => [p.ParameterKey as string, p.ParameterValue ?? ""]));
        return {
          description: s?.Description ?? "",
          parameters: Object.keys(params).length ? JSON.stringify(params, null, 2) : "",
          capabilities: (s?.Capabilities ?? []).filter(isCapability),
        };
      },
      async run(ctx, name, v) {
        const params = parseParameters(v.parameters);
        let parameters = params.length ? params : undefined;
        if (!parameters) {
          const current = await ctx.clients.cloudformation.send(new DescribeStackSetCommand({ StackSetName: name }));
          parameters = (current.StackSet?.Parameters ?? []).filter((p) => p.ParameterKey).map((p) => ({ ParameterKey: p.ParameterKey as string, UsePreviousValue: true }));
        }
        const r = await ctx.clients.cloudformation.send(
          new UpdateStackSetCommand({
            StackSetName: name,
            ...templateSource(v.templateSource, v.templateBody, v.templateUrl, true),
            Description: text(v.description),
            Parameters: parameters,
            Capabilities: capabilities(v.capabilities),
            OperationPreferences: operationPreferences(v),
          })
        );
        return { message: `Started update operation ${r.OperationId ?? "-"}. Existing stack instances are updated with the new settings.` };
      },
    },
    {
      id: "detect-drift",
      label: "Detect drift",
      async run(ctx, name) {
        const r = await ctx.clients.cloudformation.send(new DetectStackSetDriftCommand({ StackSetName: name }));
        return { message: `Started drift detection operation ${r.OperationId ?? "-"}. The result shows in the StackSet info and Stack instances tabs.` };
      },
    },
    {
      id: "operations",
      label: "View operation results",
      async run(ctx, name) {
        const rows = await listOperations(ctx, name);
        return {
          message: `${plural(rows.length, "operation")}. Select operations to see their per-account, per-Region results.`,
          table: { columns: operationColumns, rows, rowKey: "operationId", emptyText: "No operations.", selectionAction: { actionId: "operation-results", label: "View results", valuesField: "operationIds" } },
        };
      },
    },
    {
      id: "operation-results",
      label: "Operation results",
      hidden: true,
      fields: [{ name: "operationIds", label: "Operations", kind: "multiselect", required: true }],
      async run(ctx, name, v) {
        const rows: Row[] = [];
        for (const op of strings(v.operationIds).slice(0, 20)) {
          const r = await ctx.clients.cloudformation.send(new ListStackSetOperationResultsCommand({ StackSetName: name, OperationId: op }));
          for (const x of r.Summaries ?? []) {
            rows.push({ key: `${op}-${x.Account}-${x.Region}`, operationId: op, account: x.Account ?? null, region: x.Region ?? null, status: x.Status ?? null, reason: x.StatusReason ?? null });
          }
        }
        return {
          message: `${plural(rows.length, "result")}.`,
          table: {
            rowKey: "key",
            rows,
            emptyText: "No results for these operations.",
            columns: [
              { key: "operationId", label: "Operation ID", kind: "code" },
              { key: "account", label: "AWS account", kind: "text" },
              { key: "region", label: "AWS Region", kind: "text" },
              { key: "status", label: "Status", kind: "status" },
              { key: "reason", label: "Status reason", kind: "text" },
            ],
          },
        };
      },
    },
  ],

  delete: {
    confirmText: "name",
    async run(ctx, name) {
      await ctx.clients.cloudformation.send(new DeleteStackSetCommand({ StackSetName: name }));
    },
  },
};

// ---------------------------------------------------------------- exports

async function listAllExports(ctx: Ctx): Promise<Export[]> {
  return allPages(async (token) => {
    const r = await ctx.clients.cloudformation.send(new ListExportsCommand({ NextToken: token }));
    return { items: r.Exports ?? [], next: r.NextToken };
  });
}

const exportsResource: ResourceDef = {
  id: "exports",
  name: "Exports",
  singular: "export",
  idField: "name",
  nameField: "Export name",
  description: "Output values that stacks export for other stacks in this account and Region to import with Fn::ImportValue.",
  emptyText: "No exports. Add an Export to a stack output to share it with other stacks.",
  columns: [
    { key: "name", label: "Export name", kind: "link" },
    { key: "value", label: "Export value", kind: "code" },
    { key: "stack", label: "Exporting stack", kind: "text" },
    { key: "stackId", label: "Exporting stack ID", kind: "arn", hidden: true },
  ],
  async list(ctx) {
    return (await listAllExports(ctx)).map((e) => ({ name: e.Name ?? null, value: e.Value ?? null, stack: stackNameFromId(e.ExportingStackId), stackId: e.ExportingStackId ?? null }));
  },
  async get(ctx, name) {
    const e = (await listAllExports(ctx)).find((x) => x.Name === name);
    if (!e) throw new Error(`Export ${name} does not exist.`);
    let imports: string[] = [];
    let note: string | undefined;
    try {
      imports = await allPages(async (token) => {
        const r = await ctx.clients.cloudformation.send(new ListImportsCommand({ ExportName: name, NextToken: token }));
        return { items: r.Imports ?? [], next: r.NextToken };
      });
    } catch (err: unknown) {
      // ListImports answers ValidationError "is not imported by any stack" when nothing imports it.
      if (!(err instanceof Error && /not imported/i.test(err.message))) throw err;
      note = err.message;
    }
    return {
      summary: { "Export name": e.Name ?? name, "Export value": e.Value ?? null, "Exporting stack": stackNameFromId(e.ExportingStackId), "Exporting stack ID": e.ExportingStackId ?? null },
      tabs: [
        {
          id: "imports",
          label: "Imports",
          kind: "table",
          description: note,
          columns: [{ key: "stack", label: "Importing stack", kind: "text" }],
          data: imports.map((s) => ({ stack: s })),
          emptyText: "No stacks import this export.",
        },
      ],
    };
  },
};

// ---------------------------------------------------------------- registry

const extensions: ResourceDef = {
  id: "extensions",
  name: "Public extensions",
  singular: "extension",
  idField: "name",
  nameField: "Type name",
  description: "Registry: the public resource types that templates can use, as the emulator registers them.",
  emptyText: "No public extensions are registered.",
  columns: [
    { key: "name", label: "Type name", kind: "link" },
    { key: "type", label: "Type", kind: "text" },
    { key: "publisher", label: "Publisher", kind: "text" },
    { key: "description", label: "Description", kind: "text" },
    { key: "arn", label: "Type ARN", kind: "arn", hidden: true },
  ],
  async list(ctx) {
    const types = await allPages(async (token) => {
      const r = await ctx.clients.cloudformation.send(new ListTypesCommand({ Visibility: "PUBLIC", Type: "RESOURCE", NextToken: token, MaxResults: 100 }));
      return { items: r.TypeSummaries ?? [], next: r.NextToken };
    });
    return types.map((t) => ({
      name: t.TypeName ?? null,
      type: t.Type ?? null,
      publisher: t.PublisherName ?? (t.TypeName?.startsWith("AWS::") ? "AWS" : null),
      description: t.Description ?? null,
      arn: t.TypeArn ?? null,
    }));
  },
  async get(ctx, name) {
    const t = await ctx.clients.cloudformation.send(new DescribeTypeCommand({ Type: "RESOURCE", TypeName: name }));
    let schema: unknown = t.Schema ?? null;
    if (typeof schema === "string") {
      try {
        schema = JSON.parse(schema);
      } catch {
        // Shown as text below.
      }
    }
    return {
      summary: {
        "Type name": t.TypeName ?? name,
        Type: t.Type ?? null,
        "Type ARN": t.Arn ?? null,
        Description: t.Description ?? null,
        "Provisioning type": t.ProvisioningType ?? null,
        Visibility: t.Visibility ?? null,
        "Default version": t.DefaultVersionId ?? null,
      },
      tabs: [{ id: "schema", label: "Schema", kind: "json", data: schema, emptyText: "No schema was returned." }],
    };
  },
};

export const cloudformationService: ServiceDef = {
  id: "cloudformation",
  name: "CloudFormation",
  category: "Management & Governance",
  description: "Model, provision and manage AWS resources as code with templates, stacks, change sets and StackSets.",
  resources: [stacks, stacksets, exportsResource, extensions],
  notSupported: ["Parameter constraints other than AllowedValues (MinLength, MaxLength, MinValue, MaxValue, AllowedPattern) in GetTemplateSummary, so the parameter form can't check them before CreateStack"],
};
