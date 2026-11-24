"use client";

/**
 * Hand-built DynamoDB "Explore items" screen: tables on the left; scan or query the chosen
 * table or index with key conditions and filters; create, edit and delete items.
 */

import Link from "next/link";
import { useState } from "react";
import { Modal } from "@/console/ui/Modal";
import { Button, Container, EmptyState, ErrorBanner, Flash } from "@/console/ui/primitives";
import { displayValue, FILTER_OPS, itemColumns, KEY_OPS, OP_LABELS, type Condition, type FilterOp, type KeyOp, type ScalarType, type WireItem } from "./attr";
import { ItemEditor } from "./ItemEditor";
import { deleteItems, runItemQuery, type ItemPage, type ItemQuery, type TableSchema } from "./item-actions";

const inputClass = "w-full rounded-[4px] border border-[#879596] bg-white px-2.5 py-1.5 text-[13px] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";
const SCALARS: { value: ScalarType; label: string }[] = [
  { value: "S", label: "String" },
  { value: "N", label: "Number" },
  { value: "B", label: "Binary" },
  { value: "BOOL", label: "Boolean" },
  { value: "NULL", label: "Null" },
];

interface ItemExplorerProps {
  tables: string[];
  tablesError: string | null;
  schema: TableSchema | null;
  schemaError: string | null;
  initial: ItemPage | null;
  initialError: string | null;
}

type Dialog = { kind: "create" } | { kind: "edit"; item: WireItem } | { kind: "delete" } | null;

export function ItemExplorer({ tables, tablesError, schema, schemaError, initial, initialError }: ItemExplorerProps) {
  const [tableFilter, setTableFilter] = useState("");
  const shown = tables.filter((t) => t.toLowerCase().includes(tableFilter.trim().toLowerCase()));
  return (
    <div className="flex flex-col gap-5 lg:flex-row">
      <aside className="lg:w-64 lg:shrink-0">
        <Container title="Tables" counter={`(${tables.length})`}>
          <input type="search" aria-label="Find tables" placeholder="Find tables" className={`${inputClass} mb-3`} value={tableFilter} onChange={(e) => setTableFilter(e.target.value)} />
          {tablesError && <ErrorBanner message={tablesError} />}
          <ul className="space-y-1" data-testid="explorer-tables">
            {shown.map((t) => (
              <li key={t}>
                <Link href={`/dynamodb/explore-items?table=${encodeURIComponent(t)}`} className={`block break-all ${t === schema?.name ? "font-bold" : ""}`}>
                  {t}
                </Link>
              </li>
            ))}
          </ul>
          {tables.length === 0 && !tablesError && <EmptyState title="No tables" />}
        </Container>
      </aside>
      <div className="min-w-0 flex-1 space-y-5">
        {schemaError && <ErrorBanner message={schemaError} />}
        {!schema && !schemaError && (
          <Container title="Explore items">
            <EmptyState title="Choose a table">
              <p>Select a table on the left to scan or query its items.</p>
            </EmptyState>
          </Container>
        )}
        {schema && <TableItems key={schema.name} schema={schema} initial={initial} initialError={initialError} />}
      </div>
    </div>
  );
}

function emptyFilter(): Condition {
  return { attr: "", type: "S", op: "=", value: "", value2: "" };
}

function TableItems({ schema, initial, initialError }: { schema: TableSchema; initial: ItemPage | null; initialError: string | null }) {
  const keyNames = [schema.partition.name, ...(schema.sort ? [schema.sort.name] : [])];
  const [mode, setMode] = useState<"scan" | "query">("scan");
  const [index, setIndex] = useState("");
  const [pkValue, setPkValue] = useState("");
  const [skOp, setSkOp] = useState<KeyOp>("=");
  const [skValue, setSkValue] = useState("");
  const [skValue2, setSkValue2] = useState("");
  const [filters, setFilters] = useState<Condition[]>([]);
  const [pages, setPages] = useState<ItemPage[]>(initial ? [initial] : []);
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [lastQuery, setLastQuery] = useState<ItemQuery>({ table: schema.name, mode: "scan", index: null, pkValue: "", skOp: "=", skValue: "", skValue2: "", filters: [], limit: 50, startKey: null });

  const keys = index ? schema.indexes.find((i) => i.name === index) ?? schema : schema;
  const items = pages.flatMap((p) => p.items);
  const lastKey = pages.at(-1)?.lastKey ?? null;
  const columns = itemColumns(items, keyNames);
  const scanned = pages.reduce((n, p) => n + p.scannedCount, 0);

  async function run(query: ItemQuery, append: boolean) {
    setBusy(true);
    const r = await runItemQuery(query);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setError(null);
    setLastQuery(query);
    setPages((prev) => (append ? [...prev, r.data] : [r.data]));
    if (!append) setSelected([]);
  }

  const submit = () =>
    void run({ table: schema.name, mode, index: index || null, pkValue, skOp, skValue, skValue2, filters, limit: 50, startKey: null }, false);

  async function removeSelected() {
    setBusy(true);
    const keysToDelete = selected.map((i) => Object.fromEntries(keyNames.map((k) => [k, items[i][k]])));
    const r = await deleteItems(schema.name, keysToDelete);
    setBusy(false);
    setDialog(null);
    if (!r.ok) return setError(r.error);
    setNotice(`Deleted ${r.data.deleted} item${r.data.deleted === 1 ? "" : "s"}.`);
    await run({ ...lastQuery, startKey: null }, false);
  }

  const setFilter = (i: number, patch: Partial<Condition>) => setFilters((prev) => prev.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const toggle = (i: number, on: boolean) => setSelected((prev) => (on ? [...prev, i] : prev.filter((x) => x !== i)));

  return (
    <>
      <Container title={schema.name} description={`Status: ${schema.status ?? "-"} · Approximate item count: ${schema.itemCount ?? "-"} (DescribeTable updates this periodically)`}>
        <form
          className="space-y-3"
          data-testid="scan-query-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-wrap items-center gap-4">
            {(["scan", "query"] as const).map((m) => (
              <label key={m} className="flex items-center gap-2">
                <input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} />
                <span>{m === "scan" ? "Scan" : "Query"}</span>
              </label>
            ))}
            <label className="flex min-w-64 items-center gap-2">
              <span className="shrink-0">Table or index</span>
              <select aria-label="Table or index" className={inputClass} value={index} onChange={(e) => setIndex(e.target.value)}>
                <option value="">Table - {schema.name}</option>
                {schema.indexes.map((i) => (
                  <option key={i.name} value={i.name}>
                    {i.kind === "Global" ? "GSI" : "LSI"} - {i.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {mode === "query" && (
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block space-y-1">
                <span className="font-bold">
                  {keys.partition.name} (Partition key)
                </span>
                <input aria-label="Partition key value" className={inputClass} placeholder={`Enter ${keys.partition.type === "N" ? "a number" : "a value"}`} value={pkValue} onChange={(e) => setPkValue(e.target.value)} />
              </label>
              {keys.sort && (
                <div className="space-y-1">
                  <span className="font-bold">{keys.sort.name} (Sort key)</span>
                  <div className="flex gap-2">
                    <select aria-label="Sort key condition" className={`${inputClass} max-w-48`} value={skOp} onChange={(e) => setSkOp(e.target.value as KeyOp)}>
                      {KEY_OPS.map((o) => (
                        <option key={o} value={o}>
                          {OP_LABELS[o]}
                        </option>
                      ))}
                    </select>
                    <input aria-label="Sort key value" className={inputClass} placeholder="Value - optional" value={skValue} onChange={(e) => setSkValue(e.target.value)} />
                    {skOp === "between" && <input aria-label="Sort key second value" className={inputClass} placeholder="And" value={skValue2} onChange={(e) => setSkValue2(e.target.value)} />}
                  </div>
                </div>
              )}
            </div>
          )}
          <details open={filters.length > 0}>
            <summary className="cursor-pointer font-bold">Filters - optional</summary>
            <div className="mt-2 space-y-2">
              {filters.map((f, i) => (
                <div key={i} className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_8rem_10rem_1fr_auto]">
                  <input aria-label={`Filter ${i + 1} attribute name`} className={inputClass} placeholder="Attribute name" value={f.attr} onChange={(e) => setFilter(i, { attr: e.target.value })} />
                  <select aria-label={`Filter ${i + 1} type`} className={inputClass} value={f.type} onChange={(e) => setFilter(i, { type: e.target.value as ScalarType })}>
                    {SCALARS.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <select aria-label={`Filter ${i + 1} condition`} className={inputClass} value={f.op} onChange={(e) => setFilter(i, { op: e.target.value as FilterOp })}>
                    {FILTER_OPS.map((o) => (
                      <option key={o} value={o}>
                        {OP_LABELS[o]}
                      </option>
                    ))}
                  </select>
                  <div className="flex gap-2">
                    {f.op !== "exists" && f.op !== "not_exists" && <input aria-label={`Filter ${i + 1} value`} className={inputClass} placeholder="Value" value={f.value} onChange={(e) => setFilter(i, { value: e.target.value })} />}
                    {f.op === "between" && <input aria-label={`Filter ${i + 1} second value`} className={inputClass} placeholder="And" value={f.value2} onChange={(e) => setFilter(i, { value2: e.target.value })} />}
                  </div>
                  <Button variant="link" onClick={() => setFilters((prev) => prev.filter((_, j) => j !== i))}>
                    Remove
                  </Button>
                </div>
              ))}
              <Button onClick={() => setFilters((prev) => [...prev, emptyFilter()])}>Add filter</Button>
            </div>
          </details>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={busy} data-testid="run-query">
              {busy ? "Running…" : "Run"}
            </Button>
            <Button
              onClick={() => {
                setMode("scan");
                setIndex("");
                setPkValue("");
                setSkValue("");
                setSkValue2("");
                setFilters([]);
              }}
            >
              Reset
            </Button>
          </div>
        </form>
      </Container>

      {notice && <Flash kind="success" message={notice} onDismiss={() => setNotice(null)} />}
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <Container
        title="Items returned"
        counter={`(${items.length}${lastKey ? "+" : ""})`}
        description={pages.length ? `${lastQuery.mode === "query" ? "Query" : "Scan"} read ${scanned} item${scanned === 1 ? "" : "s"}${lastQuery.filters.some((f) => f.attr) ? " before filtering" : ""}.` : undefined}
        actions={
          <>
            <Button aria-label="Refresh items" disabled={busy} onClick={() => void run({ ...lastQuery, startKey: null }, false)}>
              ⟳
            </Button>
            <Button disabled={selected.length !== 1} onClick={() => setDialog({ kind: "edit", item: items[selected[0]] })}>
              Edit item
            </Button>
            <Button disabled={selected.length === 0 || busy} onClick={() => setDialog({ kind: "delete" })}>
              Delete items
            </Button>
            <Button variant="primary" onClick={() => setDialog({ kind: "create" })}>
              Create item
            </Button>
          </>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left" data-testid="items-table">
            <thead>
              <tr className="border-b-2 border-line-soft">
                <th className="w-8" />
                {columns.map((c) => (
                  <th key={c} className="px-2 py-2 whitespace-nowrap">
                    {c}
                    {c === keyNames[0] ? " (Partition key)" : c === keyNames[1] ? " (Sort key)" : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i} className="border-b border-line-soft align-top hover:bg-shade">
                  <td className="px-2 py-2">
                    <input type="checkbox" aria-label={`Select item ${keyNames.map((k) => displayValue(it[k])).join(" ")}`} checked={selected.includes(i)} onChange={(e) => toggle(i, e.target.checked)} />
                  </td>
                  {columns.map((c, j) => (
                    <td key={c} className="max-w-xs px-2 py-2 break-words">
                      {j === 0 ? (
                        <button type="button" className="text-link hover:underline" onClick={() => setDialog({ kind: "edit", item: it })}>
                          {displayValue(it[c])}
                        </button>
                      ) : (
                        <span className={it[c] && !("S" in it[c]) && !("N" in it[c]) ? "font-mono text-[13px]" : ""}>{displayValue(it[c])}</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {pages.length > 0 && items.length === 0 && <EmptyState title="No items returned" />}
        {lastKey && (
          <div className="mt-3">
            <Button disabled={busy} onClick={() => void run({ ...lastQuery, startKey: lastKey }, true)}>
              Load more
            </Button>
          </div>
        )}
      </Container>

      {(dialog?.kind === "create" || dialog?.kind === "edit") && (
        <ItemEditor
          schema={schema}
          item={dialog.kind === "edit" ? dialog.item : null}
          onClose={() => setDialog(null)}
          onSaved={(message) => {
            setDialog(null);
            setNotice(message);
            void run({ ...lastQuery, startKey: null }, false);
          }}
        />
      )}
      {dialog?.kind === "delete" && (
        <Modal
          title="Delete items"
          onClose={() => setDialog(null)}
          footer={
            <>
              <Button variant="link" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => void removeSelected()} data-testid="confirm-delete-items">
                Delete
              </Button>
            </>
          }
        >
          <p>
            Are you sure you want to delete {selected.length} item{selected.length === 1 ? "" : "s"}? This can&apos;t be undone.
          </p>
        </Modal>
      )}
    </>
  );
}
