// @effect-diagnostics nodeBuiltinImport:off -- Fixtures are read synchronously at module load.
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  makeOmpAdapterV2,
  ompDeviceToolCall,
  ompEditedFileName,
  ompReportedToolCall,
  ompResumeCopyPath,
  type OmpAdapterV2Options,
} from "./adapter.ts";
import { makeOmpRpcConnection, type OmpRpcRecord } from "./rpc.ts";
import {
  OMP_APPROVAL_FEEDBACK_REQUEST_PREFIX,
  OMP_PLAN_APPROVE_OPTION,
  OMP_PLAN_REFINE_OPTION,
  OMP_PLAN_REVIEW_PROMPT,
  OMP_T3_TOOL_RESULT_WIDGET,
} from "./mcpExtensionSource.ts";

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

const decodeJsonLine = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const OMP_INSTANCE_ID = ProviderInstanceId.make("omp");
const THREAD_ID = ThreadId.make("thread-omp-test");
const SESSION_ID = ProviderSessionId.make("provider-session-omp-test");
const FAKE_SESSION_FILE = "/fake/.omp/agent/sessions/--workspace--/0001_abc.jsonl";
/** Deliberately outside the valid pid range so a group-kill can never land. */
const FAKE_PID = 999_999_999;

const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
});

const modelSelection = (model: string): ModelSelection => ({
  instanceId: OMP_INSTANCE_ID,
  model,
});

/** `unanswered` request types get no automatic response; the test emits it. */
const makeFakeOmpWith = Effect.fnUntraced(function* (unanswered: ReadonlyArray<string>) {
  const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const requests = yield* Queue.unbounded<OmpRpcRecord>();
  const emit = (record: OmpRpcRecord) =>
    Queue.offer(stdout, new TextEncoder().encode(`${encodeJsonLine(record)}\n`));
  let buffered = "";
  const spawner = ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(FAKE_PID),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.gen(function* () {
            buffered += new TextDecoder().decode(chunk);
            const lines = buffered.split("\n");
            buffered = lines.pop() ?? "";
            for (const line of lines.filter(Boolean)) {
              const record = decodeJsonLine(line) as OmpRpcRecord;
              yield* Queue.offer(requests, record);
              if (record["type"] === "extension_ui_response") continue;
              if (unanswered.includes(String(record["type"]))) continue;
              const data =
                record["type"] === "get_state"
                  ? {
                      sessionFile: FAKE_SESSION_FILE,
                      isStreaming: false,
                      isSettled: true,
                      hasPendingAsyncWork: false,
                      queuedMessageCount: 0,
                    }
                  : record["type"] === "get_entries"
                    ? { entries: [], leafId: null }
                    : record["type"] === "get_available_models"
                      ? { models: [] }
                      : {};
              yield* emit({
                type: "response",
                id: record["id"],
                command: record["type"],
                success: true,
                data,
              });
            }
          }),
        ),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );
  const takeRequest = (type: string) =>
    Effect.gen(function* () {
      while (true) {
        const request = yield* Queue.take(requests);
        if (request["type"] === type) return request;
      }
    });
  return { spawner, emit, takeRequest, closeStdout: Queue.end(stdout) };
});
const makeFakeOmp = makeFakeOmpWith([]);
type FakeOmp = Effect.Success<typeof makeFakeOmp>;
const makeAdapter = (
  fake: FakeOmp,
  continuationRequests?: OmpAdapterV2Options["continuationRequests"],
) =>
  makeOmpAdapterV2({
    instanceId: OMP_INSTANCE_ID,
    settings: { enabled: true, binaryPath: "omp", launchArgs: "", customModels: [] },
    environment: {},
    ...(continuationRequests === undefined ? {} : { continuationRequests }),
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));

const openRuntime = Effect.fnUntraced(function* (
  fake: FakeOmp,
  model = "default",
  threadId = THREAD_ID,
  providerSessionId = SESSION_ID,
  continuationRequests?: OmpAdapterV2Options["continuationRequests"],
) {
  const adapter = yield* makeAdapter(fake, continuationRequests);
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId,
    modelSelection: modelSelection(model),
    runtimePolicy,
  });
  const emitted = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(emitted, event)),
    Effect.forkScoped,
  );
  const takeEvent = (predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(emitted);
        if (predicate(event)) return event;
      }
    });
  return { runtime, takeEvent };
});

const makeAppThread = Effect.fnUntraced(function* (model: string, threadId = THREAD_ID) {
  const now = yield* DateTime.now;
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: "project:fixture:omp" as OrchestrationV2AppThread["projectId"],
    title: "Omp test thread",
    providerInstanceId: OMP_INSTANCE_ID,
    modelSelection: modelSelection(model),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  } satisfies OrchestrationV2AppThread;
});

const startTurn = Effect.fnUntraced(function* (
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  providerThread: OrchestrationV2ProviderThread,
  model = "default",
  attachments: ReadonlyArray<ChatAttachment> = [],
  text = "Hello omp",
  selection?: ModelSelection,
  runOrdinal = 1,
  threadId = THREAD_ID,
  continuation = false,
) {
  const appThread = yield* makeAppThread(model, threadId);
  const runId = RunId.make(`run:${threadId}:${runOrdinal}`);
  yield* runtime.startTurn({
    appThread,
    threadId,
    runId,
    runOrdinal,
    providerTurnOrdinal: runOrdinal,
    attemptId: RunAttemptId.make(`run-attempt:${runId}:1`),
    rootNodeId: NodeId.make(`node:${runId}:root`),
    providerThread,
    message: {
      messageId: `message:${threadId}:${runOrdinal}` as never,
      text,
      attachments,
      createdBy: continuation ? "agent" : "user",
      creationSource: continuation ? "provider" : "web",
    },
    modelSelection: selection ?? modelSelection(model),
    runtimePolicy,
  });
});

describe("OmpAdapterV2", () => {
  it.effect(
    "renders command-only output and reapplies the selected model and thinking after native config changes",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeOmp;
        const { runtime, takeEvent } = yield* openRuntime(fake, "openai/selected");
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("openai/selected"),
          runtimePolicy,
        });
        const selection = {
          ...modelSelection("openai/selected"),
          options: [{ id: "thinking", value: "high" }],
        };
        yield* startTurn(runtime, providerThread, "openai/selected", [], "/model", selection);
        yield* fake.takeRequest("prompt");
        yield* fake.emit({ type: "command_output", text: "Current model: openai/native" });
        const notice = yield* takeEvent(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "system_notice",
        );
        assert.isTrue(
          notice.type === "turn_item.updated" &&
            notice.turnItem.type === "system_notice" &&
            notice.turnItem.message === "Current model: openai/native",
        );
        yield* fake.emit({
          type: "config_update",
          model: { provider: "openai", id: "native", contextWindow: 32000 },
          thinkingLevel: "low",
        });
        yield* fake.emit({
          type: "prompt_result",
          status: "completed",
          agentInvoked: false,
          sessionSettled: true,
        });
        yield* takeEvent((event) => event.type === "turn.terminal");
        yield* startTurn(runtime, providerThread, "openai/selected", [], "Next", selection, 2);
        const setModel = yield* fake.takeRequest("set_model");
        assert.equal(setModel["modelId"], "selected");
        const setThinking = yield* fake.takeRequest("set_thinking_level");
        assert.equal(setThinking["level"], "high");
        yield* fake.takeRequest("prompt");
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("sends native compaction modes as unchanged prompt commands", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      let ordinal = 0;
      for (const mode of ["soft", "remote", "snapcompact"]) {
        yield* startTurn(
          runtime,
          providerThread,
          "default",
          [],
          `/compact ${mode}`,
          undefined,
          ++ordinal,
        );
        const prompt = yield* fake.takeRequest("prompt");
        assert.equal(prompt["message"], `/compact ${mode}`);
        yield* fake.emit({
          type: "prompt_result",
          status: "completed",
          agentInvoked: false,
          sessionSettled: true,
        });
        yield* takeEvent((event) => event.type === "turn.terminal");
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect(
    "projects manual /compact as a compaction item, and a skipped one without failing",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeOmpWith(["compact"]);
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        const compactionItem = (status: string) =>
          takeEvent(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "compaction" &&
              event.turnItem.status === status,
          );

        yield* startTurn(runtime, providerThread, "default", [], "/compact Keep the code words");
        const compact = yield* fake.takeRequest("compact");
        assert.equal(compact["customInstructions"], "Keep the code words");
        yield* fake.emit({ type: "manual_compaction_start" });
        yield* compactionItem("running");
        yield* fake.emit({
          type: "manual_compaction_end",
          aborted: false,
          result: { summary: "Kept JULIET", firstKeptEntryId: "e1", tokensBefore: 48210 },
        });
        const done = yield* compactionItem("completed");
        assert.isTrue(
          done.type === "turn_item.updated" &&
            done.turnItem.type === "compaction" &&
            done.turnItem.summary === "Kept JULIET" &&
            done.turnItem.beforeTokenCount === 48210,
        );
        yield* fake.emit({
          type: "response",
          id: compact["id"],
          command: "compact",
          success: true,
        });
        const first = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.isTrue(first.type === "turn.terminal" && first.status === "completed");

        yield* startTurn(runtime, providerThread, "default", [], "/compact", undefined, 2);
        const again = yield* fake.takeRequest("compact");
        yield* fake.emit({ type: "manual_compaction_start" });
        yield* fake.emit({
          type: "manual_compaction_end",
          aborted: false,
          skipped: true,
          errorMessage: "Already compacted",
        });
        const skipped = yield* compactionItem("completed");
        assert.isTrue(
          skipped.type === "turn_item.updated" &&
            skipped.turnItem.type === "compaction" &&
            skipped.turnItem.summary === "Already compacted",
        );
        yield* fake.emit({
          type: "response",
          id: again["id"],
          command: "compact",
          success: false,
          error: "Already compacted",
        });
        const second = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.isTrue(second.type === "turn.terminal" && second.status === "completed");
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("ends the run at the agent's yield while its background work keeps running", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "subagent_lifecycle",
        payload: {
          id: "native-child",
          agent: "explore",
          description: "Inspect files",
          status: "started",
          parentToolCallId: "spawn",
        },
      });
      const child = yield* takeEvent(
        (event) => event.type === "subagent.updated" || event.type === "turn.terminal",
      );
      assert.isTrue(child.type === "subagent.updated" && child.subagent.status === "running");
      yield* fake.emit({ type: "agent_end", isTerminal: false, yielded: true, messages: [] });
      yield* fake.emit({ type: "prompt_result", status: "completed", sessionSettled: false });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
      assert.isTrue(yield* runtime.hasPendingBackgroundWork ?? Effect.succeed(false));
      yield* fake.emit({
        type: "subagent_lifecycle",
        payload: {
          id: "native-child",
          agent: "explore",
          status: "completed",
          parentToolCallId: "spawn",
        },
      });
      yield* fake.emit({ type: "session_settled" });
      yield* takeEvent(
        (event) => event.type === "subagent.updated" && event.subagent.status === "completed",
      );
      // Frames are handled in order, so seeing this one means session_settled was handled too.
      yield* fake.emit({ type: "config_update", model: { provider: "probe", id: "settled" } });
      yield* takeEvent(
        (event) =>
          event.type === "provider_session.updated" &&
          event.providerSession.model === "probe/settled",
      );
      assert.isFalse(yield* runtime.hasPendingBackgroundWork ?? Effect.succeed(true));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("cancels a native question when OMP sends its targetId", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "question",
        method: "ask",
        questions: [{ id: "q", question: "Continue?", options: [{ label: "Yes" }] }],
      });
      yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      yield* fake.emit({
        type: "extension_ui_request",
        id: "cancel",
        method: "cancel",
        targetId: "question",
      });
      const cancelled = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "cancelled",
      );
      assert.equal(cancelled.type, "runtime_request.updated");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("emits session-start dialogs before a turn exists", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-trust",
        method: "confirm",
        title: "Run project extensions?",
        message: "This project has .omp/extensions.",
      });
      const pending = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      const requestId =
        pending.type === "runtime_request.updated" ? pending.runtimeRequest.id : undefined;
      yield* runtime.respondToRuntimeRequest({ requestId: requestId!, decision: "accept" });
      const uiResponse = yield* fake.takeRequest("extension_ui_response");
      assert.equal(uiResponse["id"], "ui-trust");
      assert.equal(uiResponse["confirmed"], true);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("cancels startup dialogs when Omp exits before a turn exists", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "startup",
        method: "confirm",
        title: "Trust project?",
      });
      const pending = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      if (pending.type !== "runtime_request.updated") return;
      yield* fake.closeStdout;
      const cancelled = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" &&
          event.runtimeRequest.id === pending.runtimeRequest.id &&
          event.runtimeRequest.status === "cancelled",
      );
      assert.isTrue(cancelled.type === "runtime_request.updated");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("maps omp's own tool approvals to readable T3 approvals and back", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const raise = (frame: OmpRpcRecord) =>
        Effect.gen(function* () {
          yield* fake.emit(frame);
          const request = yield* takeEvent(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          );
          const item = yield* takeEvent(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "approval_request",
          );
          if (request.type !== "runtime_request.updated" || item.type !== "turn_item.updated") {
            return yield* Effect.die("unexpected events");
          }
          return { request: request.runtimeRequest, item: item.turnItem };
        });

      // Frames captured from omp 18.20.0 `--mode rpc-ui --approval-mode always-ask`.
      const write = yield* raise({
        type: "extension_ui_request",
        id: "15cc5bc1b5fbb9d9",
        method: "select",
        title: "Allow tool: write\nPath: b.txt\nContent:\none",
        options: ["Approve", "Approve write for this session", "Deny"],
      });
      assert.equal(write.request.kind, "file-change");
      assert.deepEqual(write.request.responseCapability, {
        type: "live",
        providerSessionId: SESSION_ID,
        supportsFeedback: true,
      });
      assert.isTrue(
        write.item.type === "approval_request" &&
          write.item.requestKind === "file-change" &&
          write.item.prompt === "Path: b.txt\nContent:\none" &&
          // Full access asks only for the user's own prompt rules.
          write.item.fullAccessOverride === "ask_rule",
      );
      yield* runtime.respondToRuntimeRequest({
        requestId: write.request.id,
        decision: "decline",
        feedback: "Write c.txt instead",
      });
      const denied = yield* fake.takeRequest("extension_ui_response");
      assert.deepEqual(denied, {
        type: "extension_ui_response",
        id: "15cc5bc1b5fbb9d9",
        value: "Deny",
      });
      // The extension asks for the decline message right after omp's denial; no card is shown.
      yield* fake.emit({
        type: "extension_ui_request",
        id: "15cc5dd682292af3",
        method: "input",
        title: `${OMP_APPROVAL_FEEDBACK_REQUEST_PREFIX}write`,
      });
      const relayed = yield* fake.takeRequest("extension_ui_response");
      assert.deepEqual(relayed, {
        type: "extension_ui_response",
        id: "15cc5dd682292af3",
        value: "Write c.txt instead",
      });

      const bash = yield* raise({
        type: "extension_ui_request",
        id: "15cc5bbfff7bb9d8",
        method: "select",
        title: "Allow tool: bash\nCommand: echo hi > a.txt",
        options: ["Approve", "Approve bash for this session", "Deny"],
      });
      assert.equal(bash.request.kind, "command");
      assert.isTrue(
        bash.item.type === "approval_request" &&
          bash.item.prompt === "echo hi > a.txt" &&
          bash.item.options?.some(
            (option) =>
              option.decision === "acceptForSession" &&
              option.label === "Approve bash for this session",
          ) === true,
      );
      yield* runtime.respondToRuntimeRequest({
        requestId: bash.request.id,
        decision: "acceptForSession",
      });
      const session = yield* fake.takeRequest("extension_ui_response");
      assert.equal(session["value"], "Approve bash for this session");

      // The only approval a subagent's work gets is its parent's task call (subagents run
      // headless in yolo mode), so that card names the subagents.
      const task = yield* raise({
        type: "extension_ui_request",
        id: "15cc5bdf71c30a89",
        method: "select",
        title:
          "Allow tool: task\nContext:\nSingle subagent run; no shared context.\nBatch agents: task \u00d71\nName: Childy\nAgent: task\nTask:\nrun bash: echo child > child.txt, then yield",
        options: ["Approve", "Approve task for this session", "Deny"],
      });
      assert.equal(task.item.title, "Start subagent Childy");
      assert.isTrue(
        task.item.type === "approval_request" &&
          task.item.prompt?.startsWith("Subagents: Childy\n") === true,
      );
      yield* runtime.respondToRuntimeRequest({ requestId: task.request.id, decision: "accept" });
      const approved = yield* fake.takeRequest("extension_ui_response");
      assert.equal(approved["value"], "Approve");

      // Other extensions' confirmations stay generic command approvals.
      const other = yield* raise({
        type: "extension_ui_request",
        id: "ui-ext",
        method: "confirm",
        title: "Deploy to staging?",
      });
      assert.equal(other.request.kind, "command");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  const makeHandle = (options: {
    readonly exitCode: Effect.Effect<ChildProcessSpawner.ExitCode>;
    readonly stderr: Stream.Stream<Uint8Array>;
  }) =>
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(FAKE_PID),
      exitCode: options.exitCode,
      isRunning: Effect.succeed(true),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.empty,
      stderr: options.stderr,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });

  it.effect("fails closed when OMP cannot load the required permission bridge", () =>
    Effect.gen(function* () {
      const requiredExtensionPath = "/fixture/omp-t3-mcp-extension.ts";
      const connection = yield* makeOmpRpcConnection({
        command: "omp",
        args: [],
        cwd: undefined,
        env: {},
        requiredExtensionPath,
      }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed({
              ...makeHandle({
                exitCode: Effect.never,
                stderr: Stream.succeed(
                  new TextEncoder().encode(
                    `Failed to load extension ${requiredExtensionPath}: unavailable dependency secret-token`,
                  ),
                ),
              }),
              stdout: Stream.never,
            }),
          ),
        ),
      );
      const error = yield* Queue.take(connection.events).pipe(Effect.flip);
      assert.equal(error.operation, "extension");
      assert.notInclude(error.message, "secret-token");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a nonzero exit code instead of an unexplained stdout close", () =>
    Effect.gen(function* () {
      const secret = "API_KEY=super-secret\n";
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          makeHandle({
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
            stderr: Stream.fromIterable([new TextEncoder().encode(secret)]),
          }),
        ),
      );
      const connection = yield* makeOmpRpcConnection({
        command: "omp",
        args: ["--mode", "rpc"],
        cwd: undefined,
        env: {},
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const error = yield* Queue.take(connection.events).pipe(Effect.flip);
      assert.equal(error._tag, "OmpRpcError");
      assert.equal(error.operation, "read");
      assert.equal(error.detail, "omp process exited with code 1");
      assert.isFalse((error.detail ?? "").includes("API_KEY"));
      assert.isFalse((error.detail ?? "").includes("super-secret"));
      assert.isFalse(error.message.includes("API_KEY"));
      assert.isFalse(error.message.includes("super-secret"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

// Frames modelled on a captured two-subagent `task` batch (omp 18.19, subscription level `events`).
const TASK_CALL_ID = "toolu_task";
const SUBAGENT_TEMPLATE = "Complete assignment thoroughly:\n\n";

const subagentLifecycle = (
  id: string,
  status: string,
  extra: Record<string, unknown> = {},
): OmpRpcRecord => ({
  type: "subagent_lifecycle",
  payload: {
    id,
    agent: "task",
    agentSource: "bundled",
    parentToolCallId: TASK_CALL_ID,
    detached: true,
    status,
    index: 0,
    ...extra,
  },
});

const subagentProgress = (
  id: string,
  assignment: string,
  progress: Record<string, unknown>,
): OmpRpcRecord => ({
  type: "subagent_progress",
  payload: {
    index: 0,
    agent: "task",
    agentSource: "bundled",
    task: `${SUBAGENT_TEMPLATE}${assignment}`,
    assignment,
    parentToolCallId: TASK_CALL_ID,
    detached: true,
    progress: {
      id,
      agent: "task",
      status: "running",
      task: `${SUBAGENT_TEMPLATE}${assignment}`,
      assignment,
      recentTools: [],
      recentOutput: [],
      durationMs: 1,
      tokens: 0,
      cost: 0,
      resolvedModelIdentity: "anthropic/claude-haiku-5-5",
      resolvedModel: "anthropic/claude-haiku-5-5:low",
      ...progress,
    },
  },
});

const subagentEvent = (id: string, event: Record<string, unknown>): OmpRpcRecord => ({
  type: "subagent_event",
  payload: { id, event },
});

const subagentMessageEnd = (id: string, role: string, text: string) =>
  subagentEvent(id, { type: "message_end", message: { role, content: [{ type: "text", text }] } });

/** One subagent's whole run: the assignment, a `read`, and a one-line answer. */
const subagentRun = (id: string, file: string, description: string, answer: string) => {
  const assignment = `Read the file ${file} and report how many lines it has.`;
  const readCallId = `toolu_read_${id}`;
  return {
    assignment,
    readCallId,
    started: [
      subagentLifecycle(id, "started"),
      subagentEvent(id, { type: "agent_start" }),
      subagentProgress(id, assignment, {}),
      subagentEvent(id, { type: "message_start", message: { role: "user" } }),
      subagentMessageEnd(id, "user", `${SUBAGENT_TEMPLATE}${assignment}`),
    ],
    work: [
      subagentEvent(id, { type: "message_start", message: { role: "assistant" } }),
      subagentEvent(id, {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: readCallId, name: "read", arguments: { path: file } }],
        },
      }),
      subagentEvent(id, {
        type: "tool_execution_start",
        toolCallId: readCallId,
        toolName: "read",
        args: { path: file },
      }),
      subagentProgress(id, assignment, {
        lastIntent: `Reading ${file}`,
        currentTool: "read",
      }),
      subagentEvent(id, {
        type: "tool_execution_end",
        toolCallId: readCallId,
        toolName: "read",
        result: { content: [{ type: "text", text: "1:a\n2:b" }] },
        isError: false,
      }),
      subagentEvent(id, { type: "message_start", message: { role: "assistant" } }),
      subagentMessageEnd(id, "assistant", answer),
      subagentEvent(id, { type: "agent_end" }),
      subagentProgress(id, assignment, {
        status: "completed",
        description,
        lastIntent: `Reading ${file}`,
        recentOutput: [answer],
      }),
      subagentLifecycle(id, "completed", { description }),
    ],
  };
};

const taskToolFrame = (type: string, extra: Record<string, unknown> = {}): OmpRpcRecord => ({
  type,
  toolCallId: TASK_CALL_ID,
  toolName: "task",
  args: { tasks: [{ agent: "task" }, { agent: "task" }] },
  ...extra,
});

const asyncJobResult = (text: string, state: string, type = "task") => ({
  content: [{ type: "text", text }],
  details: { async: { state, jobId: "job", type } },
});

const collectUntilTerminal = Effect.fnUntraced(function* (
  takeEvent: (
    predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean,
  ) => Effect.Effect<ProviderAdapter.ProviderAdapterV2Event>,
) {
  const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
  yield* takeEvent((event) => {
    events.push(event);
    return event.type === "turn.terminal";
  });
  return events;
});

const turnItemsOf = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
  events.flatMap((event) => (event.type === "turn_item.updated" ? [event.turnItem] : []));

/** The final record of every item, in first-seen order. */
const latestById = <T extends { readonly id: string }>(records: ReadonlyArray<T>) =>
  Array.from(new Map(records.map((record) => [record.id, record])).values());

const settleTurn = Effect.fnUntraced(function* (fake: FakeOmp) {
  yield* fake.emit({ type: "agent_end", messages: [] });
  yield* fake.emit({
    type: "prompt_result",
    agentInvoked: true,
    status: "completed",
    sessionSettled: true,
  });
  yield* fake.emit({ type: "session_settled" });
});

const openTurn = Effect.fnUntraced(function* (fake: FakeOmp) {
  const { runtime, takeEvent } = yield* openRuntime(fake);
  const providerThread = yield* runtime.ensureThread({
    threadId: THREAD_ID,
    modelSelection: modelSelection("default"),
    runtimePolicy,
  });
  yield* startTurn(runtime, providerThread);
  yield* fake.takeRequest("prompt");
  yield* fake.emit({ type: "agent_start" });
  return { runtime, takeEvent };
});

describe("OmpAdapterV2 native subagents", () => {
  it.effect("subscribes to subagent session events", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp;
      const { runtime } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const subscription = yield* fake.takeRequest("set_subagent_subscription");
      assert.equal(subscription["level"], "events");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("projects a two-subagent task batch into rows and read-only child threads", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp;
      const { takeEvent } = yield* openTurn(fake);
      const boar = subagentRun("FamousBoar", "calc.py", "Count lines in calc.py", "2");
      const vole = subagentRun("ArchitecturalVole", "lines.txt", "Count lines in lines.txt", "3");
      for (const frame of [...boar.started, ...vole.started]) yield* fake.emit(frame);
      yield* fake.emit(taskToolFrame("tool_execution_start"));
      yield* fake.emit(
        taskToolFrame("tool_execution_end", {
          result: asyncJobResult("Spawned 2 background agents using task.", "running"),
          isError: false,
        }),
      );
      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "toolu_wait",
        toolName: "wait",
        args: {},
      });
      for (const frame of [...boar.work, ...vole.work]) {
        yield* fake.emit(frame);
        yield* fake.emit(
          taskToolFrame("tool_execution_update", {
            partialResult: asyncJobResult("Running agent...", "running"),
          }),
        );
      }
      yield* fake.emit(
        taskToolFrame("tool_execution_update", {
          partialResult: asyncJobResult("Background task ArchitecturalVole complete.", "completed"),
        }),
      );
      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "toolu_wait",
        toolName: "wait",
        result: { content: [{ type: "text", text: "## Completed (2)" }] },
        isError: false,
      });
      yield* settleTurn(fake);
      const events = yield* collectUntilTerminal(takeEvent);

      const subagents = latestById(
        events.flatMap((event) => (event.type === "subagent.updated" ? [event.subagent] : [])),
      );
      assert.deepEqual(
        subagents.map((subagent) => [
          subagent.title,
          subagent.model,
          subagent.status,
          subagent.result,
          subagent.prompt,
        ]),
        [
          [
            "Count lines in calc.py",
            "anthropic/claude-haiku-5-5:low",
            "completed",
            "2",
            boar.assignment,
          ],
          [
            "Count lines in lines.txt",
            "anthropic/claude-haiku-5-5:low",
            "completed",
            "3",
            vole.assignment,
          ],
        ],
      );

      const items = latestById(turnItemsOf(events));
      const parentItems = items.filter((item) => item.threadId === THREAD_ID);
      const taskItem = parentItems.find(
        (item) => item.type === "dynamic_tool" && item.toolName === "task",
      );
      assert.isDefined(taskItem);
      assert.deepEqual(
        parentItems.filter((item) => item.status === "running").map((item) => item.title),
        [],
      );
      const rows = parentItems.filter((item) => item.type === "subagent");
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(row.parentItemId, taskItem?.id);
        assert.isAbove(row.ordinal, taskItem?.ordinal ?? Number.POSITIVE_INFINITY);
      }

      const childThreads = events.flatMap((event) =>
        event.type === "app_thread.created" ? [event.appThread] : [],
      );
      assert.deepEqual(
        childThreads.map((thread) => [
          thread.lineage.relationshipToParent,
          thread.activeProviderThreadId,
        ]),
        [
          ["subagent", null],
          ["subagent", null],
        ],
      );
      for (const [index, run] of [boar, vole].entries()) {
        const childThread = childThreads[index];
        const row = rows[index];
        assert.isTrue(row?.type === "subagent" && row.childThreadId === childThread?.id);
        assert.equal(subagents[index]?.childThreadId, childThread?.id);
        const transcript = items
          .filter((item) => item.threadId === childThread?.id)
          .toSorted((left, right) => left.ordinal - right.ordinal)
          .map((item) =>
            item.type === "user_message" || item.type === "assistant_message"
              ? [item.type, item.text]
              : item.type === "dynamic_tool"
                ? [item.type, item.toolName, item.status]
                : [item.type],
          );
        assert.deepEqual(transcript, [
          ["user_message", run.assignment],
          ["dynamic_tool", "read", "completed"],
          ["assistant_message", index === 0 ? "2" : "3"],
        ]);
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("completes a subagent row from frames that arrive after its turn ended", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp;
      const { runtime, takeEvent } = yield* openTurn(fake);
      const boar = subagentRun("FamousBoar", "calc.py", "Count lines in calc.py", "2");
      for (const frame of boar.started) yield* fake.emit(frame);
      yield* settleTurn(fake);
      const turnEvents = yield* collectUntilTerminal(takeEvent);
      const started = turnEvents.find((event) => event.type === "subagent.updated");
      assert.isTrue(started?.type === "subagent.updated" && started.subagent.status === "running");
      assert.isTrue(yield* runtime.hasPendingBackgroundWork ?? Effect.succeed(false));

      for (const frame of boar.work) yield* fake.emit(frame);
      const completed = yield* takeEvent(
        (event) => event.type === "subagent.updated" && event.subagent.status === "completed",
      );
      assert.isTrue(
        completed.type === "subagent.updated" &&
          started?.type === "subagent.updated" &&
          completed.subagent.id === started.subagent.id &&
          completed.subagent.runId === started.subagent.runId &&
          completed.subagent.result === "2",
      );
      assert.isFalse(yield* runtime.hasPendingBackgroundWork ?? Effect.succeed(true));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("links a subagent started before its task call to that call", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp;
      const { takeEvent } = yield* openTurn(fake);
      yield* fake.emit(subagentLifecycle("FamousBoar", "started"));
      yield* fake.emit(taskToolFrame("tool_execution_start"));
      yield* settleTurn(fake);
      const events = yield* collectUntilTerminal(takeEvent);
      const items = latestById(turnItemsOf(events));
      const taskItem = items.find((item) => item.type === "dynamic_tool");
      const row = items.find((item) => item.type === "subagent");
      const subagent = events.find((event) => event.type === "subagent.updated");
      assert.isDefined(taskItem);
      assert.equal(row?.parentItemId, taskItem?.id);
      assert.isAbove(row?.ordinal ?? 0, taskItem?.ordinal ?? Number.POSITIVE_INFINITY);
      assert.isTrue(
        subagent?.type === "subagent.updated" &&
          subagent.subagent.parentNodeId === taskItem?.nodeId,
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("runs a child's root turn before the failure omp reported first", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp;
      const { takeEvent } = yield* openTurn(fake);
      // Recorded from omp 18.20: a project agent with an unknown model fails before it starts,
      // and its first frame naming the assignment already says failed.
      yield* fake.emit(subagentLifecycle("InitialTapir", "started"));
      yield* fake.emit(
        subagentProgress("InitialTapir", "Reply exactly: broken done", { status: "failed" }),
      );
      yield* fake.emit(subagentLifecycle("InitialTapir", "failed"));
      yield* settleTurn(fake);
      const childRoots = (yield* collectUntilTerminal(takeEvent)).flatMap((event) =>
        event.type === "node.updated" &&
        event.node.kind === "root_turn" &&
        event.node.threadId !== THREAD_ID
          ? [event.node.status]
          : [],
      );
      assert.deepEqual(childRoots.slice(0, 2), ["running", "failed"]);
      assert.equal(childRoots.at(-1), "failed");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("settles a backgrounded bash call from its job frame and ignores later updates", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp;
      const { takeEvent } = yield* openTurn(fake);
      const bash = (type: string, extra: Record<string, unknown>) =>
        fake.emit({
          type,
          toolCallId: "toolu_bash",
          toolName: "bash",
          args: { command: "sleep 20; echo WAKE" },
          ...extra,
        });
      yield* bash("tool_execution_start", {});
      yield* bash("tool_execution_end", {
        result: asyncJobResult("Running in background", "running", "bash"),
        isError: false,
      });
      yield* bash("tool_execution_update", {
        partialResult: asyncJobResult("WAKE", "completed", "bash"),
      });
      yield* bash("tool_execution_update", {
        partialResult: asyncJobResult("WAKE", "running", "bash"),
      });
      yield* settleTurn(fake);
      const commandStatuses = turnItemsOf(yield* collectUntilTerminal(takeEvent)).flatMap((item) =>
        item.type === "command_execution" ? [item.status] : [],
      );
      assert.deepEqual(commandStatuses, ["running", "running", "completed"]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("settles a call still in the background when its turn ends", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp;
      const { takeEvent } = yield* openTurn(fake);
      yield* fake.emit(taskToolFrame("tool_execution_start"));
      yield* fake.emit(
        taskToolFrame("tool_execution_end", {
          result: asyncJobResult("Spawned 1 background agent.", "running"),
          isError: false,
        }),
      );
      yield* settleTurn(fake);
      const statuses = turnItemsOf(yield* collectUntilTerminal(takeEvent)).flatMap((item) =>
        item.type === "dynamic_tool" ? [item.status] : [],
      );
      assert.equal(statuses.at(-1), "completed");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "streams a subagent's reasoning and answer into its child thread and fails a sibling with its error",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeOmp;
        const opened = yield* openTurn(fake);
        // Every event, including those passed over while waiting for a particular one.
        const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        const takeEvent = (predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
          opened.takeEvent((event) => {
            events.push(event);
            return predicate(event);
          });
        const frames = readSubagentFixture("subagent-batch-one-failed.ndjson");
        const firstTextDelta = frames.findIndex((frame) => {
          const delta = subagentFrameEvent(frame, "ObviousSwan")?.["assistantMessageEvent"];
          return Predicate.isObject(delta) && delta["type"] === "text_delta";
        });
        assert.isAbove(firstTextDelta, 0);
        for (const frame of frames.slice(0, firstTextDelta + 1)) yield* fake.emit(frame);
        // A row change after the delta proves the adapter has buffered it before the clock moves.
        yield* fake.emit({
          type: "subagent_progress",
          payload: { progress: { id: "ObviousSwan", status: "running", lastIntent: "Answering" } },
        });
        yield* takeEvent(
          (event) => event.type === "subagent.updated" && event.subagent.progress === "Answering",
        );
        yield* TestClock.adjust("100 millis");
        const streamed = yield* takeEvent(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.threadId !== THREAD_ID &&
            event.turnItem.type === "assistant_message",
        );
        assert.isTrue(
          streamed.type === "turn_item.updated" &&
            streamed.turnItem.type === "assistant_message" &&
            streamed.turnItem.streaming &&
            streamed.turnItem.status === "running" &&
            streamed.turnItem.text.length > 0 &&
            "calc.py has 2 lines.".startsWith(streamed.turnItem.text),
        );
        for (const frame of frames.slice(firstTextDelta + 1)) yield* fake.emit(frame);
        yield* collectUntilTerminal(takeEvent);

        const subagents = latestById(
          events.flatMap((event) => (event.type === "subagent.updated" ? [event.subagent] : [])),
        );
        assert.deepEqual(
          subagents.map((subagent) => [
            subagent.title,
            subagent.model,
            subagent.status,
            subagent.result,
          ]),
          [
            [
              "Count lines in calc.py",
              "anthropic/claude-haiku-5-5:medium",
              "completed",
              "calc.py has 2 lines.",
            ],
            [
              "PunyKrill",
              "anthropic/claude-nonexistent-9-9",
              "failed",
              "Error: No model selected.\n\nUse /login, set an API key environment variable, or create /home/user/.omp/agent/agent.db\n\nThen use /model to select a model.",
            ],
          ],
        );
        const items = latestById(turnItemsOf(events));
        assert.deepEqual(
          items.filter((item) => item.status === "running").map((item) => item.title),
          [],
        );
        const [swan, krill] = subagents;
        const swanItems = childItems(items, swan?.childThreadId);
        assert.deepEqual(swanItems.map(childItemSummary), [
          ["user_message", "Read calc.py and report how many lines it has.", "completed"],
          ["reasoning", "completed"],
          ["dynamic_tool", "read", "completed"],
          ["assistant_message", "calc.py has 2 lines.", "completed"],
        ]);
        const reasoning = swanItems.find((item) => item.type === "reasoning");
        assert.isTrue(
          reasoning?.type === "reasoning" &&
            reasoning.text.startsWith("I'm going to read calc.py with the read tool"),
        );
        // The streamed deltas and the final message are one item.
        const streamedId = streamed.type === "turn_item.updated" ? streamed.turnItem.id : null;
        assert.equal(swanItems.find((item) => item.type === "assistant_message")?.id, streamedId);
        assert.deepEqual(childItems(items, krill?.childThreadId).map(childItemSummary), [
          ["user_message", "Read lines.txt and report how many lines it has.", "completed"],
          ["error", krill?.result, "failed"],
        ]);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("shows why a stopped subagent stopped and closes the calls it left open", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp;
      const { takeEvent } = yield* openTurn(fake);
      // Omp can kill a subagent before its running call reports an end.
      const frames = readSubagentFixture("subagent-batch-one-aborted.ndjson").filter(
        (frame) => subagentFrameEvent(frame, "AutonomousSkink")?.["type"] !== "tool_execution_end",
      );
      for (const frame of frames) yield* fake.emit(frame);
      const events = yield* collectUntilTerminal(takeEvent);

      const subagents = latestById(
        events.flatMap((event) => (event.type === "subagent.updated" ? [event.subagent] : [])),
      );
      assert.deepEqual(
        subagents.map((subagent) => [subagent.title, subagent.status, subagent.result]),
        [
          ["Count lines in calc.py", "completed", "calc.py has 2 lines."],
          ["Run sleep 30 and echo done", "interrupted", "Request was aborted"],
        ],
      );
      const items = latestById(turnItemsOf(events));
      assert.deepEqual(
        items.filter((item) => item.status === "running").map((item) => item.title),
        [],
      );
      assert.deepEqual(childItems(items, subagents[1]?.childThreadId).map(childItemSummary), [
        [
          "user_message",
          "Run the bash command `sleep 30 && echo done` and report its output.",
          "completed",
        ],
        ["reasoning", "completed"],
        ["command_execution", "bash", "interrupted"],
        ["error", "Request was aborted", "interrupted"],
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});

/** Frames captured from omp 18.20 (`--mode rpc-ui`, subagent subscription `events`), trimmed of bulk. */
const readSubagentFixture = (name: string): ReadonlyArray<OmpRpcRecord> =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, "../../test/fixtures", name), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => decodeJsonLine(line) as OmpRpcRecord);

const subagentFrameEvent = (frame: OmpRpcRecord, id: string) => {
  const payload = frame["payload"];
  if (frame["type"] !== "subagent_event" || !Predicate.isObject(payload) || payload["id"] !== id)
    return undefined;
  const event = payload["event"];
  return Predicate.isObject(event) ? event : undefined;
};

const childItems = (
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  childThreadId: string | null | undefined,
) =>
  items
    .filter((item) => childThreadId != null && item.threadId === childThreadId)
    .toSorted((left, right) => left.ordinal - right.ordinal);

const childItemSummary = (item: OrchestrationV2TurnItem) => {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
      return [item.type, item.text, item.status];
    case "dynamic_tool":
      return [item.type, item.toolName, item.status];
    case "command_execution":
      return [item.type, item.title, item.status];
    case "error":
      return [item.type, item.failure.message, item.status];
    default:
      return [item.type, item.status];
  }
};

/** The html_render frames T3 would draw from these items: tool name and page title. */
const htmlRenderFrames = (items: ReadonlyArray<OrchestrationV2TurnItem>) =>
  items.flatMap((item) => {
    if (item.type !== "dynamic_tool" || item.status !== "completed") return [];
    const page = htmlRenderFromToolItem(item);
    return page === undefined ? [] : [[item.toolName, page.title]];
  });

const isReportFrame = (frame: OmpRpcRecord) => ompReportedToolCall(frame) !== undefined;

// Frames captured from omp 18.20.0 with T3's extension (`t3-tool-report-*.ndjson`); tool,
// subagent and report frames only.
describe("OmpAdapterV2 T3 tool calls the extension reports", () => {
  it.effect("shows a direct html_render device call as exactly one frame", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp;
      const { takeEvent } = yield* openTurn(fake);
      const frames = readSubagentFixture("t3-tool-report-direct.ndjson");
      // omp shows the direct call itself; the extension's report of it must not add a second.
      assert.deepEqual(
        frames.map((frame) => (isReportFrame(frame) ? "report" : frame["type"])),
        ["tool_execution_start", "report", "tool_execution_end"],
      );
      for (const frame of frames) yield* fake.emit(frame);
      yield* settleTurn(fake);
      const items = latestById(turnItemsOf(yield* collectUntilTerminal(takeEvent)));
      assert.deepEqual(
        items.filter((item) => item.type === "dynamic_tool").map((item) => item.toolName),
        ["mcp__t3-code__html_render"],
      );
      assert.deepEqual(htmlRenderFrames(items), [["mcp__t3-code__html_render", "direct route"]]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("shows each html_render an eval cell made, after the eval call", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp;
      const { takeEvent } = yield* openTurn(fake);
      // omp's frames show only the eval call; both renders inside it reach T3 as reports.
      const frames = readSubagentFixture("t3-tool-report-eval-twice.ndjson");
      assert.deepEqual(
        frames.map((frame) => (isReportFrame(frame) ? "report" : frame["toolName"])),
        ["eval", "report", "report", "eval"],
      );
      for (const frame of frames) yield* fake.emit(frame);
      yield* settleTurn(fake);
      const items = latestById(turnItemsOf(yield* collectUntilTerminal(takeEvent)))
        .filter((item) => item.type === "dynamic_tool")
        .toSorted((left, right) => left.ordinal - right.ordinal);
      assert.deepEqual(
        items.map((item) => [item.type === "dynamic_tool" ? item.toolName : null, item.status]),
        [
          ["eval", "completed"],
          ["mcp__t3-code__html_render", "completed"],
          ["mcp__t3-code__html_render", "completed"],
        ],
      );
      assert.deepEqual(htmlRenderFrames(items), [
        ["mcp__t3-code__html_render", "first of two"],
        ["mcp__t3-code__html_render", "second of two"],
      ]);
      assert.isTrue(items.every((item) => item.threadId === THREAD_ID));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each([{ order: "as recorded" }, { order: "report before omp's start frame" }] as const)(
    "shows a subagent's direct and eval renders once each in its child thread ($order)",
    ({ order }) =>
      Effect.gen(function* () {
        const fake = yield* makeFakeOmp;
        const opened = yield* openTurn(fake);
        const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        const takeEvent = (predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
          opened.takeEvent((event) => {
            events.push(event);
            return predicate(event);
          });
        const recorded = readSubagentFixture("t3-tool-report-subagent.ndjson");
        const directReport = recorded.findIndex(isReportFrame);
        const directStart = recorded.findIndex(
          (frame) => subagentFrameEvent(frame, "AwkwardDuck")?.["type"] === "tool_execution_start",
        );
        assert.equal(directReport, directStart + 1);
        // omp delivers the subagent's frames and the extension's report on separate paths, so
        // the report can also arrive first (seen live with omp 18.20.0).
        const frames =
          order === "as recorded"
            ? recorded
            : recorded.map((frame, index) =>
                index === directStart
                  ? recorded[directReport]!
                  : index === directReport
                    ? recorded[directStart]!
                    : frame,
              );
        for (const frame of frames) yield* fake.emit(frame);
        yield* settleTurn(fake);
        yield* collectUntilTerminal(takeEvent);

        const [duck] = latestById(
          events.flatMap((event) => (event.type === "subagent.updated" ? [event.subagent] : [])),
        );
        const updates = turnItemsOf(events);
        const items = latestById(updates);
        const child = childItems(items, duck?.childThreadId);
        assert.deepEqual(child.map(childItemSummary), [
          ["dynamic_tool", "mcp__t3-code__html_render", "completed"],
          ["dynamic_tool", "eval", "completed"],
          ["dynamic_tool", "mcp__t3-code__html_render", "completed"],
        ]);
        assert.deepEqual(htmlRenderFrames(child), [
          ["mcp__t3-code__html_render", "sub direct"],
          ["mcp__t3-code__html_render", "sub eval"],
        ]);
        assert.deepEqual(htmlRenderFrames(items.filter((item) => item.threadId === THREAD_ID)), []);
        // A frame, once drawn, is never taken down again by a later frame of the same call.
        const direct = child[0];
        const statuses = updates
          .filter((item) => item.id === direct?.id)
          .map((item) => item.status);
        const drawn = statuses.indexOf("completed");
        assert.isAbove(drawn, -1);
        assert.isTrue(statuses.slice(drawn).every((status) => status === "completed"));
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it("reads only well-formed reports under the extension's widget key", () => {
    const report = (widgetKey: string, line: unknown): OmpRpcRecord => ({
      type: "extension_ui_request",
      id: "1",
      method: "setWidget",
      widgetKey,
      widgetLines: [typeof line === "string" ? line : JSON.stringify(line)],
    });
    const call = {
      toolCallId: "js-write-1",
      toolName: "mcp__t3-code__html_render",
      args: { a: 1 },
    };
    assert.deepEqual(ompReportedToolCall(report(OMP_T3_TOOL_RESULT_WIDGET, call)), {
      ...call,
      result: undefined,
    });
    assert.equal(ompReportedToolCall(report("autoresearch", call)), undefined);
    assert.equal(ompReportedToolCall(report(OMP_T3_TOOL_RESULT_WIDGET, "{not json")), undefined);
    assert.equal(
      ompReportedToolCall(report(OMP_T3_TOOL_RESULT_WIDGET, { toolName: "x" })),
      undefined,
    );
  });
});

describe("OmpAdapterV2 planning", () => {
  it.effect("projects a recorded todo list and ticks its steps to completed", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      // Recorded from omp 18.20.0: `todo init` with three items, then `todo done` for each.
      for (const frame of readSubagentFixture("todo-three-items.ndjson")) yield* fake.emit(frame);
      const plans: Array<OrchestrationV2PlanArtifact> = [];
      const items: Array<OrchestrationV2TurnItem> = [];
      // Each update emits its plan before its turn item; wait for both of the last one.
      while (plans.length < 4 || items.length < 4) {
        const event = yield* takeEvent(
          (candidate) =>
            candidate.type === "plan.updated" ||
            (candidate.type === "turn_item.updated" && candidate.turnItem.type === "todo_list"),
        );
        if (event.type === "plan.updated") plans.push(event.plan);
        if (event.type === "turn_item.updated") items.push(event.turnItem);
      }
      assert.deepEqual(
        plans.map((plan) => [
          plan.kind,
          plan.status,
          plan.kind === "todo_list" ? plan.steps.map((step) => `${step.text}:${step.status}`) : [],
        ]),
        [
          ["todo_list", "active", ["alpha:running", "beta:pending", "gamma:pending"]],
          ["todo_list", "active", ["alpha:completed", "beta:running", "gamma:pending"]],
          ["todo_list", "active", ["alpha:completed", "beta:completed", "gamma:running"]],
          ["todo_list", "completed", ["alpha:completed", "beta:completed", "gamma:completed"]],
        ],
      );
      // One list per turn, updated in place.
      assert.equal(new Set(plans.map((plan) => plan.id)).size, 1);
      assert.equal(new Set(items.map((item) => item.id)).size, 1);
      const lastItem = items.at(-1);
      assert.isTrue(
        lastItem?.type === "todo_list" &&
          lastItem.planId === plans[0]?.id &&
          lastItem.steps.every((step) => step.status === "completed"),
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("shows a plan review as a plan card and ends plan mode when it is approved", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp;
      const planSelection: ModelSelection = {
        ...modelSelection("default"),
        options: [{ id: "mode", value: "plan" }],
      };
      const adapter = yield* makeAdapter(fake);
      const runtime = yield* adapter.openSession({
        threadId: THREAD_ID,
        providerSessionId: SESSION_ID,
        modelSelection: planSelection,
        runtimePolicy,
      });
      const emitted = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(emitted, event)),
        Effect.forkScoped,
      );
      const takeEvent = (predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
        Effect.gen(function* () {
          while (true) {
            const event = yield* Queue.take(emitted);
            if (predicate(event)) return event;
          }
        });
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: planSelection,
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default", [], "Plan hello.txt", planSelection);
      yield* fake.takeRequest("prompt");
      // Recorded from omp 18.20.0 under `--plan-yolo` with the T3 extension's review hook.
      const [reviewFrame] = readSubagentFixture("plan-review-select.ndjson");
      assert.isDefined(reviewFrame);
      if (reviewFrame === undefined) return;

      const review = Effect.fnUntraced(function* (nativeId: string, choice: string) {
        yield* fake.emit({ ...reviewFrame, id: nativeId });
        const card = yield* takeEvent(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "proposed_plan",
        );
        // The runtime request precedes its question item.
        const pending = yield* takeEvent(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
        );
        const question = yield* takeEvent(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
        );
        if (
          card.type !== "turn_item.updated" ||
          card.turnItem.type !== "proposed_plan" ||
          question.type !== "turn_item.updated" ||
          question.turnItem.type !== "user_input_request" ||
          pending.type !== "runtime_request.updated"
        ) {
          return assert.fail("expected a plan card and its decision question");
        }
        assert.include(card.turnItem.markdown, "create-hello-txt");
        assert.include(card.turnItem.markdown, "1. Check whether hello.txt already exists");
        assert.notInclude(card.turnItem.markdown, OMP_PLAN_REVIEW_PROMPT);
        // The card holds the plan; the question only asks for the decision.
        assert.isTrue(card.turnItem.ordinal < question.turnItem.ordinal);
        assert.equal(question.turnItem.questions[0]?.question, OMP_PLAN_REVIEW_PROMPT);
        assert.deepEqual(
          question.turnItem.questions[0]?.options.map((option) => option.value),
          [OMP_PLAN_APPROVE_OPTION, OMP_PLAN_REFINE_OPTION],
        );
        yield* runtime.respondToRuntimeRequest({
          requestId: pending.runtimeRequest.id,
          answers: { [nativeId]: choice },
        });
        const response = yield* fake.takeRequest("extension_ui_response");
        assert.equal(response["id"], nativeId);
        assert.equal(response["value"], choice);
        const settled = yield* takeEvent(
          (event) =>
            event.type === "plan.updated" &&
            event.plan.kind === "proposed_plan" &&
            event.plan.status !== "active",
        );
        // The resolved request follows any selection change the answer causes.
        let ended: ProviderAdapter.ProviderAdapterV2Event | undefined;
        while (true) {
          const event = yield* Queue.take(emitted);
          if (event.type === "model_option.ended") ended = event;
          if (
            event.type === "runtime_request.updated" &&
            event.runtimeRequest.status === "resolved"
          )
            break;
        }
        return { card: card.turnItem, settled, ended };
      });

      const refined = yield* review("review-1", OMP_PLAN_REFINE_OPTION);
      assert.isTrue(
        refined.settled.type === "plan.updated" &&
          refined.settled.plan.id === refined.card.planId &&
          refined.settled.plan.status === "superseded",
      );
      // Refining keeps omp planning, so the thread stays in Plan.
      assert.notEqual(refined.ended?.type, "model_option.ended");
      const approved = yield* review("review-2", OMP_PLAN_APPROVE_OPTION);
      assert.notEqual(approved.card.planId, refined.card.planId);
      assert.isTrue(
        approved.settled.type === "plan.updated" &&
          approved.settled.plan.id === approved.card.planId &&
          approved.settled.plan.status === "completed",
      );
      // omp has left plan mode for good, so the thread's Mode goes back to its default.
      assert.deepInclude(approved.ended, {
        type: "model_option.ended",
        threadId: THREAD_ID,
        optionId: "mode",
        value: "plan",
      });

      // The same process implements the next message directly.
      yield* fake.emit({
        type: "notice",
        level: "info",
        message:
          'Plan-yolo: plan approved, switched to anthropic/claude-haiku-5-5 to implement "Create-hellotxt-containing-hi".',
        source: "plan-yolo",
      });
      yield* fake.emit({ type: "prompt_result", status: "completed", sessionSettled: true });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
      yield* startTurn(
        runtime,
        providerThread,
        "default",
        [],
        "Also add bye.txt",
        modelSelection("default"),
        2,
      );
      yield* fake.takeRequest("prompt");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("keeps omp running after a turn whose plan was not approved", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const [reviewFrame] = readSubagentFixture("plan-review-select.ndjson");
      if (reviewFrame === undefined) return assert.fail("missing plan review fixture");
      yield* fake.emit(reviewFrame);
      const pending = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      if (pending.type !== "runtime_request.updated") return;
      // Dismissing the review keeps omp planning, so the process must stay.
      yield* runtime.respondToRuntimeRequest({ requestId: pending.runtimeRequest.id });
      yield* fake.emit({ type: "prompt_result", status: "completed", sessionSettled: true });
      yield* takeEvent((event) => event.type === "turn.terminal");
      yield* startTurn(runtime, providerThread, "default", [], "Revise it", undefined, 2);
      yield* fake.takeRequest("prompt");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});

/**
 * One background `bash` job captured from omp 18.20: the run that starts `sleep 15; echo TOKEN`
 * and yields with STARTED, then the job's frames and the run omp starts by itself to answer TOKEN.
 */
const backgroundJobFrames = () => {
  const frames = readSubagentFixture("background-job-wake.ndjson");
  const yieldIndex = frames.findIndex((frame) => frame["type"] === "prompt_result");
  return { firstRun: frames.slice(0, yieldIndex + 1), afterYield: frames.slice(yieldIndex + 1) };
};

const openBackgroundJobTurn = Effect.fnUntraced(function* () {
  const fake = yield* makeFakeOmp;
  const offers = yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
  const { runtime, takeEvent } = yield* openRuntime(fake, "default", THREAD_ID, SESSION_ID, {
    offer: (request) => Queue.offer(offers, request).pipe(Effect.asVoid),
  });
  const providerThread = yield* runtime.ensureThread({
    threadId: THREAD_ID,
    modelSelection: modelSelection("default"),
    runtimePolicy,
  });
  yield* startTurn(runtime, providerThread);
  yield* fake.takeRequest("prompt");
  return { fake, offers, runtime, takeEvent, providerThread, ...backgroundJobFrames() };
});

const commandStatuses = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
  turnItemsOf(events).flatMap((item) => (item.type === "command_execution" ? [item.status] : []));

describe("OmpAdapterV2 background work after the agent yields", () => {
  it.effect("completes the run at the yield and continues once when the job wakes omp", () =>
    Effect.gen(function* () {
      const { fake, offers, runtime, takeEvent, providerThread, firstRun, afterYield } =
        yield* openBackgroundJobTurn();
      for (const frame of firstRun) yield* fake.emit(frame);
      const firstEvents = yield* collectUntilTerminal(takeEvent);
      const firstTerminal = firstEvents.at(-1);
      assert.isTrue(
        firstTerminal?.type === "turn.terminal" &&
          firstTerminal.status === "completed" &&
          firstTerminal.runOrdinal === 1,
      );
      assert.deepEqual(
        latestById(turnItemsOf(firstEvents)).flatMap((item) =>
          item.type === "assistant_message" ? [item.text] : [],
        ),
        ["STARTED"],
      );
      // The job outlives its run, so its item stays running as the thread's pending work.
      assert.equal(commandStatuses(firstEvents).at(-1), "running");
      assert.isTrue(yield* runtime.hasPendingBackgroundWork ?? Effect.succeed(false));
      assert.equal(yield* Queue.size(offers), 0);

      for (const frame of afterYield) yield* fake.emit(frame);
      const offer = yield* Queue.take(offers);
      assert.equal(offer.threadId, THREAD_ID);
      assert.equal(offer.delivery, "adapter_buffered");
      // The orchestrator answers the offer with a provider-created message for run 2.
      yield* startTurn(runtime, providerThread, "default", [], "", undefined, 2, THREAD_ID, true);
      const wakeEvents = yield* collectUntilTerminal(takeEvent);
      const wakeTerminal = wakeEvents.at(-1);
      assert.isTrue(
        wakeTerminal?.type === "turn.terminal" &&
          wakeTerminal.status === "completed" &&
          wakeTerminal.runOrdinal === 2,
      );
      const items = latestById(turnItemsOf(wakeEvents));
      const command = items.find((item) => item.type === "command_execution");
      assert.isTrue(
        command?.type === "command_execution" &&
          command.status === "completed" &&
          command.runId === RunId.make(`run:${THREAD_ID}:1`) &&
          (command.output ?? "").includes("TOKEN"),
      );
      const answer = items.find((item) => item.type === "assistant_message");
      assert.isTrue(
        answer?.type === "assistant_message" &&
          answer.text === "TOKEN" &&
          answer.runId === RunId.make(`run:${THREAD_ID}:2`),
      );
      assert.equal(yield* Queue.size(offers), 0);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("Stop after the yield ends the job and its wake offers no continuation", () =>
    Effect.gen(function* () {
      const { fake, offers, runtime, takeEvent, providerThread, firstRun, afterYield } =
        yield* openBackgroundJobTurn();
      for (const frame of firstRun) yield* fake.emit(frame);
      const terminal = (yield* collectUntilTerminal(takeEvent)).at(-1);
      if (terminal?.type !== "turn.terminal") return assert.fail("the run did not end");
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId: terminal.providerTurnId,
        requestRuntimeRestart: true,
      });
      const stopEvents: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      yield* takeEvent((event) => {
        stopEvents.push(event);
        return (
          event.type === "provider_session.updated" && event.providerSession.status === "stopped"
        );
      });
      assert.equal(commandStatuses(stopEvents).at(-1), "interrupted");
      assert.isFalse(yield* runtime.hasPendingBackgroundWork ?? Effect.succeed(true));
      for (const frame of afterYield) yield* fake.emit(frame);
      assert.equal(yield* Queue.size(offers), 0);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});

describe("ompDeviceToolCall", () => {
  it("projects a write to an xd:// device as a call of that tool", () => {
    assert.deepStrictEqual(
      ompDeviceToolCall("write", {
        path: "xd://mcp__t3-code__html_render",
        content: '{"title":"Dot","html":"<svg/>"}',
      }),
      { toolName: "mcp__t3-code__html_render", args: { title: "Dot", html: "<svg/>" } },
    );
    assert.deepStrictEqual(ompDeviceToolCall("write", { path: "xd://bash", content: "ls" }), {
      toolName: "bash",
      args: "ls",
    });
  });

  it("leaves file writes, docs paths and other tools alone", () => {
    const file = { path: "notes.txt", content: "x" };
    assert.deepStrictEqual(ompDeviceToolCall("write", file), { toolName: "write", args: file });
    const docs = { path: "xd://read/sources", content: "{}" };
    assert.deepStrictEqual(ompDeviceToolCall("write", docs), { toolName: "write", args: docs });
    const read = { path: "xd://mcp__t3-code__html_render" };
    assert.deepStrictEqual(ompDeviceToolCall("read", read), { toolName: "read", args: read });
  });
});

describe("ompEditedFileName", () => {
  it("reads the file from a hashline edit's header when the call has no path", () => {
    // Recorded from omp 18.20's default `edit` tool.
    assert.equal(ompEditedFileName({ input: "[notes.txt#0063]\nPUT 2.=2:\n+gamma" }), "notes.txt");
    assert.equal(ompEditedFileName({ input: "[src/a b.ts#1A2B]\nCUT 3" }), "src/a b.ts");
  });

  it("prefers explicit paths and ignores input without a header", () => {
    assert.equal(ompEditedFileName({ path: "x.txt", input: "[y.txt#00AA]" }), "x.txt");
    assert.equal(ompEditedFileName({ file_path: "z.txt" }), "z.txt");
    assert.isUndefined(ompEditedFileName({ input: "PUT 1:\n+x" }));
  });
});

describe("ompResumeCopyPath", () => {
  it("keeps omp's lock and temp names under NAME_MAX for long source paths", () => {
    // A rollback fork in a deep --session-dir: embedding this path made omp fail to lock the copy.
    const source = `/Users/someone/${"deep/".repeat(20)}2026-11-13T09-57-50-287Z_01a1d457-8e4f-731c-8c9b-733264fa4292.jsonl`;
    const copy = ompResumeCopyPath(
      "/state/omp-sessions",
      "mcp:a7975816-b035-4b66-b564-ce869e7cc345",
      source,
    );
    const name = NodePath.basename(copy);
    assert.strictEqual(NodePath.dirname(copy), "/state/omp-sessions");
    assert.isAtMost(Buffer.byteLength(`.${name}.0123456789abcdef.tmp`), 255);
    assert.isAtMost(Buffer.byteLength(`.${name}.lock.os`), 255);
  });

  it("is stable per thread and source, and distinct across either", () => {
    const copy = ompResumeCopyPath("/s", "thread-a", "/x/one.jsonl");
    assert.strictEqual(ompResumeCopyPath("/s", "thread-a", "/x/one.jsonl"), copy);
    assert.notStrictEqual(ompResumeCopyPath("/s", "thread-a", "/x/two.jsonl"), copy);
    assert.notStrictEqual(ompResumeCopyPath("/s", "thread-b", "/x/one.jsonl"), copy);
  });
});
