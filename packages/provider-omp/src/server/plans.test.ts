// @effect-diagnostics nodeBuiltinImport:off -- Fixtures are read synchronously at module load.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";

import { ompTodoStepsFromToolEnd, sameOmpTodoSteps } from "./plans.ts";

// Recorded from `omp --mode rpc-ui` (v18.20.0): create a 3-item todo list, then tick each item.
const recordedTodoFrames = NodeFS.readFileSync(
  NodePath.join(import.meta.dirname, "../../test/fixtures/todo-three-items.ndjson"),
  "utf8",
)
  .split("\n")
  .filter(Boolean)
  .map((line): unknown => JSON.parse(line));

it("reads the whole todo list after each recorded todo call", () => {
  const lists = recordedTodoFrames.flatMap((frame) => {
    const steps = ompTodoStepsFromToolEnd(frame);
    return steps === undefined ? [] : [steps.map((step) => `${step.text}:${step.status}`)];
  });
  expect(lists).toEqual([
    ["alpha:running", "beta:pending", "gamma:pending"],
    ["alpha:completed", "beta:running", "gamma:pending"],
    ["alpha:completed", "beta:completed", "gamma:running"],
    ["alpha:completed", "beta:completed", "gamma:completed"],
  ]);
});

it("ignores other tools and failed todo calls", () => {
  const end = (overrides: Record<string, unknown>) => ({
    type: "tool_execution_end",
    toolName: "todo",
    result: {
      details: { phases: [{ name: "Tasks", tasks: [{ content: "a", status: "pending" }] }] },
    },
    isError: false,
    ...overrides,
  });
  expect(ompTodoStepsFromToolEnd(end({ toolName: "bash" }))).toBeUndefined();
  expect(ompTodoStepsFromToolEnd(end({ isError: true }))).toBeUndefined();
  expect(ompTodoStepsFromToolEnd(end({ result: { details: {} } }))).toBeUndefined();
  expect(ompTodoStepsFromToolEnd(end({ result: { details: { phases: [] } } }))).toEqual([]);
});

it("drops abandoned tasks without renumbering the rest and names phases only when several exist", () => {
  const steps = ompTodoStepsFromToolEnd({
    toolName: "todo",
    result: {
      details: {
        phases: [
          {
            name: "Build",
            tasks: [
              { content: "compile", status: "abandoned" },
              { content: "link", status: "in_progress" },
            ],
          },
          { name: "Ship", tasks: [{ content: "", status: "pending" }] },
        ],
      },
    },
  });
  expect(steps).toEqual([
    { id: "omp-step-2", text: "Build: link", status: "running" },
    { id: "omp-step-3", text: "Ship: Step 3", status: "pending" },
  ]);
});

it("treats an unchanged list as the same", () => {
  const step = { id: "omp-step-1", text: "a", status: "pending" as const };
  expect(sameOmpTodoSteps([step], [{ ...step }])).toBe(true);
  expect(sameOmpTodoSteps([step], [{ ...step, status: "completed" }])).toBe(false);
});
