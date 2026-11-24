/** Systems Manager documents (SSM documents) and Automation executions. */

import {
  CreateDocumentCommand,
  DeleteDocumentCommand,
  DescribeAutomationExecutionsCommand,
  DescribeDocumentCommand,
  GetAutomationExecutionCommand,
  GetDocumentCommand,
  ListDocumentsCommand,
  ListDocumentVersionsCommand,
  StartAutomationExecutionCommand,
  StopAutomationExecutionCommand,
  UpdateDocumentCommand,
  UpdateDocumentDefaultVersionCommand,
  type DocumentFormat,
  type DocumentType,
} from "@aws-sdk/client-ssm";
import type { Ctx, FieldValues, Option, ResourceDef, Row } from "../../console/types.ts";
import { parseDocParameters } from "./helpers.ts";

const DOC_NAME = "[A-Za-z0-9_.-]{3,128}";

const DOC_TYPES: Option[] = [
  { value: "Command", label: "Command or Session document" },
  { value: "Automation", label: "Automation runbook" },
  { value: "Session", label: "Session document" },
  { value: "Package", label: "Package" },
];

const STARTER = `schemaVersion: "2.2"
description: "Example command document"
parameters:
  message:
    type: String
    default: Hello
mainSteps:
  - action: aws:runShellScript
    name: run
    inputs:
      runCommand:
        - echo {{ message }}
`;

export const documents: ResourceDef = {
  id: "documents",
  name: "Documents",
  singular: "document",
  idField: "name",
  nameField: "name",
  description: "SSM documents define the actions Run Command, Automation, State Manager and Session Manager perform.",
  emptyText: "No documents.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "owner", label: "Owner", kind: "text" },
    { key: "type", label: "Document type", kind: "text" },
    { key: "platforms", label: "Platform types", kind: "text" },
    { key: "version", label: "Default version", kind: "text" },
    { key: "format", label: "Format", kind: "text" },
    { key: "created", label: "Created", kind: "date" },
  ],
  async list(ctx) {
    const rows: Row[] = [];
    let token: string | undefined;
    do {
      const r = await ctx.clients.ssm.send(new ListDocumentsCommand({ NextToken: token, MaxResults: 50 }));
      for (const d of r.DocumentIdentifiers ?? [])
        rows.push({
          name: d.Name ?? "",
          owner: d.Owner === "Amazon" ? "Amazon" : d.Owner ? `Owned by me (${d.Owner})` : null,
          type: d.DocumentType ?? null,
          platforms: (d.PlatformTypes ?? []).join(", "),
          version: d.DocumentVersion ?? null,
          format: d.DocumentFormat ?? null,
          created: d.CreatedDate ?? null,
        });
      token = r.NextToken;
    } while (token && rows.length < 2000);
    return rows;
  },
  async get(ctx, name) {
    const [desc, content, versions] = await Promise.all([
      ctx.clients.ssm.send(new DescribeDocumentCommand({ Name: name })),
      ctx.clients.ssm.send(new GetDocumentCommand({ Name: name })),
      ctx.clients.ssm.send(new ListDocumentVersionsCommand({ Name: name })),
    ]);
    const d = desc.Document;
    return {
      summary: {
        Name: name,
        Description: d?.Description ?? null,
        Owner: d?.Owner ?? null,
        "Document type": d?.DocumentType ?? null,
        "Schema version": d?.SchemaVersion ?? null,
        "Platform types": (d?.PlatformTypes ?? []).join(", ") || null,
        "Default version": d?.DefaultVersion ?? null,
        "Latest version": d?.LatestVersion ?? null,
        Status: d?.Status ?? null,
        Created: d?.CreatedDate ?? null,
      },
      tabs: [
        { id: "content", label: "Content", kind: "text", data: content.Content ?? "", description: `Version ${content.DocumentVersion ?? "?"} as ${content.DocumentFormat ?? "JSON"}.` },
        {
          id: "parameters",
          label: "Parameters",
          kind: "table",
          data: (d?.Parameters ?? []).map((p) => ({ name: p.Name ?? "", type: p.Type ?? null, default: p.DefaultValue ?? null, description: p.Description ?? null })),
          columns: [
            { key: "name", label: "Name", kind: "text" },
            { key: "type", label: "Type", kind: "text" },
            { key: "default", label: "Default value", kind: "code" },
            { key: "description", label: "Description", kind: "text" },
          ],
          emptyText: "This document takes no parameters.",
        },
        {
          id: "versions",
          label: "Versions",
          kind: "table",
          data: (versions.DocumentVersions ?? []).map((v) => ({ version: v.DocumentVersion ?? "", default: v.IsDefaultVersion ? "Default" : "", status: v.Status ?? null, created: v.CreatedDate ?? null, format: v.DocumentFormat ?? null })),
          columns: [
            { key: "version", label: "Version", kind: "text" },
            { key: "default", label: "Default", kind: "text" },
            { key: "status", label: "Status", kind: "status" },
            { key: "format", label: "Format", kind: "text" },
            { key: "created", label: "Created", kind: "date" },
          ],
        },
      ],
    };
  },
  create: {
    title: "Create document",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, section: "Document details", validate: { pattern: DOC_NAME, message: "3 to 128 letters, numbers, . _ and -. Can't start with AWS or Amazon." } },
      { name: "type", label: "Document type", kind: "select", section: "Document details", default: "Command", options: DOC_TYPES },
      {
        name: "format",
        label: "Content format",
        kind: "radio",
        section: "Content",
        default: "YAML",
        options: [
          { value: "YAML", label: "YAML" },
          { value: "JSON", label: "JSON" },
        ],
      },
      { name: "content", label: "Content", kind: "textarea", required: true, section: "Content", default: STARTER },
      { name: "tags", label: "Tags", kind: "tags", section: "Tags" },
    ],
    async run(ctx, v) {
      const name = String(v.name);
      if (/^(aws|amazon|amzn)/i.test(name)) throw new Error("Document names can't start with AWS, Amazon or AMZN.");
      await ctx.clients.ssm.send(
        new CreateDocumentCommand({
          Name: name,
          Content: String(v.content),
          DocumentType: String(v.type) as DocumentType,
          DocumentFormat: String(v.format) as DocumentFormat,
          Tags: Array.isArray(v.tags) && v.tags.length ? (v.tags as { Key: string; Value: string }[]) : undefined,
        })
      );
      return name;
    },
  },
  actions: [
    {
      id: "new-version",
      label: "Create new version",
      availableFor: (row) => (row.owner ?? row.Owner) !== "Amazon",
      fields: [
        {
          name: "format",
          label: "Content format",
          kind: "radio",
          default: "YAML",
          options: [
            { value: "YAML", label: "YAML" },
            { value: "JSON", label: "JSON" },
          ],
        },
        { name: "content", label: "Content", kind: "textarea", required: true, help: "Starts from the latest version's content." },
      ],
      async initialValues(ctx, name) {
        const d = await ctx.clients.ssm.send(new GetDocumentCommand({ Name: name, DocumentVersion: "$LATEST" }));
        return { format: d.DocumentFormat === "JSON" ? "JSON" : "YAML", content: d.Content ?? "" };
      },
      async run(ctx, name, v) {
        const r = await ctx.clients.ssm.send(new UpdateDocumentCommand({ Name: name, Content: String(v.content), DocumentFormat: String(v.format) as DocumentFormat, DocumentVersion: "$LATEST" }));
        return { message: `Created version ${r.DocumentDescription?.DocumentVersion ?? "?"} of ${name}. Set it as the default version to use it by default.` };
      },
    },
    {
      id: "set-default",
      label: "Set default version",
      availableFor: (row) => (row.owner ?? row.Owner) !== "Amazon",
      fields: [{ name: "version", label: "Version", kind: "select", required: true, options: documentVersionOptions }],
      async initialValues(ctx, name) {
        const d = await ctx.clients.ssm.send(new DescribeDocumentCommand({ Name: name }));
        const values: FieldValues = d.Document?.DefaultVersion ? { version: d.Document.DefaultVersion } : {};
        return values;
      },
      async run(ctx, name, v) {
        await ctx.clients.ssm.send(new UpdateDocumentDefaultVersionCommand({ Name: name, DocumentVersion: String(v.version) }));
        return { message: `Default version of ${name} set to ${String(v.version)}.` };
      },
    },
  ],
  delete: {
    confirmText: "delete",
    async run(ctx, name) {
      await ctx.clients.ssm.send(new DeleteDocumentCommand({ Name: name }));
    },
  },
};

async function documentVersionOptions(ctx: Ctx, name?: string): Promise<Option[]> {
  if (!name) return [];
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.ssm.send(new ListDocumentVersionsCommand({ Name: name, NextToken: token, MaxResults: 50 }));
    for (const v of r.DocumentVersions ?? []) if (v.DocumentVersion) out.push({ value: v.DocumentVersion, label: `${v.DocumentVersion}${v.VersionName ? ` (${v.VersionName})` : ""}${v.IsDefaultVersion ? " - default" : ""}` });
    token = r.NextToken;
  } while (token);
  return out.sort((a, b) => Number(a.value) - Number(b.value));
}

async function automationDocs(ctx: Ctx): Promise<Option[]> {
  const out: Option[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.ssm.send(new ListDocumentsCommand({ Filters: [{ Key: "DocumentType", Values: ["Automation"] }], NextToken: token, MaxResults: 50 }));
    for (const d of r.DocumentIdentifiers ?? []) if (d.Name) out.push({ value: d.Name, label: d.Name });
    token = r.NextToken;
  } while (token);
  return out;
}

export const automation: ResourceDef = {
  id: "automation",
  name: "Automation",
  singular: "automation execution",
  idField: "id",
  nameField: "id",
  description: "Runbook executions that automate maintenance, deployment and remediation tasks.",
  emptyText: "No automation executions. Execute automation to run a runbook.",
  columns: [
    { key: "id", label: "Execution ID", kind: "link" },
    { key: "document", label: "Document name", kind: "text" },
    { key: "status", label: "Status", kind: "status" },
    { key: "mode", label: "Execution mode", kind: "text" },
    { key: "start", label: "Start time", kind: "date" },
    { key: "end", label: "End time", kind: "date" },
    { key: "executedBy", label: "Executed by", kind: "arn" },
  ],
  async list(ctx) {
    const rows: Row[] = [];
    let token: string | undefined;
    do {
      const r = await ctx.clients.ssm.send(new DescribeAutomationExecutionsCommand({ NextToken: token, MaxResults: 50 }));
      for (const e of r.AutomationExecutionMetadataList ?? [])
        rows.push({
          id: e.AutomationExecutionId ?? "",
          document: e.DocumentName ?? null,
          status: e.AutomationExecutionStatus ?? null,
          mode: e.Mode ?? null,
          start: e.ExecutionStartTime ?? null,
          end: e.ExecutionEndTime ?? null,
          executedBy: e.ExecutedBy ?? null,
        });
      token = r.NextToken;
    } while (token && rows.length < 1000);
    return rows;
  },
  async get(ctx, id) {
    const r = await ctx.clients.ssm.send(new GetAutomationExecutionCommand({ AutomationExecutionId: id }));
    const e = r.AutomationExecution;
    if (!e) throw new Error(`AutomationExecutionNotFoundException: ${id}`);
    return {
      summary: {
        "Execution ID": id,
        "Document name": e.DocumentName ?? null,
        "Document version": e.DocumentVersion ?? null,
        Status: e.AutomationExecutionStatus ?? null,
        "Execution mode": e.Mode ?? null,
        "Start time": e.ExecutionStartTime ?? null,
        "End time": e.ExecutionEndTime ?? null,
        "Executed by": e.ExecutedBy ?? null,
        "Failure message": e.FailureMessage ?? null,
      },
      tabs: [
        {
          id: "steps",
          label: "Executed steps",
          kind: "table",
          data: (e.StepExecutions ?? []).map((s, i) => ({
            n: i + 1,
            id: s.StepExecutionId ?? null,
            name: s.StepName ?? null,
            action: s.Action ?? null,
            status: s.StepStatus ?? null,
            start: s.ExecutionStartTime ?? null,
            end: s.ExecutionEndTime ?? null,
            failure: s.FailureMessage ?? null,
          })),
          columns: [
            { key: "n", label: "Step #", kind: "count" },
            { key: "name", label: "Step name", kind: "text" },
            { key: "action", label: "Action", kind: "text" },
            { key: "status", label: "Status", kind: "status" },
            { key: "start", label: "Start time", kind: "date" },
            { key: "end", label: "End time", kind: "date" },
            { key: "failure", label: "Failure message", kind: "text" },
          ],
          emptyText: "No steps have run yet.",
        },
        { id: "inputs", label: "Input parameters", kind: "json", data: e.Parameters ?? {} },
        { id: "outputs", label: "Outputs", kind: "json", data: e.Outputs ?? {} },
      ],
    };
  },
  create: {
    title: "Execute automation",
    description: "Runs an Automation runbook with simple execution (all targets, one run).",
    fields: [
      { name: "document", label: "Automation document", kind: "select", required: true, options: automationDocs },
      { name: "version", label: "Document version", kind: "text", default: "$DEFAULT" },
      { name: "parameters", label: "Input parameters", kind: "json", default: "{}", help: 'JSON object, e.g. {"InstanceId": ["i-0123456789abcdef0"], "AutomationAssumeRole": ["arn:aws:iam::…:role/…"]}.' },
    ],
    async run(ctx, v) {
      const r = await ctx.clients.ssm.send(
        new StartAutomationExecutionCommand({
          DocumentName: String(v.document),
          DocumentVersion: typeof v.version === "string" && v.version !== "" ? v.version : undefined,
          Parameters: parseDocParameters(String(v.parameters ?? "")),
        })
      );
      if (!r.AutomationExecutionId) throw new Error("Systems Manager returned no execution ID.");
      return r.AutomationExecutionId;
    },
  },
  actions: [
    {
      id: "stop",
      label: "Cancel execution",
      danger: true,
      availableFor: (row) => {
        const st = row.status ?? row.Status;
        return st === undefined || st === null || ["Pending", "InProgress", "Waiting", "Scheduled", "RunbookInProgress", "PendingApproval", "Approved", "PendingChangeCalendarOverride", "ChangeCalendarOverrideApproved", "Cancelling"].includes(String(st));
      },
      confirm: "Stops the execution. Steps already run are not undone.",
      async run(ctx, id) {
        await ctx.clients.ssm.send(new StopAutomationExecutionCommand({ AutomationExecutionId: id, Type: "Cancel" }));
        return { message: `Cancel requested for ${id}.` };
      },
    },
  ],
};
