"use client";

import { useState, type FormEvent } from "react";
import { Button, Container, EmptyState, ErrorBanner } from "@/console/ui/primitives";
import { runCostQuery, type CostQuery, type CostReport } from "./ce-actions";
import { COST_METRICS, FILTER_DIMENSIONS, GROUP_BY } from "./ce-options";

const inputClass = "w-full rounded-[4px] border border-[#879596] bg-white px-2.5 py-1.5 text-[13px] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

interface CostExplorerProps {
  defaultStart: string;
  defaultEnd: string;
}

export function CostExplorer({ defaultStart, defaultEnd }: CostExplorerProps) {
  const [q, setQ] = useState<CostQuery>({ start: defaultStart, end: defaultEnd, granularity: "MONTHLY", metric: "UnblendedCost", groupBy: "SERVICE", tagKey: "", filterDimension: "", filterValues: "" });
  const [report, setReport] = useState<CostReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof CostQuery) => (e: { target: { value: string } }) => setQ((prev) => ({ ...prev, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await runCostQuery(q);
    setBusy(false);
    if (r.ok) {
      setReport(r.data);
      setError(null);
    } else {
      setReport(null);
      setError(r.error);
    }
  }

  return (
    <div className="space-y-4">
      <Container title="Report parameters" description="Runs GetCostAndUsage against AWS Emulator and shows exactly what it returns.">
        <form onSubmit={submit} className="grid grid-cols-1 gap-4 md:grid-cols-3" data-testid="cost-query">
          <label className="block">
            <span className="font-bold">Start date</span>
            <input type="date" className={inputClass} value={q.start} onChange={set("start")} required />
          </label>
          <label className="block">
            <span className="font-bold">End date</span>
            <input type="date" className={inputClass} value={q.end} onChange={set("end")} required />
          </label>
          <label className="block">
            <span className="font-bold">Granularity</span>
            <select className={inputClass} value={q.granularity} onChange={set("granularity")}>
              <option value="DAILY">Daily</option>
              <option value="MONTHLY">Monthly</option>
              <option value="HOURLY">Hourly</option>
            </select>
          </label>
          <label className="block">
            <span className="font-bold">Metric</span>
            <select className={inputClass} value={q.metric} onChange={set("metric")}>
              {COST_METRICS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="font-bold">Group by</span>
            <select className={inputClass} value={q.groupBy} onChange={set("groupBy")}>
              <option value="">No grouping</option>
              {GROUP_BY.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
              <option value="TAG">Tag</option>
            </select>
          </label>
          {q.groupBy === "TAG" ? (
            <label className="block">
              <span className="font-bold">Tag key</span>
              <input className={inputClass} value={q.tagKey} onChange={set("tagKey")} placeholder="e.g. Project" />
            </label>
          ) : (
            <div />
          )}
          <label className="block">
            <span className="font-bold">Filter</span>
            <select className={inputClass} value={q.filterDimension} onChange={set("filterDimension")}>
              <option value="">No filter</option>
              {FILTER_DIMENSIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          {q.filterDimension !== "" && (
            <label className="block md:col-span-2">
              <span className="font-bold">Include only</span>
              <input className={inputClass} value={q.filterValues} onChange={set("filterValues")} placeholder="Values, separated by commas" />
            </label>
          )}
          <div className="md:col-span-3">
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "Running…" : "Apply"}
            </Button>
          </div>
        </form>
      </Container>
      {error && <ErrorBanner title="Cost Explorer returned an error" message={error} />}
      {report && (
        <Container title="Cost and usage breakdown" counter={`(${report.rows.length})`}>
          {report.rows.length === 0 ? (
            <EmptyState title="No cost data for this period" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left" data-testid="cost-results">
                <thead>
                  <tr className="border-b-2 border-line-soft">
                    <th className="px-2 py-1.5">Period</th>
                    <th className="px-2 py-1.5">Group</th>
                    <th className="px-2 py-1.5">Amount</th>
                    <th className="px-2 py-1.5">Unit</th>
                    <th className="px-2 py-1.5">Estimated</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((r, i) => (
                    <tr key={i} className="border-b border-line-soft">
                      <td className="px-2 py-1.5">{r.period}</td>
                      <td className="px-2 py-1.5">{r.group}</td>
                      <td className="px-2 py-1.5">{r.amount ?? "-"}</td>
                      <td className="px-2 py-1.5">{r.unit ?? "-"}</td>
                      <td className="px-2 py-1.5">{r.estimated ? "Yes" : "No"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Container>
      )}
    </div>
  );
}
