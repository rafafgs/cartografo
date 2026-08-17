/**
 * D18 gate: no Portuguese code identifier in `packages/topografo` (t247, AT9).
 *
 * Port of `packages/topografo-custo/test/no-portuguese-identifiers.test.ts`,
 * which is itself the port of the shape t127 left in `packages/core`: walk the
 * package, mask out the positions where a Portuguese word is DATA rather than
 * code, and assert that no pre-rename token survives in an identifier position.
 *
 * The difference from every port before it: this package was born after D18 and
 * has no migration behind it. Its whole vocabulary — `watch`, `--lens`,
 * `--dry-run`, `posted`/`deduped`/`nothing`/`error`/`skipped` — is English from
 * the first commit, and this gate carries no per-file exception and no
 * allowlisted symbol. What it is here to catch is the NEXT change, not this one.
 *
 * The masking is the sibling's, and the reasons are its reasons:
 *
 * - **String and template literals**, where the wire vocabulary lives — the
 *   event type this package subscribes to, the body keys the two lenses put on
 *   the wire, the node ids of the fixture graph the e2e test drives.
 * - **Regular-expression literals**: a wire word matched by regex is the wire.
 * - **Key and member positions.** `result.proposta`, `{ execucao_id: id }`,
 *   `evidence.no_id` — a field mirrored from a JSON answer is the data format,
 *   not code. This package reads two of them (`proposta`, `criada`) off
 *   `SurveyorResult`, whose names belong to the book (`surveyor/proposal.ts`).
 * - **Backticked spans inside comments**, which is how this codebase quotes a
 *   frozen field or flag while writing English prose around it, and the
 *   multi-line form of the same thing.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const SCANNED_DIRS = ['src', 'test'];

/**
 * Pre-rename tokens of the t127/t133 glossary plus the vocabulary this package
 * would reach for if it slipped.
 *
 * `bare` matches the standalone lowercase word — `\bevento\b` fires on a
 * variable named `evento` but never on the wire field `evento_id`, because `_`
 * is a word character. `camel` matches the capitalized form when it starts a
 * word inside an identifier, and the "not followed by a lowercase letter" rule
 * is what keeps `Erro` from firing on the English `Error`.
 *
 * `no` (node) is deliberately absent for the reason the sibling records: it is
 * the English word for negation and the head of half the wire fields, so a gate
 * that flagged it would flag every English sentence in the package.
 */
const FORBIDDEN = Object.freeze([
  // Domain vocabulary (t127 glossary, reused verbatim).
  { bare: ['grafo', 'grafos'], camel: ['Grafo'] },
  { bare: ['trabalho', 'trabalhos'], camel: ['Trabalho', 'Trabalhos'] },
  { bare: ['sessao', 'sessoes'], camel: ['Sessao', 'Sessoes'] },
  { bare: ['execucao', 'execucoes'], camel: ['Execucao', 'Execucoes'] },
  { bare: ['proposta', 'propostas'], camel: ['Proposta', 'Propostas'] },
  { bare: ['versao', 'versoes'], camel: ['Versao', 'Versoes'] },
  { bare: ['evento', 'eventos'], camel: ['Evento', 'Eventos'] },
  { bare: ['pergunta', 'perguntas'], camel: ['Pergunta'] },

  // The surveyor vocabulary this package triggers, on both lenses.
  //
  // `topografo` itself is absent, and deliberately: it is this package's own
  // brand — the same reason the sibling's wire gate had to teach itself not to
  // fire on `topografo-custo` (D18 moves code, never a name a person types).
  { bare: ['lente', 'lentes'], camel: ['Lente'] },
  { bare: ['fluxo', 'fluxos', 'custo', 'custos'], camel: ['Fluxo', 'Custo'] },
  { bare: ['evidencia', 'evidencias', 'gargalo'], camel: ['Evidencia', 'Gargalo'] },
  { bare: ['metrica', 'metricas'], camel: ['Metrica', 'Metricas'] },
  { bare: ['candidata', 'candidatas', 'politica', 'politicas'], camel: ['Candidata', 'Politica'] },
  { bare: ['operacao', 'operacoes'], camel: ['Operacao'] },

  // The watcher's own nouns: stream, reconnection, dispatch. `cursor` is the
  // same word in both languages and is left out for it.
  { bare: ['fio', 'fios', 'retomada', 'reconexao'], camel: ['Retomada', 'Reconexao'] },
  { bare: ['conexao', 'conexoes', 'tentativa', 'tentativas'], camel: ['Conexao', 'Tentativa'] },
  { bare: ['despacho', 'despachos', 'despachar'], camel: ['Despacho'] },
  { bare: ['espera', 'fila', 'batida', 'batidas'], camel: ['Fila'] },
  { bare: ['desfecho', 'desfechos', 'relato', 'relatos'], camel: ['Desfecho', 'Relato'] },
  { bare: ['processo', 'processos'], camel: ['Processo'] },

  // Structural vocabulary (t127/t133 glossary).
  { bare: ['erro', 'erros'], camel: ['Erro'] },
  { bare: ['resposta', 'respostas', 'requisicao', 'corpo'], camel: ['Resposta', 'Requisicao', 'Corpo'] },
  { bare: ['linha', 'linhas', 'coluna', 'colunas'], camel: ['Linha', 'Linhas', 'Coluna'] },
  { bare: ['padrao', 'prefixo', 'caminho', 'caminhos'], camel: ['Padrao', 'Prefixo', 'Caminho'] },
  { bare: ['opcao', 'opcoes'], camel: ['Opcao', 'Opcoes'] },
  { bare: ['valor', 'valores', 'texto', 'textos'], camel: ['Valor', 'Valores', 'Texto'] },
  { bare: ['campo', 'campos', 'chave', 'chaves'], camel: ['Campo', 'Campos', 'Chave'] },
  { bare: ['filtro', 'filtros', 'consulta'], camel: ['Filtro', 'Consulta'] },
  { bare: ['resultado', 'resultados', 'metodo', 'verbo'], camel: ['Resultado', 'Metodo', 'Verbo'] },
  { bare: ['entrada', 'entradas', 'saida', 'saidas'], camel: ['Entrada', 'Saida'] },
  { bare: ['inicio', 'fim', 'duracao', 'instante'], camel: ['Inicio', 'Duracao'] },
  { bare: ['uso', 'usos', 'tipo', 'tipos', 'dado', 'dados'], camel: ['Uso', 'Tipo', 'Dado'] },
  { bare: ['numero', 'indice', 'tamanho', 'bruto'], camel: ['Numero', 'Indice', 'Tamanho', 'Bruto'] },
  { bare: ['raiz', 'pacote', 'modulo', 'arquivo'], camel: ['Raiz', 'Pacote', 'Modulo', 'Arquivo'] },
  { bare: ['ficha', 'fichas', 'secao', 'secoes'], camel: ['Ficha', 'Secao'] },
  { bare: ['mensagem', 'mensagens', 'credencial'], camel: ['Mensagem', 'Credencial'] },
  { bare: ['cabecalho', 'cabecalhos', 'ambiente'], camel: ['Cabecalho', 'Ambiente'] },
  { bare: ['comando', 'comandos', 'subcomando'], camel: ['Comando', 'Subcomando'] },
  { bare: ['argumento', 'argumentos', 'contexto'], camel: ['Argumento', 'Contexto'] },
  { bare: ['chamada', 'chamadas', 'espiao'], camel: ['Chamada', 'Chamadas', 'Espiao'] },
  { bare: ['prazo', 'pedaco', 'pedacos', 'sinal', 'sinais'], camel: ['Prazo', 'Pedaco', 'Sinal'] },
  { bare: ['filho', 'filhos', 'atual', 'restante'], camel: ['Filho', 'Atual', 'Restante'] },
  { bare: ['minimo', 'maximo', 'primeiro', 'ultimo'], camel: ['Minimo', 'Maximo', 'Primeiro', 'Ultimo'] },
  { bare: ['documento', 'registro', 'artefato'], camel: ['Documento', 'Registro', 'Artefato'] },
  { bare: ['anterior', 'proximo', 'alvo', 'codigo'], camel: ['Anterior', 'Proximo', 'Alvo', 'Codigo'] },
  { bare: ['falha', 'falhas', 'queda', 'quedas'], camel: ['Falha', 'Queda'] },

  // Verbs the glossary maps (`criar`→create, `buscar`→get, …), as identifiers.
  {
    bare: [
      'criar',
      'buscar',
      'listar',
      'registrar',
      'finalizar',
      'aplicar',
      'reverter',
      'abrir',
      'iniciar',
      'encerrar',
      'assistir',
      'observar',
      'ligar',
      'reconectar',
      'consumir',
      'despachar',
      'pedir',
      'conferir',
      'exigir',
      'montar',
      'formatar',
      'responder',
      'enviar',
      'ler',
      'pegar',
      'normalizar',
      'interpretar',
      'avaliar',
      'propor',
      'esperar',
      'chamar',
      'escrever',
      'validar',
      'verificar',
      'parar',
    ],
    camel: [],
  },
]);

/** Replaces a span with same-length blanks, so line numbers stay honest. */
function blank(text: string): string {
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
 * Single left-to-right pass that blanks out every string literal, every template
 * literal, every regular-expression literal and every backticked span inside a
 * comment.
 *
 * A hand-written scanner and not a regex alternation: with alternation, one
 * backtick in a comment can swallow the quoted strings that follow it, and the
 * masking silently stops applying — which is how a sweep quietly stops biting.
 *
 * @param source File contents.
 * @returns The same text, same length, with those spans blanked.
 */
export function maskLiteralsAndCommentQuotes(source: string): string {
  const out: string[] = [];
  let index = 0;
  let lastMeaningful = '';
  let lastWord = '';
  /** Are we blanking template text right now, as opposed to reading code? */
  let inTemplateBody = false;
  /** Brace depth at which each open `${…}` closes and its template resumes. */
  const interpolations: number[] = [];
  let braceDepth = 0;

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

  /**
   * Blanks one run of template text, stopping at the closing backtick or at the
   * `${` that opens an interpolation.
   *
   * Templates need their own reader because they NEST: a backtick inside an
   * interpolation would otherwise be read as the closing delimiter, dropping
   * the scanner back into code mode halfway through a string.
   *
   * @returns `true` when the template closed, `false` when `${` opened.
   */
  const readTemplateChunk = (): boolean => {
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

  /** Reads `/…/flags`, honouring `\/` escapes and `/` inside a `[…]` class. */
  const readRegex = (): void => {
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

  const readComment = (end: string): void => {
    const start = index;
    const stop = source.indexOf(end, index + 2);
    const finish = stop === -1 ? source.length : stop + end.length;
    // Inside a comment only the quoted spans are masked: the English prose
    // around them still has to be scanned. Fenced blocks go first, because they
    // contain the backticks the second rule looks for — and a fence is the same
    // quoting as a backticked span, only multi-line.
    out.push(
      source
        .slice(start, finish)
        .replace(/```[\s\S]*?```/g, (span) => `\`\`\`${blank(span.slice(3, -3))}\`\`\``)
        .replace(/`[^`\n]*`/g, (span) => `\`${blank(span.slice(1, -1))}\``),
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
 * `{ execucao_id: id }`, `result.proposta` and `opcoes?: []` are the wire format
 * somebody else owns; a bare `const proposta = …` is not.
 */
function maskKeyAndMemberPositions(text: string, token: string): string {
  const boundary = '(?![A-Za-z0-9_])';
  return text
    // property access / optional chaining: `.proposta`
    .replace(new RegExp(`\\.\\s*${token}${boundary}`, 'g'), (span) => blank(span))
    // object key, interface member, destructuring rename: `proposta:` / `proposta?:`
    .replace(new RegExp(`(^|[{,(\\s])${token}\\s*\\??\\s*:`, 'gm'), (span) => blank(span));
}

/** Every scanned file, as a path relative to `packages/topografo`. */
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
  for (const dir of SCANNED_DIRS) {
    const absolute = path.join(PACKAGE_ROOT, dir);
    assert.ok(existsSync(absolute), `artifact does not exist yet: packages/topografo/${dir}`);
    walk(absolute);
  }
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
          // standalone word: `const evento = …` (never the field `evento_id`)
          new RegExp(`\\b${word}\\b`, 'i').test(line) ||
          // any SCREAMING_SNAKE segment: `PORTA_PADRAO`, and also `TIER_FATOR_PADRAO`
          new RegExp(`(^|[^A-Za-z0-9])${screaming}(?![A-Za-z0-9])`).test(line) ||
          // camelCase prefix: `buscarSessoes`, `linhaDeRelatorio`
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

test('t247 — no Portuguese identifier survives in packages/topografo/{src,test}', () => {
  const files = scannedFiles();
  assert.ok(files.length >= 8, `the sweep found only ${files.length} files; it is not walking the tree`);

  const hits = files.flatMap((relative) =>
    hitsInSource(readFileSync(path.join(PACKAGE_ROOT, relative), 'utf8')).map(
      (hit) => `${relative}:${hit.line} — ${hit.token}`,
    ),
  );

  assert.deepEqual(hits, [], `Portuguese identifiers present (D18):\n${hits.join('\n')}`);
});

test('t247 — no Portuguese file name survives under packages/topografo/{src,test}', () => {
  // The same sweep, run over each file name as if it were a declaration: this
  // package renames nothing away, so there is no hand-written list of banished
  // names to assert against — only the rule itself, applied to what is there.
  const offenders = scannedFiles().filter(
    (relative) =>
      hitsInSource(`const ${path.basename(relative).replace(/[.-]/g, '_')} = 1;`).length > 0,
  );

  assert.deepEqual(offenders, [], `Portuguese file names (D18):\n${offenders.join('\n')}`);
});

test('t247 — the sweep bites on real Portuguese identifiers', () => {
  const caught = [
    'const evento = message.envelope;',
    'function despacharLentes(execucao) { return execucao; }',
    'export interface LinhaDeRelato { execution_id: number }',
    'const { erro } = report;',
    'export const PRAZO_PADRAO = 1000;',
    'export const BACKOFF_PADRAO_MS = 1000;',
    'import { assistirExecucoes } from "./stream.ts";',
    'export class ErroDeFio extends Error {}',
    'const propostas = await proposalsOf(plane);',
    '// a conexao cai e o cursor volta pelo cabecalho',
  ];
  for (const source of caught) {
    assert.ok(hitsInSource(source).length > 0, `the sweep missed a Portuguese identifier: ${source}`);
  }
});

test('t247 — the sweep does NOT bite on the frozen exceptions', () => {
  const allowed = [
    // the wire, in key and member position: what the two lenses answer with
    'const line = { execution_id: id, lens: "flow", outcome: "posted" };',
    'return { proposal_id: result.proposta?.id ?? null, created: result.criada };',
    'if (proposal.evidence.no_id === "revisar") return true;',
    'const version = row.grafo_versao_id;',
    // the fixture graph the e2e test drives, whose ids are data
    'await api(plane, "POST", `/v1/jobs/${job.id}/transitions`, { to_node_id: "revisar" });',
    'const OUTPUT_FILE = "proposta-topografo.json";',
    // English code that merely contains a forbidden token as a substring
    'export class ValidationError extends Error { readonly errors: string[]; }',
    'const parts = Partial<StreamMessage>;',
    'const half = total / 1000;',
    'const entries = Object.entries(fields);',
    // a backticked frozen name inside English prose
    '/** The `evidencia` / `metrica_esperada` free JSON stays exactly as it is. */',
    // the multi-line form of the same quoting: a whole invocation, fenced
    '/**\n * ```\n * cartografo-topografo watch --url http://127.0.0.1:4317 --token <token>\n * ```\n */',
  ];
  for (const source of allowed) {
    assert.deepEqual(hitsInSource(source), [], `the sweep flagged a frozen exception: ${source}`);
  }
});
