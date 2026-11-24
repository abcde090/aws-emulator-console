/**
 * Reads for the hand-built pipeline screen, as plain serialisable values. Server only;
 * every call uses the permission-checked CodePipeline client.
 */

import { GetPipelineCommand, GetPipelineStateCommand, ListActionExecutionsCommand, ListPipelineExecutionsCommand } from "@aws-sdk/client-codepipeline";
import { clients } from "../../lib/aws.ts";
import { errorMessage } from "../../console/serialize.ts";
import type { Result } from "../../console/types.ts";

export interface ActionView {
  name: string;
  provider: string;
  category: string;
  status: string | null;
  summary: string | null;
  lastChange: string | null;
  externalId: string | null;
  token: string | null;
  error: string | null;
}

export interface StageView {
  name: string;
  transitionEnabled: boolean;
  disabledReason: string | null;
  executionId: string | null;
  status: string | null;
  actions: ActionView[];
}

export interface PipelineView {
  name: string;
  version: number | null;
  structureJson: string;
  stages: StageView[];
}

export interface ExecutionRow {
  id: string;
  status: string | null;
  statusSummary: string | null;
  trigger: string | null;
  sourceRevisions: string | null;
  started: string | null;
  updated: string | null;
}

export interface ActionExecutionRow {
  stage: string;
  action: string;
  status: string | null;
  provider: string | null;
  started: string | null;
  updated: string | null;
  summary: string | null;
  externalId: string | null;
  error: string | null;
}

const iso = (d: Date | undefined): string | null => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null);

async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

export function readPipelineView(name: string): Promise<Result<PipelineView>> {
  return attempt(async () => {
    const cp = clients.codepipeline;
    const [def, state] = await Promise.all([cp.send(new GetPipelineCommand({ name })), cp.send(new GetPipelineStateCommand({ name }))]);
    const decl = def.pipeline;
    if (!decl) throw new Error(`CodePipeline returned no pipeline ${name}.`);
    const stateByStage = new Map((state.stageStates ?? []).map((s) => [s.stageName ?? "", s]));
    const stages: StageView[] = (decl.stages ?? []).map((s) => {
      const st = stateByStage.get(s.name ?? "");
      const actionStates = new Map((st?.actionStates ?? []).map((a) => [a.actionName ?? "", a]));
      return {
        name: s.name ?? "",
        transitionEnabled: st?.inboundTransitionState?.enabled !== false,
        disabledReason: st?.inboundTransitionState?.disabledReason ?? null,
        executionId: st?.latestExecution?.pipelineExecutionId ?? null,
        status: st?.latestExecution?.status ?? null,
        actions: (s.actions ?? []).map((a) => {
          const ex = actionStates.get(a.name ?? "")?.latestExecution;
          return {
            name: a.name ?? "",
            provider: a.actionTypeId?.provider ?? "",
            category: a.actionTypeId?.category ?? "",
            status: ex?.status ?? null,
            summary: ex?.summary ?? null,
            lastChange: iso(ex?.lastStatusChange),
            externalId: ex?.externalExecutionId ?? null,
            token: ex?.token ?? null,
            error: ex?.errorDetails?.message ?? null,
          };
        }),
      };
    });
    return { name: decl.name ?? name, version: decl.version ?? null, structureJson: JSON.stringify(decl, null, 2), stages };
  });
}

export function readExecutions(name: string): Promise<Result<ExecutionRow[]>> {
  return attempt(async () => {
    const r = await clients.codepipeline.send(new ListPipelineExecutionsCommand({ pipelineName: name, maxResults: 50 }));
    return (r.pipelineExecutionSummaries ?? []).map((e) => ({
      id: e.pipelineExecutionId ?? "",
      status: e.status ?? null,
      statusSummary: e.statusSummary ?? null,
      trigger: e.trigger?.triggerType ?? null,
      sourceRevisions: (e.sourceRevisions ?? []).map((s) => `${s.actionName ?? "Source"}: ${(s.revisionId ?? "").slice(0, 8)}`).join(", ") || null,
      started: iso(e.startTime),
      updated: iso(e.lastUpdateTime),
    }));
  });
}

export function readActionExecutions(name: string, executionId: string): Promise<Result<ActionExecutionRow[]>> {
  return attempt(async () => {
    const r = await clients.codepipeline.send(new ListActionExecutionsCommand({ pipelineName: name, filter: { pipelineExecutionId: executionId } }));
    return (r.actionExecutionDetails ?? [])
      .map((d) => ({
        stage: d.stageName ?? "",
        action: d.actionName ?? "",
        status: d.status ?? null,
        provider: d.input?.actionTypeId?.provider ?? null,
        started: iso(d.startTime),
        updated: iso(d.lastUpdateTime),
        summary: d.output?.executionResult?.externalExecutionSummary ?? null,
        externalId: d.output?.executionResult?.externalExecutionId ?? null,
        error: d.output?.executionResult?.errorDetails?.message ?? null,
      }))
      .sort((a, b) => (a.started ?? "").localeCompare(b.started ?? ""));
  });
}
