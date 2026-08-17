/**
 * D18 gate: no Portuguese code identifier left in `scripts/` (t133, AC1).
 *
 * Port of `packages/core/test/no-portuguese-identifiers.test.ts`, with one
 * addition the core original does not need: a list of frozen EXPORT names.
 *
 * ## Why `validar-grafo.mjs` keeps four names, and nothing else
 *
 * `packages/core/test/domain-graph.test.ts` imports `scripts/validar-grafo.mjs`
 * BY PATH, destructures it by the names `validarEstrutura` / `validarSoundness`,
 * and `deepEqual`s its report against `packages/core/src/domain/graph.ts` on
 * every fixture in `schema/exemplos/`. Renaming one of those four exports turns
 * core's suite red without a line of core changing, so they are masked here —
 * moving them is `scripts/`' own D18 identifier migration, and that ticket does
 * not exist yet.
 *
 * The REPORT that file answers with used to be frozen alongside them, and this
 * file carried a per-file token exemption for it. t230 (D20's fifth child) moved
 * the whole report vocabulary to English in lockstep with the port, so the
 * exemption went with it: `valido`, `erros`, `violacoes`, `codigo`, `mensagem`,
 * `alvo`, `regra` and `estrutura` are now ordinary Portuguese words in a script,
 * and the general sweep below is what keeps them from coming back.
 *
 * `check-single-writer.mjs` keeps its path for the same kind of reason as the
 * file name above — three packages spawn it by path and read its exit code — but
 * nothing imports a name out of it, so its insides are freely renamable.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const SCRIPTS_DIR = path.resolve(import.meta.dirname);

/** Pre-rename tokens of the t127 glossary plus the scripts' own vocabulary. */
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

  // Report vocabulary (English since t230, `validar-grafo.mjs` included).
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
  { bare: ['banco', 'dono', 'donos'], camel: ['Banco', 'Dono'] },
  { bare: ['resumo', 'resultado'], camel: ['Resumo', 'Resultado'] },
  { bare: ['entrada', 'entradas', 'saida', 'saidas'], camel: ['Entrada', 'Saida'] },
  { bare: ['fila', 'ponta', 'pontas'], camel: ['Fila', 'Ponta'] },
  { bare: ['vizinho', 'vizinhos'], camel: ['Vizinho'] },
  { bare: ['semente', 'sementes'], camel: ['Semente'] },
  { bare: ['visitado', 'visitados'], camel: ['Visitado'] },
  { bare: ['conhecido', 'conhecidos'], camel: ['Conhecido'] },
  { bare: ['alcancado', 'alcancados', 'alcancavel'], camel: ['Alcancado'] },
  { bare: ['esperado', 'esperados', 'principal'], camel: ['Esperado'] },

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

/**
 * The reference validator's four exported names, frozen WHEREVER they appear.
 *
 * `packages/core/test/domain-graph.test.ts` imports the first two by name, and
 * `validate-factory-bundle.mjs` imports `validarGrafo` from the same module.
 * Masking the exact spellings — rather than the words `validar` and `grafo`
 * everywhere — keeps the exemption narrow: a NEW `validarAlgumaCoisa` in either
 * file is still flagged.
 */
const FROZEN_IDENTIFIERS = Object.freeze([
  'validarEstrutura',
  'validarSoundness',
  'validarGrafo',
  'carregarGrafo',
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
  /** Are we blanking template text right now, as opposed to reading code? */
  let inTemplateBody = false;
  /** Brace depth at which each open `${…}` closes and its template resumes. */
  const interpolations = [];
  let braceDepth = 0;

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
      // A plain quote never spans lines.
      if (char === '\n') break;
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

  /**
   * Blanks one run of template text, stopping at the closing backtick or at the
   * `${` that opens an interpolation.
   *
   * Templates need their own reader because they NEST: a backtick can sit
   * inside a template's own interpolation, and a reader that just scans for
   * "the next backtick" would take that one for the closing delimiter, drop
   * back into code mode halfway through a string, and start reporting the text
   * inside it as identifiers. The interpolated expressions themselves are read
   * as code, which is what a template literal actually is.
   *
   * @returns {boolean} `true` when the template closed, `false` when `${` opened.
   */
  const readTemplateChunk = () => {
    const start = index;
    while (index < source.length) {
      const char = source[index];
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === '`') break;
      if (char === '$' && source[index + 1] === '{') break;
      index += 1;
    }
    out.push(blank(source.slice(start, Math.min(index, source.length))));
    if (index >= source.length) return true;
    if (source[index] === '`') {
      out.push('`');
      index += 1;
      return true;
    }
    out.push('${');
    index += 2;
    return false;
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
    if (inTemplateBody) {
      if (readTemplateChunk()) {
        lastMeaningful = '`';
      } else {
        interpolations.push(braceDepth);
        lastMeaningful = '{';
      }
      inTemplateBody = false;
      lastWord = '';
      continue;
    }

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
    if (char === "'" || char === '"') {
      readDelimited(char);
      lastMeaningful = char;
      lastWord = '';
      continue;
    }
    if (char === '`') {
      out.push('`');
      index += 1;
      inTemplateBody = true;
      continue;
    }
    if (char === '/' && (REGEX_PRECEDERS.has(lastMeaningful) || REGEX_KEYWORDS.has(lastWord))) {
      readRegex();
      lastMeaningful = '/';
      lastWord = '';
      continue;
    }

    if (char === '{') {
      braceDepth += 1;
    } else if (char === '}') {
      if (interpolations.length > 0 && braceDepth === interpolations[interpolations.length - 1]) {
        // This `}` closes a `${…}`: the template text picks up right after it.
        interpolations.pop();
        out.push('}');
        index += 1;
        inTemplateBody = true;
        lastMeaningful = '}';
        lastWord = '';
        continue;
      }
      braceDepth -= 1;
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
/** Blanks the pinned export names, so only NEW Portuguese around them counts. */
function maskFrozenIdentifiers(text) {
  let out = text;
  for (const name of FROZEN_IDENTIFIERS) {
    out = out.replace(new RegExp(`\\b${name}\\b`, 'g'), (span) => blank(span));
  }
  return out;
}

function maskKeyAndMemberPositions(text, token) {
  const boundary = '(?![A-Za-z0-9_])';
  return text
    .replace(new RegExp(`\\.\\s*${token}${boundary}`, 'g'), (span) => blank(span))
    .replace(new RegExp(`(^|[{,(\\s])${token}\\s*\\??\\s*:`, 'gm'), (span) => blank(span));
}

/** Every scanned file, as a name relative to `scripts/`. */
function scannedFiles() {
  return readdirSync(SCRIPTS_DIR)
    .filter((name) => name.endsWith('.mjs'))
    .sort();
}

/**
 * Every forbidden-token hit in one source text, as `line — token` pairs.
 *
 * @param {string} source File contents.
 */
export function hitsInSource(source) {
  const masked = maskFrozenIdentifiers(maskLiteralsAndCommentQuotes(source));
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
const RENAMED_AWAY = Object.freeze(['validar-bundle-fabrica.mjs']);

/**
 * File names that stay in Portuguese on purpose, each pinned from outside.
 *
 * `validar-grafo.mjs` is imported by path from
 * `packages/core/test/domain-graph.test.ts`; `check-single-writer.mjs` is
 * spawned by path from three packages' `no-privileged-access.test.ts`.
 */
const FROZEN_FILE_NAMES = Object.freeze(['validar-grafo.mjs', 'check-single-writer.mjs']);

test('AC1 — no Portuguese identifier survives in scripts/*.mjs', () => {
  const files = scannedFiles();
  assert.ok(files.length >= 4, `the sweep found only ${files.length} files; it is not reading the directory`);

  const hits = files.flatMap((name) =>
    hitsInSource(readFileSync(path.join(SCRIPTS_DIR, name), 'utf8')).map(
      (hit) => `${name}:${hit.line} — ${hit.token}`,
    ),
  );

  assert.deepEqual(hits, [], `Portuguese identifiers still present (D18):\n${hits.join('\n')}`);
});

test('AC1 — no script file name is in Portuguese, bar the two pinned from outside', () => {
  const names = scannedFiles();
  const offenders = RENAMED_AWAY.filter((name) => names.includes(name));

  assert.deepEqual(offenders, [], `Portuguese script names (D18):\n${offenders.join('\n')}`);
  for (const frozen of FROZEN_FILE_NAMES) {
    assert.ok(names.includes(frozen), `${frozen} is pinned by path from outside and must not move`);
  }
});

test('exception 5 — validar-grafo.mjs keeps the four names core pins, and nothing more', async () => {
  const source = readFileSync(path.join(SCRIPTS_DIR, 'validar-grafo.mjs'), 'utf8');

  // The four exports `packages/core/test/domain-graph.test.ts` imports by name.
  const validator = await import('./validar-grafo.mjs');
  for (const exported of ['validarEstrutura', 'validarSoundness', 'validarGrafo', 'carregarGrafo']) {
    assert.equal(typeof validator[exported], 'function', `${exported} is pinned by core's suite`);
  }

  // The report shape it `deepEqual`s against `packages/core/src/domain/graph.ts`
  // — English since t230, in both files at once, or that parity test falls over.
  const structure = validator.validarEstrutura(null);
  assert.deepEqual(Object.keys(structure).sort(), ['errors', 'valid']);
  assert.deepEqual(Object.keys(structure.errors[0]).sort(), ['code', 'message', 'target']);

  const soundness = validator.validarSoundness({ nodes: [{ id: 'a' }], edges: [] });
  assert.deepEqual(Object.keys(soundness).sort(), ['valid', 'violations']);
  assert.deepEqual(Object.keys(soundness.violations[0]).sort(), ['rule', 'target']);

  // The exception is now the four names and only the four names: with the
  // report in English, the general sweep runs over this file with no exemption
  // at all, and `FROZEN_IDENTIFIERS` is what keeps it from demanding a rename
  // core's suite forbids.
  assert.deepEqual(hitsInSource(source), [], 'the pinned file still has renamable Portuguese in it');
  assert.ok(
    hitsInSource(source.replace(/\bvalidarEstrutura\b/g, 'validarShape')).length > 0,
    'the export mask is dead code; the sweep no longer bites on a Portuguese export name',
  );
});

test('AC1 — the sweep bites on real Portuguese identifiers', () => {
  const caught = [
    'const relatorio = readReport(doc);',
    'function percorrer(sementes, vizinhos) { return sementes; }',
    // the exemption is the exact spelling, not the words in it
    'export function validarBundle(dir) { return dir; }',
    'const arestas = doc.arestas ?? [];',
    'export const PREFIXO_DONO_DO_BANCO = "packages/core";',
    'let houveFalha = false;',
    '// o caminho do arquivo de manifesto',
  ];
  for (const source of caught) {
    assert.ok(hitsInSource(source).length > 0, `the sweep missed a Portuguese identifier: ${source}`);
  }
});

test('AC1 — the sweep does NOT bite on the frozen exceptions', () => {
  const allowed = [
    // graph-bundle JSON Schema keys, in key and member position (D18 carve-out)
    'const nodes = doc.nos ?? [];',
    'for (const edge of doc.arestas) report(edge.de, edge.para, edge.condicao);',
    'const ref = node.skill_ref; return ref.versao && ref.hash;',
    'return { no_inicial: entry, nos_finais: exits, tipo_no: kind, papel: role };',
    'const contract = node.contrato; return contract.entrada_schema && contract.saida_schema;',
    // literals: every schema key and enum value lives in one
    "const REQUIRED = ['classe', 'linhagem', 'metadata', 'nos', 'arestas', 'no_inicial'];",
    "annotate('campo_obrigatorio_ausente', `campo obrigatório ausente: \"${field}\"`);",
    // a template nested inside another template's interpolation: the masking
    // has to survive it, or everything after the inner backtick reads as code
    'const line = `${name}: ${ok ? `valido` : `erro ${n}`}`;',
    // English code that merely contains a forbidden token as a substring
    'export class ValidationError extends Error { readonly errors = []; }',
    'const half = total / 1000;',
    // the pinned export names, at the call site that imports them
    "import { validarGrafo } from './validar-grafo.mjs';",
    'const report = validarGrafo(carregarGrafo(filePath));',
    // a backticked frozen name inside English prose
    '/** `validarEstrutura` is pinned by core; its `valido` / `erros` report is not. */',
  ];
  for (const source of allowed) {
    assert.deepEqual(hitsInSource(source), [], `the sweep flagged a frozen exception: ${source}`);
  }
});
