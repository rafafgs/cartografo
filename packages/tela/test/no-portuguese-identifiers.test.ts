/**
 * D18 gate: no Portuguese code identifier left in `packages/tela` (t133, AC1).
 *
 * Port of `packages/core/test/no-portuguese-identifiers.test.ts`, which t127
 * left behind as the proven shape for this sweep: walk the package, mask out
 * everything the ticket deliberately leaves in Portuguese, and assert that no
 * pre-rename token of the glossary survives in an identifier position.
 *
 * What gets masked here, and why — these are the ticket's frozen exceptions,
 * not loopholes:
 *
 * - **String and template literals.** This is where the wire vocabulary the
 *   core owns lives, and every string that reaches the browser DOM. The screen
 *   renders its pages in Portuguese on purpose, and the `data-*` markers it
 *   writes into that HTML are a declared contract (`docs/spec/tela.md`).
 * - **Regular-expression literals.** The screen's own route paths are matched
 *   by regex, not by string compare, in the router — so a regex literal is
 *   masked exactly like the string literal next to it. This is the one place
 *   this port had to go beyond the core original, which has no such regex. The
 *   paths themselves went English with t230 (D20 §5.1) and no longer need the
 *   exemption; what still does is every other regex over a Portuguese wire
 *   name, and `no-portuguese-wire.test.ts` next door is what now holds the
 *   routes to their new spelling.
 * - **Key and member positions.** A field the screen mirrors from a core JSON
 *   response is still spelled in Portuguese in the code that reads it —
 *   `job.motivo_bloqueio`, `{ execucao_id: id }`, `erro:`. That is the data
 *   format, not code.
 * - **Backticked spans inside comments**, which is how this codebase quotes a
 *   frozen field, route or event name while writing English prose around it.
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
 * Pre-rename tokens of the t127 glossary plus the vocabulary that is unique to
 * the screen, the scripts and the root tests.
 *
 * `bare` matches the standalone lowercase word — `\btrabalho\b` fires on a
 * variable named `trabalho` but never on the wire field `trabalho_id`, because
 * `_` is a word character. `camel` matches the capitalized form when it starts a
 * word inside an identifier, which is what catches `listarTrabalhos` or
 * `ResumoDeExecucao` — and, thanks to the "not followed by a lowercase letter"
 * rule, never catches the English `Error` with `Erro`.
 */
const FORBIDDEN = Object.freeze([
  // Domain vocabulary (t127 glossary, reused verbatim).
  { bare: ['grafo', 'grafos'], camel: ['Grafo'] },
  { bare: ['trabalho', 'trabalhos'], camel: ['Trabalho', 'Trabalhos'] },
  { bare: ['pergunta', 'perguntas'], camel: ['Pergunta', 'Perguntas'] },
  { bare: ['sessao', 'sessoes'], camel: ['Sessao', 'Sessoes'] },
  { bare: ['execucao', 'execucoes'], camel: ['Execucao', 'Execucoes'] },
  { bare: ['proposta', 'propostas'], camel: ['Proposta', 'Propostas'] },
  { bare: ['evento', 'eventos'], camel: ['Evento', 'Eventos'] },
  { bare: ['versao', 'versoes'], camel: ['Versao'] },

  // Structural vocabulary (t127 glossary).
  { bare: ['apoio', 'rota', 'rotas'], camel: ['Rota'] },
  { bare: ['linha', 'linhas', 'coluna', 'colunas'], camel: ['Linha', 'Coluna', 'Colunas'] },
  { bare: ['padrao', 'prefixo', 'caminho', 'caminhos'], camel: ['Padrao', 'Prefixo', 'Caminho'] },
  { bare: ['erro', 'erros'], camel: ['Erro'] },
  { bare: ['resposta', 'respostas', 'requisicao', 'corpo'], camel: ['Resposta', 'Requisicao', 'Corpo'] },

  // Vocabulary of the screen itself.
  { bare: ['quadro'], camel: ['Quadro'] },
  { bare: ['pagina', 'paginas'], camel: ['Pagina', 'Paginas'] },
  { bare: ['segmento', 'segmentos'], camel: ['Segmento', 'Segmentos'] },
  { bare: ['saude'], camel: ['Saude'] },
  { bare: ['cliente', 'servidor'], camel: ['Cliente', 'Servidor'] },
  { bare: ['arquivo', 'arquivos'], camel: ['Arquivo'] },
  { bare: ['campo', 'campos'], camel: ['Campo', 'Campos'] },
  { bare: ['formulario'], camel: ['Formulario'] },
  { bare: ['opcao', 'opcoes'], camel: ['Opcao', 'Opcoes'] },
  { bare: ['titulo', 'rotulo', 'detalhe'], camel: ['Titulo', 'Rotulo', 'Detalhe'] },
  { bare: ['duracao', 'instante'], camel: ['Duracao', 'Instante'] },
  { bare: ['ocupacao', 'ocupacoes'], camel: ['Ocupacao'] },
  { bare: ['marco', 'marcos', 'marca', 'marcas'], camel: ['Marco', 'Marca'] },
  { bare: ['corte', 'cortes'], camel: ['Corte'] },
  { bare: ['totais', 'balde', 'baldes', 'fila'], camel: ['Totais', 'Balde', 'Fila'] },
  { bare: ['bloco', 'blocos', 'trecho'], camel: ['Bloco', 'Trecho'] },
  { bare: ['valor', 'valores', 'texto'], camel: ['Valor', 'Texto'] },
  { bare: ['saida', 'saidas', 'entrada', 'entradas'], camel: ['Saida', 'Entrada'] },
  { bare: ['motivo', 'grupo', 'grupos', 'estado'], camel: ['Motivo', 'Grupo', 'Estado'] },
  { bare: ['uso', 'tipo', 'tipos', 'estilo'], camel: ['Uso', 'Tipo', 'Estilo'] },
  { bare: ['cartao', 'tabela', 'resumo'], camel: ['Cartao', 'Tabela', 'Resumo'] },
  { bare: ['fonte', 'fontes', 'ordem', 'categoria'], camel: ['Fonte', 'Fontes', 'Ordem', 'Categoria'] },
  { bare: ['indice', 'numero', 'tamanho'], camel: ['Indice', 'Numero', 'Tamanho'] },
  { bare: ['pedaco', 'pedacos', 'bruto'], camel: ['Pedaco', 'Bruto'] },
  { bare: ['resultado', 'metodo', 'consulta'], camel: ['Resultado', 'Metodo', 'Consulta'] },
  { bare: ['filtro', 'parametros', 'porta'], camel: ['Filtro', 'Parametros', 'Porta'] },
  { bare: ['sinal', 'causa', 'prazo', 'tentativa'], camel: ['Sinal', 'Causa', 'Prazo', 'Tentativa'] },
  { bare: ['artefato', 'artefatos', 'raiz'], camel: ['Artefato', 'Raiz'] },
  { bare: ['gancho', 'submissao', 'destino'], camel: ['Gancho', 'Submissao', 'Destino'] },
  { bare: ['casamento', 'filho', 'pacote'], camel: ['Casamento', 'Filho', 'Pacote'] },
  { bare: ['limite', 'estrutura', 'concluido'], camel: ['Limite', 'Estrutura'] },
  { bare: ['ultimo', 'respondido', 'principal'], camel: ['Ultimo'] },

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
      'escapar',
      'formatar',
      'montar',
      'rotear',
      'responder',
      'enviar',
      'ler',
      // `resolver` is deliberately absent, as it is from t127's own glossary:
      // it is a Portuguese verb AND an English noun, and English prose about
      // "the resolver" is not a rename this gate gets to demand.
      'consultar',
      'cortar',
      'carregar',
      'validar',
      'verificar',
      'esperar',
      'redirecionar',
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
   * back into code mode halfway through a string, and start reporting the HTML
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
    // Inside a comment only the backticked spans are masked: the English prose
    // around them still has to be scanned.
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
 * `{ execucao_id: id }`, `job.motivo_bloqueio`, `erro: 'x'` and `opcoes?: []`
 * are the wire format the core owns; a bare `const trabalho = …` is not.
 */
function maskKeyAndMemberPositions(text: string, token: string): string {
  const boundary = '(?![A-Za-z0-9_])';
  return text
    // property access / optional chaining: `.trabalho`
    .replace(new RegExp(`\\.\\s*${token}${boundary}`, 'g'), (span) => blank(span))
    // object key, interface member, destructuring rename: `trabalho:` / `trabalho?:`
    .replace(new RegExp(`(^|[{,(\\s])${token}\\s*\\??\\s*:`, 'gm'), (span) => blank(span));
}

/** Every scanned file, as a path relative to `packages/tela`. */
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
          // SCREAMING_SNAKE segment: `PORTA_PADRAO`
          new RegExp(`\\b${screaming}(_|\\b)`).test(line) ||
          // camelCase prefix: `listarTrabalhos`, `paginaQuadro`
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
 * File and directory names this ticket renames away.
 *
 * Asserted by name rather than by glossary because the sweep's own word list
 * would also flag `scripts/validar-grafo.mjs`, which stays exactly where it is
 * (see `no-portuguese-identifiers.test.mjs` in `scripts/`).
 */
const RENAMED_AWAY = Object.freeze([
  'cliente.ts',
  'servidor.ts',
  'paginas.ts',
  'linha-do-tempo.ts',
  'apoio.ts',
  'execucoes.test.ts',
  'linha-do-tempo.test.ts',
  'quadro.test.ts',
  'perguntas.test.ts',
]);

test('AC1 — no Portuguese identifier survives in packages/tela/{src,test,bin}', () => {
  const files = scannedFiles();
  assert.ok(files.length > 15, `the sweep found only ${files.length} files; it is not walking the tree`);

  const hits = files.flatMap((relative) =>
    hitsInSource(readFileSync(path.join(PACKAGE_ROOT, relative), 'utf8')).map(
      (hit) => `${relative}:${hit.line} — ${hit.token}`,
    ),
  );

  assert.deepEqual(hits, [], `Portuguese identifiers still present (D18):\n${hits.join('\n')}`);
});

test('AC1 — no file name under packages/tela/{src,test,bin} is in Portuguese', () => {
  const names = scannedFiles().map((relative) => path.basename(relative));
  const offenders = RENAMED_AWAY.filter((name) => names.includes(name));

  assert.deepEqual(offenders, [], `Portuguese file names (D18):\n${offenders.join('\n')}`);
});

test('AC1 — the sweep bites on real Portuguese identifiers', () => {
  const caught = [
    'const trabalho = getJob(1);',
    'function paginaQuadro(cliente) { return cliente; }',
    'export interface ResumoDeExecucao { id: number }',
    'const { erro } = report;',
    'export const PORTA_PADRAO = 4318;',
    'import { montarLinhaDoTempo } from "./timeline.ts";',
    'export class ErroDaApi extends Error {}',
    '// a versao corrente do grafo muda aqui',
  ];
  for (const source of caught) {
    assert.ok(hitsInSource(source).length > 0, `the sweep missed a Portuguese identifier: ${source}`);
  }
});

test('AC1 — the sweep does NOT bite on the frozen exceptions', () => {
  const allowed = [
    // wire fields the core owns, in key and member position
    'const row = { execucao_id: 1, trabalho_id: 2, criado_em: now, atualizado_em: now };',
    'const blocked = summary.trabalhos_bloqueados + summary.perguntas_pendentes;',
    'return { no_entrada_id: entry, no_atual: current, motivo_bloqueio: null };',
    "reply.code(502); return { erro: 'control_plane_indisponivel', mensagem: text };",
    'export interface Job { grafo_versao_id: string | null; bloqueado: boolean }',
    // A route path as a string and as a regex. The spellings below are the
    // pre-t230 ones on purpose: no file writes them any more, and a made-up
    // path in English would demonstrate nothing about masking a Portuguese one.
    "if (pathname === '/quadro') return board(client);",
    "if (pathname === '/execucoes' || pathname === '/perguntas') return list(client);",
    'const match = /^\\/execucoes\\/([^/]+)$/.exec(pathname);',
    'const answer = /^\\/perguntas\\/([^/]+)\\/resposta$/.exec(pathname);',
    // `data-*` markers, a declared DOM contract, and the Portuguese UI content
    'return `<section class="grupo" data-no-atual="${escape(node)}">`;',
    'return `<tr data-sessao="${row.id}" data-trabalho="${row.id}"></tr>`;',
    // a template nested inside another template's interpolation: the masking
    // has to survive it, or everything after the inner backtick reads as code
    'const cell = `<td data-campo="opcao">${o === "" ? `sem opcao` : escape(o)}</td>`;',
    "const empty = 'Nenhum trabalho por aqui ainda.';",
    "const buckets = { fila: 0, agente_trabalhando: 0, esperando_humano: 0 };",
    // English code that merely contains a forbidden token as a substring
    'export class ValidationError extends Error { readonly errors: string[]; }',
    'const half = total / 1000;',
    // a backticked frozen name inside English prose
    '/** The `erro` / `mensagem` envelope the core still answers with stays as it is. */',
  ];
  for (const source of allowed) {
    assert.deepEqual(hitsInSource(source), [], `the sweep flagged a frozen exception: ${source}`);
  }
});
