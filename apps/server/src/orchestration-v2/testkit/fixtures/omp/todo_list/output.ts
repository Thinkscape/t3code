import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../../OrchestratorScenario.ts";
import { assertAssistantTextIncludes } from "../../shared.ts";
import { assertOmpReplayRun } from "../simple/output.ts";
import { OMP_TODO_LIST_PROMPT } from "./input.ts";

export function assertOmpTodoListOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = assertOmpReplayRun(result, transcript, {
    runStatuses: ["completed"],
    // One todo call creates the list, three more mark it done; the list is one item.
    itemTypes: [
      "user_message",
      "dynamic_tool",
      "todo_list",
      "dynamic_tool",
      "dynamic_tool",
      "dynamic_tool",
      "assistant_message",
      "checkpoint",
    ],
    userMessages: [OMP_TODO_LIST_PROMPT],
  });
  const todo = projection.turnItems.find((item) => item.type === "todo_list");
  assert.deepEqual(
    todo?.type === "todo_list" ? todo.steps.map((step) => [step.text, step.status]) : [],
    [
      ["alpha", "completed"],
      ["beta", "completed"],
      ["gamma", "completed"],
    ],
  );
  assertAssistantTextIncludes(projection, "todo fixture complete");
}
