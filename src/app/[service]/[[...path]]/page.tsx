/**
 * Generic console routes, drawn from the service registry:
 *   /<service>                       -> first resource
 *   /<service>/<resource>            -> list
 *   /<service>/<resource>/create     -> create form
 *   /<service>/<resource>/<id>       -> detail (the id may span segments: "a/b" or "a%2Fb")
 */

import { notFound, redirect } from "next/navigation";
import { getService } from "@/console/registry";
import { idFromSegments } from "@/console/meta";
import { decodeSegment, firstParam, GenericCreatePage, GenericDetailPage, GenericListPage } from "@/console/ui/pages";

interface PageProps {
  params: Promise<{ service: string; path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ServicePage({ params, searchParams }: PageProps) {
  const { service: serviceId, path = [] } = await params;
  const query = await searchParams;
  const service = getService(serviceId);
  if (!service) notFound();
  const resourceId = path[0] === undefined ? undefined : decodeSegment(path[0]);
  const idSegments = path.slice(1);
  if (!resourceId) {
    const first = service.resources[0];
    if (!first) notFound();
    redirect(`/${service.id}/${first.id}`);
  }
  const resource = service.resources.find((r) => r.id === resourceId);
  if (!resource) notFound();

  if (idSegments.length === 0) {
    const deleted = firstParam(query.deleted);
    return <GenericListPage service={service} resource={resource} flash={deleted} />;
  }
  const rawId = idFromSegments(idSegments);
  if (rawId === "") notFound();
  if (idSegments.length === 1 && rawId === "create") {
    if (!resource.create) notFound();
    return <GenericCreatePage service={service} resource={resource} />;
  }
  const created = firstParam(query.created);
  return <GenericDetailPage service={service} resource={resource} id={rawId} flash={created ? `Created ${resource.singular} ${created}.` : null} />;
}
