/** Hand-built lens review screen: answer a lens's questions pillar by pillar. */

import { notFound } from "next/navigation";
import { getService } from "@/console/registry";
import { decodeSegment, firstParam, ServiceFrame } from "@/console/ui/pages";
import { ErrorBanner } from "@/console/ui/primitives";
import { LensReviewScreen } from "@/services/wellarchitected/LensReviewScreen";
import { loadLensReview } from "@/services/wellarchitected/review-data";

interface PageProps {
  params: Promise<{ workload: string; lens: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function LensReviewPage({ params, searchParams }: PageProps) {
  const service = getService("wellarchitected");
  if (!service) notFound();
  const p = await params;
  const workloadId = decodeSegment(p.workload);
  const lens = decodeSegment(p.lens);
  const query = await searchParams;
  const r = await loadLensReview(workloadId, lens, firstParam(query.pillar), firstParam(query.question));
  const workloadHref = `/wellarchitected/workloads/${encodeURIComponent(workloadId)}`;
  return (
    <ServiceFrame
      service={service}
      activeResource="workloads"
      crumbs={[
        { label: service.name, href: "/wellarchitected" },
        { label: "Workloads", href: "/wellarchitected/workloads" },
        { label: r.ok ? r.data.workloadName : workloadId, href: workloadHref },
        { label: r.ok ? r.data.review.LensName ?? lens : lens },
      ]}
    >
      {r.ok ? <LensReviewScreen workloadId={workloadId} lens={lens} view={r.data} /> : <ErrorBanner message={r.error} />}
    </ServiceFrame>
  );
}
