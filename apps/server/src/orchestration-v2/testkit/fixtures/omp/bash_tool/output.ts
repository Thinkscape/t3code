import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../../OrchestratorScenario.ts";
import { assertAssistantTextIncludes } from "../../shared.ts";
import { assertOmpReplayRun } from "../simple/output.ts";
import { OMP_BASH_TOOL_PROMPT } from "./input.ts";

export function assertOmpBashToolOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = assertOmpReplayRun(result, transcript, {
    runStatuses: ["completed"],
    itemTypes: ["user_message", "command_execution", "assistant_message", "checkpoint"],
    userMessages: [OMP_BASH_TOOL_PROMPT],
  });
  const command = projection.turnItems.find((item) => item.type === "command_execution");
  assert.equal(command?.status, "completed");
  assert.include(
    command?.type === "command_execution" ? command.input : "",
    "echo omp bash fixture ok",
  );
  assert.include(
    command?.type === "command_execution" ? command.output : "",
    "omp bash fixture ok",
  );
  assertAssistantTextIncludes(projection, "bash fixture complete");
}
