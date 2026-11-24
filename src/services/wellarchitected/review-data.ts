/**
 * Reads for the hand-built lens review screen. Server only; every call uses the
 * permission-checked Well-Architected client, so the IAM simulator sees it.
 */

import {
  GetAnswerCommand,
  GetLensReviewCommand,
  GetWorkloadCommand,
  ListAnswersCommand,
  ListLensReviewImprovementsCommand,
  ListLensReviewsCommand,
  ListMilestonesCommand,
  type Answer,
  type AnswerSummary,
  type ImprovementSummary,
  type LensReview,
  type LensReviewSummary,
  type MilestoneSummary,
  type Workload,
} from "@aws-sdk/client-wellarchitected";
import { clients } from "../../lib/aws.ts";
import { errorMessage } from "../../console/serialize.ts";
import type { Result } from "../../console/types.ts";
import { LENS_ALIAS, PILLAR_ID, QUESTION_ID, WORKLOAD_ID } from "./helpers.ts";

async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

function check(workloadId: string, lens: string): void {
  if (!WORKLOAD_ID.test(workloadId)) throw new Error("That is not a valid workload ID.");
  if (!LENS_ALIAS.test(lens)) throw new Error("That is not a valid lens alias.");
}

export interface WorkloadLenses {
  workload: Workload;
  reviews: LensReviewSummary[];
  milestones: MilestoneSummary[];
}

/** The workload with its lens reviews and milestones (for the "Lens reviews" tab). */
export function loadWorkloadLenses(workloadId: string): Promise<Result<WorkloadLenses>> {
  return attempt(async () => {
    if (!WORKLOAD_ID.test(workloadId)) throw new Error("That is not a valid workload ID.");
    const wa = clients.wellarchitected;
    const [w, reviews, milestones] = await Promise.all([
      wa.send(new GetWorkloadCommand({ WorkloadId: workloadId })),
      wa.send(new ListLensReviewsCommand({ WorkloadId: workloadId, MaxResults: 50 })),
      wa.send(new ListMilestonesCommand({ WorkloadId: workloadId, MaxResults: 50 })),
    ]);
    if (!w.Workload) throw new Error(`Workload ${workloadId} was not returned.`);
    return { workload: w.Workload, reviews: reviews.LensReviewSummaries ?? [], milestones: milestones.MilestoneSummaries ?? [] };
  });
}

export interface LensReviewView {
  workloadName: string;
  review: LensReview;
  pillarId: string;
  answers: AnswerSummary[];
  improvements: ImprovementSummary[];
  answer: Answer | null;
}

/** One pillar of a lens review, and the selected question's full answer if one is chosen. */
export function loadLensReview(workloadId: string, lens: string, pillar: string | null, question: string | null): Promise<Result<LensReviewView>> {
  return attempt(async () => {
    check(workloadId, lens);
    const wa = clients.wellarchitected;
    const [w, r] = await Promise.all([
      wa.send(new GetWorkloadCommand({ WorkloadId: workloadId })),
      wa.send(new GetLensReviewCommand({ WorkloadId: workloadId, LensAlias: lens })),
    ]);
    if (!r.LensReview) throw new Error(`The ${lens} lens review was not returned.`);
    const pillars = r.LensReview.PillarReviewSummaries ?? [];
    const pillarId = pillar && PILLAR_ID.test(pillar) && pillars.some((p) => p.PillarId === pillar) ? pillar : pillars[0]?.PillarId ?? "";
    const answers: AnswerSummary[] = [];
    let token: string | undefined;
    if (pillarId) {
      do {
        const page = await wa.send(new ListAnswersCommand({ WorkloadId: workloadId, LensAlias: lens, PillarId: pillarId, MaxResults: 50, NextToken: token }));
        answers.push(...(page.AnswerSummaries ?? []));
        token = page.NextToken;
      } while (token);
    }
    const improvements = pillarId
      ? (await wa.send(new ListLensReviewImprovementsCommand({ WorkloadId: workloadId, LensAlias: lens, PillarId: pillarId, MaxResults: 100 }))).ImprovementSummaries ?? []
      : [];
    const questionId = question && QUESTION_ID.test(question) && answers.some((a) => a.QuestionId === question) ? question : null;
    const answer = questionId ? (await wa.send(new GetAnswerCommand({ WorkloadId: workloadId, LensAlias: lens, QuestionId: questionId }))).Answer ?? null : null;
    return { workloadName: w.Workload?.WorkloadName ?? workloadId, review: r.LensReview, pillarId, answers, improvements, answer };
  });
}
