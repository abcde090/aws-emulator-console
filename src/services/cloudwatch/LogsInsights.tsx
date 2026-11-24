"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { formatBytes, formatCount } from "@/console/format";
import { Button, Container, EmptyState, ErrorBanner, Spinner, StatusBadge } from "@/console/ui/primitives";
import { getInsightsResults, startInsightsQuery, type InsightsResults } from "./logs-actions";
import { RANGES } from "./helpers";

const input = "rounded-[4px] border border-[#879596] bg-white px-2.5 py-1.5 text-[13px] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";
const DEFAULT_QUERY = "fields @timestamp, @message, @logStream, @log\n| sort @timestamp desc\n| limit 20";
const POLL_MS = 1000;
const DONE = ["Complete", "Failed", "Cancelled", "Timeout"];

/** Logs Insights: select log groups, write a query, run it and poll GetQueryResults. */
export function LogsInsights({ groups, initialGroup }: { groups: string[]; initialGroup: string | null }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>(initialGroup && groups.includes(initialGroup) ? [initialGroup] : []);
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [range, setRange] = useState<number>(3600);
  const [queryId, setQueryId] = useState<string | null>(null);
  const [results, setResults] = useState<InsightsResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function poll(id: string) {
    const r = await getInsightsResults(id);
    if (!r.ok) {
      setRunning(false);
      return setError(r.error);
    }
    setResults(r.data);
    if (DONE.includes(r.data.status)) {
      setRunning(false);
      router.refresh();
    } else timer.current = setTimeout(() => void poll(id), POLL_MS);
  }

  async function run() {
    setError(null);
    setResults(null);
    setRunning(true);
    const r = await startInsightsQuery(selected, query, range, 1000);
    if (!r.ok) {
      setRunning(false);
      return setError(r.error);
    }
    setQueryId(r.data.queryId);
    await poll(r.data.queryId);
  }

  return (
    <div className="space-y-4">
      <Container title="Logs Insights" description="Interactively search and analyze log data with the Logs Insights query language.">
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="font-bold">Log groups</span>
            <select aria-label="Log groups" multiple className={`${input} min-h-24 w-full`} value={selected} onChange={(e) => setSelected([...e.target.selectedOptions].map((o) => o.value))}>
              {groups.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
            {groups.length === 0 && <span className="text-muted">No log groups exist yet.</span>}
          </label>
          <label className="block space-y-1">
            <span className="font-bold">Query</span>
            <textarea aria-label="Query" className={`${input} min-h-32 w-full font-mono text-[13px]`} value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2">
              <span className="font-bold">Time range</span>
              <select aria-label="Time range" className={input} value={range} onChange={(e) => setRange(Number(e.target.value))}>
                {RANGES.map((r) => (
                  <option key={r.key} value={r.seconds}>
                    Last {r.label}
                  </option>
                ))}
              </select>
            </label>
            <Button variant="primary" disabled={running || selected.length === 0} onClick={() => void run()}>
              {running ? "Running…" : "Run query"}
            </Button>
            {queryId && <span className="font-mono text-[13px] text-muted">Query ID {queryId}</span>}
          </div>
        </div>
      </Container>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {(results || running) && (
        <Container
          title="Logs"
          counter={results ? `(${results.rows.length})` : undefined}
          description={
            results ? (
              <span className="flex flex-wrap items-center gap-3">
                <StatusBadge value={results.status} />
                <span>{formatCount(results.recordsMatched)} records matched</span>
                <span>{formatCount(results.recordsScanned)} records scanned</span>
                <span>{formatBytes(results.bytesScanned)} scanned</span>
              </span>
            ) : undefined
          }
        >
          {running && !results && <Spinner label="Running query" />}
          {results && results.rows.length === 0 && <EmptyState title="No data found">The query matched no log events in this time range.</EmptyState>}
          {results && results.rows.length > 0 && (
            <div className="max-h-[32rem] overflow-auto">
              <table className="w-full border-collapse text-left" data-testid="insights-results">
                <thead>
                  <tr className="border-b-2 border-line-soft">
                    {results.columns.map((c) => (
                      <th key={c} className="px-2 py-2 whitespace-nowrap">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.rows.map((r) => (
                    <tr key={r["#"]} className="border-b border-line-soft align-top">
                      {results.columns.map((c) => (
                        <td key={c} className="max-w-xl px-2 py-1.5 font-mono text-[13px] break-all whitespace-pre-wrap">
                          {r[c] ?? ""}
                        </td>
                      ))}
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
