import { expect, it } from "@effect/vitest";
import { T3_OMP_PLAN_REVIEW_ENV } from "./mcpExtensionSource.ts";
import { buildOmpRpcLaunch, resolveOmpLaunchArgs } from "./mcpInjection.ts";

it.each([
  "--restore",
  "--from-claude",
  "--from-codex",
  "--goal",
  "--alias",
  "--cwd",
  "--resume",
  "--continue",
])("reserves native startup lifecycle argument %s in both forms", (flag) => {
  expect(resolveOmpLaunchArgs(`${flag} /fixture/session.jsonl`).ok).toBe(false);
  expect(resolveOmpLaunchArgs(`${flag}=/fixture/session.jsonl`).ok).toBe(false);
});

it.each(["--plan-yolo", "--plan-yolo-into"])(
  "reserves %s, which approves plans unattended without T3's review hook",
  (flag) => {
    expect(resolveOmpLaunchArgs(`${flag} anthropic/claude-opus-5-5`).ok).toBe(false);
  },
);

it.each(["--approval-mode yolo", "--auto-approve", "--yolo", "--approval-mode=write"])(
  "reserves %s, which would override the thread's runtime mode",
  (args) => {
    expect(resolveOmpLaunchArgs(args).ok).toBe(false);
  },
);

it.each([
  ["approval-required", "always-ask"],
  ["auto-accept-edits", "write"],
  ["auto", "always-ask"],
  ["full-access", "yolo"],
] as const)("launches a %s thread with omp's %s approval mode", (runtimeMode, approvalMode) => {
  const launch = buildOmpRpcLaunch({
    launchArgs: ["--model", "anthropic/claude-opus-5-5"],
    environment: {},
    mcpSession: undefined,
    // omp enforces the mode itself, so it holds without the T3 extension too.
    extensionPath: undefined,
    runtimeMode,
  });
  const index = launch.args.indexOf("--approval-mode");
  expect(launch.args[index + 1]).toBe(approvalMode);
  expect(launch.args.lastIndexOf("--approval-mode")).toBe(index);
});

it("leaves omp's configured approval mode alone without a runtime mode", () => {
  const launch = buildOmpRpcLaunch({
    launchArgs: [],
    environment: {},
    mcpSession: undefined,
    extensionPath: undefined,
  });
  expect(launch.args).not.toContain("--approval-mode");
});

it("starts plan mode only together with the review extension", () => {
  const base = {
    launchArgs: [],
    // An inherited marker must not switch reviews on for a default-mode session.
    environment: { [T3_OMP_PLAN_REVIEW_ENV]: "1" },
    mcpSession: undefined,
  };
  const model = "anthropic/claude-opus-5-5";

  const reviewed = buildOmpRpcLaunch({
    ...base,
    extensionPath: "/fixture/extension.ts",
    planExecutionModel: model,
  });
  expect(reviewed.args.join(" ")).toContain(`--plan-yolo --plan-yolo-into ${model}`);
  expect(reviewed.env[T3_OMP_PLAN_REVIEW_ENV]).toBe("1");

  const withoutExtension = buildOmpRpcLaunch({
    ...base,
    extensionPath: undefined,
    planExecutionModel: model,
  });
  expect(withoutExtension.args).not.toContain("--plan-yolo");
  expect(withoutExtension.env[T3_OMP_PLAN_REVIEW_ENV]).toBeUndefined();

  const defaultMode = buildOmpRpcLaunch({ ...base, extensionPath: "/fixture/extension.ts" });
  expect(defaultMode.args).not.toContain("--plan-yolo");
  expect(defaultMode.env[T3_OMP_PLAN_REVIEW_ENV]).toBeUndefined();
});
