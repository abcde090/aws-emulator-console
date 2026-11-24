/**
 * Hand-built Cost Explorer screen: a report builder (date range, granularity, metric,
 * group by, filter) that calls GetCostAndUsage and shows the result or the emulator's error.
 * When the emulator answers NotImplemented, the page says so and offers no report builder
 * (DESIGN.md rule 2: no dead controls). Any other error (e.g. a simulated AccessDenied)
 * still shows the builder, which reports it.
 */

import { notFound } from "next/navigation";
import { getService } from "@/console/registry";
import { ServiceFrame } from "@/console/ui/pages";
import { Container, PageHeader } from "@/console/ui/primitives";
import { runCostQuery } from "@/services/cost/ce-actions";
import { CostExplorer } from "@/services/cost/CostExplorer";

export const dynamic = "force-dynamic";

export default async function CostExplorerPage() {
  const service = getService("cost");
  if (!service) notFound();
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1)).toISOString().slice(0, 10);
  const end = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  const probe = await runCostQuery({ start, end, granularity: "MONTHLY", metric: "UnblendedCost", groupBy: "SERVICE", tagKey: "", filterDimension: "", filterValues: "" });
  const notImplemented = !probe.ok && /NotImplemented|not implemented/i.test(probe.error);
  return (
    <ServiceFrame service={service} activeResource="cost-explorer" crumbs={[{ label: service.name, href: "/cost" }, { label: "Cost Explorer" }]}>
      <PageHeader title="Cost and usage report" description="Build a report of your AWS costs and usage. The date range end is exclusive." />
      {notImplemented ? (
        <Container title="Not available in AWS Emulator">
          <p className="text-[13px]" data-testid="cost-not-supported">
            AWS Emulator doesn&apos;t support Cost Explorer reports yet: GetCostAndUsage answers NotImplemented. Budgets, cost categories and cost anomaly detection work.
          </p>
        </Container>
      ) : (
        <CostExplorer defaultStart={start} defaultEnd={end} />
      )}
    </ServiceFrame>
  );
}
