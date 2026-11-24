"use client";

import { useState } from "react";
import { chartGeometry, shortNumber, type Series } from "./helpers";

interface LineChartProps {
  series: Series[];
  start: number;
  end: number;
  height?: number;
  /** Accessible name of the graph. */
  title: string;
}

const BOX = { width: 800, left: 48, right: 16, top: 12, bottom: 28 };

function timeLabel(t: number, span: number): string {
  const d = new Date(t);
  const hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  if (span <= 86400_000) return hm;
  return `${d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", timeZone: "UTC" })} ${hm}`;
}

/** A CloudWatch-style line graph drawn as SVG from GetMetricData results, with a hover crosshair. */
export function LineChart({ series, start, end, height = 260, title }: LineChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const box = { ...BOX, height };
  const g = chartGeometry(series, box, { start, end });
  const span = end - start;
  const empty = series.every((s) => s.points.length === 0);
  const plotRight = box.width - box.right;

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * box.width;
    if (x < box.left || x > plotRight) return setHover(null);
    setHover(g.minT + ((x - box.left) / (plotRight - box.left)) * (g.maxT - g.minT));
  }

  const nearest = hover === null ? [] : g.lines.map((l, i) => {
    let best: (typeof l.points)[number] | null = null;
    for (const p of l.points) if (!best || Math.abs(p.t - hover) < Math.abs(best.t - hover)) best = p;
    return best ? { ...best, color: l.color, label: series[i]?.label ?? l.id } : null;
  }).filter((p): p is NonNullable<typeof p> => p !== null);
  const hoverT = nearest[0]?.t ?? null;

  return (
    <figure className="space-y-2" data-testid="metric-chart">
      <div className="relative">
        <svg viewBox={`0 0 ${box.width} ${box.height}`} className="w-full" role="img" aria-label={title} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {g.yTicks.map((t) => (
            <g key={`y${t.value}`}>
              <line x1={box.left} x2={plotRight} y1={t.y} y2={t.y} stroke="#e9ebed" strokeWidth={1} />
              <text x={box.left - 6} y={t.y + 4} textAnchor="end" fontSize={11} fill="#5f6b7a">
                {shortNumber(t.value)}
              </text>
            </g>
          ))}
          {g.xTicks.map((t) => (
            <text key={`x${t.t}`} x={t.x} y={box.height - 8} textAnchor="middle" fontSize={11} fill="#5f6b7a">
              {timeLabel(t.t, span)}
            </text>
          ))}
          <line x1={box.left} x2={plotRight} y1={box.height - box.bottom} y2={box.height - box.bottom} stroke="#8c8c94" strokeWidth={1} />
          {g.lines.map((l) => (
            <g key={l.id}>
              {l.points.length > 1 && <path d={l.path} fill="none" stroke={l.color} strokeWidth={2} strokeLinejoin="round" />}
              {l.points.length <= 3 && l.points.map((p) => <circle key={p.t} cx={p.x} cy={p.y} r={4} fill={l.color} stroke="#fff" strokeWidth={2} />)}
            </g>
          ))}
          {hoverT !== null && nearest[0] && <line x1={nearest[0].x} x2={nearest[0].x} y1={box.top} y2={box.height - box.bottom} stroke="#8c8c94" strokeDasharray="3 3" />}
          {nearest.map((p) => (
            <circle key={`h${p.label}`} cx={p.x} cy={p.y} r={5} fill={p.color} stroke="#fff" strokeWidth={2} />
          ))}
        </svg>
        {empty && <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-muted">No data available for this time range.</p>}
        {hoverT !== null && nearest.length > 0 && (
          <div className="pointer-events-none absolute top-2 right-2 rounded-lg border border-line-soft bg-white px-3 py-2 text-[13px] shadow" role="tooltip">
            <p className="font-bold">{new Date(hoverT).toISOString().replace("T", " ").slice(0, 19)} UTC</p>
            {nearest.map((p) => (
              <p key={p.label} className="flex items-center gap-2">
                <span aria-hidden className="inline-block h-0.5 w-3" style={{ background: p.color }} />
                <span>{p.label}</span>
                <span className="ml-auto font-mono">{shortNumber(p.v)}</span>
              </p>
            ))}
          </div>
        )}
      </div>
      {series.length > 0 && (
        <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]" aria-label="Legend">
          {g.lines.map((l, i) => (
            <span key={l.id} className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-0.5 w-4" style={{ background: l.color }} />
              <span>{series[i]?.label ?? l.id}</span>
              {series[i]?.message && <span className="text-bad">({series[i]?.message})</span>}
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}
