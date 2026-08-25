#!/usr/bin/env bash
#
# Structural check of the EngineAdapter specification (t99).
#
# This gate's artifact is a document, so its gate is this script — the same
# philosophy as D9 (contract + typed verification) applied reflexively to the
# specification artifact.
#
# Every string this script compares against the document is left exactly as the
# document spells it: the headings, the conformance-kit row patterns and the
# codex flag citations. They moved to English with the document itself (D24,
# t299); before that they were Portuguese, and the patterns kept `.+` in place
# of an accented character for the reason check [3] still records.
#
# A note on `grep -q` and `set -o pipefail`, which cost this gate a flake: a
# `grep -q` that finds its match exits at once, and the producer on the left of
# the pipe then dies of SIGPIPE — which `pipefail` reports as a failed pipeline
# even though the match was found. It is a race between the producer finishing
# its write and grep reading enough to decide, so it stays quiet on a small
# input and shows up under load. That is why every `grep -q` below reads from a
# here-string rather than from a pipe. Measured, not guessed: a 200 k-line
# producer piped into `grep -q` matching line 1 fails 200 times out of 200.
#
# Usage: scripts/check-engine-adapter-spec.sh
# Exits 0 if every check passes, 1 on the first that fails.

set -uo pipefail

cd "$(dirname "$0")/.."

DOC="docs/formatos/engine-adapter.md"

failures=0

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; failures=$((failures + 1)); }

# Extracts the body of a `## <title>` section up to the next `## ` heading.
section() {
  awk -v h="$1" '$0 == h { found = 1; next } /^## / { if (found) exit } found' "$DOC"
}

printf '== check-engine-adapter-spec ==\n'

# --- 1. the file exists ------------------------------------------------------
printf '\n[1] file\n'
if [ -f "$DOC" ]; then
  pass "$DOC exists"
else
  fail "$DOC does not exist"
  printf '\n%d check(s) failed.\n' "$failures"
  exit 1
fi

# --- 2. exact headings -------------------------------------------------------
printf '\n[2] required headings\n'
for heading in \
  '## The TypeScript interface' \
  '## The conformance kit' \
  '## Feasibility: a second CLI' \
  '## Adjustments made in review'; do
  if grep -qxF "$heading" "$DOC"; then
    pass "heading '$heading'"
  else
    fail "missing heading: '$heading'"
  fi
done

# --- 3. the kit table covers FR6's 6 cases -----------------------------------
# The patterns use `.+` in place of the accented character to avoid depending on
# multibyte case-folding in grep (it varies between GNU/BSD and by locale).
printf '\n[3] conformance kit: 6 cases\n'
kit_rows=$(section '## The conformance kit' | grep '^|' || true)
if [ -z "$kit_rows" ]; then
  fail 'the "conformance kit" section has no markdown table'
else
  while IFS='|' read -r label pattern; do
    if grep -qiE "$pattern" <<<"$kit_rows"; then
      pass "row for '$label'"
    else
      fail "no table row for '$label' (pattern: $pattern)"
    fi
  done <<'CASES'
basic session|basic session
skill injection|skill injection
timeout|timeout
process death|process death
cancellation|cancellation
event harvesting|event harvesting
CASES
fi

# --- 4. the feasibility section cites a primary source -----------------------
printf '\n[4] feasibility: second CLI\n'
if grep -q 'http' <<<"$(section '## Feasibility: a second CLI')"; then
  pass 'the section carries at least one URL as a source citation'
else
  fail 'the section carries no URL (http) as a source citation'
fi

# --- 5. every ```typescript block compiles clean -----------------------------
printf '\n[5] typescript blocks compile (tsc --noEmit --strict)\n'
ts_file=$(mktemp -t engine-adapter-XXXXXX).ts
trap 'rm -f "$ts_file"' EXIT

awk '
  /^```typescript$/ { inblock = 1; next }
  /^```/            { inblock = 0; next }
  inblock           { print }
' "$DOC" > "$ts_file"

if [ ! -s "$ts_file" ]; then
  fail 'no ```typescript block found in the doc'
else
  # Two corrections over the ticket's literal command
  # (`npx --yes typescript tsc --noEmit --strict`):
  #
  # 1. `--package typescript -- tsc` is the form that works. `typescript` is a
  #    PACKAGE name; npx wants a BINARY, and it only infers one from a package
  #    when that package exposes exactly one. typescript exposed two through
  #    6.x (`tsc` and `tsserver`), so `npx --yes typescript ...` died with
  #    `npm error could not determine executable to run` (t137). Naming the bin
  #    after `--` settles it for every version. The package and the bin also
  #    have to stay SEPARATED by that `--`: written adjacent, the way the
  #    ticket's literal command had them, npx reads the package name as the
  #    binary and passes "tsc" through as an input file, and the compiler dies
  #    with TS6231 before ever looking at the doc (t119). Note that dropping
  #    the word `tsc` entirely does NOT work either: 7.0.2 happens to expose
  #    only `tsc`, so the short form resolves today and would break again the
  #    day a second bin comes back. Three false reds, in three directions;
  # 2. `--target es2022` is required — the default (ES5) does not load the
  #    `Promise` lib, and the whole interface is asynchronous.
  #
  # Run ad hoc through npx so this gate does not depend on the repository's own
  # toolchain being installed.
  if tsc_out=$(npx --yes --package typescript -- tsc --noEmit --strict --target es2022 "$ts_file" 2>&1); then
    pass "$(grep -c '' "$ts_file") lines of TS compile clean"
  else
    fail 'tsc rejected the typescript blocks of the doc:'
    printf '%s\n' "$tsc_out" | sed 's/^/        /'
  fi
fi

# --- 6. citation of codex's approval flags (t126) ----------------------------
#
# `-a, --ask-for-approval` is a flag of the interactive `codex` (top level). The
# `codex exec` subcommand does NOT accept it: `codex exec --help` does not list
# it and `codex exec -a on-request …` dies with `error: unexpected argument '-a'
# found`. Measured on codex-cli 0.147.0, the same version the doc cites. The
# exec's non-interactive approval surface is a different one —
# `--approve-for-me` and `--dangerously-bypass-approvals-and-sandbox`. These
# checks stop the wrong citation from coming back, and the last one stops the
# correction from being made by deleting the part that was right along with it.
printf '\n[6] codex exec approval flags\n'

for flag in '--approve-for-me' '--dangerously-bypass-approvals-and-sandbox'; do
  if grep -qF -- "$flag" "$DOC"; then
    pass "cites '$flag' (the exec's real non-interactive approval surface)"
  else
    fail "does not cite '$flag'"
  fi
done

# Every paragraph mentioning the flag has to attribute it to the interactive CLI.
misattributed=$(awk 'BEGIN { RS = "" } /--ask-for-approval/ && !/interactive/' "$DOC")
if [ -z "$misattributed" ]; then
  pass '--ask-for-approval always attributed to the interactive `codex`'
else
  fail '--ask-for-approval cited without attributing it to the interactive `codex`:'
  printf '%s\n' "$misattributed" | sed 's/^/        /'
fi

if grep -qF -- '-s, --sandbox <read-only|workspace-write|danger-full-access>' "$DOC"; then
  pass 'keeps the -s, --sandbox citation (confirmed against the CLI)'
else
  fail 'lost the -s, --sandbox citation, which is correct and measured'
fi

printf '\n'
if [ "$failures" -eq 0 ]; then
  printf 'All checks passed.\n'
  exit 0
fi
printf '%d check(s) failed.\n' "$failures"
exit 1
