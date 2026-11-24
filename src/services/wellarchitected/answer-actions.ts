"use server";

/**
 * Server action for the lens review screen: saves one answer with UpdateAnswer through the
 * permission-checked client. Choices are checked against the question's real choices first.
 */

import { GetAnswerCommand, UpdateAnswerCommand, type AnswerReason } from "@aws-sdk/client-wellarchitected";
import { clients } from "../../lib/aws.ts";
import { errorMessage } from "../../console/serialize.ts";
import type { Result } from "../../console/types.ts";
import { checkSelection, LENS_ALIAS, MAX_NOTES, NOT_APPLICABLE_REASONS, QUESTION_ID, WORKLOAD_ID } from "./helpers.ts";

export interface AnswerInput {
  selected: string[];
  notes: string;
  applicable: boolean;
  reason: string;
}

export interface SavedAnswer {
  risk: string | null;
}

export async function saveAnswer(workloadId: string, lens: string, questionId: string, input: AnswerInput): Promise<Result<SavedAnswer>> {
  try {
    if (typeof workloadId !== "string" || !WORKLOAD_ID.test(workloadId)) throw new Error("That is not a valid workload ID.");
    if (typeof lens !== "string" || !LENS_ALIAS.test(lens)) throw new Error("That is not a valid lens alias.");
    if (typeof questionId !== "string" || !QUESTION_ID.test(questionId)) throw new Error("That is not a valid question ID.");
    if (!input || typeof input !== "object") throw new Error("The answer is missing.");
    if (typeof input.notes !== "string" || input.notes.length > MAX_NOTES) throw new Error(`Notes must be text of at most ${MAX_NOTES} characters.`);
    if (typeof input.applicable !== "boolean") throw new Error("Question applicability is missing.");
    const reason = input.applicable ? undefined : input.reason;
    if (reason !== undefined && !NOT_APPLICABLE_REASONS.some((r) => r.value === reason)) throw new Error("Choose a reason why the question does not apply.");

    const wa = clients.wellarchitected;
    const current = await wa.send(new GetAnswerCommand({ WorkloadId: workloadId, LensAlias: lens, QuestionId: questionId }));
    const selection = checkSelection(current.Answer?.Choices ?? [], input.applicable ? input.selected : []);
    if (!selection.ok) throw new Error(selection.error);

    const r = await wa.send(
      new UpdateAnswerCommand({
        WorkloadId: workloadId,
        LensAlias: lens,
        QuestionId: questionId,
        SelectedChoices: selection.value,
        Notes: input.notes,
        IsApplicable: input.applicable,
        Reason: reason as AnswerReason | undefined,
      })
    );
    return { ok: true, data: { risk: r.Answer?.Risk ?? null } };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}
