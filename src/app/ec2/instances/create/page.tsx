/** Hand-built Launch an instance wizard; its lists are read from the emulator on the server. */

import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { makeCtx } from "@/console/server";
import { ServiceFrame } from "@/console/ui/pages";
import { ErrorBanner } from "@/console/ui/primitives";
import { errorMessage } from "@/console/serialize";
import { loadWizardData, type WizardData } from "@/services/ec2/launch-data";
import { LaunchWizard } from "@/services/ec2/LaunchWizard";

export default async function LaunchInstancePage() {
  const service = getService("ec2");
  const resource = getResource("ec2", "instances");
  if (!service || !resource) notFound();
  let data: WizardData | null = null;
  let error: string | null = null;
  try {
    data = await loadWizardData(await makeCtx());
  } catch (err: unknown) {
    error = errorMessage(err);
  }
  return (
    <ServiceFrame service={service} activeResource={resource.id} crumbs={[{ label: service.name, href: "/ec2" }, { label: resource.name, href: "/ec2/instances" }, { label: "Launch an instance" }]}>
      {data ? <LaunchWizard data={data} /> : <ErrorBanner message={error ?? "The wizard could not load."} />}
    </ServiceFrame>
  );
}
