import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../../OrchestratorScenario.ts";
import { field } from "../../shared.ts";
import { OMP_MODEL_SELECTION } from "../shared.ts";
import { assertOmpReplayRun, ompInboundFrames, ompOutboundFrames } from "../simple/output.ts";
import { OMP_PLAN_APPROVE_CHOICE, OMP_PLAN_REVIEW_PROMPT } from "./input.ts";

export function assertOmpPlanReviewOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const [start] = ompOutboundFrames(transcript, "process_start");
  const args = (start as { readonly args?: ReadonlyArray<string> } | undefined)?.args ?? [];
  assert.include(args.join(" "), "--plan-yolo --plan-yolo-into anthropic/claude-haiku-5-5");
  const projection = assertOmpReplayRun(result, transcript, {
    runStatuses: ["completed"],
    // omp 19: the agent drafts the plan file and explores, then runs `propose`, which the T3
    // extension holds for the card; only after approval does the agent change the workspace.
    itemTypes: [
      "user_message",
      "file_change",
      "command_execution",
      "dynamic_tool",
      "command_execution",
      "proposed_plan",
      "user_input_request",
      "command_execution",
      "file_change",
      "command_execution",
      "assistant_message",
      "checkpoint",
    ],
    userMessages: [OMP_PLAN_REVIEW_PROMPT],
    runtimeRequestKinds: ["user_input"],
  });
  const plan = projection.turnItems.find((item) => item.type === "proposed_plan");
  assert.include(plan?.type === "proposed_plan" ? plan.markdown : "", "hello.txt");
  // Approving ended omp's plan mode, so the thread's Mode is back to its default.
  assert.deepEqual(projection.thread.modelSelection, OMP_MODEL_SELECTION);
  const review = ompInboundFrames(transcript, "extension_ui_request").find(
    (frame) => field(frame, "method") === "select",
  );
  assert.deepEqual(
    ompOutboundFrames(transcript, "extension_ui_response").map((frame) => JSON.stringify(frame)),
    [
      JSON.stringify({
        type: "extension_ui_response",
        id: field(review, "id"),
        value: OMP_PLAN_APPROVE_CHOICE,
      }),
    ],
  );
}
