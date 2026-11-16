import type { OrchestratorFixtureInput } from "../../shared.ts";

export const OMP_SUBAGENT_BATCH_PROMPT =
  'Call the task tool exactly once with two tasks in one batch, both using agent "task": task 1 assignment "Reply exactly: alpha done"; task 2 assignment "Reply exactly: beta done". Wait for both, then reply exactly: subagent batch complete';

export const OMP_SUBAGENT_FAILURE_PROMPT =
  'Call the task tool exactly once with one task using agent "broken" and assignment "Reply exactly: broken done". Do not retry. After it returns, reply exactly: subagent failure reported';

/** A project agent pinned to a model omp cannot resolve, so its subagent fails at start. */
const BROKEN_AGENT = [
  "---",
  "name: broken",
  "description: Fixture agent whose model does not exist.",
  "model: no-such-provider/no-such-model",
  "---",
  "",
  "Reply with the assignment's requested text.",
  "",
].join("\n");

export function ompSubagentBatchInput(): OrchestratorFixtureInput {
  return { steps: [{ type: "message", text: OMP_SUBAGENT_BATCH_PROMPT }] };
}

export function ompSubagentFailureInput(): OrchestratorFixtureInput {
  return {
    workspaceFiles: { ".omp/agents/broken.md": BROKEN_AGENT },
    steps: [{ type: "message", text: OMP_SUBAGENT_FAILURE_PROMPT }],
  };
}
