import {
  ompAskChoice,
  ompAskChoicePresses,
  ompAskChoiceQuestion,
  ompAskPressValue,
  ompAskQuestions,
  ompAskResponse,
  type OmpAskChoice,
  type OmpAskPress,
} from "./questions.ts";
import {
  ompFormCard,
  ompFormQuestion,
  ompFormSubmission,
  type OmpFormCard,
  type OmpFormEntry,
  type OmpFormProblem,
  type OmpFormValue,
} from "./form.ts";
import {
  isOmpSessionSettled,
  ompAgentEndYielded,
  ompDeliveredAsyncJobs,
  ompPromptFailure,
  ompForkMessageParent,
  ompSubagentJobFailures,
  ompSubagentTitle,
  ompToolFrameJobId,
  type OmpAsyncJobStatus,
} from "./lifecycle.ts";
import {
  isOmpPlanModeSelection,
  OMP_MODE_OPTION_ID,
  OMP_PLAN_MODE,
} from "./thinkingCapabilities.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeUtil from "node:util";
import * as Hash from "effect/Hash";
import { AgentScope } from "@t3tools/shared/AgentScope";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { readToolOutputImage } from "@t3tools/shared/toolOutput";
import * as Predicate from "effect/Predicate";
import {
  ProviderDriverKind,
  type ChatAttachment,
  type NodeId,
  type ThreadId,
  type ModelSelection,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2PlanStep,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderRetry,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2Subagent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type OrchestrationV2ProviderTurnTokenUsage,
} from "@t3tools/contracts";
import { OmpSettings } from "../settings.ts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { providerMessageTextWithAttachmentPaths } from "@t3tools/provider-core/server/attachmentPrompt";
import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { parseOmpCompactCommand, type OmpCompactCommand } from "./commands.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import {
  makeProviderFailure,
  makeProviderRetryTurnItem,
} from "@t3tools/provider-core/server/failure";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import {
  makeOmpRpcConnection,
  parseOmpModelSlug,
  ompRecordField as recordField,
  ompRecordNumber as recordNumber,
  ompRecordString as recordString,
  type OmpRpcConnection,
  type OmpRpcRecord,
} from "./rpc.ts";
import {
  buildOmpRpcLaunch,
  materializeOmpT3McpExtension,
  resolveOmpLaunchArgs,
} from "./mcpInjection.ts";
import {
  ompApprovalChoice,
  ompApprovalFullAccessOverride,
  ompApprovalOptions,
  parseOmpApprovalPrompt,
  takeOmpApprovalFeedback,
  type OmpApprovalPrompt,
  type OmpDeclinedApproval,
} from "./approvals.ts";
import {
  OMP_PLAN_APPROVE_OPTION,
  OMP_PLAN_REVIEW_PROMPT,
  OMP_T3_TOOL_RESULT_WIDGET,
  ompPlanReviewMarkdown,
} from "./mcpExtensionSource.ts";
import { ompTodoStepsFromToolEnd, sameOmpTodoSteps } from "./plans.ts";

export const OMP_PROVIDER = ProviderDriverKind.make("omp");
const OMP_DRIVER_KIND = OMP_PROVIDER;
const DEFAULT_OMP_SETTINGS = Schema.decodeSync(OmpSettings)({});

// Inherit Omp's configured defaultProvider/defaultModel without calling set_model.
const OMP_INHERIT_MODEL_SLUG = "default";
/** The question id of the plan review card's approve/refine decision. */
const OMP_PLAN_REVIEW_QUESTION_ID = "plan-review";

const STREAM_FLUSH_MS = 50;
const OMP_REQUEST_TIMEOUT_MS = 15_000;
const OMP_SESSION_TIMEOUT_MS = 60_000;
const MAX_EXTENSION_STATUSES = 32;
const MAX_EXTENSION_STATUS_KEY_LENGTH = 256;
const MAX_EXTENSION_STATUS_TEXT_LENGTH = 4096;
const OMP_UNSOLICITED_ACTIVITY_ERROR =
  "Omp started agent work outside an active T3 turn. The session was stopped to prevent invisible tool execution.";
const SETTLE_PROBE_MAX_ATTEMPTS = 3;
const SETTLE_PROBE_RETRY_DELAY = Duration.millis(100);

const OmpProviderCapabilitiesV2 = {
  runtimePolicy: { enforcement: "client-boundary" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    // omp's approval mode is a launch flag (`--approval-mode`), so a mode change restarts omp.
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    // omp runs subagents headless in yolo mode: the parent's `task` approval covers their calls,
    // and a call that still needs a prompt fails inside the subagent instead of reaching T3.
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    // Root-agent `todo` calls become T3 todo lists; plan-mode reviews show their plan as a plan card.
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: true,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: true,
    // CommandPolicy requires a snapshot for rollback; rollbackThread returns the updated provider thread.
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface OmpAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: OmpSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly continuationRequests?: {
    readonly offer: (
      request: ProviderContinuationRequests.ProviderContinuationRequest,
    ) => Effect.Effect<void>;
  };
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : "";
  }
  return content
    .map((block) => {
      if (recordField(block, "type") === "text") return recordString(block, "text") ?? "";
      return "";
    })
    .join("");
}

const MAX_STRUCTURED_TOOL_OUTPUT_BYTES = 64 * 1024;

function isBoundedStructuredToolValue(value: unknown): boolean {
  let bytes = MAX_STRUCTURED_TOOL_OUTPUT_BYTES;
  let nodes = 4_096;
  const visit = (entry: unknown, depth: number): boolean => {
    if (depth > 32 || --nodes < 0 || bytes < 0) return false;
    if (Array.isArray(entry)) {
      bytes -= 2 + entry.length;
      return entry.every((item) => visit(item, depth + 1));
    }
    if (Predicate.isObject(entry)) {
      bytes -= 2;
      for (const key in entry) {
        if (!Object.hasOwn(entry, key)) continue;
        if (key.length > bytes) return false;
        bytes -= Buffer.byteLength(JSON.stringify(key), "utf8") + 2;
        if (!visit(entry[key], depth + 1)) return false;
      }
      return bytes >= 0;
    }
    if (typeof entry === "string" && entry.length > bytes) return false;
    bytes -= Buffer.byteLength(JSON.stringify(entry) ?? "null", "utf8");
    return bytes >= 0;
  };
  return visit(value, 0);
}

/**
 * Where a resumed native session is copied before T3 writes to it. omp locks a session as
 * `.<name>.lock.os` beside it, so the name must stay well under NAME_MAX (255 bytes): the
 * source path is hashed rather than embedded, or omp silently stops persisting the session.
 */
export function ompResumeCopyPath(sessionDir: string, threadId: string, sourceFile: string) {
  const source = (Hash.string(sourceFile) >>> 0).toString(16).padStart(8, "0");
  return `${sessionDir}/${encodeURIComponent(threadId)}-${source}.jsonl`;
}

/**
 * omp mounts tools beyond its prompt budget as `xd://<tool>` devices that the agent runs by
 * writing JSON arguments to them. Such a write is a call of that tool, not a file change, so it
 * is projected under the device's tool name (T3's html_render frame keys on it).
 */
export function ompDeviceToolCall(
  toolName: string,
  args: unknown,
): { readonly toolName: string; readonly args: unknown } {
  if (toolName !== "write") return { toolName, args };
  const device = /^xd:\/\/([^/?#\s]+)$/.exec(recordString(args, "path") ?? "")?.[1];
  if (device === undefined) return { toolName, args };
  const content = recordField(args, "content");
  if (typeof content !== "string") return { toolName: device, args: content ?? {} };
  try {
    return { toolName: device, args: JSON.parse(content) };
  } catch {
    return { toolName: device, args: content };
  }
}

export interface OmpReportedToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly result: unknown;
  /** The subagent that made the call; absent for the top-level session. */
  readonly agentId?: string;
}

/**
 * A T3 tool call the injected extension reported (`OMP_T3_TOOL_RESULT_WIDGET`). omp's RPC frames
 * show only the outermost call, so a T3 tool run from inside another tool (an eval cell's
 * `tool.write("xd://…")`) appears nowhere else, and a subagent's call can be reported before
 * omp's own frames for it.
 */
export function ompReportedToolCall(event: OmpRpcRecord): OmpReportedToolCall | undefined {
  if (
    event["type"] !== "extension_ui_request" ||
    event["method"] !== "setWidget" ||
    event["widgetKey"] !== OMP_T3_TOOL_RESULT_WIDGET
  ) {
    return undefined;
  }
  const lines = event["widgetLines"];
  const line = Array.isArray(lines) ? lines[0] : undefined;
  if (typeof line !== "string") return undefined;
  let report: unknown;
  try {
    report = JSON.parse(line);
  } catch {
    return undefined;
  }
  const toolCallId = recordString(report, "toolCallId");
  const toolName = recordString(report, "toolName");
  if (toolCallId === undefined || toolName === undefined) return undefined;
  const agentId = recordString(report, "agentId");
  return {
    toolCallId,
    toolName,
    args: recordField(report, "args") ?? {},
    result: recordField(report, "result"),
    ...(agentId === undefined ? {} : { agentId }),
  };
}

/**
 * The file an `edit`/`write` call changes. omp's default hashline `edit` takes no `path`: its
 * `input` opens with a `[path#tag]` header naming the file.
 */
export function ompEditedFileName(args: unknown): string | undefined {
  return (
    recordString(args, "path") ??
    recordString(args, "file_path") ??
    /^\[([^\]\n]+?)#[0-9A-Za-z]+\]/.exec(recordString(args, "input") ?? "")?.[1]
  );
}

function ompToolOutput(result: unknown, toolName: string): unknown {
  const rawContent = recordField(result, "content");
  const content = Array.isArray(rawContent)
    ? rawContent
    : typeof rawContent === "string"
      ? [{ type: "text", text: rawContent }]
      : [];
  let structured = recordField(result, "structuredContent");
  const details = recordField(result, "details");
  const isMcpResult =
    toolName.startsWith("mcp__") &&
    recordString(details, "server") !== undefined &&
    recordString(details, "tool") !== undefined &&
    Array.isArray(recordField(structured, "content"));
  if (isMcpResult) {
    structured = recordField(structured, "structuredContent");
  }
  if (typeof structured === "string" && structured === contentText(content)) {
    structured = undefined;
  }
  // Native read mirrors image/note in structured output; drop only that mirror, retaining extension metadata.
  if (toolName === "read" && Predicate.isObject(structured)) {
    const image = readToolOutputImage(structured);
    const note =
      recordString(
        content.find((block) => recordField(block, "type") === "text"),
        "text",
      ) ?? "";
    if (
      image !== null &&
      Object.keys(structured).every((key) => ["type", "data", "mimeType", "note"].includes(key)) &&
      recordString(structured, "note") === note &&
      content.some((block) => {
        const match = readToolOutputImage(block);
        return match !== null && match.mimeType === image.mimeType && match.data === image.data;
      })
    ) {
      structured = undefined;
    }
  }
  if (structured !== undefined && !isBoundedStructuredToolValue(structured)) {
    return {
      content: [
        ...content,
        {
          type: "text",
          text: "Structured output omitted because it exceeds the stored result limit.",
        },
      ],
    };
  }
  if (
    !isMcpResult &&
    structured === undefined &&
    content.every((block) => recordField(block, "type") === "text")
  ) {
    const text = contentText(content);
    return text.length > 0 ? text : undefined;
  }
  return {
    content,
    ...(structured === undefined ? {} : { structuredContent: structured }),
  };
}

function providerRef(
  nativeId: string,
  strength: "strong" | "weak" = "strong",
): OrchestrationV2ProviderRef {
  return { driver: OMP_PROVIDER, nativeId, strength };
}

const OMP_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

interface OmpStreamItemState {
  readonly nativeItemId: string;
  readonly kind: "assistant_message" | "reasoning";
  text: string;
  completed: boolean;
  flushScheduled: boolean;
  readonly startedAt: DateTime.Utc;
}

type OmpCompactionStatus = "running" | "completed" | "failed" | "cancelled";

interface OmpCompactionState {
  readonly nativeItemId: string;
  readonly startedAt: DateTime.Utc;
}

interface OmpProviderRetryState {
  readonly retry: OrchestrationV2ProviderRetry;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly startedAt: DateTime.Utc;
  readonly itemOrdinal: number;
}

function compactionTitle(status: OmpCompactionStatus): string {
  switch (status) {
    case "running":
      return "Compacting context...";
    case "completed":
      return "Context compacted";
    case "failed":
      return "Context compaction failed";
    case "cancelled":
      return "Context compaction stopped";
  }
}

/**
 * Omp keeps reporting a call it moved to the background (async `task`, an
 * auto-backgrounded `bash`) after its `tool_execution_end`; the job's settled
 * `tool_execution_update` is what ends it.
 */
type OmpToolPhase = "running" | "background" | "settled";

/** Tool calls of one transcript: a parent turn's or one subagent's. */
interface OmpToolCalls {
  readonly args: Map<string, unknown>;
  readonly startedAt: Map<string, DateTime.Utc>;
  readonly phase: Map<string, OmpToolPhase>;
  /** Latest frame of each unsettled call, replayed to settle it when its transcript ends. */
  readonly open: Map<string, OmpRpcRecord>;
  /** Output bytes of each running shell call already streamed as deltas. */
  readonly outputBytes: Map<string, number>;
}

const makeOmpToolCalls = (): OmpToolCalls => ({
  args: new Map(),
  startedAt: new Map(),
  phase: new Map(),
  open: new Map(),
  outputBytes: new Map(),
});

type OmpItemBase = Pick<
  Extract<OrchestrationV2TurnItem, { readonly type: "dynamic_tool" }>,
  | "id"
  | "threadId"
  | "runId"
  | "nodeId"
  | "providerThreadId"
  | "providerTurnId"
  | "nativeItemRef"
  | "parentItemId"
  | "ordinal"
  | "startedAt"
  | "updatedAt"
>;

/** Where a transcript's tool calls are projected: the parent turn or a subagent's child thread. */
interface OmpToolTarget {
  readonly calls: OmpToolCalls;
  readonly interrupted: boolean;
  readonly itemFields: (
    nativeItemId: string,
    startedAt: DateTime.Utc,
    updatedAt: DateTime.Utc,
    parentNativeItemId?: string,
  ) => OmpItemBase;
  readonly emitNode: (
    nativeItemId: string,
    status: OrchestrationV2ExecutionNode["status"],
    startedAt: DateTime.Utc,
    completedAt: DateTime.Utc | null,
    parentNativeItemId?: string,
  ) => Effect.Effect<void>;
}

function ompSubagentStatus(status: string | undefined): OrchestrationV2Subagent["status"] | null {
  switch (status) {
    case "started":
    case "pending":
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "aborted":
      return "interrupted";
    default:
      return null;
  }
}

const isTerminalSubagentStatus = (status: OrchestrationV2Subagent["status"]): boolean =>
  status === "completed" ||
  status === "failed" ||
  status === "interrupted" ||
  status === "cancelled";

/** One omp subagent, keyed by its native id (`FamousBoar`) for the session's lifetime. */
interface OmpSubagentState {
  readonly nativeId: string;
  readonly nativeTaskId: string;
  /** The turn that first reported the subagent; its row and run stay there. */
  readonly owner: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly ownerProviderTurnId: OrchestrationV2ProviderTurn["id"];
  readonly nodeId: NodeId;
  readonly turnItemOrdinal: number;
  readonly childThreadId: ThreadId;
  readonly childRootNodeId: NodeId;
  readonly startedAt: DateTime.Utc;
  parentToolCallId: string | null;
  description: string | null;
  prompt: string;
  model: string | null;
  modelIdentity: string | null;
  progress: string | null;
  recentOutput: string | null;
  lastAssistantText: string | null;
  /** Why the subagent failed or stopped, from its own last message or its job's report. */
  error: string | null;
  status: OrchestrationV2Subagent["status"];
  completedAt: DateTime.Utc | null;
  childCreated: boolean;
  promptSeeded: boolean;
  userMessages: number;
  messageOrdinal: number;
  readonly childOrdinals: Map<string, number>;
  nextChildOrdinal: number;
  readonly tools: OmpToolCalls;
  readonly streamItems: Map<string, OmpStreamItemState>;
  lastEmitted: ReadonlyArray<unknown>;
}

interface ActiveOmpTurn {
  readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly startedAt: DateTime.Utc;
  readonly itemOrdinals: Map<string, number>;
  nextItemOrdinal: number;
  messageOrdinal: number;
  readonly streamItems: Map<string, OmpStreamItemState>;
  readonly tools: OmpToolCalls;
  interrupted: boolean;
  nativeAborted: boolean;
  sawAgentActivity: boolean;
  adoptedWake: boolean;
  /** Started for an omp-started run; there is no prompt, so its agent's yield ends it. */
  readonly continuation: boolean;
  /** Admitted prompts whose `prompt_result` has not arrived; the turn ends only at zero. */
  admittedPrompts: number;
  readonly promptMayBeCommandOnly: boolean;
  latestCompactionAfterTokens: number | null;
  lastLiveUsedTokens: number | null;
  settleProbeGeneration: number;
  /** An extension may start compaction immediately after Omp emits session_settled. */
  settleWhenIdle: boolean;
  sawCompaction: boolean;
  manualCompactInFlight: boolean;
  activeCompaction: OmpCompactionState | null;
  activeProviderRetry: OmpProviderRetryState | null;
  failure: ReturnType<typeof makeProviderFailure> | null;
  rejectedPromptFailure: ReturnType<typeof makeProviderFailure> | null;
  stopTreeRefs?: OmpTurnTreeRefs | null;
}

interface OmpTurnTreeRefs {
  /** Omitted keeps the synthetic ref; null means the turn left nothing on the active branch. */
  readonly nativeTurnRef: OrchestrationV2ProviderRef | null | undefined;
  readonly leafId: string | null;
  readonly retainedNativeTurnIds: ReadonlyArray<string> | undefined;
}

interface PendingOmpPrompt {
  readonly nativeRequestId: string;
  readonly method: "select" | "confirm" | "input" | "editor" | "ask" | "form";
  readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
  readonly questionId: string;
  readonly approvalKey: string;
  readonly expiresAt: number | null;
  expirationFiber: Fiber.Fiber<void> | null;
  runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: OrchestrationV2TurnItem;
  /** The plan card shown for a plan-mode review dialog; the answer settles it. */
  readonly proposedPlan?: OmpPlanCard;
  /** Set for omp's own tool approvals, whose answer is one of the dialog's labels. */
  readonly approval?: OmpApprovalPrompt;
  /** A choice of omp's `ask` tool, answered by one or more dialog presses. */
  readonly askChoice?: OmpAskChoice;
  /** omp's `form` dialog (the `ask` tool), asked as one card; see {@link OmpFormPrompt}. */
  readonly form?: OmpFormPrompt;
}

/**
 * One round of an omp `form` dialog. omp answers a form once, so answers the form would reject
 * are not sent: the fields they answered are asked again in a new card on the same dialog, and
 * the answers it accepted are kept for the final `data`.
 */
interface OmpFormPrompt {
  readonly event: OmpRpcRecord;
  readonly card: OmpFormCard;
  readonly entries: ReadonlyArray<OmpFormEntry>;
  readonly accepted: ReadonlyMap<string, OmpFormValue | undefined>;
}

interface OmpFormRetry {
  readonly card: OmpFormCard;
  readonly problems: ReadonlyArray<OmpFormProblem>;
  readonly accepted: ReadonlyMap<string, OmpFormValue | undefined>;
  readonly expiresAt: number | null;
}

interface OmpPlanCard {
  readonly turn: ActiveOmpTurn;
  readonly nativeItemId: string;
  readonly startedAt: DateTime.Utc;
  readonly plan: OrchestrationV2PlanArtifact;
}

// Native prompt errors are retained until the compaction releases queued input.
const OMP_COMPACTING_PROMPT_REJECTION = "Cannot submit a prompt while compaction is in progress";

interface OmpPromptSend {
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly kind: "turn_start" | "steer";
  readonly record: OmpRpcRecord;
}

interface OmpThreadState {
  providerThread: OrchestrationV2ProviderThread;
  activeTurn: ActiveOmpTurn | null;
}

interface OmpWake {
  readonly state: OmpThreadState;
  readonly events: Array<OmpRpcRecord>;
}

export const makeOmpAdapterV2 = Effect.fn("makeOmpAdapterV2")(function* (
  options: OmpAdapterV2Options,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const agentScope = yield* AgentScope;
  const fileSystem = yield* FileSystem.FileSystem;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const host = yield* ProviderHost.ProviderHost;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const { continuationRequests } = options;

  const protocolError = (detail: string, payload?: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: OMP_PROVIDER,
      detail,
      ...(payload === undefined ? {} : { payload }),
    });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: OMP_PROVIDER,
    getCapabilities: Effect.fn("OmpAdapter.getCapabilities")(function () {
      return Effect.succeed(OmpProviderCapabilitiesV2);
    }),
    planSelectionTransition: Effect.fn("OmpAdapter.planSelectionTransition")(function (input) {
      // omp enters plan mode only at launch, so changing Mode needs a new process.
      return Effect.succeed(
        isOmpPlanModeSelection(input.current) === isOmpPlanModeSelection(input.target)
          ? turnScopedSelectionTransition()
          : ({ type: "restart_session" } as const),
      );
    }),
    openSession: Effect.fn("OmpAdapterV2.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      const scope = yield* Effect.scope;
      const cwd = input.runtimePolicy.cwd ?? host.paths.cwd;
      const mcpSession = yield* mcpSessions.read(input.threadId);
      const provideCacheFs = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
        effect.pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: OMP_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        );
      // Always inject the extension even without MCP credentials: it relays approval feedback and plan reviews.
      const extensionPath = yield* provideCacheFs(
        materializeOmpT3McpExtension(host.paths.providerStatusCacheDir),
      );
      const resolvedLaunchArgs = resolveOmpLaunchArgs(options.settings.launchArgs);
      if (!resolvedLaunchArgs.ok) {
        return yield* protocolError(resolvedLaunchArgs.message);
      }
      const launch = buildOmpRpcLaunch({
        launchArgs: resolvedLaunchArgs.args,
        // PortScanner.AGENT_THREAD_ENV, as a literal because this package cannot reach apps/server.
        environment: { ...options.environment, T3CODE_THREAD_ID: input.threadId },
        mcpSession,
        extensionPath,
        runtimeMode: input.runtimePolicy.runtimeMode,
        ...(isOmpPlanModeSelection(input.modelSelection)
          ? {
              planExecutionModel:
                input.modelSelection.model === "default" ? "@default" : input.modelSelection.model,
            }
          : {}),
      });
      const scopedLaunch = yield* agentScope.wrap({
        command: options.settings.binaryPath || "omp",
        args: launch.args,
        name: "omp",
        threadId: input.threadId,
        env: launch.env,
      });
      // Finalizers run in reverse order: reap detached work after terminating Omp.
      const scopeUnit = scopedLaunch.unit;
      const stopScope =
        scopeUnit === undefined ? Effect.void : yield* Effect.cached(agentScope.stop(scopeUnit));
      yield* Effect.addFinalizer(() => stopScope);
      const connection: OmpRpcConnection = yield* makeOmpRpcConnection({
        command: scopedLaunch.command,
        requiredExtensionPath: extensionPath,
        args: scopedLaunch.args,
        cwd,
        env: launch.env,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver: OMP_PROVIDER,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      );
      // Detached children can keep stdout open after Omp exits.
      if (scopeUnit !== undefined) {
        yield* connection.exited.pipe(
          Effect.matchEffect({ onFailure: () => stopScope, onSuccess: () => stopScope }),
          Effect.forkIn(scope),
        );
      }
      const now = yield* DateTime.now;
      let sessionEntity: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: OMP_PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd,
        model: input.modelSelection.model,
        capabilities: OmpProviderCapabilitiesV2,
        extensionStatuses: [],
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const events = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error | Cause.Done
      >();
      const pendingPrompts = new Map<string, PendingOmpPrompt>();
      const sessionApprovals = new Set<string>();
      // Messages the user declined omp approvals with, until the extension asks for them.
      const declinedApprovalFeedback: Array<OmpDeclinedApproval> = [];
      // Dialog answers still owed for an `ask` choice the user answered on one card.
      const queuedAskPresses: Array<OmpAskPress> = [];
      // Omp can settle immediately after dialog response; serialize so terminal cannot overtake request resolution.
      const sessionEventPermit = yield* Semaphore.make(1);
      let threadState: OmpThreadState | null = null;
      let registrationAttempted = false;
      let lastNativeThreadId: string | null = null;
      let stopRequested = false;
      let unsolicitedActivityDetected = false;
      // One todo list item per turn, updated in place; a later turn's list supersedes an unfinished one.
      let latestTodo: OmpPlanCard | null = null;
      // Turn failures can leave Omp alive; pump termination retires the runtime.
      let runtimeRetired = false;
      let pendingWake: OmpWake | null = null;
      // Set when the agent yields with background work that can still wake it; cleared at session_settled.
      let nativeBackgroundPending = false;
      // Background calls that outlived their turn, by tool call id; their items stay running until the job ends.
      const retainedBackgroundCalls = new Map<
        string,
        { readonly turn: ActiveOmpTurn; readonly jobId: string | undefined }
      >();
      let extensionStatusReset: {
        previous: NonNullable<OrchestrationV2ProviderSession["extensionStatuses"]>;
        readonly touched: Set<string>;
        readonly ready: Deferred.Deferred<void, ProviderAdapter.ProviderAdapterProtocolError>;
      } | null = null;
      let rollbackBarrier: Deferred.Deferred<
        void,
        ProviderAdapter.ProviderAdapterProtocolError
      > | null = null;
      let closed = false;
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          closed = true;
          sessionEntity = { ...sessionEntity, extensionStatuses: [] };
          pendingWake = null;
          if (extensionStatusReset !== null)
            yield* Deferred.fail(
              extensionStatusReset.ready,
              protocolError("Omp session closed during status reset"),
            );
          if (rollbackBarrier !== null)
            yield* Deferred.fail(
              rollbackBarrier,
              protocolError("Omp session closed during rollback"),
            );
        }),
      );
      let appliedModel: string | null = null;
      let appliedThinking: string | null = null;
      let appliedSessionName: string | null = null;
      const outOfTurnExtensionErrors: Array<OmpRpcRecord> = [];
      let lastKnownLeaf: string | null = null;
      // Failed get_entries leaves an untrustworthy turn boundary; re-sync the cursor on next capture.
      let leafCursorStale = false;
      // Omp has no unset commands; capture initial defaults so Omp default can replay them.
      let baselineModel: { provider: string; modelId: string } | null = null;
      let baselineThinking: string | null = null;
      let contextWindow: number | null = null;
      const modelContextWindows = new Map<string, number>();
      let modelsDiscovered = false;
      // Prompt ACKs lack IDs; retain session send order and ownership so late ACKs cannot affect new turns.
      const pendingPromptResponses: Array<OmpPromptSend> = [];
      const pendingCompactResponses: Array<{
        readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
        readonly kind: "turn_start" | "steer";
      }> = [];
      // Omp rejects every prompt while it compacts, including compaction an
      // extension starts after the turn settled. Hold prompts until it ends.
      let nativeCompacting = false;
      const heldPrompts: Array<OmpPromptSend> = [];
      // Prompts sent before the pump observed compaction_start are rejected
      // after it; they precede every prompt held since.
      let rejectedHeldCount = 0;

      const sendPrompt = Effect.fnUntraced(function* (prompt: OmpPromptSend) {
        if (nativeCompacting) {
          heldPrompts.push(prompt);
          return;
        }
        yield* connection.send(prompt.record);
        pendingPromptResponses.push(prompt);
      });
      // A just-released prompt has not started its run yet, so a settle probe
      // racing it would see Omp idle. Its ack re-arms the probe instead.
      let releasedPromptTurnId: OrchestrationV2ProviderTurn["id"] | null = null;

      const compactRpcRecord = (command: OmpCompactCommand): OmpRpcRecord =>
        command.customInstructions === undefined
          ? { type: "compact" }
          : { type: "compact", customInstructions: command.customInstructions };

      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);

      const updateProviderSession =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (
          status: OrchestrationV2ProviderSession["status"],
          lastError: string | null = sessionEntity.lastError,
        ) {
          const updatedAt = yield* DateTime.now;
          sessionEntity = {
            ...sessionEntity,
            status,
            lastError,
            updatedAt,
            ...(status === "stopped" || runtimeRetired || unsolicitedActivityDetected
              ? { extensionStatuses: [] }
              : {}),
          };
          yield* emit({
            type: "provider_session.updated",
            driver: OMP_PROVIDER,
            providerSession: sessionEntity,
          });
        });

      // Frequent notifications share the event pump's tracing boundary and outlive individual turns.
      const updateExtensionStatus = Effect.fnUntraced(function* (event: OmpRpcRecord) {
        if (
          closed ||
          stopRequested ||
          runtimeRetired ||
          unsolicitedActivityDetected ||
          sessionEntity.status === "stopped"
        )
          return;
        const key = recordString(event, "statusKey");
        const rawText = recordField(event, "statusText");
        if (
          key === undefined ||
          key.trim().length === 0 ||
          key.length > MAX_EXTENSION_STATUS_KEY_LENGTH ||
          (rawText !== undefined && typeof rawText !== "string")
        )
          return;
        const text =
          typeof rawText === "string"
            ? NodeUtil.stripVTControlCharacters(
                rawText.slice(0, MAX_EXTENSION_STATUS_TEXT_LENGTH * 4),
              )
                .replaceAll(/\p{Cc}/gu, " ")
                .trim()
                .slice(0, MAX_EXTENSION_STATUS_TEXT_LENGTH)
            : "";
        const statuses = sessionEntity.extensionStatuses ?? [];
        if (extensionStatusReset?.previous.some((status) => status.key === key)) {
          extensionStatusReset.touched.add(key);
        }
        const index = statuses.findIndex((status) => status.key === key);
        if (
          index < 0
            ? text.length === 0 || statuses.length >= MAX_EXTENSION_STATUSES
            : statuses[index]?.text === text
        )
          return;
        sessionEntity = {
          ...sessionEntity,
          extensionStatuses:
            text.length === 0
              ? statuses.filter((status) => status.key !== key)
              : index < 0
                ? [...statuses, { key, text }]
                : statuses.map((status) => (status.key === key ? { key, text } : status)),
        };
        yield* updateProviderSession(sessionEntity.status);
      });

      const clearExtensionStatuses = Effect.fn("OmpAdapter.clearExtensionStatuses")(function* () {
        if (sessionEntity.extensionStatuses?.length === 0) return;
        sessionEntity = { ...sessionEntity, extensionStatuses: [] };
        yield* updateProviderSession(sessionEntity.status);
      });

      const updateProviderThread =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (
          state: OmpThreadState,
          patch: Partial<OrchestrationV2ProviderThread>,
          retainedNativeTurnIds?: ReadonlyArray<string>,
        ) {
          const updatedAt = yield* DateTime.now;
          state.providerThread = { ...state.providerThread, ...patch, updatedAt };
          yield* emit({
            type: "provider_thread.updated",
            driver: OMP_PROVIDER,
            providerThread: state.providerThread,
            ...(retainedNativeTurnIds === undefined ? {} : { retainedNativeTurnIds }),
          });
        });

      const itemOrdinal = (turn: ActiveOmpTurn, nativeItemId: string): number => {
        const existing = turn.itemOrdinals.get(nativeItemId);
        if (existing !== undefined) return existing;
        const ordinal = turn.nextItemOrdinal++;
        turn.itemOrdinals.set(nativeItemId, ordinal);
        return ordinal;
      };

      const request = (record: OmpRpcRecord, timeoutMs = OMP_REQUEST_TIMEOUT_MS) =>
        connection.request(record, timeoutMs);

      const nonNegativeInteger = (input: unknown, key: string): number | undefined => {
        const value = recordNumber(input, key);
        return value === undefined ? undefined : Math.max(0, Math.trunc(value));
      };

      const rememberModelContextWindow = (model: unknown): number | null => {
        const provider = recordString(model, "provider");
        const id = recordString(model, "id");
        const capacity = nonNegativeInteger(model, "contextWindow");
        if (provider !== undefined && id !== undefined && capacity !== undefined && capacity > 0) {
          modelContextWindows.set(`${provider}/${id}`, capacity);
          return capacity;
        }
        return null;
      };

      const lifecycleRequest = Effect.fn("OmpAdapter.lifecycleRequest")(
        function* (record: OmpRpcRecord) {
          if (extensionStatusReset !== null)
            return yield* protocolError("A Omp session lifecycle request is already pending");
          const reset = {
            previous: sessionEntity.extensionStatuses ?? [],
            touched: new Set<string>(),
            ready: yield* Deferred.make<void, ProviderAdapter.ProviderAdapterProtocolError>(),
          };
          extensionStatusReset = reset;
          return yield* Effect.gen(function* () {
            // RPC responses bypass the pump. Reset after all earlier native notifications.
            if (
              !(yield* Queue.offer(connection.events, { type: "t3.extension_status_reset", reset }))
            )
              return yield* protocolError("Omp transport closed during status reset");
            yield* Deferred.await(reset.ready);
            const result = yield* request(record, OMP_SESSION_TIMEOUT_MS);
            if (recordField(result, "cancelled") === true) {
              yield* sessionEventPermit.withPermits(1)(
                Effect.gen(function* () {
                  if (closed || stopRequested) return;
                  const current = sessionEntity.extensionStatuses ?? [];
                  // A veto keeps the old session. Preserve updates and clears from its lifecycle hooks.
                  const restored = reset.previous.flatMap((status) => {
                    if (!reset.touched.has(status.key)) return [status];
                    const updated = current.find((candidate) => candidate.key === status.key);
                    return updated === undefined ? [] : [updated];
                  });
                  restored.push(
                    ...current.filter(
                      (status) => !reset.previous.some((previous) => previous.key === status.key),
                    ),
                  );
                  const statuses = restored.slice(0, MAX_EXTENSION_STATUSES);
                  if (
                    statuses.length === current.length &&
                    statuses.every(
                      (status, index) =>
                        status.key === current[index]?.key && status.text === current[index]?.text,
                    )
                  )
                    return;
                  sessionEntity = { ...sessionEntity, extensionStatuses: statuses };
                  yield* updateProviderSession(sessionEntity.status);
                }),
              );
            }
            return result;
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (extensionStatusReset === reset) extensionStatusReset = null;
              }),
            ),
          );
        },
        (effect, record) =>
          effect.pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Omp session lifecycle request failed", {
                providerSessionId: input.providerSessionId,
                operation: record["type"],
                errorTag: error._tag,
              }),
            ),
            // A failed lifecycle RPC can leave Omp's previous native session disposed.
            Effect.tapError((error) =>
              error._tag === "OmpRpcError" || error._tag === "OmpRpcTimeoutError"
                ? connection.terminate
                : Effect.void,
            ),
            Effect.onInterrupt(() => connection.terminate),
          ),
      );

      const tokenUsageFromStats = (
        stats: unknown,
        fallbackUsedTokens: number | null,
        updatedAt: DateTime.Utc,
      ): OrchestrationV2ProviderTurnTokenUsage | undefined => {
        const contextUsage = recordField(stats, "contextUsage");
        const maxTokens = nonNegativeInteger(contextUsage, "contextWindow");
        const usedTokens =
          nonNegativeInteger(contextUsage, "tokens") ?? fallbackUsedTokens ?? undefined;
        if (usedTokens === undefined || maxTokens === undefined || maxTokens === 0)
          return undefined;

        const totals = recordField(stats, "tokens");
        const inputTokens = nonNegativeInteger(totals, "input");
        const cachedInputTokens = nonNegativeInteger(totals, "cacheRead");
        const outputTokens = nonNegativeInteger(totals, "output");
        return {
          usedTokens,
          maxTokens,
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
          updatedAt: DateTime.formatIso(updatedAt),
        };
      };

      const readTokenUsage = (fallbackUsedTokens: number | null, updatedAt: DateTime.Utc) =>
        Effect.all([
          request({ type: "get_session_stats" }, 2_000),
          request({ type: "get_state" }, 2_000),
        ]).pipe(
          Effect.map(([stats, state]) =>
            tokenUsageFromStats(
              {
                tokens: recordField(stats, "tokens"),
                contextUsage:
                  recordField(state, "contextUsage") ?? recordField(stats, "contextUsage"),
              },
              fallbackUsedTokens,
              updatedAt,
            ),
          ),
          Effect.orElseSucceed(() => undefined),
        );

      const reportLiveUsage =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (turn: ActiveOmpTurn, usage: unknown) {
          const usedTokens = nonNegativeInteger(usage, "totalTokens");
          if (
            usedTokens === undefined ||
            usedTokens === 0 ||
            usedTokens === turn.lastLiveUsedTokens ||
            contextWindow === null ||
            contextWindow === 0
          ) {
            return;
          }
          turn.lastLiveUsedTokens = usedTokens;
          const inputTokens = nonNegativeInteger(usage, "input");
          const cachedInputTokens = nonNegativeInteger(usage, "cacheRead");
          const outputTokens = nonNegativeInteger(usage, "output");
          const updatedAt = yield* DateTime.now;
          yield* emit({
            type: "provider_turn.updated",
            driver: OMP_PROVIDER,
            threadId: turn.turnInput.threadId,
            providerTurn: {
              ...turn.providerTurn,
              tokenUsage: {
                usedTokens,
                maxTokens: contextWindow,
                ...(inputTokens === undefined ? {} : { inputTokens }),
                ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
                ...(outputTokens === undefined ? {} : { outputTokens }),
                updatedAt: DateTime.formatIso(updatedAt),
              },
            },
          });
        });

      const baseItemFields = (
        turn: ActiveOmpTurn,
        nativeItemId: string,
        startedAt: DateTime.Utc,
        updatedAt: DateTime.Utc,
        parentNativeItemId?: string,
      ) => ({
        id: idAllocator.derive.turnItemFromProviderItem({
          driver: OMP_PROVIDER,
          nativeItemId,
        }),
        threadId: turn.turnInput.threadId,
        runId: turn.turnInput.runId,
        nodeId: idAllocator.derive.nodeFromProviderItem({
          driver: OMP_PROVIDER,
          nativeItemId,
        }),
        providerThreadId: turn.turnInput.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: providerRef(nativeItemId),
        parentItemId:
          parentNativeItemId === undefined
            ? null
            : idAllocator.derive.turnItemFromProviderItem({
                driver: OMP_PROVIDER,
                nativeItemId: parentNativeItemId,
              }),
        ordinal: itemOrdinal(turn, nativeItemId),
        startedAt,
        updatedAt,
      });

      const emitItemNode = (
        turn: ActiveOmpTurn,
        nativeItemId: string,
        kind: OrchestrationV2ExecutionNode["kind"],
        status: OrchestrationV2ExecutionNode["status"],
        startedAt: DateTime.Utc,
        completedAt: DateTime.Utc | null,
        parentNativeItemId?: string,
      ) =>
        emit({
          type: "node.updated",
          driver: OMP_PROVIDER,
          node: {
            id: idAllocator.derive.nodeFromProviderItem({
              driver: OMP_PROVIDER,
              nativeItemId,
            }),
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            parentNodeId:
              parentNativeItemId === undefined
                ? turn.turnInput.rootNodeId
                : idAllocator.derive.nodeFromProviderItem({
                    driver: OMP_PROVIDER,
                    nativeItemId: parentNativeItemId,
                  }),
            rootNodeId: turn.turnInput.rootNodeId,
            kind,
            status,
            countsForRun: false,
            providerThreadId: turn.turnInput.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: providerRef(nativeItemId),
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt,
            completedAt,
          },
        });

      // The node, plan and turn item the Claude adapter emits for its plan cards and todo lists. The
      // item is complete once shown; the plan's own status says whether the work is still open.
      const emitPlanCard = Effect.fnUntraced(function* (card: OmpPlanCard) {
        const updatedAt = yield* DateTime.now;
        const { turn, nativeItemId, startedAt, plan } = card;
        yield* emitItemNode(
          turn,
          nativeItemId,
          plan.kind === "todo_list" ? "todo_list" : "plan",
          "completed",
          startedAt,
          updatedAt,
        );
        yield* emit({ type: "plan.updated", driver: OMP_PROVIDER, plan });
        const fields = {
          ...baseItemFields(turn, nativeItemId, startedAt, updatedAt),
          status: "completed" as const,
          title: null,
          completedAt: updatedAt,
        };
        yield* emit({
          type: "turn_item.updated",
          driver: OMP_PROVIDER,
          turnItem:
            plan.kind === "todo_list"
              ? { ...fields, type: "todo_list", planId: plan.id, steps: plan.steps }
              : {
                  ...fields,
                  type: "proposed_plan",
                  planId: plan.id,
                  markdown: plan.markdown,
                  streaming: false,
                },
        });
      });

      const settlePlan = (plan: OrchestrationV2PlanArtifact, status: "completed" | "superseded") =>
        emit({ type: "plan.updated", driver: OMP_PROVIDER, plan: { ...plan, status } });

      const showProposedPlan = Effect.fnUntraced(function* (
        turn: ActiveOmpTurn,
        nativeRequestId: string,
        markdown: string,
      ) {
        const nativeItemId = `proposed-plan:${nativeRequestId}`;
        const card: OmpPlanCard = {
          turn,
          nativeItemId,
          startedAt: yield* DateTime.now,
          plan: {
            id: yield* idAllocator.allocate.plan({
              threadId: turn.turnInput.threadId,
              runId: turn.turnInput.runId,
              driver: OMP_PROVIDER,
            }),
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            nodeId: idAllocator.derive.nodeFromProviderItem({ driver: OMP_PROVIDER, nativeItemId }),
            status: "active",
            kind: "proposed_plan",
            markdown,
          },
        };
        yield* emitPlanCard(card);
        return card;
      });

      const projectTodoList = Effect.fnUntraced(function* (
        turn: ActiveOmpTurn,
        steps: ReadonlyArray<OrchestrationV2PlanStep>,
      ) {
        // omp keeps one todo list per session; each turn shows it as its own item, as Claude does.
        if (latestTodo !== null && latestTodo.turn !== turn) {
          if (latestTodo.plan.status === "active") yield* settlePlan(latestTodo.plan, "superseded");
          latestTodo = null;
        }
        const previous = latestTodo;
        if (previous?.plan.kind === "todo_list" && sameOmpTodoSteps(previous.plan.steps, steps)) {
          return;
        }
        if (steps.length === 0) {
          // The agent cleared its list: nothing is left to track.
          if (previous !== null && previous.plan.status === "active") {
            yield* settlePlan(previous.plan, "superseded");
          }
          latestTodo = null;
          return;
        }
        const nativeItemId = previous?.nativeItemId ?? `todo:${turn.providerTurn.id}`;
        const card: OmpPlanCard = {
          turn,
          nativeItemId,
          startedAt: previous?.startedAt ?? (yield* DateTime.now),
          plan: {
            id:
              previous?.plan.id ??
              (yield* idAllocator.allocate.plan({
                threadId: turn.turnInput.threadId,
                runId: turn.turnInput.runId,
                driver: OMP_PROVIDER,
              })),
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            nodeId: idAllocator.derive.nodeFromProviderItem({ driver: OMP_PROVIDER, nativeItemId }),
            status: steps.every((step) => step.status === "completed") ? "completed" : "active",
            kind: "todo_list",
            steps,
          },
        };
        latestTodo = card;
        yield* emitPlanCard(card);
      });

      const emitProviderRetry = Effect.fnUntraced(function* (
        turn: ActiveOmpTurn,
        providerRetry: OmpProviderRetryState,
        status: "running" | "completed" | "failed" | "interrupted" | "cancelled",
        updatedAt: DateTime.Utc,
      ) {
        yield* emit({
          type: "turn_item.updated",
          driver: OMP_PROVIDER,
          turnItem: makeProviderRetryTurnItem({
            driver: OMP_PROVIDER,
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            nodeId: turn.turnInput.rootNodeId,
            providerThreadId: turn.turnInput.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            itemOrdinal: providerRetry.itemOrdinal,
            failure: providerRetry.failure,
            retry: providerRetry.retry,
            status,
            startedAt: providerRetry.startedAt,
            updatedAt,
          }),
        });
      });

      const compactionNativeItemId = (turn: ActiveOmpTurn): string =>
        `compaction:${turn.providerTurn.id}:${turn.nextItemOrdinal}`;

      const emitCompaction = Effect.fnUntraced(function* (
        turn: ActiveOmpTurn,
        compaction: OmpCompactionState,
        status: OmpCompactionStatus,
        details: {
          readonly summary?: string;
          readonly beforeTokenCount?: number;
          readonly afterTokenCount?: number;
        } = {},
      ) {
        const emittedAt = yield* DateTime.now;
        const completedAt = status === "running" ? null : emittedAt;
        yield* emitItemNode(
          turn,
          compaction.nativeItemId,
          "system",
          status,
          compaction.startedAt,
          completedAt,
        );
        yield* emit({
          type: "turn_item.updated",
          driver: OMP_PROVIDER,
          turnItem: {
            ...baseItemFields(turn, compaction.nativeItemId, compaction.startedAt, emittedAt),
            status,
            title: compactionTitle(status),
            completedAt,
            type: "compaction",
            driver: OMP_PROVIDER,
            ...details,
          },
        });
      });

      const emitStreamItem =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (
          turn: ActiveOmpTurn,
          item: OmpStreamItemState,
          streaming: boolean,
        ) {
          const emittedAt = yield* DateTime.now;
          const base = baseItemFields(turn, item.nativeItemId, item.startedAt, emittedAt);
          yield* emitItemNode(
            turn,
            item.nativeItemId,
            item.kind,
            streaming ? "running" : "completed",
            item.startedAt,
            streaming ? null : emittedAt,
          );
          if (item.kind === "assistant_message") {
            const messageId = idAllocator.derive.messageFromProviderItem({
              driver: OMP_PROVIDER,
              nativeItemId: item.nativeItemId,
            });
            yield* emit({
              type: "turn_item.updated",
              driver: OMP_PROVIDER,
              turnItem: {
                ...base,
                status: streaming ? "running" : "completed",
                title: null,
                completedAt: streaming ? null : emittedAt,
                type: "assistant_message",
                messageId,
                text: item.text,
                streaming,
              },
            });
            yield* emit({
              type: "message.updated",
              driver: OMP_PROVIDER,
              message: {
                id: messageId,
                threadId: turn.turnInput.threadId,
                runId: turn.turnInput.runId,
                nodeId: idAllocator.derive.nodeFromProviderItem({
                  driver: OMP_PROVIDER,
                  nativeItemId: item.nativeItemId,
                }),
                role: "assistant",
                text: item.text,
                attachments: [],
                streaming,
                createdBy: "agent",
                creationSource: "provider",
                createdAt: item.startedAt,
                updatedAt: emittedAt,
              },
            });
            return;
          }
          yield* emit({
            type: "turn_item.updated",
            driver: OMP_PROVIDER,
            turnItem: {
              ...base,
              status: streaming ? "running" : "completed",
              title: null,
              completedAt: streaming ? null : emittedAt,
              type: "reasoning",
              text: item.text,
              streaming,
            },
          });
        });

      const scheduleStreamFlush =
        /* Provider events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (turn: ActiveOmpTurn, item: OmpStreamItemState) {
          if (item.flushScheduled || item.completed) return;
          item.flushScheduled = true;
          yield* Effect.sleep(Duration.millis(STREAM_FLUSH_MS)).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                item.flushScheduled = false;
                return item.completed ? Effect.void : emitStreamItem(turn, item, true);
              }),
            ),
            Effect.forkIn(scope),
          );
        });

      const streamItemFor = Effect.fnUntraced(function* (
        turn: ActiveOmpTurn,
        kind: OmpStreamItemState["kind"],
        contentIndex: number,
      ) {
        const nativeItemId = `${turn.providerTurn.id}:m${turn.messageOrdinal}:c${contentIndex}`;
        const existing = turn.streamItems.get(nativeItemId);
        if (existing !== undefined) return existing;
        const startedAt = yield* DateTime.now;
        const item: OmpStreamItemState = {
          nativeItemId,
          kind,
          text: "",
          completed: false,
          flushScheduled: false,
          startedAt,
        };
        turn.streamItems.set(nativeItemId, item);
        itemOrdinal(turn, nativeItemId);
        return item;
      });

      const completeStreamItem = (turn: ActiveOmpTurn, item: OmpStreamItemState, text?: string) =>
        Effect.suspend(() => {
          if (item.completed) return Effect.void;
          item.completed = true;
          if (text !== undefined && text.length > 0) item.text = text;
          return item.text.length === 0 ? Effect.void : emitStreamItem(turn, item, false);
        });

      const completeOpenStreamItems = (turn: ActiveOmpTurn) =>
        Effect.forEach(
          Array.from(turn.streamItems.values()).filter((item) => !item.completed),
          (item) => completeStreamItem(turn, item),
          { discard: true },
        );

      const turnToolTarget = (
        turn: ActiveOmpTurn,
        interrupted = turn.interrupted,
      ): OmpToolTarget => ({
        calls: turn.tools,
        interrupted,
        itemFields: (nativeItemId, startedAt, updatedAt, parentNativeItemId) =>
          baseItemFields(turn, nativeItemId, startedAt, updatedAt, parentNativeItemId),
        emitNode: (nativeItemId, status, startedAt, completedAt, parentNativeItemId) =>
          emitItemNode(
            turn,
            nativeItemId,
            "tool_call",
            status,
            startedAt,
            completedAt,
            parentNativeItemId,
          ),
      });

      // Omp resends the whole output tail on every update; stored snapshots grow quadratically.
      const emitCommandOutputDelta = (
        calls: OmpToolCalls,
        item: Pick<OmpItemBase, "id" | "threadId">,
        toolCallId: string,
        result: unknown,
      ) =>
        Effect.suspend(() => {
          const text = contentText(recordField(result, "content"));
          const tail = Buffer.from(text, "utf8");
          const totalBytes =
            recordNumber(recordField(recordField(result, "details"), "truncation"), "totalBytes") ??
            tail.length;
          const previousBytes = calls.outputBytes.get(toolCallId) ?? 0;
          calls.outputBytes.set(toolCallId, totalBytes);
          if (totalBytes <= previousBytes) return Effect.void;
          let start = Math.max(0, tail.length - (totalBytes - previousBytes));
          while (start < tail.length && (tail[start]! & 0xc0) === 0x80) start++;
          const chunk = tail.subarray(start).toString("utf8");
          if (chunk.length === 0) return Effect.void;
          return emit({
            type: "command_output.delta",
            driver: OMP_PROVIDER,
            threadId: item.threadId,
            itemId: item.id,
            chunk,
          });
        });

      const emitToolItem = Effect.fnUntraced(function* (
        target: OmpToolTarget,
        event: OmpRpcRecord,
        phase: "start" | "update" | "end" | "settle",
      ) {
        const toolCallId = recordString(event, "toolCallId");
        const nativeToolName = recordString(event, "toolName") ?? "tool";
        // Omp tags every phase of a call made through ctx.executeTool, such as from a codemode script.
        const parentToolCallId = recordString(event, "parentToolCallId");
        if (toolCallId === undefined) return;
        const { calls } = target;
        const previous = calls.phase.get(toolCallId);
        if (phase === "start") {
          calls.args.set(toolCallId, event["args"]);
        }
        // A backgrounded call keeps streaming updates after it ended, and settled calls can still
        // see them; neither, nor a call this transcript never started, may reopen an item. A
        // subagent's T3 call can be reported (and settled) before omp's own start frame for it.
        if (
          ((phase === "update" || phase === "settle") &&
            (previous === undefined || previous === "settled")) ||
          (phase === "start" && previous === "settled")
        )
          return;
        const { toolName, args } = ompDeviceToolCall(
          nativeToolName,
          event["args"] ?? calls.args.get(toolCallId),
        );
        const emittedAt = yield* DateTime.now;
        const startedAt = calls.startedAt.get(toolCallId) ?? emittedAt;
        calls.startedAt.set(toolCallId, startedAt);
        const isError = event["isError"] === true;
        const resultRecord =
          phase === "end" ? event["result"] : (event["partialResult"] ?? event["result"]);
        const outputText = contentText(recordField(resultRecord, "content"));
        const jobState = recordString(
          recordField(recordField(resultRecord, "details"), "async"),
          "state",
        );
        const status: OrchestrationV2TurnItem["status"] =
          phase === "settle"
            ? target.interrupted
              ? "interrupted"
              : "completed"
            : phase === "end"
              ? isError
                ? target.interrupted
                  ? "interrupted"
                  : "failed"
                : jobState === "running"
                  ? "running"
                  : "completed"
              : // A job can settle before its call returns; tool_execution_end then owns the result.
                previous === "background" && jobState !== undefined && jobState !== "running"
                ? jobState === "completed"
                  ? "completed"
                  : jobState === "cancelled"
                    ? "cancelled"
                    : "failed"
                : "running";
        const completed = status !== "running";
        if (completed) {
          calls.phase.set(toolCallId, "settled");
          calls.open.delete(toolCallId);
        } else {
          calls.phase.set(
            toolCallId,
            phase === "end" || previous === "background" ? "background" : "running",
          );
          calls.open.set(toolCallId, event);
        }
        const base = target.itemFields(toolCallId, startedAt, emittedAt, parentToolCallId);
        // A running shell call's updates stream as live output; only its final state is stored.
        if (
          phase === "update" &&
          status === "running" &&
          (toolName === "bash" || toolName === "powershell")
        ) {
          yield* emitCommandOutputDelta(calls, base, toolCallId, resultRecord);
          return;
        }
        yield* target.emitNode(
          toolCallId,
          status,
          startedAt,
          completed ? emittedAt : null,
          parentToolCallId,
        );
        const shared = {
          ...base,
          status,
          completedAt: completed ? emittedAt : null,
        } as const;
        if (toolName === "bash" || toolName === "powershell") {
          const exitCode =
            recordNumber(recordField(resultRecord, "structuredContent"), "exit_code") ??
            recordNumber(recordField(resultRecord, "details"), "exitCode");
          yield* emit({
            type: "turn_item.updated",
            driver: OMP_PROVIDER,
            turnItem: {
              ...shared,
              title: toolName,
              type: "command_execution",
              input: recordString(args, "command") ?? "",
              ...(outputText.length > 0 ? { output: outputText } : {}),
              ...(exitCode === undefined ? {} : { exitCode }),
            },
          });
          return;
        }
        if (toolName === "edit" || toolName === "write") {
          const fileName = ompEditedFileName(args);
          if (fileName !== undefined) {
            const diffStr =
              recordString(recordField(resultRecord, "details"), "patch") ??
              (isError && outputText.trim().length > 0 ? outputText : undefined);
            const newStr = toolName === "write" ? recordString(args, "content") : undefined;
            yield* emit({
              type: "turn_item.updated",
              driver: OMP_PROVIDER,
              turnItem: {
                ...shared,
                title: toolName,
                type: "file_change",
                fileName,
                ...(diffStr === undefined ? {} : { diffStr }),
                ...(newStr === undefined ? {} : { newStr }),
              },
            });
            return;
          }
        }
        const output = ompToolOutput(resultRecord, toolName);
        yield* emit({
          type: "turn_item.updated",
          driver: OMP_PROVIDER,
          turnItem: {
            ...shared,
            title: toolName,
            type: "dynamic_tool",
            ...mcpToolPresentation({ toolName }),
            toolName,
            input: args ?? {},
            ...(output === undefined ? {} : { output }),
          },
        });
      });

      const settleOpenTools = (target: OmpToolTarget) =>
        Effect.forEach(
          Array.from(target.calls.open.values()),
          (event) => emitToolItem(target, event, "settle"),
          { discard: true },
        );

      // Detached subagents report after their turn settled and during omp-started runs, so their
      // state is session-scoped by native id and keeps the turn that first reported it: late
      // frames update that row and child thread, never whichever turn is active.
      const subagents = new Map<string, OmpSubagentState>();

      const subagentChildItemFields = (
        subagent: OmpSubagentState,
        nativeItemId: string,
        startedAt: DateTime.Utc,
        updatedAt: DateTime.Utc,
        parentNativeItemId?: string,
      ): OmpItemBase => {
        let ordinal = subagent.childOrdinals.get(nativeItemId);
        if (ordinal === undefined) {
          ordinal = subagent.nextChildOrdinal++;
          subagent.childOrdinals.set(nativeItemId, ordinal);
        }
        return {
          id: idAllocator.derive.turnItemFromProviderItem({ driver: OMP_PROVIDER, nativeItemId }),
          threadId: subagent.childThreadId,
          runId: null,
          nodeId: subagent.childRootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: providerRef(nativeItemId),
          parentItemId:
            parentNativeItemId === undefined
              ? null
              : idAllocator.derive.turnItemFromProviderItem({
                  driver: OMP_PROVIDER,
                  nativeItemId: parentNativeItemId,
                }),
          ordinal,
          startedAt,
          updatedAt,
        };
      };

      const subagentToolTarget = (subagent: OmpSubagentState): OmpToolTarget => ({
        calls: subagent.tools,
        // A call still open when its subagent fails or stops never finished.
        interrupted:
          subagent.status === "interrupted" ||
          subagent.status === "failed" ||
          subagent.status === "cancelled",
        itemFields: (toolCallId, startedAt, updatedAt, parentToolCallId) =>
          subagentChildItemFields(
            subagent,
            `${subagent.nativeTaskId}:tool:${toolCallId}`,
            startedAt,
            updatedAt,
            parentToolCallId === undefined
              ? undefined
              : `${subagent.nativeTaskId}:tool:${parentToolCallId}`,
          ),
        // Child items hang off the child thread's root node, as the ACP and Codex adapters project them.
        emitNode: () => Effect.void,
      });

      const emitSubagentStreamItem =
        /* Subagent events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (
          subagent: OmpSubagentState,
          item: OmpStreamItemState,
          streaming: boolean,
        ) {
          const emittedAt = yield* DateTime.now;
          const base = subagentChildItemFields(
            subagent,
            item.nativeItemId,
            item.startedAt,
            emittedAt,
          );
          const shared = {
            ...base,
            status: streaming ? "running" : "completed",
            title: null,
            completedAt: streaming ? null : emittedAt,
            text: item.text,
            streaming,
          } as const;
          if (item.kind === "reasoning") {
            yield* emit({
              type: "turn_item.updated",
              driver: OMP_PROVIDER,
              turnItem: { ...shared, type: "reasoning" },
            });
            return;
          }
          const messageId = idAllocator.derive.messageFromProviderItem({
            driver: OMP_PROVIDER,
            nativeItemId: item.nativeItemId,
          });
          yield* emit({
            type: "message.updated",
            driver: OMP_PROVIDER,
            message: {
              id: messageId,
              threadId: subagent.childThreadId,
              runId: null,
              nodeId: subagent.childRootNodeId,
              role: "assistant",
              text: item.text,
              attachments: [],
              streaming,
              createdBy: "agent",
              creationSource: "provider",
              createdAt: item.startedAt,
              updatedAt: emittedAt,
            },
          });
          yield* emit({
            type: "turn_item.updated",
            driver: OMP_PROVIDER,
            turnItem: { ...shared, type: "assistant_message", messageId },
          });
        });

      const scheduleSubagentStreamFlush =
        /* Subagent events include streaming deltas; avoid a span for each update. */
        Effect.fnUntraced(function* (subagent: OmpSubagentState, item: OmpStreamItemState) {
          if (item.flushScheduled || item.completed) return;
          item.flushScheduled = true;
          yield* Effect.sleep(Duration.millis(STREAM_FLUSH_MS)).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                item.flushScheduled = false;
                return item.completed || item.text.length === 0
                  ? Effect.void
                  : emitSubagentStreamItem(subagent, item, true);
              }),
            ),
            Effect.forkIn(scope),
          );
        });

      /** One item per content block of an assistant message, as the parent turn projects them. */
      const subagentStreamItemFor = Effect.fnUntraced(function* (
        subagent: OmpSubagentState,
        kind: OmpStreamItemState["kind"],
        contentIndex: number,
      ) {
        const nativeItemId = `${subagent.nativeTaskId}:m${subagent.messageOrdinal}:c${contentIndex}`;
        const existing = subagent.streamItems.get(nativeItemId);
        if (existing !== undefined) return existing;
        const item: OmpStreamItemState = {
          nativeItemId,
          kind,
          text: "",
          completed: false,
          flushScheduled: false,
          startedAt: yield* DateTime.now,
        };
        subagent.streamItems.set(nativeItemId, item);
        // Reserve the ordinal at the first delta so the block keeps its place before later tool calls.
        subagentChildItemFields(subagent, nativeItemId, item.startedAt, item.startedAt);
        return item;
      });

      const completeSubagentStreamItem = (
        subagent: OmpSubagentState,
        item: OmpStreamItemState,
        text?: string,
      ) =>
        Effect.suspend(() => {
          if (item.completed) return Effect.void;
          item.completed = true;
          if (text !== undefined && text.length > 0) item.text = text;
          return item.text.length === 0
            ? Effect.void
            : emitSubagentStreamItem(subagent, item, false);
        });

      const completeOpenSubagentStreamItems = (subagent: OmpSubagentState) =>
        Effect.forEach(
          Array.from(subagent.streamItems.values()).filter((item) => !item.completed),
          (item) => completeSubagentStreamItem(subagent, item),
          { discard: true },
        );

      const emitSubagentError = Effect.fnUntraced(function* (
        subagent: OmpSubagentState,
        nativeItemId: string,
        status: "failed" | "interrupted",
        message: string,
      ) {
        const now = yield* DateTime.now;
        yield* emit({
          type: "turn_item.updated",
          driver: OMP_PROVIDER,
          turnItem: {
            ...subagentChildItemFields(subagent, nativeItemId, now, now),
            status,
            title: status === "failed" ? "Provider error" : "Subagent stopped",
            completedAt: now,
            type: "error",
            failure: makeProviderFailure({
              message,
              class: status === "failed" ? "provider_error" : "unknown",
            }),
          },
        });
      });

      const emitSubagentChildRoot = (subagent: OmpSubagentState) =>
        emit({
          type: "node.updated",
          driver: OMP_PROVIDER,
          node: {
            id: subagent.childRootNodeId,
            threadId: subagent.childThreadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: subagent.childRootNodeId,
            kind: "root_turn",
            status: subagent.status,
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: providerRef(subagent.nativeTaskId),
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: subagent.startedAt,
            completedAt: subagent.completedAt,
          },
        });

      const emitSubagentUserMessage = Effect.fnUntraced(function* (
        subagent: OmpSubagentState,
        nativeItemId: string,
        text: string,
        ordinal: number,
      ) {
        const artifacts = makeSubagentConversationArtifacts({
          messageId: idAllocator.derive.messageFromProviderItem({
            driver: OMP_PROVIDER,
            nativeItemId,
          }),
          senderThreadId: subagent.owner.threadId,
          turnItemId: idAllocator.derive.turnItemFromProviderItem({
            driver: OMP_PROVIDER,
            nativeItemId,
          }),
          threadId: subagent.childThreadId,
          rootNodeId: subagent.childRootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: providerRef(nativeItemId),
          role: "user",
          text,
          ordinal,
          now: yield* DateTime.now,
        });
        yield* emit({ type: "message.updated", driver: OMP_PROVIDER, message: artifacts.message });
        yield* emit({
          type: "turn_item.updated",
          driver: OMP_PROVIDER,
          turnItem: artifacts.turnItem,
        });
      });

      const ensureSubagentChild = Effect.fnUntraced(function* (subagent: OmpSubagentState) {
        if (!subagent.childCreated) {
          subagent.childCreated = true;
          const { appThread, modelSelection } = subagent.owner;
          yield* emit({
            type: "app_thread.created",
            driver: OMP_PROVIDER,
            appThread: makeSubagentChildThread({
              parentThread: appThread,
              childThreadId: subagent.childThreadId,
              parentNodeId: subagent.nodeId,
              // No provider thread: omp cannot be prompted inside a subagent, so the child is read-only.
              activeProviderThreadId: null,
              providerInstanceId: options.instanceId,
              modelSelection: {
                instanceId: modelSelection.instanceId,
                model: subagent.modelIdentity ?? modelSelection.model,
              },
              title: subagentThreadTitle({
                parentTitle: appThread.title,
                title: ompSubagentTitle(subagent),
                prompt: subagent.prompt,
                ordinal: subagents.size,
              }),
              now: yield* DateTime.now,
              createdBy: "agent",
              creationSource: "provider",
            }),
          });
          // A subagent can fail before omp names its assignment, so its child appears already
          // ended; its root turn still runs first, as the subagent row did.
          if (isTerminalSubagentStatus(subagent.status)) {
            yield* emitSubagentChildRoot({ ...subagent, status: "running", completedAt: null });
          }
          yield* emitSubagentChildRoot(subagent);
        }
        if (!subagent.promptSeeded && subagent.prompt.length > 0) {
          subagent.promptSeeded = true;
          // Fixed below every projected item, which start at 101, so a late prompt still leads.
          yield* emitSubagentUserMessage(
            subagent,
            `${subagent.nativeTaskId}:prompt`,
            subagent.prompt,
            100,
          );
        }
      });

      const emitSubagentRow = Effect.fnUntraced(function* (subagent: OmpSubagentState) {
        const terminal = isTerminalSubagentStatus(subagent.status);
        // A failed or stopped subagent's error is its outcome; its last words may predate it.
        const result = !terminal
          ? null
          : subagent.status === "completed"
            ? (subagent.lastAssistantText ?? subagent.recentOutput)
            : (subagent.error ?? subagent.lastAssistantText ?? subagent.recentOutput);
        const title = ompSubagentTitle(subagent);
        const childThreadId = subagent.childCreated ? subagent.childThreadId : null;
        const progress = terminal ? null : subagent.progress;
        // Progress frames repeat unchanged fields for every subagent tool call.
        const emitted = [
          subagent.status,
          title,
          subagent.model,
          progress,
          result,
          subagent.prompt,
          childThreadId,
          subagent.parentToolCallId,
        ];
        if (emitted.every((value, index) => value === subagent.lastEmitted[index])) return;
        subagent.lastEmitted = emitted;
        const now = yield* DateTime.now;
        const { owner } = subagent;
        const parentNodeId =
          subagent.parentToolCallId === null
            ? owner.rootNodeId
            : idAllocator.derive.nodeFromProviderItem({
                driver: OMP_PROVIDER,
                nativeItemId: subagent.parentToolCallId,
              });
        const nativeTaskRef = providerRef(subagent.nativeTaskId);
        yield* emit({
          type: "node.updated",
          driver: OMP_PROVIDER,
          node: {
            id: subagent.nodeId,
            threadId: owner.threadId,
            runId: owner.runId,
            parentNodeId,
            rootNodeId: owner.rootNodeId,
            kind: "subagent",
            status: subagent.status,
            countsForRun: false,
            providerThreadId: owner.providerThread.id,
            providerTurnId: subagent.ownerProviderTurnId,
            nativeItemRef: nativeTaskRef,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: subagent.startedAt,
            completedAt: subagent.completedAt,
          },
        });
        if (subagent.childCreated) yield* emitSubagentChildRoot(subagent);
        yield* emit({
          type: "subagent.updated",
          driver: OMP_PROVIDER,
          subagent: {
            id: subagent.nodeId,
            threadId: owner.threadId,
            runId: owner.runId,
            parentNodeId,
            origin: "provider_native",
            createdBy: "agent",
            driver: OMP_PROVIDER,
            providerInstanceId: options.instanceId,
            providerThreadId: null,
            childThreadId,
            nativeTaskRef,
            prompt: subagent.prompt,
            title,
            model: subagent.model,
            status: subagent.status,
            ...(progress === null ? {} : { progress }),
            result,
            startedAt: subagent.startedAt,
            completedAt: subagent.completedAt,
            updatedAt: now,
          },
        });
        yield* emit({
          type: "turn_item.updated",
          driver: OMP_PROVIDER,
          turnItem: {
            id: idAllocator.derive.turnItemFromProviderItem({
              driver: OMP_PROVIDER,
              nativeItemId: subagent.nativeTaskId,
            }),
            threadId: owner.threadId,
            runId: owner.runId,
            nodeId: subagent.nodeId,
            providerThreadId: owner.providerThread.id,
            providerTurnId: subagent.ownerProviderTurnId,
            nativeItemRef: nativeTaskRef,
            parentItemId:
              subagent.parentToolCallId === null
                ? null
                : idAllocator.derive.turnItemFromProviderItem({
                    driver: OMP_PROVIDER,
                    nativeItemId: subagent.parentToolCallId,
                  }),
            ordinal: subagent.turnItemOrdinal,
            status: subagent.status,
            title,
            startedAt: subagent.startedAt,
            completedAt: subagent.completedAt,
            updatedAt: now,
            type: "subagent",
            subagentId: subagent.nodeId,
            origin: "provider_native",
            driver: OMP_PROVIDER,
            providerInstanceId: options.instanceId,
            childThreadId,
            prompt: subagent.prompt,
            ...(progress === null ? {} : { progress }),
            result,
          },
        });
      });

      const projectSubagentEvent = Effect.fnUntraced(function* (
        subagent: OmpSubagentState,
        event: unknown,
      ) {
        if (!Predicate.isObject(event)) return;
        const type = recordString(event, "type");
        if (type === "message_start") {
          if (recordString(event["message"], "role") === "assistant") subagent.messageOrdinal += 1;
          return;
        }
        if (type === "message_update") {
          const delta = event["assistantMessageEvent"];
          const deltaType = recordString(delta, "type");
          const contentIndex = recordNumber(delta, "contentIndex") ?? 0;
          if (deltaType === "text_delta" || deltaType === "thinking_delta") {
            yield* ensureSubagentChild(subagent);
            const item = yield* subagentStreamItemFor(
              subagent,
              deltaType === "text_delta" ? "assistant_message" : "reasoning",
              contentIndex,
            );
            item.text += recordString(delta, "delta") ?? "";
            yield* scheduleSubagentStreamFlush(subagent, item);
            return;
          }
          if (deltaType === "text_end" || deltaType === "thinking_end") {
            yield* ensureSubagentChild(subagent);
            const item = yield* subagentStreamItemFor(
              subagent,
              deltaType === "text_end" ? "assistant_message" : "reasoning",
              contentIndex,
            );
            yield* completeSubagentStreamItem(
              subagent,
              item,
              recordString(delta, "content") ?? recordString(delta, "thinking"),
            );
          }
          return;
        }
        if (type === "message_end") {
          const message = event["message"];
          const role = recordString(message, "role");
          const text = contentText(recordField(message, "content"));
          if (role === "user") {
            if (text.trim().length === 0) return;
            subagent.userMessages += 1;
            // The first user message is the assignment, already seeded from the progress frame.
            if (subagent.userMessages === 1) {
              if (subagent.prompt.length === 0) subagent.prompt = text;
              yield* ensureSubagentChild(subagent);
              return;
            }
            yield* ensureSubagentChild(subagent);
            const nativeItemId = `${subagent.nativeTaskId}:u${subagent.userMessages}`;
            yield* emitSubagentUserMessage(
              subagent,
              nativeItemId,
              text,
              subagentChildItemFields(
                subagent,
                nativeItemId,
                subagent.startedAt,
                subagent.startedAt,
              ).ordinal,
            );
            return;
          }
          if (role !== "assistant") return;
          yield* ensureSubagentChild(subagent);
          // Final blocks complete any block still streaming and stand in for blocks that never streamed.
          const content = recordField(message, "content");
          const blocks: ReadonlyArray<unknown> = Array.isArray(content) ? content : [];
          for (const [index, block] of blocks.entries()) {
            const blockType = recordString(block, "type");
            const blockText =
              blockType === "text"
                ? recordString(block, "text")
                : blockType === "thinking"
                  ? recordString(block, "thinking")
                  : undefined;
            if (blockText === undefined || blockText.trim().length === 0) continue;
            const item = yield* subagentStreamItemFor(
              subagent,
              blockType === "text" ? "assistant_message" : "reasoning",
              index,
            );
            yield* completeSubagentStreamItem(subagent, item, blockText);
          }
          yield* completeOpenSubagentStreamItems(subagent);
          const stopReason = recordString(message, "stopReason");
          if (stopReason === "error" || stopReason === "aborted") {
            const reported = recordString(message, "errorMessage")?.trim() ?? "";
            const error =
              reported.length > 0
                ? reported
                : stopReason === "error"
                  ? "Omp reported a model error."
                  : "The subagent was stopped.";
            subagent.error = error;
            yield* emitSubagentError(
              subagent,
              `${subagent.nativeTaskId}:m${subagent.messageOrdinal}:error`,
              stopReason === "error" ? "failed" : "interrupted",
              error,
            );
          }
          if (text.trim().length > 0) subagent.lastAssistantText = text;
          // A result can land after the terminal lifecycle frame.
          yield* emitSubagentRow(subagent);
          return;
        }
        if (
          type === "tool_execution_start" ||
          type === "tool_execution_update" ||
          type === "tool_execution_end"
        ) {
          yield* ensureSubagentChild(subagent);
          yield* emitToolItem(
            subagentToolTarget(subagent),
            event,
            type === "tool_execution_start"
              ? "start"
              : type === "tool_execution_end"
                ? "end"
                : "update",
          );
        }
      });

      const handleSubagentFrame = Effect.fnUntraced(function* (event: OmpRpcRecord) {
        const payload = recordField(event, "payload");
        const progress = recordField(payload, "progress");
        const id = recordString(payload, "id") ?? recordString(progress, "id");
        if (id === undefined) return;
        const parentToolCallId = recordString(payload, "parentToolCallId");
        let subagent = subagents.get(id);
        // Native names are only unique among live agents: a finished name started again by
        // another task call is a new subagent, while a resumed one keeps its row.
        const reused =
          subagent !== undefined &&
          event["type"] === "subagent_lifecycle" &&
          recordString(payload, "status") === "started" &&
          isTerminalSubagentStatus(subagent.status) &&
          parentToolCallId !== undefined &&
          subagent.parentToolCallId !== null &&
          parentToolCallId !== subagent.parentToolCallId;
        if (subagent === undefined || reused) {
          const turn = threadState?.activeTurn ?? null;
          // An unknown subagent outside any turn has no run to belong to.
          if (turn === null) return;
          // `started` can precede the spawning tool_execution_start; reserve that call's ordinal
          // first so its rows still follow it.
          if (parentToolCallId !== undefined) itemOrdinal(turn, parentToolCallId);
          const nativeTaskId = `${turn.providerTurn.id}:subagent:${id}`;
          subagent = {
            nativeId: id,
            nativeTaskId,
            owner: turn.turnInput,
            ownerProviderTurnId: turn.providerTurn.id,
            nodeId: idAllocator.derive.nodeFromProviderItem({
              driver: OMP_PROVIDER,
              nativeItemId: nativeTaskId,
            }),
            turnItemOrdinal: itemOrdinal(turn, nativeTaskId),
            childThreadId: idAllocator.derive.threadFromProviderThread({
              driver: OMP_PROVIDER,
              providerInstanceId: options.instanceId,
              nativeThreadId: `${turn.turnInput.providerThread.id}:${nativeTaskId}`,
            }),
            childRootNodeId: idAllocator.derive.nodeFromProviderItem({
              driver: OMP_PROVIDER,
              nativeItemId: `${nativeTaskId}:child-root`,
            }),
            startedAt: yield* DateTime.now,
            parentToolCallId: null,
            description: null,
            prompt: "",
            model: null,
            modelIdentity: null,
            progress: null,
            recentOutput: null,
            lastAssistantText: null,
            error: null,
            status: "running",
            completedAt: null,
            childCreated: false,
            promptSeeded: false,
            userMessages: 0,
            messageOrdinal: 0,
            childOrdinals: new Map(),
            nextChildOrdinal: 101,
            tools: makeOmpToolCalls(),
            streamItems: new Map(),
            lastEmitted: [],
          };
          subagents.set(id, subagent);
        }
        if (parentToolCallId !== undefined) subagent.parentToolCallId = parentToolCallId;
        if (event["type"] === "subagent_event") {
          const hadChild = subagent.childCreated;
          yield* projectSubagentEvent(subagent, recordField(payload, "event"));
          if (!hadChild && subagent.childCreated) yield* emitSubagentRow(subagent);
          return;
        }
        const description =
          recordString(payload, "description") ?? recordString(progress, "description");
        if (description !== undefined && description.trim().length > 0) {
          subagent.description = description;
        }
        const prompt = recordString(payload, "assignment") ?? recordString(payload, "task");
        if (prompt !== undefined && prompt.trim().length > 0) subagent.prompt = prompt;
        // A subagent whose model cannot be resolved never reports a resolved one.
        const modelOverride = recordField(progress, "modelOverride");
        subagent.model =
          recordString(progress, "resolvedModel") ??
          (Array.isArray(modelOverride) ? modelOverride.find(Predicate.isString) : undefined) ??
          subagent.model;
        subagent.modelIdentity =
          recordString(progress, "resolvedModelIdentity") ?? subagent.modelIdentity;
        subagent.progress =
          recordString(progress, "lastIntent") ??
          recordString(progress, "currentTool") ??
          subagent.progress;
        const recentOutput = recordField(progress, "recentOutput");
        if (Array.isArray(recentOutput)) {
          const lines = recentOutput.filter(Predicate.isString);
          if (lines.length > 0) subagent.recentOutput = lines.join("\n");
        }
        const lifecycle = event["type"] === "subagent_lifecycle";
        const status = ompSubagentStatus(recordString(lifecycle ? payload : progress, "status"));
        // Progress snapshots can trail a terminal frame; only a lifecycle start reopens a subagent.
        if (
          status !== null &&
          (lifecycle || status !== "running" || !isTerminalSubagentStatus(subagent.status))
        ) {
          if (!isTerminalSubagentStatus(status)) {
            subagent.completedAt = null;
            // A resumed subagent starts over; its last failure is history in the child thread.
            if (isTerminalSubagentStatus(subagent.status)) subagent.error = null;
          } else if (subagent.completedAt === null) {
            subagent.completedAt = yield* DateTime.now;
          }
          subagent.status = status;
          if (isTerminalSubagentStatus(status)) {
            yield* completeOpenSubagentStreamItems(subagent);
            yield* settleOpenTools(subagentToolTarget(subagent));
          }
        }
        if (subagent.prompt.length > 0 || subagent.childCreated) {
          yield* ensureSubagentChild(subagent);
        }
        yield* emitSubagentRow(subagent);
      });

      // A subagent that dies before its session starts sends no events; the `wait`/`job` result
      // reporting its job is the only place omp says why.
      const noteSubagentJobFailures = Effect.fnUntraced(function* (event: OmpRpcRecord) {
        for (const failure of ompSubagentJobFailures(event["result"])) {
          const subagent = subagents.get(failure.id);
          if (subagent === undefined || subagent.error !== null) continue;
          subagent.error = failure.error;
          if (subagent.childCreated) {
            yield* emitSubagentError(
              subagent,
              `${subagent.nativeTaskId}:job-error`,
              failure.status === "failed" ? "failed" : "interrupted",
              failure.error,
            );
          }
          yield* emitSubagentRow(subagent);
        }
      });

      // The extension reports every T3 call it ran. Calls omp showed as frames of their own are
      // already items; the rest (made inside eval, or by a subagent) become items here, under the
      // id omp's frames would give them so a late frame of a subagent's call updates the same item.
      const projectReportedToolCall = Effect.fnUntraced(function* (
        reported: OmpReportedToolCall,
        turn: ActiveOmpTurn | null,
      ) {
        const subagent =
          reported.agentId === undefined ? undefined : subagents.get(reported.agentId);
        const target =
          subagent !== undefined
            ? subagentToolTarget(subagent)
            : turn === null
              ? undefined
              : turnToolTarget(turn);
        if (target === undefined || target.calls.phase.has(reported.toolCallId)) return;
        const hadChild = subagent?.childCreated ?? true;
        if (subagent !== undefined) yield* ensureSubagentChild(subagent);
        yield* emitToolItem(
          target,
          {
            type: "tool_execution_end",
            toolCallId: reported.toolCallId,
            toolName: reported.toolName,
            args: reported.args,
            result: reported.result,
            isError: recordField(reported.result, "isError") === true,
          },
          "end",
        );
        if (subagent !== undefined && !hadChild) yield* emitSubagentRow(subagent);
      });

      const cancelPrompt = Effect.fn("OmpAdapter.cancelPrompt")(function* (
        pending: PendingOmpPrompt,
        resolvedAt: DateTime.Utc,
        timedOut = false,
      ) {
        if (pending.expirationFiber !== null) yield* Fiber.interrupt(pending.expirationFiber);
        yield* connection
          .send({
            type: "extension_ui_response",
            id: pending.nativeRequestId,
            cancelled: true,
            // A timed-out form submits its defaults (the preselected recommendation) instead.
            ...(timedOut && pending.method === "form" ? { timedOut: true } : {}),
          })
          .pipe(Effect.ignore);
        pending.runtimeRequest = {
          ...pending.runtimeRequest,
          status: "cancelled",
          resolvedAt,
        };
        yield* emit({
          type: "runtime_request.updated",
          driver: OMP_PROVIDER,
          threadId: pending.node.threadId,
          runtimeRequest: pending.runtimeRequest,
        });
        yield* emit({
          type: "node.updated",
          driver: OMP_PROVIDER,
          node: { ...pending.node, status: "cancelled", completedAt: resolvedAt },
        });
        yield* emit({
          type: "turn_item.updated",
          driver: OMP_PROVIDER,
          turnItem: {
            ...pending.turnItem,
            status: "cancelled",
            completedAt: resolvedAt,
            updatedAt: resolvedAt,
          },
        });
      });

      const cancelPendingPrompts = Effect.fn("OmpAdapter.cancelPendingPrompts")(function* (
        resolvedAt: DateTime.Utc,
      ) {
        const pending = Array.from(pendingPrompts.values());
        pendingPrompts.clear();
        yield* Effect.forEach(pending, (prompt) => cancelPrompt(prompt, resolvedAt), {
          discard: true,
        });
      });

      const emitSystemNotice = Effect.fnUntraced(function* (
        turn: ActiveOmpTurn,
        nativeItemId: string,
        message: string,
        level?: "info" | "warning" | "error",
      ) {
        const emittedAt = yield* DateTime.now;
        yield* emitItemNode(turn, nativeItemId, "system", "completed", emittedAt, emittedAt);
        yield* emit({
          type: "turn_item.updated",
          driver: OMP_PROVIDER,
          turnItem: {
            ...baseItemFields(turn, nativeItemId, emittedAt, emittedAt),
            status: "completed",
            completedAt: emittedAt,
            title: message,
            type: "system_notice",
            message,
            ...(level === undefined ? {} : { level }),
          },
        });
      });

      const clearNativeQueue = Effect.fnUntraced(function* (turn: ActiveOmpTurn) {
        const current = yield* request({ type: "get_state" }, 2_000);
        const queue = recordField(current, "queuedMessages");
        const cleared: string[] = [];
        for (const key of ["steering", "followUp"]) {
          const entries = recordField(queue, key);
          if (!Array.isArray(entries)) continue;
          for (const entry of entries) {
            const message = typeof entry === "string" ? entry : recordString(entry, "message");
            if (message === undefined) continue;
            yield* request({ type: "remove_queued_message", message, queue: key }, 2_000);
            cleared.push(message);
          }
        }
        if (cleared.length === 0) return;
        yield* sessionEventPermit.withPermits(1)(
          threadState?.activeTurn === turn
            ? emitSystemNotice(
                turn,
                `queue-cleared:${turn.providerTurn.id}`,
                [
                  `Stop cleared ${cleared.length} queued ${cleared.length === 1 ? "message" : "messages"} Omp had not read:`,
                  // Image-only messages come back as empty text.
                  ...cleared.filter((text) => text.length > 0),
                ]
                  .join("\n\n")
                  .slice(0, 2_000),
              )
            : Effect.void,
        );
      });

      const handleExtensionUiRequest = Effect.fnUntraced(function* (
        event: OmpRpcRecord,
        formRetry?: OmpFormRetry,
      ) {
        const method = recordString(event, "method");
        const nativeRequestId = recordString(event, "id");
        if (method === undefined) return;
        if (method === "cancel") {
          const targetId = recordString(event, "targetId");
          for (const [id, pending] of pendingPrompts) {
            if (pending.nativeRequestId !== targetId) continue;
            pendingPrompts.delete(id);
            yield* cancelPrompt(pending, yield* DateTime.now);
          }
          return;
        }
        if (method === "notify") {
          const state = threadState;
          const turn = state?.activeTurn ?? null;
          const message = recordString(event, "message") ?? "";
          if (turn === null || message.length === 0) return;
          const notifyType = recordString(event, "notifyType");
          yield* emitSystemNotice(
            turn,
            `notify:${turn.providerTurn.id}:${turn.nextItemOrdinal}`,
            message,
            notifyType === "warning" || notifyType === "error" ? notifyType : "info",
          );
          return;
        }
        if (
          method !== "select" &&
          method !== "confirm" &&
          method !== "input" &&
          method !== "editor" &&
          method !== "ask" &&
          method !== "form"
        ) {
          yield* Effect.logDebug("Ignoring omp extension UI update.", { method });
          return;
        }
        if (nativeRequestId === undefined) return;
        const formCard =
          method === "form"
            ? (formRetry?.card ?? ompFormCard(recordString(event, "html") ?? ""))
            : undefined;
        if (formCard !== undefined && "unsupported" in formCard) {
          // omp's ask blocks until a form is answered, so one the card cannot ask is dismissed.
          yield* Effect.logWarning("Cancelled an omp form the question card cannot ask.", {
            reason: formCard.unsupported,
          });
          yield* connection.send({
            type: "extension_ui_response",
            id: nativeRequestId,
            cancelled: true,
          });
          const turn = threadState?.activeTurn ?? null;
          if (turn !== null) {
            yield* emitSystemNotice(
              turn,
              `form-unsupported:${nativeRequestId}`,
              `Omp asked with a form T3 cannot show (${formCard.unsupported}), so it was dismissed.`,
              "warning",
            );
          }
          return;
        }
        const formEntries =
          formCard === undefined
            ? undefined
            : (formRetry?.problems.map((problem) => problem.entry) ?? formCard.entries);
        const formQuestions =
          formCard === undefined
            ? undefined
            : (formRetry?.problems.map((problem) => ompFormQuestion(problem.entry, problem)) ??
              formCard.entries.map((entry) => ompFormQuestion(entry)));
        const queuedPress = queuedAskPresses.shift();
        if (queuedPress !== undefined) {
          const value = ompAskPressValue(queuedPress, method, event);
          if (value !== undefined) {
            yield* connection.send({ type: "extension_ui_response", id: nativeRequestId, value });
            return;
          }
          // omp left the expected flow; ask the user from here on.
          queuedAskPresses.length = 0;
        }
        const approvalTitle = recordString(event, "title") ?? "";
        const approvalKey = `${approvalTitle.length}:${approvalTitle}${recordString(event, "message") ?? ""}`;
        if (method === "confirm" && sessionApprovals.has(approvalKey)) {
          yield* connection.send({
            type: "extension_ui_response",
            id: nativeRequestId,
            confirmed: true,
          });
          return;
        }
        if (method === "input") {
          const feedback = takeOmpApprovalFeedback(declinedApprovalFeedback, approvalTitle);
          if (feedback !== undefined) {
            yield* connection.send({
              type: "extension_ui_response",
              id: nativeRequestId,
              ...feedback,
            });
            return;
          }
        }
        const state = threadState;
        const turn = state?.activeTurn ?? null;
        const createdAt = yield* DateTime.now;
        const timeout = recordNumber(event, "timeout");
        // Omp treats zero as no timeout and negative durations as immediate expiry. A form asked
        // again keeps its first deadline.
        const expiresAt =
          formRetry !== undefined
            ? formRetry.expiresAt
            : timeout === undefined || timeout === 0
              ? null
              : DateTime.toEpochMillis(createdAt) + Math.max(0, timeout);
        const requestId = yield* idAllocator.allocate.runtimeRequest({
          driver: OMP_PROVIDER,
          ...(turn === null ? {} : { providerTurnId: turn.providerTurn.id }),
          nativeRequestId,
        });
        const nodeId = idAllocator.derive.approvalNode({ requestId });
        const approval =
          method === "select"
            ? parseOmpApprovalPrompt(
                approvalTitle,
                Array.isArray(event["options"])
                  ? event["options"].filter(
                      (option): option is string => typeof option === "string",
                    )
                  : [],
              )
            : undefined;
        const isApproval = method === "confirm" || approval !== undefined;
        const rawTitle = formCard?.title ?? recordString(event, "title") ?? method;
        const planMarkdown = method === "select" ? ompPlanReviewMarkdown(rawTitle) : undefined;
        const askChoice =
          method === "select" && approval === undefined && planMarkdown === undefined
            ? ompAskChoice(event)
            : undefined;
        // Emitted before the decision so the plan card sits above the approve/refine question.
        const proposedPlan =
          planMarkdown === undefined || turn === null
            ? undefined
            : yield* showProposedPlan(turn, nativeRequestId, planMarkdown);
        // The plan card carries the plan text; the question card only asks for the decision.
        const title = proposedPlan === undefined ? rawTitle : OMP_PLAN_REVIEW_PROMPT;
        // omp 19's dialog ids are random; a fixed id lets a scripted answer find the decision.
        const questionId =
          proposedPlan === undefined ? nativeRequestId : OMP_PLAN_REVIEW_QUESTION_ID;
        const threadId =
          turn?.turnInput.threadId ?? state?.providerThread.appThreadId ?? input.threadId;
        const providerThreadId = state?.providerThread.id ?? null;
        const providerTurnId = turn?.providerTurn.id ?? null;
        const runtimeRequest: OrchestrationV2RuntimeRequest = {
          id: requestId,
          nodeId,
          providerTurnId,
          nativeRequestRef: providerRef(nativeRequestId),
          kind: approval?.requestKind ?? (method === "confirm" ? "command" : "user_input"),
          status: "pending",
          responseCapability: {
            type: "live",
            providerSessionId: input.providerSessionId,
            // The extension relays a decline message to the agent (see takeOmpApprovalFeedback).
            ...(approval === undefined ? {} : { supportsFeedback: true }),
          },
          createdAt,
          resolvedAt: null,
        };
        const node: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId,
          runId: turn?.turnInput.runId ?? null,
          parentNodeId: turn?.turnInput.rootNodeId ?? null,
          rootNodeId: turn?.turnInput.rootNodeId ?? nodeId,
          kind: isApproval ? "approval_request" : "user_input_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId,
          providerTurnId,
          nativeItemRef: providerRef(nativeRequestId),
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: createdAt,
          completedAt: null,
        };
        const itemBase = {
          id: idAllocator.derive.approvalTurnItem({ requestId }),
          threadId,
          runId: turn?.turnInput.runId ?? null,
          nodeId,
          providerThreadId,
          providerTurnId,
          nativeItemRef: providerRef(nativeRequestId),
          parentItemId: null,
          ordinal: turn === null ? 0 : itemOrdinal(turn, nativeRequestId),
          status: "waiting" as const,
          title: approval?.title ?? title,
          startedAt: createdAt,
          completedAt: null,
          updatedAt: createdAt,
        };
        const fullAccessOverride =
          approval === undefined
            ? undefined
            : ompApprovalFullAccessOverride(approval, input.runtimePolicy.runtimeMode);
        const turnItem: OrchestrationV2TurnItem =
          approval !== undefined
            ? {
                ...itemBase,
                type: "approval_request",
                requestId,
                requestKind: approval.requestKind,
                prompt: approval.detail,
                ...(approval.reason === undefined ? {} : { reason: approval.reason }),
                ...(fullAccessOverride === undefined ? {} : { fullAccessOverride }),
                options: ompApprovalOptions(approval),
              }
            : method === "confirm"
              ? {
                  ...itemBase,
                  type: "approval_request",
                  requestId,
                  requestKind: "command",
                  prompt: recordString(event, "message") ?? title,
                }
              : {
                  ...itemBase,
                  type: "user_input_request",
                  requestId,
                  questions:
                    formQuestions !== undefined
                      ? formQuestions
                      : method === "ask"
                        ? ompAskQuestions(event)
                        : method === "form"
                          ? []
                          : [
                              askChoice === undefined
                                ? ompQuestion(questionId, method, title, event)
                                : ompAskChoiceQuestion(
                                    ompQuestion(questionId, method, title, event),
                                    askChoice,
                                  ),
                            ],
                };
        const pending: PendingOmpPrompt = {
          nativeRequestId,
          method,
          questionId,
          questions: method === "ask" ? ompAskQuestions(event) : [],
          approvalKey,
          expiresAt,
          expirationFiber: null,
          runtimeRequest,
          node,
          turnItem,
          ...(proposedPlan === undefined ? {} : { proposedPlan }),
          ...(approval === undefined ? {} : { approval }),
          ...(askChoice === undefined ? {} : { askChoice }),
          ...(formCard === undefined || formEntries === undefined
            ? {}
            : {
                form: {
                  event,
                  card: formCard,
                  entries: formEntries,
                  accepted: formRetry?.accepted ?? new Map(),
                },
              }),
        };
        pendingPrompts.set(String(requestId), pending);
        yield* emit({
          type: "runtime_request.updated",
          driver: OMP_PROVIDER,
          threadId,
          runtimeRequest,
        });
        yield* emit({ type: "node.updated", driver: OMP_PROVIDER, node });
        yield* emit({ type: "turn_item.updated", driver: OMP_PROVIDER, turnItem });
        if (expiresAt !== null) {
          const now = yield* DateTime.now;
          pending.expirationFiber = yield* Effect.sleep(
            Duration.millis(Math.max(0, expiresAt - DateTime.toEpochMillis(now))),
          ).pipe(
            Effect.andThen(
              Queue.offer(connection.events, {
                type: "t3.ui_request_expired",
                requestId: String(requestId),
                pending,
              }),
            ),
            Effect.asVoid,
            Effect.forkIn(scope),
          );
        }
      });

      const emitExtensionError = Effect.fnUntraced(function* (event: OmpRpcRecord) {
        const state = threadState;
        const turn = state?.activeTurn ?? null;
        if (turn === null) {
          outOfTurnExtensionErrors.push(event);
          return;
        }
        const emittedAt = yield* DateTime.now;
        const nativeItemId = `extension-error:${turn.providerTurn.id}:${turn.nextItemOrdinal}`;
        const extensionName = ompExtensionDisplayName(recordString(event, "extensionPath"));
        const extensionEvent = recordString(event, "event");
        const detail = recordString(event, "error")?.trim();
        const message = [
          `${extensionName} failed${extensionEvent === undefined ? "" : ` during ${extensionEvent}`}.`,
          detail === undefined || detail.length === 0 ? undefined : detail.slice(0, 2_000),
        ]
          .filter((part): part is string => part !== undefined)
          .join("\n\n");
        const failure = makeProviderFailure({
          message,
          class: "provider_error",
          retryable: false,
        });
        yield* emitItemNode(turn, nativeItemId, "system", "failed", emittedAt, emittedAt);
        yield* emit({
          type: "turn_item.updated",
          driver: OMP_PROVIDER,
          turnItem: {
            ...baseItemFields(turn, nativeItemId, emittedAt, emittedAt),
            status: "failed",
            title: extensionName,
            completedAt: emittedAt,
            type: "error",
            failure,
          },
        });
      });

      const listSessionEntries = (since: string | null, timeoutMs: number) =>
        request({ type: "get_entries", ...(since === null ? {} : { since }) }, timeoutMs).pipe(
          Effect.map(ompSessionListing),
          Effect.orElseSucceed(() => null),
        );

      // get_entries includes abandoned branches in append order; follow leaf parentId ancestry instead.
      const captureTurnTreeRefs = Effect.fnUntraced(function* (
        timeoutMs = OMP_REQUEST_TIMEOUT_MS,
      ): Effect.fn.Return<OmpTurnTreeRefs | null> {
        const cursorWasStale = leafCursorStale;
        const previousLeaf = lastKnownLeaf;
        const fullListing = cursorWasStale || previousLeaf === null;
        const listing = yield* listSessionEntries(fullListing ? null : previousLeaf, timeoutMs);
        const turnWalk =
          listing === null ? null : walkOmpBranch(listing.entries, listing.leafId, previousLeaf);
        const rewound = turnWalk !== null && previousLeaf !== null && !turnWalk.reachedStop;
        // since ends at the previous leaf; rewound ancestry requires the whole tree.
        const tree = rewound && !fullListing ? yield* listSessionEntries(null, timeoutMs) : listing;
        if (listing === null || turnWalk === null || tree === null) {
          leafCursorStale = true;
          return null;
        }
        lastKnownLeaf = listing.leafId;
        leafCursorStale = false;
        const turnStartEntryId = turnWalk.userEntryIds.at(-1);
        // Only a complete acyclic root walk proves all survivors.
        // The old leaf must remain in this tree to prove rewind rather than session replacement.
        const branch =
          rewound && previousLeaf !== null && tree.entries.has(previousLeaf)
            ? walkOmpBranch(tree.entries, listing.leafId, null)
            : undefined;
        return {
          // Stale cursors span earlier turns; keep a synthetic ref to avoid rolling back too far.
          nativeTurnRef: cursorWasStale
            ? undefined
            : turnStartEntryId !== undefined
              ? providerRef(turnStartEntryId)
              : turnWalk.entryCount === 0
                ? null
                : undefined,
          leafId: listing.leafId,
          retainedNativeTurnIds: branch?.reachedStop === true ? branch.userEntryIds : undefined,
        };
      });

      const finalizeTurn = Effect.fnUntraced(function* (state: OmpThreadState, readUsage = true) {
        const turn = state.activeTurn;
        if (turn === null) return;
        state.activeTurn = null;
        const interrupted = turn.interrupted || turn.nativeAborted;
        const completedAt = yield* DateTime.now;
        yield* completeOpenStreamItems(turn);
        // A job omp may still deliver keeps its call running past the turn, as in Claude/Codex;
        // every other open call ends here.
        const retainBackground = !interrupted && nativeBackgroundPending && !stopRequested;
        const toolTarget = turnToolTarget(turn, interrupted);
        for (const [toolCallId, frame] of Array.from(turn.tools.open)) {
          if (retainBackground && turn.tools.phase.get(toolCallId) === "background") {
            retainedBackgroundCalls.set(toolCallId, { turn, jobId: ompToolFrameJobId(frame) });
            continue;
          }
          yield* emitToolItem(toolTarget, frame, "settle");
        }
        if (turn.activeCompaction !== null) {
          const status = interrupted ? "cancelled" : turn.failure === null ? "completed" : "failed";
          yield* emitCompaction(turn, turn.activeCompaction, status);
          turn.activeCompaction = null;
        }
        if (turn.activeProviderRetry !== null) {
          if (interrupted) {
            yield* emitProviderRetry(turn, turn.activeProviderRetry, "interrupted", completedAt);
            turn.activeProviderRetry = null;
          } else if (turn.failure === null) {
            yield* emitProviderRetry(turn, turn.activeProviderRetry, "completed", completedAt);
            turn.activeProviderRetry = null;
          }
        }
        yield* cancelPendingPrompts(completedAt);
        const treeRefs =
          turn.stopTreeRefs !== undefined ? turn.stopTreeRefs : yield* captureTurnTreeRefs();
        const tokenUsage = readUsage
          ? yield* readTokenUsage(turn.latestCompactionAfterTokens, completedAt)
          : undefined;
        const failure = interrupted ? null : (turn.rejectedPromptFailure ?? turn.failure);
        yield* emit({
          type: "provider_turn.updated",
          driver: OMP_PROVIDER,
          threadId: turn.turnInput.threadId,
          providerTurn: {
            ...turn.providerTurn,
            ...(treeRefs === null || treeRefs.nativeTurnRef === undefined
              ? {}
              : { nativeTurnRef: treeRefs.nativeTurnRef }),
            status: interrupted ? "interrupted" : failure !== null ? "failed" : "completed",
            completedAt,
            ...(tokenUsage === undefined ? {} : { tokenUsage }),
          },
        });
        yield* updateProviderThread(
          state,
          {
            status: "idle",
            ...(treeRefs === null
              ? {}
              : {
                  nativeConversationHeadRef:
                    treeRefs.leafId === null ? null : providerRef(treeRefs.leafId),
                }),
          },
          treeRefs?.retainedNativeTurnIds,
        );
        yield* updateProviderSession(
          failure !== null ? "error" : "ready",
          failure?.message ?? null,
        );
        if (failure !== null) {
          const failureItemId = `terminal-failure:${turn.providerTurn.id}`;
          if (turn.activeProviderRetry !== null) {
            yield* emitProviderRetry(
              turn,
              { ...turn.activeProviderRetry, failure },
              "failed",
              completedAt,
            );
          } else {
            yield* emit({
              type: "turn_item.updated",
              driver: OMP_PROVIDER,
              turnItem: {
                ...baseItemFields(turn, failureItemId, completedAt, completedAt),
                status: "failed",
                title: null,
                completedAt,
                type: "error",
                failure,
              },
            });
          }
          yield* emit({
            type: "turn.terminal",
            driver: OMP_PROVIDER,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.turnInput.runOrdinal,
            failureItemOrdinal: itemOrdinal(turn, failureItemId),
            status: "failed",
            failure,
            ...(turn.activeProviderRetry === null
              ? {}
              : {
                  retry: turn.activeProviderRetry.retry,
                  retryStartedAt: turn.activeProviderRetry.startedAt,
                }),
            threadDisposition: "reusable",
          });
        } else {
          yield* emit({
            type: "turn.terminal",
            driver: OMP_PROVIDER,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.turnInput.runOrdinal,
            status: interrupted ? "interrupted" : "completed",
            failure: null,
            threadDisposition: "reusable",
          });
        }
      });

      const scheduleSettleProbe = (
        turn: ActiveOmpTurn,
        settleAfterAgentActivity = false,
        attempt = 1,
      ) => {
        const providerTurnId = turn.providerTurn.id;
        const settleProbeGeneration = turn.settleProbeGeneration;
        return request({ type: "get_state" }, 2_000).pipe(
          Effect.matchEffect({
            onSuccess: (data) =>
              Queue.offer(connection.events, {
                type: "t3.settle_probe",
                providerTurnId,
                settleAfterAgentActivity,
                settleProbeGeneration,
                attempt,
                data,
              }),
            // Failed probes must reach the pump; command-only turns emit no agent events to settle them.
            onFailure: () =>
              Queue.offer(connection.events, {
                type: "t3.settle_probe",
                providerTurnId,
                settleAfterAgentActivity,
                settleProbeGeneration,
                attempt,
                probeFailed: true,
              }),
          }),
          Effect.ignore,
          Effect.forkIn(scope),
        );
      };

      const stopPendingWake = Effect.fnUntraced(function* (wake: OmpWake) {
        if (pendingWake !== wake || threadState !== wake.state || closed) return;
        pendingWake = null;
        stopRequested = true;
        yield* cancelPendingPrompts(yield* DateTime.now);
        yield* connection.terminate;
      });

      /** Ends a call that outlived its turn, keeping the output of the job's last frame. */
      const settleRetainedCall = Effect.fnUntraced(function* (
        toolCallId: string,
        status: OmpAsyncJobStatus | "interrupted",
      ) {
        const retained = retainedBackgroundCalls.get(toolCallId);
        if (retained === undefined) return;
        retainedBackgroundCalls.delete(toolCallId);
        const frame = retained.turn.tools.open.get(toolCallId);
        if (frame === undefined) return;
        if (status === "interrupted") {
          yield* emitToolItem(turnToolTarget(retained.turn, true), frame, "settle");
          return;
        }
        const last =
          frame["type"] === "tool_execution_end"
            ? frame["result"]
            : (frame["partialResult"] ?? frame["result"]);
        yield* emitToolItem(
          turnToolTarget(retained.turn, false),
          {
            ...frame,
            type: "tool_execution_update",
            partialResult: {
              content: recordField(last, "content") ?? [],
              details: { async: { state: status, jobId: retained.jobId } },
            },
          },
          "update",
        );
      });

      const settleRetainedCalls = (status: OmpAsyncJobStatus | "interrupted") =>
        Effect.forEach(
          Array.from(retainedBackgroundCalls.keys()),
          (toolCallId) => settleRetainedCall(toolCallId, status),
          { discard: true },
        );

      const hasBackgroundWork = () =>
        pendingWake !== null ||
        nativeBackgroundPending ||
        retainedBackgroundCalls.size > 0 ||
        Array.from(subagents.values()).some(
          (subagent) => !isTerminalSubagentStatus(subagent.status),
        );

      // omp's `abort` leaves background jobs running, and a finished job still wakes the agent
      // (probed on 18.20), so only ending the process cancels them. The session file keeps the
      // conversation; the next message resumes it in a new process.
      const stopBackgroundWork = Effect.fnUntraced(function* () {
        if (closed) return;
        stopRequested = true;
        pendingWake = null;
        nativeBackgroundPending = false;
        yield* cancelPendingPrompts(yield* DateTime.now);
        yield* settleRetainedCalls("interrupted");
        yield* connection.terminate;
      });

      // A steer still awaiting its ack, held behind compaction, or admitted without its
      // prompt_result keeps the run going past an earlier prompt's yield.
      const promptsOutstanding = (turn: ActiveOmpTurn) =>
        turn.admittedPrompts > 0 ||
        pendingPromptResponses.some((pending) => pending.providerTurnId === turn.providerTurn.id) ||
        heldPrompts.some((held) => held.providerTurnId === turn.providerTurn.id);

      /**
       * The agent yielded. As with Claude, the run ends here even when background work can still
       * wake the agent; omp's later run becomes a continuation. A stopped turn's jobs would wake
       * it all the same, so Stop ends them with the process.
       */
      const endTurnAtYield = Effect.fnUntraced(function* (
        state: OmpThreadState,
        backgroundPending: boolean,
      ) {
        const turn = state.activeTurn;
        if (turn === null) return;
        if (turn.interrupted) {
          yield* finalizeTurn(state);
          if (backgroundPending) yield* stopBackgroundWork();
          return;
        }
        if (backgroundPending) nativeBackgroundPending = true;
        yield* finalizeTurn(state);
      });

      const handleSessionEvent = Effect.fnUntraced(function* (event: OmpRpcRecord) {
        if (event["type"] === "t3.extension_status_reset") {
          const reset = extensionStatusReset;
          if (reset !== null && event["reset"] === reset) {
            reset.previous = sessionEntity.extensionStatuses ?? [];
            reset.touched.clear();
            yield* clearExtensionStatuses();
            yield* Deferred.succeed(reset.ready, undefined);
          }
          return;
        }
        // A native wake may wait for a turn owner; status belongs to the live session immediately.
        if (event["type"] === "extension_ui_request" && event["method"] === "setStatus") {
          yield* updateExtensionStatus(event);
          return;
        }
        // Subagent state is not turn-scoped, so their frames never wait for a turn owner.
        if (
          event["type"] === "subagent_lifecycle" ||
          event["type"] === "subagent_progress" ||
          event["type"] === "subagent_event"
        ) {
          yield* handleSubagentFrame(event);
          return;
        }
        const reported = ompReportedToolCall(event);
        // A subagent's call belongs to its child thread, which needs no turn owner either.
        if (reported?.agentId !== undefined && subagents.has(reported.agentId)) {
          yield* projectReportedToolCall(reported, null);
          return;
        }
        // A call that outlived its turn is session-scoped too: its job frames update the finished
        // turn's item, never whichever turn is active, and never wait for a wake's owner.
        if (event["type"] === "tool_execution_update") {
          const toolCallId = recordString(event, "toolCallId");
          const retained =
            toolCallId === undefined ? undefined : retainedBackgroundCalls.get(toolCallId);
          if (toolCallId !== undefined && retained !== undefined) {
            yield* emitToolItem(turnToolTarget(retained.turn, false), event, "update");
            if (retained.turn.tools.phase.get(toolCallId) === "settled")
              retainedBackgroundCalls.delete(toolCallId);
            return;
          }
        }
        for (const job of ompDeliveredAsyncJobs(event)) {
          for (const [toolCallId, retained] of Array.from(retainedBackgroundCalls)) {
            if (retained.jobId === job.jobId) yield* settleRetainedCall(toolCallId, job.status);
          }
        }
        if (event["type"] === "session_settled") {
          nativeBackgroundPending = false;
          yield* settleRetainedCalls("completed");
        }
        // Model hooks can show dialogs before turn ownership; keep requests session-scoped and buffer output.
        const interactiveUiRequest =
          event["type"] === "extension_ui_request" &&
          ["select", "confirm", "input", "editor", "form"].includes(String(event["method"]));
        if (
          threadState?.activeTurn === null &&
          pendingWake !== null &&
          !interactiveUiRequest &&
          !String(event["type"]).startsWith("t3.") &&
          event["type"] !== "response"
        ) {
          pendingWake.events.push(event);
          if (event["type"] === "agent_start") yield* updateProviderSession("running", null);
          if (event["type"] === "session_settled") yield* updateProviderSession("ready", null);
          return;
        }
        const state = threadState;
        const turn = state?.activeTurn ?? null;
        switch (event["type"]) {
          case "command_output": {
            const text = recordString(event, "text");
            if (turn !== null && text !== undefined) {
              yield* emitSystemNotice(
                turn,
                `command:${turn.providerTurn.id}:${turn.nextItemOrdinal}`,
                text,
              );
            }
            return;
          }
          case "config_update": {
            const model = recordField(event, "model");
            const provider = recordString(model, "provider");
            const modelId = recordString(model, "id");
            appliedModel =
              provider !== undefined && modelId !== undefined ? `${provider}/${modelId}` : null;
            baselineModel =
              provider !== undefined && modelId !== undefined ? { provider, modelId } : null;
            baselineThinking = recordString(event, "thinkingLevel") ?? null;
            appliedThinking = baselineThinking;
            contextWindow = rememberModelContextWindow(model);
            if (appliedModel !== null) {
              const updatedAt = yield* DateTime.now;
              sessionEntity = { ...sessionEntity, model: appliedModel, updatedAt };
              yield* emit({
                type: "provider_session.updated",
                driver: OMP_PROVIDER,
                providerSession: sessionEntity,
              });
            }
            return;
          }
          case "agent_start": {
            if (
              turn === null &&
              state?.providerThread.appThreadId != null &&
              continuationRequests !== undefined &&
              !closed &&
              !stopRequested
            ) {
              const wake: OmpWake = { state, events: [event] };
              pendingWake = wake;
              if (rollbackBarrier !== null) {
                yield* stopPendingWake(wake);
                return;
              }
              yield* updateProviderSession("running", null);
              yield* continuationRequests
                .offer({
                  threadId: state.providerThread.appThreadId,
                  providerThreadId: state.providerThread.id,
                  driver: OMP_PROVIDER,
                  detail: null,
                  delivery: "adapter_buffered",
                  dispatchIfCurrent: (dispatch) =>
                    sessionEventPermit.withPermits(1)(
                      Effect.suspend(() =>
                        pendingWake === wake && threadState === state && !closed
                          ? dispatch.pipe(
                              Effect.asSome,
                              Effect.tapError(() => stopPendingWake(wake)),
                            )
                          : Effect.succeedNone,
                      ),
                    ),
                  clearIfCurrent: () => sessionEventPermit.withPermits(1)(stopPendingWake(wake)),
                })
                .pipe(Effect.tapError(() => stopPendingWake(wake)));
              return;
            }
            // Stop is ending the process; a job that finished meanwhile must not reopen the thread.
            if (turn === null && stopRequested) return;
            if (turn === null) {
              unsolicitedActivityDetected = true;
              yield* updateProviderSession("error", OMP_UNSOLICITED_ACTIVITY_ERROR);
              yield* connection.terminate;
              return;
            }
            turn.sawAgentActivity = true;
            turn.nativeAborted = false;
            turn.settleProbeGeneration += 1;
            return;
          }
          case "message_start": {
            if (turn !== null && recordString(event["message"], "role") === "assistant") {
              turn.sawAgentActivity = true;
              turn.messageOrdinal += 1;
            }
            return;
          }
          case "message_update": {
            if (turn === null) return;
            turn.sawAgentActivity = true;
            yield* reportLiveUsage(turn, event["usage"]);
            const delta = event["assistantMessageEvent"];
            const deltaType = recordString(delta, "type");
            const contentIndex = recordNumber(delta, "contentIndex") ?? 0;
            if (deltaType === "text_delta" || deltaType === "thinking_delta") {
              const item = yield* streamItemFor(
                turn,
                deltaType === "text_delta" ? "assistant_message" : "reasoning",
                contentIndex,
              );
              item.text += recordString(delta, "delta") ?? "";
              yield* scheduleStreamFlush(turn, item);
              return;
            }
            if (deltaType === "text_end" || deltaType === "thinking_end") {
              const item = yield* streamItemFor(
                turn,
                deltaType === "text_end" ? "assistant_message" : "reasoning",
                contentIndex,
              );
              yield* completeStreamItem(
                turn,
                item,
                recordString(delta, "content") ?? recordString(delta, "thinking"),
              );
              return;
            }
            return;
          }
          case "message_end": {
            if (turn === null) return;
            const message = event["message"];
            if (recordString(message, "role") !== "assistant") return;
            yield* completeOpenStreamItems(turn);
            if (recordString(message, "stopReason") === "error" && turn.failure === null) {
              turn.failure = makeProviderFailure({
                message: recordString(message, "errorMessage") ?? "Omp reported a model error.",
                class: "provider_error",
              });
            }
            return;
          }
          case "tool_execution_start":
            if (turn !== null) {
              turn.sawAgentActivity = true;
              yield* emitToolItem(turnToolTarget(turn), event, "start");
            }
            return;
          case "tool_execution_update":
            if (turn !== null) yield* emitToolItem(turnToolTarget(turn), event, "update");
            return;
          case "tool_execution_end": {
            if (turn !== null) {
              yield* emitToolItem(turnToolTarget(turn), event, "end");
              const todoSteps = ompTodoStepsFromToolEnd(event);
              if (todoSteps !== undefined) yield* projectTodoList(turn, todoSteps);
            }
            yield* noteSubagentJobFailures(event);
            return;
          }
          case "todo_auto_clear":
            // omp drops a finished list on its own; an unfinished one is no longer being tracked.
            if (latestTodo !== null && latestTodo.plan.status === "active") {
              yield* settlePlan(latestTodo.plan, "superseded");
            }
            latestTodo = null;
            return;
          case "compaction_start": {
            if (turn === null) return;
            turn.settleProbeGeneration += 1;
            turn.sawCompaction = true;
            if (turn.activeCompaction !== null) {
              yield* emitCompaction(turn, turn.activeCompaction, "cancelled");
            }
            const startedAt = yield* DateTime.now;
            const compaction = {
              nativeItemId: compactionNativeItemId(turn),
              startedAt,
            } satisfies OmpCompactionState;
            turn.activeCompaction = compaction;
            yield* emitCompaction(turn, compaction, "running");
            return;
          }
          case "compaction_end": {
            if (turn === null) return;
            const observedAt = yield* DateTime.now;
            const compaction = turn.activeCompaction ?? {
              nativeItemId: compactionNativeItemId(turn),
              startedAt: observedAt,
            };
            turn.activeCompaction = null;
            const result = event["result"];
            if (result === null || result === undefined) {
              if (event["aborted"] === true) {
                yield* emitCompaction(turn, compaction, "cancelled");
                if (
                  (turn.settleWhenIdle || !turn.sawAgentActivity) &&
                  releasedPromptTurnId !== turn.providerTurn.id
                ) {
                  yield* scheduleSettleProbe(turn, turn.settleWhenIdle);
                }
                return;
              }
              const errorMessage =
                recordString(event, "errorMessage") ?? "Omp context compaction failed.";
              // A skipped compaction ("Already compacted") found nothing to do; it did not fail.
              yield* emitCompaction(
                turn,
                compaction,
                event["skipped"] === true ? "completed" : "failed",
                { summary: errorMessage.slice(0, 1_000) },
              );
              if (
                (turn.settleWhenIdle || !turn.sawAgentActivity) &&
                releasedPromptTurnId !== turn.providerTurn.id
              ) {
                yield* scheduleSettleProbe(turn, turn.settleWhenIdle);
              }
              return;
            }
            // Clear overflow failures only when compaction will retry; ordinary compaction must retain exhausted retries.
            if (event["willRetry"] === true) turn.failure = null;
            turn.latestCompactionAfterTokens =
              nonNegativeInteger(result, "estimatedTokensAfter") ?? null;
            const summary = recordString(result, "summary");
            const beforeTokenCount = nonNegativeInteger(result, "tokensBefore");
            const afterTokenCount = nonNegativeInteger(result, "estimatedTokensAfter");
            yield* emitCompaction(turn, compaction, "completed", {
              ...(summary === undefined ? {} : { summary }),
              ...(beforeTokenCount === undefined ? {} : { beforeTokenCount }),
              ...(afterTokenCount === undefined ? {} : { afterTokenCount }),
            });
            if (
              (turn.settleWhenIdle || !turn.sawAgentActivity) &&
              releasedPromptTurnId !== turn.providerTurn.id
            ) {
              yield* scheduleSettleProbe(turn, turn.settleWhenIdle);
            }
            return;
          }
          case "auto_retry_start": {
            if (turn === null) return;
            const emittedAt = yield* DateTime.now;
            const attempt = Math.max(1, Math.trunc(recordNumber(event, "attempt") ?? 1));
            const maxAttempts = Math.max(
              attempt,
              Math.trunc(recordNumber(event, "maxAttempts") ?? attempt),
            );
            const retryDelayMs = Math.max(0, Math.trunc(recordNumber(event, "delayMs") ?? 0));
            const failure = makeProviderFailure({
              message: recordString(event, "errorMessage") ?? "Omp provider request failed.",
              class: "provider_error",
              retryable: true,
            });
            const current = turn.activeProviderRetry;
            const providerRetry = {
              retry: { attempt, maxAttempts, retryDelayMs },
              failure,
              startedAt: current?.startedAt ?? emittedAt,
              itemOrdinal:
                current?.itemOrdinal ??
                itemOrdinal(turn, `terminal-failure:${turn.providerTurn.id}`),
            } satisfies OmpProviderRetryState;
            turn.activeProviderRetry = providerRetry;
            yield* emitProviderRetry(turn, providerRetry, "running", emittedAt);
            return;
          }
          case "auto_retry_end": {
            if (turn === null) return;
            const emittedAt = yield* DateTime.now;
            if (event["success"] === true) {
              // Successful retries supersede the failure session_settled would reuse.
              if (turn.activeProviderRetry !== null) {
                const attempt = Math.max(
                  1,
                  Math.trunc(
                    recordNumber(event, "attempt") ?? turn.activeProviderRetry.retry.attempt,
                  ),
                );
                const recoveredRetry = {
                  ...turn.activeProviderRetry,
                  retry: { ...turn.activeProviderRetry.retry, attempt },
                };
                yield* emitProviderRetry(turn, recoveredRetry, "completed", emittedAt);
                turn.activeProviderRetry = null;
              }
              turn.failure = null;
              return;
            }
            const failure = makeProviderFailure({
              message: recordString(event, "finalError") ?? "Omp auto-retry failed.",
              class: "provider_error",
              retryable: false,
            });
            const attempt = Math.max(1, Math.trunc(recordNumber(event, "attempt") ?? 1));
            const current = turn.activeProviderRetry;
            const providerRetry = {
              retry: {
                attempt,
                maxAttempts: current?.retry.maxAttempts ?? attempt,
                retryDelayMs: current?.retry.retryDelayMs ?? null,
              },
              failure,
              startedAt: current?.startedAt ?? emittedAt,
              itemOrdinal:
                current?.itemOrdinal ??
                itemOrdinal(turn, `terminal-failure:${turn.providerTurn.id}`),
            } satisfies OmpProviderRetryState;
            turn.activeProviderRetry = providerRetry;
            turn.failure = failure;
            yield* emitProviderRetry(turn, providerRetry, "failed", emittedAt);
            return;
          }
          case "extension_ui_request":
            if (reported !== undefined) yield* projectReportedToolCall(reported, turn);
            else yield* handleExtensionUiRequest(event);
            return;
          case "extension_error": {
            yield* emitExtensionError(event);
            return;
          }
          case "prompt_result": {
            if (turn === null) return;
            const failure = ompPromptFailure(event);
            if (failure !== undefined)
              turn.failure = makeProviderFailure({ message: failure, class: "provider_error" });
            if (event["status"] === "aborted") turn.nativeAborted = true;
            turn.admittedPrompts = Math.max(0, turn.admittedPrompts - 1);
            if (promptsOutstanding(turn)) return;
            if (event["sessionSettled"] === true) {
              turn.settleWhenIdle = true;
              yield* scheduleSettleProbe(turn, true);
              return;
            }
            if (state !== null) yield* endTurnAtYield(state, true);
            return;
          }
          case "agent_end": {
            // An omp-started run has no prompt_result; its agent's yield ends the continuation.
            if (
              turn === null ||
              !turn.continuation ||
              !ompAgentEndYielded(event) ||
              promptsOutstanding(turn)
            )
              return;
            if (state !== null) yield* endTurnAtYield(state, event["isTerminal"] === false);
            return;
          }
          case "session_settled": {
            if (turn?.interrupted === true) {
              if (state !== null) yield* finalizeTurn(state);
              return;
            }
            if (turn !== null) {
              turn.nativeAborted = event["aborted"] === true;
              turn.settleWhenIdle = true;
              turn.settleProbeGeneration += 1;
              if (
                turn.adoptedWake &&
                pendingPromptResponses.some(
                  (pending) =>
                    pending.providerTurnId === turn.providerTurn.id &&
                    pending.kind === "turn_start",
                )
              )
                return;
              yield* scheduleSettleProbe(turn, true);
            }
            return;
          }
          case "response": {
            const command = recordString(event, "command");
            if (command === "compact") {
              const pendingCompact = pendingCompactResponses.shift();
              const compactTurn =
                pendingCompact?.providerTurnId === turn?.providerTurn.id ? turn : null;
              if (compactTurn !== null) compactTurn.manualCompactInFlight = false;
              if (event["success"] === true) {
                if (
                  pendingCompact?.kind === "turn_start" &&
                  compactTurn !== null &&
                  compactTurn.promptMayBeCommandOnly &&
                  !compactTurn.sawAgentActivity
                ) {
                  yield* scheduleSettleProbe(compactTurn);
                }
                return;
              }
              if (event["success"] !== false) return;
              if (compactTurn === null) return;
              if (compactTurn.activeCompaction !== null) return;
              if (pendingCompact?.kind === "steer") {
                yield* Effect.logWarning("Omp rejected a compact steer.", {
                  errorLength: recordString(event, "error")?.length,
                });
                return;
              }
              if (!compactTurn.sawCompaction) {
                compactTurn.failure = makeProviderFailure({
                  message: recordString(event, "error") ?? "Omp compact failed.",
                  class: "provider_error",
                });
                if (state !== null) yield* finalizeTurn(state);
                return;
              }
              if (!compactTurn.sawAgentActivity) {
                yield* scheduleSettleProbe(compactTurn);
              }
              return;
            }
            const pendingPrompt = command === "prompt" ? pendingPromptResponses.shift() : undefined;
            const responseTurn =
              pendingPrompt?.providerTurnId === turn?.providerTurn.id ? turn : null;
            if (
              event["success"] === false &&
              nativeCompacting &&
              recordString(event, "error")?.startsWith(OMP_COMPACTING_PROMPT_REJECTION) === true &&
              pendingPrompt !== undefined &&
              responseTurn !== null
            ) {
              heldPrompts.splice(rejectedHeldCount++, 0, pendingPrompt);
              return;
            }
            // Settlement is not probed while a steer awaits its ack (see
            // compaction_end); once Omp answers, the run it may have started is
            // visible to get_state.
            if (pendingPrompt?.kind === "steer" && responseTurn?.settleWhenIdle === true) {
              yield* scheduleSettleProbe(responseTurn, true);
            }
            if (event["success"] === true) {
              // Exactly one prompt_result follows an admitted prompt unless the ack completed it.
              if (
                pendingPrompt !== undefined &&
                responseTurn !== null &&
                recordField(event["data"], "agentInvoked") !== false
              )
                responseTurn.admittedPrompts += 1;
              // Command-only prompts emit no session_settled; probe idle and re-queue behind preceding native events.
              if (
                pendingPrompt?.kind === "turn_start" &&
                responseTurn !== null &&
                ((responseTurn.promptMayBeCommandOnly && !responseTurn.sawAgentActivity) ||
                  (responseTurn.adoptedWake &&
                    (responseTurn.settleWhenIdle || responseTurn.promptMayBeCommandOnly)))
              ) {
                yield* scheduleSettleProbe(responseTurn, responseTurn.adoptedWake);
              }
              return;
            }
            if (event["success"] !== false) return;
            if (command === "steer" || pendingPrompt?.kind === "steer") {
              // A rejected steer refuses only that message; its target turn keeps running.
              yield* Effect.logWarning("Omp rejected a steer message.", {
                errorLength: recordString(event, "error")?.length,
              });
              return;
            }
            const failedTurn =
              command === "prompt" && pendingPrompt?.kind === "turn_start"
                ? responseTurn
                : command === "parse"
                  ? turn
                  : null;
            if (failedTurn !== null) {
              const failure = makeProviderFailure({
                message: recordString(event, "error") ?? "Omp rejected the prompt.",
                class: "provider_error",
              });
              if (failedTurn.adoptedWake && command === "prompt") {
                failedTurn.rejectedPromptFailure = failure;
                failedTurn.settleWhenIdle = true;
                yield* scheduleSettleProbe(failedTurn, true);
              } else {
                failedTurn.failure = failure;
                if (state !== null) yield* finalizeTurn(state);
              }
            }
            return;
          }
          case "t3.ui_request_expired": {
            const requestId = recordString(event, "requestId");
            if (requestId === undefined) return;
            const pending = pendingPrompts.get(requestId);
            if (pending === undefined || pending !== event["pending"]) return;
            pendingPrompts.delete(requestId);
            yield* cancelPrompt(pending, yield* DateTime.now, true);
            return;
          }
          case "t3.flush_extension_errors": {
            for (const extensionError of outOfTurnExtensionErrors.splice(0)) {
              yield* emitExtensionError(extensionError);
            }
            return;
          }
          case "t3.rollback_barrier": {
            if (rollbackBarrier !== null && event["barrier"] === rollbackBarrier)
              yield* Deferred.succeed(rollbackBarrier, undefined);
            return;
          }
          case "t3.settle_probe": {
            const data = event["data"];
            const probeFailed = event["probeFailed"] === true;
            const settleAfterAgentActivity = event["settleAfterAgentActivity"] === true;
            const attempt = Math.max(1, Math.trunc(recordNumber(event, "attempt") ?? 1));
            if (
              turn === null ||
              turn.providerTurn.id !== event["providerTurnId"] ||
              turn.settleProbeGeneration !== event["settleProbeGeneration"] ||
              (!settleAfterAgentActivity && turn.sawAgentActivity) ||
              turn.activeCompaction !== null
            ) {
              return;
            }
            if (probeFailed) {
              if (!settleAfterAgentActivity) {
                if (state !== null) yield* finalizeTurn(state);
                return;
              }
              if (attempt < SETTLE_PROBE_MAX_ATTEMPTS) {
                yield* Effect.sleep(SETTLE_PROBE_RETRY_DELAY).pipe(
                  Effect.andThen(scheduleSettleProbe(turn, true, attempt + 1)),
                  Effect.forkIn(scope),
                );
                return;
              }
              stopRequested = true;
              yield* connection.terminate;
              return;
            }
            if (isOmpSessionSettled(data)) {
              turn.settleWhenIdle = false;
              if (state !== null) yield* finalizeTurn(state);
            }
            return;
          }
          default:
            return;
        }
      });

      yield* Effect.gen(function* () {
        while (true) {
          const nativeEvent = yield* Queue.take(connection.events);
          // Omp reports manual compaction (`compact`, `/compact`) and automatic compaction as
          // separate event pairs; both drive the same compaction item and prompt hold.
          const event =
            nativeEvent["type"] === "auto_compaction_start" ||
            nativeEvent["type"] === "manual_compaction_start"
              ? { ...nativeEvent, type: "compaction_start" }
              : nativeEvent["type"] === "auto_compaction_end" ||
                  nativeEvent["type"] === "manual_compaction_end"
                ? { ...nativeEvent, type: "compaction_end" }
                : nativeEvent;
          yield* sessionEventPermit.withPermits(1)(
            Effect.gen(function* () {
              // Tracked here rather than in handleSessionEvent, which also
              // replays buffered wake events after they were observed.
              if (event["type"] === "compaction_start") nativeCompacting = true;
              if (event["type"] === "compaction_end") {
                nativeCompacting = false;
                // Send before the handler can probe settlement, so Omp sees the
                // prompt first. Prompts whose turn ended or is stopping are dropped.
                rejectedHeldCount = 0;
                for (const held of heldPrompts.splice(0)) {
                  const turn = threadState?.activeTurn;
                  if (
                    turn?.providerTurn.id !== held.providerTurnId ||
                    turn.interrupted ||
                    stopRequested
                  )
                    continue;
                  yield* sendPrompt(held);
                  releasedPromptTurnId = held.providerTurnId;
                }
              }
              yield* handleSessionEvent(event).pipe(
                Effect.ensuring(Effect.sync(() => (releasedPromptTurnId = null))),
              );
            }),
          );
        }
      }).pipe(
        Effect.catchCause((cause) =>
          sessionEventPermit.withPermits(1)(
            Effect.gen(function* () {
              runtimeRetired = true;
              const state = threadState;
              if (extensionStatusReset !== null)
                yield* Deferred.fail(
                  extensionStatusReset.ready,
                  protocolError("Omp transport closed during status reset"),
                );
              if (rollbackBarrier !== null)
                yield* Deferred.fail(
                  rollbackBarrier,
                  protocolError("Omp transport closed during rollback"),
                );
              pendingWake = null;
              // Jobs run inside the omp process and end with it.
              nativeBackgroundPending = false;
              yield* settleRetainedCalls("interrupted");
              const interrupted = state?.activeTurn?.interrupted === true;
              if (state?.activeTurn != null) {
                const turn = state.activeTurn;
                // An approval or question dies with the process (pendingRequestsSurviveRestart:
                // false). End the run as stopped and say so, so the thread is not left waiting on
                // a request nothing can answer; the next message resumes the session file.
                const lostRequest = pendingPrompts.size > 0 && !interrupted && !stopRequested;
                if (lostRequest) {
                  turn.interrupted = true;
                  yield* emitSystemNotice(
                    turn,
                    `lost-request:${turn.providerTurn.id}`,
                    "Omp stopped while waiting for your answer, so the request was cancelled. Send a message to continue; the conversation resumes where it left off.",
                  );
                }
                turn.failure =
                  interrupted || lostRequest
                    ? null
                    : makeProviderFailure({
                        cause,
                        message: "Omp process exited unexpectedly.",
                        class: "transport_error",
                      });
                yield* finalizeTurn(state, false);
              } else {
                yield* cancelPendingPrompts(yield* DateTime.now);
              }
              // Subagents run inside the omp process and cannot report once it is gone.
              for (const subagent of subagents.values()) {
                if (isTerminalSubagentStatus(subagent.status)) continue;
                subagent.status = "interrupted";
                subagent.completedAt = yield* DateTime.now;
                yield* settleOpenTools(subagentToolTarget(subagent));
                yield* emitSubagentRow(subagent);
              }
              if (unsolicitedActivityDetected) {
                yield* updateProviderSession("error", OMP_UNSOLICITED_ACTIVITY_ERROR);
                yield* Queue.end(events);
              } else if (stopRequested) {
                yield* updateProviderSession("stopped", null);
                yield* Queue.end(events);
              } else {
                yield* updateProviderSession(
                  "error",
                  interrupted ? "Omp process was stopped." : "Omp process exited unexpectedly.",
                );
                yield* Queue.fail(
                  events,
                  new ProviderAdapter.ProviderAdapterEventStreamError({
                    driver: OMP_PROVIDER,
                    providerSessionId: input.providerSessionId,
                    cause,
                  }),
                );
              }
            }),
          ),
        ),
        Effect.forkIn(scope),
      );

      const registerThread = Effect.fnUntraced(function* (
        threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
        publish = true,
      ) {
        if (rollbackBarrier !== null)
          return yield* protocolError("Cannot register a Omp thread during rollback");
        if (threadState !== null && threadState.activeTurn !== null) {
          return yield* protocolError("Cannot register a Omp thread while a turn is active");
        }
        if (pendingWake !== null) {
          const state = threadState;
          if (
            state !== null &&
            state === pendingWake.state &&
            state.providerThread.appThreadId === threadInput.threadId &&
            (threadInput.existingProviderThread === undefined ||
              threadInput.existingProviderThread.nativeThreadRef?.nativeId ===
                state.providerThread.nativeThreadRef?.nativeId)
          )
            return state.providerThread;
          return yield* protocolError(
            "Cannot switch Omp threads while native work is awaiting a turn",
          );
        }
        const existing = threadInput.existingProviderThread;
        let resumeId = existing?.nativeThreadRef?.nativeId;
        if (resumeId != null) {
          const sessionDir = `${host.paths.stateDir}/omp-sessions`;
          if (!resumeId.startsWith(`${sessionDir}/`)) {
            const copy = ompResumeCopyPath(sessionDir, threadInput.threadId, resumeId);
            yield* fileSystem
              .makeDirectory(sessionDir, { recursive: true })
              .pipe(
                Effect.mapError((cause) => protocolError("Cannot prepare OMP session copy", cause)),
              );
            if (!(yield* fileSystem.exists(copy))) {
              yield* fileSystem
                .copyFile(resumeId, copy)
                .pipe(
                  Effect.mapError((cause) =>
                    protocolError("Cannot copy the native OMP session", cause),
                  ),
                );
            }
            resumeId = copy;
          }
        }
        const needsNewSession = resumeId == null && registrationAttempted;
        registrationAttempted = true;
        if (resumeId != null || needsNewSession) {
          lastNativeThreadId = resumeId ?? lastNativeThreadId;
          // Failed lifecycle operations can still change native sessions; invalidate bindings and defaults.
          threadState = null;
          appliedModel = null;
          appliedThinking = null;
          appliedSessionName = null;
          baselineModel = null;
          baselineThinking = null;
          contextWindow = null;
          const result = yield* lifecycleRequest(
            resumeId != null
              ? { type: "switch_session", sessionPath: resumeId }
              : { type: "new_session" },
          );
          if (recordField(result, "cancelled") === true) {
            return yield* protocolError("A Omp extension cancelled the session switch");
          }
        }
        yield* request({ type: "set_ask_dialog", enabled: true });
        yield* request({ type: "set_subagent_subscription", level: "events" });
        const stateData = yield* request({ type: "get_state" });
        if (!modelsDiscovered) {
          const modelsData = yield* request({ type: "get_available_models" }).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          const models = recordField(modelsData, "models");
          if (Array.isArray(models)) {
            for (const model of models) rememberModelContextWindow(model);
            modelsDiscovered = true;
          }
        }
        contextWindow = rememberModelContextWindow(recordField(stateData, "model"));
        // Capture each baseline before applying selections so our own choices cannot become Omp defaults.
        if (baselineModel === null && appliedModel === null) {
          const stateModel = recordField(stateData, "model");
          const provider = recordString(stateModel, "provider");
          const modelId = recordString(stateModel, "id");
          if (provider !== undefined && modelId !== undefined) {
            baselineModel = { provider, modelId };
          }
        }
        if (baselineThinking === null && appliedThinking === null) {
          baselineThinking = recordString(stateData, "thinkingLevel") ?? null;
          appliedThinking = baselineThinking;
        }
        // switch_session accepts a file path, not Omp's display session UUID.
        const nativeId = recordString(stateData, "sessionFile");
        if (nativeId === undefined) {
          return yield* protocolError("get_state returned no persisted sessionFile", stateData);
        }
        if (needsNewSession && nativeId === lastNativeThreadId) {
          return yield* protocolError("Omp did not create a distinct session file");
        }
        lastNativeThreadId = nativeId;
        const createdAt = yield* DateTime.now;
        const providerThread: OrchestrationV2ProviderThread =
          existing !== undefined
            ? {
                ...existing,
                providerSessionId: input.providerSessionId,
                nativeThreadRef: providerRef(nativeId),
                ...(needsNewSession ? { nativeConversationHeadRef: null, contextUsage: null } : {}),
                status: "idle",
                updatedAt: createdAt,
              }
            : {
                id: idAllocator.derive.providerThread({
                  driver: OMP_PROVIDER,
                  nativeThreadId: nativeId,
                }),
                driver: OMP_PROVIDER,
                providerInstanceId: options.instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: providerRef(nativeId),
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                pendingBackgroundTasks: [],
                createdAt,
                updatedAt: createdAt,
              };
        threadState = { providerThread, activeTurn: null };
        const baselineEntries = yield* request({ type: "get_entries" }).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        lastKnownLeaf = recordString(baselineEntries, "leafId") ?? null;
        leafCursorStale = baselineEntries === undefined;
        if (publish)
          yield* emit({
            type: "provider_thread.updated",
            driver: OMP_PROVIDER,
            providerThread,
          });
        return providerThread;
      });

      const applySelection = Effect.fnUntraced(function* (modelSelection: ModelSelection) {
        const thinking = getModelSelectionStringOptionValue(modelSelection, "thinking");
        if (modelSelection.model === OMP_INHERIT_MODEL_SLUG) {
          if (appliedModel !== null && baselineModel !== null) {
            const restoredModel = yield* request({ type: "set_model", ...baselineModel });
            appliedThinking = null;
            contextWindow = rememberModelContextWindow(restoredModel);
            appliedModel = null;
            const updatedAt = yield* DateTime.now;
            sessionEntity = { ...sessionEntity, model: OMP_INHERIT_MODEL_SLUG, updatedAt };
            yield* emit({
              type: "provider_session.updated",
              driver: OMP_PROVIDER,
              providerSession: sessionEntity,
            });
          }
          if (
            thinking === undefined &&
            baselineThinking !== null &&
            appliedThinking !== baselineThinking
          ) {
            yield* request({ type: "set_thinking_level", level: baselineThinking });
            appliedThinking = baselineThinking;
          }
        } else if (modelSelection.model !== appliedModel) {
          const parsed = parseOmpModelSlug(modelSelection.model);
          if (parsed === null) {
            return yield* protocolError(
              `Omp model '${modelSelection.model}' must use provider/model format`,
            );
          }
          const selectedModel = yield* request({
            type: "set_model",
            provider: parsed.provider,
            modelId: parsed.modelId,
          });
          // Omp resets thinking to the target model's configured default on set_model.
          appliedThinking = null;
          contextWindow = rememberModelContextWindow(selectedModel);
          appliedModel = modelSelection.model;
          const updatedAt = yield* DateTime.now;
          sessionEntity = { ...sessionEntity, model: modelSelection.model, updatedAt };
          yield* emit({
            type: "provider_session.updated",
            driver: OMP_PROVIDER,
            providerSession: sessionEntity,
          });
        }
        if (
          thinking !== undefined &&
          thinking !== appliedThinking &&
          OMP_THINKING_LEVELS.has(thinking)
        ) {
          yield* request({ type: "set_thinking_level", level: thinking });
          appliedThinking = thinking;
        }
      });

      const resolvePromptPayload = Effect.fnUntraced(function* (
        text: string,
        attachments: ReadonlyArray<ChatAttachment>,
      ) {
        const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
        const message = yield* providerMessageTextWithAttachmentPaths({
          text,
          attachments,
          resolveAttachmentPath: host.resolveAttachmentPath,
          resolveExtractedTextPath: host.resolveExtractedTextPath,
        });
        for (const attachment of attachments) {
          const path = host.resolveAttachmentPath(attachment);
          if (path === null) continue;
          if (attachment.mimeType.startsWith("image/")) {
            const bytes = yield* fileSystem.readFile(path);
            images.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          }
        }
        return { message, images };
      });

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: OMP_PROVIDER,
        providerSessionId: input.providerSessionId,
        get providerSession() {
          return sessionEntity;
        },
        events: Stream.fromQueue(events),
        hasPendingBackgroundWork: Effect.sync(hasBackgroundWork),
        hasPendingBackgroundWorkForThread: (providerThread, probeOptions) =>
          Effect.sync(
            () =>
              (pendingWake !== null && pendingWake.state.providerThread.id === providerThread.id) ||
              // Jobs left after a yield belong to the session's one thread and end with its process.
              ((nativeBackgroundPending || retainedBackgroundCalls.size > 0) &&
                threadState?.providerThread.id === providerThread.id) ||
              (probeOptions?.includeSubagents === true &&
                Array.from(subagents.values()).some(
                  (subagent) =>
                    subagent.owner.providerThread.id === providerThread.id &&
                    !isTerminalSubagentStatus(subagent.status),
                )),
          ),
        getModelContextWindow: (selection) => {
          if (selection.instanceId !== options.instanceId) return undefined;
          const slug =
            selection.model === OMP_INHERIT_MODEL_SLUG
              ? baselineModel === null
                ? undefined
                : `${baselineModel.provider}/${baselineModel.modelId}`
              : selection.model;
          return slug === undefined ? undefined : modelContextWindows.get(slug);
        },
        ensureThread: (threadInput) =>
          registerThread(threadInput).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver: OMP_PROVIDER,
                  threadId: threadInput.threadId,
                  cause,
                }),
            ),
          ),
        resumeThread: (threadInput) =>
          registerThread({
            threadId:
              threadInput.threadId ?? threadInput.providerThread.appThreadId ?? input.threadId,
            modelSelection: threadInput.modelSelection ?? input.modelSelection,
            runtimePolicy: threadInput.runtimePolicy ?? input.runtimePolicy,
            existingProviderThread: threadInput.providerThread,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterResumeThreadError({
                  driver: OMP_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: threadInput.providerThread.id,
                  cause,
                }),
            ),
          ),
        compactThread: (turnInput) =>
          runtime.startTurn({
            ...turnInput,
            message: { ...turnInput.message, text: "/compact" },
          }),
        startTurn: Effect.fn("OmpAdapter.startTurn")(
          function* (turnInput) {
            if (rollbackBarrier !== null)
              return yield* protocolError("Cannot start a Omp turn during rollback");
            const state = threadState;
            if (state === null) {
              return yield* protocolError("Omp session has no registered thread");
            }
            if (state.activeTurn !== null) {
              return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                driver: OMP_PROVIDER,
                detail: `Omp provider thread ${turnInput.providerThread.id} already has an active turn`,
                reason: "previous_turn_active",
              });
            }
            if (
              state.providerThread.nativeThreadRef?.nativeId !==
              turnInput.providerThread.nativeThreadRef?.nativeId
            ) {
              return yield* protocolError("Omp turn requested for a different native session");
            }
            // Fork adoption uses the orchestrator-allocated row; preserve that identity in later updates.
            const continuation =
              turnInput.message.createdBy === "agent" &&
              turnInput.message.creationSource === "provider";
            if (!continuation) yield* applySelection(turnInput.modelSelection);
            if (turnInput.appThread.title !== appliedSessionName) {
              yield* request({
                type: "set_session_name",
                name: turnInput.appThread.title,
              }).pipe(
                Effect.tap(() =>
                  Effect.sync(() => (appliedSessionName = turnInput.appThread.title)),
                ),
                Effect.ignore,
              );
            }
            // Resolve attachments before turn installation so failures cannot strand activeTurn.
            // Inject instructions through before_agent_start; wrapping user text breaks slash-command expansion.
            const compactCommand = continuation
              ? null
              : parseOmpCompactCommand(turnInput.message.text);
            const payload =
              !continuation && compactCommand === null
                ? yield* resolvePromptPayload(turnInput.message.text, turnInput.message.attachments)
                : null;
            const startedAt = yield* DateTime.now;
            const syntheticNativeTurnId = `${state.providerThread.id}:attempt:${turnInput.attemptId}`;
            const providerTurn: OrchestrationV2ProviderTurn = {
              id: idAllocator.derive.providerTurn({
                driver: OMP_PROVIDER,
                nativeTurnId: syntheticNativeTurnId,
              }),
              providerThreadId: turnInput.providerThread.id,
              nodeId: turnInput.rootNodeId,
              runAttemptId: turnInput.attemptId,
              nativeTurnRef: providerRef(syntheticNativeTurnId, "weak"),
              ordinal: turnInput.providerTurnOrdinal,
              status: "running",
              startedAt,
              completedAt: null,
            };
            const activeTurn: ActiveOmpTurn = {
              turnInput,
              providerTurn,
              startedAt,
              itemOrdinals: new Map(),
              nextItemOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
              messageOrdinal: 0,
              streamItems: new Map(),
              tools: makeOmpToolCalls(),
              interrupted: false,
              nativeAborted: false,
              sawAgentActivity: false,
              adoptedWake: false,
              continuation,
              admittedPrompts: 0,
              promptMayBeCommandOnly:
                compactCommand !== null || (payload?.message.trimStart().startsWith("/") ?? false),
              latestCompactionAfterTokens: null,
              lastLiveUsedTokens: null,
              settleProbeGeneration: 0,
              settleWhenIdle: false,
              sawCompaction: false,
              manualCompactInFlight: compactCommand !== null,
              activeCompaction: null,
              activeProviderRetry: null,
              failure: null,
              rejectedPromptFailure: null,
            };
            // Lock only install/send/start events; correlated setup must leave the pump free for dialogs.
            yield* Effect.gen(function* () {
              if (
                threadState !== state ||
                state.activeTurn !== null ||
                closed ||
                stopRequested ||
                rollbackBarrier !== null ||
                state.providerThread.nativeThreadRef?.nativeId !==
                  turnInput.providerThread.nativeThreadRef?.nativeId
              ) {
                return yield* protocolError("Omp turn ownership changed before it could start");
              }
              const wake = pendingWake?.state === state ? pendingWake : null;
              if (wake !== null && wake.state.providerThread.appThreadId !== turnInput.threadId) {
                return yield* protocolError("Omp native wake belongs to a different app thread");
              }
              pendingWake = null;
              state.providerThread = turnInput.providerThread;
              state.activeTurn = activeTurn;
              activeTurn.adoptedWake = wake !== null && !continuation;
              if (compactCommand !== null) {
                yield* connection.send(compactRpcRecord(compactCommand));
                pendingCompactResponses.push({
                  providerTurnId: providerTurn.id,
                  kind: "turn_start",
                });
              } else if (payload !== null) {
                yield* sendPrompt({
                  providerTurnId: providerTurn.id,
                  kind: "turn_start",
                  record: {
                    type: "prompt",
                    message: payload.message,
                    streamingBehavior: "steer",
                    ...(payload.images.length === 0 ? {} : { images: payload.images }),
                  },
                });
              }
              yield* emit({
                type: "provider_turn.updated",
                driver: OMP_PROVIDER,
                threadId: turnInput.threadId,
                providerTurn,
              });
              yield* updateProviderThread(state, {
                status: "active",
                firstRunOrdinal: state.providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
                lastRunOrdinal: turnInput.runOrdinal,
              });
              yield* updateProviderSession("running", null);
              if (wake !== null) {
                for (const event of wake.events) {
                  if (!continuation && event["type"] === "session_settled") {
                    activeTurn.nativeAborted = event["aborted"] === true;
                    activeTurn.settleWhenIdle = true;
                    continue;
                  }
                  yield* handleSessionEvent(event);
                }
              } else if (continuation) {
                yield* finalizeTurn(state);
              }
              if (outOfTurnExtensionErrors.length > 0) {
                yield* Queue.offer(connection.events, { type: "t3.flush_extension_errors" });
              }
            }).pipe(
              sessionEventPermit.withPermits(1),
              Effect.tapError(() =>
                Effect.sync(() => {
                  if (state.activeTurn === activeTurn) state.activeTurn = null;
                }),
              ),
            );
            // Native prompt_result owns completion; the prompt acknowledgement only admits the request.
          },
          (effect, turnInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver: OMP_PROVIDER,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
              ),
            ),
        ),
        steerTurn: Effect.fn("OmpAdapter.steerTurn")(
          function* (steerInput: ProviderAdapter.ProviderAdapterV2SteerInput) {
            const turn = threadState?.activeTurn ?? null;
            if (turn === null || turn.providerTurn.id !== steerInput.providerTurnId) {
              return yield* protocolError(`Omp turn ${steerInput.providerTurnId} is not active`);
            }
            const compactCommand = parseOmpCompactCommand(steerInput.message.text);
            const payload =
              compactCommand === null
                ? yield* resolvePromptPayload(
                    steerInput.message.text,
                    steerInput.message.attachments,
                  )
                : null;
            // prompt with steer atomically queues or starts; fire-and-forget under the permit avoids dialog deadlocks.
            // /compact uses its RPC, which aborts the agent first.
            yield* sessionEventPermit.withPermits(1)(
              Effect.gen(function* () {
                if (threadState?.activeTurn !== turn) {
                  return yield* protocolError(
                    `Omp turn ${steerInput.providerTurnId} is not active`,
                  );
                }
                if (compactCommand !== null) {
                  turn.manualCompactInFlight = true;
                  yield* connection.send(compactRpcRecord(compactCommand));
                  pendingCompactResponses.push({
                    providerTurnId: turn.providerTurn.id,
                    kind: "steer",
                  });
                } else if (payload !== null) {
                  yield* sendPrompt({
                    providerTurnId: turn.providerTurn.id,
                    kind: "steer",
                    record: {
                      type: "prompt",
                      message: payload.message,
                      streamingBehavior: "steer",
                      ...(payload.images.length === 0 ? {} : { images: payload.images }),
                    },
                  });
                }
                turn.settleProbeGeneration += 1;
              }),
            );
          },
          (effect, steerInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterSteerRunError({
                    driver: OMP_PROVIDER,
                    providerThreadId: steerInput.providerThread.id,
                    providerTurnId: steerInput.providerTurnId,
                    cause,
                  }),
              ),
            ),
        ),
        interruptTurn: Effect.fn("OmpAdapter.interruptTurn")(
          function* (interruptInput) {
            const turn = threadState?.activeTurn ?? null;
            if (turn === null && interruptInput.requestRuntimeRestart === true) {
              // Stop after the run ended: jobs it left, and any run they woke, end with the process.
              if (hasBackgroundWork())
                yield* sessionEventPermit.withPermits(1)(stopBackgroundWork());
              return;
            }
            if (turn === null || turn.providerTurn.id !== interruptInput.providerTurnId) {
              return yield* protocolError(
                `Omp turn ${interruptInput.providerTurnId} is not active`,
              );
            }
            turn.interrupted = true;
            if (
              interruptInput.requestRuntimeRestart === true ||
              turn.settleWhenIdle ||
              turn.activeCompaction !== null ||
              turn.manualCompactInFlight ||
              nativeCompacting
            ) {
              // Generic abort misses manual compaction; terminate so Stop covers /compact and recovery.
              stopRequested = true;
              if (interruptInput.requestRuntimeRestart === true && !turn.settleWhenIdle) {
                yield* clearNativeQueue(turn);
                yield* request({ type: "abort" }, 2_000).pipe(Effect.ignore);
              }
              // Read rollback tree refs before termination breaks requests; the permit lets in-flight capture finish.
              yield* sessionEventPermit.withPermits(1)(
                Effect.gen(function* () {
                  if (threadState?.activeTurn === turn && turn.stopTreeRefs === undefined) {
                    turn.stopTreeRefs = yield* captureTurnTreeRefs(2_000);
                  }
                  yield* connection.terminate;
                }),
              );
              return;
            }
            yield* clearNativeQueue(turn);
            yield* request({ type: "abort" }).pipe(
              Effect.tapError(() => Effect.sync(() => (turn.interrupted = false))),
            );
          },
          (effect, interruptInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterInterruptError({
                    driver: OMP_PROVIDER,
                    providerThreadId: interruptInput.providerThread.id,
                    providerTurnId: interruptInput.providerTurnId,
                    cause,
                  }),
              ),
            ),
        ),
        respondToRuntimeRequest: Effect.fn("OmpAdapter.respondToRuntimeRequest")(
          function* (requestInput) {
            const pending = pendingPrompts.get(String(requestInput.requestId));
            if (pending === undefined) {
              return yield* protocolError(
                `No pending Omp extension request ${requestInput.requestId}`,
              );
            }
            const answeredAt = yield* DateTime.now;
            if (
              pending.expiresAt !== null &&
              DateTime.toEpochMillis(answeredAt) >= pending.expiresAt
            ) {
              pendingPrompts.delete(String(requestInput.requestId));
              yield* cancelPrompt(pending, answeredAt, true);
              return yield* protocolError(
                `Omp extension request ${requestInput.requestId} has expired`,
              );
            }
            const presses =
              pending.askChoice === undefined
                ? undefined
                : ompAskChoicePresses(
                    pending.askChoice,
                    requestInput.answers?.[pending.questionId],
                  );
            const [firstPress, ...laterPresses] = presses ?? [];
            const firstValue =
              firstPress === undefined
                ? undefined
                : "select" in firstPress
                  ? firstPress.select
                  : "done" in firstPress
                    ? pending.askChoice?.doneLabel
                    : undefined;
            const formResult =
              pending.form === undefined || requestInput.answers === undefined
                ? undefined
                : ompFormSubmission(
                    pending.form.card,
                    pending.form.entries,
                    requestInput.answers,
                    pending.form.accepted,
                  );
            // Answers the form would reject are asked again rather than failing omp's ask.
            const formRetry: OmpFormRetry | undefined =
              pending.form !== undefined && formResult !== undefined && "problems" in formResult
                ? {
                    card: pending.form.card,
                    problems: formResult.problems,
                    accepted: formResult.accepted,
                    expiresAt: pending.expiresAt,
                  }
                : undefined;
            const response: OmpRpcRecord =
              pending.form !== undefined
                ? formResult !== undefined && "data" in formResult
                  ? { data: formResult.data }
                  : { cancelled: true }
                : pending.askChoice === undefined
                  ? ompUiResponse(pending, requestInput.decision, requestInput.answers)
                  : firstValue === undefined
                    ? { cancelled: true }
                    : { value: firstValue };
            queuedAskPresses.length = 0;
            if (firstValue !== undefined) queuedAskPresses.push(...laterPresses);
            const feedback = requestInput.feedback?.trim();
            if (pending.approval !== undefined && feedback !== undefined && feedback.length > 0) {
              // Queued before the denial reaches omp, whose extension then asks for it.
              declinedApprovalFeedback.push({ toolName: pending.approval.toolName, feedback });
            }
            if (formRetry === undefined) {
              yield* connection.send({
                type: "extension_ui_response",
                id: pending.nativeRequestId,
                ...response,
              });
            }
            pendingPrompts.delete(String(requestInput.requestId));
            if (pending.expirationFiber !== null) yield* Fiber.interrupt(pending.expirationFiber);
            if (pending.method === "confirm" && requestInput.decision === "acceptForSession") {
              sessionApprovals.add(pending.approvalKey);
            }
            if (pending.proposedPlan !== undefined) {
              // Approval lets the propose write through, which is when omp leaves plan mode for
              // good; the thread's selection follows, so the next message is not planned.
              const approved = response["value"] === OMP_PLAN_APPROVE_OPTION;
              yield* settlePlan(pending.proposedPlan.plan, approved ? "completed" : "superseded");
              if (approved) {
                const { turnInput } = pending.proposedPlan.turn;
                yield* emit({
                  type: "thread_model_selection.updated",
                  driver: OMP_PROVIDER,
                  threadId: turnInput.threadId,
                  instanceId: options.instanceId,
                  changes: [{ id: OMP_MODE_OPTION_ID, from: OMP_PLAN_MODE, to: "default" }],
                });
              }
            }
            const resolvedAt = yield* DateTime.now;
            pending.runtimeRequest = {
              ...pending.runtimeRequest,
              status: "resolved",
              resolvedAt,
            };
            yield* emit({
              type: "runtime_request.updated",
              driver: OMP_PROVIDER,
              threadId: pending.node.threadId,
              runtimeRequest: pending.runtimeRequest,
            });
            yield* emit({
              type: "node.updated",
              driver: OMP_PROVIDER,
              node: { ...pending.node, status: "completed", completedAt: resolvedAt },
            });
            yield* emit({
              type: "turn_item.updated",
              driver: OMP_PROVIDER,
              turnItem: {
                ...pending.turnItem,
                status: "completed",
                completedAt: resolvedAt,
                updatedAt: resolvedAt,
              },
            });
            if (pending.form !== undefined && formRetry !== undefined) {
              yield* handleExtensionUiRequest(pending.form.event, formRetry);
            }
          },
          (effect, requestInput) =>
            effect.pipe(
              sessionEventPermit.withPermits(1),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                    driver: OMP_PROVIDER,
                    requestId: requestInput.requestId,
                    cause,
                  }),
              ),
            ),
        ),
        readThreadSnapshot: Effect.fn("OmpAdapter.readThreadSnapshot")(
          function* (snapshotInput) {
            const state = threadState;
            const boundNativeId = state?.providerThread.nativeThreadRef?.nativeId;
            const wantedNativeId = snapshotInput.providerThread.nativeThreadRef?.nativeId;
            if (state === null || wantedNativeId == null || boundNativeId !== wantedNativeId) {
              return yield* protocolError(
                "Omp snapshot requested for a thread this session does not host",
              );
            }
            // get_messages contains only the active branch; get_entries would leak abandoned branches into handoffs.
            const messagesData = yield* request({ type: "get_messages" });
            const activeMessages = recordField(messagesData, "messages");
            const threadId = state.providerThread.appThreadId ?? input.threadId;
            const messages = (Array.isArray(activeMessages) ? activeMessages : []).flatMap(
              (message, index) => {
                const role = recordString(message, "role");
                if (role !== "user" && role !== "assistant") return [];
                const text = contentText(recordField(message, "content"));
                if (text.length === 0) return [];
                const timestamp = recordNumber(message, "timestamp");
                const at = Option.getOrElse(
                  DateTime.make(timestamp ?? Number.NaN),
                  () => state.providerThread.createdAt,
                );
                return [
                  {
                    id: idAllocator.derive.messageFromProviderItem({
                      driver: OMP_PROVIDER,
                      nativeItemId: `${wantedNativeId}:snapshot-message:${index}`,
                    }),
                    threadId,
                    runId: null,
                    nodeId: null,
                    role: role as "user" | "assistant",
                    text,
                    attachments: [],
                    streaming: false,
                    createdBy: role === "user" ? ("user" as const) : ("agent" as const),
                    creationSource: "provider" as const,
                    createdAt: at,
                    updatedAt: at,
                  },
                ];
              },
            );
            return {
              providerThread: state.providerThread,
              messages,
              runtimeRequests: [],
            };
          },
          (effect, snapshotInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                    driver: OMP_PROVIDER,
                    providerThreadId: snapshotInput.providerThread.id,
                    cause,
                  }),
              ),
            ),
        ),
        rollbackThread: Effect.fn("OmpAdapter.rollbackThread")(
          function* (rollbackInput) {
            const state = threadState;
            if (state === null) {
              return yield* protocolError("Omp session has no registered thread");
            }
            if (state.providerThread.id !== rollbackInput.providerThread.id) {
              return yield* protocolError(
                "Omp rollback requested for a thread this session does not host",
              );
            }
            if (state.activeTurn !== null) {
              return yield* protocolError("Cannot roll back while a Omp turn is active");
            }
            if (pendingWake !== null) {
              return yield* protocolError("Cannot roll back while native Omp work awaits a turn");
            }
            const boundary = ompForkBoundary(rollbackInput);
            if (boundary.type === "nothing") {
              return ompThreadSnapshot(state.providerThread);
            }
            const forkEntryId = yield* ompForkEntry(
              boundary,
              rollbackInput.providerThread.createdAt,
              request({ type: "get_entries" }),
            );
            return yield* Effect.acquireUseRelease(
              sessionEventPermit.withPermits(1)(
                Effect.gen(function* () {
                  if (
                    rollbackBarrier !== null ||
                    threadState !== state ||
                    state.activeTurn !== null ||
                    pendingWake !== null ||
                    closed ||
                    stopRequested
                  )
                    return yield* protocolError(
                      "Omp rollback ownership changed before its fork could start",
                    );
                  const barrier = yield* Deferred.make<
                    void,
                    ProviderAdapter.ProviderAdapterProtocolError
                  >();
                  rollbackBarrier = barrier;
                  return barrier;
                }),
              ),
              (barrier) =>
                Effect.gen(function* () {
                  const forkData = yield* lifecycleRequest(
                    forkEntryId === null
                      ? { type: "new_session" }
                      : { type: "fork", entryId: forkEntryId },
                  );
                  if (recordField(forkData, "cancelled") === true)
                    return yield* protocolError("A Omp extension cancelled the session fork");
                  const forkState = yield* request({ type: "get_state" }).pipe(
                    Effect.onError(() =>
                      Effect.sync(() => {
                        threadState = null;
                      }),
                    ),
                  );
                  const forkSessionFile = recordString(forkState, "sessionFile");
                  if (forkSessionFile === undefined) {
                    threadState = null;
                    return yield* protocolError("Omp fork did not return a persisted session file");
                  }
                  const entriesData = yield* request({ type: "get_entries" }).pipe(
                    Effect.orElseSucceed(() => undefined),
                  );
                  const leafId = recordString(entriesData, "leafId") ?? null;
                  // RPC responses bypass the pump; drain prior native events before replacing their binding.
                  const queued = yield* Queue.offer(connection.events, {
                    type: "t3.rollback_barrier",
                    barrier,
                  });
                  if (!queued) return yield* protocolError("Omp transport closed during rollback");
                  yield* Deferred.await(barrier);
                  return yield* sessionEventPermit.withPermits(1)(
                    Effect.gen(function* () {
                      if (pendingWake !== null) {
                        yield* stopPendingWake(pendingWake);
                        return yield* protocolError(
                          "Native Omp work started while rollback was changing the session",
                        );
                      }
                      if (
                        threadState !== state ||
                        state.activeTurn !== null ||
                        closed ||
                        stopRequested
                      )
                        return yield* protocolError(
                          "Omp rollback ownership changed during its fork",
                        );
                      lastNativeThreadId = forkSessionFile;
                      appliedModel = null;
                      appliedThinking = null;
                      appliedSessionName = null;
                      lastKnownLeaf = leafId;
                      leafCursorStale = entriesData === undefined;
                      yield* updateProviderThread(state, {
                        nativeThreadRef: providerRef(forkSessionFile),
                        nativeConversationHeadRef: leafId === null ? null : providerRef(leafId),
                      });
                      rollbackBarrier = null;
                      return ompThreadSnapshot(state.providerThread);
                    }),
                  );
                }).pipe(Effect.onInterrupt(() => connection.terminate)),
              (barrier) =>
                Effect.sync(() => {
                  if (rollbackBarrier === barrier) rollbackBarrier = null;
                }),
            );
          },
          (effect, rollbackInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterRollbackThreadError({
                    driver: OMP_PROVIDER,
                    providerThreadId: rollbackInput.providerThread.id,
                    checkpointId: rollbackInput.target.checkpointId,
                    cause,
                  }),
              ),
            ),
        ),
        forkThread: Effect.fn("OmpAdapter.forkThread")(
          function* (forkInput) {
            if (threadState?.activeTurn != null) {
              return yield* protocolError("Cannot fork while a Omp turn is active");
            }
            const source = forkInput.sourceProviderThread;
            const sourceFile = source.nativeThreadRef?.nativeId;
            if (sourceFile == null)
              return yield* protocolError("Omp fork source has no session file");
            const sourceTurns = (forkInput.sourceProviderTurns ?? []).filter(
              (turn) => turn.providerThreadId === source.id,
            );
            const target = sourceTurns.find((turn) => turn.id === forkInput.providerTurnId);
            if (forkInput.providerTurnId !== undefined && target === undefined) {
              return yield* protocolError("Omp fork target turn is missing");
            }
            const boundary: OmpForkBoundary =
              target === undefined
                ? { type: "nothing" }
                : ompForkBoundary({
                    target: { type: "provider_turn", providerTurn: target },
                    providerThreadTurns: sourceTurns,
                  });
            const forkDirectory = `${host.paths.stateDir}/omp-sessions`;
            const forkCopy = `${forkDirectory}/${encodeURIComponent(forkInput.targetThreadId)}.jsonl`;
            yield* fileSystem.makeDirectory(forkDirectory, { recursive: true });
            yield* fileSystem.copyFile(sourceFile, forkCopy);
            const forkLaunch = buildOmpRpcLaunch({
              launchArgs: resolvedLaunchArgs.args,
              environment: options.environment,
              mcpSession: undefined,
              extensionPath: undefined,
              disableExtensions: true,
              disableTools: true,
            });
            const nativeId = yield* Effect.scoped(
              Effect.gen(function* () {
                const forkConnection = yield* makeOmpRpcConnection({
                  command: options.settings.binaryPath || "omp",
                  args: [...forkLaunch.args, "--session-dir", forkDirectory, "--resume", forkCopy],
                  cwd,
                  env: forkLaunch.env,
                });
                yield* Stream.fromQueue(forkConnection.events).pipe(
                  Stream.runDrain,
                  Effect.ignore,
                  Effect.forkScoped,
                );
                const beforeEntry =
                  boundary.type === "nothing"
                    ? null
                    : yield* ompForkEntry(
                        boundary,
                        source.createdAt,
                        forkConnection.request({ type: "get_entries" }),
                      );
                {
                  const result = yield* forkConnection.request(
                    boundary.type === "nothing"
                      ? { type: "fork" }
                      : beforeEntry === null
                        ? { type: "new_session" }
                        : {
                            type: "fork",
                            entryId: beforeEntry,
                          },
                  );
                  if (recordField(result, "cancelled") === true) {
                    return yield* protocolError("A Omp extension cancelled the session fork");
                  }
                }
                const state = yield* forkConnection.request({ type: "get_state" });
                const file = recordString(state, "sessionFile");
                if (file === undefined || file === sourceFile) {
                  return yield* protocolError("Omp fork did not create a distinct session file");
                }
                return file;
              }),
            ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
            const now = yield* DateTime.now;
            return yield* registerThread(
              {
                threadId: forkInput.targetThreadId,
                modelSelection: forkInput.modelSelection ?? input.modelSelection,
                runtimePolicy: forkInput.runtimePolicy ?? input.runtimePolicy,
                existingProviderThread: {
                  ...source,
                  id: idAllocator.derive.providerThread({
                    driver: OMP_PROVIDER,
                    nativeThreadId: nativeId,
                  }),
                  appThreadId: forkInput.targetThreadId,
                  providerSessionId: input.providerSessionId,
                  providerInstanceId: options.instanceId,
                  ownerNodeId: forkInput.ownerNodeId ?? null,
                  nativeThreadRef: providerRef(nativeId),
                  nativeConversationHeadRef: null,
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  pendingBackgroundTasks: [],
                  forkedFrom: {
                    providerThreadId: source.id,
                    ...(forkInput.providerTurnId === undefined
                      ? {}
                      : { providerTurnId: forkInput.providerTurnId }),
                  },
                  createdAt: now,
                  updatedAt: now,
                },
              },
              false,
            );
          },
          (effect, forkInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterForkThreadError({
                    driver: OMP_PROVIDER,
                    providerThreadId: forkInput.sourceProviderThread.id,
                    cause,
                  }),
              ),
            ),
        ),
      };
      return runtime;
    }),
  });
});

interface OmpSessionEntry {
  readonly parentId: string | null;
  readonly isUserMessage: boolean;
  readonly isMessage: boolean;
  /** Omp's `timestamp` as epoch milliseconds; null when missing or unparsable. */
  readonly timestamp: number | null;
}

interface OmpSessionListing {
  readonly entries: ReadonlyMap<string, OmpSessionEntry>;
  readonly leafId: string | null;
}

function ompSessionListing(data: unknown): OmpSessionListing | null {
  const leafId = recordField(data, "leafId");
  const entries = ompSessionEntries(recordField(data, "entries"));
  return entries !== null && (typeof leafId === "string" || leafId === null)
    ? { entries, leafId }
    : null;
}

function ompSessionEntries(entries: unknown): ReadonlyMap<string, OmpSessionEntry> | null {
  const byId = new Map<string, OmpSessionEntry>();
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    const id = recordString(entry, "id");
    const parentId = recordField(entry, "parentId");
    if (id === undefined || byId.has(id) || (parentId !== null && typeof parentId !== "string"))
      return null;
    const timestamp = recordString(entry, "timestamp");
    byId.set(id, {
      parentId,
      isMessage: recordField(entry, "type") === "message",
      isUserMessage:
        recordField(entry, "type") === "message" &&
        recordString(recordField(entry, "message"), "role") === "user",
      timestamp:
        timestamp === undefined
          ? null
          : Option.getOrNull(Option.map(DateTime.make(timestamp), DateTime.toEpochMillis)),
    });
  }
  return byId;
}

function walkOmpBranch(
  entries: ReadonlyMap<string, OmpSessionEntry>,
  leafId: string | null,
  stopAt: string | null,
): {
  readonly entryCount: number;
  readonly userEntryIds: ReadonlyArray<string>;
  readonly reachedStop: boolean;
} | null {
  const visited = new Set<string>();
  const userEntryIds: Array<string> = [];
  let current = leafId;
  while (current !== null && current !== stopAt) {
    const entry = entries.get(current);
    if (entry === undefined) break;
    if (visited.has(current)) return null;
    visited.add(current);
    if (entry.isUserMessage) userEntryIds.push(current);
    current = entry.parentId;
  }
  return { entryCount: visited.size, userEntryIds, reachedStop: current === stopAt };
}

type OmpForkBoundary =
  | { readonly type: "entry"; readonly entryId: string }
  | { readonly type: "nothing" }
  | {
      readonly type: "uncaptured";
      readonly turn: OrchestrationV2ProviderTurn;
      readonly target: OrchestrationV2ProviderTurn | null;
    };

/**
 * Turns without a ref left nothing on the active branch, so the boundary is the first discarded
 * turn that has one. `uncaptured` is a boundary turn still carrying its synthetic ref (only
 * `captureTurnTreeRefs` records strong ones); `ompForkEntry` locates it in the session tree.
 */
function ompForkBoundary(input: {
  readonly target:
    | { readonly type: "thread_start" }
    | { readonly type: "provider_turn"; readonly providerTurn: OrchestrationV2ProviderTurn };
  readonly providerThreadTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
}): OmpForkBoundary {
  const target = input.target.type === "thread_start" ? null : input.target.providerTurn;
  const boundary = input.providerThreadTurns
    .filter((turn) => turn.ordinal > (target?.ordinal ?? 0) && turn.nativeTurnRef !== null)
    .sort((a, b) => a.ordinal - b.ordinal)[0];
  const ref = boundary?.nativeTurnRef;
  if (boundary === undefined || ref == null) return { type: "nothing" };
  return ref.strength === "strong" && ref.nativeId !== null
    ? { type: "entry", entryId: ref.nativeId }
    : { type: "uncaptured", turn: boundary, target };
}

// OMP fork includes the selected entry; T3 discards the boundary user message.
function ompForkEntry<E>(
  boundary: Exclude<OmpForkBoundary, { type: "nothing" }>,
  providerThreadCreatedAt: DateTime.Utc,
  readEntries: Effect.Effect<unknown, E>,
): Effect.Effect<string | null, E | ProviderAdapter.ProviderAdapterProtocolError> {
  return readEntries.pipe(
    Effect.flatMap((data) => {
      const listing = ompSessionListing(data);
      const entryId =
        listing === null
          ? undefined
          : boundary.type === "entry"
            ? boundary.entryId
            : ompUncapturedForkEntry(listing, boundary, providerThreadCreatedAt);
      return entryId === undefined || !listing?.entries.has(entryId)
        ? Effect.fail(
            new ProviderAdapter.ProviderAdapterProtocolError({
              driver: OMP_PROVIDER,
              detail: "OMP rollback boundary was not found in its session tree",
            }),
          )
        : Effect.succeed(ompForkMessageParent(listing.entries, entryId));
    }),
  );
}

/**
 * Omp shares the server clock. An adopted wake can precede its T3 turn, so search from the target
 * turn's end through the boundary turn's end. A boundary turn still running has no end yet, so
 * the window stays open through the tree read. At thread start, use the earlier of thread
 * creation and turn start to include adopted wakes while preserving inherited session history.
 */
function ompUncapturedForkEntry(
  listing: OmpSessionListing,
  boundary: Extract<OmpForkBoundary, { type: "uncaptured" }>,
  providerThreadCreatedAt: DateTime.Utc,
): string | undefined {
  const { startedAt, completedAt } = boundary.turn;
  if (startedAt === null) return undefined;
  const from =
    boundary.target === null
      ? Math.min(DateTime.toEpochMillis(providerThreadCreatedAt), DateTime.toEpochMillis(startedAt))
      : DateTime.toEpochMillis(boundary.target.completedAt ?? startedAt);
  const to = completedAt === null ? Infinity : DateTime.toEpochMillis(completedAt);
  const targetRef = boundary.target?.nativeTurnRef;
  const stopAt = targetRef?.strength === "strong" ? targetRef.nativeId : null;
  if (stopAt !== null && !listing.entries.has(stopAt)) return undefined;
  const walk = walkOmpBranch(listing.entries, listing.leafId, stopAt);
  if (walk === null || !walk.reachedStop) return undefined;
  let earliest: string | undefined;
  for (const id of walk.userEntryIds) {
    const timestamp = listing.entries.get(id)?.timestamp;
    if (timestamp == null) return undefined;
    if (timestamp >= from && timestamp <= to) earliest = id;
  }
  return earliest;
}

function ompExtensionDisplayName(extensionPath: string | undefined): string {
  if (extensionPath === undefined) return "Omp extension";
  const segments = extensionPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const fileName = segments.at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  // Omp loads a directory extension from its index file; the folder names it.
  const name = fileName === "index" ? (segments.at(-2) ?? fileName) : fileName;
  return name.length === 0 ? "Omp extension" : name;
}

function ompThreadSnapshot(
  providerThread: OrchestrationV2ProviderThread,
): ProviderAdapter.ProviderAdapterV2ThreadSnapshot {
  return { providerThread, messages: [], runtimeRequests: [] };
}

function ompQuestion(
  questionId: string,
  method: "select" | "input" | "editor",
  title: string,
  event: OmpRpcRecord,
): OrchestrationV2UserInputQuestion {
  const options =
    method === "select" && Array.isArray(event["options"])
      ? event["options"]
          .filter((option): option is string => typeof option === "string")
          .map((option) => ({
            label: option || "Empty value",
            description: option || "Empty value",
            value: option,
          }))
      : method === "editor"
        ? []
        : [
            {
              label: "Submit empty value",
              description: "Send an empty string to the extension.",
              value: "",
            },
          ];
  // Omp's select and editor dialogs carry only a title, so show it once, as the question.
  // Extensions may send a blank placeholder, which is not a valid question.
  const detail = [recordString(event, "message"), recordString(event, "placeholder")].find(
    (text) => text !== undefined && text.trim().length > 0,
  );
  const questionTitle = title.trim() ? title : "Question";
  return {
    id: questionId,
    header: detail === undefined ? "Question" : questionTitle,
    question: detail ?? questionTitle,
    ...(method === "editor" ? { initialAnswer: recordString(event, "prefill") ?? "" } : {}),
    options,
  };
}

function ompUiResponse(
  pending: PendingOmpPrompt,
  decision: ProviderApprovalDecision | undefined,
  answers: Record<string, unknown> | undefined,
): OmpRpcRecord {
  if (pending.method === "confirm") {
    if (decision === "accept" || decision === "acceptForSession") return { confirmed: true };
    if (decision === "decline") return { confirmed: false };
    return { cancelled: true };
  }
  if (pending.approval !== undefined) {
    const choice = ompApprovalChoice(pending.approval, decision);
    return choice === undefined ? { cancelled: true } : { value: choice };
  }
  if (pending.method === "ask") return ompAskResponse(pending.questions, answers);
  const answer = answers?.[pending.questionId];
  // RPC distinguishes empty dialog values from cancellation (undefined).
  if (typeof answer === "string") return { value: answer };
  return { cancelled: true };
}

export type OmpAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderHost.ProviderHost;

export const OmpAdapterV2Driver: ProviderAdapterDriver<OmpSettings, OmpAdapterV2DriverEnv> = {
  driverKind: OMP_DRIVER_KIND,
  configSchema: OmpSettings,
  defaultConfig: (): OmpSettings => DEFAULT_OMP_SETTINGS,
  create: Effect.fn("OmpAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<OmpSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      return yield* makeOmpAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        continuationRequests,
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: OMP_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create Omp adapter.",
              cause,
            }),
        ),
      ),
  ),
};
