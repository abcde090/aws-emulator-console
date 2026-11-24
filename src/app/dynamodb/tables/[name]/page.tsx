/**
 * Hand-built DynamoDB table page: the generic detail (overview, indexes, monitoring,
 * backups … and every action) plus the Contributor Insights graphs right after Monitoring.
 * /dynamodb/tables/create stays the generic create form.
 */

import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { decodeSegment, firstParam, GenericCreatePage, GenericDetailPage } from "@/console/ui/pages";
import { ContributorInsightsPanel } from "@/services/dynamodb/ContributorInsightsPanel";

interface PageProps {
  params: Promise<{ name: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TablePage({ params, searchParams }: PageProps) {
  const service = getService("dynamodb");
  const resource = getResource("dynamodb", "tables");
  if (!service || !resource) notFound();
  const name = decodeSegment((await params).name);
  if (name === "create") return <GenericCreatePage service={service} resource={resource} />;
  const created = firstParam((await searchParams).created);
  return (
    <GenericDetailPage
      service={service}
      resource={resource}
      id={name}
      flash={created ? `Created ${resource.singular} ${created}.` : null}
      extraTabs={[{ id: "contributor-insights", label: "Contributor Insights", after: "monitoring", content: <ContributorInsightsPanel table={name} /> }]}
    />
  );
}
