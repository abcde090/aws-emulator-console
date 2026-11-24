/** Hand-built dashboard page: the widgets drawn as graphs, then the generic Source tab. */

import { GetDashboardCommand } from "@aws-sdk/client-cloudwatch";
import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { makeCtx } from "@/console/server";
import { errorMessage } from "@/console/serialize";
import { decodeSegment, firstParam, GenericCreatePage, GenericDetailPage } from "@/console/ui/pages";
import { DashboardView } from "@/services/cloudwatch/DashboardView";
import { parseDashboard, type DashboardWidget } from "@/services/cloudwatch/helpers";

interface PageProps {
  params: Promise<{ name: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

async function loadWidgets(name: string): Promise<{ widgets: DashboardWidget[]; error: string | null }> {
  try {
    const ctx = await makeCtx();
    const r = await ctx.clients.cloudwatch.send(new GetDashboardCommand({ DashboardName: name }));
    return { widgets: parseDashboard(r.DashboardBody ?? "{}"), error: null };
  } catch (err: unknown) {
    return { widgets: [], error: errorMessage(err) };
  }
}

export default async function DashboardPage({ params, searchParams }: PageProps) {
  const service = getService("cloudwatch");
  const resource = getResource("cloudwatch", "dashboards");
  if (!service || !resource) notFound();
  const name = decodeSegment((await params).name);
  if (name === "create") return <GenericCreatePage service={service} resource={resource} />;
  const created = firstParam((await searchParams).created);
  const { widgets, error } = await loadWidgets(name);
  return (
    <GenericDetailPage
      service={service}
      resource={resource}
      id={name}
      flash={created ? `Created dashboard ${created}.` : null}
      extraTabs={[{ id: "widgets", label: "Widgets", content: <DashboardView widgets={widgets} parseError={error} /> }]}
    />
  );
}
