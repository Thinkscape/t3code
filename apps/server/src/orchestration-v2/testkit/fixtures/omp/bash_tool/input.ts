import type { OrchestratorFixtureInput } from "../../shared.ts";

export const OMP_BASH_TOOL_PROMPT =
  "Use the bash tool to run exactly `echo omp bash fixture ok`. Then reply exactly: bash fixture complete";

export function ompBashToolInput(): OrchestratorFixtureInput {
  return { steps: [{ type: "message", text: OMP_BASH_TOOL_PROMPT }] };
}
