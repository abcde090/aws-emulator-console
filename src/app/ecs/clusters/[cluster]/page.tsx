/**
 * Hand-built ECS cluster screen: Services and Tasks tabs (with links and Create service /
 * Run new task buttons) first, then the cluster definition's tabs. /ecs/clusters/create
 * is still the generic form.
 */

import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { decodeSegment, firstParam, GenericCreatePage, GenericDetailPage } from "@/console/ui/pages";
import { SERVICE_TAB_COLUMNS, serviceHref, TASK_TAB_COLUMNS, taskHref } from "@/services/ecs/columns";
import { LinkTable } from "@/services/ecs/LinkTable";
import { clusterServices, clusterTasks } from "@/services/ecs/screen-data";

interface PageProps {
  params: Promise<{ cluster: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ClusterPage({ params, searchParams }: PageProps) {
  const service = getService("ecs");
  const resource = getResource("ecs", "clusters");
  if (!service || !resource) notFound();
  const cluster = decodeSegment((await params).cluster);
  if (cluster === "create") return <GenericCreatePage service={service} resource={resource} />;

  const [svcs, tasks] = await Promise.all([clusterServices(cluster), clusterTasks(cluster)]);
  const created = firstParam((await searchParams).created);
  return (
    <GenericDetailPage
      service={service}
      resource={resource}
      id={cluster}
      flash={created ? `Created cluster ${created}.` : null}
      extraTabs={[
        {
          id: "services",
          label: "Services",
          content: (
            <LinkTable
              title="Services"
              testId="cluster-services"
              description="Services in this cluster (ListServices / DescribeServices)."
              columns={SERVICE_TAB_COLUMNS}
              rows={svcs.ok ? svcs.data : null}
              error={svcs.ok ? null : svcs.error}
              hrefOf={(r) => serviceHref(r.id)}
              emptyText="No services in this cluster."
              createHref="/ecs/services/create"
              createLabel="Create service"
            />
          ),
        },
        {
          id: "tasks",
          label: "Tasks",
          content: (
            <LinkTable
              title="Tasks"
              testId="cluster-tasks"
              description="Running and recently stopped tasks in this cluster (ListTasks / DescribeTasks)."
              columns={TASK_TAB_COLUMNS}
              rows={tasks.ok ? tasks.data : null}
              error={tasks.ok ? null : tasks.error}
              hrefOf={(r) => taskHref(r.id)}
              emptyText="No tasks in this cluster."
              createHref="/ecs/tasks/create"
              createLabel="Run new task"
            />
          ),
        },
      ]}
    />
  );
}
