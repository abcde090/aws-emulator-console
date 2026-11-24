"use client";

import Link from "next/link";
import { useState } from "react";
import { CellValue } from "@/console/ui/CellValue";
import { Button, Container, EmptyState, ErrorBanner, PageHeader } from "@/console/ui/primitives";
import type { Row } from "@/console/types";
import { queryTraces } from "./trace-actions";

const input = "rounded-[4px] border border-[#879596] bg-white px-2.5 py-1.5 text-[13px] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";
const RANGES = [
  { label: "Last 5 minutes", seconds: 300 },
  { label: "Last 15 minutes", seconds: 900 },
  { label: "Last 1 hour", seconds: 3600 },
  { label: "Last 6 hours", seconds: 21600 },
  { label: "Last 24 hours", seconds: 86400 },
];
const COLUMNS = [
  { key: "time", label: "Trace start time", kind: "date" as const },
  { key: "status", label: "Trace status", kind: "status" as const },
  { key: "responseCode", label: "Response code", kind: "text" as const },
  { key: "responseTime", label: "Response time (s)", kind: "text" as const },
  { key: "method", label: "HTTP method", kind: "text" as const },
  { key: "url", label: "URL address", kind: "text" as const },
  { key: "services", label: "Nodes", kind: "text" as const },
];

/** Trace query: a filter expression and time range run through GetTraceSummaries. */
export function TraceQuery({ initialRows, initialError }: { initialRows: Row[]; initialError: string | null }) {
  const [filter, setFilter] = useState("");
  const [range, setRange] = useState(21600);
  const [rows, setRows] = useState<Row[]>(initialRows);
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    const r = await queryTraces(filter, range);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setError(null);
    setRows(r.data);
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Traces" description="Search and analyze the traces your applications send to X-Ray." />
      <Container title="Query" description="Filter traces with an X-Ray filter expression, e.g. service(&quot;api&quot;) { fault = true } or responsetime > 1 or http.status = 500.">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <label className="flex min-w-72 flex-1 flex-col gap-1">
            <span className="font-bold">Filter expression</span>
            <input aria-label="Filter expression" className={`${input} font-mono`} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder='service("my-service")' />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-bold">Time range</span>
            <select aria-label="Time range" className={input} value={range} onChange={(e) => setRange(Number(e.target.value))}>
              {RANGES.map((r) => (
                <option key={r.seconds} value={r.seconds}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Running…" : "Run query"}
          </Button>
        </form>
      </Container>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <Container title="Traces" counter={`(${rows.length})`}>
        {rows.length === 0 ? (
          <EmptyState title="No traces">No traces match the filter in this time range.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left" data-testid="trace-table">
              <thead>
                <tr className="border-b-2 border-line-soft">
                  <th className="px-2 py-2">Trace ID</th>
                  {COLUMNS.map((c) => (
                    <th key={c.key} className="px-2 py-2 whitespace-nowrap">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={String(r.id)} className="border-b border-line-soft hover:bg-shade">
                    <td className="px-2 py-1.5 font-mono text-[13px]">
                      <Link href={`/xray/traces/${encodeURIComponent(String(r.id))}`}>{String(r.id)}</Link>
                    </td>
                    {COLUMNS.map((c) => (
                      <td key={c.key} className="max-w-md px-2 py-1.5">
                        <CellValue kind={c.kind} value={r[c.key]} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Container>
    </div>
  );
}
