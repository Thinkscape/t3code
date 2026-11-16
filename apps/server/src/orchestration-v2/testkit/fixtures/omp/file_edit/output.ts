import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../../OrchestratorScenario.ts";
import { assertAssistantTextIncludes } from "../../shared.ts";
import { assertOmpReplayRun } from "../simple/output.ts";
import { OMP_FILE_EDIT_PROMPT } from "./input.ts";

export function assertOmpFileEditOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = assertOmpReplayRun(result, transcript, {
    runStatuses: ["completed"],
    // omp reads the file first: its hashline edit needs the line tags `read` returns.
    itemTypes: ["user_message", "dynamic_tool", "file_change", "assistant_message", "checkpoint"],
    userMessages: [OMP_FILE_EDIT_PROMPT],
  });
  const edits = projection.turnItems.filter((item) => item.type === "file_change");
  assert.isNotEmpty(edits);
  assert.deepEqual(
    edits.map((item) => item.status),
    edits.map(() => "completed"),
  );
  assertAssistantTextIncludes(projection, "edit fixture complete");
}
