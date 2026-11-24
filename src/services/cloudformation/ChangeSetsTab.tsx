/** The stack's "Change sets" tab: a table whose names open the change set page. */

import Link from "next/link";
import { CellValue } from "@/console/ui/CellValue";
import { buttonClass, Container, EmptyState } from "@/console/ui/primitives";
import type { ColumnDef, DetailTab, Row } from "@/console/types";
import { changeSetHref } from "./helpers";

export function ChangeSetsTab({ stack, tab }: { stack: string; tab: DetailTab }) {
  const rows = Array.isArray(tab.data) ? (tab.data as Row[]) : [];
  const columns: ColumnDef[] = tab.columns ?? [];
  return (
    <Container
      title="Change sets"
      counter={`(${rows.length})`}
      actions={
        <Link href={`/cloudformation/stacks/${encodeURIComponent(stack)}/changesets/create`} className={buttonClass("primary")}>
          Create change set
        </Link>
      }
    >
      {rows.length === 0 ? (
        <EmptyState title={tab.emptyText ?? "No change sets."} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left" data-testid="changesets-table">
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
                <tr key={String(r.name)} className="border-b border-line-soft align-top">
                  {columns.map((c) => (
                    <td key={c.key} className="px-2 py-1.5">
                      <CellValue kind={c.kind} value={r[c.key]} href={c.kind === "link" ? changeSetHref(stack, String(r.name)) : undefined} />
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
