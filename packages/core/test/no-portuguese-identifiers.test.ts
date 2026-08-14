/**
 * D18 gate: no Portuguese code identifiers left in `packages/core` (t127, AC9).
 *
 * This is AC1's sweep turned into a deterministic, re-runnable test instead of a
 * checklist a reviewer maintains by hand. It walks `src/`, `test/` and `bin/`,
 * masks out everything FR8 deliberately leaves in Portuguese, and then asserts
 * that none of the pre-rename tokens of the ticket's Glossary and Code Changes
 * table survives in an identifier position.
 *
 * What gets masked, and why — these are the FR8 exceptions, not loopholes:
 *
 * - **String and template literals.** This is where SQL (`FROM trabalho`,
 *   `criado_em`), event-type strings (`'trabalho.criado'`), CHECK-constrained
 *   enum values (`'pendente'`, `'usuario'`) and the frozen wire codes live. The
 *   schema is untouched (AC3) and the taxonomy governs the event vocabulary, so
 *   none of it translates.
 * - **Key and member positions.** A wire field that mirrors a migration column
 *   is still spelled in Portuguese in the code that builds or reads it —
 *   `{ grafo_versao: version }`, `body.grafo`, `erro: 'grafo_invalido'`. Those
 *   are the data format, not code (FR8).
 * - **Backticked spans inside comments**, which is how this codebase quotes a
 *   table, column or event name while writing English prose around it.
 *
 * What is left after masking is a real identifier position — a variable, a
 * parameter, a function, a type, a const, an import binding — and from D18
 * onward those are English.
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
 * `bare` matches the standalone lowercase word — `\btrabalho\b` fires on a
 * variable named `trabalho` but never on the column `trabalho_id`, because `_`
 * is a word character. `camel` matches the capitalized form when it starts a
 * word inside an identifier, which is what catches `buscarTrabalho`,
 * `LinhaTrabalho` or `EntradaCriarTrabalho` — and, thanks to the "not followed
 * by a lowercase letter" rule, never catches the English `Error` with `Erro`.
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
      'subir',
      'pedir',
      'conferir',
      'exigir',
      'anotar',
      'percorrer',
      'mutar',
      'hidratar',
      'liberar',
      'renovar',
      'conceder',
      'avancar',
    ],
    camel: [],
  },
]);

/** Replaces a span with same-length blanks, so line numbers stay honest. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

/**
 * Single left-to-right pass that blanks out every string literal, every template
 * literal and every backticked span inside a comment.
 *
 * A hand-written scanner and not a regex alternation: with alternation, one
 * backtick in a comment can swallow the quoted strings that follow it, and the
 * masking silently stops applying — which is how a sweep quietly stops biting.
 *
 * @param source File contents.
 * @returns The same text, same length, with those spans blanked.
 */
function maskLiteralsAndCommentQuotes(source: string): string {
  const out: string[] = [];
  let index = 0;

  const readDelimited = (quote: string): void => {
    // Opening delimiter stays, the content is blanked, the closing one stays.
    out.push(source[index]);
    index += 1;
    const start = index;
    while (index < source.length) {
      const char = source[index];
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === quote) break;
      // A plain quote never spans lines; a template literal may.
      if (char === '\n' && quote !== '`') break;
      index += 1;
    }
    out.push(blank(source.slice(start, Math.min(index, source.length))));
    if (index < source.length) {
      out.push(source[index]);
      index += 1;
    }
  };

  const readComment = (end: string): void => {
    const start = index;
    const stop = source.indexOf(end, index + 2);
    const finish = stop === -1 ? source.length : stop + end.length;
    // Inside a comment only the backticked spans are masked: the English prose
    // around them still has to be scanned.
    out.push(source.slice(start, finish).replace(/`[^`\n]*`/g, (span) => `\`${blank(span.slice(1, -1))}\``));
    index = finish;
  };

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === '/' && next === '/') {
      readComment('\n');
      continue;
    }
    if (char === '/' && next === '*') {
      readComment('*/');
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      readDelimited(char);
      continue;
    }
    out.push(char);
    index += 1;
  }

  return out.join('');
}

/**
 * Blanks the token when it sits in a key or member position.
 *
 * `{ grafo_versao: version }`, `body.grafo`, `erro: 'x'` and `versoes?: Row[]`
 * are the wire format FR8 freezes; a bare `const grafo = …` is not.
 */
function maskKeyAndMemberPositions(text: string, token: string): string {
  const boundary = '(?![A-Za-z0-9_])';
  return text
    // property access / optional chaining: `.grafo`
    .replace(new RegExp(`\\.\\s*${token}${boundary}`, 'g'), (span) => blank(span))
    // object key, interface member, destructuring rename: `grafo:` / `grafo?:`
    .replace(new RegExp(`(^|[{,(\\s])${token}\\s*\\??\\s*:`, 'gm'), (span) => blank(span));
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

/** Every forbidden-token hit in one source text, as `line — token` pairs. */
export function hitsInSource(source: string): Array<{ line: number; token: string }> {
  const masked = maskLiteralsAndCommentQuotes(source);
  const hits: Array<{ line: number; token: string }> = [];

  masked.split('\n').forEach((rawLine, index) => {
    for (const group of FORBIDDEN) {
      for (const word of group.bare) {
        let line = rawLine;
        for (const token of [word, word[0].toUpperCase() + word.slice(1)]) {
          line = maskKeyAndMemberPositions(line, token);
        }
        const screaming = word.toUpperCase();
        if (
          // standalone word: `const trabalho = …` (never the column `trabalho_id`)
          new RegExp(`\\b${word}\\b`, 'i').test(line) ||
          // SCREAMING_SNAKE segment: `PREFIXO_API`
          new RegExp(`\\b${screaming}(_|\\b)`).test(line) ||
          // camelCase prefix: `criarApp`, `listarClasses`
          new RegExp(`\\b${word}(?=[A-Z])`).test(line)
        ) {
          hits.push({ line: index + 1, token: word });
        }
      }
      for (const word of group.camel) {
        const line = maskKeyAndMemberPositions(rawLine, word);
        // `Erro` must not fire on the English `Error`: a capitalized token only
        // counts when the next character does not continue the same word.
        if (new RegExp(`${word}(?![a-z])`).test(line)) {
          hits.push({ line: index + 1, token: word });
        }
      }
    }
  });

  return hits;
}

test('AC9 — no Portuguese identifier survives in packages/core/{src,test,bin}', () => {
  const files = scannedFiles();
  assert.ok(files.length > 30, `the sweep found only ${files.length} files; it is not walking the tree`);

  const hits = files.flatMap((relative) =>
    hitsInSource(readFileSync(path.join(PACKAGE_ROOT, relative), 'utf8')).map(
      (hit) => `${relative}:${hit.line} — ${hit.token}`,
    ),
  );

  assert.deepEqual(hits, [], `Portuguese identifiers still present (D18):\n${hits.join('\n')}`);
});

test('AC9 — no file or directory name under packages/core/{src,test,bin} is in Portuguese', () => {
  const offenders = scannedFiles().filter((relative) =>
    FORBIDDEN.some((group) =>
      group.bare.some((word) => new RegExp(`(^|[/\\-_.])${word}([/\\-_.]|$)`, 'i').test(relative)),
    ),
  );

  assert.deepEqual(offenders, [], `Portuguese file/directory names (D18):\n${offenders.join('\n')}`);
});

test('AC9 — the sweep bites on real Portuguese identifiers', () => {
  const caught = [
    'const trabalho = getJob(db, 1);',
    'function buscarGrafo(db) { return db; }',
    'export interface LinhaTrabalho { id: number }',
    'const { erro } = report;',
    'export const PREFIXO_API = 1;',
    'import { criarApp } from "./server.ts";',
    '// a versao corrente do grafo muda aqui',
  ];
  for (const source of caught) {
    assert.ok(hitsInSource(source).length > 0, `the sweep missed a Portuguese identifier: ${source}`);
  }
});

test('AC9 — the sweep does NOT bite on the FR8 exceptions', () => {
  const allowed = [
    // column-mirrored snake_case fields
    'const row = { trabalho_id: 1, criado_em: now(), grafo_versao_id: null };',
    // wire keys in key and member position
    'return { grafo: graph, grafo_versao: version };',
    'const version = body.grafo_versao;',
    "reply.code(422); return { erro: 'grafo_invalido', ...report };",
    'export interface StructureError { codigo: string; mensagem: string; alvo: unknown }',
    // SQL and enum/event-type literals
    "db.prepare('SELECT id, criado_em FROM trabalho WHERE id = ?');",
    "recordEvent(db, { tipo: 'trabalho.criado' });",
    "export type LeaseStatus = 'ativa' | 'liberada' | 'expirada';",
    // English code that merely contains a forbidden token as a substring
    'export class ValidationError extends Error { readonly errors: string[]; }',
    'throw new NetworkError(url, cause);',
    // a backticked frozen name inside English prose
    '/** The `evento` table and the `trabalho.criado` type stay Portuguese. */',
  ];
  for (const source of allowed) {
    assert.deepEqual(
      hitsInSource(source),
      [],
      `the sweep flagged an FR8 exception: ${source}`,
    );
  }
});
