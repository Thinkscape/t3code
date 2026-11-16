// @effect-diagnostics nodeBuiltinImport:off -- Account ids are hashed synchronously inside a pure mapper.
import * as NodeCrypto from "node:crypto";

import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";

import type { OmpSettings } from "../settings.ts";
import { OMP_ARGUMENTS_WITH_VALUES, resolveOmpLaunchArgs } from "./mcpInjection.ts";

// `omp usage` queries every logged-in provider over the network; a slow one must not stall the probe.
const OMP_USAGE_TIMEOUT = "15 seconds";

const DAY_MS = 24 * 60 * 60 * 1000;

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  "openai-codex": "OpenAI Codex",
  "github-copilot": "GitHub Copilot",
  "google-gemini-cli": "Gemini CLI",
  "google-antigravity": "Antigravity",
};

const OmpUsageDocument = Schema.Struct({ reports: Schema.Array(Schema.Unknown) });

const OmpUsageReport = Schema.Struct({
  provider: Schema.String,
  limits: Schema.Array(Schema.Unknown),
  metadata: Schema.optional(Schema.Unknown),
});

const OmpUsageAccountMetadata = Schema.Struct({
  accountId: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  planType: Schema.optional(Schema.String),
});

const OmpUsageLimit = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  scope: Schema.optional(Schema.Struct({ tier: Schema.optional(Schema.String) })),
  window: Schema.optional(
    Schema.Struct({
      label: Schema.optional(Schema.String),
      durationMs: Schema.optional(Schema.Number),
      resetsAt: Schema.optional(Schema.Number),
    }),
  ),
  amount: Schema.Struct({
    used: Schema.optional(Schema.Number),
    limit: Schema.optional(Schema.Number),
    usedFraction: Schema.optional(Schema.Number),
    remainingFraction: Schema.optional(Schema.Number),
    unit: Schema.String,
  }),
  status: Schema.optional(Schema.String),
});
type OmpUsageLimit = typeof OmpUsageLimit.Type;

const decodeUsageDocument = Schema.decodeUnknownOption(OmpUsageDocument);
const decodeUsageReport = Schema.decodeUnknownOption(OmpUsageReport);
const decodeAccountMetadata = Schema.decodeUnknownOption(OmpUsageAccountMetadata);
const decodeUsageLimit = Schema.decodeUnknownOption(OmpUsageLimit);

/** Same precedence as omp's own `resolveUsedFraction`, so bars match `omp usage`. */
function usedFraction(limit: OmpUsageLimit): number | undefined {
  const { amount } = limit;
  if (amount.usedFraction !== undefined) return amount.usedFraction;
  if (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0) {
    return amount.used / amount.limit;
  }
  if (amount.unit === "percent" && amount.used !== undefined) return amount.used / 100;
  if (amount.remainingFraction !== undefined) return Math.max(0, 1 - amount.remainingFraction);
  return limit.status === "exhausted" ? 1 : undefined;
}

function windowKind(durationMs: number | undefined): ServerProviderUsageWindow["kind"] {
  if (durationMs === undefined || !(durationMs > 0)) return "other";
  if (durationMs <= DAY_MS) return "session";
  if (durationMs >= 6 * DAY_MS && durationMs <= 8 * DAY_MS) return "weekly";
  if (durationMs >= 28 * DAY_MS && durationMs <= 31 * DAY_MS) return "monthly";
  return "other";
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function accountKey(
  metadata: typeof OmpUsageAccountMetadata.Type | undefined,
  ordinal: number,
): string {
  const identity = metadata?.accountId?.trim() || metadata?.email?.trim();
  // Hashing keeps ids stable across probes without putting account identifiers on the wire.
  return identity
    ? NodeCrypto.createHash("sha256").update(identity).digest("hex").slice(0, 8)
    : `account-${ordinal}`;
}

interface DecodedReport {
  readonly provider: string;
  readonly metadata: typeof OmpUsageAccountMetadata.Type | undefined;
  readonly limits: ReadonlyArray<{ readonly limit: OmpUsageLimit; readonly percent: number }>;
}

function decodeReports(reports: ReadonlyArray<unknown>): ReadonlyArray<DecodedReport> {
  return reports.flatMap((raw) => {
    const report = decodeUsageReport(raw);
    if (Option.isNone(report) || report.value.provider.trim().length === 0) return [];
    // One provider's odd entry must not hide every other bar.
    const limits = report.value.limits.flatMap((rawLimit) => {
      const limit = decodeUsageLimit(rawLimit);
      if (Option.isNone(limit) || limit.value.id.trim().length === 0) return [];
      const fraction = usedFraction(limit.value);
      if (fraction === undefined || !Number.isFinite(fraction)) return [];
      return [{ limit: limit.value, percent: clampPercent(fraction * 100) }];
    });
    if (limits.length === 0) return [];
    return [
      {
        provider: report.value.provider.trim(),
        metadata: Option.getOrUndefined(decodeAccountMetadata(report.value.metadata ?? {})),
        limits,
      },
    ];
  });
}

/**
 * One window per omp limit. Ids are `<provider>:<limit id>`; a provider with several
 * accounts adds a hashed account key so each account's bars keep their own identity.
 */
export function ompUsageReportToLimits(
  document: unknown,
  checkedAt: string,
): ServerProviderUsageLimits {
  const decoded = decodeUsageDocument(document);
  if (Option.isNone(decoded)) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Omp returned usage in an unexpected format.",
    });
  }
  const reports = decodeReports(decoded.value.reports);
  const reportsByProvider = Map.groupBy(reports, (report) => report.provider);
  const windows = new Map<string, ServerProviderUsageWindow>();
  for (const [provider, accounts] of reportsByProvider) {
    const name =
      PROVIDER_NAMES[provider] ??
      provider
        .split(/[-_]/)
        .filter((part) => part.length > 0)
        .map(capitalize)
        .join(" ");
    const multiAccount = accounts.length > 1;
    const tags = accounts.map((account, index) =>
      account.metadata?.planType?.trim()
        ? capitalize(account.metadata.planType.trim())
        : `Account ${index + 1}`,
    );
    accounts.forEach((account, index) => {
      const tag = tags[index] ?? `Account ${index + 1}`;
      const uniqueTag =
        tags.filter((candidate) => candidate === tag).length > 1 ? `${tag} ${index + 1}` : tag;
      const prefix = multiAccount ? `${name} (${uniqueTag})` : name;
      const key = accountKey(account.metadata, index + 1);
      const windowLabels = account.limits.map(({ limit }) => {
        const windowLabel = limit.window?.label?.trim();
        const tier = limit.scope?.tier?.trim();
        if (!windowLabel) return undefined;
        return tier ? `${windowLabel} (${capitalize(tier)})` : windowLabel;
      });
      account.limits.forEach(({ limit, percent }, limitIndex) => {
        const limitId = limit.id.trim();
        const localId = limitId.startsWith(`${provider}:`)
          ? limitId.slice(provider.length + 1)
          : limitId;
        const id = multiAccount ? `${provider}:${key}:${localId}` : `${provider}:${localId}`;
        if (windows.has(id)) return;
        const windowLabel = windowLabels[limitIndex];
        // Limits without a window label, or sharing one, fall back to omp's own limit label.
        const shortLabel =
          windowLabel !== undefined &&
          windowLabels.filter((candidate) => candidate === windowLabel).length === 1
            ? windowLabel
            : limit.label.trim() || localId;
        const resetsAt =
          limit.window?.resetsAt !== undefined && limit.window.resetsAt > 0
            ? Option.map(DateTime.make(limit.window.resetsAt), DateTime.formatIso)
            : Option.none();
        const durationMs = limit.window?.durationMs;
        const windowDurationMins =
          durationMs !== undefined && durationMs > 0 ? Math.round(durationMs / 60_000) : 0;
        windows.set(id, {
          id,
          kind: windowKind(durationMs),
          label: `${prefix} · ${shortLabel}`,
          usedPercent: percent,
          ...(Option.isSome(resetsAt) ? { resetsAt: resetsAt.value } : {}),
          ...(windowDurationMins > 0 ? { windowDurationMins } : {}),
        });
      });
    });
  }
  return windows.size > 0
    ? makeUsageLimits({ checkedAt, windows: windows.values() })
    : makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
}

/** `omp usage` takes the profile from the environment; launch args may name one for T3 sessions. */
function usageEnvironment(environment: NodeJS.ProcessEnv, launchArgs: string): NodeJS.ProcessEnv {
  const resolved = resolveOmpLaunchArgs(launchArgs);
  if (!resolved.ok) return environment;
  let profile: string | undefined;
  for (let index = 0; index < resolved.args.length; index += 1) {
    const arg = resolved.args[index];
    if (arg === undefined || !OMP_ARGUMENTS_WITH_VALUES.has(arg)) continue;
    index += 1;
    if (arg === "--profile") profile = resolved.args[index];
  }
  return profile?.trim() ? { ...environment, OMP_PROFILE: profile.trim() } : environment;
}

const decodeUsageJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

/** Reads subscription limits for every account omp is logged into; failures yield no bars. */
export const readOmpUsageLimits = Effect.fn("readOmpUsageLimits")(function* (
  ompSettings: Pick<OmpSettings, "binaryPath" | "launchArgs">,
  environment: NodeJS.ProcessEnv,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const probeFailed = makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: "Omp could not read usage limits.",
  });
  return yield* Effect.gen(function* () {
    const command = ompSettings.binaryPath || "omp";
    const env = usageEnvironment(environment, ompSettings.launchArgs);
    const spawnCommand = yield* resolveSpawnCommand(command, ["usage", "--json"], { env });
    const result = yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env,
        shell: spawnCommand.shell,
      }),
    );
    if (result.code !== 0) return probeFailed;
    const document = yield* decodeUsageJson(result.stdout);
    return ompUsageReportToLimits(document, checkedAt);
  }).pipe(
    Effect.timeoutOption(OMP_USAGE_TIMEOUT),
    Effect.map(Option.getOrElse(() => probeFailed)),
    // Interruption must still propagate; only failures and defects degrade to no bars.
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) =>
        Effect.logWarning("Omp usage limits probe failed.", {
          errorTag: causeErrorTag(cause),
        }).pipe(Effect.as(probeFailed)),
    ),
    // Only interruption is left; the typed failures above were all turned into `probeFailed`.
    Effect.orDie,
  );
});
