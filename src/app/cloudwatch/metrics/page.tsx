/** Hand-built CloudWatch metrics explorer: replaces the generic "All metrics" list. */

import { notFound } from "next/navigation";
import { getService } from "@/console/registry";
import { ServiceFrame } from "@/console/ui/pages";
import { PageHeader } from "@/console/ui/primitives";
import { listAllMetrics } from "@/services/cloudwatch/metric-actions";
import { MetricsExplorer } from "@/services/cloudwatch/MetricsExplorer";

export default async function MetricsPage() {
  const service = getService("cloudwatch");
  if (!service) notFound();
  const r = await listAllMetrics(null);
  return (
    <ServiceFrame service={service} activeResource="metrics" crumbs={[{ label: service.name, href: "/cloudwatch" }, { label: "Metrics" }, { label: "All metrics" }]}>
      <PageHeader title="Metrics" description="Browse metrics by namespace and dimension, choose a statistic and period, and graph them with math expressions." />
      <MetricsExplorer metrics={r.ok ? r.data.metrics : []} truncated={r.ok && r.data.truncated} initialError={r.ok ? null : r.error} />
    </ServiceFrame>
  );
}
