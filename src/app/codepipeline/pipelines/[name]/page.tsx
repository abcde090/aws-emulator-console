/**
 * Hand-built CodePipeline screen: the pipeline diagram and its execution history (with
 * per-execution action details), then the definition's tabs. /codepipeline/pipelines/create
 * stays generic.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDate } from "@/console/format";
import { getResource, getService } from "@/console/registry";
import { decodeSegment, firstParam, GenericCreatePage, GenericDetailPage } from "@/console/ui/pages";
import { Container, EmptyState, ErrorBanner } from "@/console/ui/primitives";
import { statusText } from "@/services/codepipeline/helpers";
import { PipelineView } from "@/services/codepipeline/PipelineView";
import { readActionExecutions, readExecutions, readPipelineView } from "@/services/codepipeline/read";

interface PageProps {
  params: Promise<{ name: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const th = "px-2 py-2";
const td = "px-2 py-2 align-top";

async function ExecutionHistory({ name }: { name: string }) {
  const r = await readExecutions(name);
  return (
    <Container title="Execution history" counter={r.ok ? `(${r.data.length})` : undefined} description="The most recent 50 executions, newest first.">
      {!r.ok && <ErrorBanner message={r.error} />}
      {r.ok && r.data.length === 0 && <EmptyState title="No executions" />}
      {r.ok && r.data.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left" data-testid="execution-history">
            <thead>
              <tr className="border-b-2 border-line-soft">
                <th className={th}>Execution ID</th>
                <th className={th}>Status</th>
                <th className={th}>Source revisions</th>
                <th className={th}>Trigger</th>
                <th className={th}>Started</th>
                <th className={th}>Last updated</th>
              </tr>
            </thead>
            <tbody>
              {r.data.map((e) => (
                <tr key={e.id} className="border-b border-line-soft">
                  <td className={`${td} font-mono text-[13px]`}>
                    <Link href={`?execution=${encodeURIComponent(e.id)}`}>{e.id}</Link>
                  </td>
                  <td className={td}>
                    {statusText(e.status)}
                    {e.statusSummary && <div className="text-[13px] text-muted">{e.statusSummary}</div>}
                  </td>
                  <td className={`${td} font-mono text-[13px]`}>{e.sourceRevisions ?? "-"}</td>
                  <td className={td}>{e.trigger ?? "-"}</td>
                  <td className={td}>{formatDate(e.started)}</td>
                  <td className={td}>{formatDate(e.updated)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Container>
  );
}

async function ExecutionDetail({ name, executionId }: { name: string; executionId: string }) {
  const r = await readActionExecutions(name, executionId);
  return (
    <Container title={`Execution ${executionId}`} description="Action executions in this run (ListActionExecutions)." actions={<Link href={`/codepipeline/pipelines/${encodeURIComponent(name)}`}>Back to pipeline</Link>}>
      {!r.ok && <ErrorBanner message={r.error} />}
      {r.ok && r.data.length === 0 && <EmptyState title="No actions ran in this execution yet." />}
      {r.ok && r.data.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left" data-testid="action-executions">
            <thead>
              <tr className="border-b-2 border-line-soft">
                <th className={th}>Stage</th>
                <th className={th}>Action</th>
                <th className={th}>Provider</th>
                <th className={th}>Status</th>
                <th className={th}>Summary</th>
                <th className={th}>Started</th>
                <th className={th}>Last updated</th>
              </tr>
            </thead>
            <tbody>
              {r.data.map((a) => (
                <tr key={`${a.stage}/${a.action}/${a.started ?? ""}`} className="border-b border-line-soft">
                  <td className={td}>{a.stage}</td>
                  <td className={td}>{a.action}</td>
                  <td className={td}>{a.provider ?? "-"}</td>
                  <td className={td}>{statusText(a.status)}</td>
                  <td className={td}>
                    {a.summary ?? "-"}
                    {a.error && <div className="text-bad">{a.error}</div>}
                    {a.provider === "CodeBuild" && a.externalId && (
                      <div>
                        <Link href={`/codebuild/build-history/${encodeURIComponent(a.externalId)}`}>View build</Link>
                      </div>
                    )}
                  </td>
                  <td className={td}>{formatDate(a.started)}</td>
                  <td className={td}>{formatDate(a.updated)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Container>
  );
}

export default async function PipelinePage({ params, searchParams }: PageProps) {
  const service = getService("codepipeline");
  const resource = getResource("codepipeline", "pipelines");
  if (!service || !resource) notFound();
  const name = decodeSegment((await params).name);
  if (name === "create") return <GenericCreatePage service={service} resource={resource} />;
  const query = await searchParams;
  const created = firstParam(query.created);
  const execution = firstParam(query.execution);
  const view = await readPipelineView(name);

  const diagram = { id: "pipeline", label: "Pipeline", content: view.ok ? <PipelineView view={view.data} /> : <ErrorBanner message={view.error} /> };
  const history = {
    id: "executions",
    label: "Execution history",
    content: execution ? <ExecutionDetail name={name} executionId={execution} /> : <ExecutionHistory name={name} />,
  };
  return (
    <GenericDetailPage
      key={execution ?? ""}
      service={service}
      resource={resource}
      id={name}
      flash={created ? `Created pipeline ${created}. Its first execution has started.` : null}
      extraTabs={execution ? [history, diagram] : [diagram, history]}
    />
  );
}
