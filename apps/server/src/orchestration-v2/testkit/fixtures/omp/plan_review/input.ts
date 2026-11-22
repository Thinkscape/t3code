import type { OrchestratorFixtureInput } from "../../shared.ts";

export const OMP_PLAN_REVIEW_PROMPT =
  'Create hello.txt containing exactly "hi". Keep the plan to two steps and do not ask questions.';

/** The adapter asks the plan review decision under a fixed question id. */
const OMP_PLAN_REVIEW_QUESTION_ID = "plan-review";
export const OMP_PLAN_APPROVE_CHOICE = "Approve and execute";

export function ompPlanReviewInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OMP_PLAN_REVIEW_PROMPT },
      {
        type: "answer_next_user_input_request",
        answers: { [OMP_PLAN_REVIEW_QUESTION_ID]: OMP_PLAN_APPROVE_CHOICE },
      },
    ],
  };
}
