"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatBytes, formatDate } from "@/console/format";
import { Modal } from "@/console/ui/Modal";
import { Button, Container, EmptyState, ErrorBanner, Flash, StatusBadge } from "@/console/ui/primitives";
import type { Row } from "@/console/types";
import {
  listSavedQueries,
  listTables,
  queryResults,
  queryStatus,
  recentQueries,
  runQuery,
  saveQuery,
  stopQuery,
  type EditorContext,
  type QueryStatus,
  type ResultPage,
  type SavedQuery,
  type TableInfo,
} from "./editor-actions";
import { formatRunTime } from "./helpers";

interface QueryEditorProps {
  context: EditorContext | null;
  contextError: string | null;
}

type Tab = "results" | "recent" | "saved";
const POLL_MS = 1000;

const inputClass = "w-full rounded-[4px] border border-[#879596] bg-white px-2.5 py-1.5 text-[13px] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

export function QueryEditor({ context, contextError }: QueryEditorProps) {
  const firstWg = context?.workgroups.find((w) => w.state === "ENABLED")?.name ?? context?.workgroups[0]?.name ?? "";
  const [workgroup, setWorkgroup] = useState(firstWg);
  const [catalog, setCatalog] = useState(context?.catalogs.includes("AwsDataCatalog") ? "AwsDataCatalog" : context?.catalogs[0] ?? "");
  const [database, setDatabase] = useState(context?.databases.includes("default") ? "default" : context?.databases[0] ?? "");
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const [openTable, setOpenTable] = useState<string | null>(null);
  const [sql, setSql] = useState("");
  const [outputLocation, setOutputLocation] = useState("");
  const [status, setStatus] = useState<QueryStatus | null>(null);
  const [results, setResults] = useState<ResultPage | null>(null);
  const [error, setError] = useState<string | null>(contextError);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("results");
  const [recent, setRecent] = useState<Row[] | null>(null);
  const [saved, setSaved] = useState<SavedQuery[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveDescription, setSaveDescription] = useState("");
  const runToken = useRef(0);

  const wgInfo = context?.workgroups.find((w) => w.name === workgroup) ?? null;
  const running = status !== null && !status.done;

  useEffect(() => {
    if (!catalog || !database) return;
    let live = true;
    void listTables(catalog, database).then((r) => {
      if (!live) return;
      if (r.ok) setTables(r.data);
      else {
        setTables([]);
        setError(r.error);
      }
    });
    return () => {
      live = false;
    };
  }, [catalog, database]);

  const loadRecent = useCallback(async () => {
    if (!workgroup) return;
    const r = await recentQueries(workgroup);
    if (r.ok) setRecent(r.data);
    else setError(r.error);
  }, [workgroup]);

  const loadSaved = useCallback(async () => {
    if (!workgroup) return;
    const r = await listSavedQueries(workgroup);
    if (r.ok) setSaved(r.data);
    else setError(r.error);
  }, [workgroup]);

  async function poll(id: string, token: number) {
    for (;;) {
      if (runToken.current !== token) return;
      const s = await queryStatus(id);
      if (runToken.current !== token) return;
      if (!s.ok) return setError(s.error);
      setStatus(s.data);
      if (s.data.done) {
        if (s.data.state === "SUCCEEDED") {
          const r = await queryResults(id, null);
          if (runToken.current !== token) return;
          if (r.ok) setResults(r.data);
          else setError(r.error);
        }
        // Running DDL can create or drop tables.
        if (catalog && database) {
          const t = await listTables(catalog, database);
          if (t.ok) setTables(t.data);
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  async function run() {
    setError(null);
    setNotice(null);
    setResults(null);
    setTab("results");
    const token = ++runToken.current;
    const r = await runQuery({ sql, workgroup, catalog, database, outputLocation });
    if (!r.ok) return setError(r.error);
    setStatus({ id: r.data.id, state: "QUEUED", done: false, reason: null, runTimeMs: null, scannedBytes: null, outputLocation: null, statementType: null });
    await poll(r.data.id, token);
  }

  async function cancel() {
    if (!status) return;
    const r = await stopQuery(status.id);
    if (!r.ok) setError(r.error);
  }

  async function more() {
    if (!status || !results?.nextToken) return;
    const r = await queryResults(status.id, results.nextToken);
    if (!r.ok) return setError(r.error);
    setResults({ columns: results.columns, rows: [...results.rows, ...r.data.rows], nextToken: r.data.nextToken });
  }

  async function save() {
    const r = await saveQuery({ name: saveName, description: saveDescription, workgroup, database, sql });
    if (!r.ok) return setError(r.error);
    setSaving(false);
    setNotice(`Saved query ${saveName}.`);
    setSaveName("");
    setSaveDescription("");
    setSaved(null);
  }

  function preview(table: string) {
    setSql(`SELECT * FROM "${database}"."${table}" LIMIT 10;`);
  }

  function showTab(t: Tab) {
    setTab(t);
    if (t === "recent") void loadRecent();
    if (t === "saved") void loadSaved();
  }

  if (!context) return error ? <ErrorBanner message={error} /> : null;

  return (
    <div className="space-y-4" data-testid="query-editor">
      {notice && <Flash kind="success" message={notice} onDismiss={() => setNotice(null)} />}
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {context.warnings.map((w) => (
        <ErrorBanner key={w} message={w} />
      ))}
      <div className="flex flex-col gap-4 lg:flex-row">
        <aside className="w-full shrink-0 space-y-4 lg:w-72">
          <Container title="Data">
            <div className="space-y-3">
              <label className="block space-y-1">
                <span className="font-bold">Data source</span>
                <select aria-label="Data source" className={inputClass} value={catalog} onChange={(e) => setCatalog(e.target.value)}>
                  {context.catalogs.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1">
                <span className="font-bold">Database</span>
                <select aria-label="Database" className={inputClass} value={database} onChange={(e) => setDatabase(e.target.value)}>
                  {context.databases.length === 0 && <option value="">No databases</option>}
                  {context.databases.map((d) => (
                    <option key={d}>{d}</option>
                  ))}
                </select>
              </label>
              <div>
                <p className="font-bold">Tables {tables ? `(${tables.length})` : ""}</p>
                {tables === null ? (
                  <p className="text-muted">Loading…</p>
                ) : tables.length === 0 ? (
                  <p className="text-muted">No tables in this database.</p>
                ) : (
                  <ul className="mt-1 space-y-1" data-testid="table-list">
                    {tables.map((t) => (
                      <li key={t.name}>
                        <div className="flex items-center justify-between gap-2">
                          <button type="button" className="text-left text-link hover:underline" onClick={() => setOpenTable(openTable === t.name ? null : t.name)}>
                            {openTable === t.name ? "▾" : "▸"} {t.name}
                          </button>
                          <button type="button" className="text-[13px] text-link hover:underline" onClick={() => preview(t.name)}>
                            Preview
                          </button>
                        </div>
                        {openTable === t.name && (
                          <ul className="ml-4 font-mono text-[13px]">
                            {t.columns.map((c) => (
                              <li key={c.name}>
                                {c.name} <span className="text-muted">{c.type}</span>
                              </li>
                            ))}
                            {t.partitionKeys.map((c) => (
                              <li key={`p-${c.name}`}>
                                {c.name} <span className="text-muted">{c.type} (partitioned)</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </Container>
        </aside>

        <div className="min-w-0 flex-1 space-y-4">
          <Container
            title="Query"
            actions={
              <label className="flex items-center gap-2">
                <span className="font-bold">Workgroup</span>
                <select aria-label="Workgroup" className="rounded-[4px] border border-[#879596] bg-white px-2 py-0.5" value={workgroup} onChange={(e) => setWorkgroup(e.target.value)}>
                  {context.workgroups.map((w) => (
                    <option key={w.name} value={w.name}>
                      {w.name}
                      {w.state !== "ENABLED" ? ` (${w.state.toLowerCase()})` : ""}
                    </option>
                  ))}
                </select>
              </label>
            }
          >
            <textarea
              aria-label="SQL query"
              data-testid="sql"
              className={`${inputClass} min-h-40 font-mono text-[13px]`}
              placeholder={`SELECT * FROM "${database || "database"}"."table" LIMIT 10;`}
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !running && sql.trim()) void run();
              }}
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled={running || sql.trim() === "" || !workgroup} onClick={() => void run()}>
                Run
              </Button>
              <Button disabled={!running} onClick={() => void cancel()}>
                Cancel
              </Button>
              <Button disabled={sql.trim() === "" || !database} onClick={() => setSaving(true)}>
                Save as
              </Button>
              <Button variant="link" disabled={sql === ""} onClick={() => setSql("")}>
                Clear
              </Button>
            </div>
            <label className="mt-3 block space-y-1">
              <span className="font-bold">Query result location</span>
              <input
                aria-label="Query result location"
                className={inputClass}
                placeholder={wgInfo?.outputLocation ?? "s3://my-bucket/athena-results/"}
                value={outputLocation}
                onChange={(e) => setOutputLocation(e.target.value)}
              />
              <span className="block text-[13px] text-muted">
                {wgInfo?.outputLocation
                  ? `Leave empty to use the workgroup's location (${wgInfo.outputLocation}). A workgroup that overrides client-side settings ignores this.`
                  : "This workgroup has no result location, so enter an S3 location (or set one on the workgroup)."}
              </span>
            </label>
          </Container>

          <div role="tablist" className="flex gap-4 border-b border-line-soft">
            {(
              [
                ["results", "Query results"],
                ["recent", "Recent queries"],
                ["saved", "Saved queries"],
              ] as [Tab, string][]
            ).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className={`-mb-px border-b-2 px-1 pb-2 font-bold ${tab === id ? "border-primary text-primary" : "border-transparent text-ink"}`} onClick={() => showTab(id)}>
                {label}
              </button>
            ))}
          </div>

          {tab === "results" && (
            <Container title="Query results" counter={results ? `(${results.rows.length}${results.nextToken ? "+" : ""})` : undefined}>
              {!status ? (
                <EmptyState title="Run a query to see results here." />
              ) : (
                <div className="space-y-3">
                  <dl className="flex flex-wrap gap-x-8 gap-y-2" data-testid="query-status">
                    <div>
                      <dt className="text-muted">Status</dt>
                      <dd data-testid="query-state">
                        <StatusBadge value={status.state} />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted">Query ID</dt>
                      <dd className="font-mono text-[13px]">
                        <Link href={`/athena/query-editor/${status.id}`}>{status.id}</Link>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted">Run time</dt>
                      <dd>{formatRunTime(status.runTimeMs)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted">Data scanned</dt>
                      <dd>{formatBytes(status.scannedBytes)}</dd>
                    </div>
                  </dl>
                  {status.reason && status.state !== "SUCCEEDED" && <ErrorBanner title={`Query ${status.state.toLowerCase()}`} message={status.reason} />}
                  {status.outputLocation && <p className="text-[13px] text-muted">Result file: {status.outputLocation}</p>}
                  {results && (
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-left" data-testid="query-results">
                        <thead>
                          <tr className="border-b-2 border-line-soft">
                            <th className="px-2 py-1.5 text-muted">#</th>
                            {results.columns.map((c, i) => (
                              <th key={`${c.name}-${i}`} className="px-2 py-1.5" title={c.type ?? undefined}>
                                {c.name}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {results.rows.map((row, i) => (
                            <tr key={i} className="border-b border-line-soft">
                              <td className="px-2 py-1 text-muted">{i + 1}</td>
                              {results.columns.map((_, j) => (
                                <td key={j} className="px-2 py-1 font-mono text-[13px]">
                                  {row[j] ?? <span className="text-muted">NULL</span>}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {results.rows.length === 0 && <EmptyState title="No rows returned." />}
                      {results.nextToken && (
                        <div className="mt-3">
                          <Button onClick={() => void more()}>Load more</Button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </Container>
          )}

          {tab === "recent" && (
            <Container title="Recent queries" description={`Up to 50 recent executions in workgroup ${workgroup}.`} actions={<Button aria-label="Refresh recent queries" onClick={() => void loadRecent()}>⟳</Button>}>
              {recent === null ? (
                <p className="text-muted">Loading…</p>
              ) : recent.length === 0 ? (
                <EmptyState title="No queries have run in this workgroup." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left" data-testid="recent-queries">
                    <thead>
                      <tr className="border-b-2 border-line-soft">
                        <th className="px-2 py-1.5">Execution ID</th>
                        <th className="px-2 py-1.5">Query</th>
                        <th className="px-2 py-1.5">Time submitted</th>
                        <th className="px-2 py-1.5">Status</th>
                        <th className="px-2 py-1.5">Run time</th>
                        <th className="px-2 py-1.5">Data scanned</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recent.map((q) => (
                        <tr key={String(q.id)} className="border-b border-line-soft align-top">
                          <td className="px-2 py-1 font-mono text-[13px]">
                            <Link href={`/athena/query-editor/${String(q.id)}`}>{String(q.id)}</Link>
                          </td>
                          <td className="max-w-md px-2 py-1">
                            <button type="button" className="text-left font-mono text-[13px] text-link hover:underline" title="Open in the editor" onClick={() => setSql(String(q.query ?? ""))}>
                              {String(q.query ?? "")}
                            </button>
                          </td>
                          <td className="px-2 py-1">{formatDate(q.submitted)}</td>
                          <td className="px-2 py-1">
                            <StatusBadge value={q.state} />
                          </td>
                          <td className="px-2 py-1">{String(q.runTime ?? "-")}</td>
                          <td className="px-2 py-1">{formatBytes(q.scanned)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Container>
          )}

          {tab === "saved" && (
            <Container title="Saved queries" description={`Named queries in workgroup ${workgroup}. Choose one to open it in the editor.`}>
              {saved === null ? (
                <p className="text-muted">Loading…</p>
              ) : saved.length === 0 ? (
                <EmptyState title="No saved queries in this workgroup." />
              ) : (
                <ul className="space-y-2" data-testid="saved-queries">
                  {saved.map((q) => (
                    <li key={q.id}>
                      <button
                        type="button"
                        className="text-left text-link hover:underline"
                        onClick={() => {
                          setSql(q.query);
                          if (q.database && context.databases.includes(q.database)) setDatabase(q.database);
                          setTab("results");
                        }}
                      >
                        {q.name}
                      </button>
                      {q.description && <span className="text-muted"> — {q.description}</span>}
                      <span className="ml-2 text-[13px] text-muted">{q.database}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Container>
          )}
        </div>
      </div>

      {saving && (
        <Modal
          title="Save query"
          onClose={() => setSaving(false)}
          footer={
            <>
              <Button variant="link" onClick={() => setSaving(false)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={saveName.trim() === ""} onClick={() => void save()}>
                Save query
              </Button>
            </>
          }
        >
          <p className="text-muted">
            Saves the query as a named query in workgroup {workgroup}, database {database}.
          </p>
          <label className="block space-y-1">
            <span className="font-bold">Name</span>
            <input aria-label="Saved query name" className={inputClass} value={saveName} onChange={(e) => setSaveName(e.target.value)} />
          </label>
          <label className="block space-y-1">
            <span className="font-bold">Description - optional</span>
            <input aria-label="Saved query description" className={inputClass} value={saveDescription} onChange={(e) => setSaveDescription(e.target.value)} />
          </label>
        </Modal>
      )}
    </div>
  );
}
