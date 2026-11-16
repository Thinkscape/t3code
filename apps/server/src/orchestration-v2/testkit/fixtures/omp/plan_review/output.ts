import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../../OrchestratorScenario.ts";
import { OMP_MODEL_SELECTION } from "../shared.ts";
import { assertOmpReplayRun, ompOutboundFrames } from "../simple/output.ts";
import {
  OMP_PLAN_APPROVE_CHOICE,
  OMP_PLAN_REVIEW_DIALOG_ID,
  OMP_PLAN_REVIEW_PROMPT,
} from "./input.ts";

export function assertOmpPlanReviewOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const [start] = ompOutboundFrames(transcript, "process_start");
  const args = (start as { readonly args?: ReadonlyArray<string> } | undefined)?.args ?? [];
  assert.include(args.join(" "), "--plan-yolo --plan-yolo-into anthropic/claude-haiku-5-5");
  const projection = assertOmpReplayRun(result, transcript, {
    runStatuses: ["completed"],
    // The review dialog opens while omp's plan write is still running; the approved plan then runs.
    itemTypes: [
      "user_message",
      "proposed_plan",
      "user_input_request",
      "file_change",
      "dynamic_tool",
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
  assert.deepEqual(
    ompOutboundFrames(transcript, "extension_ui_response").map((frame) => JSON.stringify(frame)),
    [
      JSON.stringify({
        type: "extension_ui_response",
        id: OMP_PLAN_REVIEW_DIALOG_ID,
        value: OMP_PLAN_APPROVE_CHOICE,
      }),
    ],
  );
}
