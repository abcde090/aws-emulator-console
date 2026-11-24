"use client";

/**
 * Hand-built DynamoDB "PartiQL editor": runs one statement with ExecuteStatement and shows
 * the items it returned, as a table or as DynamoDB JSON.
 */

import Link from "next/link";
import { useState } from "react";
import { Button, Container, EmptyState, ErrorBanner, Flash } from "@/console/ui/primitives";
import { JsonView } from "@/console/ui/JsonView";
import { displayValue, itemColumns, type WireItem } from "./attr";
import { runStatement } from "./item-actions";

const inputClass = "w-full rounded-[4px] border border-[#879596] bg-white px-2.5 py-1.5 text-[13px] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

export function PartiqlEditor({ tables, tablesError, initialTable }: { tables: string[]; tablesError: string | null; initialTable: string | null }) {
  const [statement, setStatement] = useState(initialTable ? `SELECT * FROM "${initialTable}"` : "");
  const [items, setItems] = useState<WireItem[] | null>(null);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [ran, setRan] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"table" | "json">("table");

  async function run(more: boolean) {
    setBusy(true);
    const stmt = more ? ran : statement;
    const r = await runStatement(stmt, more ? nextToken : null);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setError(null);
    setRan(stmt);
    setItems((prev) => (more && prev ? [...prev, ...r.data.items] : r.data.items));
    setNextToken(r.data.nextToken);
  }

  const columns = itemColumns(items ?? [], []);
  return (
    <div className="flex flex-col gap-5 lg:flex-row">
      <aside className="lg:w-64 lg:shrink-0">
        <Container title="Tables" counter={`(${tables.length})`}>
          {tablesError && <ErrorBanner message={tablesError} />}
          <ul className="space-y-1">
            {tables.map((t) => (
              <li key={t}>
                <button type="button" className="break-all text-left text-link hover:underline" onClick={() => setStatement(`SELECT * FROM "${t}"`)}>
                  {t}
                </button>
              </li>
            ))}
          </ul>
          {tables.length === 0 && !tablesError && <EmptyState title="No tables" />}
        </Container>
      </aside>
      <div className="min-w-0 flex-1 space-y-5">
        <Container title="Query 1" description={<>PartiQL is a SQL-compatible language for DynamoDB. Choose a table to start a SELECT, or write INSERT, UPDATE and DELETE statements. To browse with key conditions, use <Link href="/dynamodb/explore-items">Explore items</Link>.</>}>
          <textarea aria-label="PartiQL statement" className={`${inputClass} min-h-36 font-mono text-[13px]`} placeholder={'SELECT * FROM "Music" WHERE Artist = \'No One You Know\''} value={statement} onChange={(e) => setStatement(e.target.value)} />
          <div className="mt-3 flex gap-2">
            <Button variant="primary" disabled={busy || statement.trim() === ""} onClick={() => void run(false)} data-testid="run-statement">
              {busy ? "Running…" : "Run"}
            </Button>
            <Button onClick={() => setStatement("")}>Clear</Button>
          </div>
        </Container>
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
        {items && !error && items.length === 0 && <Flash kind="info" message="The statement ran successfully and returned no items." />}
        {items && items.length > 0 && (
          <Container
            title="Items returned"
            counter={`(${items.length}${nextToken ? "+" : ""})`}
            actions={
              <>
                <Button variant={view === "table" ? "primary" : "normal"} onClick={() => setView("table")}>
                  Table view
                </Button>
                <Button variant={view === "json" ? "primary" : "normal"} onClick={() => setView("json")}>
                  JSON view
                </Button>
              </>
            }
          >
            {view === "json" ? (
              <JsonView value={items} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left" data-testid="statement-results">
                  <thead>
                    <tr className="border-b-2 border-line-soft">
                      {columns.map((c) => (
                        <th key={c} className="px-2 py-2 whitespace-nowrap">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, i) => (
                      <tr key={i} className="border-b border-line-soft align-top">
                        {columns.map((c) => (
                          <td key={c} className="max-w-xs px-2 py-2 break-words">
                            {displayValue(it[c])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {nextToken && (
              <div className="mt-3">
                <Button disabled={busy} onClick={() => void run(true)}>
                  Load more
                </Button>
              </div>
            )}
          </Container>
        )}
      </div>
    </div>
  );
}
