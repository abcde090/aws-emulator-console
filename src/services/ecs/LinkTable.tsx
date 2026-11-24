/**
 * Server-rendered table for the hand-built ECS tabs (a cluster's services and tasks, a
 * service's tasks, a family's revisions). The first column links to the row's detail page.
 */

import Link from "next/link";
import type { ColumnDef, Row } from "../../console/types.ts";
import { CellValue } from "../../console/ui/CellValue.tsx";
import { buttonClass, Container, EmptyState, ErrorBanner } from "../../console/ui/primitives.tsx";

export interface LinkTableProps {
  title: string;
  description?: string;
  columns: ColumnDef[];
  rows: Row[] | null;
  error: string | null;
  hrefOf: (row: Row) => string;
  emptyText: string;
  createHref?: string;
  createLabel?: string;
  testId?: string;
}

export function LinkTable({ title, description, columns, rows, error, hrefOf, emptyText, createHref, createLabel, testId }: LinkTableProps) {
  const actions = createHref ? (
    <Link href={createHref} className={buttonClass("primary")}>
      {createLabel}
    </Link>
  ) : undefined;
  return (
    <Container title={title} counter={rows ? `(${rows.length})` : undefined} description={description} actions={actions}>
      {error && <ErrorBanner message={error} />}
      {rows && rows.length === 0 && <EmptyState title={emptyText} />}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left" data-testid={testId}>
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
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-line-soft align-top">
                  {columns.map((c, j) => (
                    <td key={c.key} className="max-w-xl px-2 py-1.5">
                      <CellValue kind={j === 0 ? "link" : c.kind} value={r[c.key]} href={j === 0 ? hrefOf(r) : undefined} />
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
