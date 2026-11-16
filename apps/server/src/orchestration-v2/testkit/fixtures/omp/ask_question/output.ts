import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../../OrchestratorScenario.ts";
import { assertAssistantTextIncludes } from "../../shared.ts";
import { assertOmpReplayRun, ompOutboundFrames } from "../simple/output.ts";
import { OMP_ASK_QUESTION_DIALOG_ID, OMP_ASK_QUESTION_PROMPT } from "./input.ts";

export function assertOmpAskQuestionOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = assertOmpReplayRun(result, transcript, {
    runStatuses: ["completed"],
    itemTypes: [
      "user_message",
      "user_input_request",
      "dynamic_tool",
      "assistant_message",
      "checkpoint",
    ],
    userMessages: [OMP_ASK_QUESTION_PROMPT],
    runtimeRequestKinds: ["user_input"],
  });
  const question = projection.turnItems.find((item) => item.type === "user_input_request");
  // omp appends its free-text row to the form's options; how T3 shows it is the adapter's choice.
  assert.includeMembers(
    question?.type === "user_input_request"
      ? question.questions.flatMap((entry) => entry.options.map((option) => option.value))
      : [],
    ["Red", "Blue"],
  );
  // The answer reaches omp as the dialog's value.
  assert.deepEqual(ompOutboundFrames(transcript, "extension_ui_response"), [
    { type: "extension_ui_response", id: OMP_ASK_QUESTION_DIALOG_ID, value: "Blue" },
  ]);
  const ask = projection.turnItems.find((item) => item.type === "dynamic_tool");
  assert.equal(ask?.status, "completed");
  assertAssistantTextIncludes(projection, "Blue");
}
