import type { OrchestratorFixtureInput } from "../../shared.ts";

export const OMP_ASK_QUESTION_PROMPT =
  "Use the ask tool once to ask me one question, `Pick a color`, with options `Red` and `Blue`. After I answer, reply exactly: you picked <my answer>";

/**
 * omp 18.20 shows the ask tool's form as a `select` dialog, and the adapter keys a select's
 * answer by the dialog id; the recorder numbers dialogs `ui-<n>`.
 */
export const OMP_ASK_QUESTION_DIALOG_ID = "ui-1";

export function ompAskQuestionInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OMP_ASK_QUESTION_PROMPT },
      { type: "answer_next_user_input_request", answers: { [OMP_ASK_QUESTION_DIALOG_ID]: "Blue" } },
    ],
  };
}
