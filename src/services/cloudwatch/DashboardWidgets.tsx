"use client";

/**
 * Dashboard alarm and log widgets. Alarm widgets show each alarm's state (DescribeAlarms);
 * log widgets run their Logs Insights query (StartQuery, then GetQueryResults) over the
 * dashboard's time range and show the result table. Errors show inside the widget.
 */

import { useEffect, useState } from "react";
import { formatDate } from "@/console/format";
import { ErrorBanner, Spinner, StatusBadge } from "@/console/ui/primitives";
import { alarmWidgetNames, logWidgetQuery, type DashboardWidget } from "./helpers";
import { getInsightsResults, startInsightsQuery, type InsightsResults } from "./logs-actions";
import { describeAlarmStates, type AlarmStatus } from "./metric-actions";

const POLL_MS = 1000;
const MAX_POLLS = 60;
const DONE = ["Complete", "Failed", "Cancelled", "Timeout"];
const ROW_LIMIT = 1000;

export function AlarmWidget({ widget, tick }: { widget: DashboardWidget; tick: number }) {
  const names = alarmWidgetNames(widget.properties);
  const key = names.join("\u0000");
  const [data, setData] = useState<{ alarms: AlarmStatus[]; missing: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const list = key === "" ? [] : key.split("\u0000");
    if (list.length === 0) return;
    let live = true;
    void describeAlarmStates(list).then((r) => {
      if (!live) return;
      if (r.ok) {
        setData(r.data);
        setError(null);
      } else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [key, tick]);
  if (names.length === 0) return <p className="text-muted">This alarm widget lists no alarms.</p>;
  if (error) return <ErrorBanner message={error} />;
  if (!data) return <Spinner />;
  return (
    <div className="space-y-2" data-testid="alarm-widget">
      <ul className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
        {data.alarms.map((a) => (
          <li key={a.name} className="rounded-[4px] border border-line-soft px-3 py-2" title={a.reason ?? undefined} data-testid={`alarm-status-${a.name}`}>
            <p className="truncate font-semibold text-ink">{a.name}</p>
            <StatusBadge value={a.state} />
            <p className="text-[11px] text-muted">{a.type}{a.updated ? ` · ${formatDate(a.updated)}` : ""}</p>
          </li>
        ))}
      </ul>
      {data.missing.length > 0 && <p className="text-[12px] text-muted">Not found: {data.missing.join(", ")}</p>}
    </div>
  );
}

type LogState = { kind: "running"; results: InsightsResults | null } | { kind: "done"; results: InsightsResults } | { kind: "error"; error: string };

export function LogWidget({ widget, range, tick }: { widget: DashboardWidget; range: number; tick: number }) {
  const { groups, query } = logWidgetQuery(widget.properties);
  const groupKey = groups.join("\u0000");
  // Each run's results are tagged with the run they belong to, so a new time range or
  // refresh shows "running" until its own results arrive.
  const runKey = `${groupKey}\u0001${query}\u0001${range}\u0001${tick}`;
  const [tagged, setTagged] = useState<{ key: string; state: LogState } | null>(null);
  const state: LogState = tagged && tagged.key === runKey ? tagged.state : { kind: "running", results: null };

  useEffect(() => {
    const list = groupKey === "" ? [] : groupKey.split("\u0000");
    if (list.length === 0 || query === "") return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const setState = (next: LogState) => setTagged({ key: runKey, state: next });
    const poll = async (id: string, n: number) => {
      const r = await getInsightsResults(id);
      if (!live) return;
      if (!r.ok) return setState({ kind: "error", error: r.error });
      if (DONE.includes(r.data.status)) {
        setState(r.data.status === "Complete" ? { kind: "done", results: r.data } : { kind: "error", error: `The query ended with status ${r.data.status}.` });
      } else if (n >= MAX_POLLS) {
        setState({ kind: "error", error: `The query was still ${r.data.status} after ${MAX_POLLS} seconds.` });
      } else {
        setState({ kind: "running", results: r.data });
        timer = setTimeout(() => void poll(id, n + 1), POLL_MS);
      }
    };
    void startInsightsQuery(list, query, range, ROW_LIMIT).then((r) => {
      if (!live) return;
      if (!r.ok) return setState({ kind: "error", error: r.error });
      void poll(r.data.queryId, 0);
    });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [groupKey, query, range, tick, runKey]);

  if (groups.length === 0) return <ErrorBanner message="This log widget's query names no log groups (SOURCE 'log-group' | …)." />;
  if (query === "") return <ErrorBanner message="This log widget has no query." />;
  if (state.kind === "error") return <ErrorBanner title="Query failed" message={state.error} />;
  const results = state.results;
  return (
    <div className="space-y-2" data-testid="log-widget">
      <p className="truncate text-[12px] text-muted" title={groups.join(", ")}>
        {groups.join(", ")}
        {results && state.kind === "done" && ` · ${results.rows.length} record${results.rows.length === 1 ? "" : "s"}${results.recordsScanned !== null ? ` of ${results.recordsScanned} scanned` : ""}`}
      </p>
      {state.kind === "running" && <Spinner label={results ? `Query ${results.status}` : "Running query"} />}
      {results && state.kind === "done" && results.rows.length === 0 && <p className="text-muted">No data found.</p>}
      {results && results.rows.length > 0 && (
        <div className="max-h-80 overflow-auto">
          <table className="w-full border-collapse text-left text-[12px]" data-testid="log-widget-table">
            <thead>
              <tr className="border-b border-line bg-shade text-muted">
                {results.columns.map((c) => (
                  <th key={c} className="px-2 py-1.5 font-bold">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {results.rows.map((row, i) => (
                <tr key={i} className="border-b border-line-soft align-top">
                  {results.columns.map((c) => (
                    <td key={c} className="px-2 py-1 font-mono break-all">{row[c] ?? ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
