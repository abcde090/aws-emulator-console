/** Server-side data for the hand-built state machine page, through the permission-checked clients. */

import { DescribeExecutionCommand, DescribeStateMachineCommand, DescribeStateMachineForExecutionCommand, GetExecutionHistoryCommand } from "@aws-sdk/client-sfn";
import { makeCtx } from "../../console/server.ts";
import { errorMessage, toPlain } from "../../console/serialize.ts";
import type { Result, Row } from "../../console/types.ts";
import { executionRow, listExecutionsOf } from "./executions.ts";
import type { HistoryEventLike } from "./helpers.ts";

export interface StateMachinePageData {
  definition: string | null;
  definitionError: string | null;
  express: boolean;
  executions: Row[] | null;
  executionsError: string | null;
}

async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

export async function loadStateMachinePage(arn: string): Promise<StateMachinePageData> {
  const ctx = await makeCtx();
  const d = await attempt(() => ctx.clients.sfn.send(new DescribeStateMachineCommand({ stateMachineArn: arn })));
  const express = d.ok && d.data.type === "EXPRESS";
  const ex = express ? null : await attempt(async () => (await listExecutionsOf(ctx, arn, 1000)).map(executionRow));
  return {
    definition: d.ok ? d.data.definition ?? null : null,
    definitionError: d.ok ? null : d.error,
    express,
    executions: ex?.ok ? ex.data : null,
    executionsError: ex && !ex.ok ? ex.error : null,
  };
}

export interface ExecutionGraphData {
  definition: string | null;
  status: string;
  events: HistoryEventLike[];
  error: string | null;
}

/** The definition this execution ran (DescribeStateMachineForExecution) and its event history, for the Graph view. */
export async function loadExecutionGraph(arn: string): Promise<ExecutionGraphData> {
  const ctx = await makeCtx();
  const r = await attempt(async () => {
    const [machine, execution] = await Promise.all([
      ctx.clients.sfn.send(new DescribeStateMachineForExecutionCommand({ executionArn: arn })),
      ctx.clients.sfn.send(new DescribeExecutionCommand({ executionArn: arn })),
    ]);
    const events: HistoryEventLike[] = [];
    let token: string | undefined;
    do {
      const page = await ctx.clients.sfn.send(new GetExecutionHistoryCommand({ executionArn: arn, nextToken: token, maxResults: 1000 }));
      events.push(...((toPlain(page.events ?? []) as HistoryEventLike[])));
      token = page.nextToken;
    } while (token && events.length < 25000);
    return { definition: machine.definition ?? null, status: execution.status ?? "", events };
  });
  return r.ok ? { ...r.data, error: null } : { definition: null, status: "", events: [], error: r.error };
}
