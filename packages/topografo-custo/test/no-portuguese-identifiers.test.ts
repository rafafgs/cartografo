/**
 * D18 gate: no Portuguese code identifier left in `packages/topografo-custo`
 * (t211, AT1/AT2).
 *
 * Port of `packages/tela/test/no-portuguese-identifiers.test.ts`, which is
 * itself the port of the shape t127 left behind in `packages/core`: walk the
 * package, mask out everything the ticket deliberately leaves in Portuguese,
 * and assert that no pre-rename token of the glossary survives in an identifier
 * position.
 *
 * What gets masked here, and why — these are the ticket's frozen exceptions,
 * not loopholes:
 *
 * - **String and template literals.** This is where the wire vocabulary lives,
 *   whole: the body keys the lens reads and writes (`sessoes`, `trabalhos`,
 *   `grafo_versao`, `proposta`, `no_id`, `evidencia`, `metrica_esperada`), the
 *   free-JSON values it emits (`teto`, `tier`, `custo`) and the CLI surface a
 *   person types (`avaliar`, `--teto-tokens`, `--tier-minimo-nos`). D20 freezes
 *   all of it as wire vocabulary, migrating only under t213 — not here.
 * - **Regular-expression literals**, for the same reason the screen's port
 *   masks them: a route or a wire word matched by regex is still the wire.
 * - **Key and member positions.** A field the lens mirrors from a core JSON
 *   response is still spelled in Portuguese in the code that reads it —
 *   `row.no_id`, `{ execucao_id: id }`, `evidencia.tipo`. That is the data
 *   format, not code.
 * - **Backticked spans inside comments**, which is how this codebase quotes a
 *   frozen field, flag or value while writing English prose around it — and the
 *   multi-line form of the same thing, a fenced block, which is how `src/cli.ts`
 *   shows a whole invocation.
 *
 * What is left after masking is a real identifier position — a variable, a
 * parameter, a function, a type, a const, an import binding — and from D18
 * onward those are English.
 *
 * One rule is stricter than the port it came from, and this package is why.
 * The screen's version anchors the SCREAMING_SNAKE check at a word boundary,
 * which only ever reaches the FIRST segment of a constant; the two constants
 * this ticket renames hide their Portuguese in the middle (`TIER_FATOR_PADRAO`,
 * `TIER_MINIMO_NOS_PADRAO`), and a gate that cannot see them would have gone
 * green over the exact names it was written to catch. Here any segment counts.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const SCANNED_DIRS = ['src', 'test'];

/**
 * Pre-rename tokens of the t127/t133 glossary plus the vocabulary that is
 * unique to the cost lens.
 *
 * `bare` matches the standalone lowercase word — `\btrabalho\b` fires on a
 * variable named `trabalho` but never on the wire field `trabalho_id`, because
 * `_` is a word character. `camel` matches the capitalized form when it starts a
 * word inside an identifier, which is what catches `buscarTrabalhos` or
 * `LinhaDeCusto` — and, thanks to the "not followed by a lowercase letter"
 * rule, never catches the English `Error` with `Erro`.
 *
 * Two words the glossary would suggest are deliberately absent. `no` (node) is
 * the English word for negation and the head of half the wire fields the lens
 * reads, so a gate that flagged it would flag every English sentence in the
 * package; `nodeId` is enforced by the reviewer, not by this list. `de` and
 * `para` as PREPOSITIONS are likewise unreachable — they are operation keys
 * (`alterar_campo_no`), and every occurrence of them here is either a key or a
 * literal.
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

  // Vocabulary of the cost lens itself.
  { bare: ['custo', 'custos'], camel: ['Custo', 'Custos'] },
  { bare: ['politica', 'politicas'], camel: ['Politica', 'Politicas'] },
  { bare: ['candidata', 'candidatas'], camel: ['Candidata', 'Candidatas'] },
  { bare: ['teto', 'tetos'], camel: ['Teto'] },
  { bare: ['evidencia', 'evidencias'], camel: ['Evidencia'] },
  { bare: ['metrica', 'metricas'], camel: ['Metrica', 'Metricas'] },
  { bare: ['mediana', 'limiar', 'fator'], camel: ['Mediana', 'Limiar', 'Fator'] },
  { bare: ['amostra', 'unidade', 'rotulo'], camel: ['Amostra', 'Unidade', 'Rotulo'] },
  { bare: ['marca', 'marcas', 'nos', 'vezes'], camel: ['Marca', 'Nos'] },
  { bare: ['recomendacao', 'operacao', 'operacoes'], camel: ['Recomendacao', 'Operacao'] },
  { bare: ['descricao', 'descricoes'], camel: ['Descricao'] },

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
  { bare: ['par', 'pares', 'grupo', 'grupos'], camel: ['Par', 'Grupo'] },
  { bare: ['raiz', 'pacote', 'modulo', 'arquivo'], camel: ['Raiz', 'Pacote', 'Modulo', 'Arquivo'] },
  { bare: ['ficha', 'fichas', 'secao', 'secoes'], camel: ['Ficha', 'Secao'] },
  { bare: ['mensagem', 'mensagens', 'credencial'], camel: ['Mensagem', 'Credencial'] },
  { bare: ['cabecalho', 'cabecalhos', 'ambiente'], camel: ['Cabecalho', 'Ambiente'] },
  { bare: ['comando', 'comandos', 'subcomando'], camel: ['Comando', 'Subcomando'] },
  { bare: ['argumento', 'argumentos', 'contexto'], camel: ['Argumento', 'Contexto'] },
  { bare: ['chamada', 'chamadas', 'espiao'], camel: ['Chamada', 'Chamadas', 'Espiao'] },
  { bare: ['prazo', 'tentativa', 'pedaco', 'pedacos'], camel: ['Prazo', 'Tentativa', 'Pedaco'] },
  { bare: ['filho', 'filhos', 'atual', 'restante'], camel: ['Filho', 'Atual', 'Restante'] },
  { bare: ['minimo', 'maximo'], camel: ['Minimo', 'Maximo'] },
  { bare: ['documento', 'registro', 'artefato'], camel: ['Documento', 'Registro', 'Artefato'] },
  { bare: ['anterior', 'proximo', 'alvo', 'codigo'], camel: ['Anterior', 'Proximo', 'Alvo', 'Codigo'] },
  { bare: ['impresso', 'permitidas', 'identificada'], camel: ['Impresso', 'Identificada'] },
  { bare: ['extracao', 'projecao', 'fronteira'], camel: ['Extracao', 'Projecao', 'Fronteira'] },

  // Verbs the glossary maps (`criar`→create, `buscar`→get, …), as identifiers.
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
      'abrir',
      'iniciar',
      'encerrar',
      'subir',
      'pedir',
      'conferir',
      'exigir',
      'anotar',
      'percorrer',
      'montar',
      'formatar',
      'responder',
      'enviar',
      'ler',
      'pegar',
      'normalizar',
      'interpretar',
      'avaliar',
      'agregar',
      'comparar',
      'extrair',
      'carregar',
      'semear',
      'esperar',
      'chamar',
      'escrever',
      'validar',
      'verificar',
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
   * Templates need their own reader because they NEST: `` `a ${x ? `b` : c}` ``
   * has a backtick inside its own interpolation, and a reader that just scans
   * for "the next backtick" would take that one for the closing delimiter, drop
   * back into code mode halfway through a string, and start reporting the text
   * inside it as identifiers. The interpolated expressions themselves are read
   * as code, which is what a template literal actually is.
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
    // Inside a comment only the quoted spans are masked: the English prose around
    // them still has to be scanned. Fenced blocks go first, because they contain
    // the backticks the second rule looks for — and a fence is the same quoting
    // as a backticked span, only multi-line. `src/cli.ts` documents the command
    // with one, and what is inside it is an invocation a person types, frozen by
    // D20 exactly like the flags quoted inline around it.
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
 * `{ execucao_id: id }`, `row.no_id`, `evidencia.tipo` and `opcoes?: []` are the
 * wire format the core owns; a bare `const trabalho = …` is not.
 */
function maskKeyAndMemberPositions(text: string, token: string): string {
  const boundary = '(?![A-Za-z0-9_])';
  return text
    // property access / optional chaining: `.trabalho`
    .replace(new RegExp(`\\.\\s*${token}${boundary}`, 'g'), (span) => blank(span))
    // object key, interface member, destructuring rename: `trabalho:` / `trabalho?:`
    .replace(new RegExp(`(^|[{,(\\s])${token}\\s*\\??\\s*:`, 'gm'), (span) => blank(span));
}

/** Every scanned file, as a path relative to `packages/topografo-custo`. */
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
          // standalone word: `const trabalho = …` (never the field `trabalho_id`)
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

/**
 * File names this ticket renames away.
 *
 * Asserted by name rather than by glossary because the sweep's own word list
 * would also flag a file the repo keeps on purpose — the same reason the screen's
 * port states it by hand.
 */
const RENAMED_AWAY = Object.freeze([
  'cliente.ts',
  'custo.ts',
  'politica.ts',
  'cliente.test.ts',
  'custo.test.ts',
  'politica.test.ts',
]);

test('t211 — no Portuguese identifier survives in packages/topografo-custo/{src,test}', () => {
  const files = scannedFiles();
  assert.ok(files.length >= 10, `the sweep found only ${files.length} files; it is not walking the tree`);

  const hits = files.flatMap((relative) =>
    hitsInSource(readFileSync(path.join(PACKAGE_ROOT, relative), 'utf8')).map(
      (hit) => `${relative}:${hit.line} — ${hit.token}`,
    ),
  );

  assert.deepEqual(hits, [], `Portuguese identifiers still present (D18):\n${hits.join('\n')}`);
});

test('t211 — no Portuguese file name survives under packages/topografo-custo/{src,test}', () => {
  const names = scannedFiles().map((relative) => path.basename(relative));
  const offenders = RENAMED_AWAY.filter((name) => names.includes(name));

  assert.deepEqual(offenders, [], `Portuguese file names (D18):\n${offenders.join('\n')}`);
});

test('t211 — the sweep bites on real Portuguese identifiers', () => {
  const caught = [
    'const trabalho = getJob(1);',
    'function agregarCusto(sessoes) { return sessoes; }',
    'export interface LinhaDeCusto { tokens_total: number }',
    'const { erro } = report;',
    'export const TIER_FATOR_PADRAO = 3;',
    'export const TIER_MINIMO_NOS_PADRAO = 3;',
    'import { avaliarPoliticas } from "./policy.ts";',
    'export class ErroDaApi extends Error {}',
    'const candidatas = ceilingCandidates(rows, options);',
    '// a versao corrente do grafo muda aqui',
  ];
  for (const source of caught) {
    assert.ok(hitsInSource(source).length > 0, `the sweep missed a Portuguese identifier: ${source}`);
  }
});

test('t211 — the sweep does NOT bite on the frozen exceptions', () => {
  const allowed = [
    // wire body keys, in key and member position
    'const row = { no_id: id, grafo_versao_id: version, trabalho_id: job };',
    'const body = { grafo_id: id, versao_alvo: target, operacoes: ops };',
    'if (candidate.evidencia.tipo === "teto" && candidate.evidencia.lente === "custo") return true;',
    'export interface CostRow { tokens_total: number; sessoes_com_uso: number }',
    'const spent = row.tempo_total_segundos + row.sessoes_sem_tempo;',
    'return { tipo: "alterar_campo_no", campo: "description", de: from, para: to };',
    'const { sessoes: sessions } = await get(baseUrl, path, doFetch);',
    // the free-JSON values the lens emits, which t213 owns and this ticket does not
    'const kind = over ? "teto" : "tier";',
    'const evidence = { lente: "custo", teto_excedido: exceeded };',
    // the CLI surface a person types, frozen by D20
    'const fromCeiling = extractValue(args, "--teto-tokens");',
    'if (subcommand !== "avaliar") return 2;',
    'const fromMinNodes = extractValue(rest, "--tier-minimo-nos");',
    'const match = /^--execucao=(.+)$/.exec(argument);',
    // English code that merely contains a forbidden token as a substring
    'export class ValidationError extends Error { readonly errors: string[]; }',
    'const parts = Partial<CostRow>;',
    'const half = total / 1000;',
    // a backticked frozen name inside English prose
    '/** The `evidencia` / `metrica_esperada` free JSON and the `--teto-tokens` flag stay as they are. */',
    // the multi-line form of the same quoting: a whole invocation, fenced
    '/**\n * ```\n * topografo-custo avaliar --url http://127.0.0.1:4317 --execucao 7 --teto-tokens 200000\n * ```\n */',
  ];
  for (const source of allowed) {
    assert.deepEqual(hitsInSource(source), [], `the sweep flagged a frozen exception: ${source}`);
  }
});
