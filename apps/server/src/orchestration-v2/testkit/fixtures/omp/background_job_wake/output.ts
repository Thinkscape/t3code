import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../../OrchestratorScenario.ts";
import { assertOmpReplayRun } from "../simple/output.ts";
import { OMP_BACKGROUND_JOB_PROMPT } from "./input.ts";

export function assertOmpBackgroundJobWakeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = assertOmpReplayRun(result, transcript, {
    runStatuses: ["completed", "completed"],
    itemTypes: [
      "user_message",
      "command_execution",
      "assistant_message",
      "checkpoint",
      "notification",
      "assistant_message",
      "checkpoint",
    ],
    userMessages: [OMP_BACKGROUND_JOB_PROMPT],
  });
  const [rootRun, wakeRun] = projection.runs;
  const command = projection.turnItems.find((item) => item.type === "command_execution");
  assert.equal(command?.runId, rootRun?.id, "the job belongs to the run that started it");
  assert.equal(command?.status, "completed");
  assert.include(command?.type === "command_execution" ? command.output : "", "WAKE_TOKEN");
  const answers = (runId: unknown) =>
    projection.turnItems.flatMap((item) =>
      item.runId === runId && item.type === "assistant_message" ? [item.text.trim()] : [],
    );
  assert.include(answers(rootRun?.id), "STARTED");
  assert.include(answers(wakeRun?.id).join("\n"), "WAKE_TOKEN");
  const wakeMessage = projection.messages.find((message) => message.id === wakeRun?.userMessageId);
  assert.equal(`${wakeMessage?.createdBy}:${wakeMessage?.creationSource}`, "agent:provider");
}
