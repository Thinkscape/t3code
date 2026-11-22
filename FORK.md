# omp-native fork

Fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) that adds a native provider
for [omp](https://github.com/can1357/oh-my-pi) (Oh My Pi). It drives `omp --mode rpc-ui` directly
over omp's RPC protocol. User-facing behavior: [docs/user/providers-omp.md](docs/user/providers-omp.md).

- Branch: `omp-native` on `git@github.com:Thinkscape/t3code.git`. Push only this branch, never
  tags, and force-push only with `--force-with-lease`.
- Base: upstream nightly tag `v0.1.10-nightly.20261116.4761`. The branch is always a short stack of
  commits on one upstream nightly tag; `git describe --tags --abbrev=0 --match 'v*-nightly.*'`
  prints it.

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

On top of the base tag, oldest first. Core edits sit in their own commits.

1. `feat(core): let a provider end a model option it left on its own`
2. `feat(contracts): add omp as a usage provider kind`
3. `feat(omp): add the native omp RPC provider package`
4. `feat(omp): register the omp driver on the server and in clients`
5. `test(omp): replay omp transcripts through OrchestratorV2`
6. `fix(omp): port upstream Pi provider fixes` (fixes upstream made to `provider-pi` that apply
   to omp; fold later ports into it)
7. `chore(fork): document the fork and add omp:gates`

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

| File                                                             | Commit | Why                                                                                                                                             |
| ---------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/provider-core/src/server/ProviderAdapter.ts`           | 1      | Adds the `model_option.ended` adapter event. omp leaves Plan mode on its own when a plan is approved, and T3 has no other way to hear about it. |
| `apps/server/src/orchestration-v2/ProviderEventIngestor.ts`      | 1      | Turns that event into the existing `thread.model-selection-updated` domain event under the thread lock, so no new wire field is needed.         |
| `apps/server/src/orchestration-v2/RunExecutionService.ts`        | 1      | Routes the event to the run that owns it.                                                                                                       |
| `packages/contracts/src/usage.ts`                                | 2      | Adds `omp` to `UsageProviderKind`; omp usage and limits are reported under it.                                                                  |
| `apps/web/src/components/usage/usageProviders.ts`                | 2      | Label and color for `omp`. The map is exhaustive over `UsageProviderKind`, so it fails to compile without it.                                   |
| `apps/mobile/src/features/usage/usageProviders.ts`               | 2      | Same as web.                                                                                                                                    |
| `apps/server/src/provider/builtInDrivers.ts`                     | 4      | Registers `OmpDriver` as a built-in and usage driver.                                                                                           |
| `apps/server/package.json`                                       | 4, 5   | `@t3tools/provider-omp` dependency; `record:omp-replay` script, which is also the recorder's knip entry point.                                  |
| `packages/client-runtime/package.json`, `src/providerClients.ts` | 4      | Registers `ompClient` so clients built from this tree show omp settings and icons.                                                              |
| `packages/contracts/src/settings.ts`                             | 4      | Adds `omp` to `DEFAULT_DISABLED_PROVIDER_DRIVERS`, matching the driver's decoding default.                                                      |
| `package.json`                                                   | 7      | The `omp:gates` script.                                                                                                                         |
| `pnpm-lock.yaml`                                                 | 3, 4   | Importer entries for the new workspace package and its dependents. Always regenerated, never merged by hand.                                    |

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
that owns the file (`git commit --fixup <sha>` then `git rebase -i --autosquash "$new"`). Update
the base tag at the top of this file. Then push with
`git push --force-with-lease origin omp-native`.

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
