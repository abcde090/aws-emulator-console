/** Security Hub CSPM findings: list, details, history, workflow status and severity updates, ASFF import. */

import { BatchImportFindingsCommand, BatchUpdateFindingsCommand, GetFindingHistoryCommand, GetFindingsCommand, type AwsSecurityFinding } from "@aws-sdk/client-securityhub";
import type { Ctx, FieldValues, ResourceDef, Row } from "../../console/types.ts";
import { principalArn } from "../../lib/permissions.ts";
import { needHub, str } from "./hub.ts";
import { buildAsff, isSeverity, isWorkflowStatus, SEVERITY_LABELS, WORKFLOW_STATUSES } from "./helpers.ts";

const MAX_FINDINGS = 1000;

async function listFindings(ctx: Ctx): Promise<AwsSecurityFinding[]> {
  const out: AwsSecurityFinding[] = [];
  let token: string | undefined;
  do {
    const r = await needHub(() =>
      ctx.clients.securityhub.send(new GetFindingsCommand({ MaxResults: 100, NextToken: token, SortCriteria: [{ Field: "UpdatedAt", SortOrder: "desc" }] }))
    );
    out.push(...(r.Findings ?? []));
    token = r.NextToken || undefined;
  } while (token && out.length < MAX_FINDINGS);
  return out;
}

async function oneFinding(ctx: Ctx, id: string): Promise<AwsSecurityFinding> {
  const r = await needHub(() => ctx.clients.securityhub.send(new GetFindingsCommand({ Filters: { Id: [{ Value: id, Comparison: "EQUALS" }] }, MaxResults: 1 })));
  const f = r.Findings?.[0];
  if (!f) throw new Error(`No finding with ID ${id}.`);
  return f;
}

function findingRow(f: AwsSecurityFinding): Row {
  return {
    id: f.Id ?? "",
    severity: f.Severity?.Label ?? null,
    workflow: f.Workflow?.Status ?? null,
    recordState: f.RecordState ?? null,
    title: f.Title ?? "",
    resourceType: f.Resources?.[0]?.Type ?? null,
    resourceId: f.Resources?.[0]?.Id ?? null,
    compliance: f.Compliance?.Status ?? null,
    product: f.ProductName ?? f.ProductArn?.split("/").slice(-2).join("/") ?? null,
    updated: f.UpdatedAt ?? null,
  };
}

const ident = (f: AwsSecurityFinding) => ({ Id: f.Id, ProductArn: f.ProductArn });

export const findings: ResourceDef = {
  id: "findings",
  name: "Findings",
  singular: "finding",
  idField: "id",
  nameField: "title",
  description: "Findings from Security Hub CSPM controls and integrated products, newest first (up to 1,000).",
  emptyText: "No findings. Import an ASFF finding, or enable standards and wait for control checks.",
  columns: [
    { key: "severity", label: "Severity", kind: "status" },
    { key: "workflow", label: "Workflow status", kind: "text" },
    { key: "recordState", label: "Record state", kind: "text" },
    { key: "title", label: "Title", kind: "link" },
    { key: "resourceType", label: "Resource type", kind: "text" },
    { key: "resourceId", label: "Resource", kind: "text" },
    { key: "compliance", label: "Compliance status", kind: "text" },
    { key: "product", label: "Product", kind: "text" },
    { key: "updated", label: "Updated", kind: "date" },
  ],
  async list(ctx) {
    return (await listFindings(ctx)).map(findingRow);
  },
  async get(ctx, id) {
    const f = await oneFinding(ctx, id);
    const history = await ctx.clients.securityhub.send(new GetFindingHistoryCommand({ FindingIdentifier: ident(f), MaxResults: 100 }));
    return {
      summary: {
        Title: f.Title, Severity: f.Severity?.Label ?? null, "Workflow status": f.Workflow?.Status ?? null, "Record state": f.RecordState ?? null,
        "Finding ID": f.Id, "Product ARN": f.ProductArn, "Account ID": f.AwsAccountId, Region: f.Region ?? null,
      },
      tabs: [
        {
          id: "overview", label: "Overview", kind: "keyvalue",
          data: {
            Description: f.Description ?? null, Types: (f.Types ?? []).join(", ") || null, "Generator ID": f.GeneratorId ?? null,
            "Created at": f.CreatedAt ?? null, "Updated at": f.UpdatedAt ?? null, "Compliance status": f.Compliance?.Status ?? null,
            "Verification state": f.VerificationState ?? null, Note: f.Note?.Text ?? null, "Note updated by": f.Note?.UpdatedBy ?? null,
          },
        },
        {
          id: "resources", label: "Resources", kind: "table",
          columns: [{ key: "type", label: "Type", kind: "text" }, { key: "id", label: "ID", kind: "text" }, { key: "region", label: "Region", kind: "text" }],
          data: (f.Resources ?? []).map((r) => ({ type: r.Type ?? "", id: r.Id ?? "", region: r.Region ?? null })),
          emptyText: "No resources.",
        },
        {
          id: "history", label: "History", kind: "table",
          columns: [{ key: "time", label: "Time", kind: "date" }, { key: "source", label: "Source", kind: "text" }, { key: "identity", label: "Identity", kind: "text" }, { key: "changes", label: "Changes", kind: "code" }],
          data: (history.Records ?? []).map((h) => ({
            time: h.UpdateTime ?? null, source: h.UpdateSource?.Type ?? null, identity: h.UpdateSource?.Identity ?? null,
            changes: h.FindingCreated ? "Finding created" : (h.Updates ?? []).map((u) => `${u.UpdatedField ?? "?"}: ${u.OldValue ?? "-"} -> ${u.NewValue ?? "-"}`).join("; "),
          })),
          emptyText: "No history.",
        },
        { id: "json", label: "JSON", kind: "json", data: f },
      ],
    };
  },
  create: {
    title: "Import finding",
    description: "Sends one finding in the AWS Security Finding Format (ASFF) with BatchImportFindings, using your account's default product ARN.",
    fields: [
      { name: "id", label: "Finding ID", kind: "text", required: true, section: "Finding", help: "Unique per product. Importing the same ID again updates the finding.", validate: { pattern: "[^\\s]{1,512}", message: "Up to 512 characters with no spaces." } },
      { name: "title", label: "Title", kind: "text", required: true, section: "Finding", validate: { max: 256, message: "At most 256 characters." } },
      { name: "description", label: "Description", kind: "textarea", required: true, section: "Finding", validate: { max: 1024, message: "At most 1024 characters." } },
      { name: "severity", label: "Severity", kind: "select", required: true, default: "MEDIUM", section: "Finding", options: SEVERITY_LABELS.map((s) => ({ value: s, label: s })) },
      {
        name: "type", label: "Finding type", kind: "select", required: true, default: "Software and Configuration Checks/Vulnerabilities/CVE", section: "Finding",
        options: [
          "Software and Configuration Checks/Vulnerabilities/CVE",
          "Software and Configuration Checks/AWS Security Best Practices",
          "Software and Configuration Checks/Industry and Regulatory Standards",
          "TTPs/Initial Access",
          "Effects/Data Exposure",
          "Unusual Behaviors/User",
          "Sensitive Data Identifications/PII",
        ].map((t) => ({ value: t, label: t })),
      },
      { name: "generatorId", label: "Generator ID", kind: "text", default: "custom-import", section: "Finding" },
      { name: "resourceType", label: "Resource type", kind: "select", default: "AwsS3Bucket", section: "Resource", options: ["AwsS3Bucket", "AwsEc2Instance", "AwsIamRole", "AwsIamUser", "AwsLambdaFunction", "AwsAccount", "Other"].map((t) => ({ value: t, label: t })) },
      { name: "resourceId", label: "Resource ID", kind: "text", required: true, section: "Resource", placeholder: "arn:aws:s3:::my-bucket" },
    ],
    async run(ctx, v) {
      const severity = isSeverity(v.severity) ? v.severity : "MEDIUM";
      const doc = buildAsff({
        id: str(v.id), title: str(v.title), description: str(v.description), severity, type: str(v.type), resourceType: str(v.resourceType),
        resourceId: str(v.resourceId), generatorId: str(v.generatorId), region: ctx.region, account: ctx.accountId, now: new Date().toISOString(),
      });
      const r = await needHub(() => ctx.clients.securityhub.send(new BatchImportFindingsCommand({ Findings: [doc as unknown as AwsSecurityFinding] })));
      if (r.FailedCount) throw new Error(`Import failed: ${(r.FailedFindings ?? []).map((f) => `${f.ErrorCode ?? "Error"}: ${f.ErrorMessage ?? ""}`).join("; ")}`);
      return str(v.id);
    },
  },
  actions: [
    {
      id: "workflow",
      label: "Set workflow status",
      fields: [
        { name: "status", label: "Workflow status", kind: "radio", required: true, default: "NOTIFIED", options: WORKFLOW_STATUSES.map((s) => ({ value: s, label: s })) },
        { name: "note", label: "Note", kind: "textarea", validate: { max: 512, message: "At most 512 characters." } },
      ],
      async initialValues(ctx, id): Promise<FieldValues> {
        const status = (await oneFinding(ctx, id)).Workflow?.Status;
        return isWorkflowStatus(status) ? { status } : {};
      },
      async run(ctx, id, v) {
        const f = await oneFinding(ctx, id);
        const status = isWorkflowStatus(v.status) ? v.status : "NOTIFIED";
        const note = str(v.note);
        const r = await ctx.clients.securityhub.send(
          new BatchUpdateFindingsCommand({ FindingIdentifiers: [ident(f)], Workflow: { Status: status }, Note: note ? { Text: note, UpdatedBy: principalArn(ctx.identity) } : undefined })
        );
        if (r.UnprocessedFindings?.length) throw new Error(`Not updated: ${r.UnprocessedFindings.map((u) => `${u.ErrorCode ?? ""} ${u.ErrorMessage ?? ""}`).join("; ")}`);
        return { message: `Workflow status set to ${status}.` };
      },
    },
    {
      id: "severity",
      label: "Set severity",
      fields: [{ name: "severity", label: "Severity", kind: "select", required: true, options: SEVERITY_LABELS.map((s) => ({ value: s, label: s })) }],
      async initialValues(ctx, id): Promise<FieldValues> {
        const label = (await oneFinding(ctx, id)).Severity?.Label;
        return isSeverity(label) ? { severity: label } : {};
      },
      async run(ctx, id, v) {
        const f = await oneFinding(ctx, id);
        const label = isSeverity(v.severity) ? v.severity : "MEDIUM";
        const r = await ctx.clients.securityhub.send(new BatchUpdateFindingsCommand({ FindingIdentifiers: [ident(f)], Severity: { Label: label } }));
        if (r.UnprocessedFindings?.length) throw new Error(`Not updated: ${r.UnprocessedFindings.map((u) => `${u.ErrorCode ?? ""} ${u.ErrorMessage ?? ""}`).join("; ")}`);
        return { message: `Severity set to ${label}.` };
      },
    },
  ],
};
