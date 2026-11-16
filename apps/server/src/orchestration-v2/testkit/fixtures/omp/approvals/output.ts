import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../../OrchestratorScenario.ts";
import { assertAssistantTextIncludes } from "../../shared.ts";
import { assertOmpReplayRun, ompOutboundFrames } from "../simple/output.ts";
import { OMP_APPROVAL_PROMPT } from "./input.ts";

function assertSupervisedLaunch(transcript: ProviderReplayTranscript) {
  const [start] = ompOutboundFrames(transcript, "process_start");
  const args = (start as { readonly args?: ReadonlyArray<string> } | undefined)?.args ?? [];
  assert.include(args.join(" "), "--approval-mode always-ask");
}

export function assertOmpApprovalApprovedOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertSupervisedLaunch(transcript);
  const projection = assertOmpReplayRun(result, transcript, {
    runStatuses: ["completed"],
    itemTypes: [
      "user_message",
      "command_execution",
      "approval_request",
      "assistant_message",
      "checkpoint",
    ],
    userMessages: [OMP_APPROVAL_PROMPT],
    runtimeRequestKinds: ["command"],
  });
  const command = projection.turnItems.find((item) => item.type === "command_execution");
  assert.equal(command?.status, "completed");
  assert.include(
    command?.type === "command_execution" ? command.output : "",
    "omp approval fixture",
  );
  assertAssistantTextIncludes(projection, "approval fixture ran");
}

export function assertOmpApprovalDeclinedOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertSupervisedLaunch(transcript);
  const projection = assertOmpReplayRun(result, transcript, {
    runStatuses: ["completed"],
    itemTypes: [
      "user_message",
      "command_execution",
      "approval_request",
      "assistant_message",
      "checkpoint",
    ],
    userMessages: [OMP_APPROVAL_PROMPT],
    runtimeRequestKinds: ["command"],
  });
  const command = projection.turnItems.find((item) => item.type === "command_execution");
  assert.notEqual(command?.status, "completed", "a declined command must not report success");
  assertAssistantTextIncludes(projection, "approval fixture declined");
}
