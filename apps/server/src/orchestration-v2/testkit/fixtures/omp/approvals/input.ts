import type { OrchestratorFixtureInput } from "../../shared.ts";

export const OMP_APPROVAL_PROMPT =
  "Use the bash tool to run exactly `echo omp approval fixture`. If it runs, reply exactly: approval fixture ran. If it is not allowed, reply exactly: approval fixture declined";

/** Supervised threads launch omp with `--approval-mode always-ask`, so the command asks first. */
function ompApprovalInput(decision: "accept" | "decline"): OrchestratorFixtureInput {
  return {
    runtimeMode: "approval-required",
    steps: [
      { type: "message", text: OMP_APPROVAL_PROMPT },
      { type: "approve_next_runtime_request", decision },
    ],
  };
}

export function ompApprovalApprovedInput(): OrchestratorFixtureInput {
  return ompApprovalInput("accept");
}

export function ompApprovalDeclinedInput(): OrchestratorFixtureInput {
  return ompApprovalInput("decline");
}
