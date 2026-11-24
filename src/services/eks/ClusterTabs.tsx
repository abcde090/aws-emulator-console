/**
 * Server-rendered tabs for the hand-built EKS cluster screen: Compute (node groups and the
 * Fargate note), Add-ons and Access (access entries, Pod Identity associations). Each table
 * links to the child resource's detail page and offers the console's "add" button.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { CellValue } from "../../console/ui/CellValue.tsx";
import { buttonClass, Container, EmptyState, ErrorBanner } from "../../console/ui/primitives.tsx";
import type { ColumnDef, Result, Row } from "../../console/types.ts";

interface ChildTableProps {
  title: string;
  description?: ReactNode;
  result: Result<Row[]>;
  columns: ColumnDef[];
  resourceId: string;
  cluster: string;
  addLabel: string;
  emptyText: string;
  testId: string;
}

/** Columns shown inside a cluster: the Cluster column is redundant there. */
export function withoutCluster(columns: ColumnDef[]): ColumnDef[] {
  return columns.filter((c) => c.key !== "cluster" && !c.hidden);
}

export function ChildTable({ title, description, result, columns, resourceId, cluster, addLabel, emptyText, testId }: ChildTableProps) {
  const rows = result.ok ? result.data : [];
  const addHref = `/eks/${resourceId}/create?cluster=${encodeURIComponent(cluster)}`;
  return (
    <Container
      title={title}
      counter={result.ok ? `(${rows.length})` : undefined}
      description={description}
      actions={
        <Link href={addHref} className={buttonClass("normal")}>
          {addLabel}
        </Link>
      }
    >
      {!result.ok && <ErrorBanner message={result.error} />}
      {result.ok && rows.length === 0 && <EmptyState title={emptyText} />}
      {rows.length > 0 && (
        <div className="overflow-x-auto" data-testid={testId}>
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b-2 border-line-soft">
                {columns.map((c) => (
                  <th key={c.key} className="px-2 py-1.5 font-bold">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={String(r.id)} className="border-b border-line-soft align-top">
                  {columns.map((c) => (
                    <td key={c.key} className="max-w-xl px-2 py-1.5">
                      <CellValue kind={c.kind} value={r[c.key]} href={c.kind === "link" ? `/eks/${resourceId}/${encodeURIComponent(String(r.id))}` : undefined} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Container>
  );
}
