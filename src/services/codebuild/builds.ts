/** CodeBuild build history: every build run, with phases and CloudWatch logs. */

import { BatchDeleteBuildsCommand, BatchGetBuildsCommand, ListBuildsCommand, RetryBuildCommand, StopBuildCommand, type Build, type CodeBuildClient } from "@aws-sdk/client-codebuild";
import { GetLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import type { Ctx, ResourceDef, Row } from "../../console/types.ts";
import { durationSeconds, formatDuration, sourceLabel } from "./helpers.ts";

const MAX_LOG_EVENTS = 10_000;

export async function getBuilds(cb: CodeBuildClient, ids: string[]): Promise<Build[]> {
  const out: Build[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const r = await cb.send(new BatchGetBuildsCommand({ ids: ids.slice(i, i + 100) }));
    out.push(...(r.builds ?? []));
  }
  return out;
}

async function getBuild(cb: CodeBuildClient, id: string): Promise<Build> {
  const [b] = await getBuilds(cb, [id]);
  if (!b) throw new Error(`Build ${id} was not found.`);
  return b;
}

export function buildRow(b: Build): Row {
  return {
    id: b.id ?? "",
    status: b.buildStatus ?? null,
    buildNumber: b.buildNumber ?? null,
    project: b.projectName ?? null,
    sourceVersion: b.resolvedSourceVersion ?? b.sourceVersion ?? null,
    initiator: b.initiator ?? null,
    duration: formatDuration(durationSeconds(b.startTime, b.endTime)),
    started: b.startTime ?? null,
    completed: b.endTime ?? null,
  };
}

/** The build's CloudWatch Logs stream as text, oldest first. */
async function readLog(ctx: Ctx, b: Build): Promise<{ text: string; note: string }> {
  const group = b.logs?.groupName;
  const stream = b.logs?.streamName;
  if (!group || !stream) return { text: "", note: "This build has no CloudWatch Logs stream." };
  try {
    return await readStream(ctx, group, stream);
  } catch (e) {
    // A denied or failed log read must not hide the build itself.
    return { text: "", note: `The build log is unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function readStream(ctx: Ctx, group: string, stream: string): Promise<{ text: string; note: string }> {
  const lines: string[] = [];
  let token: string | undefined;
  for (;;) {
    const r = await ctx.clients.logs.send(new GetLogEventsCommand({ logGroupName: group, logStreamName: stream, startFromHead: true, nextToken: token }));
    for (const e of r.events ?? []) lines.push(e.message ?? "");
    if (!r.nextForwardToken || r.nextForwardToken === token || (r.events ?? []).length === 0 || lines.length >= MAX_LOG_EVENTS) break;
    token = r.nextForwardToken;
  }
  return { text: lines.join("\n"), note: `Log group ${group}, stream ${stream}${lines.length >= MAX_LOG_EVENTS ? ` (first ${MAX_LOG_EVENTS} events)` : ""}.` };
}

export const builds: ResourceDef = {
  id: "build-history",
  name: "Build history",
  singular: "build",
  idField: "id",
  nameField: "id",
  description: "Every build run in this account, newest first (up to 100).",
  emptyText: "No builds. Start a build from a build project.",
  columns: [
    { key: "id", label: "Build run", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "buildNumber", label: "Build number", kind: "count" },
    { key: "project", label: "Project", kind: "text" },
    { key: "sourceVersion", label: "Source version", kind: "code" },
    { key: "initiator", label: "Submitter", kind: "text" },
    { key: "duration", label: "Duration", kind: "text" },
    { key: "completed", label: "Completed", kind: "date" },
  ],

  async list(ctx) {
    const r = await ctx.clients.codebuild.send(new ListBuildsCommand({ sortOrder: "DESCENDING" }));
    const bs = await getBuilds(ctx.clients.codebuild, (r.ids ?? []).slice(0, 100));
    return bs.map(buildRow);
  },

  async get(ctx, id) {
    const b = await getBuild(ctx.clients.codebuild, id);
    const log = await readLog(ctx, b);
    const row = buildRow(b);
    return {
      summary: {
        id: b.id ?? id,
        status: b.buildStatus ?? null,
        project: b.projectName ?? null,
        buildNumber: b.buildNumber ?? null,
        initiator: b.initiator ?? null,
        started: b.startTime ?? null,
        completed: b.endTime ?? null,
        duration: row.duration,
      },
      summaryLabels: { id: "Build ID", status: "Status", project: "Build project", buildNumber: "Build number", initiator: "Initiator", started: "Start time", completed: "End time", duration: "Duration" },
      tabs: [
        {
          id: "logs",
          label: "Build logs",
          kind: "text",
          data: log.text,
          description: log.note,
          emptyText: "No log events yet. Refresh while the build runs.",
        },
        {
          id: "phases",
          label: "Phase details",
          kind: "table",
          columns: [
            { key: "name", label: "Name", kind: "text" },
            { key: "status", label: "Status", kind: "status" },
            { key: "context", label: "Context", kind: "text" },
            { key: "duration", label: "Duration", kind: "text" },
            { key: "start", label: "Start time", kind: "date" },
            { key: "end", label: "End time", kind: "date" },
          ],
          data: (b.phases ?? []).map((p) => ({
            name: p.phaseType ?? "",
            status: p.phaseStatus ?? (p.endTime ? null : "IN_PROGRESS"),
            context: (p.contexts ?? []).map((c) => [c.statusCode, c.message].filter(Boolean).join(": ")).filter(Boolean).join("; ") || null,
            duration: formatDuration(p.durationInSeconds ?? null),
            start: p.startTime ?? null,
            end: p.endTime ?? null,
          })),
          emptyText: "No phases reported yet.",
        },
        {
          id: "details",
          label: "Build details",
          kind: "keyvalue",
          data: {
            "Build ARN": b.arn ?? null,
            "Current phase": b.currentPhase ?? null,
            "Build complete": b.buildComplete ?? null,
            "Source provider": sourceLabel(b.source?.type),
            "Source location": b.source?.location ?? null,
            "Source version": b.sourceVersion ?? null,
            "Resolved source version": b.resolvedSourceVersion ?? null,
            Image: b.environment?.image ?? null,
            "Compute type": b.environment?.computeType ?? null,
            "Service role": b.serviceRole ?? null,
            "Timeout (minutes)": b.timeoutInMinutes ?? null,
            "Queued timeout (minutes)": b.queuedTimeoutInMinutes ?? null,
            "Artifacts location": b.artifacts?.location || null,
            "Encryption key": b.encryptionKey ?? null,
          },
        },
        {
          id: "env",
          label: "Environment variables",
          kind: "table",
          columns: [
            { key: "name", label: "Name", kind: "text" },
            { key: "value", label: "Value", kind: "code" },
            { key: "type", label: "Type", kind: "text" },
          ],
          data: (b.environment?.environmentVariables ?? []).map((e) => ({ name: e.name ?? "", value: e.value ?? "", type: e.type ?? "PLAINTEXT" })),
          emptyText: "No environment variables.",
        },
        { id: "buildspec", label: "Buildspec", kind: "text", data: b.source?.buildspec ?? "", emptyText: "This build used the buildspec file from its source." },
      ],
    };
  },

  actions: [
    {
      id: "stop",
      label: "Stop build",
      danger: true,
      availableFor: (row) => row.status === undefined || row.status === "IN_PROGRESS",
      confirm: "Stops the build if it is still running.",
      async run(ctx, id) {
        const r = await ctx.clients.codebuild.send(new StopBuildCommand({ id }));
        return { message: `Build is now ${r.build?.buildStatus ?? "unknown"} (phase ${r.build?.currentPhase ?? "-"}).` };
      },
    },
    {
      id: "retry",
      label: "Retry build",
      async run(ctx, id) {
        const r = await ctx.clients.codebuild.send(new RetryBuildCommand({ id }));
        return { message: `Started build ${r.build?.id ?? "(no ID returned)"} with the same settings.` };
      },
    },
  ],

  delete: {
    confirmText: "delete",
    async run(ctx, id) {
      const r = await ctx.clients.codebuild.send(new BatchDeleteBuildsCommand({ ids: [id] }));
      const failed = r.buildsNotDeleted ?? [];
      if (failed.length) throw new Error(`Not deleted: ${failed.map((f) => `${f.id ?? id}: ${f.statusCode ?? "error"}`).join("; ")}`);
    },
  },
};
