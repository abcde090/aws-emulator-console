/** Hand-built "Create stack" wizard: its parameter form is generated from the template. */

import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { ServiceFrame } from "@/console/ui/pages";
import { StackWizard } from "@/services/cloudformation/StackWizard";

export default function CreateStackPage() {
  const service = getService("cloudformation");
  const resource = getResource("cloudformation", "stacks");
  if (!service || !resource) notFound();
  return (
    <ServiceFrame
      service={service}
      activeResource="stacks"
      crumbs={[
        { label: service.name, href: "/cloudformation" },
        { label: resource.name, href: "/cloudformation/stacks" },
        { label: "Create stack" },
      ]}
    >
      <StackWizard mode="create" />
    </ServiceFrame>
  );
}
