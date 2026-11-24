/** Hand-built Logs Insights: the query editor above the generic query history list. */

import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { toResourceMeta } from "@/console/meta";
import { engineList } from "@/console/server";
import { firstParam, ServiceFrame } from "@/console/ui/pages";
import { ResourceTable } from "@/console/ui/ResourceTable";
import { makeCtx } from "@/console/server";
import { logGroupOptions } from "@/services/cloudwatch/logs";
import { LogsInsights } from "@/services/cloudwatch/LogsInsights";
import { ErrorBanner } from "@/console/ui/primitives";
import { errorMessage } from "@/console/serialize";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function LogsInsightsPage({ searchParams }: PageProps) {
  const service = getService("cloudwatch");
  const resource = getResource("cloudwatch", "logs-insights");
  if (!service || !resource) notFound();
  const query = await searchParams;
  let groups: string[] = [];
  let groupsError: string | null = null;
  try {
    groups = (await logGroupOptions(await makeCtx())).map((o) => o.value);
  } catch (err: unknown) {
    groupsError = errorMessage(err);
  }
  const history = await engineList("cloudwatch", "logs-insights");
  return (
    <ServiceFrame service={service} activeResource="logs-insights" crumbs={[{ label: service.name, href: "/cloudwatch" }, { label: "Logs Insights" }]}>
      <div className="space-y-6">
        {groupsError && <ErrorBanner title="Log groups could not be listed" message={groupsError} />}
        <LogsInsights groups={groups} initialGroup={firstParam(query.group)} />
        <ResourceTable serviceId="cloudwatch" resource={{ ...toResourceMeta(resource), name: "Query history" }} initialRows={history.ok ? history.data : []} initialError={history.ok ? null : history.error} />
      </div>
    </ServiceFrame>
  );
}
