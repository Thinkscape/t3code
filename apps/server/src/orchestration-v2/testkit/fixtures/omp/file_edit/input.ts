import type { OrchestratorFixtureInput } from "../../shared.ts";

export const OMP_FILE_EDIT_PROMPT =
  "In notes.txt, change the line `beta` to `gamma` with the edit tool (not bash). Then reply exactly: edit fixture complete";

export function ompFileEditInput(): OrchestratorFixtureInput {
  return {
    workspaceFiles: { "notes.txt": "alpha\nbeta\n" },
    steps: [{ type: "message", text: OMP_FILE_EDIT_PROMPT }],
  };
}
