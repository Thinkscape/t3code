import type { OrchestrationV2PlanStep } from "@t3tools/contracts";

import { ompRecordField as recordField, ompRecordString as recordString } from "./rpc.ts";

/**
 * The todo list a root-agent `todo` tool call left behind, read from its `tool_execution_end`
 * frame (`result.details.phases`, the whole list after the call). Undefined for any other frame
 * or a failed call; an empty array when the call cleared the list.
 */
export function ompTodoStepsFromToolEnd(
  event: unknown,
): ReadonlyArray<OrchestrationV2PlanStep> | undefined {
  if (recordString(event, "toolName") !== "todo" || recordField(event, "isError") === true) {
    return undefined;
  }
  const phases = recordField(recordField(recordField(event, "result"), "details"), "phases");
  if (!Array.isArray(phases)) return undefined;
  const named = phases.filter((phase) => Array.isArray(recordField(phase, "tasks")));
  // A single phase is omp's default grouping; prefix names only when they tell steps apart.
  const showPhase = named.length > 1;
  const steps: Array<OrchestrationV2PlanStep> = [];
  // Ids follow the native list position so a step keeps its id when an earlier one is abandoned.
  let position = 0;
  for (const phase of named) {
    const phaseName = recordString(phase, "name")?.trim() ?? "";
    const tasks = recordField(phase, "tasks");
    if (!Array.isArray(tasks)) continue;
    for (const task of tasks) {
      position += 1;
      const nativeStatus = recordString(task, "status");
      // Abandoned work is not outstanding, and plan steps have no cancelled status.
      if (nativeStatus === "abandoned") continue;
      const content = recordString(task, "content")?.trim() ?? "";
      const text = content.length === 0 ? `Step ${position}` : content;
      steps.push({
        id: `omp-step-${position}`,
        text: showPhase && phaseName.length > 0 ? `${phaseName}: ${text}` : text,
        status:
          nativeStatus === "completed"
            ? "completed"
            : nativeStatus === "in_progress"
              ? "running"
              : "pending",
      });
    }
  }
  return steps;
}

/** Read-only `todo` calls repeat the list unchanged; re-emitting it would only churn the projection. */
export function sameOmpTodoSteps(
  left: ReadonlyArray<OrchestrationV2PlanStep>,
  right: ReadonlyArray<OrchestrationV2PlanStep>,
): boolean {
  return (
    left.length === right.length &&
    left.every((step, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        other.id === step.id &&
        other.text === step.text &&
        other.status === step.status
      );
    })
  );
}
