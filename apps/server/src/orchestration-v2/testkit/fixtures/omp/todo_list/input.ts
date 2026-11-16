import type { OrchestratorFixtureInput } from "../../shared.ts";

export const OMP_TODO_LIST_PROMPT =
  "Use the todo tool to create a list with exactly three items: alpha, beta, gamma. Then mark each item done in order, one todo call per item. Use no other tools. Then reply exactly: todo fixture complete";

export function ompTodoListInput(): OrchestratorFixtureInput {
  return { steps: [{ type: "message", text: OMP_TODO_LIST_PROMPT }] };
}
