"use client";

import { useEffect, useState } from "react";
import { Button, Container, EmptyState, ErrorBanner, Spinner } from "@/console/ui/primitives";
import { JsonView } from "@/console/ui/JsonView";
import { AlarmWidget, LogWidget } from "./DashboardWidgets";
import { LineChart } from "./LineChart";
import { fetchMetricData } from "./metric-actions";
import { RANGES, type DashboardWidget, type Series } from "./helpers";

function MetricWidget({ widget, range, tick }: { widget: DashboardWidget; range: number; tick: number }) {
  const [data, setData] = useState<{ series: Series[]; start: number; end: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (widget.queries.length === 0) return;
    let live = true;
    fetchMetricData(widget.queries, range).then((r) => {
      if (!live) return;
      if (r.ok) {
        setData(r.data);
        setError(null);
      } else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [widget, range, tick]);
  if (widget.queries.length === 0) return <p className="text-muted">This widget has no metrics.</p>;
  if (error) return <ErrorBanner message={error} />;
  if (!data) return <Spinner />;
  return <LineChart title={widget.title || "Metric widget"} series={data.series} start={data.start} end={data.end} height={Math.max(160, widget.height * 36)} />;
}

/** Draws a dashboard's widgets on the console's 24-column grid. */
export function DashboardView({ widgets, parseError }: { widgets: DashboardWidget[]; parseError: string | null }) {
  const [range, setRange] = useState(10800);
  const [tick, setTick] = useState(0);
  if (parseError) return <ErrorBanner title="The dashboard body can't be read" message={parseError} />;
  const sorted = [...widgets].sort((a, b) => a.y - b.y || a.x - b.x);
  return (
    <Container
      title="Widgets"
      counter={`(${widgets.length})`}
      actions={
        <>
          <div role="group" aria-label="Time range" className="flex overflow-hidden rounded-[4px] border border-[#879596] bg-white">
            {RANGES.map((r) => (
              <button key={r.key} type="button" aria-pressed={range === r.seconds} className={`px-2.5 py-0.5 ${range === r.seconds ? "bg-primary text-white" : "hover:bg-shade"}`} onClick={() => setRange(r.seconds)}>
                {r.label}
              </button>
            ))}
          </div>
          <Button aria-label="Refresh widgets" onClick={() => setTick((t) => t + 1)}>
            ⟳
          </Button>
        </>
      }
    >
      {widgets.length === 0 ? (
        <EmptyState title="This dashboard is empty.">Use Actions &gt; Edit source to add widgets.</EmptyState>
      ) : (
        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(24, minmax(0, 1fr))" }} data-testid="dashboard-widgets">
          {sorted.map((w, i) => (
            <section key={i} className="rounded-[6px] border border-line bg-white p-3" data-testid={`widget-${w.type}`} style={{ gridColumn: `span ${Math.min(Math.max(w.width, 1), 24)} / span ${Math.min(Math.max(w.width, 1), 24)}` }}>
              <h3 className="mb-2 font-bold">{w.title || (w.type === "text" ? "" : `${w.type} widget`)}</h3>
              {w.type === "metric" && <MetricWidget widget={w} range={range} tick={tick} />}
              {w.type === "text" && <pre className="font-sans whitespace-pre-wrap">{w.markdown ?? ""}</pre>}
              {w.type === "alarm" && <AlarmWidget widget={w} tick={tick} />}
              {w.type === "log" && <LogWidget widget={w} range={range} tick={tick} />}
              {!["metric", "text", "alarm", "log"].includes(w.type) && (
                <>
                  <p className="text-muted">This console draws metric, text, alarm and log widgets; here are the {w.type} widget&apos;s properties.</p>
                  <JsonView value={w.properties} />
                </>
              )}
            </section>
          ))}
        </div>
      )}
    </Container>
  );
}
