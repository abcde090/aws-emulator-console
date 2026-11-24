/**
 * Hand-built Route 53 hosted zone screen: the Records table and record editor first, then
 * the definition's tabs. /route53/hosted-zones/create is still the generic form.
 */

import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { decodeSegment, firstParam, GenericCreatePage, GenericDetailPage } from "@/console/ui/pages";
import { editorOptions, listRecords } from "@/services/route53/record-actions";
import { RecordsPanel } from "@/services/route53/RecordsPanel";

interface PageProps {
  params: Promise<{ zone: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function HostedZonePage({ params, searchParams }: PageProps) {
  const service = getService("route53");
  const resource = getResource("route53", "hosted-zones");
  if (!service || !resource) notFound();
  const zoneId = decodeSegment((await params).zone);
  if (zoneId === "create") return <GenericCreatePage service={service} resource={resource} />;

  const query = await searchParams;
  const [records, options] = await Promise.all([listRecords(zoneId), editorOptions()]);
  const created = firstParam(query.created);
  return (
    <GenericDetailPage
      service={service}
      resource={resource}
      id={zoneId}
      flash={created ? `Created hosted zone ${created}.` : null}
      extraTabs={[
        {
          id: "records",
          label: "Records",
          content: <RecordsPanel zoneId={zoneId} initial={records.ok ? records.data : null} initialError={records.ok ? null : records.error} options={options.ok ? options.data : null} />,
        },
      ]}
    />
  );
}
