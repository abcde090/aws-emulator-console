/**
 * Parameter details. Parameter names contain "/", so this catch-all route accepts both
 * /ssm/parameters/%2Fapp%2Fdb and /ssm/parameters/app/db (leading "/" kept when encoded).
 */

import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { decodeSegment, firstParam, GenericCreatePage, GenericDetailPage } from "@/console/ui/pages";

interface PageProps {
  params: Promise<{ name: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ParameterPage({ params, searchParams }: PageProps) {
  const service = getService("ssm");
  const resource = getResource("ssm", "parameters");
  if (!service || !resource) notFound();
  const name = (await params).name.map(decodeSegment).join("/");
  if (name === "create") return <GenericCreatePage service={service} resource={resource} />;
  const created = firstParam((await searchParams).created);
  return <GenericDetailPage service={service} resource={resource} id={name} flash={created ? `Created parameter ${created}.` : null} />;
}
