// @effect-diagnostics nodeBuiltinImport:off -- The recorded fixture is read synchronously at module load.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { checkOmpProviderStatus } from "./status.ts";

const Frame = Schema.Record(Schema.String, Schema.Unknown);
const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(Frame));
const decodeHeader = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.String,
      metadata: Schema.Struct({ launchArgs: Schema.String }),
    }),
  ),
);
const decodeEntry = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literals(["expect_outbound", "emit_inbound"]),
      frame: Frame,
    }),
  ),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encoder = new TextEncoder();

/**
 * omp 18.20's provider-status discovery recorded by
 * `apps/server/scripts/record-omp-rpc-replay-fixture.ts --scenario status_discovery`:
 * `ready`, protocol v2 negotiation, then get_state, a chunked get_available_models
 * and get_available_commands.
 */
const [headerLine = "", ...entryLines] = NodeFS.readFileSync(
  NodePath.join(import.meta.dirname, "../../test/fixtures/status-discovery.ndjson"),
  "utf8",
)
  .split("\n")
  .filter((line) => line.length > 0);
const header = decodeHeader(headerLine);
const version = header.version;
const entries = entryLines.map((line) => decodeEntry(line));

function processHandle(input: { readonly stdout?: string; readonly exitCode?: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_002),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout:
      input.stdout === undefined ? Stream.empty : Stream.succeed(encoder.encode(input.stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

/** Answers each write with the frames omp sent after it; any write the recording lacks fails. */
const replaySpawner = (writes: Array<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    let cursor = 0;
    const drainInbound = () => {
      while (entries[cursor]?.type === "emit_inbound") {
        Queue.offerUnsafe(stdout, encoder.encode(`${encodeJson(entries[cursor]!.frame)}\n`));
        cursor += 1;
      }
    };
    const expect = (actual: Record<string, unknown>) => {
      const expected = entries[cursor];
      if (expected?.type !== "expect_outbound") {
        throw new Error(`Unrecorded omp write ${JSON.stringify(actual)}`);
      }
      assert.deepEqual(actual, expected.frame);
      cursor += 1;
      drainInbound();
    };
    let buffer = "";
    const stdin = Sink.forEach((chunk: Uint8Array) =>
      Effect.sync(() => {
        buffer += new TextDecoder().decode(chunk);
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines.filter((candidate) => candidate.length > 0)) {
          const frame = decodeFrame(line);
          writes.push(frame);
          expect(frame);
        }
      }),
    );
    return ChildProcessSpawner.make((command) => {
      const args = ChildProcess.isStandardCommand(command) ? [...command.args] : [];
      if (args.includes("--version")) {
        return Effect.succeed(processHandle({ stdout: `omp ${version}\n` }));
      }
      if (!args.includes("rpc-ui")) return Effect.succeed(processHandle({ exitCode: 1 }));
      expect({ type: "process_start", args });
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          ...processHandle({}),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          stdin,
          stdout: Stream.fromQueue(stdout),
        }),
      );
    });
  });

describe("checkOmpProviderStatus against recorded omp discovery", () => {
  it.effect("negotiates protocol v2 and reads the chunked model catalog", () =>
    Effect.gen(function* () {
      const writes: Array<Record<string, unknown>> = [];
      const snapshot = yield* checkOmpProviderStatus({
        enabled: true,
        binaryPath: "omp",
        launchArgs: header.metadata.launchArgs,
        customModels: [],
      }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          yield* replaySpawner(writes),
        ),
      );
      assert.isAbove(
        entries.filter((entry) => entry.frame["type"] === "rpc_chunk").length,
        1,
        "the recording must carry a chunked response",
      );
      assert.deepEqual(writes[0], {
        id: "t3-protocol",
        type: "negotiate_protocol",
        protocolVersion: 2,
      });
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.version, version);
      assert.equal(snapshot.auth.status, "authenticated");
      assert.include(
        snapshot.models.map((model) => model.slug),
        "anthropic/claude-haiku-5-5",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
