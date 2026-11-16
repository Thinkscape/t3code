import type { OrchestratorFixtureInput } from "../../shared.ts";

export const OMP_BACKGROUND_JOB_PROMPT =
  "Use the bash tool to run exactly `sleep 5; echo WAKE_TOKEN` as a background job (async, do not wait for it). After starting it, reply exactly: STARTED. When the job finishes, reply exactly with its output.";

/** omp yields run 1 at STARTED; the job's completion wakes omp, which T3 records as run 2. */
export function ompBackgroundJobWakeInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OMP_BACKGROUND_JOB_PROMPT },
      { type: "await_run_status", targetRunIndex: 2, status: "completed" },
    ],
  };
}
