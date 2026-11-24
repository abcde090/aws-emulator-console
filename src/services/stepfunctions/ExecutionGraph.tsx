"use client";

/**
 * Step Functions execution Graph view: the definition this execution ran, drawn as SVG,
 * each state coloured by what happened to it in the event history, like the console's
 * Graph view. Selecting a state shows its input, output and error from the events.
 */

import { useMemo, useState } from "react";
import { Container, EmptyState, ErrorBanner } from "@/console/ui/primitives";
import { JsonView } from "@/console/ui/JsonView";
import type { HistoryEventLike } from "./helpers";
import { parseJsonText } from "./helpers";
import { layoutDefinition, stateRuns, type GraphNode, type StateOutcome, type StateRun } from "./graph";

const OUTCOME: Record<StateOutcome, { label: string; fill: string; stroke: string; text: string }> = {
  succeeded: { label: "Succeeded", fill: "#e9f7ea", stroke: "#037f0c", text: "#035b09" },
  failed: { label: "Failed", fill: "#fff1f0", stroke: "#d91515", text: "#a3120f" },
  caught: { label: "Caught error", fill: "#fff6e5", stroke: "#e07700", text: "#8a4b00" },
  inProgress: { label: "In progress", fill: "#f2f8fd", stroke: "#0972d3", text: "#05509a" },
  notRun: { label: "Not run", fill: "#ffffff", stroke: "#8c8c94", text: "#5f6b7a" },
};

const LEGEND: StateOutcome[] = ["inProgress", "succeeded", "failed", "caught", "notRun"];

function outcomeOf(runs: Record<string, StateRun>, node: GraphNode, executionStatus: string): StateOutcome {
  if (node.type === "Start") return "succeeded";
  if (node.type === "End") return executionStatus === "SUCCEEDED" ? "succeeded" : "notRun";
  return runs[node.name]?.outcome ?? "notRun";
}

function Payload({ title, value, testId }: { title: string; value: string | null; testId: string }) {
  return (
    <div className="space-y-1" data-testid={testId}>
      <h4 className="text-[13px] font-bold text-ink">{title}</h4>
      {value === null ? <p className="text-[13px] text-muted">-</p> : <JsonView value={parseJsonText(value)} />}
    </div>
  );
}

function StepDetails({ node, run, executionStatus }: { node: GraphNode; run: StateRun | undefined; executionStatus: string }) {
  const outcome = run?.outcome ?? "notRun";
  return (
    <div className="space-y-3" data-testid="step-details">
      <div>
        <h3 className="text-[15px] font-bold text-ink">{node.name}</h3>
        <p className="text-[12px] text-muted">{node.type} state</p>
      </div>
      <p className="text-[13px]">
        <span className="font-semibold">Status: </span>
        <span style={{ color: OUTCOME[outcome].text }} data-testid="step-status">{OUTCOME[outcome].label}</span>
        {run && run.entered > 1 && <span className="text-muted"> (entered {run.entered} times)</span>}
        {run && run.failures > 0 && <span className="text-muted"> ({run.failures} failed attempt{run.failures === 1 ? "" : "s"})</span>}
      </p>
      {!run ? (
        <p className="text-[13px] text-muted">{executionStatus === "RUNNING" ? "This state hasn't run yet." : "This state didn't run in this execution."}</p>
      ) : (
        <>
          {(run.error || run.cause) && (
            <div className="space-y-1 rounded-[2px] border border-l-4 border-bad bg-bad-bg px-3 py-2 text-[13px]" data-testid="step-error">
              <p><span className="font-semibold">Error: </span>{run.error ?? "-"}</p>
              {run.cause && <p className="break-words whitespace-pre-wrap"><span className="font-semibold">Cause: </span>{run.cause}</p>}
            </div>
          )}
          <Payload title="Input" value={run.input} testId="step-input" />
          <Payload title="Output" value={run.output} testId="step-output" />
        </>
      )}
    </div>
  );
}

interface ExecutionGraphProps {
  definition: string | null;
  events: HistoryEventLike[];
  status: string;
  error: string | null;
}

export function ExecutionGraph({ definition, events, status, error }: ExecutionGraphProps) {
  const layout = useMemo(() => layoutDefinition(definition), [definition]);
  const runs = useMemo(() => stateRuns(events, status), [events, status]);
  const [selected, setSelected] = useState<string | null>(null);
  if (error) return <ErrorBanner title="Could not load the graph" message={error} />;
  if (!layout) return <EmptyState title="No graph">The state machine definition could not be read as Amazon States Language.</EmptyState>;
  const node = layout.nodes.find((n) => n.name === selected && n.type !== "Start" && n.type !== "End") ?? null;
  // Containers first, so their branches draw on top.
  const ordered = [...layout.nodes].sort((a, b) => Number(b.container) - Number(a.container) || a.depth - b.depth);

  return (
    <Container title="Graph view" description="The definition this execution ran, coloured by each state's outcome in the event history. Choose a state to see its input, output and error.">
      <div className="flex flex-wrap items-center gap-4 pb-3 text-[12px]" aria-label="Legend">
        {LEGEND.map((o) => (
          <span key={o} className="inline-flex items-center gap-1.5">
            <span className="inline-block size-3 rounded-[2px] border-2" style={{ background: OUTCOME[o].fill, borderColor: OUTCOME[o].stroke }} />
            {OUTCOME[o].label}
          </span>
        ))}
      </div>
      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="min-w-0 flex-1 overflow-auto rounded-[2px] border border-line-soft bg-[#fafafa]" style={{ maxHeight: "70vh" }}>
          <svg width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label="State machine graph" data-testid="sfn-graph" className="mx-auto block">
            <defs>
              <marker id="sfn-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="#5f6b7a" />
              </marker>
            </defs>
            {ordered.filter((n) => n.container).map((n) => {
              const o = OUTCOME[outcomeOf(runs, n, status)];
              return (
                <g key={`c-${n.name}`} data-testid={`graph-state-${n.name}`} data-outcome={outcomeOf(runs, n, status)} className="cursor-pointer" onClick={() => setSelected(n.name)}>
                  <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={6} fill={o.fill} fillOpacity={0.45} stroke={o.stroke} strokeWidth={selected === n.name ? 3 : 1.5} strokeDasharray="6 3" />
                  <text x={n.x + 10} y={n.y + 19} fontSize={12} fontWeight={700} fill={o.text}>{n.name}</text>
                  <text x={n.x + n.w - 10} y={n.y + 19} fontSize={11} textAnchor="end" fill="#5f6b7a">{n.type}</text>
                </g>
              );
            })}
            {layout.edges.map((e, i) => (
              <g key={`e-${i}`}>
                <path d={e.path} fill="none" stroke="#5f6b7a" strokeWidth={1.3} strokeDasharray={e.kind === "catch" ? "5 4" : undefined} markerEnd="url(#sfn-arrow)" />
                {e.label && (
                  <text x={e.labelX} y={e.labelY} fontSize={10} textAnchor="middle" fill="#414d5c" paintOrder="stroke" stroke="#fafafa" strokeWidth={3}>{e.label}</text>
                )}
              </g>
            ))}
            {ordered.filter((n) => !n.container).map((n) => {
              const outcome = outcomeOf(runs, n, status);
              const o = OUTCOME[outcome];
              if (n.type === "Start" || n.type === "End") {
                return (
                  <g key={`m-${n.name}`}>
                    <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={n.h / 2} fill={n.type === "Start" || outcome === "succeeded" ? "#414d5c" : "#fff"} stroke="#414d5c" strokeWidth={1.5} />
                    <text x={n.x + n.w / 2} y={n.y + n.h / 2 + 4} fontSize={11} textAnchor="middle" fill={n.type === "Start" || outcome === "succeeded" ? "#fff" : "#414d5c"}>{n.type}</text>
                  </g>
                );
              }
              return (
                <g
                  key={`n-${n.name}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${n.name}: ${o.label}`}
                  data-testid={`graph-state-${n.name}`}
                  data-outcome={outcome}
                  className="cursor-pointer"
                  onClick={() => setSelected(n.name)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") setSelected(n.name);
                  }}
                >
                  <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={4} fill={o.fill} stroke={o.stroke} strokeWidth={selected === n.name ? 3 : 1.5} />
                  <text x={n.x + n.w / 2} y={n.y + 15} fontSize={12} fontWeight={700} textAnchor="middle" fill={o.text}>{n.name.length > 40 ? `${n.name.slice(0, 39)}…` : n.name}</text>
                  <text x={n.x + n.w / 2} y={n.y + 29} fontSize={10} textAnchor="middle" fill="#5f6b7a">{n.type}</text>
                </g>
              );
            })}
          </svg>
        </div>
        <aside className="w-full shrink-0 rounded-[2px] border border-line-soft p-4 lg:w-96">
          {node ? <StepDetails node={node} run={runs[node.name]} executionStatus={status} /> : <p className="text-[13px] text-muted">Choose a state in the graph to see its details.</p>}
        </aside>
      </div>
    </Container>
  );
}
