"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Container, EmptyState, ErrorBanner, Spinner } from "@/console/ui/primitives";
import { LineChart } from "./LineChart";
import { fetchMetricData } from "./metric-actions";
import { autoPeriod, dimensionSetKey, dimensionsLabel, metricKey, PERIODS, QUERY_ID, RANGES, STATISTICS, type ChartQuery, type MetricId, type Series } from "./helpers";

const input = "rounded-[4px] border border-[#879596] bg-white px-2.5 py-1.5 text-[13px] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

interface ExplorerProps {
  metrics: MetricId[];
  truncated: boolean;
  initialError: string | null;
}

interface Graphed extends ChartQuery {
  key: string;
}

function nextId(used: Graphed[], prefix: string): string {
  for (let i = 1; ; i++) if (!used.some((g) => g.id === `${prefix}${i}`)) return `${prefix}${i}`;
}

/** The CloudWatch metrics explorer: browse namespaces and dimensions, graph metrics and math expressions. */
export function MetricsExplorer({ metrics, truncated, initialError }: ExplorerProps) {
  const [namespace, setNamespace] = useState<string | null>(null);
  const [dimSet, setDimSet] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [graphed, setGraphed] = useState<Graphed[]>([]);
  const [range, setRange] = useState(10800);
  const [stat, setStat] = useState("Average");
  const [period, setPeriod] = useState<number>(300);
  const [expression, setExpression] = useState("");
  const [data, setData] = useState<{ series: Series[]; start: number; end: number } | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [tab, setTab] = useState<"browse" | "graphed">("browse");

  const q = filter.trim().toLowerCase();
  const namespaces = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of metrics) counts.set(m.namespace, (counts.get(m.namespace) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [metrics]);
  const inNamespace = useMemo(() => metrics.filter((m) => m.namespace === namespace), [metrics, namespace]);
  const dimSets = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of inNamespace) counts.set(dimensionSetKey(m.dimensions), (counts.get(dimensionSetKey(m.dimensions)) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [inNamespace]);
  const rows = useMemo(
    () => inNamespace.filter((m) => dimensionSetKey(m.dimensions) === dimSet).filter((m) => q === "" || `${m.metricName} ${dimensionsLabel(m.dimensions)}`.toLowerCase().includes(q)),
    [inNamespace, dimSet, q]
  );

  useEffect(() => {
    if (graphed.length === 0) return;
    let live = true;
    const queries: ChartQuery[] = graphed.map((g) => ({ id: g.id, label: g.label, metric: g.metric, stat: g.stat, period: g.period, expression: g.expression, visible: g.visible }));
    fetchMetricData(queries, range).then((r) => {
      if (!live) return;
      setLoading(false);
      if (!r.ok) return setError(r.error);
      setError(null);
      setData(r.data);
    });
    return () => {
      live = false;
    };
  }, [graphed, range, tick]);

  function toggle(m: MetricId, on: boolean) {
    const key = metricKey(m);
    setGraphed((prev) => (on ? [...prev, { key, id: nextId(prev, "m"), metric: m, stat, period, label: m.metricName }] : prev.filter((g) => g.key !== key)));
  }

  function update(key: string, patch: Partial<Graphed>) {
    setGraphed((prev) => prev.map((g) => (g.key === key ? { ...g, ...patch } : g)));
  }

  function addExpression() {
    const expr = expression.trim();
    if (!expr) return;
    setGraphed((prev) => {
      const id = nextId(prev, "e");
      return [...prev, { key: `expr:${id}`, id, expression: expr, label: expr }];
    });
    setExpression("");
    setTab("graphed");
  }

  const selectedKeys = new Set(graphed.map((g) => g.key));
  const shown = data?.series ?? [];

  return (
    <div className="space-y-4" data-testid="metrics-explorer">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <Container
        title="Untitled graph"
        actions={
          <>
            <div role="group" aria-label="Time range" className="flex overflow-hidden rounded-[4px] border border-[#879596] bg-white">
              {RANGES.map((r) => (
                <button key={r.key} type="button" aria-pressed={range === r.seconds} className={`px-2.5 py-0.5 ${range === r.seconds ? "bg-primary text-white" : "hover:bg-shade"}`} onClick={() => setRange(r.seconds)}>
                  {r.label}
                </button>
              ))}
            </div>
            <Button aria-label="Refresh graph" onClick={() => {
                setLoading(true);
                setTick((t) => t + 1);
              }}
              disabled={loading || graphed.length === 0}>
              {loading ? "…" : "⟳"}
            </Button>
          </>
        }
      >
        {graphed.length === 0 ? (
          <EmptyState title="Your CloudWatch graph is empty.">Select some metrics from Browse to appear here.</EmptyState>
        ) : data ? (
          <LineChart title="Metrics graph" series={shown} start={data.start} end={data.end} />
        ) : (
          <Spinner />
        )}
      </Container>

      <div role="tablist" className="flex gap-1 border-b border-line">
        {(["browse", "graphed"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`-mb-px border-b-2 px-4 py-2 font-bold ${tab === t ? "border-primary text-primary" : "border-transparent"}`} onClick={() => setTab(t)}>
            {t === "browse" ? "Browse" : `Graphed metrics (${graphed.length})`}
          </button>
        ))}
      </div>

      {tab === "browse" && (
        <Container
          title={
            <span className="flex flex-wrap items-center gap-1 text-base">
              <button type="button" className="text-link hover:underline" onClick={() => { setNamespace(null); setDimSet(null); }}>
                All metrics
              </button>
              {namespace && (
                <>
                  <span className="text-muted">›</span>
                  <button type="button" className="text-link hover:underline" onClick={() => setDimSet(null)}>
                    {namespace}
                  </button>
                </>
              )}
              {dimSet && (
                <>
                  <span className="text-muted">›</span>
                  <span>{dimSet}</span>
                </>
              )}
            </span>
          }
          description={truncated ? "Showing the first 5,000 metrics." : undefined}
          actions={
            <>
              <label className="flex items-center gap-1">
                <span className="text-muted">Statistic</span>
                <select aria-label="Statistic for new metrics" className={input} value={stat} onChange={(e) => setStat(e.target.value)}>
                  {STATISTICS.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1">
                <span className="text-muted">Period</span>
                <select aria-label="Period for new metrics" className={input} value={period} onChange={(e) => setPeriod(Number(e.target.value))}>
                  {PERIODS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          }
        >
          {!namespace && (
            <ul className="grid grid-cols-1 gap-2 md:grid-cols-3" aria-label="Namespaces">
              {namespaces.map(([ns, n]) => (
                <li key={ns}>
                  <button type="button" className="w-full rounded-[6px] border border-line bg-white px-3 py-2 text-left hover:bg-shade" onClick={() => setNamespace(ns)}>
                    <span className="font-bold text-link">{ns}</span> <span className="text-muted">({n})</span>
                  </button>
                </li>
              ))}
              {namespaces.length === 0 && <li className="text-muted">No metrics yet. Services and PutMetricData publish metrics here.</li>}
            </ul>
          )}
          {namespace && !dimSet && (
            <ul className="space-y-2" aria-label="Dimensions">
              {dimSets.map(([set, n]) => (
                <li key={set}>
                  <button type="button" className="text-link hover:underline" onClick={() => setDimSet(set)}>
                    {set}
                  </button>{" "}
                  <span className="text-muted">({n})</span>
                </li>
              ))}
            </ul>
          )}
          {namespace && dimSet && (
            <>
              <input type="search" aria-label="Search metrics" placeholder="Search for any metric, dimension or value" className={`${input} mb-3 w-full max-w-md`} value={filter} onChange={(e) => setFilter(e.target.value)} />
              <div className="max-h-96 overflow-auto">
                <table className="w-full border-collapse text-left" data-testid="metric-rows">
                  <thead>
                    <tr className="border-b-2 border-line-soft">
                      <th className="w-8" />
                      {dimSet !== "Metrics with no dimensions" && dimSet.split(", ").map((d) => <th key={d} className="px-2 py-2">{d}</th>)}
                      <th className="px-2 py-2">Metric name</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((m) => {
                      const key = metricKey(m);
                      return (
                        <tr key={key} className="border-b border-line-soft hover:bg-shade">
                          <td className="px-2 py-1.5">
                            <input type="checkbox" aria-label={`Graph ${m.metricName} ${dimensionsLabel(m.dimensions)}`} checked={selectedKeys.has(key)} onChange={(e) => toggle(m, e.target.checked)} />
                          </td>
                          {dimSet !== "Metrics with no dimensions" &&
                            dimSet.split(", ").map((d) => (
                              <td key={d} className="px-2 py-1.5 break-all">
                                {m.dimensions.find((x) => x.Name === d)?.Value ?? "-"}
                              </td>
                            ))}
                          <td className="px-2 py-1.5">{m.metricName}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {rows.length === 0 && <EmptyState title="No metrics match the search." />}
              </div>
            </>
          )}
        </Container>
      )}

      {tab === "graphed" && (
        <Container title="Graphed metrics" description={`Ids name each query in math expressions, e.g. m1 * 100 / m2. Suggested period for this range: ${PERIODS.find((p) => p.value === autoPeriod(range))?.label}.`}>
          <form
            className="mb-3 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              addExpression();
            }}
          >
            <label className="flex min-w-64 flex-1 flex-col gap-1">
              <span className="font-bold">Add math</span>
              <input aria-label="Math expression" placeholder="e.g. SUM([m1, m2]) or m1 * 2" className={input} value={expression} onChange={(e) => setExpression(e.target.value)} />
            </label>
            <Button type="submit" disabled={expression.trim() === ""}>
              Add math expression
            </Button>
          </form>
          {graphed.length === 0 ? (
            <EmptyState title="No graphed metrics." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left" data-testid="graphed-metrics">
                <thead>
                  <tr className="border-b-2 border-line-soft">
                    <th className="px-2 py-2">Id</th>
                    <th className="px-2 py-2">Label</th>
                    <th className="px-2 py-2">Details</th>
                    <th className="px-2 py-2">Statistic</th>
                    <th className="px-2 py-2">Period</th>
                    <th className="px-2 py-2">Shown</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {graphed.map((g) => {
                    const s = shown.find((x) => x.id === g.id);
                    return (
                      <tr key={g.key} className="border-b border-line-soft align-top">
                        <td className="px-2 py-1.5">
                          <input aria-label={`Id of ${g.label ?? g.id}`} className={`${input} w-20 font-mono`} defaultValue={g.id} onBlur={(e) => QUERY_ID.test(e.target.value) && e.target.value !== g.id && update(g.key, { id: e.target.value })} />
                        </td>
                        <td className="px-2 py-1.5">
                          <input aria-label={`Label of ${g.id}`} className={`${input} w-40`} defaultValue={g.label ?? ""} onBlur={(e) => update(g.key, { label: e.target.value })} />
                        </td>
                        <td className="px-2 py-1.5 font-mono text-[13px] break-all">
                          {g.expression ?? `${g.metric?.namespace} • ${g.metric?.metricName} • ${dimensionsLabel(g.metric?.dimensions ?? [])}`}
                          {s?.message && <p className="text-bad">{s.message}</p>}
                        </td>
                        <td className="px-2 py-1.5">
                          {g.metric ? (
                            <select aria-label={`Statistic of ${g.id}`} className={input} value={g.stat} onChange={(e) => update(g.key, { stat: e.target.value })}>
                              {STATISTICS.map((x) => (
                                <option key={x}>{x}</option>
                              ))}
                            </select>
                          ) : (
                            "-"
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          {g.metric ? (
                            <select aria-label={`Period of ${g.id}`} className={input} value={g.period} onChange={(e) => update(g.key, { period: Number(e.target.value) })}>
                              {PERIODS.map((p) => (
                                <option key={p.value} value={p.value}>
                                  {p.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            "-"
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          <input type="checkbox" aria-label={`Show ${g.id}`} checked={g.visible !== false} onChange={(e) => update(g.key, { visible: e.target.checked })} />
                        </td>
                        <td className="px-2 py-1.5">
                          <Button variant="link" aria-label={`Remove ${g.id}`} onClick={() => setGraphed((prev) => prev.filter((x) => x.key !== g.key))}>
                            ✕
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Container>
      )}
    </div>
  );
}
