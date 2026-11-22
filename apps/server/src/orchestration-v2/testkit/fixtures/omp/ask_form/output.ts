import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../../OrchestratorScenario.ts";
import { assertAssistantTextIncludes, field } from "../../shared.ts";
import { assertOmpReplayRun, ompInboundFrames, ompOutboundFrames } from "../simple/output.ts";
import { OMP_ASK_FORM_PROMPT } from "./input.ts";

export function assertOmpAskFormOutput(
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
    userMessages: [OMP_ASK_FORM_PROMPT],
    runtimeRequestKinds: ["user_input"],
  });
  const form = ompInboundFrames(transcript, "extension_ui_request").find(
    (frame) => field(frame, "method") === "form",
  );
  assert.isDefined(form, "omp sends the ask tool's form as one form dialog");
  const card = projection.turnItems.find((item) => item.type === "user_input_request");
  assert.deepEqual(
    card?.type === "user_input_request"
      ? card.questions.map((question) => ({
          id: question.id,
          multiSelect: question.multiSelect ?? false,
          allowCustomAnswer: question.allowCustomAnswer,
          values: question.options.map((option) => option.value),
          recommended: question.options
            .filter((option) => option.description === "Recommended")
            .map((option) => option.value),
        }))
      : [],
    [
      {
        id: "store",
        multiSelect: false,
        allowCustomAnswer: true,
        values: ["sqlite", "redis"],
        recommended: ["sqlite"],
      },
      {
        id: "platforms",
        multiSelect: true,
        allowCustomAnswer: true,
        values: ["web", "ios", "t3:omp-form:none"],
        recommended: [],
      },
      { id: "project", multiSelect: false, allowCustomAnswer: true, values: [], recommended: [] },
    ],
  );
  // One answer for the whole form, as omp's form data; Android is the platforms' Other answer.
  assert.deepEqual(ompOutboundFrames(transcript, "extension_ui_response"), [
    {
      type: "extension_ui_response",
      id: field(form, "id"),
      data: { store: "redis", platforms: ["web", "Android"], project: "demo" },
    },
  ]);
  const ask = projection.turnItems.find((item) => item.type === "dynamic_tool");
  assert.equal(ask?.status, "completed");
  assertAssistantTextIncludes(projection, "Android");
}
