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
# codex flag citations are Portuguese because `docs/formatos/engine-adapter.md`
# is, and that file is out of the D18 rename scope (t133, exception 7). Only
# this script's own prose is English.
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
  '## Interface TypeScript' \
  '## Kit de conformidade' \
  '## Viabilidade: segunda CLI' \
  '## Ajustes feitos na revisão'; do
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
kit_rows=$(section '## Kit de conformidade' | grep '^|' || true)
if [ -z "$kit_rows" ]; then
  fail 'the "Kit de conformidade" section has no markdown table'
else
  while IFS='|' read -r label pattern; do
    if printf '%s\n' "$kit_rows" | grep -qiE "$pattern"; then
      pass "row for '$label'"
    else
      fail "no table row for '$label' (pattern: $pattern)"
    fi
  done <<'CASES'
sessão básica|sess.+o b.+sica
injeção de skill|inje.+o de skill
timeout|timeout
morte de processo|morte de processo
cancelamento|cancelamento
colheita de eventos|colheita de eventos
CASES
fi

# --- 4. the feasibility section cites a primary source -----------------------
printf '\n[4] feasibility: second CLI\n'
if section '## Viabilidade: segunda CLI' | grep -q 'http'; then
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
  # 1. the `tsc` word is one too many — the `typescript` package's default bin
  #    ALREADY is tsc, so npx passes "tsc" through as if it were an input file
  #    and the compiler dies with TS6231 before it ever looks at the doc (a
  #    false red);
  # 2. `--target es2022` is required — the default (ES5) does not load the
  #    `Promise` lib, and the whole interface is asynchronous.
  #
  # Run ad hoc through npx so this gate does not depend on the repository's own
  # toolchain being installed.
  if tsc_out=$(npx --yes typescript --noEmit --strict --target es2022 "$ts_file" 2>&1); then
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
misattributed=$(awk 'BEGIN { RS = "" } /--ask-for-approval/ && !/interativ/' "$DOC")
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
