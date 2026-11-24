"use client";

import { useState, type ReactNode } from "react";
import { fillHref } from "../format.ts";
import { orderTabIds, type TabPlacement } from "../tabs.ts";
import type { ColumnDef, DetailTab, Row } from "../types.ts";
import { CellValue } from "./CellValue.tsx";
import { JsonView } from "./JsonView.tsx";
import { KeyValue } from "./KeyValue.tsx";
import { Container, EmptyState } from "./primitives.tsx";

function isEmptyData(tab: DetailTab): boolean {
  const d = tab.data;
  if (d === null || d === undefined || d === "") return true;
  if (Array.isArray(d)) return d.length === 0;
  if (tab.kind === "keyvalue" && typeof d === "object") return Object.keys(d as object).length === 0;
  return false;
}

export function TabBody({ tab }: { tab: DetailTab }) {
  if (isEmptyData(tab)) return <EmptyState title={tab.emptyText ?? "Nothing to show"} />;
  switch (tab.kind) {
    case "keyvalue":
      return <KeyValue data={tab.data as Row} />;
    case "json":
      return <JsonView value={tab.data} />;
    case "text":
      return <pre className="font-mono text-[13px] whitespace-pre-wrap">{String(tab.data)}</pre>;
    case "table": {
      const rows = tab.data as Row[];
      const columns: ColumnDef[] = tab.columns ?? Object.keys(rows[0] ?? {}).map((k) => ({ key: k, label: k, kind: "text" as const }));
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-shade text-muted">
                {columns.map((c) => (
                  <th key={c.key} className="px-3 py-2 font-bold">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-line-soft align-top hover:bg-shade">
                  {columns.map((c) => (
                    <td key={c.key} className="max-w-xl px-3 py-2">
                      <CellValue kind={c.kind} value={r[c.key]} href={fillHref(c.href, r)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
  }
}

/** A hand-built tab. `after` places it among the definition's tabs (see tabs.ts). */
export interface ExtraTab extends TabPlacement {
  label: string;
  content: ReactNode;
}

/** Console-style tabs. `extra` tabs (hand-built content) come first unless they say `after`. */
export function DetailTabs({ tabs, extra = [] }: { tabs: DetailTab[]; extra?: ExtraTab[] }) {
  const labels = new Map<string, string>([...tabs.map((t): [string, string] => [t.id, t.label]), ...extra.map((e): [string, string] => [e.id, e.label])]);
  const all = orderTabIds(
    tabs.map((t) => t.id),
    extra
  ).map((id) => ({ id, label: labels.get(id) ?? id }));
  const [active, setActive] = useState(all[0]?.id ?? "");
  if (all.length === 0) return null;
  const extraTab = extra.find((e) => e.id === active);
  const tab = tabs.find((t) => t.id === active);
  return (
    <div className="space-y-4">
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-line">
        {all.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === active}
            className={`-mb-px border-b-2 px-4 py-2 text-[13px] font-semibold transition-colors ${
              t.id === active ? "border-accent text-accent" : "border-transparent text-muted hover:text-ink"
            }`}
            onClick={() => setActive(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {extraTab && <div>{extraTab.content}</div>}
      {tab && (
        <Container title={tab.label} description={tab.description}>
          <TabBody tab={tab} />
        </Container>
      )}
    </div>
  );
}
