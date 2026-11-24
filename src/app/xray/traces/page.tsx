/** Hand-built X-Ray traces page: filter expression and time range over GetTraceSummaries. */

import { notFound } from "next/navigation";
import { getService } from "@/console/registry";
import { engineList } from "@/console/server";
import { ServiceFrame } from "@/console/ui/pages";
import { TraceQuery } from "@/services/xray/TraceQuery";

export default async function TracesPage() {
  const service = getService("xray");
  if (!service) notFound();
  const r = await engineList("xray", "traces");
  return (
    <ServiceFrame service={service} activeResource="traces" crumbs={[{ label: service.name, href: "/xray" }, { label: "Traces" }]}>
      <TraceQuery initialRows={r.ok ? r.data : []} initialError={r.ok ? null : r.error} />
    </ServiceFrame>
  );
}
