"use client";

import Link from "next/link";
import { useState } from "react";
import { formatDate } from "@/console/format";
import { Button, Container, EmptyState, ErrorBanner } from "@/console/ui/primitives";
import { lookupEvents, type EventPage } from "./event-actions";
import type { EventFilter, EventRow } from "./events";

interface EventHistoryProps {
  initial: EventPage | null;
  initialError: string | null;
  lookupKeys: { value: string; label: string }[];
}

const EMPTY: EventFilter = { key: "", value: "", start: "", end: "" };

/** datetime-local gives "2026-11-23T10:00" in local time; send it as an ISO instant. */
function toIso(local: string): string {
  if (!local) return "";
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

export function EventHistory({ initial, initialError, lookupKeys }: EventHistoryProps) {
  const [rows, setRows] = useState<EventRow[]>(initial?.rows ?? []);
  const [nextToken, setNextToken] = useState<string | null>(initial?.nextToken ?? null);
  const [error, setError] = useState<string | null>(initialError);
  const [filter, setFilter] = useState<EventFilter>(EMPTY);
  const [applied, setApplied] = useState<EventFilter>(EMPTY);
  const [busy, setBusy] = useState(false);

  async function search(f: EventFilter) {
    setBusy(true);
    const sent = { ...f, start: toIso(f.start), end: toIso(f.end) };
    const r = await lookupEvents(sent, null);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setError(null);
    setApplied(sent);
    setRows(r.data.rows);
    setNextToken(r.data.nextToken);
  }

  async function more() {
    if (!nextToken) return;
    setBusy(true);
    const r = await lookupEvents(applied, nextToken);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setRows((prev) => [...prev, ...r.data.rows]);
    setNextToken(r.data.nextToken);
  }

  const set = (k: keyof EventFilter, v: string) => setFilter((prev) => ({ ...prev, [k]: v }));
  const inputClass = "rounded-[4px] border border-[#879596] bg-white px-2.5 py-1.5 text-[13px] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

  return (
    <div className="space-y-4" data-testid="event-history">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <Container
        title="Event history"
        counter={`(${rows.length}${nextToken ? "+" : ""})`}
        description="Event history shows the last 90 days of management events in this Region. Filter by one lookup attribute and a time range."
        actions={
          <Button aria-label="Refresh events" disabled={busy} onClick={() => void search(filter)}>
            ⟳
          </Button>
        }
      >
        <form
          className="mb-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void search(filter);
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="font-bold">Lookup attributes</span>
            <select aria-label="Lookup attribute" className={inputClass} value={filter.key} onChange={(e) => set("key", e.target.value)}>
              <option value="">Any attribute</option>
              {lookupKeys.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-bold">Value</span>
            {filter.key === "ReadOnly" ? (
              <select aria-label="Lookup value" className={inputClass} value={filter.value} onChange={(e) => set("value", e.target.value)}>
                <option value="">Choose</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input aria-label="Lookup value" className={inputClass} placeholder={filter.key ? "Enter a value" : "Choose an attribute first"} disabled={!filter.key} value={filter.value} onChange={(e) => set("value", e.target.value)} />
            )}
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-bold">Start time</span>
            <input type="datetime-local" aria-label="Start time" className={inputClass} value={filter.start} onChange={(e) => set("start", e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-bold">End time</span>
            <input type="datetime-local" aria-label="End time" className={inputClass} value={filter.end} onChange={(e) => set("end", e.target.value)} />
          </label>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Searching…" : "Apply"}
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              setFilter(EMPTY);
              void search(EMPTY);
            }}
          >
            Clear filters
          </Button>
        </form>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left" data-testid="events-table">
            <thead>
              <tr className="border-b-2 border-line-soft">
                <th className="px-2 py-2">Event name</th>
                <th className="px-2 py-2">Event time</th>
                <th className="px-2 py-2">User name</th>
                <th className="px-2 py-2">Event source</th>
                <th className="px-2 py-2">Resource type</th>
                <th className="px-2 py-2">Resource name</th>
                <th className="px-2 py-2">Error code</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line-soft hover:bg-shade">
                  <td className="px-2 py-2">
                    <Link href={`/cloudtrail/event-history/${encodeURIComponent(r.id)}`}>{r.name || r.id}</Link>
                  </td>
                  <td className="px-2 py-2">{formatDate(r.time)}</td>
                  <td className="px-2 py-2">{r.user ?? "-"}</td>
                  <td className="px-2 py-2">{r.source ?? "-"}</td>
                  <td className="px-2 py-2">{r.resourceType ?? "-"}</td>
                  <td className="px-2 py-2 break-all">{r.resourceName ?? "-"}</td>
                  <td className="px-2 py-2">{r.errorCode ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && !error && <EmptyState title="No events">No events match these filters in the last 90 days.</EmptyState>}
        {nextToken && (
          <div className="mt-3">
            <Button disabled={busy} onClick={() => void more()}>
              Load more events
            </Button>
          </div>
        )}
      </Container>
    </div>
  );
}
