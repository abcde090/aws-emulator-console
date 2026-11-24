/**
 * Server-rendered Executions list for one state machine, with links to each execution's
 * detail page (status, input/output and event history).
 */

import Link from "next/link";
import { CellValue } from "@/console/ui/CellValue";
import { Container, EmptyState, ErrorBanner } from "@/console/ui/primitives";
import type { Row } from "@/console/types";

interface ExecutionsPanelProps {
  rows: Row[] | null;
  error: string | null;
  express: boolean;
}

export function ExecutionsPanel({ rows, error, express }: ExecutionsPanelProps) {
  if (express) {
    return (
      <Container title="Executions">
        <EmptyState title="Express workflows don't keep execution history.">
          Use Actions &gt; Start execution to run one synchronously and see its result, or turn on logging to send history to CloudWatch Logs.
        </EmptyState>
      </Container>
    );
  }
  return (
    <Container title="Executions" counter={rows ? `(${rows.length})` : undefined} description="Use Actions > Start execution to run the workflow, then refresh.">
      {error && <ErrorBanner message={error} />}
      {rows && rows.length === 0 && <EmptyState title="No executions." />}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left" data-testid="sfn-executions">
            <thead>
              <tr className="border-b-2 border-line-soft">
                {["Name", "Status", "Start time", "End time", "Duration"].map((h) => (
                  <th key={h} className="px-2 py-1.5 font-bold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={String(r.arn)} className="border-b border-line-soft">
                  <td className="px-2 py-1.5">
                    <Link href={`/stepfunctions/executions/${encodeURIComponent(String(r.arn))}`}>{String(r.name ?? r.arn)}</Link>
                  </td>
                  <td className="px-2 py-1.5"><CellValue kind="status" value={r.status} /></td>
                  <td className="px-2 py-1.5"><CellValue kind="date" value={r.started} /></td>
                  <td className="px-2 py-1.5"><CellValue kind="date" value={r.ended} /></td>
                  <td className="px-2 py-1.5"><CellValue kind="text" value={r.duration} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Container>
  );
}
