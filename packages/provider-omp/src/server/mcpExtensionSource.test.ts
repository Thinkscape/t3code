// @effect-diagnostics nodeBuiltinImport:off -- Execute the shipped extension at its native JavaScript boundary.
import { expect, it } from "@effect/vitest";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
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
    ctx: { ui: Ui; sessionManager: { getArtifactsDir: () => string } },
  ) => Promise<{ block: true; reason: string } | { input: unknown } | undefined>;
  const hooks = new Map<string, Hook>();
  const dir = "/sessions/resumed-thread";
  const files = new Map([
    [NodePath.join(dir, "local", "asm-git-helper-plan.md"), "## Plan\n1. Install helper"],
  ]);
  const source = NodeModule.stripTypeScriptTypes(
    OMP_T3_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(omp)`, {
    process: { env: { T3_OMP_PLAN_REVIEW: "1" } },
    NodePath,
    NodeFSP: {
      readFile: async (path: string) => {
        const body = files.get(path);
        if (body === undefined) throw new Error("File not found");
        return body;
      },
    },
    omp: { on: (name: string, hook: Hook) => hooks.set(name, hook) },
  });
  const hook = hooks.get("tool_call")!;
  const selectTitles: string[] = [];
  const ctx = (choice?: string, feedback?: string) => ({
    ui: {
      confirm: async () => {
        throw new Error("plan-mode writes must not raise a generic approval");
      },
      select: async (title: string) => {
        selectTitles.push(title);
        return choice;
      },
      input: async () => feedback,
    },
    sessionManager: { getArtifactsDir: () => dir },
  });
  // omp 19 submits with `propose <slug>`, run from bash or as the propose tool; on resume the
  // extension never saw the plan file being written, so it reads the file the slug names.
  const propose = (title: string) => ({ toolName: "propose", input: { title } });
  const bash = (command: string) => ({ toolName: "bash", input: { command } });
  const slug = "asm-git-helper";

  // Drafting the plan file is part of planning, not a change to review.
  expect(
    await hook(
      { toolName: "write", input: { path: "local://asm-git-helper-plan.md", content: "# Plan" } },
      ctx(),
    ),
  ).toBeUndefined();

  const refined = await hook(
    bash(`propose ${slug}`),
    ctx(OMP_PLAN_REFINE_OPTION, "Name it minus()"),
  );
  expect(refined).toMatchObject({ block: true });
  expect(refined && "reason" in refined ? refined.reason : "").toContain("Name it minus()");
  // The adapter recovers the plan from this title to show it as T3's plan card.
  expect(ompPlanReviewMarkdown(selectTitles.at(-1) ?? "")).toBe("## Plan\n1. Install helper");
  expect(ompPlanReviewMarkdown("Allow write?")).toBeUndefined();

  // Review the current file after edits, and hand omp the bare slug it looks the file up by.
  files.set(NodePath.join(dir, "local", `${slug}-plan.md`), "## Revised\n1. Verify helper");
  expect(await hook(propose(`${slug}\n\nOriginal summary.`), ctx(OMP_PLAN_APPROVE_OPTION))).toEqual(
    {
      input: { title: slug },
    },
  );
  expect(ompPlanReviewMarkdown(selectTitles.at(-1) ?? "")).toBe("## Revised\n1. Verify helper");
  expect(await hook(propose(slug), ctx(OMP_PLAN_APPROVE_OPTION))).toBeUndefined();
  expect(await hook(bash(`propose ${slug}`), ctx(OMP_PLAN_APPROVE_OPTION))).toBeUndefined();
  expect(await hook(bash(`propose "${slug}" && echo done`), ctx(OMP_PLAN_APPROVE_OPTION))).toEqual({
    input: { command: `propose ${slug}` },
  });
  // Other shell commands, including ones that merely start with the word, are not submissions.
  expect(await hook(bash("proposer --help"), ctx(OMP_PLAN_APPROVE_OPTION))).toBeUndefined();
  expect(await hook(bash("ls local://"), ctx(OMP_PLAN_APPROVE_OPTION))).toBeUndefined();
  // Older omp writes the slug to xd://propose; it is reviewed the same way.
  const legacy = { toolName: "write", input: { path: "xd://propose", content: slug } };
  expect(await hook(legacy, ctx(OMP_PLAN_APPROVE_OPTION))).toBeUndefined();

  // A slug without a plan file is sent back without asking the user.
  const reviewed = selectTitles.length;
  expect(await hook(propose("missing"), ctx(OMP_PLAN_APPROVE_OPTION))).toMatchObject({
    block: true,
  });
  expect(selectTitles).toHaveLength(reviewed);

  const dismissed = await hook(propose(slug), ctx());
  expect(dismissed).toMatchObject({ block: true });
  expect(dismissed && "reason" in dismissed ? dismissed.reason : "").not.toContain("feedback");
});
