/** Segments timeline: one bar per segment and subsegment, positioned on the trace's time axis. */

import { StatusBadge } from "@/console/ui/primitives";
import type { TimelineRow } from "./helpers";

const BAR: Record<string, string> = { OK: "#1baf7a", Error: "#eda100", Throttle: "#6250d6", Fault: "#e34948", "In progress": "#2a78d6" };

export function TraceTimeline({ rows }: { rows: TimelineRow[] }) {
  if (rows.length === 0) return <p className="text-muted">This trace has no readable segments.</p>;
  const start = Math.min(...rows.map((r) => r.start));
  const end = Math.max(...rows.map((r) => r.end ?? r.start));
  const span = end - start || 1;
  return (
    <div className="overflow-x-auto" data-testid="trace-timeline">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b-2 border-line-soft">
            <th className="px-2 py-2">Name</th>
            <th className="px-2 py-2">Response code</th>
            <th className="px-2 py-2">Duration</th>
            <th className="px-2 py-2">Status</th>
            <th className="w-1/2 px-2 py-2">
              Timeline <span className="font-normal text-muted">(0 to {span.toFixed(3)}s)</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const left = ((r.start - start) / span) * 100;
            const width = Math.max((((r.end ?? end) - r.start) / span) * 100, 0.5);
            return (
              <tr key={`${r.id}-${i}`} className={`border-b border-line-soft ${r.kind === "segment" ? "font-bold" : ""}`}>
                <td className="px-2 py-1.5 whitespace-nowrap" style={{ paddingLeft: `${0.5 + r.depth * 1.25}rem` }}>
                  {r.name}
                  {r.origin && <span className="ml-2 font-normal text-muted">{r.origin}</span>}
                  {r.namespace && <span className="ml-2 font-normal text-muted">({r.namespace})</span>}
                </td>
                <td className="px-2 py-1.5">{r.httpStatus ?? "-"}</td>
                <td className="px-2 py-1.5 whitespace-nowrap">{r.end !== null ? `${(r.end - r.start).toFixed(3)}s` : "in progress"}</td>
                <td className="px-2 py-1.5">
                  <StatusBadge value={r.status} />
                </td>
                <td className="px-2 py-1.5">
                  <div className="relative h-4 rounded bg-shade" aria-label={`${r.name} from ${(r.start - start).toFixed(3)}s for ${r.end !== null ? (r.end - r.start).toFixed(3) : "?"}s`}>
                    <div className="absolute top-0 h-4 rounded" style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%`, background: BAR[r.status] ?? "#2a78d6" }} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
