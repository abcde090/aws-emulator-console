/**
 * Create form for a cluster's child resource (node group, add-on, access entry, Pod Identity
 * association) with the Cluster field preset from ?cluster=, as when you start from the
 * cluster screen in the AWS console. Same form, fields and server action as the generic page.
 */

import { notFound } from "next/navigation";
import { toResourceMeta } from "../../console/meta.ts";
import { getResource, getService } from "../../console/registry.ts";
import { engineFields } from "../../console/server.ts";
import { CreateForm } from "../../console/ui/CreateForm.tsx";
import { firstParam, ServiceFrame } from "../../console/ui/pages.tsx";
import { ErrorBanner } from "../../console/ui/primitives.tsx";
import { presetCluster } from "./preset.ts";

export async function PrefilledCreatePage({ resourceId, searchParams }: { resourceId: string; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const service = getService("eks");
  const resource = getResource("eks", resourceId);
  if (!service || !resource?.create) notFound();
  const cluster = firstParam((await searchParams).cluster);
  const fields = await engineFields("eks", resourceId, "create");
  const crumbs = [
    { label: service.name, href: "/eks" },
    ...(cluster ? [{ label: cluster, href: `/eks/clusters/${encodeURIComponent(cluster)}` }] : [{ label: resource.name, href: `/eks/${resourceId}` }]),
    { label: resource.create.title },
  ];
  return (
    <ServiceFrame service={service} activeResource={resourceId} crumbs={crumbs}>
      {fields.ok ? <CreateForm serviceId="eks" resource={toResourceMeta(resource)} fields={presetCluster(fields.data, cluster)} /> : <ErrorBanner message={fields.error} />}
    </ServiceFrame>
  );
}
