import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../../OrchestratorScenario.ts";
import { assertAssistantTextIncludes } from "../../shared.ts";
import { assertOmpReplayRun } from "../simple/output.ts";
import { OMP_SUBAGENT_BATCH_PROMPT, OMP_SUBAGENT_FAILURE_PROMPT } from "./input.ts";

export function assertOmpSubagentBatchOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = assertOmpReplayRun(result, transcript, {
    runStatuses: ["completed"],
    // The task tool returns once both detached subagents start; the agent then waits on them.
    itemTypes: [
      "user_message",
      "dynamic_tool",
      "subagent",
      "subagent",
      "dynamic_tool",
      "assistant_message",
      "checkpoint",
    ],
    userMessages: [OMP_SUBAGENT_BATCH_PROMPT],
  });
  assert.deepEqual(
    projection.subagents.map((subagent) => subagent.status),
    ["completed", "completed"],
  );
  assertAssistantTextIncludes(projection, "subagent batch complete");
}

export function assertOmpSubagentFailureOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = assertOmpReplayRun(result, transcript, {
    runStatuses: ["completed"],
    itemTypes: [
      "user_message",
      "dynamic_tool",
      "assistant_message",
      "dynamic_tool",
      "subagent",
      "assistant_message",
      "checkpoint",
    ],
    userMessages: [OMP_SUBAGENT_FAILURE_PROMPT],
  });
  assert.deepEqual(
    projection.subagents.map((subagent) => subagent.status),
    ["failed"],
  );
  assertAssistantTextIncludes(projection, "subagent failure reported");
}
