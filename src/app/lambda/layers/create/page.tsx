/** Hand-built Create layer page: the .zip upload the generic form can't do. */

import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { ServiceFrame } from "@/console/ui/pages";
import { PageHeader } from "@/console/ui/primitives";
import { LayerCreate } from "@/services/lambda/LayerCreate";

export default function CreateLayerPage() {
  const service = getService("lambda");
  const resource = getResource("lambda", "layers");
  if (!service || !resource) notFound();
  return (
    <ServiceFrame service={service} activeResource={resource.id} crumbs={[{ label: service.name, href: "/lambda" }, { label: resource.name, href: "/lambda/layers" }, { label: "Create layer" }]}>
      <PageHeader title="Create layer" />
      <LayerCreate />
    </ServiceFrame>
  );
}
