/** GuardDuty findings: list with severity, details, archive / unarchive, feedback. */

import { ArchiveFindingsCommand, GetFindingsCommand, ListFindingsCommand, UnarchiveFindingsCommand, UpdateFindingsFeedbackCommand, type Finding } from "@aws-sdk/client-guardduty";
import type { Ctx, ResourceDef, Row } from "../../console/types.ts";
import { detectorId, str } from "./detector.ts";
import { severityLabel } from "./helpers.ts";

const MAX_FINDINGS = 1000;

async function listIds(ctx: Ctx, detector: string): Promise<string[]> {
  const ids: string[] = [];
  let token: string | undefined;
  do {
    const r = await ctx.clients.guardduty.send(new ListFindingsCommand({ DetectorId: detector, MaxResults: 50, NextToken: token, SortCriteria: { AttributeName: "updatedAt", OrderBy: "DESC" } }));
    ids.push(...(r.FindingIds ?? []));
    token = r.NextToken || undefined;
  } while (token && ids.length < MAX_FINDINGS);
  return ids;
}

async function getFindings(ctx: Ctx, detector: string, ids: string[]): Promise<Finding[]> {
  const out: Finding[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await ctx.clients.guardduty.send(new GetFindingsCommand({ DetectorId: detector, FindingIds: ids.slice(i, i + 50) }));
    out.push(...(r.Findings ?? []));
  }
  return out;
}

function resourceName(f: Finding): string {
  const r = f.Resource;
  return r?.InstanceDetails?.InstanceId ?? r?.AccessKeyDetails?.UserName ?? r?.S3BucketDetails?.[0]?.Name ?? r?.EksClusterDetails?.Name ?? r?.RdsDbInstanceDetails?.DbInstanceIdentifier ?? r?.LambdaDetails?.FunctionName ?? r?.ResourceType ?? "-";
}

function findingRow(f: Finding): Row {
  return {
    id: f.Id ?? "",
    title: f.Title ?? f.Type ?? "",
    severity: severityLabel(f.Severity),
    score: f.Severity ?? null,
    type: f.Type ?? null,
    resourceType: f.Resource?.ResourceType ?? null,
    resource: resourceName(f),
    count: f.Service?.Count ?? null,
    status: f.Service?.Archived ? "Archived" : "Current",
    lastSeen: f.Service?.EventLastSeen ?? f.UpdatedAt ?? null,
    updated: f.UpdatedAt ?? null,
  };
}

async function oneFinding(ctx: Ctx, id: string): Promise<{ detector: string; finding: Finding }> {
  const detector = await detectorId(ctx);
  const [finding] = await getFindings(ctx, detector, [id]);
  if (!finding) throw new Error(`No finding with ID ${id}.`);
  return { detector, finding };
}

export const findings: ResourceDef = {
  id: "findings",
  name: "Findings",
  singular: "finding",
  idField: "id",
  nameField: "title",
  description: "Potential security issues GuardDuty found, newest first. Archived findings show Status Archived; type \"Current\" in the filter to hide them.",
  emptyText: "No findings. To see what findings look like, open Settings and choose Generate sample findings.",
  columns: [
    { key: "severity", label: "Severity", kind: "status" },
    { key: "title", label: "Finding type", kind: "link" },
    { key: "resource", label: "Resource", kind: "text" },
    { key: "lastSeen", label: "Last seen", kind: "date" },
    { key: "count", label: "Count", kind: "count" },
    { key: "status", label: "Status", kind: "text" },
    { key: "type", label: "Type", kind: "text", hidden: true },
    { key: "resourceType", label: "Resource type", kind: "text", hidden: true },
  ],
  async list(ctx) {
    const detector = await detectorId(ctx);
    return (await getFindings(ctx, detector, await listIds(ctx, detector))).map(findingRow);
  },
  async get(ctx, id) {
    const { finding: f } = await oneFinding(ctx, id);
    const row = findingRow(f);
    return {
      summary: {
        Title: f.Title, Severity: row.severity ? `${row.severity} (${f.Severity})` : null, "Finding type": f.Type, "Finding ID": f.Id,
        Status: row.status, Region: f.Region, "Account ID": f.AccountId, "Resource type": f.Resource?.ResourceType ?? null,
      },
      tabs: [
        {
          id: "overview", label: "Overview", kind: "keyvalue",
          data: {
            Description: f.Description ?? null, "Created at": f.CreatedAt ?? null, "Updated at": f.UpdatedAt ?? null,
            "First seen": f.Service?.EventFirstSeen ?? null, "Last seen": f.Service?.EventLastSeen ?? null, Count: f.Service?.Count ?? null,
            "Resource role": f.Service?.ResourceRole ?? null, "Detector ID": f.Service?.DetectorId ?? null, "User feedback": f.Service?.UserFeedback ?? null, ARN: f.Arn ?? null,
          },
        },
        { id: "resource", label: "Resource affected", kind: "json", data: f.Resource ?? null, emptyText: "No resource details." },
        { id: "action", label: "Action", kind: "json", data: f.Service?.Action ?? null, emptyText: "No action details in this finding." },
        { id: "json", label: "JSON", kind: "json", data: f },
      ],
    };
  },
  actions: [
    {
      id: "archive",
      label: "Archive",
      availableFor: (row) => (row.status ?? row.Status) !== "Archived",
      async run(ctx, id) {
        const detector = await detectorId(ctx);
        await ctx.clients.guardduty.send(new ArchiveFindingsCommand({ DetectorId: detector, FindingIds: [id] }));
        return { message: "Finding archived. Archived findings are kept for 90 days." };
      },
    },
    {
      id: "unarchive",
      label: "Unarchive",
      availableFor: (row) => (row.status ?? row.Status) !== "Current",
      async run(ctx, id) {
        const detector = await detectorId(ctx);
        await ctx.clients.guardduty.send(new UnarchiveFindingsCommand({ DetectorId: detector, FindingIds: [id] }));
        return { message: "Finding moved back to current findings." };
      },
    },
    {
      id: "feedback",
      label: "Give feedback",
      fields: [
        { name: "feedback", label: "Was this finding useful?", kind: "radio", required: true, default: "USEFUL", options: [{ value: "USEFUL", label: "Useful" }, { value: "NOT_USEFUL", label: "Not useful" }] },
        { name: "comments", label: "Comments", kind: "textarea" },
      ],
      async run(ctx, id, v) {
        const detector = await detectorId(ctx);
        await ctx.clients.guardduty.send(new UpdateFindingsFeedbackCommand({ DetectorId: detector, FindingIds: [id], Feedback: v.feedback === "NOT_USEFUL" ? "NOT_USEFUL" : "USEFUL", Comments: str(v.comments) || undefined }));
        return { message: "Feedback recorded." };
      },
    },
  ],
};
