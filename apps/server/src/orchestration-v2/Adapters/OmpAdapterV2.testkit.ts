import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderReplayEntry,
  ProviderInstanceId,
  type ResolvedProviderInstanceEnvironment,
  type ProviderReplayTranscript,
  type ProviderReplayEntry as ProviderReplayEntryType,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { ProviderAdapterDriverCreateError } from "@t3tools/provider-core/server/adapterDriver";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import { OMP_PROVIDER, OmpAdapterV2Driver } from "@t3tools/provider-omp/server";

export const OMP_RPC_REPLAY_PROTOCOL = "omp.rpc-ui-jsonl";
export const OMP_REPLAY_ANY = "<any>";
/** Stands in for the provider host's state directory, which differs per run. */
export const OMP_REPLAY_STATE_DIR = "<omp-state>";

const OmpRpcReplayTranscript = Schema.Struct({
  provider: Schema.Literal(OMP_PROVIDER),
  protocol: Schema.Literal(OMP_RPC_REPLAY_PROTOCOL),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(ProviderReplayEntry),
});
type OmpRpcReplayTranscript = typeof OmpRpcReplayTranscript.Type;
const decodeOmpRpcReplayTranscript = Schema.decodeUnknownEffect(OmpRpcReplayTranscript);

class OmpReplayTranscriptDecodeError extends Schema.TaggedError<OmpReplayTranscriptDecodeError>()(
  "OmpReplayTranscriptDecodeError",
  {
    driver: Schema.optional(Schema.String),
    protocol: Schema.optional(Schema.String),
    scenario: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode omp RPC replay transcript for scenario ${this.scenario ?? "<unknown>"}.`;
  }
}

class OmpReplayMismatchError extends Schema.TaggedError<OmpReplayMismatchError>()(
  "OmpReplayMismatchError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    process: Schema.Number,
    label: Schema.optional(Schema.String),
    actualType: Schema.optional(Schema.String),
    expected: Schema.Unknown,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `omp replay frame mismatch at cursor ${this.cursor} (expected ${this.label ?? "<none>"}, received ${this.actualType ?? "<untyped>"} from process ${this.process}) in scenario ${this.scenario}.`;
  }
}

class OmpReplayIncompleteError extends Schema.TaggedError<OmpReplayIncompleteError>()(
  "OmpReplayIncompleteError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    remaining: Schema.Number,
    nextLabel: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `omp replay ended with ${this.remaining} unconsumed entries at cursor ${this.cursor} (next ${this.nextLabel ?? "<none>"}) in scenario ${this.scenario}.`;
  }
}

function entryLabel(entry: ProviderReplayEntryType | undefined): string | undefined {
  if (entry === undefined) return undefined;
  return entry.type === "runtime_exit" ? "runtime_exit" : (entry.label ?? entry.type);
}

const OmpOrchestratorReplayHarnessError = Schema.Union([
  OmpReplayTranscriptDecodeError,
  ProviderAdapterDriverCreateError,
]);
type OmpOrchestratorReplayHarnessError = typeof OmpOrchestratorReplayHarnessError.Type;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function replayValueMatches(expected: unknown, actual: unknown): boolean {
  if (expected === OMP_REPLAY_ANY) return true;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((entry, index) => replayValueMatches(entry, actual[index]))
    );
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...keys].every((key) => replayValueMatches(expected[key], actual[key]));
  }
  return Object.is(expected, actual);
}

const ADAPTER_REQUEST_ID = /^t3-\d+$/u;

function adapterRequestId(frame: unknown): string | undefined {
  const id = isRecord(frame) ? frame.id : undefined;
  return typeof id === "string" && ADAPTER_REQUEST_ID.test(id) ? id : undefined;
}

/** Rebind adapter request ids without pinning counters; ids omp chose (dialogs) stay exact. */
function withRequestId(expected: unknown, actual: unknown): unknown {
  const actualId = adapterRequestId(actual);
  return isRecord(expected) && adapterRequestId(expected) !== undefined && actualId !== undefined
    ? { ...expected, id: actualId }
    : expected;
}

function startsTurn(entry: ProviderReplayEntryType): boolean {
  if (entry.type !== "expect_outbound") return false;
  const type = isRecord(entry.frame) ? entry.frame.type : undefined;
  return type === "prompt" || type === "compact" || type === "process_start";
}

function processStartFrame(command: ChildProcess.Command) {
  const args = ChildProcess.isStandardCommand(command) ? command.args : [];
  return { type: "process_start", args: [...args] };
}

function entryProcess(entry: ProviderReplayEntryType): number {
  const label = entry.type === "runtime_exit" ? undefined : entry.label;
  const match = label === undefined ? null : /@p(\d+)$/u.exec(label);
  return match === null ? 1 : Number(match[1]);
}

/** Transcript label of one omp frame, suffixed with the process ordinal after the first process. */
export function ompRecordLabel(frame: unknown, process: number): string | undefined {
  const base = !isRecord(frame)
    ? undefined
    : frame.type === "response" && typeof frame.command === "string"
      ? `response:${frame.command}`
      : frame.type === "extension_ui_request" && typeof frame.method === "string"
        ? `extension_ui_request:${frame.method}`
        : typeof frame.type === "string"
          ? frame.type
          : undefined;
  if (base === undefined || process === 1) return base;
  return `${base}@p${process}`;
}

const decodeJsonLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function makeLineSplitter() {
  let buffer = "";
  const decoder = new TextDecoder();
  return (chunk: Uint8Array): ReadonlyArray<string> => {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    return lines.map((line) => line.replace(/\r$/u, "")).filter((line) => line.length > 0);
  };
}

function tryDecodeJsonLine(line: string): unknown {
  try {
    return decodeJsonLine(line);
  } catch {
    return undefined;
  }
}

interface OmpReplayProcess {
  readonly ordinal: number;
  readonly stdout: Queue.Queue<Uint8Array, Cause.Done>;
  readonly ids: Map<string, string>;
  open: boolean;
}

/** Adapter fibers can reorder stdin writes; hold matches within the turn until reached, and fail unmatched writes. */
class OmpReplayController {
  private cursor = 0;
  private failure: unknown = null;
  private readonly consumed = new Set<number>();
  private readonly held: Array<{ readonly process: OmpReplayProcess; readonly actual: unknown }> =
    [];
  private readonly processes: Array<OmpReplayProcess> = [];
  private readonly transcript: OmpRpcReplayTranscript;

  constructor(transcript: OmpRpcReplayTranscript) {
    this.transcript = transcript;
  }

  spawn(
    command: ChildProcess.Command,
    stdout: Queue.Queue<Uint8Array, Cause.Done>,
  ): OmpReplayProcess {
    const process: OmpReplayProcess = {
      ordinal: this.processes.length + 1,
      stdout,
      ids: new Map(),
      open: true,
    };
    this.processes.push(process);
    this.receive(process, processStartFrame(command));
    return process;
  }

  receive(process: OmpReplayProcess, actual: unknown): void {
    if (this.failure !== null) return;
    const entries = this.transcript.entries;
    let possible = false;
    for (let index = this.cursor; index < entries.length && !possible; index += 1) {
      const entry = entries[index]!;
      const pending = entry.type === "expect_outbound" && !this.consumed.has(index);
      possible =
        pending &&
        entryProcess(entry) === process.ordinal &&
        replayValueMatches(withRequestId(entry.frame, actual), actual);
      if (!possible && pending && startsTurn(entry)) break;
    }
    if (!possible) {
      const expected = entries[this.cursor];
      const label = entryLabel(expected);
      const actualType = isRecord(actual) ? actual.type : undefined;
      this.fail(
        new OmpReplayMismatchError({
          scenario: this.transcript.scenario,
          cursor: this.cursor,
          process: process.ordinal,
          ...(label === undefined ? {} : { label }),
          ...(typeof actualType === "string" ? { actualType } : {}),
          expected: expected ?? null,
          actual,
        }),
      );
      return;
    }
    this.held.push({ process, actual });
    this.advance();
  }

  close(process: OmpReplayProcess): void {
    process.open = false;
    Queue.endUnsafe(process.stdout);
  }

  assertComplete(): void {
    if (this.failure !== null) throw this.failure;
    if (this.cursor !== this.transcript.entries.length || this.held.length > 0) {
      const nextLabel = entryLabel(this.transcript.entries[this.cursor]);
      throw new OmpReplayIncompleteError({
        scenario: this.transcript.scenario,
        cursor: this.cursor,
        remaining: this.transcript.entries.length - this.cursor,
        ...(nextLabel === undefined ? {} : { nextLabel }),
      });
    }
  }

  private advance(): void {
    let progressed = true;
    while (progressed && this.failure === null) {
      progressed = this.drainInbound();
      for (const [heldIndex, write] of this.held.entries()) {
        if (this.consumePending(write.process, write.actual)) {
          this.held.splice(heldIndex, 1);
          progressed = true;
          break;
        }
      }
    }
  }

  private consumePending(process: OmpReplayProcess, actual: unknown): boolean {
    const entries = this.transcript.entries;
    for (let index = this.cursor; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (entry.type !== "expect_outbound") return false;
      if (this.consumed.has(index) || entryProcess(entry) !== process.ordinal) continue;
      if (!replayValueMatches(withRequestId(entry.frame, actual), actual)) continue;
      const recordedId = adapterRequestId(entry.frame);
      const actualId = adapterRequestId(actual);
      if (recordedId !== undefined && actualId !== undefined) {
        process.ids.set(recordedId, actualId);
      }
      this.consumed.add(index);
      while (this.consumed.has(this.cursor)) this.cursor += 1;
      return true;
    }
    return false;
  }

  private drainInbound(): boolean {
    let emitted = false;
    while (this.failure === null) {
      const entry = this.transcript.entries[this.cursor];
      if (entry?.type === "runtime_exit") {
        this.cursor += 1;
        emitted = true;
        const process = this.processes.at(-1);
        if (process !== undefined) this.close(process);
        continue;
      }
      if (entry?.type !== "emit_inbound") return emitted;
      const process = this.processes[entryProcess(entry) - 1];
      if (process === undefined) return emitted;
      this.cursor += 1;
      emitted = true;
      if (!process.open) continue;
      const frame = entry.frame;
      const recordedId = isRecord(frame) ? frame.id : undefined;
      const reboundId = typeof recordedId === "string" ? process.ids.get(recordedId) : undefined;
      const rebound =
        isRecord(frame) && reboundId !== undefined ? { ...frame, id: reboundId } : frame;
      Queue.offerUnsafe(process.stdout, new TextEncoder().encode(`${encodeJsonLine(rebound)}\n`));
    }
    return emitted;
  }

  private fail(cause: unknown): void {
    if (this.failure !== null) return;
    this.failure = cause;
    for (const process of this.processes) Queue.endUnsafe(process.stdout);
  }
}

/** Deliberately outside the valid pid range so OmpRpc's group signals never land. */
const REPLAY_PID = 999_999_999;

function makeOmpReplaySpawner(
  controller: OmpReplayController,
): ChildProcessSpawner.ChildProcessSpawner["Service"] {
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const process = controller.spawn(command, yield* Queue.unbounded<Uint8Array, Cause.Done>());
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.close(process)));
      const split = makeLineSplitter();
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(REPLAY_PID),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.sync(() => {
            for (const line of split(chunk)) controller.receive(process, decodeJsonLine(line));
          }),
        ),
        stdout: Stream.fromQueue(process.stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
}

export function layer<E, R>(input: {
  readonly scenario: string;
  readonly spawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner, E, R>;
  readonly binaryPath: string;
  readonly launchArgs: string;
  readonly environment?: ResolvedProviderInstanceEnvironment;
}) {
  return ProviderAdapterRegistry.layerFromAdaptersEffect(
    OmpAdapterV2Driver.create({
      instanceId: ProviderInstanceId.make(OMP_PROVIDER),
      environment: input.environment ?? [],
      displayName: undefined,
      enabled: true,
      config: {
        ...OmpAdapterV2Driver.defaultConfig(),
        binaryPath: input.binaryPath,
        launchArgs: input.launchArgs,
      },
    }).pipe(Effect.map((adapter) => [adapter])),
  ).pipe(
    Layer.provide(input.spawner),
    Layer.provide(
      Layer.mergeAll(
        TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
        NodeServices.layer,
        IdAllocator.layer,
      ),
    ),
  );
}

function metadataString(transcript: OmpRpcReplayTranscript, key: string): string {
  const value = transcript.metadata?.[key];
  return typeof value === "string" ? value : "";
}

function replaceDeep(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") return value.replaceAll(from, to);
  if (Array.isArray(value)) return value.map((entry) => replaceDeep(entry, from, to));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, replaceDeep(entry, from, to)]),
  );
}

/**
 * Points the recording's `<omp-state>` paths at this replay's provider-host state directory. The
 * adapter copies a session it resumes into that directory, so the copies the recording switched
 * to are created up front (empty: no omp reads them) and the adapter has nothing to copy.
 */
const materializeStateDir = Effect.fn("OmpReplay.materializeStateDir")(function* (
  transcript: OmpRpcReplayTranscript,
) {
  const host = yield* ProviderHost.ProviderHost;
  const fs = yield* FileSystem.FileSystem;
  const materialized = {
    ...transcript,
    entries: transcript.entries.map((entry) =>
      entry.type === "runtime_exit"
        ? entry
        : { ...entry, frame: replaceDeep(entry.frame, OMP_REPLAY_STATE_DIR, host.paths.stateDir) },
    ),
  };
  for (const entry of materialized.entries) {
    const frame = entry.type === "expect_outbound" ? entry.frame : undefined;
    const sessionPath = isRecord(frame) ? frame.sessionPath : undefined;
    if (typeof sessionPath !== "string" || !sessionPath.startsWith(host.paths.stateDir)) continue;
    yield* fs.makeDirectory(sessionPath.slice(0, sessionPath.lastIndexOf("/")), {
      recursive: true,
    });
    yield* fs.writeFileString(sessionPath, "");
  }
  return materialized;
}, Effect.orDie);

export const OmpOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  OmpRpcReplayTranscript,
  OmpOrchestratorReplayHarnessError
> = {
  driver: OMP_PROVIDER,
  decodeTranscript: (transcript: ProviderReplayTranscript) =>
    decodeOmpRpcReplayTranscript(transcript).pipe(
      Effect.mapError(
        (cause) =>
          new OmpReplayTranscriptDecodeError({
            driver: transcript.provider,
            protocol: transcript.protocol,
            scenario: transcript.scenario,
            cause,
          }),
      ),
    ),
  makeProviderAdapterRegistryLayer: (transcript) =>
    layer({
      scenario: transcript.scenario,
      binaryPath: "omp",
      launchArgs: metadataString(transcript, "launchArgs"),
      spawner: Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.gen(function* () {
          const controller = new OmpReplayController(yield* materializeStateDir(transcript));
          yield* Effect.addFinalizer(() => Effect.sync(() => controller.assertComplete()));
          return makeOmpReplaySpawner(controller);
        }),
      ),
    }),
};

/** omp extension UI requests that wait for an `extension_ui_response`. */
const OMP_DIALOG_METHODS: ReadonlyArray<string> = ["select", "confirm", "input", "editor", "ask"];

/**
 * Wraps the live spawner to record every omp stdin/stdout JSON line. omp names its dialogs with
 * random ids, and a fixture must answer a dialog by id before it exists, so the recorder hands the
 * adapter stable `ui-<n>` ids and translates them back on the way to omp. Recorded frames carry the
 * stable ids, as the adapter saw them.
 */
export function makeOmpRecordingSpawner(
  live: ChildProcessSpawner.ChildProcessSpawner["Service"],
  entries: Array<ProviderReplayEntryType>,
): ChildProcessSpawner.ChildProcessSpawner["Service"] {
  let spawned = 0;
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const handle = yield* live.spawn(command);
      const args = ChildProcess.isStandardCommand(command) ? command.args : [];
      // Only rpc-ui processes speak the protocol; `omp --version` probes pass through untouched.
      if (!args.includes("rpc-ui")) return handle;
      const process = ++spawned;
      const record = (type: "expect_outbound" | "emit_inbound", frame: unknown) => {
        const label = ompRecordLabel(frame, process);
        entries.push({ type, ...(label === undefined ? {} : { label }), frame });
      };
      const stableIds = new Map<string, string>();
      const nativeIds = new Map<string, string>();
      const encoder = new TextEncoder();
      record("expect_outbound", processStartFrame(command));
      const splitIn = makeLineSplitter();
      const splitOut = makeLineSplitter();
      return ChildProcessSpawner.makeHandle({
        ...handle,
        stdin: handle.stdin.pipe(
          Sink.mapInput((chunk: Uint8Array) => {
            const lines = splitIn(chunk).map((line) => {
              const frame = tryDecodeJsonLine(line);
              if (frame === undefined) return line;
              record("expect_outbound", frame);
              const nativeId =
                isRecord(frame) &&
                frame.type === "extension_ui_response" &&
                typeof frame.id === "string"
                  ? nativeIds.get(frame.id)
                  : undefined;
              return nativeId === undefined || !isRecord(frame)
                ? line
                : encodeJsonLine({ ...frame, id: nativeId });
            });
            return encoder.encode(lines.map((line) => `${line}\n`).join(""));
          }),
        ),
        stdout: handle.stdout.pipe(
          Stream.map((chunk) => {
            const lines = splitOut(chunk).map((line) => {
              const frame = tryDecodeJsonLine(line);
              if (frame === undefined) return line;
              const method = isRecord(frame) ? frame.method : undefined;
              if (
                isRecord(frame) &&
                frame.type === "extension_ui_request" &&
                typeof frame.id === "string" &&
                typeof method === "string" &&
                OMP_DIALOG_METHODS.includes(method)
              ) {
                const stableId = `ui-${stableIds.size + 1}`;
                stableIds.set(frame.id, stableId);
                nativeIds.set(stableId, frame.id);
                const stable = { ...frame, id: stableId };
                record("emit_inbound", stable);
                return encodeJsonLine(stable);
              }
              // omp withdraws a dialog (timeout, abort) by naming it in a `cancel` request.
              const targetId =
                isRecord(frame) && method === "cancel" && typeof frame.targetId === "string"
                  ? stableIds.get(frame.targetId)
                  : undefined;
              if (targetId !== undefined && isRecord(frame)) {
                const stable = { ...frame, targetId };
                record("emit_inbound", stable);
                return encodeJsonLine(stable);
              }
              record("emit_inbound", frame);
              return line;
            });
            return encoder.encode(lines.map((line) => `${line}\n`).join(""));
          }),
        ),
      });
    }),
  );
}
