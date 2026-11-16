import { expect, it } from "@effect/vitest";
import {
  isOmpSessionSettled,
  ompAgentEndYielded,
  ompDeliveredAsyncJobs,
  ompPromptFailure,
  ompForkMessageParent,
  ompSubagentJobFailures,
  ompSubagentTitle,
  ompToolFrameJobId,
} from "./lifecycle.ts";

it("reports the session settled only when no background work can wake it", () => {
  expect(
    isOmpSessionSettled({
      isStreaming: false,
      isSettled: false,
      hasPendingAsyncWork: true,
      queuedMessageCount: 0,
    }),
  ).toBe(false);
  expect(
    isOmpSessionSettled({
      isStreaming: false,
      isSettled: true,
      hasPendingAsyncWork: false,
      queuedMessageCount: 0,
    }),
  ).toBe(true);
  expect(isOmpSessionSettled({ isStreaming: false })).toBe(false);
  expect(
    isOmpSessionSettled({
      isStreaming: false,
      isSettled: true,
      hasPendingAsyncWork: false,
      queuedMessageCount: 1,
    }),
  ).toBe(false);
});
it("reads native prompt-result failures without interpreting acceptance as completion", () => {
  expect(ompPromptFailure({ type: "response", command: "prompt", success: true })).toBeUndefined();
  expect(
    ompPromptFailure({
      type: "prompt_result",
      status: "error",
      error: { message: "Cost cap reached" },
    }),
  ).toBe("Cost cap reached");
  expect(
    ompPromptFailure({ type: "prompt_result", status: "completed", sessionSettled: false }),
  ).toBeUndefined();
});

// Frames from an omp 18.20 capture of `sleep 15; echo TOKEN` run as a background job.
it("reads the agent's yield, including from runtimes that omit `yielded`", () => {
  expect(
    ompAgentEndYielded({
      type: "agent_end",
      isTerminal: false,
      yielded: true,
      awaitingAsyncWork: true,
    }),
  ).toBe(true);
  expect(ompAgentEndYielded({ type: "agent_end", isTerminal: false, yielded: false })).toBe(false);
  expect(ompAgentEndYielded({ type: "agent_end", isTerminal: false })).toBe(false);
  expect(ompAgentEndYielded({ type: "agent_end" })).toBe(true);
});

it("matches a delivered job result to the call that started the job", () => {
  const started = {
    type: "tool_execution_end",
    toolCallId: "toolu_01XnKSsw8oUXci9VTJYzVaEW",
    toolName: "bash",
    result: {
      content: [{ type: "text", text: "Backgrounded as job bg_1" }],
      details: { async: { state: "running", jobId: "bg_1", type: "bash" }, timeoutSeconds: 300 },
    },
    isError: false,
  };
  expect(ompToolFrameJobId(started)).toBe("bg_1");
  // The job's final update drops `details.async`, so it cannot end the call by itself.
  expect(
    ompToolFrameJobId({
      type: "tool_execution_update",
      partialResult: { content: [{ type: "text", text: "TOKEN\n" }], details: { wallTimeMs: 1 } },
    }),
  ).toBeUndefined();
  expect(
    ompDeliveredAsyncJobs({
      type: "message_end",
      message: {
        role: "custom",
        customType: "async-result",
        details: {
          jobs: [
            { jobId: "bg_1", type: "bash", status: "completed", label: "sleep 15; echo TOKEN" },
            { jobId: "bg_2", type: "task", status: "lost" },
          ],
        },
      },
    }),
  ).toEqual([
    { jobId: "bg_1", status: "completed" },
    { jobId: "bg_2", status: "failed" },
  ]);
  expect(
    ompDeliveredAsyncJobs({ type: "message_end", message: { role: "assistant", content: [] } }),
  ).toEqual([]);
});

it("forks at the preceding message because native OMP rejects metadata entries", () => {
  const entries = new Map([
    ["model", { parentId: null, isMessage: false }],
    ["first", { parentId: "model", isMessage: true }],
    ["answer", { parentId: "first", isMessage: true }],
    ["settings", { parentId: "answer", isMessage: false }],
    ["next", { parentId: "settings", isMessage: true }],
  ]);
  expect(ompForkMessageParent(entries, "first")).toBeNull();
  expect(ompForkMessageParent(entries, "next")).toBe("answer");
});

it("titles a subagent by its description unless that only repeats the prompt's heading", () => {
  const prompt = "# Target\ncalc.py in the working directory.\n# Change\nNone.";
  expect(ompSubagentTitle({ nativeId: "CalcCounter", description: "# Target", prompt })).toBe(
    "CalcCounter",
  );
  expect(
    ompSubagentTitle({
      nativeId: "LinesCounter",
      description: "## Count lines in lines.txt",
      prompt,
    }),
  ).toBe("Count lines in lines.txt");
  expect(ompSubagentTitle({ nativeId: "FamousBoar", description: null, prompt })).toBe(
    "FamousBoar",
  );
});

it("titles a subagent by its name when omp's generated label is not a label", () => {
  const prompt = "Run `echo ALPHA` and report the output.";
  for (const description of ["<user>", "_next", 'content="none">', "Echo"]) {
    expect(ompSubagentTitle({ nativeId: "AlphaEcho", description, prompt })).toBe("AlphaEcho");
  }
  expect(
    ompSubagentTitle({ nativeId: "AlphaEcho", description: "Run echo ALPHA with bash", prompt }),
  ).toBe("Run echo ALPHA with bash");
});

it("reads a failed subagent job's error without omp's envelope or stack trace", () => {
  const errorText =
    '<task-result id="PunyKrill" agent="broken" status="failed (exit 1)" duration="351ms">\n\n' +
    "<output>\nError: No model selected.\n\nThen use /model to select a model.\n" +
    "    at #ts (/$bunfs/root/chunks/cli.js:1:2)\n    at async #Wo (/$bunfs/root/chunks/cli.js:3:4)\n" +
    "</output>\n</task-result>";
  expect(
    ompSubagentJobFailures({
      details: {
        jobs: [
          { id: "PunyKrill", type: "task", status: "failed", errorText },
          { id: "ObviousSwan", type: "task", status: "completed", resultText: "done" },
          { id: "bash-1", type: "bash", status: "failed", errorText: "exit 1" },
        ],
      },
    }),
  ).toEqual([
    {
      id: "PunyKrill",
      status: "failed",
      error: "Error: No model selected.\n\nThen use /model to select a model.",
    },
  ]);
  expect(ompSubagentJobFailures({ content: [] })).toEqual([]);
});
