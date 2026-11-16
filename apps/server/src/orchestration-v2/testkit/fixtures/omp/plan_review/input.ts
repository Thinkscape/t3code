import type { OrchestratorFixtureInput } from "../../shared.ts";

export const OMP_PLAN_REVIEW_PROMPT =
  'Create hello.txt containing exactly "hi". Keep the plan to two steps and do not ask questions.';

/** The recorder numbers omp's dialogs `ui-<n>`; the plan review is the thread's first dialog. */
export const OMP_PLAN_REVIEW_DIALOG_ID = "ui-1";
export const OMP_PLAN_APPROVE_CHOICE = "Approve and execute";

export function ompPlanReviewInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OMP_PLAN_REVIEW_PROMPT },
      {
        type: "answer_next_user_input_request",
        answers: { [OMP_PLAN_REVIEW_DIALOG_ID]: OMP_PLAN_APPROVE_CHOICE },
      },
    ],
  };
}
