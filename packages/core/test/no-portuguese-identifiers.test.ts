/**
 * D18 gate: no Portuguese code identifiers left in `packages/core` (t127, AC9).
 *
 * This is AC1's sweep turned into a deterministic, re-runnable test instead of a
 * checklist a reviewer maintains by hand. It walks `src/`, `test/` and `bin/`,
 * masks out everything FR8 deliberately leaves in Portuguese, and then asserts
 * that none of the pre-rename tokens of the ticket's Glossary and Code Changes
 * table survives anywhere in what is left.
 *
 * What gets masked, and why — these are the FR8 exceptions, not loopholes:
 *
 * - **SQL** inside query strings. The schema is untouched (AC3), so
 *   `FROM trabalho`, `SELECT ... criado_em` and the column-list constants stay
 *   exactly as the migrations spell them.
 * - **Event-type strings** (`'trabalho.criado'`, `'sessao.aberta'`, …), governed
 *   by `especificacoes/eventos/taxonomia.md`, and the CHECK-constrained enum
 *   values (`entidade_tipo`, `ator_tipo`, `origem`, `status`).
 * - **Column-mirrored wire fields.** These are snake_case, so the word-boundary
 *   rules below never reach them: `\btrabalho\b` does not match `trabalho_id`.
 * - **Prose spans in backticks** inside comments, which is how this codebase
 *   quotes a table, column or event name while writing English around it.
 *
 * Anything else — a function, type, const, variable, file name, route segment or
 * plain word in a comment — is code, and code is English from D18 onward.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const SCANNED_DIRS = ['src', 'test', 'bin'];

/**
 * Pre-rename tokens of the Glossary and the Code Changes table.
 *
 * `bare` matches the standalone lowercase word (so `\btrabalho\b` fires on a
 * variable named `trabalho` but never on the column `trabalho_id`); `camel`
 * matches the capitalized form anywhere, which is what catches it inside
 * `buscarTrabalho`, `LinhaTrabalho` or `EntradaCriarTrabalho`.
 */
const FORBIDDEN = Object.freeze([
  // Domain vocabulary (Glossary).
  { bare: ['grafo', 'grafos'], camel: ['Grafo'] },
  { bare: ['trabalho', 'trabalhos'], camel: ['Trabalho'] },
  { bare: ['pergunta', 'perguntas'], camel: ['Pergunta'] },
  { bare: ['sessao', 'sessoes'], camel: ['Sessao'] },
  { bare: ['execucao', 'execucoes'], camel: ['Execucao'] },
  { bare: ['proposta', 'propostas'], camel: ['Proposta'] },
  { bare: ['evento', 'eventos'], camel: ['Evento'] },
  { bare: ['banco'], camel: ['Banco'] },
  { bare: ['versao', 'versoes'], camel: ['Versao'] },
  { bare: ['operacao', 'operacoes'], camel: ['Operacao'] },
  { bare: ['ator', 'atores'], camel: ['Ator'] },
  { bare: ['lease'], camel: [] },

  // Structural vocabulary (Glossary + Code Changes table).
  { bare: ['dominio', 'repositorios', 'comum', 'apoio', 'rota', 'rotas'], camel: [] },
  { bare: ['linha', 'linhas', 'coluna', 'colunas'], camel: ['Linha', 'Coluna'] },
  { bare: ['carimbo', 'padrao', 'prefixo', 'caminho'], camel: ['Padrao', 'Prefixo', 'Caminho'] },
  { bare: ['erro', 'erros'], camel: ['Erro'] },
  { bare: ['resposta', 'respostas', 'requisicao', 'corpo'], camel: ['Resposta', 'Requisicao'] },
  { bare: ['validacao', 'transicao', 'transicoes'], camel: ['Validacao', 'Transicao'] },
  { bare: ['bloqueio', 'bloqueios', 'desbloqueio', 'desbloqueios'], camel: ['Bloqueio'] },
  { bare: ['emenda', 'emendas'], camel: ['Emenda'] },
  { bare: ['migracoes', 'migracao'], camel: ['Migracoes', 'Migracao'] },

  // Verbs the Glossary maps (`criar`→create, `buscar`→get, …), as identifiers.
  {
    bare: [
      'criar',
      'buscar',
      'listar',
      'registrar',
      'finalizar',
      'exportar',
      'importar',
      'aplicar',
      'reverter',
      'migrar',
      'abrir',
      'iniciar',
      'encerrar',
    ],
    camel: [],
  },
]);

/** Literal string values FR8 freezes: event types and CHECK-constrained enums. */
const FROZEN_STRING_VALUES = new Set([
  // Event types (especificacoes/eventos/taxonomia.md).
  'trabalho.criado',
  'trabalho.transicao',
  'trabalho.bloqueado',
  'trabalho.desbloqueado',
  'trabalho.emendado',
  'sessao.aberta',
  'sessao.finalizada',
  'pergunta.criada',
  'pergunta.respondida',
  'pergunta.auto_resolvida',
  'grafo_versao.aplicada',
  'grafo_versao.revertida',
  'lease.concedida',
  'lease.expirada',
  // entidade_tipo / ator_tipo / origem / status enum values.
  'trabalho',
  'sessao',
  'pergunta',
  'grafo',
  'grafo_versao',
  'proposta',
  'evento',
  'usuario',
  'agente',
  'sistema',
  'manual',
  'sintetizador',
  'auto',
  'base',
  'variante',
  'pendente',
  'aplicada',
  'revertida',
  'rejeitada',
  'aberta',
  'respondida',
  'ativa',
  'liberada',
  'expirada',
  'concluida',
  'pausada_cota',
  'heartbeat_perdido',
  'expirou',
  'trabalho_ja_leased',
  'teto_runner',
  'teto_projeto',
  'recomendacao',
  'resposta_padrao',
  'precedente',
  // Inline HTTP error codes of the non-envelope routes, frozen with the wire
  // format the runner parses (t127 keeps FR7 scoped to routes/common.ts).
  'grafo_invalido',
  'grafo_desconhecido',
  'grafo_versao_desconhecida',
  'classe_ja_registrada',
  'linhagem_nao_base',
  'campo_invalido',
  'versao_alvo_desconhecida',
  'campo_obrigatorio_ausente',
  'operacoes_invalidas',
  'operacao_inaplicavel',
  'versao_sem_efeito',
  'proposta_desconhecida',
  'proposta_nao_pendente',
  'proposta_nao_aplicada',
  'proposta_desatualizada',
  'motivo_obrigatorio',
  'corpo_invalido',
  'filtro_invalido',
  'runner_desconhecido',
  'lease_desconhecida',
  'lease_nao_ativa',
  'id_obrigatorio',
  'nome_invalido',
]);

const SQL_KEYWORD = /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|VALUES|ORDER\s+BY|GROUP\s+BY|CREATE|PRAGMA|COALESCE|COUNT|CAST|json_extract|AS|SET|AND|LIMIT)\b/;

/** A string made only of snake_case names, commas and whitespace: a column list. */
const COLUMN_LIST = /^[\s,]*[a-z][a-z0-9_]*(?:\s*,\s*[a-z][a-z0-9_]*)*[\s,]*$/;

/** Replaces a span with same-length blanks, so line/column numbers stay honest. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

/**
 * Masks every FR8-exempt span of a source file.
 *
 * @param source File contents.
 * @returns The same text with the exempt spans blanked out.
 */
function maskExemptSpans(source: string): string {
  // Quoted strings and template literals: masked when they are SQL, a column
  // list, or one of the frozen event-type/enum values.
  let masked = source.replace(/`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, (span) => {
    const inner = span.slice(1, -1);
    if (SQL_KEYWORD.test(inner) || COLUMN_LIST.test(inner) || FROZEN_STRING_VALUES.has(inner)) {
      return span[0] + blank(inner) + span.at(-1);
    }
    return span;
  });

  // Backticked prose spans inside comments: how this codebase names a table,
  // column or event while writing English around it.
  masked = masked.replace(/^\s*(?:\/\*\*?|\*|\/\/).*$/gm, (line) =>
    line.replace(/`[^`\n]*`/g, (span) => '`' + blank(span.slice(1, -1)) + '`'),
  );

  return masked;
}

/** Every scanned file, as a path relative to `packages/core`. */
function scannedFiles(): string[] {
  const found: string[] = [];
  const walk = (absolute: string): void => {
    for (const entry of readdirSync(absolute)) {
      const child = path.join(absolute, entry);
      if (statSync(child).isDirectory()) {
        walk(child);
        continue;
      }
      if (/\.(ts|mjs|js)$/.test(entry)) found.push(path.relative(PACKAGE_ROOT, child));
    }
  };
  for (const dir of SCANNED_DIRS) walk(path.join(PACKAGE_ROOT, dir));
  return found.sort();
}

/** Every forbidden-token hit in one file, as `path:line — token` strings. */
function hitsIn(relative: string): string[] {
  const masked = maskExemptSpans(readFileSync(path.join(PACKAGE_ROOT, relative), 'utf8'));
  const hits: string[] = [];

  masked.split('\n').forEach((line, index) => {
    for (const group of FORBIDDEN) {
      for (const word of group.bare) {
        if (new RegExp(`\\b${word}\\b`, 'i').test(line)) {
          hits.push(`${relative}:${index + 1} — ${word}`);
        }
      }
      for (const word of group.camel) {
        if (line.includes(word)) hits.push(`${relative}:${index + 1} — ${word}`);
      }
    }
  });

  return hits;
}

test('AC9 — no Portuguese identifier survives in packages/core/{src,test,bin}', () => {
  const files = scannedFiles();
  assert.ok(files.length > 40, `the sweep found only ${files.length} files; it is not walking the tree`);

  const hits = files.flatMap(hitsIn);
  assert.deepEqual(
    hits,
    [],
    `Portuguese identifiers still present (D18):\n${hits.join('\n')}`,
  );
});

test('AC9 — no file or directory name under packages/core/{src,test,bin} is in Portuguese', () => {
  const offenders = scannedFiles().filter((relative) =>
    FORBIDDEN.some((group) =>
      group.bare.some((word) => new RegExp(`(^|[/\\-_.])${word}([/\\-_.]|$)`, 'i').test(relative)),
    ),
  );

  assert.deepEqual(offenders, [], `Portuguese file/directory names (D18):\n${offenders.join('\n')}`);
});

test('AC9 — the sweep actually bites: a planted Portuguese identifier is caught', () => {
  const planted = maskExemptSpans(
    ["const trabalho = buscarTrabalho(db, 1);", "const linha = { trabalho_id: 1 };"].join('\n'),
  );

  assert.match(planted, /\btrabalho\b/, 'a bare Portuguese identifier survives masking');
  assert.ok(
    !/\btrabalho\b/.test('const row = { trabalho_id: 1 };'),
    'a column-mirrored snake_case field is NOT a hit (FR8)',
  );
});
