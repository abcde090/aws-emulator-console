"use client";

/**
 * The table's Contributor Insights graphs (Monitoring): most accessed and most throttled
 * keys, from the managed Contributor Insights rules DynamoDB creates for the table.
 */

import { useEffect, useState } from "react";
import { Button, Container, EmptyState, ErrorBanner, Spinner } from "@/console/ui/primitives";
import { LineChart } from "@/services/cloudwatch/LineChart";
import { RANGES } from "@/services/cloudwatch/helpers";
import { contributorSeries } from "./contributor-insights";
import { tableContributorInsights, type InsightsGraph, type TableInsights } from "./insights-actions";

function Graph({ graph, start, end }: { graph: InsightsGraph; start: number; end: number }) {
  const title = graph.index ? `${graph.title} - index ${graph.index}` : graph.title;
  const contributors = graph.report?.contributors ?? [];
  return (
    <section className="rounded-[6px] border border-line bg-white p-3" data-testid="insights-graph">
      <h3 className="font-bold">{title}</h3>
      <p className="mb-2 font-mono text-[11px] text-muted">{graph.rule}</p>
      {graph.error ? (
        <ErrorBanner message={graph.error} />
      ) : contributors.length === 0 ? (
        <p className="py-6 text-center text-muted">No data available in this time range.</p>
      ) : (
        <>
          <LineChart title={title} series={contributorSeries(contributors)} start={start} end={end} height={200} />
          <table className="mt-2 w-full border-collapse text-left text-[12px]">
            <thead>
              <tr className="border-b border-line bg-shade text-muted">
                <th className="px-2 py-1 font-bold">{graph.report?.keyLabels.join(" | ") || "Key"}</th>
                <th className="px-2 py-1 text-right font-bold">Count</th>
              </tr>
            </thead>
            <tbody>
              {contributors.map((c, i) => (
                <tr key={i} className="border-b border-line-soft">
                  <td className="px-2 py-1 font-mono break-all">{c.keys.join(" | ")}</td>
                  <td className="px-2 py-1 text-right">{c.value ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

export function ContributorInsightsPanel({ table }: { table: string }) {
  const [range, setRange] = useState(3600);
  const [tick, setTick] = useState(0);
  const [data, setData] = useState<TableInsights | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void tableContributorInsights(table, range).then((r) => {
      if (!live) return;
      if (r.ok) {
        setData(r.data);
        setError(null);
      } else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [table, range, tick]);

  const enabled = data?.status === "ENABLED";
  return (
    <Container
      title="Contributor Insights"
      description="The most accessed and most throttled keys in this table, from its Contributor Insights rules (GetInsightRuleReport)."
      actions={
        enabled ? (
          <>
            <div role="group" aria-label="Time range" className="flex overflow-hidden rounded-[4px] border border-[#879596] bg-white">
              {RANGES.map((r) => (
                <button key={r.key} type="button" aria-pressed={range === r.seconds} className={`px-2.5 py-0.5 ${range === r.seconds ? "bg-primary text-white" : "hover:bg-shade"}`} onClick={() => setRange(r.seconds)}>
                  {r.label}
                </button>
              ))}
            </div>
            <Button aria-label="Refresh graphs" onClick={() => setTick((t) => t + 1)}>⟳</Button>
          </>
        ) : undefined
      }
    >
      <div data-testid="contributor-insights">
        {error ? (
          <ErrorBanner message={error} />
        ) : !data ? (
          <Spinner />
        ) : !enabled ? (
          <EmptyState title={`Contributor Insights is ${data.status}`}>
            {data.failure ?? (data.status === "ENABLING" ? "The rules are being created. Refresh in a moment." : "Use Actions > Edit CloudWatch Contributor Insights to turn it on and see the most accessed and throttled keys.")}
          </EmptyState>
        ) : data.graphs.length === 0 ? (
          <EmptyState title="No Contributor Insights rules">DynamoDB returned no rules for this table.</EmptyState>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {data.graphs.map((g) => (
              <Graph key={g.rule} graph={g} start={data.start} end={data.end} />
            ))}
          </div>
        )}
      </div>
    </Container>
  );
}
