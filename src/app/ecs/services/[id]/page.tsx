/**
 * Hand-built ECS service screen: the service's Tasks tab (with links) first, then the
 * service definition's tabs. The id is "<cluster>/<service>".
 */

import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { decodeSegment, firstParam, GenericCreatePage, GenericDetailPage } from "@/console/ui/pages";
import { TASK_TAB_COLUMNS, taskHref } from "@/services/ecs/columns";
import { LinkTable } from "@/services/ecs/LinkTable";
import { serviceTasks } from "@/services/ecs/screen-data";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function EcsServicePage({ params, searchParams }: PageProps) {
  const service = getService("ecs");
  const resource = getResource("ecs", "services");
  if (!service || !resource) notFound();
  const id = decodeSegment((await params).id);
  if (id === "create") return <GenericCreatePage service={service} resource={resource} />;

  const tasks = await serviceTasks(id);
  const created = firstParam((await searchParams).created);
  return (
    <GenericDetailPage
      service={service}
      resource={resource}
      id={id}
      flash={created ? `Created service ${created}.` : null}
      extraTabs={[
        {
          id: "tasks",
          label: "Tasks",
          content: (
            <LinkTable
              title="Tasks"
              testId="service-tasks"
              description="Running and recently stopped tasks of this service."
              columns={TASK_TAB_COLUMNS}
              rows={tasks.ok ? tasks.data : null}
              error={tasks.ok ? null : tasks.error}
              hrefOf={(r) => taskHref(r.id)}
              emptyText="This service has no tasks."
            />
          ),
        },
      ]}
    />
  );
}
