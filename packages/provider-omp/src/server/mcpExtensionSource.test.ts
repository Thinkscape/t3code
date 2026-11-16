// @effect-diagnostics nodeBuiltinImport:off -- Execute the shipped extension at its native JavaScript boundary.
import { expect, it } from "@effect/vitest";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import {
  OMP_APPROVAL_FEEDBACK_REQUEST_PREFIX,
  OMP_PLAN_APPROVE_OPTION,
  OMP_PLAN_REFINE_OPTION,
  OMP_T3_MCP_EXTENSION_SOURCE,
  OMP_T3_TOOL_RESULT_WIDGET,
  ompPlanReviewMarkdown,
} from "./mcpExtensionSource.ts";

it("registers MCP tools with omp approval tiers and leaves other calls to omp", async () => {
  type Hook = (event: { toolName: string; input: unknown }, ctx: unknown) => Promise<unknown>;
  const hooks = new Map<string, Hook>();
  const registered: Array<{
    name: string;
    approval: string;
    execute: (id: string, params: unknown) => Promise<unknown>;
  }> = [];
  const calls: string[] = [];
  const source = NodeModule.stripTypeScriptTypes(
    OMP_T3_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(omp)`, {
    process: {
      env: { T3_MCP_URL: "https://fixture.invalid/mcp", T3_MCP_BEARER_TOKEN: "fixture" },
    },
    AbortSignal,
    Type: { Unsafe: (schema: unknown) => schema },
    omp: {
      on: (name: string, hook: Hook) => hooks.set(name, hook),
      registerTool: (tool: (typeof registered)[number]) => registered.push(tool),
    },
    fetch: async (_url: string, options: { body: string }) => {
      const request = JSON.parse(options.body) as { id: number; method: string };
      calls.push(request.method);
      return new Response(
        JSON.stringify({
          id: request.id,
          result:
            request.method === "tools/list"
              ? {
                  tools: [
                    { name: "write_note", inputSchema: { type: "object", properties: {} } },
                    {
                      name: "task_status",
                      inputSchema: { type: "object", properties: {} },
                      annotations: { readOnlyHint: true },
                    },
                  ],
                }
              : { content: [{ type: "text", text: "done" }] },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  // omp's approval mode asks for exec-tier tools and never for read-tier ones.
  expect(registered.map((tool) => [tool.name, tool.approval])).toEqual([
    ["mcp__t3-code__write_note", "exec"],
    ["mcp__t3-code__task_status", "read"],
  ]);
  // The extension no longer gates calls itself; a confirm here would fail the test.
  const ui = { confirm: () => Promise.reject(new Error("the extension must not prompt")) };
  expect(
    await hooks.get("tool_call")!({ toolName: "bash", input: { command: "ls" } }, { ui }),
  ).toBeUndefined();
  expect(await registered[0]!.execute("tool-1", {})).toMatchObject({
    content: [{ type: "text", text: "done" }],
  });
  expect(calls).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
});

it("reports each T3 call it runs, a subagent's through the top-level session's UI", async () => {
  type Ctx = {
    hasUI: boolean;
    agent: { kind: "main" | "sub"; id: string };
    ui: { setWidget: (key: string, lines: ReadonlyArray<string>) => void };
  };
  const hooks = new Map<string, (event: unknown, ctx: Ctx) => unknown>();
  const registered: Array<{
    name: string;
    execute: (
      id: string,
      params: unknown,
      signal: undefined,
      onUpdate: undefined,
      ctx: Ctx,
    ) => Promise<unknown>;
  }> = [];
  const page = { attachmentId: "page", title: "Chart", height: 80 };
  const source = NodeModule.stripTypeScriptTypes(
    OMP_T3_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(omp)`, {
    process: {
      env: { T3_MCP_URL: "https://fixture.invalid/mcp", T3_MCP_BEARER_TOKEN: "fixture" },
    },
    AbortSignal,
    Type: { Unsafe: (schema: unknown) => schema },
    omp: {
      on: (name: string, hook: (event: unknown, ctx: Ctx) => unknown) => hooks.set(name, hook),
      registerTool: (tool: (typeof registered)[number]) => registered.push(tool),
    },
    fetch: async (_url: string, options: { body: string }) => {
      const request = JSON.parse(options.body) as { id: number; method: string };
      return new Response(
        JSON.stringify({
          id: request.id,
          result:
            request.method === "tools/list"
              ? { tools: [{ name: "html_render", inputSchema: { type: "object" } }] }
              : { content: [{ type: "text", text: JSON.stringify({ htmlRender: page }) }] },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  const reports: Array<[string, unknown]> = [];
  const hostUi = {
    setWidget: (key: string, lines: ReadonlyArray<string>) =>
      reports.push([key, JSON.parse(lines[0] ?? "null")]),
  };
  const main: Ctx = { hasUI: true, agent: { kind: "main", id: "Main" }, ui: hostUi };
  await hooks.get("session_start")!({}, main);
  const [tool] = registered;
  const args = { html: "<b>chart</b>", title: "Chart" };
  await tool!.execute("js-write-1", args, undefined, undefined, main);
  // A subagent has no UI of its own; its report names it and goes through the top-level one.
  await tool!.execute("toolu_sub", args, undefined, undefined, {
    hasUI: false,
    agent: { kind: "sub", id: "AwkwardDuck" },
    ui: {
      setWidget: () => {
        throw new Error("a subagent's UI reaches nobody");
      },
    },
  });
  const result = {
    content: [{ type: "text", text: JSON.stringify({ htmlRender: page }) }],
    details: { server: "t3-code", tool: "html_render" },
  };
  expect(reports).toEqual([
    [
      OMP_T3_TOOL_RESULT_WIDGET,
      { toolCallId: "js-write-1", toolName: "mcp__t3-code__html_render", args, result },
    ],
    [
      OMP_T3_TOOL_RESULT_WIDGET,
      {
        toolCallId: "toolu_sub",
        toolName: "mcp__t3-code__html_render",
        args,
        result,
        agentId: "AwkwardDuck",
      },
    ],
  ]);
});

it("relays a decline message to the agent after omp's own denial", async () => {
  type Hook = (
    event: { toolName: string; approved: boolean; reason?: string },
    ctx: { ui: { input: (title: string) => Promise<string | undefined> } },
  ) => Promise<unknown>;
  const hooks = new Map<string, Hook>();
  const sent: Array<{ message: Record<string, unknown>; options: unknown }> = [];
  const source = NodeModule.stripTypeScriptTypes(
    OMP_T3_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(omp)`, {
    process: { env: {} },
    omp: {
      on: (name: string, hook: Hook) => hooks.set(name, hook),
      sendMessage: (message: Record<string, unknown>, options: unknown) =>
        sent.push({ message, options }),
    },
  });
  const resolved = hooks.get("tool_approval_resolved")!;
  const asked: string[] = [];
  const ui = (answer: string | undefined) => ({
    input: async (title: string) => {
      asked.push(title);
      return answer;
    },
  });

  await resolved({ toolName: "bash", approved: true }, { ui: ui("unused") });
  // Aborted prompts are not the user's answer and carry no message.
  await resolved(
    { toolName: "bash", approved: false, reason: "approval aborted" },
    { ui: ui("unused") },
  );
  expect(asked).toEqual([]);

  await resolved({ toolName: "bash", approved: false, reason: "denied by user" }, { ui: ui(" ") });
  expect(sent).toEqual([]);

  await resolved(
    { toolName: "bash", approved: false, reason: "denied by user" },
    { ui: ui("Use e.txt instead") },
  );
  expect(asked).toEqual([
    `${OMP_APPROVAL_FEEDBACK_REQUEST_PREFIX}bash`,
    `${OMP_APPROVAL_FEEDBACK_REQUEST_PREFIX}bash`,
  ]);
  expect(sent).toEqual([
    {
      message: {
        customType: "t3-approval-feedback",
        content: "The user declined your bash call in T3 Code and replied: Use e.txt instead",
        display: false,
        attribution: "user",
      },
      options: { deliverAs: "aside" },
    },
  ]);
});

it("holds a plan submission for review and lets feedback send the agent back to planning", async () => {
  type Ui = {
    confirm: () => Promise<boolean>;
    select: (title: string, options: ReadonlyArray<string>) => Promise<string | undefined>;
    input: (title: string) => Promise<string | undefined>;
  };
  type Hook = (
    event: { toolName: string; input: unknown },
    ctx: { ui: Ui },
  ) => Promise<{ block: true; reason: string } | undefined>;
  const hooks = new Map<string, Hook>();
  const source = NodeModule.stripTypeScriptTypes(
    OMP_T3_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(omp)`, {
    process: { env: { T3_OMP_PLAN_REVIEW: "1" } },
    omp: { on: (name: string, hook: Hook) => hooks.set(name, hook) },
  });
  const hook = hooks.get("tool_call")!;
  const selectTitles: string[] = [];
  const ui = (choice: string | undefined, feedback?: string): Ui => ({
    confirm: async () => {
      throw new Error("plan-mode writes must not raise a generic approval");
    },
    select: async (title) => {
      selectTitles.push(title);
      return choice;
    },
    input: async () => feedback,
  });
  const submit = { toolName: "write", input: { path: "xd://propose", content: "add-subtract" } };

  // Drafting the plan file is part of planning, not a change to approve.
  expect(
    await hook(
      {
        toolName: "write",
        input: { path: "local://add-subtract-plan.md", content: "# Plan\n1. Add subtract()" },
      },
      { ui: ui(undefined) },
    ),
  ).toBeUndefined();

  const refined = await hook(submit, { ui: ui(OMP_PLAN_REFINE_OPTION, "Name it minus()") });
  expect(refined?.block).toBe(true);
  expect(refined?.reason).toContain("Name it minus()");
  // The submission carried only the slug, so the review shows the drafted plan.
  expect(selectTitles.at(-1)).toContain("1. Add subtract()");
  // The adapter recovers the plan from this title to show it as T3's plan card.
  expect(ompPlanReviewMarkdown(selectTitles.at(-1) ?? "")).toBe("# Plan\n1. Add subtract()");
  expect(ompPlanReviewMarkdown("Allow write?")).toBeUndefined();

  expect(await hook(submit, { ui: ui(OMP_PLAN_APPROVE_OPTION) })).toBeUndefined();
  // omp names the plan file after the submission, so a summary instead of the slug would make
  // the approved write fail; the approval hands omp the slug of the plan file the agent edited.
  await hook(
    { toolName: "edit", input: { input: "[local://add-minus-plan.md#AB12]\nPUT 1.=1:\n+# Plan" } },
    { ui: ui(undefined) },
  );
  const summary = { path: "xd://propose", content: "add-minus\n\nAdd minus() to util.py." };
  expect(
    await hook({ toolName: "write", input: summary }, { ui: ui(OMP_PLAN_APPROVE_OPTION) }),
  ).toEqual({ input: { ...summary, content: "add-minus" } });

  const dismissed = await hook(submit, { ui: ui(undefined) });
  expect(dismissed?.block).toBe(true);
  expect(dismissed?.reason).not.toContain("feedback");
});
