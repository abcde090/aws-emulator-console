/**
 * Hand-built CodeBuild project screen: Build history (each run links to its phases and
 * logs) first, then the definition's tabs. /codebuild/build-projects/create stays generic.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { ListBuildsForProjectCommand } from "@aws-sdk/client-codebuild";
import { clients } from "@/lib/aws";
import { errorMessage } from "@/console/serialize";
import { formatDate } from "@/console/format";
import { getResource, getService } from "@/console/registry";
import { decodeSegment, firstParam, GenericCreatePage, GenericDetailPage } from "@/console/ui/pages";
import { Container, EmptyState, ErrorBanner, StatusBadge } from "@/console/ui/primitives";
import { buildRow, getBuilds } from "@/services/codebuild/builds";
import type { Row } from "@/console/types";

interface PageProps {
  params: Promise<{ name: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

async function projectBuilds(name: string): Promise<{ ok: true; rows: Row[] } | { ok: false; error: string }> {
  try {
    const r = await clients.codebuild.send(new ListBuildsForProjectCommand({ projectName: name, sortOrder: "DESCENDING" }));
    const bs = await getBuilds(clients.codebuild, (r.ids ?? []).slice(0, 100));
    return { ok: true, rows: bs.map(buildRow) };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

async function BuildHistory({ name }: { name: string }) {
  const r = await projectBuilds(name);
  return (
    <Container title="Build history" counter={r.ok ? `(${r.rows.length})` : undefined} description="Builds of this project, newest first. Use Actions › Start build to run one.">
      {!r.ok && <ErrorBanner message={r.error} />}
      {r.ok && r.rows.length === 0 && <EmptyState title="No builds yet" />}
      {r.ok && r.rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left" data-testid="build-history">
            <thead>
              <tr className="border-b-2 border-line-soft">
                <th className="px-2 py-2">Build run</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Build number</th>
                <th className="px-2 py-2">Source version</th>
                <th className="px-2 py-2">Submitter</th>
                <th className="px-2 py-2">Duration</th>
                <th className="px-2 py-2">Completed</th>
              </tr>
            </thead>
            <tbody>
              {r.rows.map((b) => (
                <tr key={String(b.id)} className="border-b border-line-soft">
                  <td className="px-2 py-2 break-all">
                    <Link href={`/codebuild/build-history/${encodeURIComponent(String(b.id))}`}>{String(b.id)}</Link>
                  </td>
                  <td className="px-2 py-2">
                    <StatusBadge value={b.status} />
                  </td>
                  <td className="px-2 py-2">{b.buildNumber === null ? "-" : String(b.buildNumber)}</td>
                  <td className="px-2 py-2 font-mono text-[13px]">{b.sourceVersion ? String(b.sourceVersion) : "-"}</td>
                  <td className="px-2 py-2">{b.initiator ? String(b.initiator) : "-"}</td>
                  <td className="px-2 py-2">{b.duration ? String(b.duration) : "-"}</td>
                  <td className="px-2 py-2">{formatDate(b.completed instanceof Date ? b.completed.toISOString() : b.completed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Container>
  );
}

export default async function BuildProjectPage({ params, searchParams }: PageProps) {
  const service = getService("codebuild");
  const resource = getResource("codebuild", "build-projects");
  if (!service || !resource) notFound();
  const name = decodeSegment((await params).name);
  if (name === "create") return <GenericCreatePage service={service} resource={resource} />;
  const created = firstParam((await searchParams).created);
  return (
    <GenericDetailPage
      service={service}
      resource={resource}
      id={name}
      flash={created ? `Created build project ${created}.` : null}
      extraTabs={[{ id: "history", label: "Build history", content: <BuildHistory name={name} /> }]}
    />
  );
}
