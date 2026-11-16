#!/usr/bin/env bash
# Fork gates for the omp provider (see FORK.md). Runs without a live omp binary; exit 0 = green.
# Needs the workspace's node_modules/.bin on PATH (vp) and the upstream nightly tags fetched.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

step() {
  printf '\n==> %s\n' "$*"
}

base=$(git describe --tags --abbrev=0 --match 'v*-nightly.*' HEAD) || {
  echo "omp:gates: no upstream nightly tag in HEAD's history; run git fetch upstream --tags" >&2
  exit 1
}

# Every file the fork adds or changes relative to its upstream base, committed or not.
changed=()
while IFS= read -r file; do
  changed+=("$file")
done < <(
  {
    git diff --name-only --diff-filter=d "$base" -- . ':!pnpm-lock.yaml'
    git ls-files --others --exclude-standard
  } | sort -u
)
code=()
for file in "${changed[@]}"; do
  case "$file" in
    *.ts | *.tsx | *.js | *.mjs | *.cjs) code+=("$file") ;;
  esac
done

step "fork files vs $base: ${#changed[@]}"
step "client protocol unchanged"
# Official desktop/iOS clients cannot be modified; the fork must never touch the wire version.
git diff --exit-code "$base" -- packages/contracts/src/environment.ts
step "fmt --check"
vp fmt --check --no-error-on-unmatched-pattern "${changed[@]}"
step "lint"
vp lint --report-unused-disable-directives --no-error-on-unmatched-pattern "${code[@]}"
step "knip"
vp run knip:check
# Repo-wide (cached): provider-omp, the server, and every client the fork's core edits reach.
step "typecheck"
vp run typecheck
step "provider-omp tests"
vp run --filter @t3tools/provider-omp test
step "omp replay fixtures"
(cd apps/server && vp test run src/orchestration-v2/testkit/OmpReplayFixtures.integration.test.ts)
step "omp:gates green"
