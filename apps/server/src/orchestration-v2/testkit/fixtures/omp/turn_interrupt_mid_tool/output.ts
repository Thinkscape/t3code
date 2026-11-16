import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../../OrchestratorScenario.ts";
import { TURN_INTERRUPT_MID_TOOL_PROMPT } from "../../shared.ts";
import { assertOmpReplayRun, ompInboundFrames, ompOutboundFrames } from "../simple/output.ts";

export function assertTurnInterruptMidToolOmpOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assert.isNotEmpty(ompInboundFrames(transcript, "tool_execution_start"));
  assert.isNotEmpty(ompOutboundFrames(transcript, "abort"), "Stop must abort the running command");
  const projection = assertOmpReplayRun(result, transcript, {
    runStatuses: ["interrupted"],
    itemTypes: [
      "user_message",
      "command_execution",
      "run_interrupt_request",
      "run_interrupt_result",
    ],
    userMessages: [TURN_INTERRUPT_MID_TOOL_PROMPT],
  });
  const command = projection.turnItems.find((item) => item.type === "command_execution");
  assert.include(command?.type === "command_execution" ? command.input : "", "node -e");
  assert.equal(command?.status, "interrupted");
  assert.deepEqual(
    projection.providerTurns.map((turn) => turn.status),
    ["interrupted"],
  );
}
