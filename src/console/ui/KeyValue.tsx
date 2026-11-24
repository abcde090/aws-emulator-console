/** A key-value panel, in columns as on console detail pages. */

import type { Row } from "../types.ts";
import { formatDate } from "../format.ts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function show(v: unknown): string {
  if (v === null || v === undefined || v === "") return "-";
  if (typeof v === "boolean") return v ? "Enabled" : "Disabled";
  if (typeof v === "string" && ISO_DATE.test(v)) return formatDate(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function KeyValue({ data, labels, columns = 3 }: { data: Row; labels?: Record<string, string>; columns?: 1 | 2 | 3 }) {
  const entries = Object.entries(data);
  const grid = columns === 1 ? "" : columns === 2 ? "md:grid-cols-2" : "md:grid-cols-3";
  return (
    <dl className={`grid grid-cols-1 gap-x-8 gap-y-4 text-[13px] ${grid}`}>
      {entries.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-[12px] font-semibold text-muted">{labels?.[k] ?? k}</dt>
          <dd className="mt-0.5 break-words text-ink" data-testid={`kv-${k}`}>
            {show(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
