/**
 * Pure helpers for the Step Functions execution Graph view: what happened to each state
 * (from the execution's event history) and a layered layout of the definition (states,
 * transitions, Choice branches, Catch edges, Parallel branches and Map processors drawn
 * inside their state). No SDK and no React, so tests import them directly.
 */

import { parseJsonText, type HistoryEventLike } from "./helpers.ts";

export type StateOutcome = "succeeded" | "failed" | "caught" | "inProgress" | "notRun";

export interface StateRun {
  name: string;
  outcome: StateOutcome;
  /** How many times the state was entered (loops, Map iterations). */
  entered: number;
  input: string | null;
  output: string | null;
  error: string | null;
  cause: string | null;
  /** Failure events (task failures, timeouts) inside the state, retried or caught. */
  failures: number;
}

function details(e: HistoryEventLike): Record<string, unknown> | null {
  for (const [k, v] of Object.entries(e)) if (k.endsWith("EventDetails") && v && typeof v === "object") return v as Record<string, unknown>;
  return null;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

const isFailure = (type: string): boolean => /(Failed|TimedOut|Aborted)$/.test(type) && !type.startsWith("MapIteration") && !type.endsWith("StateFailed");

/**
 * Each state's outcome in this execution, keyed by state name (ASL state names are unique
 * across the whole definition, branches included). A failure event belongs to the state
 * entered last on its previousEventId chain.
 */
export function stateRuns(events: HistoryEventLike[], executionStatus: string): Record<string, StateRun> {
  const byId = new Map<number, HistoryEventLike>();
  for (const e of events) if (typeof e.id === "number") byId.set(e.id, e);
  const runs: Record<string, StateRun> = {};
  const exited: Record<string, number> = {};
  const run = (name: string): StateRun => (runs[name] ??= { name, outcome: "notRun", entered: 0, input: null, output: null, error: null, cause: null, failures: 0 });

  const owner = (e: HistoryEventLike): string | null => {
    let cur: HistoryEventLike | undefined = e;
    for (let guard = 0; cur && guard < 100_000; guard++) {
      if (cur.type?.endsWith("StateEntered")) return str(details(cur)?.name);
      cur = typeof cur.previousEventId === "number" && cur.previousEventId > 0 ? byId.get(cur.previousEventId) : undefined;
    }
    return null;
  };

  let executionError: { error: string | null; cause: string | null; state: string | null } | null = null;
  for (const e of events) {
    const type = e.type ?? "";
    const d = details(e);
    if (type.endsWith("StateEntered")) {
      const name = str(d?.name);
      if (!name) continue;
      const r = run(name);
      r.entered += 1;
      r.input = str(d?.input) ?? r.input;
    } else if (type.endsWith("StateExited")) {
      const name = str(d?.name);
      if (!name) continue;
      exited[name] = (exited[name] ?? 0) + 1;
      run(name).output = str(d?.output) ?? run(name).output;
    } else if (type === "ExecutionFailed" || type === "ExecutionTimedOut" || type === "ExecutionAborted") {
      executionError = { error: str(d?.error), cause: str(d?.cause), state: owner(e) };
    } else if (isFailure(type)) {
      const name = owner(e);
      if (!name) continue;
      const r = run(name);
      r.failures += 1;
      r.error = str(d?.error) ?? r.error;
      r.cause = str(d?.cause) ?? r.cause;
    }
  }

  const running = executionStatus === "RUNNING" || executionStatus === "PENDING_REDRIVE";
  for (const r of Object.values(runs)) {
    const open = r.entered > (exited[r.name] ?? 0);
    if (open) r.outcome = running ? "inProgress" : "failed";
    else r.outcome = r.failures > 0 ? "caught" : "succeeded";
  }
  if (executionError?.state && runs[executionError.state]) {
    const r = runs[executionError.state];
    r.outcome = "failed";
    r.error = executionError.error ?? r.error;
    r.cause = executionError.cause ?? r.cause;
  }
  return runs;
}

// ---------------------------------------------------------------- layout

export interface GraphNode {
  name: string;
  /** ASL type, or "Start" / "End" for the round markers. */
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** True for Parallel and Map: the node is a frame around its branches. */
  container: boolean;
  depth: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: "next" | "choice" | "default" | "catch";
  label: string | null;
  path: string;
  labelX: number;
  labelY: number;
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

const NODE_H = 36;
const GAP_X = 36;
const GAP_Y = 46;
const PAD = 16;
const HEADER = 30;
const MARKER = 26;

type AslState = Record<string, unknown>;
interface Flow {
  startAt: string;
  states: Record<string, AslState>;
}

interface Box {
  name: string;
  type: string;
  w: number;
  h: number;
  container: boolean;
  /** Children laid out relative to this box's top-left corner. */
  inner: Placed | null;
}

interface Placed {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

function asFlow(v: unknown): Flow | null {
  if (!v || typeof v !== "object") return null;
  const o = v as { StartAt?: unknown; States?: unknown };
  if (typeof o.StartAt !== "string" || !o.States || typeof o.States !== "object") return null;
  return { startAt: o.StartAt, states: o.States as Record<string, AslState> };
}

interface Transition {
  to: string;
  kind: GraphEdge["kind"];
  label: string | null;
}

function transitions(s: AslState, ends: boolean): Transition[] {
  const out: Transition[] = [];
  if (Array.isArray(s.Choices)) {
    s.Choices.forEach((c, i) => {
      const next = c && typeof c === "object" ? (c as { Next?: unknown }).Next : undefined;
      if (typeof next === "string") out.push({ to: next, kind: "choice", label: `Rule #${i + 1}` });
    });
  }
  if (typeof s.Default === "string") out.push({ to: s.Default, kind: "default", label: "Default" });
  if (typeof s.Next === "string") out.push({ to: s.Next, kind: "next", label: null });
  if (Array.isArray(s.Catch)) {
    s.Catch.forEach((c, i) => {
      const next = c && typeof c === "object" ? (c as { Next?: unknown }).Next : undefined;
      if (typeof next === "string") out.push({ to: next, kind: "catch", label: `Catch #${i + 1}` });
    });
  }
  if (ends && (s.End === true || s.Type === "Succeed" || s.Type === "Fail")) out.push({ to: END, kind: "next", label: null });
  return out;
}

const START = "\u0000Start";
const END = "\u0000End";

function nodeWidth(name: string, type: string): number {
  return Math.max(120, Math.min(320, Math.max(name.length, type.length + 4) * 7 + 32));
}

function childFlows(s: AslState): Flow[] {
  if (s.Type === "Parallel" && Array.isArray(s.Branches)) return s.Branches.map(asFlow).filter((f): f is Flow => f !== null);
  if (s.Type === "Map") {
    const f = asFlow(s.ItemProcessor) ?? asFlow(s.Iterator);
    return f ? [f] : [];
  }
  return [];
}

function measure(name: string, s: AslState, depth: number): Box {
  const type = typeof s.Type === "string" ? s.Type : "State";
  const flows = childFlows(s);
  if (flows.length === 0) return { name, type, w: nodeWidth(name, type), h: NODE_H, container: false, inner: null };
  const placed = flows.map((f) => layoutFlow(f, depth + 1, false));
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let x = PAD;
  let maxH = 0;
  for (const p of placed) {
    nodes.push(...p.nodes.map((n) => ({ ...n, x: n.x + x, y: n.y + HEADER })));
    edges.push(...p.edges.map((e) => shiftEdge(e, x, HEADER)));
    x += p.width + GAP_X;
    maxH = Math.max(maxH, p.height);
  }
  const innerW = x - GAP_X + PAD;
  const w = Math.max(nodeWidth(name, type) + 2 * PAD, innerW);
  // Centre narrow branch sets inside a wide header.
  const shift = (w - innerW) / 2;
  return {
    name,
    type,
    w,
    h: HEADER + maxH + PAD,
    container: true,
    inner: { nodes: nodes.map((n) => ({ ...n, x: n.x + shift })), edges: edges.map((e) => shiftEdge(e, shift, 0)), width: w, height: HEADER + maxH + PAD },
  };
}

function shiftPath(path: string, dx: number, dy: number): string {
  let i = 0;
  return path.replace(/-?\d+(\.\d+)?/g, (m) => String(Math.round((Number(m) + (i++ % 2 === 0 ? dx : dy)) * 10) / 10));
}

function shiftEdge(e: GraphEdge, dx: number, dy: number): GraphEdge {
  return { ...e, path: shiftPath(e.path, dx, dy), labelX: e.labelX + dx, labelY: e.labelY + dy };
}

/** Ranks by longest path from StartAt, ignoring edges back to a state already on the DFS path (loops). */
function rankStates(names: string[], edgesOf: (n: string) => string[], start: string): { rank: Map<string, number>; order: string[]; back: Set<string> } {
  const order: string[] = [];
  const state = new Map<string, "open" | "done">();
  const back = new Set<string>();
  const known = new Set(names);
  const visit = (n: string) => {
    state.set(n, "open");
    order.push(n);
    for (const t of edgesOf(n)) {
      if (!known.has(t)) continue;
      const st = state.get(t);
      if (st === "open") back.add(`${n}\u0001${t}`);
      else if (st === undefined) visit(t);
    }
    state.set(n, "done");
  };
  if (known.has(start)) visit(start);
  for (const n of names) if (!state.has(n)) visit(n);
  const rank = new Map<string, number>(order.map((n) => [n, 0]));
  // Longest path over forward edges: relax in DFS-finish-compatible order until stable.
  for (let pass = 0; pass < names.length + 1; pass++) {
    let changed = false;
    for (const n of order) {
      for (const t of edgesOf(n)) {
        if (!known.has(t) || back.has(`${n}\u0001${t}`)) continue;
        const r = (rank.get(n) ?? 0) + 1;
        if (r > (rank.get(t) ?? 0)) {
          rank.set(t, r);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return { rank, order, back };
}

function layoutFlow(flow: Flow, depth: number, top: boolean): Placed {
  const stateNames = Object.keys(flow.states);
  const boxes = new Map<string, Box>(stateNames.map((n) => [n, measure(n, flow.states[n] ?? {}, depth)]));
  const trans = new Map<string, Transition[]>(stateNames.map((n) => [n, transitions(flow.states[n] ?? {}, top)]));
  if (top) {
    boxes.set(START, { name: START, type: "Start", w: MARKER * 2.4, h: MARKER, container: false, inner: null });
    boxes.set(END, { name: END, type: "End", w: MARKER * 2.4, h: MARKER, container: false, inner: null });
    trans.set(START, [{ to: flow.startAt, kind: "next", label: null }]);
    trans.set(END, []);
  }
  const all = top ? [START, ...stateNames, END] : stateNames;
  const { rank, order, back } = rankStates(all, (n) => (trans.get(n) ?? []).map((t) => t.to), top ? START : flow.startAt);
  // The End marker always sits below everything.
  if (top) rank.set(END, Math.max(0, ...[...rank.entries()].filter(([n]) => n !== END).map(([, r]) => r)) + 1);

  const layers: string[][] = [];
  for (const n of order) (layers[rank.get(n) ?? 0] ??= []).push(n);
  const dense = layers.filter((l) => l && l.length > 0);
  const layerW = dense.map((l) => l.reduce((s, n) => s + (boxes.get(n)?.w ?? 0), 0) + GAP_X * (l.length - 1));
  const width = Math.max(...layerW, 0);
  const pos = new Map<string, { x: number; y: number; w: number; h: number }>();
  let y = 0;
  dense.forEach((layer, i) => {
    let x = (width - layerW[i]) / 2;
    const h = Math.max(...layer.map((n) => boxes.get(n)?.h ?? NODE_H));
    for (const n of layer) {
      const b = boxes.get(n);
      if (!b) continue;
      pos.set(n, { x, y, w: b.w, h: b.h });
      x += b.w + GAP_X;
    }
    y += h + GAP_Y;
  });
  const height = Math.max(0, y - GAP_Y);

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const n of order) {
    const b = boxes.get(n);
    const p = pos.get(n);
    if (!b || !p) continue;
    nodes.push({ name: n === START ? "Start" : n === END ? "End" : n, type: b.type, x: p.x, y: p.y, w: p.w, h: p.h, container: b.container, depth });
    if (b.inner) {
      nodes.push(...b.inner.nodes.map((c) => ({ ...c, x: c.x + p.x, y: c.y + p.y })));
      edges.push(...b.inner.edges.map((e) => shiftEdge(e, p.x, p.y)));
    }
  }
  let backLane = width + 24;
  for (const n of order) {
    const s = pos.get(n);
    if (!s) continue;
    const outs = trans.get(n) ?? [];
    outs.forEach((t, i) => {
      const d = pos.get(t.to);
      if (!d) return;
      const from = n === START ? "Start" : n;
      const to = t.to === END ? "End" : t.to;
      const isBack = back.has(`${n}\u0001${t.to}`) || (rank.get(t.to) ?? 0) <= (rank.get(n) ?? 0);
      if (isBack) {
        const sx = s.x + s.w;
        const sy = s.y + s.h / 2;
        const dx = d.x + d.w;
        const dy = d.y + d.h / 2;
        const lane = backLane;
        backLane += 14;
        edges.push({ from, to, kind: t.kind, label: t.label, path: `M${sx},${sy} C${lane},${sy} ${lane},${dy} ${dx + 6},${dy}`, labelX: lane - 4, labelY: (sy + dy) / 2 });
        return;
      }
      const spread = outs.length > 1 ? (i - (outs.length - 1) / 2) * Math.min(24, s.w / (outs.length + 1)) : 0;
      const sx = s.x + s.w / 2 + spread;
      const sy = s.y + s.h;
      const tx = d.x + d.w / 2;
      const ty = d.y - 6;
      const my = (sy + ty) / 2;
      edges.push({ from, to, kind: t.kind, label: t.label, path: `M${sx},${sy} C${sx},${my} ${tx},${my} ${tx},${ty}`, labelX: (sx + tx) / 2, labelY: my });
    });
  }
  return { nodes, edges, width: Math.max(width, backLane - 24), height };
}

/** The whole definition laid out top to bottom, or null when it isn't an ASL document. */
export function layoutDefinition(definition: string | null | undefined): GraphLayout | null {
  const flow = asFlow(parseJsonText(definition ?? null));
  if (!flow) return null;
  const p = layoutFlow(flow, 0, true);
  return { nodes: p.nodes.map((n) => ({ ...n, x: n.x + PAD, y: n.y + PAD })), edges: p.edges.map((e) => shiftEdge(e, PAD, PAD)), width: p.width + 2 * PAD + 40, height: p.height + 2 * PAD };
}
