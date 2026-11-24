/**
 * Hand-built lens review: pillars on the left, the pillar's questions with their risk, and
 * the selected question's answer form. Server component; the form saves with UpdateAnswer.
 */

import Link from "next/link";
import { buttonClass, Container, EmptyState, PageHeader, StatusBadge } from "@/console/ui/primitives";
import { KeyValue } from "@/console/ui/KeyValue";
import { AnswerForm } from "./AnswerForm";
import { RISK_LABELS, RISK_ORDER, riskCount, safeExternalUrl } from "./helpers";
import type { LensReviewView } from "./review-data";

const riskText = (risk: string | undefined): string => (risk ? RISK_LABELS[risk] ?? risk : "-");

export function LensReviewScreen({ workloadId, lens, view }: { workloadId: string; lens: string; view: LensReviewView }) {
  const base = `/wellarchitected/workloads/${encodeURIComponent(workloadId)}/lenses/${encodeURIComponent(lens)}`;
  const pillars = view.review.PillarReviewSummaries ?? [];
  const pillar = pillars.find((p) => p.PillarId === view.pillarId);
  const a = view.answer;
  return (
    <div className="space-y-5" data-testid="lens-review">
      <PageHeader
        title={view.review.LensName ?? lens}
        description={`Lens review for workload ${view.workloadName}. Version ${view.review.LensVersion ?? "-"}.`}
        actions={
          <a className={buttonClass("normal")} href={`/wellarchitected/workloads/${encodeURIComponent(workloadId)}/report?lens=${encodeURIComponent(lens)}`}>
            Generate report
          </a>
        }
      />
      <Container title="Overview">
        <KeyValue data={Object.fromEntries(RISK_ORDER.map((k) => [RISK_LABELS[k], riskCount(view.review.RiskCounts, k)]))} columns={3} />
      </Container>
      <div className="flex flex-col gap-5 lg:flex-row">
        <nav aria-label="Pillars" className="lg:w-64 lg:shrink-0">
          <Container title="Pillars">
            <ul className="space-y-2">
              {pillars.map((p) => (
                <li key={p.PillarId}>
                  <Link href={`${base}?pillar=${encodeURIComponent(p.PillarId ?? "")}`} className={p.PillarId === view.pillarId ? "font-bold" : ""}>
                    {p.PillarName ?? p.PillarId}
                  </Link>
                  <span className="block text-[13px] text-muted">
                    {riskCount(p.RiskCounts, "HIGH")} high, {riskCount(p.RiskCounts, "MEDIUM")} medium, {riskCount(p.RiskCounts, "UNANSWERED")} unanswered
                  </span>
                </li>
              ))}
            </ul>
          </Container>
        </nav>
        <div className="min-w-0 flex-1 space-y-5">
          <Container title={pillar?.PillarName ?? "Questions"} counter={`(${view.answers.length})`} description="Choose a question to answer it.">
            {view.answers.length === 0 ? (
              <EmptyState title="This pillar has no questions." />
            ) : (
              <ol className="space-y-2" data-testid="questions">
                {view.answers.map((q, i) => (
                  <li key={q.QuestionId} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line-soft pb-2">
                    <Link
                      href={`${base}?pillar=${encodeURIComponent(view.pillarId)}&question=${encodeURIComponent(q.QuestionId ?? "")}`}
                      className={q.QuestionId === a?.QuestionId ? "font-bold" : ""}
                    >
                      {i + 1}. {q.QuestionTitle ?? q.QuestionId}
                    </Link>
                    <StatusBadge value={riskText(q.Risk)} />
                  </li>
                ))}
              </ol>
            )}
          </Container>
          {a && a.QuestionId && (
            <Container title={a.QuestionTitle ?? a.QuestionId} description={a.QuestionDescription}>
              <p className="mb-3 text-[13px]">
                Risk: <StatusBadge value={riskText(a.Risk)} />
                {safeExternalUrl(a.HelpfulResourceUrl) && (
                  <>
                    {" · "}
                    <a href={safeExternalUrl(a.HelpfulResourceUrl) ?? undefined} target="_blank" rel="noreferrer noopener">
                      Helpful resources
                    </a>
                  </>
                )}
                {safeExternalUrl(a.ImprovementPlanUrl) && (
                  <>
                    {" · "}
                    <a href={safeExternalUrl(a.ImprovementPlanUrl) ?? undefined} target="_blank" rel="noreferrer noopener">
                      Improvement plan
                    </a>
                  </>
                )}
              </p>
              <AnswerForm
                key={`${a.QuestionId}-${a.Risk ?? ""}`}
                workloadId={workloadId}
                lens={lens}
                questionId={a.QuestionId}
                choices={(a.Choices ?? []).filter((c) => c.ChoiceId).map((c) => ({ id: c.ChoiceId as string, title: c.Title ?? (c.ChoiceId as string), description: c.Description ?? null }))}
                initialSelected={a.SelectedChoices ?? []}
                initialNotes={a.Notes ?? ""}
                initialApplicable={a.IsApplicable !== false}
                initialReason={a.Reason ?? null}
              />
            </Container>
          )}
          <Container title="Improvement plan" counter={`(${view.improvements.length})`} description="Questions in this pillar with high or medium risk.">
            {view.improvements.length === 0 ? (
              <EmptyState title="No improvement items in this pillar." />
            ) : (
              <ul className="space-y-2" data-testid="improvements">
                {view.improvements.map((i) => (
                  <li key={i.QuestionId} className="flex flex-wrap items-baseline gap-3">
                    <StatusBadge value={riskText(i.Risk)} />
                    <Link href={`${base}?pillar=${encodeURIComponent(view.pillarId)}&question=${encodeURIComponent(i.QuestionId ?? "")}`}>{i.QuestionTitle ?? i.QuestionId}</Link>
                    {safeExternalUrl(i.ImprovementPlanUrl) && (
                      <a href={safeExternalUrl(i.ImprovementPlanUrl) ?? undefined} target="_blank" rel="noreferrer noopener" className="text-[13px]">
                        Improvement plan
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Container>
        </div>
      </div>
    </div>
  );
}
