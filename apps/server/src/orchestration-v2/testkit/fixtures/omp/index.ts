// The fork's omp replay fixtures, kept apart from upstream's ORCHESTRATOR_REPLAY_FIXTURES so
// catching up with upstream never conflicts on them. Shared scenarios reuse upstream's inputs.
import { ProviderDriverKind } from "@t3tools/contracts";

import { providerThreadResumeInput } from "../provider_thread_resume/input.ts";
import type { OrchestratorReplayFixture, ProviderOrchestratorReplayVariant } from "../shared.ts";
import { simpleInput } from "../simple/input.ts";
import { turnInterruptMidToolInput } from "../turn_interrupt_mid_tool/input.ts";
import { ompApprovalApprovedInput, ompApprovalDeclinedInput } from "./approvals/input.ts";
import {
  assertOmpApprovalApprovedOutput,
  assertOmpApprovalDeclinedOutput,
} from "./approvals/output.ts";
import { ompAskFormInput } from "./ask_form/input.ts";
import { assertOmpAskFormOutput } from "./ask_form/output.ts";
import { ompAskQuestionInput } from "./ask_question/input.ts";
import { assertOmpAskQuestionOutput } from "./ask_question/output.ts";
import { ompBackgroundJobWakeInput } from "./background_job_wake/input.ts";
import { assertOmpBackgroundJobWakeOutput } from "./background_job_wake/output.ts";
import { ompBashToolInput } from "./bash_tool/input.ts";
import { assertOmpBashToolOutput } from "./bash_tool/output.ts";
import { ompFileEditInput } from "./file_edit/input.ts";
import { assertOmpFileEditOutput } from "./file_edit/output.ts";
import { ompPlanReviewInput } from "./plan_review/input.ts";
import { assertOmpPlanReviewOutput } from "./plan_review/output.ts";
import { assertOmpProviderThreadResumeOutput } from "./provider_thread_resume/output.ts";
import { OMP_MODEL_SELECTION, OMP_PLAN_MODEL_SELECTION } from "./shared.ts";
import { assertOmpSimpleOutput } from "./simple/output.ts";
import { ompSubagentBatchInput, ompSubagentFailureInput } from "./subagents/input.ts";
import {
  assertOmpSubagentBatchOutput,
  assertOmpSubagentFailureOutput,
} from "./subagents/output.ts";
import { ompTodoListInput } from "./todo_list/input.ts";
import { assertOmpTodoListOutput } from "./todo_list/output.ts";
import { assertTurnInterruptMidToolOmpOutput } from "./turn_interrupt_mid_tool/output.ts";

function ompFixture(
  name: string,
  buildInput: OrchestratorReplayFixture["buildInput"],
  transcript: string,
  variant: Pick<ProviderOrchestratorReplayVariant, "assertOutput"> &
    Partial<ProviderOrchestratorReplayVariant>,
): OrchestratorReplayFixture {
  return {
    name,
    buildInput,
    providers: [
      {
        driver: ProviderDriverKind.make("omp"),
        transcriptFile: new URL(transcript, import.meta.url),
        modelSelection: OMP_MODEL_SELECTION,
        ...variant,
      },
    ],
  };
}

export const OMP_REPLAY_FIXTURES: ReadonlyArray<OrchestratorReplayFixture> = [
  ompFixture("simple", simpleInput, "./simple/transcript.ndjson", {
    assertOutput: assertOmpSimpleOutput,
  }),
  ompFixture(
    "provider_thread_resume",
    providerThreadResumeInput,
    "./provider_thread_resume/transcript.ndjson",
    { assertOutput: assertOmpProviderThreadResumeOutput },
  ),
  ompFixture(
    "turn_interrupt_mid_tool",
    turnInterruptMidToolInput,
    "./turn_interrupt_mid_tool/transcript.ndjson",
    { assertOutput: assertTurnInterruptMidToolOmpOutput },
  ),
  ompFixture("omp_bash_tool", ompBashToolInput, "./bash_tool/transcript.ndjson", {
    assertOutput: assertOmpBashToolOutput,
  }),
  ompFixture("omp_file_edit", ompFileEditInput, "./file_edit/transcript.ndjson", {
    assertOutput: assertOmpFileEditOutput,
  }),
  ompFixture(
    "omp_approval_approved",
    ompApprovalApprovedInput,
    "./approvals/approved_transcript.ndjson",
    { assertOutput: assertOmpApprovalApprovedOutput },
  ),
  ompFixture(
    "omp_approval_declined",
    ompApprovalDeclinedInput,
    "./approvals/declined_transcript.ndjson",
    { assertOutput: assertOmpApprovalDeclinedOutput },
  ),
  ompFixture("omp_ask_question", ompAskQuestionInput, "./ask_question/transcript.ndjson", {
    assertOutput: assertOmpAskQuestionOutput,
  }),
  ompFixture("omp_ask_form", ompAskFormInput, "./ask_form/transcript.ndjson", {
    assertOutput: assertOmpAskFormOutput,
  }),
  ompFixture("omp_subagent_batch", ompSubagentBatchInput, "./subagents/batch_transcript.ndjson", {
    assertOutput: assertOmpSubagentBatchOutput,
  }),
  ompFixture(
    "omp_subagent_failure",
    ompSubagentFailureInput,
    "./subagents/failure_transcript.ndjson",
    { assertOutput: assertOmpSubagentFailureOutput },
  ),
  ompFixture(
    "omp_background_job_wake",
    ompBackgroundJobWakeInput,
    "./background_job_wake/transcript.ndjson",
    { runContinuationWorker: true, assertOutput: assertOmpBackgroundJobWakeOutput },
  ),
  ompFixture("omp_todo_list", ompTodoListInput, "./todo_list/transcript.ndjson", {
    assertOutput: assertOmpTodoListOutput,
  }),
  ompFixture("omp_plan_review", ompPlanReviewInput, "./plan_review/transcript.ndjson", {
    modelSelection: OMP_PLAN_MODEL_SELECTION,
    assertOutput: assertOmpPlanReviewOutput,
  }),
];
