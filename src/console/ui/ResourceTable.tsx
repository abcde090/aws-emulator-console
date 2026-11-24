"use client";

import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";
import { listResources } from "../actions.ts";
import { callServer } from "../call.ts";
import { compareValues, fillHref, rowMatches } from "../format.ts";
import { detailPath, UNAVAILABLE_ACTIONS_KEY } from "../meta.ts";
import { DELETE_TARGET } from "../targets.ts";
import type { ResourceMeta, Row } from "../types.ts";
import { ActionDialog } from "./ActionDialog.tsx";
import { ActionsMenu } from "./ActionsMenu.tsx";
import { CellValue } from "./CellValue.tsx";
import { DeleteDialog } from "./DeleteDialog.tsx";
import { Button, buttonClass, EmptyState, ErrorBanner, Flash } from "./primitives.tsx";
import { useHydrated } from "./useHydrated.ts";

const PAGE_SIZE = 25;

interface ResourceTableProps {
  serviceId: string;
  resource: ResourceMeta;
  initialRows: Row[];
  initialError: string | null;
  flash?: string | null;
}

type Dialog = { kind: "action"; actionId: string } | { kind: "page"; actionId: string } | { kind: "delete" } | null;

function unavailableIn(row: Row | undefined): string[] {
  const v = row?.[UNAVAILABLE_ACTIONS_KEY];
  return Array.isArray(v) ? v.map(String) : [];
}

export function ResourceTable({ serviceId, resource, initialRows, initialError, flash = null }: ResourceTableProps) {
  const [rows, setRows] = useState<Row[]>(initialRows);
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(flash);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [loading, setLoading] = useState(false);
  const hydrated = useHydrated();

  const columns = resource.columns.filter((c) => !c.hidden);
  const allKeys = resource.columns.map((c) => c.key);
  const idOf = useCallback((r: Row) => String(r[resource.idField] ?? ""), [resource.idField]);
  const linkable = resource.canGet || Boolean(resource.detailHref);

  // CQ-6: refreshes can overlap (double click, onDone after a dialog); only the latest applies.
  const latestRequest = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++latestRequest.current;
    setLoading(true);
    const r = await callServer(() => listResources(serviceId, resource.id));
    if (request !== latestRequest.current) return;
    setLoading(false);
    if (r.ok) {
      setRows(r.data);
      setError(null);
      setSelected((s) => (s && r.data.some((row) => idOf(row) === s) ? s : null));
    } else {
      setError(r.error);
    }
  }, [serviceId, resource.id, idOf]);

  const visible = useMemo(() => {
    const filtered = rows.filter((r) => rowMatches(r, allKeys, filter));
    if (!sort) return filtered;
    const sorted = [...filtered].sort((a, b) => compareValues(a[sort.key], b[sort.key]));
    return sort.desc ? sorted.reverse() : sorted;
  }, [rows, filter, sort, allKeys]);

  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const pageRows = visible.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);
  const selectedRow = selected === null ? undefined : rows.find((r) => idOf(r) === selected);
  const hiddenForRow = unavailableIn(selectedRow);
  const menuItems = resource.actions.filter((a) => !a.hidden && !hiddenForRow.includes(a.id)).map((a) => ({ id: a.id, label: a.label, danger: a.danger }));
  const activeAction = dialog?.kind === "action" ? resource.actions.find((a) => a.id === dialog.actionId) : undefined;
  const activePageAction = dialog?.kind === "page" ? resource.pageActions.find((a) => a.id === dialog.actionId) : undefined;
  const selectedName = selectedRow && resource.nameField ? selectedRow[resource.nameField] : undefined;

  return (
    <div className="space-y-4">
      {notice && <Flash kind="success" message={notice} onDismiss={() => setNotice(null)} />}
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      <section className="awsui-card overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line-soft bg-shade px-5 py-3.5">
          <div>
            <h1 className="text-[18px] font-bold text-ink">
              {resource.name}{" "}
              <span className="font-normal text-muted" data-testid="resource-count">
                {filter.trim() ? `(${visible.length}/${rows.length})` : `(${rows.length})`}
              </span>
            </h1>
            {resource.description && <p className="mt-0.5 text-[13px] text-muted">{resource.description}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button aria-label="Refresh" title="Refresh" onClick={refresh} disabled={loading} className="px-2.5">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={loading ? "animate-spin" : ""}
                aria-hidden="true"
              >
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <polyline points="21 3 21 9 15 9" />
              </svg>
            </Button>
            <ActionsMenu
              items={menuItems}
              disabled={!selected}
              onSelect={(actionId) => setDialog({ kind: "action", actionId })}
            />
            {resource.canDelete && !hiddenForRow.includes(DELETE_TARGET) && (
              <Button disabled={!selected} onClick={() => setDialog({ kind: "delete" })}>
                Delete
              </Button>
            )}
            {resource.pageActions.map((a) => (
              <Button
                key={a.id}
                variant={a.danger ? "danger" : "normal"}
                disabled={!hydrated}
                data-testid={`page-action-${a.id}`}
                onClick={() => setDialog({ kind: "page", actionId: a.id })}
              >
                {a.label}
              </Button>
            ))}
            {resource.canCreate && (
              <Link href={`/${serviceId}/${resource.id}/create`} className={buttonClass("primary")}>
                {resource.createTitle ?? `Create ${resource.singular}`}
              </Link>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft bg-white px-5 py-2.5">
          <div className="relative w-full max-w-md">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#545b64"
              strokeWidth="2"
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="search"
              aria-label={`Find ${resource.name.toLowerCase()}`}
              placeholder={`Find ${resource.name.toLowerCase()}`}
              className="w-full rounded-[2px] border border-[#aab7b8] bg-white py-1 pl-8 pr-2.5 text-[13px] text-ink placeholder:text-[#879596] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setPage(0);
              }}
            />
          </div>
          <div className="flex items-center gap-2 text-[13px] text-muted" aria-label="Pagination">
            <button
              type="button"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
              aria-label="Previous page"
              className="rounded-[2px] px-1.5 py-0.5 hover:bg-page hover:text-ink disabled:opacity-40"
            >
              ‹
            </button>
            <span className="font-medium text-ink">
              {current + 1} / {pages}
            </span>
            <button
              type="button"
              disabled={current >= pages - 1}
              onClick={() => setPage(current + 1)}
              aria-label="Next page"
              className="rounded-[2px] px-1.5 py-0.5 hover:bg-page hover:text-ink disabled:opacity-40"
            >
              ›
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[13px]" data-testid="resource-table">
            <thead>
              <tr className="border-b border-line bg-shade text-[#545b64]">
                <th className="w-10 px-4 py-2" />
                {columns.map((c) => (
                  <th key={c.key} className="px-3 py-2 font-bold whitespace-nowrap">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 hover:text-ink hover:underline"
                      onClick={() => setSort((s) => (s?.key === c.key ? { key: c.key, desc: !s.desc } : { key: c.key, desc: false }))}
                    >
                      <span>{c.label}</span>
                      {sort?.key === c.key && <span className="text-[10px]">{sort.desc ? "▼" : "▲"}</span>}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r) => {
                const id = idOf(r);
                const isSelected = selected === id;
                return (
                  <tr
                    key={id}
                    className={`border-b border-line-soft transition-colors ${isSelected ? "bg-[#f2f8fd]" : "hover:bg-shade"}`}
                    onClick={() => setSelected(id)}
                  >
                    <td className="px-4 py-2.5">
                      <input type="radio" name="row" aria-label={`Select ${id}`} checked={isSelected} onChange={() => setSelected(id)} />
                    </td>
                    {columns.map((c) => (
                      <td key={c.key} className="max-w-md px-3 py-2.5">
                        <CellValue kind={c.kind} value={r[c.key]} href={c.href ? fillHref(c.href, r) : c.kind === "link" && linkable ? detailPath(serviceId, resource, id) : undefined} />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && !error && (
            <EmptyState title={`No ${resource.name.toLowerCase()}`}>
              <p>{resource.emptyText ?? `You don't have any ${resource.name.toLowerCase()}.`}</p>
              {resource.canCreate && (
                <Link href={`/${serviceId}/${resource.id}/create`} className={`${buttonClass("normal")} mt-3`}>
                  {resource.createTitle ?? `Create ${resource.singular}`}
                </Link>
              )}
            </EmptyState>
          )}
          {rows.length > 0 && visible.length === 0 && <EmptyState title="No matches">No {resource.name.toLowerCase()} match the filter.</EmptyState>}
        </div>
      </section>
      {dialog?.kind === "delete" && selected && (
        <DeleteDialog
          serviceId={serviceId}
          resourceId={resource.id}
          singular={resource.singular}
          id={selected}
          name={typeof selectedName === "string" || typeof selectedName === "number" ? String(selectedName) : undefined}
          confirmText={resource.deleteConfirm}
          hasFields={resource.deleteHasFields}
          onClose={() => setDialog(null)}
          onDeleted={() => {
            setDialog(null);
            setNotice(`Deleted ${resource.singular} ${selected}.`);
            setSelected(null);
            void refresh();
          }}
        />
      )}
      {activeAction && selected && (
        <ActionDialog serviceId={serviceId} resourceId={resource.id} id={selected} action={activeAction} onClose={() => setDialog(null)} onDone={() => void refresh()} />
      )}
      {activePageAction && (
        <ActionDialog serviceId={serviceId} resourceId={resource.id} id={null} action={activePageAction} onClose={() => setDialog(null)} onDone={() => void refresh()} />
      )}
    </div>
  );
}
