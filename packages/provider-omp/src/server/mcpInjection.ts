import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import type { RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import {
  OMP_T3_MCP_EXTENSION_FILENAME,
  OMP_T3_MCP_EXTENSION_SOURCE,
  T3_MCP_BEARER_ENV,
  T3_MCP_URL_ENV,
  T3_OMP_PLAN_REVIEW_ENV,
  T3_OMP_MCP_EXTENSION_PATH_ENV,
} from "./mcpExtensionSource.ts";

/**
 * omp's own approval mode for a T3 runtime mode; omp's per-tool tiers (read/write/exec) then
 * decide what asks. omp has no Auto mode and does not offer it (status.ts), and the server runs
 * an unoffered mode as Supervised, so Auto asks like Supervised.
 */
const OMP_APPROVAL_MODE_BY_RUNTIME_MODE = {
  "approval-required": "always-ask",
  "auto-accept-edits": "write",
  auto: "always-ask",
  "full-access": "yolo",
} as const satisfies Record<RuntimeMode, string>;

const RESERVED_OMP_LAUNCH_ARGUMENTS = new Set([
  "--restore",
  "--from-claude",
  "--from-codex",
  // T3 passes these itself for plan mode; without its review hook they approve plans unattended.
  "--plan-yolo",
  "--plan-yolo-into",
  // T3 sets the approval mode from the thread's runtime mode.
  "--approval-mode",
  "--auto-approve",
  "--yolo",
  "--goal",
  "--alias",
  "--cwd",
  "--continue",
  "-c",
  "--export",
  "--fork",
  "--help",
  "-h",
  "--list-models",
  "--mode",
  "--no-session",
  "--print",
  "-p",
  "--resume",
  "-r",
  "--session",
  "--session-id",
  "--version",
  "-v",
]);

export const OMP_ARGUMENTS_WITH_VALUES = new Set([
  "--api-key",
  "--append-system-prompt",
  "--exclude-tools",
  "-xt",
  "--extension",
  "-e",
  "--model",
  "--models",
  "--name",
  "-n",
  "--prompt-template",
  "--provider",
  "--profile",
  "--session-dir",
  "--skill",
  "--system-prompt",
  "--theme",
  "--thinking",
  "--tools",
  "-t",
  "--tui-mode",
  "--use-theme",
]);

const OMP_ARGUMENTS_WITHOUT_VALUES = new Set([
  "--approve",
  "-a",
  "--no-approve",
  "-na",
  "--no-builtin-tools",
  "-nbt",
  "--no-context-files",
  "-nc",
  "--no-extensions",
  "-ne",
  "--no-prompt-templates",
  "-np",
  "--no-skills",
  "-ns",
  "--no-themes",
  "--no-tools",
  "-nt",
  "--verbose",
]);

export type OmpLaunchArgsResolution =
  | { readonly ok: true; readonly args: ReadonlyArray<string> }
  | { readonly ok: false; readonly message: string };

function reservedOmpArgument(arg: string): string | undefined {
  for (const reserved of RESERVED_OMP_LAUNCH_ARGUMENTS) {
    if (arg === reserved || (reserved.startsWith("--") && arg.startsWith(`${reserved}=`))) {
      return reserved;
    }
  }
  return undefined;
}

function normalizeOmpBuiltInEqualsArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  return args.flatMap((arg) => {
    const equalsIndex = arg.indexOf("=");
    if (equalsIndex <= 0) return [arg];
    const option = arg.slice(0, equalsIndex);
    return OMP_ARGUMENTS_WITH_VALUES.has(option) ? [option, arg.slice(equalsIndex + 1)] : [arg];
  });
}

export function resolveOmpLaunchArgs(launchArgs: string): OmpLaunchArgsResolution {
  // Omp treats equals-form tokens as extension flags; split only known built-ins.
  const args = normalizeOmpBuiltInEqualsArguments(tokenizeCliArgs(launchArgs));
  let hasProvider = false;
  let hasModel = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    const reserved = reservedOmpArgument(arg);
    if (reserved !== undefined) {
      return {
        ok: false,
        message: `Omp launch argument '${reserved}' is controlled by T3 Code and cannot be overridden.`,
      };
    }
    if (arg === "--") {
      return {
        ok: false,
        message: "Omp launch arguments cannot include positional prompts.",
      };
    }
    if (OMP_ARGUMENTS_WITH_VALUES.has(arg)) {
      const value = args[index + 1];
      if (value === undefined) {
        return { ok: false, message: `Omp launch argument '${arg}' requires a value.` };
      }
      if (arg === "--provider") hasProvider = true;
      if (arg === "--model") hasModel = true;
      index += 1;
      continue;
    }
    if (OMP_ARGUMENTS_WITHOUT_VALUES.has(arg) || (arg.startsWith("--") && arg.includes("="))) {
      continue;
    }
    if (arg.startsWith("--")) {
      // Arbitrary extension flags may consume one following non-flag token.
      if (
        args[index + 1] !== undefined &&
        !args[index + 1]!.startsWith("-") &&
        !args[index + 1]!.startsWith("@")
      ) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      return { ok: false, message: `Omp launch argument '${arg}' is not supported by T3 Code.` };
    }
    return {
      ok: false,
      message: `Omp launch arguments cannot include positional prompt '${arg}'.`,
    };
  }
  if (hasProvider && !hasModel) {
    return { ok: false, message: "Omp launch argument '--provider' requires '--model'." };
  }
  return { ok: true, args };
}

function bearerTokenFromAuthorizationHeader(header: string): string {
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
}

function normalizedOmpPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function hasExplicitExtension(args: ReadonlyArray<string>, extensionPath: string): boolean {
  const wanted = normalizedOmpPath(extensionPath);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--extension" && arg !== "-e") continue;
    const configured = args[index + 1];
    if (configured !== undefined && normalizedOmpPath(configured) === wanted) return true;
    index += 1;
  }
  return false;
}

function withoutExplicitExtensions(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--extension" || arg === "-e") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--extension=") || arg.startsWith("-e=")) continue;
    filtered.push(arg);
  }
  return filtered;
}

function withoutToolSelectionArgs(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--tools" || arg === "-t" || arg === "--exclude-tools" || arg === "-xt") {
      index += 1;
      continue;
    }
    if (
      arg === "--no-tools" ||
      arg === "-nt" ||
      arg === "--no-builtin-tools" ||
      arg === "-nbt" ||
      arg.startsWith("--tools=") ||
      arg.startsWith("-t=") ||
      arg.startsWith("--exclude-tools=") ||
      arg.startsWith("-xt=")
    ) {
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}

function ompT3McpExtensionDestPath(cacheDir: string): string {
  return `${cacheDir.replace(/\\/g, "/")}/${OMP_T3_MCP_EXTENSION_FILENAME}`;
}

export const materializeOmpT3McpExtension = Effect.fn("materializeOmpT3McpExtension")(function* (
  cacheDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(cacheDir, { recursive: true });
  const dest = ompT3McpExtensionDestPath(cacheDir);
  const existing = yield* fs.readFileString(dest).pipe(Effect.orElseSucceed(() => ""));
  if (existing !== OMP_T3_MCP_EXTENSION_SOURCE) {
    // Concurrent omp launches read this file: stage it in a per-call directory
    // and rename so readers and other writers never see a partial file.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const stagingDir = yield* fs.makeTempDirectoryScoped({ directory: cacheDir });
        const staging = `${stagingDir.replace(/\\/g, "/")}/${OMP_T3_MCP_EXTENSION_FILENAME}`;
        yield* fs.writeFileString(staging, OMP_T3_MCP_EXTENSION_SOURCE);
        yield* fs.rename(staging, dest).pipe(Effect.retry({ times: 3 }));
      }),
    );
  }
  return dest;
});

export function buildOmpRpcLaunch(input: {
  readonly launchArgs: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  readonly mcpSession: McpProviderSessionConfig | undefined;
  readonly extensionPath: string | undefined;
  readonly sessionPath?: string | undefined;
  readonly ephemeral?: boolean;
  readonly disableExtensions?: boolean;
  readonly disableTools?: boolean;
  readonly runtimeMode?: RuntimeMode;
  /**
   * Starts omp in plan mode, with this model taking over once a plan is approved. omp's RPC
   * has no plan-mode command; `--plan-yolo` is its headless plan flow, and the T3 extension
   * turns that flow's automatic approval into a review. Ignored without the extension.
   */
  readonly planExecutionModel?: string | undefined;
}): {
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
} {
  const hasT3Extension = input.disableExtensions !== true && input.extensionPath !== undefined;
  const hasT3Mcp = hasT3Extension && input.mcpSession !== undefined;
  const planExecutionModel = hasT3Extension ? input.planExecutionModel : undefined;
  const extensionSafeArgs =
    input.disableExtensions === true
      ? withoutExplicitExtensions(input.launchArgs)
      : input.launchArgs;
  const launchArgs =
    input.disableTools === true ? withoutToolSelectionArgs(extensionSafeArgs) : extensionSafeArgs;
  const args = [
    "--mode",
    "rpc-ui",
    ...(input.ephemeral === true
      ? ["--no-session"]
      : input.sessionPath !== undefined
        ? ["--resume", input.sessionPath]
        : []),
    ...launchArgs,
    "--no-title",
    "--no-lsp",
    ...(planExecutionModel === undefined
      ? []
      : ["--plan-yolo", "--plan-yolo-into", planExecutionModel]),
    // Restrictions must follow launch args so user flags cannot re-enable unattended tools/extensions.
    ...(input.disableExtensions === true ? ["--no-extensions"] : []),
    ...(input.disableTools === true ? ["--no-tools"] : []),
    ...(input.runtimeMode === undefined
      ? []
      : ["--approval-mode", OMP_APPROVAL_MODE_BY_RUNTIME_MODE[input.runtimeMode]]),
  ];
  if (
    hasT3Extension &&
    input.extensionPath !== undefined &&
    !hasExplicitExtension(args, input.extensionPath)
  ) {
    args.push("--extension", input.extensionPath);
  }
  const environment = { ...input.environment };
  // MCP credentials belong to this T3 session; discard inherited server/parent credentials.
  delete environment[T3_MCP_URL_ENV];
  delete environment[T3_MCP_BEARER_ENV];
  delete environment[T3_OMP_MCP_EXTENSION_PATH_ENV];
  delete environment[T3_OMP_PLAN_REVIEW_ENV];

  return {
    args,
    env: {
      ...environment,
      ...(hasT3Extension && input.extensionPath !== undefined
        ? { [T3_OMP_MCP_EXTENSION_PATH_ENV]: input.extensionPath }
        : {}),
      ...(planExecutionModel === undefined ? {} : { [T3_OMP_PLAN_REVIEW_ENV]: "1" }),
      ...(hasT3Mcp && input.mcpSession !== undefined
        ? {
            [T3_MCP_URL_ENV]: input.mcpSession.endpoint,
            [T3_MCP_BEARER_ENV]: bearerTokenFromAuthorizationHeader(
              input.mcpSession.authorizationHeader,
            ),
          }
        : {}),
    },
  };
}
