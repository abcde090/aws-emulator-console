/** Step Functions executions (Standard workflows): status, input, output, event history, stop, redrive. */

import {
  DescribeExecutionCommand,
  GetExecutionHistoryCommand,
  ListExecutionsCommand,
  RedriveExecutionCommand,
  StartExecutionCommand,
  StopExecutionCommand,
  type ExecutionListItem,
  type HistoryEvent,
} from "@aws-sdk/client-sfn";
import type { Ctx, ResourceDef, Row } from "../../console/types.ts";
import { secondary, unavailableText } from "../../console/secondary.ts";
import { canRedrive, canStop, historyRows, isoOrNull, parseJsonText, text, type HistoryEventLike } from "./helpers.ts";
import { listStateMachines } from "./state-machines.ts";

export async function listExecutionsOf(ctx: Ctx, stateMachineArn: string, limit = 1000): Promise<ExecutionListItem[]> {
  const out: ExecutionListItem[] = [];
  let token: string | undefined;
  do {
    const page = await ctx.clients.sfn.send(new ListExecutionsCommand({ stateMachineArn, nextToken: token, maxResults: 100 }));
    out.push(...(page.executions ?? []));
    token = page.nextToken;
  } while (token && out.length < limit);
  return out;
}

export function executionRow(e: ExecutionListItem): Row {
  const start = e.startDate ? new Date(e.startDate).getTime() : NaN;
  const stop = e.stopDate ? new Date(e.stopDate).getTime() : NaN;
  return {
    name: e.name ?? null,
    arn: e.executionArn ?? null,
    status: e.status ?? null,
    stateMachine: e.stateMachineArn ? e.stateMachineArn.slice(e.stateMachineArn.lastIndexOf(":") + 1) : null,
    started: isoOrNull(e.startDate),
    ended: isoOrNull(e.stopDate),
    duration: Number.isFinite(start) && Number.isFinite(stop) ? `${((stop - start) / 1000).toFixed(3)} s` : null,
  };
}

async function history(ctx: Ctx, arn: string): Promise<HistoryEvent[]> {
  const out: HistoryEvent[] = [];
  let token: string | undefined;
  do {
    const page = await ctx.clients.sfn.send(new GetExecutionHistoryCommand({ executionArn: arn, nextToken: token, maxResults: 1000 }));
    out.push(...(page.events ?? []));
    token = page.nextToken;
  } while (token && out.length < 25000);
  return out;
}

export const executions: ResourceDef = {
  id: "executions",
  name: "Executions",
  singular: "execution",
  idField: "arn",
  nameField: "Name",
  description: "Executions of every Standard state machine. Express executions are not stored, so they are not listed.",
  emptyText: "No executions. Start one from a state machine.",
  columns: [
    { key: "name", label: "Name", kind: "link" },
    { key: "status", label: "Status", kind: "status" },
    { key: "stateMachine", label: "State machine", kind: "text" },
    { key: "started", label: "Start time", kind: "date" },
    { key: "ended", label: "End time", kind: "date" },
    { key: "duration", label: "Duration", kind: "text" },
    { key: "arn", label: "ARN", kind: "arn", hidden: true },
  ],

  async list(ctx) {
    const machines = (await listStateMachines(ctx)).filter((m) => m.type !== "EXPRESS" && m.stateMachineArn);
    const lists = await Promise.all(machines.map((m) => listExecutionsOf(ctx, m.stateMachineArn as string, 200)));
    return lists.flat().map(executionRow);
  },

  async get(ctx, arn) {
    const e = await ctx.clients.sfn.send(new DescribeExecutionCommand({ executionArn: arn }));
    const historyResult = await secondary(history(ctx, arn));
    const events = historyResult.ok ? historyResult.value : [];
    const row = executionRow({ executionArn: e.executionArn, stateMachineArn: e.stateMachineArn, name: e.name, status: e.status, startDate: e.startDate, stopDate: e.stopDate });
    return {
      summary: {
        Name: e.name ?? null,
        "Execution status": e.status ?? null,
        "Execution ARN": e.executionArn ?? arn,
        "State machine ARN": e.stateMachineArn ?? null,
        "Start time": row.started,
        "End time": row.ended,
        Duration: row.duration,
        ...(e.error ? { Error: e.error } : {}),
        ...(e.cause ? { Cause: e.cause } : {}),
        "Redrive status": e.redriveStatus ?? "-",
        "Redrive count": e.redriveCount ?? 0,
      },
      tabs: [
        {
          id: "history",
          label: historyResult.ok ? `Events (${events.length})` : "Events",
          kind: "table",
          columns: [
            { key: "id", label: "ID", kind: "text" },
            { key: "type", label: "Type", kind: "text" },
            { key: "step", label: "Step", kind: "text" },
            { key: "resource", label: "Resource", kind: "text" },
            { key: "elapsed", label: "Started after", kind: "text" },
            { key: "timestamp", label: "Timestamp", kind: "date" },
            { key: "details", label: "Details", kind: "code" },
          ],
          data: historyRows(events as HistoryEventLike[]).map((r) => ({ ...r, elapsed: r.elapsedMs === null ? null : `${r.elapsedMs} ms` })),
          description: historyResult.ok ? "Every event in the execution history (GetExecutionHistory)." : undefined,
          emptyText: unavailableText(historyResult, "No history events."),
        },
        { id: "input", label: "Execution input", kind: "json", data: parseJsonText(e.input), emptyText: "No input." },
        { id: "output", label: "Execution output", kind: "json", data: parseJsonText(e.output), emptyText: e.status === "RUNNING" ? "The execution is still running." : "No output." },
      ],
    };
  },

  actions: [
    {
      id: "stop",
      label: "Stop execution",
      danger: true,
      availableFor: canStop,
      fields: [
        { name: "error", label: "Error", kind: "text", placeholder: "Stopped.By.User" },
        { name: "cause", label: "Cause", kind: "text" },
      ],
      async run(ctx, arn, v) {
        const r = await ctx.clients.sfn.send(new StopExecutionCommand({ executionArn: arn, error: text(v.error) || undefined, cause: text(v.cause) || undefined }));
        return { message: `Execution stopped at ${isoOrNull(r.stopDate) ?? "-"}.` };
      },
    },
    {
      id: "new-execution",
      label: "New execution with same input",
      confirm: "Starts a new execution of the same state machine with this execution's input.",
      async run(ctx, arn) {
        const e = await ctx.clients.sfn.send(new DescribeExecutionCommand({ executionArn: arn }));
        if (!e.stateMachineArn) throw new Error("Step Functions returned no state machine ARN.");
        const r = await ctx.clients.sfn.send(new StartExecutionCommand({ stateMachineArn: e.stateMachineArn, input: e.input ?? "{}" }));
        return { message: `Execution started: ${r.executionArn ?? "-"}` };
      },
    },
    {
      id: "redrive",
      label: "Redrive",
      availableFor: canRedrive,
      confirm: "Restarts a failed, timed-out or aborted execution from the step that failed.",
      async run(ctx, arn) {
        const r = await ctx.clients.sfn.send(new RedriveExecutionCommand({ executionArn: arn }));
        return { message: `Redrive started at ${isoOrNull(r.redriveDate) ?? "-"}.` };
      },
    },
  ],
};
