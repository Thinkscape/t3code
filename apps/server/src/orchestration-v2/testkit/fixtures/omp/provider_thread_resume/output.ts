import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../../OrchestratorScenario.ts";
import {
  field,
  PROVIDER_THREAD_RESUME_FIRST_PROMPT,
  PROVIDER_THREAD_RESUME_SECOND_PROMPT,
} from "../../shared.ts";
import { assertOmpReplayRun, ompOutboundFrames } from "../simple/output.ts";

const FIRST_FINAL = "provider thread resume fixture first turn complete";
const SECOND_FINAL = "provider thread resume fixture second turn complete";

export function assertOmpProviderThreadResumeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assert.lengthOf(
    ompOutboundFrames(transcript, "process_start"),
    2,
    "the idle release must retire the first omp process",
  );
  // A fresh omp process resumes the thread by switching to T3's copy of the first session file,
  // kept under the provider host's state directory.
  const switches = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" && field(entry.frame, "type") === "switch_session"
      ? [[entry.label, String(field(entry.frame, "sessionPath"))]]
      : [],
  );
  assert.lengthOf(switches, 1);
  const [label, sessionPath = ""] = switches[0] ?? [];
  assert.equal(label, "switch_session@p2");
  assert.match(sessionPath, /^<omp-state>\/omp-sessions\/[^/]+\.jsonl$/);
  const projection = assertOmpReplayRun(result, transcript, {
    runStatuses: ["completed", "completed"],
    itemTypes: [
      "user_message",
      "assistant_message",
      "checkpoint",
      "user_message",
      "assistant_message",
      "checkpoint",
    ],
    userMessages: [PROVIDER_THREAD_RESUME_FIRST_PROMPT, PROVIDER_THREAD_RESUME_SECOND_PROMPT],
  });
  assert.lengthOf(projection.providerThreads, 1, "resume must keep one provider thread");
  assert.isTrue(
    (projection.providerThreads[0]?.nativeThreadRef?.nativeId ?? "").endsWith(
      sessionPath.slice("<omp-state>".length),
    ),
    "the thread must continue in the session copy omp resumed",
  );
  const answers = projection.turnItems.flatMap((item) =>
    item.type === "assistant_message" ? [item.text] : [],
  );
  assert.include(answers[1], FIRST_FINAL, "the resumed session must remember the first answer");
  assert.include(answers[1], SECOND_FINAL);
}
