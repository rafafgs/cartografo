/**
 * D18 gate: no Portuguese code identifier left in the root `tests/` (t133, AC1).
 *
 * Port of `packages/core/test/no-portuguese-identifiers.test.ts`. Same masking,
 * same reading of what counts as an identifier position.
 *
 * The frozen exceptions that matter here are all data, not code: the
 * graph-bundle and skill-manifest JSON Schema keys (`classe`, `linhagem`,
 * `nos`, `arestas`, `no_inicial`, `nos_finais`, `papel`, `tipo_no`, `skill_ref`,
 * `contrato`, `de`, `para`, `condicao`, `versao`, `hash`, `entrada_schema`,
 * `saida_schema`, `verificacoes`) stay Portuguese per D18's own carve-out, and
 * so do the directory names these tests build paths to — `schema/exemplos/` and
 * `grafos-de-fabrica/desenvolvimento-de-software/` are out of this ticket's
 * scope. All of them live in a literal or a member position, so the masking
 * covers them without a per-file exemption list.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const TESTS_DIR = path.resolve(import.meta.dirname);

/** Pre-rename tokens of the t127 glossary plus these tests' own vocabulary. */
const FORBIDDEN = Object.freeze([
  // Graph and bundle vocabulary.
  { bare: ['grafo', 'grafos'], camel: ['Grafo', 'Grafos'] },
  { bare: ['aresta', 'arestas'], camel: ['Aresta', 'Arestas'] },
  { bare: ['nos', 'finais'], camel: ['Nos', 'Finais'] },
  { bare: ['fabrica'], camel: ['Fabrica'] },
  { bare: ['classe', 'classes', 'linhagem'], camel: ['Classe', 'Linhagem'] },
  { bare: ['contrato', 'contratos'], camel: ['Contrato'] },
  { bare: ['manifesto', 'documento'], camel: ['Manifesto', 'Documento'] },
  { bare: ['versao', 'versoes'], camel: ['Versao'] },
  { bare: ['skill', 'skills'], camel: [] },

  // Report vocabulary.
  { bare: ['valido', 'validos'], camel: ['Valido'] },
  { bare: ['violacao', 'violacoes'], camel: ['Violacao', 'Violacoes'] },
  { bare: ['regra', 'regras'], camel: ['Regra', 'Regras'] },
  { bare: ['alvo', 'codigo', 'mensagem'], camel: ['Alvo', 'Codigo', 'Mensagem'] },
  { bare: ['erro', 'erros'], camel: ['Erro'] },
  { bare: ['estrutura', 'relatorio'], camel: ['Estrutura', 'Relatorio'] },
  { bare: ['falha', 'falhas'], camel: ['Falha'] },

  // Structural vocabulary (t127 glossary).
  { bare: ['caminho', 'caminhos'], camel: ['Caminho'] },
  { bare: ['prefixo', 'padrao'], camel: ['Prefixo', 'Padrao'] },
  { bare: ['arquivo', 'arquivos'], camel: ['Arquivo'] },
  { bare: ['diretorio', 'raiz', 'pacote'], camel: ['Diretorio', 'Raiz', 'Pacote'] },
  { bare: ['linha', 'linhas', 'coluna'], camel: ['Linha', 'Coluna'] },
  { bare: ['campo', 'campos'], camel: ['Campo', 'Campos'] },
  { bare: ['valor', 'valores', 'texto'], camel: ['Valor', 'Texto'] },
  { bare: ['indice', 'numero', 'tamanho'], camel: ['Indice', 'Numero', 'Tamanho'] },
  { bare: ['objeto', 'preenchido'], camel: ['Objeto', 'Preenchido'] },
  { bare: ['resumo', 'resultado'], camel: ['Resumo', 'Resultado'] },
  { bare: ['entrada', 'entradas', 'saida', 'saidas'], camel: ['Entrada', 'Saida'] },
  { bare: ['esperado', 'esperados', 'principal'], camel: ['Esperado'] },
  { bare: ['exemplo', 'exemplos'], camel: ['Exemplo'] },
  { bare: ['lido', 'lidos', 'todos'], camel: [] },

  // Verbs the glossary maps, as identifiers.
  {
    bare: [
      'eh',
      'validar',
      'carregar',
      'verificar',
      'conferir',
      'extrair',
      'percorrer',
      'anotar',
      'criar',
      'buscar',
      'listar',
      'ler',
      'montar',
      'rodar',
      'checar',
      'exigir',
      'importar',
      'exportar',
    ],
    camel: [],
  },
]);

/** Replaces a span with same-length blanks, so line numbers stay honest. */
function blank(text) {
  return text.replace(/[^\n]/g, ' ');
}

/** Words after which a `/` opens a regular expression instead of dividing. */
const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'do',
  'else',
  'yield',
  'await',
  'delete',
  'void',
  'new',
]);

/** Characters after which a `/` opens a regular expression. */
const REGEX_PRECEDERS = new Set([
  '',
  '=',
  '(',
  ',',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '^',
  '~',
  '<',
  '>',
]);

/**
 * Single left-to-right pass that blanks out every string literal, template
 * literal, regular-expression literal and backticked span inside a comment.
 *
 * A hand-written scanner and not a regex alternation: with alternation, one
 * backtick in a comment can swallow the quoted strings that follow it, and the
 * masking silently stops applying — which is how a sweep quietly stops biting.
 *
 * @param {string} source File contents.
 * @returns {string} The same text, same length, with those spans blanked.
 */
export function maskLiteralsAndCommentQuotes(source) {
  const out = [];
  let index = 0;
  let lastMeaningful = '';
  let lastWord = '';

  const readDelimited = (quote) => {
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
      if (char === '\n' && quote !== '`') break;
      index += 1;
    }
    out.push(blank(source.slice(start, Math.min(index, source.length))));
    if (index < source.length) {
      out.push(source[index]);
      index += 1;
    }
  };

  /** Reads `/…/flags`, honouring `\/` escapes and `/` inside a `[…]` class. */
  const readRegex = () => {
    out.push(source[index]);
    index += 1;
    const start = index;
    let inClass = false;
    while (index < source.length) {
      const char = source[index];
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === '\n') break;
      if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      else if (char === '/' && !inClass) break;
      index += 1;
    }
    out.push(blank(source.slice(start, Math.min(index, source.length))));
    if (index < source.length) {
      out.push(source[index]);
      index += 1;
    }
  };

  const readComment = (end) => {
    const start = index;
    const stop = source.indexOf(end, index + 2);
    const finish = stop === -1 ? source.length : stop + end.length;
    out.push(
      source.slice(start, finish).replace(/`[^`\n]*`/g, (span) => `\`${blank(span.slice(1, -1))}\``),
    );
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
      lastMeaningful = char;
      lastWord = '';
      continue;
    }
    if (char === '/' && (REGEX_PRECEDERS.has(lastMeaningful) || REGEX_KEYWORDS.has(lastWord))) {
      readRegex();
      lastMeaningful = '/';
      lastWord = '';
      continue;
    }

    out.push(char);
    if (/[A-Za-z0-9_$]/.test(char)) {
      lastWord += char;
    } else if (!/\s/.test(char)) {
      lastWord = '';
    }
    if (!/\s/.test(char)) lastMeaningful = char;
    index += 1;
  }

  return out.join('');
}

/**
 * Blanks the token when it sits in a key or member position.
 *
 * `doc.nos`, `{ no_inicial: id }` and `aresta.condicao` are the graph-bundle
 * JSON Schema, frozen by D18's own carve-out; a bare `const nos = …` is not.
 */
function maskKeyAndMemberPositions(text, token) {
  const boundary = '(?![A-Za-z0-9_])';
  return text
    .replace(new RegExp(`\\.\\s*${token}${boundary}`, 'g'), (span) => blank(span))
    .replace(new RegExp(`(^|[{,(\\s])${token}\\s*\\??\\s*:`, 'gm'), (span) => blank(span));
}

/** Every scanned file, as a name relative to `tests/`. */
function scannedFiles() {
  return readdirSync(TESTS_DIR)
    .filter((name) => name.endsWith('.mjs'))
    .sort();
}

/** Every forbidden-token hit in one source text, as `line — token` pairs. */
export function hitsInSource(source) {
  const masked = maskLiteralsAndCommentQuotes(source);
  const hits = [];

  masked.split('\n').forEach((rawLine, index) => {
    for (const group of FORBIDDEN) {
      for (const word of group.bare) {
        let line = rawLine;
        for (const token of [word, word[0].toUpperCase() + word.slice(1)]) {
          line = maskKeyAndMemberPositions(line, token);
        }
        const screaming = word.toUpperCase();
        if (
          new RegExp(`\\b${word}\\b`, 'i').test(line) ||
          new RegExp(`\\b${screaming}(_|\\b)`).test(line) ||
          new RegExp(`\\b${word}(?=[A-Z])`).test(line)
        ) {
          hits.push({ line: index + 1, token: word });
        }
      }
      for (const word of group.camel) {
        const line = maskKeyAndMemberPositions(rawLine, word);
        if (new RegExp(`${word}(?![a-z])`).test(line)) {
          hits.push({ line: index + 1, token: word });
        }
      }
    }
  });

  return hits;
}

/** File names this ticket renames away. */
const RENAMED_AWAY = Object.freeze(['grafo-fabrica-1.test.mjs', 'schema-grafo.test.mjs']);

test('AC1 — no Portuguese identifier survives in tests/*.mjs', () => {
  const files = scannedFiles();
  assert.ok(files.length >= 3, `the sweep found only ${files.length} files; it is not reading the directory`);

  const hits = files.flatMap((name) =>
    hitsInSource(readFileSync(path.join(TESTS_DIR, name), 'utf8')).map(
      (hit) => `${name}:${hit.line} — ${hit.token}`,
    ),
  );

  assert.deepEqual(hits, [], `Portuguese identifiers still present (D18):\n${hits.join('\n')}`);
});

test('AC1 — no root test file name is in Portuguese', () => {
  const names = scannedFiles();
  const offenders = RENAMED_AWAY.filter((name) => names.includes(name));

  assert.deepEqual(offenders, [], `Portuguese test file names (D18):\n${offenders.join('\n')}`);
});

test('AC1 — the sweep bites on real Portuguese identifiers', () => {
  const caught = [
    'const grafo = carregarGrafo(caminho);',
    'function lerExemplos(diretorio) { return diretorio; }',
    'const relatorio = validate(doc);',
    'export const RAIZ_REPO = path.resolve(import.meta.dirname, "..");',
    '// o arquivo de manifesto da skill',
  ];
  for (const source of caught) {
    assert.ok(hitsInSource(source).length > 0, `the sweep missed a Portuguese identifier: ${source}`);
  }
});

test('AC1 — the sweep does NOT bite on the frozen exceptions', () => {
  const allowed = [
    // graph-bundle JSON Schema keys, in key and member position (D18 carve-out)
    'const nodes = doc.nos ?? [];',
    'for (const edge of doc.arestas) check(edge.de, edge.para, edge.condicao);',
    'const ref = node.skill_ref; assert.ok(ref.versao && ref.hash);',
    'return { no_inicial: entry, nos_finais: exits, tipo_no: kind, papel: role };',
    'const contract = node.contrato; assert.ok(contract.entrada_schema, contract.saida_schema);',
    // the out-of-scope directories these tests build paths to, all literals
    "const EXAMPLES = path.join(REPO_ROOT, 'schema', 'exemplos');",
    "const BUNDLE = path.join(REPO_ROOT, 'grafos-de-fabrica', 'desenvolvimento-de-software');",
    "assert.equal(report.violacoes[0].regra, 'alcançável');",
    // English code that merely contains a forbidden token as a substring
    'export class ValidationError extends Error { readonly errors = []; }',
    'const half = total / 1000;',
    // a backticked frozen name inside English prose
    '/** The `nos` / `arestas` keys and the `schema/exemplos/` fixtures stay put. */',
  ];
  for (const source of allowed) {
    assert.deepEqual(hitsInSource(source), [], `the sweep flagged a frozen exception: ${source}`);
  }
});
