import { assert } from "@effect/vitest";
import type {
  OrchestrationV2RunStatus,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ProviderReplayTranscript,
} from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../../OrchestratorScenario.ts";
import {
  assertAllRuntimeRequestsResolved,
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  field,
  projectionFor,
  SIMPLE_PROMPT,
} from "../../shared.ts";

/** Inbound omp frames of one type, in transcript order. */
export function ompInboundFrames(
  transcript: ProviderReplayTranscript,
  type: string,
): ReadonlyArray<unknown> {
  return transcript.entries.flatMap((entry) =>
    entry.type === "emit_inbound" && field(entry.frame, "type") === type ? [entry.frame] : [],
  );
}

/** Outbound adapter frames of one type, in transcript order. */
export function ompOutboundFrames(
  transcript: ProviderReplayTranscript,
  type: string,
): ReadonlyArray<unknown> {
  return transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" && field(entry.frame, "type") === type ? [entry.frame] : [],
  );
}

/**
 * Checks every omp replay shares: run statuses, the ordered item types, nothing left open
 * (items, runtime requests, subagents) and the user prompts.
 */
export function assertOmpReplayRun(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
  expected: {
    readonly runStatuses: ReadonlyArray<OrchestrationV2RunStatus>;
    readonly itemTypes: ReadonlyArray<OrchestrationV2TurnItem["type"]>;
    readonly userMessages: ReadonlyArray<string>;
    readonly runtimeRequestKinds?: ReadonlyArray<string>;
  },
): OrchestrationV2ThreadProjection {
  assertBaseProjection({
    result,
    transcript,
    runCount: expected.runStatuses.length,
    runStatuses: expected.runStatuses,
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, expected.userMessages);
  // Reasoning is left out: the model decides when it thinks.
  assert.deepEqual(
    projection.turnItems.filter((item) => item.type !== "reasoning").map((item) => item.type),
    expected.itemTypes,
  );
  assert.deepEqual(
    projection.turnItems
      .filter(
        (item) =>
          item.status === "pending" || item.status === "running" || item.status === "waiting",
      )
      .map((item) => `${item.type}:${item.status}`),
    [],
    "a settled omp run must leave no item open",
  );
  assert.deepEqual(
    projection.runtimeRequests.map((request) => request.kind),
    expected.runtimeRequestKinds ?? [],
  );
  assertAllRuntimeRequestsResolved(projection);
  assert.deepEqual(
    projection.subagents.filter((subagent) => subagent.status === "running").map((s) => s.id),
    [],
    "no omp subagent may stay running",
  );
  return projection;
}

export function assertOmpSimpleOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = assertOmpReplayRun(result, transcript, {
    runStatuses: ["completed"],
    itemTypes: ["user_message", "assistant_message", "checkpoint"],
    userMessages: [SIMPLE_PROMPT],
  });
  assertAssistantTextIncludes(projection, "fixture simple ok");
  // Session open negotiates protocol v2, so omp sends the model catalog as rpc_chunk frames.
  assert.isAbove(ompInboundFrames(transcript, "rpc_chunk").length, 1);
  assert.lengthOf(ompInboundFrames(transcript, "ready"), 1);
  const [turn] = projection.providerTurns;
  assert.equal(turn?.status, "completed");
  assert.isDefined(turn?.tokenUsage, "omp's settled session stats must land on the turn");
}
