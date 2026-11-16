import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { makeOmpChunkAssembler, type OmpRpcRecord, terminateOmpProcess } from "./rpc.ts";

it.effect("lets omp exit on stdin EOF before signalling, so it can cancel its jobs", () =>
  Effect.gen(function* () {
    const signals: Array<string> = [];
    let exited = false;
    const fiber = yield* Effect.forkChild(
      terminateOmpProcess(
        (signal) => (signals.push(signal), true),
        () => exited,
      ),
    );
    yield* TestClock.adjust("1 second");
    exited = true;
    yield* TestClock.adjust("100 millis");
    yield* Fiber.join(fiber);
    expect(signals).toEqual([]);
  }),
);

it.effect("signals an omp that ignores stdin EOF", () =>
  Effect.gen(function* () {
    const signals: Array<string> = [];
    const fiber = yield* Effect.forkChild(
      terminateOmpProcess(
        (signal) => (signals.push(signal), true),
        () => false,
      ),
    );
    yield* TestClock.adjust("5 seconds");
    yield* TestClock.adjust("100 millis");
    expect(signals).toEqual(["SIGTERM"]);
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(fiber);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  }),
);

/** Splits `record` into chunks of the given byte sizes; the last chunk takes the remainder. */
function chunksOf(record: OmpRpcRecord, sizes: ReadonlyArray<number>, chunkId = "rpc-1") {
  const bytes = Buffer.from(JSON.stringify(record), "utf8");
  const frames: Array<OmpRpcRecord> = [];
  let offset = 0;
  for (const [index, size] of sizes.entries()) {
    const end = index === sizes.length - 1 ? bytes.byteLength : offset + size;
    frames.push({
      type: "rpc_chunk",
      chunkId,
      index,
      count: sizes.length,
      byteLength: bytes.byteLength,
      data: bytes.subarray(offset, end).toString("base64"),
    });
    offset = end;
  }
  return (index: number): OmpRpcRecord => {
    const frame = frames[index];
    if (frame === undefined) throw new Error(`no chunk ${index}`);
    return frame;
  };
}

it("passes ordinary frames through untouched", () => {
  const assemble = makeOmpChunkAssembler(() => 1024);
  const frame = { type: "agent_start" };
  expect(assemble(frame)).toEqual({ kind: "record", record: frame });
});

it("reassembles a chunk run split inside a multi-byte character", () => {
  const assemble = makeOmpChunkAssembler(() => 1024);
  const record = { type: "response", id: "t3-1", success: true, data: { text: "naïve — 模型" } };
  // The second boundary lands inside the UTF-8 encoding of "ï".
  const cut = Buffer.from(JSON.stringify(record), "utf8").indexOf(Buffer.from("ï", "utf8")) + 1;
  const chunk = chunksOf(record, [10, cut - 10, 0]);
  expect(assemble(chunk(0))).toEqual({ kind: "pending" });
  expect(assemble(chunk(1))).toEqual({ kind: "pending" });
  expect(assemble(chunk(2))).toEqual({ kind: "record", record });
});

it("drops an interrupted run and still delivers the interrupting frame", () => {
  const assemble = makeOmpChunkAssembler(() => 1024);
  const abandoned = chunksOf({ type: "response", id: "t3-1", success: true, data: "x" }, [8, 0]);
  expect(assemble(abandoned(0))).toEqual({ kind: "pending" });
  const interrupting = { type: "agent_end" };
  const result = assemble(interrupting);
  expect(result.kind).toBe("invalid");
  expect(result).toMatchObject({ record: interrupting });
  // The abandoned run does not leak into the next one.
  const next = { type: "response", id: "t3-2", success: true, data: "next" };
  const chunk = chunksOf(next, [12, 0], "rpc-2");
  expect(assemble(chunk(0))).toEqual({ kind: "pending" });
  expect(assemble(chunk(1))).toEqual({ kind: "record", record: next });
});

it("rejects chunks that are out of sequence, oversized, or do not add up", () => {
  const record = { type: "response", id: "t3-1", success: true, data: "y".repeat(60) };
  const chunk = chunksOf(record, [20, 20, 0]);
  const whole = chunksOf(record, [0]);

  const skipped = makeOmpChunkAssembler(() => 1024);
  expect(skipped(chunk(0))).toEqual({ kind: "pending" });
  expect(skipped(chunk(2)).kind).toBe("invalid");

  const startedMidRun = makeOmpChunkAssembler(() => 1024);
  expect(startedMidRun(chunk(1)).kind).toBe("invalid");

  const overLimit = makeOmpChunkAssembler(() => 16);
  expect(overLimit(chunk(0)).kind).toBe("invalid");

  const endedShort = makeOmpChunkAssembler(() => 1024);
  expect(endedShort({ ...whole(0), byteLength: Number(whole(0)["byteLength"]) + 5 }).kind).toBe(
    "invalid",
  );

  const overran = makeOmpChunkAssembler(() => 1024);
  expect(overran({ ...chunk(0), byteLength: 8 }).kind).toBe("invalid");
});
