/** IAM policy simulator (hand-built): SimulatePrincipalPolicy / SimulateCustomPolicy. */

import { notFound } from "next/navigation";
import { getService } from "@/console/registry";
import { firstParam, ServiceFrame } from "@/console/ui/pages";
import { ErrorBanner, PageHeader } from "@/console/ui/primitives";
import { principals } from "@/services/iam/page-data";
import { Simulator, type PrincipalChoice } from "@/services/iam/ui/Simulator";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PolicySimulatorPage({ searchParams }: PageProps) {
  const service = getService("iam");
  if (!service) notFound();
  const query = await searchParams;
  const r = await principals();
  const list: PrincipalChoice[] = r.ok ? r.data.map((p) => ({ name: String(p.name), type: String(p.type), arn: String(p.arn) })) : [];
  return (
    <ServiceFrame service={service} activeResource="policy-simulator" crumbs={[{ label: "IAM", href: "/iam" }, { label: "Policy simulator" }]}>
      <PageHeader title="IAM policy simulator" description="Test and troubleshoot identity-based policies: choose a principal or paste a policy, list actions, and see whether each is allowed or denied." />
      {!r.ok && <ErrorBanner message={r.error} />}
      <Simulator principals={list} initialPrincipal={firstParam(query.principal)} />
    </ServiceFrame>
  );
}
