import { ompRecordField, ompRecordString } from "./rpc.ts";

export function isOmpSessionSettled(state: unknown): boolean {
  return (
    ompRecordField(state, "isSettled") === true &&
    ompRecordField(state, "hasPendingAsyncWork") === false &&
    ompRecordField(state, "isStreaming") === false &&
    (ompRecordField(state, "queuedMessageCount") ?? 0) === 0
  );
}

export function ompPromptFailure(event: unknown): string | undefined {
  if (
    ompRecordField(event, "type") !== "prompt_result" ||
    ompRecordField(event, "status") !== "error"
  )
    return undefined;
  return ompRecordString(ompRecordField(event, "error"), "message") ?? "OMP prompt failed.";
}

/** Older runtimes omit `yielded`; their `agent_end` hands control back only when terminal. */
export function ompAgentEndYielded(event: unknown): boolean {
  const yielded = ompRecordField(event, "yielded");
  return yielded === undefined ? ompRecordField(event, "isTerminal") !== false : yielded === true;
}

export type OmpAsyncJobStatus = "completed" | "failed" | "cancelled";

/**
 * Jobs whose result omp delivered as an `async-result` message. Their call's own last
 * `tool_execution_update` carries no job state, so this delivery is what ends the call.
 */
export function ompDeliveredAsyncJobs(
  event: unknown,
): ReadonlyArray<{ readonly jobId: string; readonly status: OmpAsyncJobStatus }> {
  if (ompRecordField(event, "type") !== "message_end") return [];
  const message = ompRecordField(event, "message");
  if (
    ompRecordField(message, "role") !== "custom" ||
    ompRecordField(message, "customType") !== "async-result"
  )
    return [];
  const jobs = ompRecordField(ompRecordField(message, "details"), "jobs");
  if (!Array.isArray(jobs)) return [];
  return jobs.flatMap((job) => {
    const jobId = ompRecordString(job, "jobId");
    const status = ompRecordString(job, "status");
    if (jobId === undefined) return [];
    return [
      {
        jobId,
        status: status === "completed" || status === "cancelled" ? status : ("failed" as const),
      },
    ];
  });
}

/** The background job a tool frame reports, from its result's `details.async`. */
export function ompToolFrameJobId(event: unknown): string | undefined {
  const result = ompRecordField(event, "result") ?? ompRecordField(event, "partialResult");
  return ompRecordString(ompRecordField(ompRecordField(result, "details"), "async"), "jobId");
}

export function ompForkMessageParent(
  entries: ReadonlyMap<string, { readonly parentId: string | null; readonly isMessage: boolean }>,
  boundaryId: string,
): string | null {
  const visited = new Set<string>();
  let current = entries.get(boundaryId)?.parentId ?? null;
  while (current !== null && !visited.has(current)) {
    visited.add(current);
    const entry = entries.get(current);
    if (entry?.isMessage) return current;
    current = entry?.parentId ?? null;
  }
  return null;
}

const firstLineWithoutMarkup = (text: string): string =>
  (text.split("\n", 1)[0] ?? "").replace(/^[#>*\-\s]+/, "").trim();

/**
 * omp's `description` is a generated label. When the task prompt opens with a heading, omp
 * reuses that heading ("# Target"), which names nothing; the subagent's own name is then the
 * better title. The tiny label model also answers with fragments that are not a label at all
 * (`<user>`, `_next`, `content="none">`); a label must read as words, at least two, without markup.
 */
export function ompSubagentTitle(input: {
  readonly nativeId: string;
  readonly description: string | null;
  readonly prompt: string;
}): string {
  const description = firstLineWithoutMarkup(input.description ?? "");
  const readsAsLabel = /\p{L}+\s+\p{L}/u.test(description) && !/[<>]/.test(description);
  return !readsAsLabel || description === firstLineWithoutMarkup(input.prompt)
    ? input.nativeId
    : description;
}

/** omp wraps a job's error in its `<task-result>` envelope, followed by the subagent's stack trace. */
export function ompSubagentErrorText(errorText: string): string {
  const output = /<output>([\s\S]*?)<\/output>/.exec(errorText)?.[1] ?? errorText;
  return output
    .split("\n")
    .filter((line) => !/^\s+at\s/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface OmpSubagentJobFailure {
  readonly id: string;
  readonly status: "failed" | "cancelled";
  readonly error: string;
}

/**
 * Subagent jobs a `wait`/`job` result reports as failed. A subagent that dies before its
 * session starts (an unusable model, say) sends no events, so this is its only error text.
 */
export function ompSubagentJobFailures(result: unknown): ReadonlyArray<OmpSubagentJobFailure> {
  const jobs = ompRecordField(ompRecordField(result, "details"), "jobs");
  if (!Array.isArray(jobs)) return [];
  return jobs.flatMap((job): ReadonlyArray<OmpSubagentJobFailure> => {
    const id = ompRecordString(job, "id");
    const status = ompRecordField(job, "status");
    const errorText = ompRecordString(job, "errorText");
    if (
      ompRecordField(job, "type") !== "task" ||
      id === undefined ||
      errorText === undefined ||
      (status !== "failed" && status !== "cancelled")
    )
      return [];
    const error = ompSubagentErrorText(errorText);
    return error.length === 0 ? [] : [{ id, status, error }];
  });
}
