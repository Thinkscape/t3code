import { describe, expect, it } from "@effect/vitest";

import {
  ompApprovalChoice,
  ompApprovalFullAccessOverride,
  ompApprovalOptions,
  parseOmpApprovalPrompt,
  takeOmpApprovalFeedback,
  type OmpDeclinedApproval,
} from "./approvals.ts";
import { OMP_APPROVAL_FEEDBACK_REQUEST_PREFIX } from "./mcpExtensionSource.ts";

// Frames captured from omp 18.20.0 `--mode rpc-ui --approval-mode always-ask`.
const BASH_FRAME = {
  type: "extension_ui_request",
  id: "15cc5bbfff7bb9d8",
  method: "select",
  title: "Allow tool: bash\nCommand: echo hi > a.txt",
  options: ["Approve", "Approve bash for this session", "Deny"],
} as const;
const WRITE_FRAME = {
  type: "extension_ui_request",
  id: "15cc5bc1b5fbb9d9",
  method: "select",
  title: "Allow tool: write\nPath: b.txt\nContent:\none",
  options: ["Approve", "Approve write for this session", "Deny"],
} as const;
const EDIT_FRAME = {
  type: "extension_ui_request",
  id: "15cc5bc436fbb9da",
  method: "select",
  title: "Allow tool: edit\nFile: b.txt",
  options: ["Approve", "Approve edit for this session", "Deny"],
} as const;
const EVAL_FRAME = {
  type: "extension_ui_request",
  id: "15cc5e367658e4ba",
  method: "select",
  title: "Allow tool: eval\nLanguage: python\nCode:\nprint(1)",
  options: ["Approve", "Approve eval for this session", "Deny"],
} as const;
// From `--approval-mode write`: the parent's `task` call is the only approval a subagent gets.
const TASK_FRAME = {
  type: "extension_ui_request",
  id: "15cc5bdf71c30a89",
  method: "select",
  title:
    "Allow tool: task\nContext:\nSingle subagent run; no shared context.\nBatch agents: task \u00d71\nName: Childy\nAgent: task\nTask:\nrun bash: echo child > child.txt, then yield",
  options: ["Approve", "Approve task for this session", "Deny"],
} as const;

const parse = (frame: { readonly title: string; readonly options: ReadonlyArray<string> }) => {
  const prompt = parseOmpApprovalPrompt(frame.title, frame.options);
  if (prompt === undefined) throw new Error(`not an approval: ${frame.title}`);
  return prompt;
};

describe("parseOmpApprovalPrompt", () => {
  it("shows a shell call as its command line", () => {
    const prompt = parse(BASH_FRAME);
    expect(prompt).toMatchObject({
      toolName: "bash",
      requestKind: "command",
      title: "Allow bash",
      detail: "echo hi > a.txt",
      reason: undefined,
      sessionLabel: "Approve bash for this session",
    });
  });

  it("shows edits and writes as file changes with their paths", () => {
    expect(parse(WRITE_FRAME)).toMatchObject({
      requestKind: "file-change",
      detail: "Path: b.txt\nContent:\none",
    });
    expect(parse(EDIT_FRAME)).toMatchObject({ requestKind: "file-change", detail: "File: b.txt" });
    // A write to an xd:// device runs the device.
    expect(
      parse({
        title: "Allow tool: write\nPath: xd://bash\nArguments:\ncommand: ls",
        options: ["Approve", "Deny"],
      }).requestKind,
    ).toBe("command");
  });

  it("keeps other exec tools' readable details", () => {
    expect(parse(EVAL_FRAME)).toMatchObject({
      requestKind: "command",
      detail: "Language: python\nCode:\nprint(1)",
    });
  });

  it("names the subagents a task call starts", () => {
    const prompt = parse(TASK_FRAME);
    expect(prompt.title).toBe("Start subagent Childy");
    expect(prompt.detail.startsWith("Subagents: Childy\n\nContext:")).toBe(true);
    const batch = parse({
      title:
        "Allow tool: task\nBatch agents: task \u00d72\nName: Alpha\nAgent: task\nName: Beta\nAgent: scout",
      options: ["Approve", "Deny"],
    });
    expect(batch.title).toBe("Start subagents Alpha, Beta");
  });

  it("separates the reason and MCP origin rows from the details", () => {
    const prompt = parse({
      title: "Allow tool: bash\nReason: Critical pattern detected\nCommand: rm -rf /",
      options: ["Approve", "Deny"],
    });
    expect(prompt).toMatchObject({
      reason: "Critical pattern detected",
      detail: "rm -rf /",
      sessionLabel: undefined,
    });
    expect(
      parse({
        title: "Allow tool: mcp__srv_tool\nOrigin: MCP server tool\nArguments:\nq: 1",
        options: ["Approve", "Approve mcp__srv_tool for this session", "Deny"],
      }).detail,
    ).toBe("Arguments:\nq: 1");
  });

  it("leaves other dialogs to the question path", () => {
    expect(
      parseOmpApprovalPrompt("Approve this plan and start implementing it?\n\n1. x", [
        "Approve and execute",
        "Refine plan",
      ]),
    ).toBeUndefined();
    expect(parseOmpApprovalPrompt("Allow tool: bash", ["Yes", "No"])).toBeUndefined();
  });
});

describe("approval answers", () => {
  it("offers omp's own choices", () => {
    expect(ompApprovalOptions(parse(BASH_FRAME))).toEqual([
      { decision: "decline", label: "Deny" },
      { decision: "acceptForSession", label: "Approve bash for this session" },
      { decision: "accept", label: "Approve" },
    ]);
    // Safety overrides cannot be approved for the session.
    expect(
      ompApprovalOptions(
        parse({ title: "Allow tool: bash\nReason: x\nCommand: y", options: ["Approve", "Deny"] }),
      ).map((option) => option.decision),
    ).toEqual(["decline", "accept"]);
  });

  it("maps T3 decisions to the dialog's labels", () => {
    const prompt = parse(BASH_FRAME);
    expect(ompApprovalChoice(prompt, "accept")).toBe("Approve");
    expect(ompApprovalChoice(prompt, "acceptForSession")).toBe("Approve bash for this session");
    expect(ompApprovalChoice(prompt, "acceptAlways")).toBe("Approve bash for this session");
    expect(ompApprovalChoice(prompt, "decline")).toBe("Deny");
    expect(ompApprovalChoice(prompt, "cancel")).toBeUndefined();
    const once = parse({ title: "Allow tool: bash\nCommand: y", options: ["Approve", "Deny"] });
    expect(ompApprovalChoice(once, "acceptForSession")).toBe("Approve");
  });

  it("explains why a full-access thread is asked", () => {
    const rule = parse({ title: "Allow tool: bash\nCommand: ls", options: ["Approve", "Deny"] });
    expect(ompApprovalFullAccessOverride(rule, "full-access")).toBe("ask_rule");
    expect(ompApprovalFullAccessOverride(rule, "approval-required")).toBeUndefined();
    const restricted = parse({
      title: "Allow tool: read\nReason: Restricted folder: /secrets\nPath: /secrets/a",
      options: ["Approve", "Deny"],
    });
    expect(ompApprovalFullAccessOverride(restricted, "full-access")).toBe("provider_check");
  });

  it("hands each decline message to the matching feedback request once", () => {
    const declined: Array<OmpDeclinedApproval> = [
      { toolName: "write", feedback: "not that file" },
      { toolName: "bash", feedback: "use e.txt" },
    ];
    expect(takeOmpApprovalFeedback(declined, "What should change in the plan?")).toBeUndefined();
    expect(
      takeOmpApprovalFeedback(declined, `${OMP_APPROVAL_FEEDBACK_REQUEST_PREFIX}bash`),
    ).toEqual({
      value: "use e.txt",
    });
    expect(
      takeOmpApprovalFeedback(declined, `${OMP_APPROVAL_FEEDBACK_REQUEST_PREFIX}bash`),
    ).toEqual({
      cancelled: true,
    });
    expect(declined).toEqual([{ toolName: "write", feedback: "not that file" }]);
  });
});
