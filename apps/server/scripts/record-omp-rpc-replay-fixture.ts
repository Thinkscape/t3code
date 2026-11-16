// @effect-diagnostics nodeBuiltinImport:off -- Normalization rewrites plain frames outside Effect.
// Records an omp replay fixture from the real `omp --mode rpc-ui` and writes it only once it replays as
// OmpReplayFixtures.integration.test.ts does. One case per run: `node scripts/record-omp-rpc-replay-fixture.ts
// --scenario <fixture|status_discovery> [--verify] [--out <file>] [--scratch <dir>]`; no --scenario lists the cases.
import { pipe } from "effect/Function";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProviderReplayEntry, ProviderReplayTranscript } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";

import {
  makeOmpRecordingSpawner,
  OMP_REPLAY_ANY,
  OMP_REPLAY_STATE_DIR,
  OMP_RPC_REPLAY_PROTOCOL,
  OmpOrchestratorReplayHarness,
  ompRecordLabel,
} from "../src/orchestration-v2/Adapters/OmpAdapterV2.testkit.ts";
import * as OmpAdapterV2Testkit from "../src/orchestration-v2/Adapters/OmpAdapterV2.testkit.ts";
import { OMP_PROVIDER } from "@t3tools/provider-omp/server";
import { OmpSettings } from "@t3tools/provider-omp/settings";
import { checkOmpProviderStatus, ompResumeCopyPath } from "@t3tools/provider-omp/testing";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { provideDeterministicTestRuntime } from "../src/orchestration-v2/testkit/DeterministicRuntime.ts";
import { OMP_REPLAY_FIXTURES } from "../src/orchestration-v2/testkit/fixtures/omp/index.ts";
import { materializeFixtureInput } from "../src/orchestration-v2/testkit/fixtures/shared.ts";
import { runReplayFixture } from "../src/orchestration-v2/testkit/ProviderReplayFixtures.ts";
import { runOrchestratorV2ProviderReplayScenario } from "../src/orchestration-v2/testkit/ProviderReplayHarness.ts";
import { makeCheckpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

// Keep user skills, rules, context files and extensions out of the recording; the T3 extension
// still loads because the adapter names it with `--extension`. omp has no flag to skip the user's
// MCP servers, so their mount notices are dropped (see DROPPED_NOTICE_PREFIXES).
const HERMETIC_LAUNCH_ARGS = "--no-extensions --no-skills --no-rules --no-context-files";
const DROPPED_NOTICE_PREFIXES = ["xd://: mounted"];
const STATUS_DISCOVERY_SCENARIO = "status_discovery";
const STATUS_DISCOVERY_FIXTURE = new URL(
  "../../../packages/provider-omp/test/fixtures/status-discovery.ndjson",
  import.meta.url,
);
const decodeOmpSettings = Schema.decodeEffect(OmpSettings);
const CLOCK_TICK = Duration.millis(20);
// Re-chunked frames stay small but keep protocol v2's chunk reassembly under test.
const RECHUNK_BYTES = 16 * 1024;

function readArgValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const scenario = readArgValue("--scenario");
const verifyOnly = process.argv.includes("--verify");
const ompFixtures = OMP_REPLAY_FIXTURES.flatMap((fixture) =>
  fixture.providers.map((variant) => ({ fixture, variant })),
);
const selected = ompFixtures.find(({ fixture }) => fixture.name === scenario);
if (scenario !== STATUS_DISCOVERY_SCENARIO && selected === undefined) {
  throw new Error(
    `Pass --scenario with an omp fixture, or ${STATUS_DISCOVERY_SCENARIO}: ${ompFixtures
      .map(({ fixture }) => fixture.name)
      .join(", ")}`,
  );
}

const ompBinary = process.env.T3_OMP_BIN ?? "omp";
const home = NodeOS.homedir();
const user = NodeOS.userInfo().username;

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const ISO_TIMESTAMP_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu;
const NORMALIZED_EPOCH_MS = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"));
const SIGNATURE_KEYS = new Set(["signature", "thinkingSignature", "textSignature"]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function realPath(path: string): string {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return path;
  }
}

function entryProcess(entry: ProviderReplayEntry): number {
  const label = entry.type === "runtime_exit" ? undefined : entry.label;
  const match = label === undefined ? null : /@p(\d+)$/u.exec(label);
  return match === null ? 1 : Number(match[1]);
}

type Normalizable = ProviderReplayEntry & { readonly rechunk?: Record<string, unknown> };

/** Joins each rpc_chunk run back into its frame; `rechunk` keeps the run's extra fields. */
function reassembleChunks(entries: ReadonlyArray<ProviderReplayEntry>): Array<Normalizable> {
  const runs = new Map<number, { parts: Array<Buffer>; fields: Record<string, unknown> }>();
  const result: Array<Normalizable> = [];
  for (const entry of entries) {
    const frame = entry.type === "runtime_exit" ? undefined : entry.frame;
    if (entry.type !== "emit_inbound" || !isRecord(frame) || frame.type !== "rpc_chunk") {
      result.push(entry);
      continue;
    }
    const process = entryProcess(entry);
    const { chunkId: _chunkId, index, count, byteLength: _byteLength, data, ...fields } = frame;
    if (index === 0) runs.set(process, { parts: [], fields });
    const run = runs.get(process);
    if (run === undefined || typeof data !== "string") {
      throw new Error(`rpc_chunk run out of order: ${JSON.stringify(frame).slice(0, 200)}`);
    }
    run.parts.push(Buffer.from(data, "base64"));
    if (index !== Number(count) - 1) continue;
    runs.delete(process);
    result.push({
      ...entry,
      frame: JSON.parse(Buffer.concat(run.parts).toString("utf8")),
      rechunk: run.fields,
    });
  }
  return result;
}

function rechunk(
  record: unknown,
  fields: Record<string, unknown>,
  chunkId: string,
): ReadonlyArray<unknown> {
  const bytes = Buffer.from(JSON.stringify(record), "utf8");
  const count = Math.max(2, Math.ceil(bytes.byteLength / RECHUNK_BYTES));
  const size = Math.ceil(bytes.byteLength / count);
  return Array.from({ length: count }, (_, index) => ({
    ...fields,
    type: "rpc_chunk",
    chunkId,
    index,
    count,
    byteLength: bytes.byteLength,
    data: bytes.subarray(index * size, (index + 1) * size).toString("base64"),
  }));
}

/**
 * Normalize both directions consistently so echoed paths, ids and times still match on replay:
 * session files, workspaces, the T3 extension, home and user name, timestamps, UUIDs and
 * signatures. The model catalog keeps only the recorded model.
 */
function normalizeEntries(input: {
  readonly entries: ReadonlyArray<ProviderReplayEntry>;
  readonly workspace: string | undefined;
  readonly sessionDir: string | undefined;
  readonly modelSlug: string;
}): ReadonlyArray<ProviderReplayEntry> {
  const sessionFiles = new Map<string, string>();
  const uuids = new Map<string, string>();
  // UUIDs the adapter writes come from T3's ids (session copies are named after the thread),
  // which the fixture fixes; only omp's own UUIDs change between recordings.
  const t3Uuids = new Set(
    input.entries.flatMap((entry) =>
      entry.type === "expect_outbound"
        ? (JSON.stringify(entry.frame).match(UUID_PATTERN) ?? []).map((uuid) => uuid.toLowerCase())
        : [],
    ),
  );
  const extensionPaths = new Set<string>();
  for (const entry of input.entries) {
    const frame = entry.type === "runtime_exit" ? undefined : entry.frame;
    const args = isRecord(frame) && frame.type === "process_start" ? frame.args : undefined;
    if (!Array.isArray(args)) continue;
    for (let index = 1; index < args.length; index += 1) {
      if (args[index - 1] === "--extension") extensionPaths.add(String(args[index]));
    }
  }
  let timeAnchorMs: number | undefined;
  const shiftTime = (ms: number): number => {
    timeAnchorMs ??= ms;
    return NORMALIZED_EPOCH_MS + (ms - timeAnchorMs);
  };
  const sessionDirs =
    input.sessionDir === undefined
      ? []
      : [...new Set([realPath(input.sessionDir), input.sessionDir])];
  const workspaces =
    input.workspace === undefined ? [] : [...new Set([realPath(input.workspace), input.workspace])];
  const sessionFilePatterns = sessionDirs.map(
    (dir) => new RegExp(`${escapeRegExp(dir)}/[^\\s"'\`]+?\\.jsonl`, "gu"),
  );
  const userPattern = new RegExp(`\\b${escapeRegExp(user)}\\b`, "gu");
  const tmpDirs = [...new Set([realPath(NodeOS.tmpdir()), NodeOS.tmpdir()])].map(escapeRegExp);
  const hostStatePattern = new RegExp(
    `(?:${tmpDirs.join("|")})/t3-provider-host-[^/"'\\s]+/userdata`,
    "gu",
  );
  // The adapter names a resumed session's copy after its source path; rename the recorded copy
  // after the stable source so replay derives the same name.
  const copyNames = new Map<string, string>();
  const copyName = (file: string) => ompResumeCopyPath("", "", file).slice("/".length);
  const normalizeString = (value: string): string => {
    let next = value;
    for (const pattern of sessionFilePatterns) {
      next = next.replace(pattern, (file) => {
        const existing = sessionFiles.get(file);
        if (existing !== undefined) return existing;
        const stable = `/omp-sessions/session-${sessionFiles.size + 1}.jsonl`;
        sessionFiles.set(file, stable);
        copyNames.set(copyName(file), copyName(stable));
        return stable;
      });
    }
    for (const dir of sessionDirs) next = next.replaceAll(dir, "/omp-sessions");
    for (const extension of extensionPaths) next = next.replaceAll(extension, "<t3-extension>");
    for (const workspace of workspaces) next = next.replaceAll(workspace, "<workspace>");
    next = next.replace(hostStatePattern, OMP_REPLAY_STATE_DIR);
    for (const [recorded, stable] of copyNames) next = next.replaceAll(recorded, stable);
    return next
      .replaceAll(home, "~")
      .replace(userPattern, "user")
      .replace(ISO_TIMESTAMP_PATTERN, (iso) =>
        pipe(
          DateTime.makeUnsafe(iso),
          DateTime.toEpochMillis,
          shiftTime,
          DateTime.makeUnsafe,
          DateTime.formatIso,
        ),
      )
      .replace(UUID_PATTERN, (uuid) => {
        if (t3Uuids.has(uuid.toLowerCase())) return uuid;
        const existing = uuids.get(uuid.toLowerCase());
        if (existing !== undefined) return existing;
        const stable = `00000000-0000-4000-8000-${String(uuids.size + 1).padStart(12, "0")}`;
        uuids.set(uuid.toLowerCase(), stable);
        return stable;
      });
  };
  const normalizeValue = (value: unknown): unknown => {
    if (typeof value === "string") return normalizeString(value);
    if (Array.isArray(value)) return value.map(normalizeValue);
    if (!isRecord(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        if (SIGNATURE_KEYS.has(key) && typeof entry === "string") return [key, "<signature>"];
        // get_state carries the machine's whole system prompt and tool manifest; the adapter
        // reads neither, so keep only their shape.
        if (key === "systemPrompt") {
          return [key, Array.isArray(entry) ? ["<system-prompt>"] : "<system-prompt>"];
        }
        if (key === "dumpTools" && Array.isArray(entry)) {
          return [key, entry.map((tool) => ({ name: isRecord(tool) ? tool.name : undefined }))];
        }
        if (
          (key === "timestamp" || key.endsWith("At")) &&
          typeof entry === "number" &&
          entry > 1e12
        ) {
          return [key, shiftTime(entry)];
        }
        return [key, normalizeValue(entry)];
      }),
    );
  };
  const normalizeFrame = (frame: unknown): unknown => {
    if (!isRecord(frame)) return normalizeValue(frame);
    const args = frame.args;
    if (frame.type === "process_start" && Array.isArray(args)) {
      return normalizeValue({
        ...frame,
        args: args.map((arg, index) => (args[index - 1] === "--extension" ? OMP_REPLAY_ANY : arg)),
      });
    }
    const data = frame.data;
    if (frame.command === "get_available_models" && isRecord(data) && Array.isArray(data.models)) {
      return normalizeValue({
        ...frame,
        data: {
          ...data,
          models: data.models.filter(
            (model) => isRecord(model) && `${model.provider}/${model.id}` === input.modelSlug,
          ),
        },
      });
    }
    return normalizeValue(frame);
  };
  let chunkRuns = 0;
  const kept = input.entries.filter((entry) => {
    const frame = entry.type === "emit_inbound" ? entry.frame : undefined;
    const message = isRecord(frame) && frame.type === "notice" ? frame.message : undefined;
    return !(
      typeof message === "string" &&
      DROPPED_NOTICE_PREFIXES.some((prefix) => message.startsWith(prefix))
    );
  });
  return reassembleChunks(kept).flatMap((entry): ReadonlyArray<ProviderReplayEntry> => {
    if (entry.type === "runtime_exit") return [entry];
    const process = entryProcess(entry);
    const frame = normalizeFrame(entry.frame);
    const frames =
      entry.rechunk === undefined
        ? [frame]
        : rechunk(frame, entry.rechunk, `chunk-${(chunkRuns += 1)}`);
    return frames.map((next) => {
      const label = ompRecordLabel(next, process);
      return { type: entry.type, ...(label === undefined ? {} : { label }), frame: next };
    });
  });
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function encodeTranscriptNdjson(transcript: ProviderReplayTranscript): string {
  const { entries, ...metadata } = transcript;
  return [
    encodeJson({ type: "transcript_start", ...metadata }),
    ...entries.map((entry) => encodeJson(entry)),
    "",
  ].join("\n");
}

// Follow wall time for live omp timers while retaining replay's TestClock steps.
const followWallClock = Effect.gen(function* () {
  while (true) {
    yield* TestClock.withLive(Effect.sleep(CLOCK_TICK));
    yield* TestClock.adjust(CLOCK_TICK);
  }
});

const readOmpVersion = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = (yield* spawner.string(ChildProcess.make(ompBinary, ["--version"]))).trim();
  return /\d+\.\d+\.\d+\S*/u.exec(output)?.[0] ?? output;
});

const makeScratch = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const scratch = readArgValue("--scratch");
  if (scratch === undefined) return yield* fs.makeTempDirectory({ prefix: "t3-omp-record-" });
  yield* fs.makeDirectory(scratch, { recursive: true });
  return scratch;
});

/** Writes the fixture, replays it as the integration test does, and restores the old one on failure. */
const writeVerified = Effect.fn("writeVerified")(function* <E>(input: {
  readonly outputPath: string;
  readonly scratch: string;
  readonly ndjson: string;
  readonly verify: Effect.Effect<void, E>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const previous = yield* fs.readFileString(input.outputPath).pipe(Effect.option);
  yield* fs.makeDirectory(path.dirname(input.outputPath), { recursive: true });
  yield* fs.writeFileString(input.outputPath, input.ndjson);
  yield* input.verify.pipe(
    Effect.tapCause(() =>
      Effect.gen(function* () {
        const unverified = path.join(input.scratch, `${scenario}.unverified.ndjson`);
        yield* fs.writeFileString(unverified, input.ndjson);
        if (previous._tag === "Some") yield* fs.writeFileString(input.outputPath, previous.value);
        else yield* fs.remove(input.outputPath, { force: true });
        yield* Console.error(`Replay failed; recording kept at ${unverified}`);
      }),
    ),
  );
});

const recordFixture = Effect.gen(function* () {
  if (selected === undefined) return;
  const { fixture, variant } = selected;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const outputPath = readArgValue("--out") ?? (yield* path.fromFileUrl(variant.transcriptFile));
  const verify = runReplayFixture({
    fixtureName: fixture.name,
    buildInput: fixture.buildInput,
    driver: { ...variant, transcriptFile: NodeURL.pathToFileURL(outputPath) },
    harness: OmpOrchestratorReplayHarness,
  }).pipe(Effect.provide(NodeServices.layer));
  if (verifyOnly) {
    yield* verify;
    yield* Console.log(`Replayed ${outputPath}`);
    return;
  }

  const ompVersion = yield* readOmpVersion;
  const scratch = yield* makeScratch;
  const fixtureInput = fixture.buildInput();
  const workspace = yield* Effect.promise(() =>
    makeCheckpointWorkspace(`omp-rpc-record-${fixture.name}`, fixtureInput.workspaceFiles),
  );
  const sessionDir = path.join(scratch, `sessions-${fixture.name}`);
  yield* fs.makeDirectory(sessionDir, { recursive: true });
  yield* Effect.addFinalizer(() =>
    Effect.all([
      fs.remove(workspace, { recursive: true, force: true }),
      fs.remove(sessionDir, { recursive: true, force: true }),
    ]).pipe(Effect.ignore),
  );
  const launchArgs = `--session-dir ${sessionDir} ${HERMETIC_LAUNCH_ARGS}`;

  const entries: Array<ProviderReplayEntry> = [];
  const placeholder: ProviderReplayTranscript = {
    provider: OMP_PROVIDER,
    protocol: OMP_RPC_REPLAY_PROTOCOL,
    version: ompVersion,
    scenario: fixture.name,
    entries: [],
  };
  const layerRecordingSpawner = Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.map(Effect.service(ChildProcessSpawner.ChildProcessSpawner), (live) =>
      makeOmpRecordingSpawner(live, entries),
    ),
  ).pipe(Layer.provide(NodeServices.layer));
  const continuationOptions =
    variant.runContinuationWorker === true ? { runContinuationWorker: true } : {};

  yield* Effect.gen(function* () {
    yield* followWallClock.pipe(Effect.forkScoped);
    const materialized = yield* materializeFixtureInput({
      scenario: fixture.name,
      fixtureInput,
      driver: variant.driver,
      modelSelection: variant.modelSelection,
    }).pipe(Effect.provide(IdAllocator.layer));
    yield* runOrchestratorV2ProviderReplayScenario(
      {
        name: `${fixture.name}/omp:record`,
        transcript: placeholder,
        commands: materialized.commands,
        steps: materialized.steps,
        projectionThreadIds: materialized.projectionThreadIds,
        runtimePolicyOverride: { ...variant.runtimePolicyOverride, cwd: workspace },
      },
      {
        driver: OMP_PROVIDER,
        decodeTranscript: Effect.succeed,
        makeProviderAdapterRegistryLayer: () =>
          OmpAdapterV2Testkit.layer({
            scenario: fixture.name,
            binaryPath: ompBinary,
            launchArgs,
            spawner: layerRecordingSpawner,
          }),
      },
      continuationOptions,
    );
  }).pipe(
    Effect.scoped,
    provideDeterministicTestRuntime,
    Effect.tapCause(() =>
      Effect.gen(function* () {
        const raw = path.join(scratch, `${fixture.name}.raw.ndjson`);
        yield* fs.writeFileString(raw, entries.map((entry) => encodeJson(entry)).join("\n"));
        yield* Console.error(`Live recording failed; raw frames at ${raw}`);
      }),
    ),
  );

  const transcript = {
    ...placeholder,
    metadata: {
      generatedBy: "live-omp-recorder",
      ompVersion,
      model: variant.modelSelection.model,
      launchArgs: launchArgs.replaceAll(sessionDir, "/omp-sessions"),
    },
    entries: normalizeEntries({
      entries,
      workspace,
      sessionDir,
      modelSlug: variant.modelSelection.model,
    }),
  } satisfies ProviderReplayTranscript;

  yield* writeVerified({ outputPath, scratch, ndjson: encodeTranscriptNdjson(transcript), verify });
  yield* Console.log(`Wrote ${transcript.entries.length} omp RPC replay entries to ${outputPath}`);
});

/** omp's provider-status discovery: `--version`, then an ephemeral rpc-ui catalog exchange. */
const recordStatusDiscovery = Effect.gen(function* () {
  const path = yield* Path.Path;
  const outputPath = readArgValue("--out") ?? (yield* path.fromFileUrl(STATUS_DISCOVERY_FIXTURE));
  const ompVersion = yield* readOmpVersion;
  const scratch = yield* makeScratch;
  const live = yield* ChildProcessSpawner.ChildProcessSpawner;
  const entries: Array<ProviderReplayEntry> = [];
  const settings = yield* decodeOmpSettings({
    enabled: true,
    binaryPath: ompBinary,
    launchArgs: HERMETIC_LAUNCH_ARGS,
  });
  const snapshot = yield* checkOmpProviderStatus(settings, process.env, scratch).pipe(
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      makeOmpRecordingSpawner(live, entries),
    ),
  );
  yield* Console.log(`omp status ${snapshot.status}, auth ${snapshot.auth.status}`);
  const transcript = {
    provider: OMP_PROVIDER,
    protocol: OMP_RPC_REPLAY_PROTOCOL,
    version: ompVersion,
    scenario: STATUS_DISCOVERY_SCENARIO,
    metadata: {
      generatedBy: "live-omp-recorder",
      ompVersion,
      model: "anthropic/claude-haiku-5-5",
      launchArgs: HERMETIC_LAUNCH_ARGS,
    },
    entries: normalizeEntries({
      entries,
      workspace: scratch,
      sessionDir: undefined,
      modelSlug: "anthropic/claude-haiku-5-5",
    }),
  } satisfies ProviderReplayTranscript;
  yield* writeVerified({
    outputPath,
    scratch,
    ndjson: encodeTranscriptNdjson(transcript),
    verify: Effect.void,
  });
  yield* Console.log(`Wrote ${transcript.entries.length} omp status entries to ${outputPath}`);
});

await Effect.runPromise(
  (scenario === STATUS_DISCOVERY_SCENARIO ? recordStatusDiscovery : recordFixture).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);
