"use client";

import { useState } from "react";
import { fillHref } from "../format.ts";
import type { ActionResult, Row } from "../types.ts";
import { CellValue } from "./CellValue.tsx";
import { Button, EmptyState } from "./primitives.tsx";

type TableResult = NonNullable<ActionResult["table"]>;

interface ResultTableProps {
  table: TableResult;
  busy: boolean;
  onSelectionAction?: (keys: string[]) => void;
}

/** Rows an action returned (e.g. received messages), optionally selectable for a follow-up action. */
export function ResultTable({ table, busy, onSelectionAction }: ResultTableProps) {
  const [picked, setPicked] = useState<string[]>([]);
  const keyOf = (r: Row) => String(r[table.rowKey] ?? "");
  // CQ-3: only keys still in the table count, so rows removed by a follow-up action (or a new
  // result) drop out of the selection and are never sent again.
  const selected = picked.filter((k) => table.rows.some((r) => keyOf(r) === k));
  const setSelected = (update: (prev: string[]) => string[]) => setPicked(update(selected));
  const selectable = Boolean(table.selectionAction && onSelectionAction);
  if (table.rows.length === 0) return <EmptyState title={table.emptyText ?? "No results"} />;
  return (
    <div className="space-y-2">
      {selectable && table.selectionAction && (
        <div className="flex justify-end">
          <Button variant={table.selectionAction.danger ? "danger" : "normal"} disabled={busy || selected.length === 0} onClick={() => onSelectionAction?.(selected)}>
            {table.selectionAction.label} ({selected.length})
          </Button>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-[13px]" data-testid="result-table">
          <thead>
            <tr className="border-b border-line bg-shade text-muted">
              {selectable && <th className="w-8" />}
              {table.columns.map((c) => (
                <th key={c.key} className="px-2.5 py-2 font-bold">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r) => {
              const k = keyOf(r);
              return (
                <tr key={k} className="border-b border-line-soft align-top">
                  {selectable && (
                    <td className="px-2 py-1.5">
                      <input
                        type="checkbox"
                        aria-label="Select row"
                        checked={selected.includes(k)}
                        onChange={(e) => setSelected((prev) => (e.target.checked ? [...prev, k] : prev.filter((x) => x !== k)))}
                      />
                    </td>
                  )}
                  {table.columns.map((c) => (
                    <td key={c.key} className="max-w-md px-2 py-1.5">
                      <CellValue kind={c.kind} value={r[c.key]} href={fillHref(c.href, r)} />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
