#!/usr/bin/env bash
#
# Verificação estrutural da especificação do EngineAdapter (t99).
#
# Este repo é pré-código (D17): não há test runner, lint nem typecheck de
# projeto. O artefato entregue é um documento, então o portão dele é este
# script — a mesma filosofia da D9 (contrato + verificação tipada) aplicada
# reflexivamente ao artefato de especificação.
#
# Uso: scripts/check-engine-adapter-spec.sh
# Sai 0 se todas as verificações passam, 1 na primeira que falha.

set -uo pipefail

cd "$(dirname "$0")/.."

DOC="docs/formatos/engine-adapter.md"

failures=0

pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FALHA %s\n' "$1"; failures=$((failures + 1)); }

# Extrai o corpo de uma seção `## <título>` até o próximo heading `## `.
section() {
  awk -v h="$1" '$0 == h { found = 1; next } /^## / { if (found) exit } found' "$DOC"
}

printf '== check-engine-adapter-spec ==\n'

# --- 1. o arquivo existe -----------------------------------------------------
printf '\n[1] arquivo\n'
if [ -f "$DOC" ]; then
  pass "$DOC existe"
else
  fail "$DOC não existe"
  printf '\n%d verificação(ões) falharam.\n' "$failures"
  exit 1
fi

# --- 2. headings exatos ------------------------------------------------------
printf '\n[2] headings obrigatórios\n'
for heading in \
  '## Interface TypeScript' \
  '## Kit de conformidade' \
  '## Viabilidade: segunda CLI' \
  '## Ajustes feitos na revisão'; do
  if grep -qxF "$heading" "$DOC"; then
    pass "heading '$heading'"
  else
    fail "heading ausente: '$heading'"
  fi
done

# --- 3. tabela do kit cobre os 6 casos do FR6 --------------------------------
# Os padrões com `.+` no lugar do caractere acentuado evitam depender de
# case-folding de multibyte no grep (varia entre GNU/BSD e por locale).
printf '\n[3] kit de conformidade: 6 casos\n'
kit_rows=$(section '## Kit de conformidade' | grep '^|' || true)
if [ -z "$kit_rows" ]; then
  fail 'seção "Kit de conformidade" não contém tabela markdown'
else
  while IFS='|' read -r label pattern; do
    if printf '%s\n' "$kit_rows" | grep -qiE "$pattern"; then
      pass "linha para '$label'"
    else
      fail "sem linha na tabela para '$label' (padrão: $pattern)"
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

# --- 4. viabilidade cita fonte primária --------------------------------------
printf '\n[4] viabilidade: segunda CLI\n'
if section '## Viabilidade: segunda CLI' | grep -q 'http'; then
  pass 'seção contém ao menos uma URL como citação de fonte'
else
  fail 'seção não contém nenhuma URL (http) como citação de fonte'
fi

# --- 5. todo bloco ```typescript compila limpo -------------------------------
printf '\n[5] blocos typescript compilam (tsc --noEmit --strict)\n'
ts_file=$(mktemp -t engine-adapter-XXXXXX).ts
trap 'rm -f "$ts_file"' EXIT

awk '
  /^```typescript$/ { inblock = 1; next }
  /^```/            { inblock = 0; next }
  inblock           { print }
' "$DOC" > "$ts_file"

if [ ! -s "$ts_file" ]; then
  fail 'nenhum bloco ```typescript encontrado no doc'
else
  # Duas correções sobre o comando literal do ticket
  # (`npx --yes typescript tsc --noEmit --strict`):
  #
  # 1. o `tsc` sobra — o bin default do pacote `typescript` JÁ é o tsc, então
  #    npx repassa a palavra "tsc" como se fosse um arquivo de entrada e o
  #    compilador morre com TS6231 antes de olhar o doc (falso vermelho);
  # 2. `--target es2022` é obrigatório — o default (ES5) não carrega o lib de
  #    `Promise`, e a interface inteira é assíncrona.
  #
  # Roda ad hoc via npx: o repo ainda não tem package.json (D17, pré-código).
  if tsc_out=$(npx --yes typescript --noEmit --strict --target es2022 "$ts_file" 2>&1); then
    pass "$(grep -c '' "$ts_file") linhas de TS compilam limpo"
  else
    fail 'tsc reprovou os blocos typescript do doc:'
    printf '%s\n' "$tsc_out" | sed 's/^/        /'
  fi
fi

printf '\n'
if [ "$failures" -eq 0 ]; then
  printf 'Todas as verificações passaram.\n'
  exit 0
fi
printf '%d verificação(ões) falharam.\n' "$failures"
exit 1
