/**
 * Hand-built ECS task definition screen. "/ecs/task-definitions/<family>" shows the latest
 * ACTIVE revision, "/ecs/task-definitions/<family>:<n>" one revision; both get the family's
 * Revisions tab with links.
 */

import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { decodeSegment, firstParam, GenericCreatePage, GenericDetailPage } from "@/console/ui/pages";
import { REVISION_TAB_COLUMNS, revisionHref } from "@/services/ecs/columns";
import { LinkTable } from "@/services/ecs/LinkTable";
import { familyRevisions } from "@/services/ecs/screen-data";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TaskDefinitionPage({ params, searchParams }: PageProps) {
  const service = getService("ecs");
  const resource = getResource("ecs", "task-definitions");
  if (!service || !resource) notFound();
  const id = decodeSegment((await params).id);
  if (id === "create") return <GenericCreatePage service={service} resource={resource} />;

  const revisions = await familyRevisions(id);
  const created = firstParam((await searchParams).created);
  return (
    <GenericDetailPage
      service={service}
      resource={resource}
      id={id}
      flash={created ? `Created task definition ${created}.` : null}
      extraTabs={[
        {
          id: "revisions",
          label: "Revisions",
          content: (
            <LinkTable
              title="Revisions"
              testId="td-revisions"
              description="ACTIVE and INACTIVE revisions of this family, newest first."
              columns={REVISION_TAB_COLUMNS}
              rows={revisions.ok ? revisions.data : null}
              error={revisions.ok ? null : revisions.error}
              hrefOf={(r) => revisionHref(r.id)}
              emptyText="No revisions."
            />
          ),
        },
      ]}
    />
  );
}
