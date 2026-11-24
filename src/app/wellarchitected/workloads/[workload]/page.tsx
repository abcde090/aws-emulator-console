/**
 * Hand-built workload screen: the generic detail page plus a "Lens reviews" tab that links
 * to each lens review and its PDF report. /wellarchitected/workloads/create stays generic.
 */

import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { decodeSegment, firstParam, GenericCreatePage, GenericDetailPage } from "@/console/ui/pages";
import { LensReviewsTab } from "@/services/wellarchitected/LensReviewsTab";
import { loadWorkloadLenses } from "@/services/wellarchitected/review-data";

interface PageProps {
  params: Promise<{ workload: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function WorkloadPage({ params, searchParams }: PageProps) {
  const service = getService("wellarchitected");
  const resource = getResource("wellarchitected", "workloads");
  if (!service || !resource) notFound();
  const workloadId = decodeSegment((await params).workload);
  if (workloadId === "create") return <GenericCreatePage service={service} resource={resource} />;

  const created = firstParam((await searchParams).created);
  const lenses = await loadWorkloadLenses(workloadId);
  return (
    <GenericDetailPage
      service={service}
      resource={resource}
      id={workloadId}
      flash={created ? `Created workload ${created}.` : null}
      extraTabs={[
        {
          id: "lens-reviews",
          label: "Lens reviews",
          content: <LensReviewsTab workloadId={workloadId} data={lenses.ok ? lenses.data : null} error={lenses.ok ? null : lenses.error} />,
        },
      ]}
    />
  );
}
