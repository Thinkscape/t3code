// No T3 imports inside the string; resolve Omp and typebox from the user's Omp install.
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";

export const OMP_T3_MCP_EXTENSION_FILENAME = "omp-t3-mcp-extension.ts";

export const T3_MCP_URL_ENV = "T3_MCP_URL";
export const T3_MCP_BEARER_ENV = "T3_MCP_BEARER_TOKEN";
export const T3_OMP_MCP_EXTENSION_PATH_ENV = "T3_OMP_MCP_EXTENSION_PATH";
/** Set while omp runs with `--plan-yolo`: the extension then holds plan submissions for review. */
export const T3_OMP_PLAN_REVIEW_ENV = "T3_OMP_PLAN_REVIEW";
export const OMP_PLAN_REVIEW_PROMPT = "Approve this plan and start implementing it?";
const OMP_PLAN_FEEDBACK_PROMPT = "What should change in the plan?";
export const OMP_PLAN_APPROVE_OPTION = "Approve and execute";
export const OMP_PLAN_REFINE_OPTION = "Refine plan";

/** The plan text of the extension's review dialog (`select` title), or undefined for any other dialog. */
export function ompPlanReviewMarkdown(title: string): string | undefined {
  const prefix = `${OMP_PLAN_REVIEW_PROMPT}\n\n`;
  if (!title.startsWith(prefix)) return undefined;
  const markdown = title.slice(prefix.length).trim();
  return markdown.length === 0 ? undefined : markdown;
}

/**
 * Title of the `input` request the extension sends after the user denies one of omp's own tool
 * approvals, followed by the tool name. omp's denial carries no message, so this is how the
 * adapter hands over the user's "decline with message" text; it answers without showing a card.
 */
export const OMP_APPROVAL_FEEDBACK_REQUEST_PREFIX = "T3 Code approval feedback: ";

/**
 * Widget key under which the extension reports each T3 tool call it ran, as one JSON line:
 * `{toolCallId, toolName, args, result, agentId?}`. omp's RPC frames show only the outermost
 * call, so a call made from inside another tool (an eval cell's `tool.write("xd://…")`) or by a
 * subagent reaches T3 only through this report; `agentId` names the subagent that made it.
 */
export const OMP_T3_TOOL_RESULT_WIDGET = "t3-code:tool-result";

export const OMP_T3_MCP_EXTENSION_SOURCE = `\
import { type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { Type } from "@sinclair/typebox";

const URL_ENV = ${JSON.stringify(T3_MCP_URL_ENV)};
const TOKEN_ENV = ${JSON.stringify(T3_MCP_BEARER_ENV)};
const APPROVAL_FEEDBACK_REQUEST_PREFIX = ${JSON.stringify(OMP_APPROVAL_FEEDBACK_REQUEST_PREFIX)};
const ORCHESTRATION_INSTRUCTIONS = ${JSON.stringify(T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim())};
const PROTOCOL = "2025-06-18";
const PLAN_REVIEW_ENV = ${JSON.stringify(T3_OMP_PLAN_REVIEW_ENV)};
const PLAN_REVIEW_PROMPT = ${JSON.stringify(OMP_PLAN_REVIEW_PROMPT)};
const PLAN_FEEDBACK_PROMPT = ${JSON.stringify(OMP_PLAN_FEEDBACK_PROMPT)};
const PLAN_APPROVE = ${JSON.stringify(OMP_PLAN_APPROVE_OPTION)};
const PLAN_REFINE = ${JSON.stringify(OMP_PLAN_REFINE_OPTION)};
const TOOL_RESULT_WIDGET = ${JSON.stringify(OMP_T3_TOOL_RESULT_WIDGET)};

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type JsonRpcResponse = {
  readonly id?: number | string;
  readonly result?: JsonValue;
  readonly error?: { readonly message?: string };
};

type McpTool = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly annotations?: { readonly readOnlyHint?: boolean };
  readonly outputSchema?: Record<string, unknown>;
};

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function parseSseOrJson(body: string, contentType: string): JsonRpcResponse {
  if (contentType.includes("text/event-stream")) {
    for (const line of body.split("\\n")) {
      const trimmed = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (trimmed.length === 0) continue;
      const parsed = JSON.parse(trimmed) as JsonRpcResponse;
      if (parsed.id !== undefined || parsed.result !== undefined || parsed.error !== undefined) {
        return parsed;
      }
    }
    throw new Error("MCP SSE response had no JSON-RPC payload.");
  }
  return JSON.parse(body) as JsonRpcResponse;
}

function jsonSchemaToTypebox(schema: Record<string, unknown> | undefined) {
  const unsafe = (Type as { Unsafe?: (value: unknown) => unknown }).Unsafe;
  if (typeof unsafe === "function" && schema !== undefined) {
    // Zero-argument MCP tools may omit "properties", which some OpenAI-compatible
    // servers reject. Declare it, as Omp does for its own MCP tools.
    return unsafe({
      ...schema,
      type: schema.type ?? "object",
      ...(schema.properties === undefined ? { properties: {} } : {}),
    });
  }
  return Type.Object({}, { additionalProperties: true });
}

type ModelContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function mcpModelContent(result: unknown): ModelContent[] {
  if (result === null || result === undefined) return [];
  if (typeof result !== "object") return [{ type: "text", text: String(result) }];
  const record = result as {
    readonly content?: ReadonlyArray<{
      readonly type?: string;
      readonly text?: string;
      readonly data?: string;
      readonly mimeType?: string;
    }>;
    readonly structuredContent?: unknown;
  };
  const content: ModelContent[] = [];
  if (Array.isArray(record.content)) {
    for (const part of record.content) {
      if (part?.type === "text" && typeof part.text === "string") {
        content.push({ type: "text", text: part.text });
      } else if (part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
        content.push({ type: "image", data: part.data, mimeType: part.mimeType });
      }
    }
  }
  // Structured output belongs to scripts. Only use it as model text when
  // the server supplied no model-facing blocks, matching Omp's native MCP tools.
  if (content.length === 0) {
    content.push({ type: "text", text: JSON.stringify(record.structuredContent ?? result) });
  }
  return content;
}

function isMcpToolError(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "isError" in result &&
    result.isError === true
  );
}

function createMcpClient(endpoint: string, token: string) {
  let nextId = 1;
  let sessionId: string | undefined;

  const headers = (): Record<string, string> => {
    const next: Record<string, string> = {
      accept: "application/json, text/event-stream",
      authorization: token.startsWith("Bearer ") ? token : \`Bearer \${token}\`,
      "content-type": "application/json",
      // Effect's HTTP MCP rejects post-initialize requests without this
      // (400). The worktree client in McpHttpServer tests sends the same
      // header; initialize itself does not require it.
      "mcp-protocol-version": PROTOCOL,
    };
    if (sessionId !== undefined) next["mcp-session-id"] = sessionId;
    return next;
  };

  const request = async (method: string, params?: unknown, signal?: AbortSignal) => {
    const id = nextId++;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal,
    });
    const nextSession = response.headers.get("mcp-session-id");
    if (nextSession) sessionId = nextSession;
    const body = await response.text();
    if (!response.ok) {
      throw new Error(\`MCP \${method} failed (\${response.status}): \${body.slice(0, 400)}\`);
    }
    if (body.length === 0) return undefined;
    const parsed = parseSseOrJson(body, response.headers.get("content-type") ?? "");
    if (parsed.error) {
      throw new Error(parsed.error.message ?? \`MCP \${method} returned an error\`);
    }
    return parsed.result;
  };

  const notify = async (method: string, params?: unknown, signal?: AbortSignal) => {
    await fetch(endpoint, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      signal,
    });
  };

  return {
    async connect(signal?: AbortSignal) {
      await request(
        "initialize",
        {
          protocolVersion: PROTOCOL,
          capabilities: {},
          clientInfo: { name: "t3-omp-mcp", version: "1.0.0" },
        },
        signal,
      );
      await notify("notifications/initialized", {}, signal).catch(() => undefined);
    },
    async listTools(signal?: AbortSignal) {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const result = (await request(
          "tools/list",
          cursor === undefined ? {} : { cursor },
          signal,
        )) as { tools?: McpTool[]; nextCursor?: string } | undefined;
        tools.push(...(result?.tools ?? []));
        cursor = result?.nextCursor;
      } while (cursor);
      return tools;
    },
    async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      return request("tools/call", { name, arguments: args }, signal);
    },
  };
}

// Subagents run this extension again in the same process, without a UI of their own; they
// report their T3 tool calls through the top-level session's.
let hostUi: { setWidget(key: string, lines: string[] | undefined): void } | undefined;

export default async function t3McpExtension(omp: ExtensionAPI) {
  omp.on("session_start", (_event, ctx) => {
    if (ctx.hasUI && ctx.agent?.kind !== "sub") hostUi = ctx.ui;
  });
  omp.on("input", async (event) => {
    if (!event.text.includes("$")) return;
    const commands = omp.getCommands().filter((command) => command.source === "skill");
    const blocks: string[] = [];
    const seen = new Set<string>();
    for (const match of event.text.matchAll(/(^|\\s)\\$([^\\s]+)(?=\\s|$)/g)) {
      const name = match[2];
      if (!name || seen.has(name)) continue;
      const command = commands.find((candidate) => candidate.name === "skill:" + name || candidate.name === name);
      const path = command?.sourceInfo?.path ?? command?.path;
      if (!path) continue;
      seen.add(name);
      const body = await NodeFSP.readFile(path, "utf8");
      blocks.push(\`<skill name="\${name}" location="\${path}">\\n\${body}\\n</skill>\`);
    }
    if (blocks.length > 0) return { action: "transform", text: event.text + "\\n\\n" + blocks.join("\\n\\n"), images: event.images };
  });
  // Under --plan-yolo omp approves a plan the moment the agent submits it to xd://propose. This
  // hook runs before that write, so holding it until T3 answers is the review step, and blocking
  // it keeps the agent planning. The submission often carries only the plan's slug; the text is
  // in the plan file the agent wrote (and maybe edited) just before.
  let planDraft = "";
  let planSlug = "";
  const notePlanFile = (input: unknown) => {
    const match = /local:\\/\\/([A-Za-z0-9_-]+)-plan\\.md/.exec(JSON.stringify(input ?? null));
    if (match) planSlug = match[1];
  };
  const readPlanFile = async (ctx: { localProtocolOptions?: { getArtifactsDir?: () => string | null } }) => {
    const dir = planSlug ? ctx.localProtocolOptions?.getArtifactsDir?.() : undefined;
    if (!dir) return undefined;
    return NodeFSP.readFile(NodePath.join(dir, "local", planSlug + "-plan.md"), "utf8").catch(() => undefined);
  };
  omp.on("tool_call", async (event, ctx) => {
    if (env(PLAN_REVIEW_ENV) === "1" && (event.toolName === "write" || event.toolName === "edit")) {
      const input = (event.input ?? {}) as { path?: unknown; content?: unknown };
      const path = typeof input.path === "string" ? input.path : "";
      const content = typeof input.content === "string" ? input.content : "";
      if (event.toolName === "write" && path.startsWith("xd://propose")) {
        const plan = (content.includes("\\n") ? content : (await readPlanFile(ctx)) || planDraft || content).trim();
        const choice = await ctx.ui.select(
          PLAN_REVIEW_PROMPT + "\\n\\n" + plan, [PLAN_APPROVE, PLAN_REFINE], { signal: ctx.signal },
        );
        if (choice === PLAN_APPROVE) {
          // omp turns the submission into the plan file name; anything but the bare slug fails
          // that lookup, so hand it the slug of the plan file instead.
          return /^[A-Za-z0-9_-]+$/.test(content.trim()) || !planSlug
            ? undefined
            : { input: { ...input, content: planSlug } };
        }
        const feedback = choice === PLAN_REFINE
          ? await ctx.ui.input(PLAN_FEEDBACK_PROMPT, undefined, { signal: ctx.signal })
          : undefined;
        return {
          block: true,
          reason: "The user did not approve this plan."
            + (feedback ? " Their feedback: " + feedback : "")
            + " Stay in plan mode, revise the plan file, and submit it again.",
        };
      }
      if (event.toolName === "edit" || path.startsWith("local://")) {
        notePlanFile(event.input);
        if (event.toolName === "write") planDraft = content;
        return;
      }
    }
  });
  // Which calls ask is omp's own decision: T3 launches it with the --approval-mode of the
  // thread's runtime mode. A denial reaches the agent only as "Tool call denied by user", so
  // fetch the message the user may have declined with and put it in front of the agent too.
  omp.on("tool_approval_resolved", async (event, ctx) => {
    if (event.approved || event.reason !== "denied by user") return;
    const feedback = (await ctx.ui.input(APPROVAL_FEEDBACK_REQUEST_PREFIX + event.toolName))?.trim();
    if (!feedback) return;
    omp.sendMessage(
      {
        customType: "t3-approval-feedback",
        content: \`The user declined your \${event.toolName} call in T3 Code and replied: \${feedback}\`,
        display: false,
        // Without user attribution the model reads the reply as tool output and ignores it.
        attribution: "user",
      },
      { deliverAs: "aside" },
    );
  });
  const endpoint = env(URL_ENV);
  const token = env(TOKEN_ENV);
  if (endpoint === undefined || token === undefined) return;
  const client = createMcpClient(endpoint, token);
  await client.connect(AbortSignal.timeout(10_000));
  const catalog = await client.listTools(AbortSignal.timeout(10_000));
  for (const tool of catalog) {
    const name = "mcp__t3-code__" + tool.name;
    omp.registerTool({
      name, label: tool.name, description: tool.description ?? tool.name,
      parameters: jsonSchemaToTypebox(tool.inputSchema),
      loadMode: ["orchestrator_capabilities", "delegate_task", "task_status"].includes(tool.name) ? "essential" : "discoverable",
      approval: tool.annotations?.readOnlyHint === true ? "read" : "exec",
      async execute(toolCallId, params, signal, _onUpdate, ctx) {
        const result = await client.callTool(tool.name, (params ?? {}) as Record<string, unknown>, signal);
        const output = {
          content: mcpModelContent(result), details: { server: "t3-code", tool: tool.name },
          ...(isMcpToolError(result) ? { isError: true } : {}),
        };
        const sub = ctx?.agent?.kind === "sub";
        (ctx?.hasUI ? ctx.ui : hostUi)?.setWidget(TOOL_RESULT_WIDGET, [JSON.stringify({
          toolCallId, toolName: name, args: params ?? {}, result: output,
          ...(sub ? { agentId: ctx.agent.id } : {}),
        })]);
        return output;
      },
    });
  }
  omp.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt + "\\n\\n" + ORCHESTRATION_INSTRUCTIONS,
  }));
}
`;
