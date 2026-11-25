# omp-native fork

Fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) that adds a native provider
for [omp](https://github.com/can1357/oh-my-pi) (Oh My Pi). It drives `omp --mode rpc-ui` directly
over omp's RPC protocol. User-facing behavior: [docs/user/providers-omp.md](docs/user/providers-omp.md).

- Branch: `omp-native` on `git@github.com:Thinkscape/t3code.git`. Push only this branch, never
  tags, and force-push only with `--force-with-lease`.
- Base: one upstream nightly tag; `git describe --tags --abbrev=0 --match 'v*-nightly.*'` prints
  it. The lab's auto-deploy (home-fpp `scripts/t3code/auto-deploy.sh`) rebases this branch onto
  newer nightlies and pushes it, so this file does not record the tag.

## Client constraints

Official desktop, web and iOS builds connect to this server unmodified, so the fork must stay
wire-compatible with them:

- never change `ORCHESTRATION_PROTOCOL_VERSION` (`packages/contracts/src/environment.ts`);
- no new turn-item types and no new required wire fields;
- no edits to `apps/web`, `apps/desktop` or `apps/mobile` beyond the usage label below;
- no new agent-session import sources (official clients reject sources they do not know).

omp features map onto what T3 already has: plan cards, todo lists, subagents with child threads,
approvals, dialogs, model options and usage limits. The one new enum value, `omp` in
`UsageProviderKind`, reaches official clients only inside `ForwardCompatibleArray`s, which skip
entries they cannot decode.

## Commits

Patch groups below retain their reference numbers. The former core patch (1) is gone:
omp now uses upstream's instance-scoped `thread_model_selection.updated` event (#40818).

2. `feat(contracts): add omp as a usage provider kind`
3. `feat(omp): add the native omp RPC provider package`
4. `feat(omp): register the omp driver on the server and in clients`
5. `test(omp): replay omp transcripts through OrchestratorV2`
6. `fix(omp): port upstream Pi provider fixes` (fixes upstream made to `provider-pi` that apply
   to omp; fold later ports into it)
7. `chore(fork): document the fork and add omp:gates`
8. `docs(fork): …`, `fix(omp): answer omp 19's ask form from T3's question card`,
   `fix(omp): hold omp 19's plan proposal for T3's plan review`: fixes for omp 19 (fold them into
   3 when squashing).
9. `chore: regenerate pnpm-lock.yaml on <tag>`: written by the auto-deploy's replay when
   upstream's lockfile needs re-resolving.

## Files

Fork-owned (upstream never touches them):

- `packages/provider-omp/**`: the provider (driver, adapter, RPC client, status, usage, text
  generation, injected T3 extension) and its unit tests and NDJSON fixtures.
- `apps/server/src/orchestration-v2/Adapters/OmpAdapterV2.testkit.ts`: replay harness.
- `apps/server/src/orchestration-v2/testkit/OmpReplayFixtures.integration.test.ts` and
  `apps/server/src/orchestration-v2/testkit/fixtures/omp/**`: the omp replay fixtures. They have
  their own list (`OMP_REPLAY_FIXTURES`), so upstream's `fixtures/index.ts`, `fixtures/shared.ts`
  and `ProviderReplayFixtures.ts` stay untouched. `simple`, `provider_thread_resume` and
  `turn_interrupt_mid_tool` reuse upstream's inputs.
- `apps/server/scripts/record-omp-rpc-replay-fixture.ts`: fixture recorder.
- `docs/user/providers-omp.md`, `scripts/omp-gates.sh`, `FORK.md`.

Upstream-owned files the fork edits, and why:

| File                                                                    | Commit | Why                                                                                                            |
| ----------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/usage.ts`                                       | 2      | Adds `omp` to `UsageProviderKind`; omp usage and limits are reported under it.                                 |
| `apps/web/src/components/usage/usageProviders.ts`                       | 2      | Label and color for `omp`. The map is exhaustive over `UsageProviderKind`, so it fails to compile without it.  |
| `apps/mobile/src/features/usage/usageProviders.ts`, `providerColors.ts` | 2      | Label (first) and color (second; upstream moved the colors there in 0.1.11) for `omp`, same reason as web.     |
| `apps/server/src/provider/builtInDrivers.ts`                            | 4      | Registers `OmpDriver` as a built-in and usage driver.                                                          |
| `apps/server/package.json`                                              | 4, 5   | `@t3tools/provider-omp` dependency; `record:omp-replay` script, which is also the recorder's knip entry point. |
| `packages/client-runtime/package.json`, `src/providerClients.ts`        | 4      | Registers `ompClient` so clients built from this tree show omp settings and icons.                             |
| `packages/contracts/src/settings.ts`                                    | 4      | Adds `omp` to `DEFAULT_DISABLED_PROVIDER_DRIVERS`, matching the driver's decoding default.                     |
| `package.json`                                                          | 7      | The `omp:gates` script.                                                                                        |
| `pnpm-lock.yaml`                                                        | 3, 4   | Importer entries for the new workspace package and its dependents. Always regenerated, never merged by hand.   |

## Catching up with upstream

Prerequisites: `PATH="$PWD/node_modules/.bin:$PATH"` (Homebrew `pnpm` fails with a pnpm
self-switch error; use `vp`) and `TMPDIR="$(realpath "$TMPDIR")"`. `rerere` is enabled, so a
conflict resolved once replays on later rebases.

```sh
git fetch upstream --tags
new=$(git tag -l 'v*-nightly.*' --sort=-creatordate | head -1)
git log --oneline "$(git describe --tags --abbrev=0 --match 'v*-nightly.*')..$new" -- \
  packages/provider-pi packages/provider-core   # fixes to port into commit 6
git rebase "$new"
```

On a conflict:

- `pnpm-lock.yaml`: take upstream's copy and regenerate it for that commit, then continue:
  `git checkout "$new" -- pnpm-lock.yaml && CI= vp install --no-frozen-lockfile && git add pnpm-lock.yaml`.
- Source files: when both sides add to a list or import block, keep both. Otherwise keep upstream's
  change and re-apply the fork's intent from the commit message.

After the rebase, run `CI= vp install`, then `vp run omp:gates`. Fix anything red in the commit
that owns the file (`git commit --fixup <sha>` then `git rebase -i --autosquash "$new"`). Then
push with `git push --force-with-lease origin omp-native`.

## Gates

`vp run omp:gates` (`scripts/omp-gates.sh`) needs no live omp. Exit 0 means green. It checks:

- `packages/contracts/src/environment.ts` is unchanged from the base tag;
- `vp fmt --check` and `vp lint` on every file the fork adds or changes (committed or not);
- `knip:check`;
- the repo-wide typecheck (cached), which covers provider-omp, the server and the clients;
- provider-omp unit tests;
- the 13 omp replay fixtures (`OmpReplayFixtures.integration.test.ts`).

The pre-commit hook runs `vp staged` (fmt, lint, knip) on each commit.

## Recording fixtures

Only re-record when omp's version or wire behavior changes. Transcripts are recorded from a real
`omp` (`T3_OMP_BIN`, default `omp` on PATH). Each run handles one scenario:

```sh
cd apps/server
node scripts/record-omp-rpc-replay-fixture.ts                       # list scenarios
node scripts/record-omp-rpc-replay-fixture.ts --scenario omp_todo_list
node scripts/record-omp-rpc-replay-fixture.ts --scenario omp_todo_list --verify
```

Without `--verify`, the recorder runs the scenario against live omp and calls the model. It
writes the transcript only after the recording replays. `--verify` replays the existing transcript
and does not need omp. `--scenario status_discovery` records
`packages/provider-omp/test/fixtures/status-discovery.ndjson`. After recording, update the
fixture's `output.ts` assertions if needed and run `omp:gates`.

## How omp reaches T3

The provider runs `omp --mode rpc-ui` per thread (`lifecycle.ts`, `rpc.ts`: JSONL over stdio,
`negotiate_protocol` v2 with `rpc_chunk` reassembly; v1 caps a frame at 1 MiB and omp's model
catalog is larger). omp's RPC contract is `docs/rpc.md` in the omp repository at the release tag
the hosts run (`omp --version`); `packages/coding-agent/src/modes/rpc/rpc-types.ts` is the frame
list. What maps where, so a broken feature points at one place:

| omp frame / mechanism                                                                                                                                                                            | T3 result                                                                                                                                     | Code                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `message_*`, `agent_*`, `prompt_result`, `session_settled`                                                                                                                                       | assistant text, reasoning, run start/end                                                                                                      | `adapter.ts`                                                  |
| `tool_execution_start/update/end`                                                                                                                                                                | tool rows (`command_execution`, `file_change`, `dynamic_tool`); a direct `write` to `xd://<t3 tool>` becomes that tool's row                  | `adapter.ts` (`ompDeviceToolCall`)                            |
| T3 tools called inside `eval` or a subagent (no RPC frames of their own)                                                                                                                         | reported by the injected extension through `setWidget("t3-code:tool-result")`, projected as rows                                              | `mcpExtensionSource.ts`, `adapter.ts` (`ompReportedToolCall`) |
| `extension_ui_request` `confirm` / `select` from `--approval-mode`                                                                                                                               | approval cards                                                                                                                                | `approvals.ts`, `adapter.ts`                                  |
| `extension_ui_request` `form` (omp 19's `ask`: one HTML `<form>`)                                                                                                                                | one T3 question card; answers validated, returned as `data`; anything unmappable is cancelled at once (an unanswered form blocks omp forever) | `form.ts`, `questions.ts`                                     |
| `extension_ui_request` `select`/`input`/`editor` (older omp `ask`, extension dialogs)                                                                                                            | question cards                                                                                                                                | `questions.ts`                                                |
| Plan mode: omp runs with `--plan-yolo`; the injected extension holds the plan submission (`propose <slug>` in bash, the `propose` tool, or older omp's `xd://propose` write) and asks for review | plan card plus Approve/Refine; approval changes Mode from Plan to Default via `thread_model_selection.updated`                                | `mcpExtensionSource.ts`, `plans.ts`, `adapter.ts`             |
| `subagent_*` events, `task`                                                                                                                                                                      | subagent rows and child threads                                                                                                               | `adapter.ts`                                                  |
| `todo` tool results                                                                                                                                                                              | todo list                                                                                                                                     | `adapter.ts`                                                  |
| `omp usage --json`                                                                                                                                                                               | limit bars                                                                                                                                    | `usageLimits.ts`                                              |

## When a new omp breaks something

A new omp release can change the RPC surface without a version bump on our side (omp 19 moved
`ask` to `form` and plan approval to the `propose` command; both failed silently: no card, or a
plan that approved itself). To find and fix such a break:

1. Read the omp repository's `CHANGELOG.md` and `docs/rpc.md` between the old and new tag, and
   `git log <old>..<new> -- packages/coding-agent/src/modes/rpc`.
2. Replay every scenario live against the new binary, one per run
   (`T3_OMP_BIN=<omp> node scripts/record-omp-rpc-replay-fixture.ts --scenario <name>` with a
   scratch output, or `--verify` to compare). A scenario that changes shape points at the row in
   the table above.
3. Fix in a separate worktree (`git worktree add <dir> -b fix/<name> omp-native`), never in a
   checkout someone else may be editing; add unit tests and re-record the affected fixtures; run
   `omp:gates`; live-check on a scratch server from source
   (`node apps/server/src/bin.ts serve --base-dir <dir> --port <p> --host 127.0.0.1 --no-browser`
   with `providerInstances.omp` set to the new binary).
4. Fast-forward `omp-native` to the fix and let the lab's auto-deploy ship it.
