/** Hand-built X-Ray service map: the graph above the generic node list. */

import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { toResourceMeta } from "@/console/meta";
import { engineList, makeCtx } from "@/console/server";
import { errorMessage } from "@/console/serialize";
import { ServiceFrame } from "@/console/ui/pages";
import { Container, EmptyState, ErrorBanner } from "@/console/ui/primitives";
import { ResourceTable } from "@/console/ui/ResourceTable";
import { DEFAULT_RANGE_SECONDS, serviceGraph } from "@/services/xray/def";
import { ServiceMapGraph } from "@/services/xray/ServiceMapGraph";
import type { Service } from "@aws-sdk/client-xray";

export default async function ServiceMapPage() {
  const service = getService("xray");
  const resource = getResource("xray", "service-map");
  if (!service || !resource) notFound();
  let services: Service[] = [];
  let error: string | null = null;
  try {
    services = await serviceGraph(await makeCtx(), DEFAULT_RANGE_SECONDS);
  } catch (err: unknown) {
    error = errorMessage(err);
  }
  const list = await engineList("xray", "service-map");
  return (
    <ServiceFrame service={service} activeResource="service-map" crumbs={[{ label: service.name, href: "/xray" }, { label: "Service map" }]}>
      <div className="space-y-6">
        <Container title="Service map" description="Last 6 hours. Ring colour: green OK, amber errors (4xx), red faults (5xx); the number is the average latency.">
          {error ? <ErrorBanner message={error} /> : services.length === 0 ? <EmptyState title="No services in the last 6 hours." /> : <ServiceMapGraph services={services} />}
        </Container>
        <ResourceTable serviceId="xray" resource={{ ...toResourceMeta(resource), name: "Nodes" }} initialRows={list.ok ? list.data : []} initialError={list.ok ? null : list.error} />
      </div>
    </ServiceFrame>
  );
}
