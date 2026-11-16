import type {
  ProviderApprovalDecision,
  ProviderApprovalFullAccessOverride,
  ProviderApprovalOption,
  RuntimeMode,
} from "@t3tools/contracts";

import { OMP_APPROVAL_FEEDBACK_REQUEST_PREFIX } from "./mcpExtensionSource.ts";

/**
 * A tool approval omp raised itself. Over RPC it is a `select` titled `Allow tool: <name>` with
 * detail rows (`Command:`, `Path:`, `File:`) and the options `Approve`, `Approve <subject> for
 * this session` and `Deny` (omp `tools/approval.ts`, `requestApproval`).
 */
export interface OmpApprovalPrompt {
  readonly toolName: string;
  readonly requestKind: "command" | "file-change";
  readonly title: string;
  /** What the user approves: the command line, or the file rows and content. */
  readonly detail: string;
  /** Why omp asks although the mode alone would not, e.g. a critical bash pattern. */
  readonly reason: string | undefined;
  readonly onceLabel: string;
  readonly sessionLabel: string | undefined;
  readonly denyLabel: string;
}

const APPROVAL_HEADER = "Allow tool: ";
const COMMAND_PREFIX = "Command: ";
const REASON_PREFIX = "Reason: ";
const ORIGIN_PREFIX = "Origin: ";
// Edit tools whose prompts name the files they change; other tools run code or devices.
const FILE_CHANGE_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true };

export function parseOmpApprovalPrompt(
  title: string,
  options: ReadonlyArray<string>,
): OmpApprovalPrompt | undefined {
  const [header, ...rows] = title.split("\n");
  if (header === undefined || !header.startsWith(APPROVAL_HEADER)) return undefined;
  const toolName = header.slice(APPROVAL_HEADER.length).trim();
  const onceLabel = options.find((option) => option === "Approve" || option === "Approve Once");
  const denyLabel = options.find((option) => option === "Deny");
  if (toolName.length === 0 || onceLabel === undefined || denyLabel === undefined) {
    return undefined;
  }
  const sessionLabel = options.find(
    (option) => option.startsWith("Approve ") && option.endsWith(" for this session"),
  );
  let reason: string | undefined;
  while (rows[0] !== undefined) {
    if (rows[0].startsWith(REASON_PREFIX)) reason = rows[0].slice(REASON_PREFIX.length).trim();
    else if (!rows[0].startsWith(ORIGIN_PREFIX)) break;
    rows.shift();
  }
  const body = rows.join("\n").trim();
  // A write to an `xd://` device runs that device, not a file change.
  const fileChange = FILE_CHANGE_TOOLS[toolName] === true && !/^Path: xd:\/\//m.test(body);
  const subagents = toolName === "task" ? ompTaskSubagentNames(body) : [];
  const detail =
    body.length === 0
      ? toolName
      : body.startsWith(COMMAND_PREFIX)
        ? body.slice(COMMAND_PREFIX.length)
        : subagents.length > 0
          ? `Subagents: ${subagents.join(", ")}\n\n${body}`
          : body;
  return {
    toolName,
    requestKind: fileChange ? "file-change" : "command",
    title:
      subagents.length > 0
        ? `Start subagent${subagents.length === 1 ? "" : "s"} ${subagents.join(", ")}`
        : `Allow ${toolName}`,
    detail,
    reason,
    onceLabel,
    sessionLabel,
    denyLabel,
  };
}

/** The names a `task` prompt lists (`Name: …` per spawned subagent). */
function ompTaskSubagentNames(body: string): ReadonlyArray<string> {
  return [...body.matchAll(/^Name: (.+)$/gm)].flatMap((match) => {
    const name = match[1]?.trim();
    return name === undefined || name.length === 0 ? [] : [name];
  });
}

/** The decisions the card offers, labelled as omp labels them. */
export function ompApprovalOptions(
  prompt: OmpApprovalPrompt,
): ReadonlyArray<ProviderApprovalOption> {
  return [
    { decision: "decline", label: prompt.denyLabel },
    ...(prompt.sessionLabel === undefined
      ? []
      : [{ decision: "acceptForSession" as const, label: prompt.sessionLabel }]),
    { decision: "accept", label: "Approve" },
  ];
}

/**
 * Why a full-access thread is asked at all. omp's yolo mode asks only for an explicit prompt
 * policy: the user's own `tools.approval.<tool>: prompt` carries no reason, while tool policies,
 * restricted folders and provider safety checks state one.
 */
export function ompApprovalFullAccessOverride(
  prompt: OmpApprovalPrompt,
  runtimeMode: RuntimeMode,
): ProviderApprovalFullAccessOverride | undefined {
  if (runtimeMode !== "full-access") return undefined;
  return prompt.reason === undefined && !prompt.detail.includes("Provider safety checks:")
    ? "ask_rule"
    : "provider_check";
}

/** The `select` value for T3's answer; undefined cancels the dialog, which omp treats as Deny. */
export function ompApprovalChoice(
  prompt: OmpApprovalPrompt,
  decision: ProviderApprovalDecision | undefined,
): string | undefined {
  switch (decision) {
    case "accept":
      return prompt.onceLabel;
    case "acceptForSession":
    case "acceptAlways":
      // omp's broadest RPC answer lasts for the session; nothing outlives it.
      return prompt.sessionLabel ?? prompt.onceLabel;
    case "decline":
      return prompt.denyLabel;
    default:
      return undefined;
  }
}

export interface OmpDeclinedApproval {
  readonly toolName: string;
  readonly feedback: string;
}

/**
 * Answers the extension's feedback request after a denial, consuming that tool's oldest pending
 * feedback; undefined when `title` is not such a request. omp emits these in the order the
 * denials were answered, so the oldest entry for the tool belongs to this request.
 */
export function takeOmpApprovalFeedback(
  declined: Array<OmpDeclinedApproval>,
  title: string,
): { readonly value: string } | { readonly cancelled: true } | undefined {
  if (!title.startsWith(OMP_APPROVAL_FEEDBACK_REQUEST_PREFIX)) return undefined;
  const toolName = title.slice(OMP_APPROVAL_FEEDBACK_REQUEST_PREFIX.length);
  const index = declined.findIndex((entry) => entry.toolName === toolName);
  if (index === -1) return { cancelled: true };
  const [entry] = declined.splice(index, 1);
  return entry === undefined ? { cancelled: true } : { value: entry.feedback };
}
