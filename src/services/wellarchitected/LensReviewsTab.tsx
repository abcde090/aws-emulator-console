/** "Lens reviews" tab on the workload page: each applied lens, its risks, and report links. */

import Link from "next/link";
import { formatDate } from "@/console/format";
import { buttonClass, Container, EmptyState, ErrorBanner, StatusBadge } from "@/console/ui/primitives";
import { riskCount, totalQuestions } from "./helpers";
import type { WorkloadLenses } from "./review-data";

const lensKey = (alias: string | undefined, arn: string | undefined): string => alias ?? arn ?? "";

function reportHref(workloadId: string, lens: string, milestone?: number): string {
  return `/wellarchitected/workloads/${encodeURIComponent(workloadId)}/report?lens=${encodeURIComponent(lens)}${milestone ? `&milestone=${milestone}` : ""}`;
}

export function LensReviewsTab({ workloadId, data, error }: { workloadId: string; data: WorkloadLenses | null; error: string | null }) {
  if (error || !data) return <ErrorBanner message={error ?? "The lens reviews could not be read."} />;
  const lenses = data.reviews.map((r) => lensKey(r.LensAlias, r.LensArn)).filter(Boolean);
  return (
    <div className="space-y-4">
      <Container title="Lens reviews" counter={`(${data.reviews.length})`} description="Start or continue a review by choosing a lens. Generate a report to download the review as a PDF.">
        {data.reviews.length === 0 ? (
          <EmptyState title="No lenses are applied to this workload." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left" data-testid="lens-reviews">
              <thead>
                <tr className="border-b-2 border-line-soft">
                  <th className="px-2 py-1.5">Lens</th>
                  <th className="px-2 py-1.5">Status</th>
                  <th className="px-2 py-1.5">Questions answered</th>
                  <th className="px-2 py-1.5">High risks</th>
                  <th className="px-2 py-1.5">Medium risks</th>
                  <th className="px-2 py-1.5">Last updated</th>
                  <th className="px-2 py-1.5">Report</th>
                </tr>
              </thead>
              <tbody>
                {data.reviews.map((r) => {
                  const key = lensKey(r.LensAlias, r.LensArn);
                  const total = totalQuestions(r.RiskCounts);
                  return (
                    <tr key={key} className="border-b border-line-soft">
                      <td className="px-2 py-1.5">
                        <Link href={`/wellarchitected/workloads/${encodeURIComponent(workloadId)}/lenses/${encodeURIComponent(key)}`}>{r.LensName ?? key}</Link>
                      </td>
                      <td className="px-2 py-1.5">
                        <StatusBadge value={r.LensStatus} />
                      </td>
                      <td className="px-2 py-1.5">{total ? `${total - riskCount(r.RiskCounts, "UNANSWERED")}/${total}` : "-"}</td>
                      <td className="px-2 py-1.5">{riskCount(r.RiskCounts, "HIGH")}</td>
                      <td className="px-2 py-1.5">{riskCount(r.RiskCounts, "MEDIUM")}</td>
                      <td className="px-2 py-1.5">{r.UpdatedAt ? formatDate(new Date(r.UpdatedAt).toISOString()) : "-"}</td>
                      <td className="px-2 py-1.5">
                        <a className={buttonClass("link")} href={reportHref(workloadId, key)}>
                          Generate report
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Container>
      <Container title="Milestone reports" counter={`(${data.milestones.length})`} description="A report for a milestone shows the review as it was when the milestone was saved.">
        {data.milestones.length === 0 ? (
          <EmptyState title="No milestones. Save a milestone from Actions." />
        ) : (
          <ul className="space-y-2">
            {data.milestones.map((m) => (
              <li key={m.MilestoneNumber}>
                <span className="font-bold">
                  {m.MilestoneNumber}. {m.MilestoneName}
                </span>{" "}
                <span className="text-muted">{m.RecordedAt ? formatDate(new Date(m.RecordedAt).toISOString()) : ""}</span>
                <span className="ml-3 inline-flex flex-wrap gap-3">
                  {(m.WorkloadSummary?.Lenses ?? lenses).map((l) => (
                    <a key={l} href={reportHref(workloadId, l, m.MilestoneNumber)}>
                      {l} report
                    </a>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Container>
    </div>
  );
}
