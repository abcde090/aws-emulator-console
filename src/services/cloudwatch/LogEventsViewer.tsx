"use client";

import { useCallback, useState } from "react";
import { formatDate } from "@/console/format";
import { Button, Container, EmptyState, ErrorBanner, Spinner } from "@/console/ui/primitives";
import { filterLogEvents, type EventPage } from "./logs-actions";
import { RANGES } from "./helpers";

const input = "rounded-[4px] border border-[#879596] bg-white px-2.5 py-1.5 text-[13px] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

interface LogEventsViewerProps {
  group: string;
  streams: string[];
}

/** Log events of a log group, filtered by stream, filter pattern and time range (FilterLogEvents). */
export function LogEventsViewer({ group, streams }: LogEventsViewerProps) {
  const [stream, setStream] = useState("");
  const [pattern, setPattern] = useState("");
  const [range, setRange] = useState<number>(0);
  const [page, setPage] = useState<EventPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const search = useCallback(
    async (more: boolean) => {
      setBusy(true);
      const r = await filterLogEvents({ group, stream, pattern, rangeSeconds: range || undefined, nextToken: more ? page?.nextToken : null });
      setBusy(false);
      if (!r.ok) return setError(r.error);
      setError(null);
      setPage(more && page ? { events: [...page.events, ...r.data.events], nextToken: r.data.nextToken } : r.data);
    },
    [group, stream, pattern, range, page]
  );

  return (
    <Container title="Log events" counter={page ? `(${page.events.length}${page.nextToken ? "+" : ""})` : undefined} description="Search the log group's events. Filter patterns use the CloudWatch Logs syntax, e.g. ERROR, &quot;timed out&quot; or { $.level = &quot;ERROR&quot; }.">
      <form
        className="mb-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void search(false);
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="font-bold">Log stream</span>
          <select aria-label="Log stream" className={input} value={stream} onChange={(e) => setStream(e.target.value)}>
            <option value="">All log streams</option>
            {streams.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-64 flex-1 flex-col gap-1">
          <span className="font-bold">Filter events</span>
          <input aria-label="Filter events" className={input} value={pattern} placeholder="Filter pattern" onChange={(e) => setPattern(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-bold">Time range</span>
          <select aria-label="Time range" className={input} value={range} onChange={(e) => setRange(Number(e.target.value))}>
            <option value={0}>All time</option>
            {RANGES.map((r) => (
              <option key={r.key} value={r.seconds}>
                Last {r.label}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Searching…" : "Search"}
        </Button>
      </form>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {busy && !page && <Spinner />}
      {page && page.events.length === 0 && <EmptyState title="No events found">No log events match the filter and time range.</EmptyState>}
      {page && page.events.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left" data-testid="log-events">
            <thead>
              <tr className="border-b-2 border-line-soft">
                <th className="px-2 py-2 whitespace-nowrap">Timestamp</th>
                <th className="px-2 py-2">Log stream</th>
                <th className="px-2 py-2">Message</th>
              </tr>
            </thead>
            <tbody>
              {page.events.map((e) => (
                <tr key={e.id} className="cursor-pointer border-b border-line-soft align-top hover:bg-shade" onClick={() => setOpen(open === e.id ? null : e.id)}>
                  <td className="px-2 py-1.5 whitespace-nowrap">{formatDate(e.timestamp)}</td>
                  <td className="px-2 py-1.5 break-all">{e.stream}</td>
                  <td className={`px-2 py-1.5 font-mono text-[13px] ${open === e.id ? "whitespace-pre-wrap" : "truncate"} max-w-2xl break-all`}>{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page?.nextToken && (
        <div className="mt-3">
          <Button disabled={busy} onClick={() => void search(true)}>
            Load more
          </Button>
        </div>
      )}
    </Container>
  );
}
