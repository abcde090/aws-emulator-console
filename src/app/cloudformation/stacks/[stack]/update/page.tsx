/** Hand-built "Update stack" wizard (Make a direct update): UpdateStack on an existing stack. */

import { notFound } from "next/navigation";
import { getService } from "@/console/registry";
import { decodeSegment, ServiceFrame } from "@/console/ui/pages";
import { ErrorBanner } from "@/console/ui/primitives";
import { stackForUpdate } from "@/services/cloudformation/stack-actions";
import { StackWizard } from "@/services/cloudformation/StackWizard";

interface PageProps {
  params: Promise<{ stack: string }>;
}

export default async function UpdateStackPage({ params }: PageProps) {
  const service = getService("cloudformation");
  if (!service) notFound();
  const stack = decodeSegment((await params).stack);
  const current = await stackForUpdate(stack);
  return (
    <ServiceFrame
      service={service}
      activeResource="stacks"
      crumbs={[
        { label: service.name, href: "/cloudformation" },
        { label: "Stacks", href: "/cloudformation/stacks" },
        { label: stack, href: `/cloudformation/stacks/${encodeURIComponent(stack)}` },
        { label: "Update stack" },
      ]}
    >
      {current.ok ? <StackWizard mode="update" stackName={current.data.name} currentParameters={current.data.parameters} /> : <ErrorBanner message={current.error} />}
    </ServiceFrame>
  );
}
