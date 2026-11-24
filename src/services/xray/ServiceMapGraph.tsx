/** The service map drawn as SVG: nodes laid out left to right by call depth, edges as arrows. */

import Link from "next/link";
import type { Service } from "@aws-sdk/client-xray";
import { layoutGraph } from "./helpers";
import { nodeId } from "./def";

const WIDTH = 900;
const ROW = 120;

function health(s: Service): string {
  const st = s.SummaryStatistics;
  if ((st?.FaultStatistics?.TotalCount ?? 0) > 0) return "#e34948";
  if ((st?.ErrorStatistics?.TotalCount ?? 0) > 0) return "#eda100";
  return "#1baf7a";
}

export function ServiceMapGraph({ services }: { services: Service[] }) {
  const input = services.map((s) => ({ id: s.ReferenceId ?? -1, name: s.Name ?? `(${s.ReferenceId})`, type: s.Type ?? null, edges: (s.Edges ?? []).map((e) => e.ReferenceId ?? -1), root: s.Root === true }));
  const nodes = layoutGraph(input, WIDTH, ROW);
  const height = Math.max(...nodes.map((n) => n.y), 50) + 60;
  const at = (id: number) => nodes.find((n) => n.id === id);
  return (
    <svg viewBox={`0 0 ${WIDTH} ${height}`} className="w-full" role="img" aria-label="Service map" data-testid="service-map">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#8c8c94" />
        </marker>
      </defs>
      {input.flatMap((s) =>
        s.edges.map((e) => {
          const a = at(s.id);
          const b = at(e);
          if (!a || !b) return null;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.hypot(dx, dy) || 1;
          return <line key={`${s.id}-${e}`} x1={a.x + (dx / len) * 28} y1={a.y + (dy / len) * 28} x2={b.x - (dx / len) * 30} y2={b.y - (dy / len) * 30} stroke="#8c8c94" strokeWidth={1.5} markerEnd="url(#arrow)" />;
        })
      )}
      {nodes.map((n) => {
        const s = services.find((x) => (x.ReferenceId ?? -1) === n.id);
        const total = s?.SummaryStatistics?.TotalCount ?? 0;
        const avg = total ? (s?.SummaryStatistics?.TotalResponseTime ?? 0) / total : 0;
        return (
          <Link key={n.id} href={`/xray/service-map/${encodeURIComponent(s ? nodeId(s) : n.name)}`}>
            <g>
              <circle cx={n.x} cy={n.y} r={26} fill="#fff" stroke={s ? health(s) : "#8c8c94"} strokeWidth={4} />
              <text x={n.x} y={n.y + 4} textAnchor="middle" fontSize={10} fill="#0f141a">
                {total ? `${Math.round(avg * 1000)}ms` : ""}
              </text>
              <text x={n.x} y={n.y + 42} textAnchor="middle" fontSize={12} fontWeight="bold" fill="#0f141a">
                {n.name}
              </text>
              {n.type && (
                <text x={n.x} y={n.y + 56} textAnchor="middle" fontSize={10} fill="#5f6b7a">
                  {n.type}
                </text>
              )}
            </g>
          </Link>
        );
      })}
    </svg>
  );
}
