/** Pure helpers for X-Ray: segment documents -> timeline rows, service graph layout. */

export interface TimelineRow {
  id: string;
  name: string;
  depth: number;
  kind: "segment" | "subsegment";
  start: number;
  end: number | null;
  status: string;
  httpStatus: number | null;
  method: string | null;
  url: string | null;
  namespace: string | null;
  origin: string | null;
}

type Doc = Record<string, unknown>;

function obj(v: unknown): Doc {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Doc) : {};
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function statusOf(d: Doc, httpStatus: number | null): string {
  if (d.fault === true || (httpStatus !== null && httpStatus >= 500)) return "Fault";
  if (d.throttle === true || httpStatus === 429) return "Throttle";
  if (d.error === true || (httpStatus !== null && httpStatus >= 400)) return "Error";
  if (d.in_progress === true) return "In progress";
  return "OK";
}

function rowOf(d: Doc, depth: number, kind: TimelineRow["kind"]): TimelineRow {
  const http = obj(d.http);
  const req = obj(http.request);
  const res = obj(http.response);
  const httpStatus = num(res.status);
  return {
    id: str(d.id) ?? "",
    name: str(d.name) ?? "(unnamed)",
    depth,
    kind,
    start: num(d.start_time) ?? 0,
    end: num(d.end_time),
    status: statusOf(d, httpStatus),
    httpStatus,
    method: str(req.method),
    url: str(req.url),
    namespace: str(d.namespace),
    origin: str(d.origin),
  };
}

function walkSubsegments(list: unknown, depth: number, out: TimelineRow[]): void {
  if (!Array.isArray(list)) return;
  for (const s of list) {
    const d = obj(s);
    out.push(rowOf(d, depth, "subsegment"));
    walkSubsegments(d.subsegments, depth + 1, out);
  }
}

/**
 * Segment documents (JSON strings from BatchGetTraces) -> rows in timeline order:
 * each segment followed by its nested subsegments. Segments whose parent is a
 * subsegment of another segment are placed under it (inferred downstream segments).
 */
export function timelineRows(documents: readonly string[]): TimelineRow[] {
  const docs = documents
    .map((text) => {
      try {
        return obj(JSON.parse(text));
      } catch {
        return null;
      }
    })
    .filter((d): d is Doc => d !== null);
  const ids = new Set<string>();
  for (const d of docs) {
    const stack: Doc[] = [d];
    while (stack.length) {
      const cur = stack.pop() as Doc;
      if (typeof cur.id === "string") ids.add(cur.id);
      if (Array.isArray(cur.subsegments)) stack.push(...cur.subsegments.map(obj));
    }
  }
  const roots = docs.filter((d) => typeof d.parent_id !== "string" || !ids.has(d.parent_id));
  const children = (parentIds: Set<string>) => docs.filter((d) => typeof d.parent_id === "string" && parentIds.has(d.parent_id));
  const out: TimelineRow[] = [];
  const emit = (d: Doc, depth: number, seen: Set<Doc>) => {
    if (seen.has(d)) return;
    seen.add(d);
    out.push(rowOf(d, depth, "segment"));
    const before = out.length;
    walkSubsegments(d.subsegments, depth + 1, out);
    const subIds = new Set<string>([str(d.id) ?? "", ...out.slice(before).map((r) => r.id)]);
    for (const c of children(subIds).sort((a, b) => (num(a.start_time) ?? 0) - (num(b.start_time) ?? 0))) emit(c, depth + 1, seen);
  };
  const seen = new Set<Doc>();
  for (const r of [...roots].sort((a, b) => (num(a.start_time) ?? 0) - (num(b.start_time) ?? 0))) emit(r, 0, seen);
  for (const d of docs) emit(d, 0, seen);
  return out;
}

export interface GraphNode {
  id: number;
  name: string;
  type: string | null;
  x: number;
  y: number;
}

/**
 * Layered layout: nodes nobody calls sit in the left column; every other node sits one
 * column right of its furthest caller (longest path, cycles cut after n passes).
 */
export function layoutGraph(services: readonly { id: number; name: string; type: string | null; edges: number[]; root: boolean }[], width: number, rowHeight: number): GraphNode[] {
  const depth = new Map<number, number>(services.map((s) => [s.id, 0]));
  for (let pass = 0; pass < services.length; pass++) {
    let changed = false;
    for (const s of services) {
      for (const e of s.edges) {
        if (e === s.id || !depth.has(e)) continue;
        const want = (depth.get(s.id) ?? 0) + 1;
        if ((depth.get(e) ?? 0) < want) {
          depth.set(e, want);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  const maxDepth = Math.max(0, ...depth.values());
  const perLevel = new Map<number, number>();
  return services.map((s) => {
    const d = depth.get(s.id) ?? 0;
    const row = perLevel.get(d) ?? 0;
    perLevel.set(d, row + 1);
    const x = maxDepth === 0 ? width / 2 : 110 + (d * (width - 220)) / maxDepth;
    return { id: s.id, name: s.name, type: s.type, x, y: 50 + row * rowHeight };
  });
}
