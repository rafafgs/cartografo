/**
 * D18 gate: no Portuguese code identifier is left in `packages/runner` (t132).
 *
 * Same sweep `packages/core/test/no-portuguese-identifiers.test.ts` runs since
 * t127, pointed at this package and extended with the vocabulary this package
 * carries. It walks `src/`, `test/` and `scripts/` WHOLE — since t304 there is
 * no excluded file left — masks out everything the ticket deliberately leaves
 * in Portuguese, and then asserts that none of the pre-rename tokens survives
 * in an identifier position.
 *
 * What gets masked, and why — these are the FR2 exceptions, not loopholes:
 *
 * - **String and template literals.** This is where the wire values and the two
 *   prompt constants live. None of it is code, so none of it translates (FR2,
 *   FR3). Much of what used to sit here has since gone English on its own
 *   surface — the event types with t227, the operation vocabulary with t228 —
 *   and the mask stays anyway: it is about the POSITION, not about which words
 *   happen to be in it today, which is why the fixtures below still prove it
 *   with Portuguese literals.
 * - **Key and member positions.** A wire field is still spelled in Portuguese
 *   in the code that builds or reads it — `{ trabalho_id: id }`, `evento.dados`,
 *   `evidencia.por_no`, `metricas.gargalo`. That is the data format, not code.
 * - **Backticked spans inside comments**, which is how this codebase quotes a
 *   table, column, route or event name while writing English prose around it.
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
const SCANNED_DIRS = ['src', 'test', 'scripts'];

/**
 * Pre-rename tokens of `packages/core`'s glossary plus this package's own.
 *
 * `bare` matches the standalone lowercase word — `\btrabalho\b` fires on a
 * variable named `trabalho` but never on the column `trabalho_id`, because `_`
 * is a word character. `camel` matches the capitalized form when it starts a
 * word inside an identifier, which is what catches `buscarTrabalho`,
 * `LinhaTrabalho` or `EntradaCriarTrabalho` — and, thanks to the "not followed
 * by a lowercase letter" rule, never catches the English `Error` with `Erro`.
 *
 * Words that are also English (`no`, `total`, `real`, `final`, `data`, `base`,
 * `status`) are deliberately absent: a sweep that cries wolf on English prose
 * stops being read.
 */
const FORBIDDEN = Object.freeze([
  /* ---- the glossary packages/core froze in t127 --------------------------- */

  // Domain vocabulary.
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

  // Structural vocabulary.
  { bare: ['dominio', 'repositorios', 'comum', 'apoio', 'rota', 'rotas'], camel: [] },
  { bare: ['linha', 'linhas', 'coluna', 'colunas'], camel: ['Linha', 'Coluna'] },
  { bare: ['carimbo', 'padrao', 'prefixo', 'caminho'], camel: ['Padrao', 'Prefixo', 'Caminho'] },
  { bare: ['erro', 'erros'], camel: ['Erro'] },
  { bare: ['resposta', 'respostas', 'requisicao', 'corpo'], camel: ['Resposta', 'Requisicao'] },
  { bare: ['validacao', 'transicao', 'transicoes'], camel: ['Validacao', 'Transicao'] },
  { bare: ['bloqueio', 'bloqueios', 'desbloqueio', 'desbloqueios'], camel: ['Bloqueio'] },
  { bare: ['emenda', 'emendas'], camel: ['Emenda'] },
  { bare: ['migracoes', 'migracao'], camel: ['Migracoes', 'Migracao'] },

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

  /* ---- what packages/runner adds on top ----------------------------------- */

  // The runner's own nouns: controller, dispatch, lease loop.
  { bare: ['despacho', 'despachos', 'despachar', 'despachados', 'despachou'], camel: ['Despacho'] },
  { bare: ['teto', 'tetos', 'projeto', 'projetos', 'cliente', 'clientes'], camel: ['Teto', 'Projeto', 'Cliente'] },
  { bare: ['opcoes', 'opcao'], camel: ['Opcoes', 'Opcao'] },
  { bare: ['candidato', 'candidatos', 'intervalo', 'segundos', 'minutos'], camel: ['Intervalo'] },
  { bare: ['chamada', 'chamadas', 'metodo', 'liberacao', 'liberacoes', 'batidas'], camel: ['Chamada', 'Metodo'] },
  { bare: ['herdada', 'todas', 'todos', 'contexto', 'teste', 'testes'], camel: ['Contexto', 'Teste'] },

  // Engine adapter and conformance kit.
  { bare: ['comando', 'comandos', 'processo', 'processos', 'filho', 'neto'], camel: ['Comando', 'Processo', 'Filho'] },
  { bare: ['instrucoes', 'instrucao', 'taxonomia', 'quadro', 'quadros'], camel: ['Instrucoes', 'Taxonomia', 'Quadro'] },
  { bare: ['sonda', 'sondar', 'prazo', 'prazos', 'graca', 'assentamento'], camel: ['Sonda', 'Prazo'] },
  { bare: ['credencial', 'credenciais', 'variavel', 'variaveis', 'conta'], camel: ['Credencial', 'Variavel'] },
  { bare: ['relogio', 'escalada', 'rede', 'resto', 'restos', 'pedaco', 'pedacos'], camel: ['Relogio', 'Pedaco'] },
  { bare: ['sinal', 'sinais', 'grupo', 'codigo', 'codigos', 'causa'], camel: ['Sinal', 'Codigo'] },
  { bare: ['falha', 'falhas', 'falho', 'finais', 'fim', 'inicio', 'subiu'], camel: ['Falha'] },
  { bare: ['cenario', 'cenarios', 'coletor', 'registro', 'registros'], camel: ['Cenario', 'Coletor', 'Registro'] },
  { bare: ['marcador', 'sequencia', 'ambiente', 'rotulo', 'limite', 'vivo', 'morto'], camel: ['Marcador', 'Ambiente', 'Rotulo'] },
  { bare: ['modo', 'permissao', 'posicao', 'formato', 'argumento', 'argumentos'], camel: ['Modo', 'Permissao', 'Formato'] },
  { bare: ['binario', 'inexistente', 'proprio', 'declarado', 'declaradas'], camel: ['Binario'] },
  { bare: ['esperado', 'esperada', 'esperados', 'esperadas', 'recebido', 'recebidas'], camel: ['Esperado', 'Esperada'] },
  { bare: ['encontrado', 'encontrados', 'analisado', 'pedido', 'pedidos', 'enviada'], camel: ['Pedido', 'Enviada'] },
  { bare: ['desfecho', 'desfechos', 'finalizada', 'finalizadas', 'aberta'], camel: ['Desfecho'] },

  // The surveyor: flow lens and proposal.
  { bare: ['topografo', 'topografos'], camel: ['Topografo'] },
  { bare: ['fluxo', 'fluxos', 'metrica', 'metricas'], camel: ['Fluxo', 'Metrica', 'Metricas'] },
  { bare: ['evidencia', 'evidencias', 'gargalo'], camel: ['Evidencia', 'Gargalo'] },
  { bare: ['acumulador', 'acumuladores', 'pendencia', 'instante'], camel: ['Acumulador', 'Pendencia'] },
  { bare: ['entidade', 'entidades', 'origem', 'fonte', 'direcao'], camel: ['Entidade'] },
  { bare: ['fila', 'espera', 'bloqueado', 'desbloqueado'], camel: ['Fila'] },
  { bare: ['inversa', 'alvo', 'aresta', 'arestas', 'nos'], camel: ['Inversa', 'Aresta'] },
  { bare: ['papel', 'descricao', 'chave', 'chaves', 'campo', 'campos'], camel: ['Campo'] },
  { bare: ['ponta', 'pontas', 'componente', 'componentes', 'dominante', 'maior', 'atual'], camel: ['Componente', 'Atual'] },
  { bare: ['melhoria', 'reducao', 'indice', 'resultado', 'resultados'], camel: ['Resultado'] },
  { bare: ['problema', 'problemas', 'detalhe', 'detalhes', 'mensagem', 'mensagens'], camel: ['Problema', 'Detalhe', 'Mensagem'] },

  // Generic nouns this package still spells in Portuguese.
  { bare: ['arquivo', 'arquivos', 'saida', 'entrada', 'entradas'], camel: ['Arquivo', 'Saida', 'Entrada'] },
  { bare: ['conteudo', 'documento', 'bruto', 'valido', 'frase', 'produzido'], camel: ['Conteudo', 'Documento'] },
  { bare: ['nome', 'nomes', 'tipo', 'tipos', 'dados', 'valor', 'valores'], camel: ['Nome', 'Tipo', 'Valor'] },
  { bare: ['texto', 'textos', 'parte', 'partes', 'trecho', 'bloco', 'blocos'], camel: ['Texto', 'Parte', 'Bloco'] },
  { bare: ['primeiro', 'segundo', 'ultimo', 'ultima', 'novo', 'nova', 'antigo'], camel: ['Primeiro', 'Ultimo'] },
  { bare: ['raiz', 'pacote', 'portao', 'manifesto', 'tentativa', 'duracao'], camel: ['Raiz', 'Pacote', 'Portao'] },
  { bare: ['tamanho', 'maximo', 'minimo', 'especie', 'especies', 'secao'], camel: ['Tamanho', 'Especie', 'Secao'] },

  // Verbs this package adds to the glossary's list.
  {
    bare: [
      'somar',
      'montar',
      'calcular',
      'propor',
      'escolher',
      'validar',
      'resolver',
      'extrair',
      'emitir',
      'bombear',
      'concluir',
      'desarmar',
      'sinalizar',
      'parar',
      'armar',
      'avisar',
      'aguardar',
      'esperar',
      'limpar',
      'morrer',
      'carregar',
      'responder',
      'rodar',
      'analisar',
      'escrever',
      'ceder',
      'ler',
      'pausa',
      'parece',
      'principal',
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
 * `{ trabalho_id: id }`, `evento.dados`, `metricas.gargalo` and `versoes?: Row[]`
 * are the wire format FR2 freezes; a bare `const evento = …` is not.
 */
function maskKeyAndMemberPositions(text: string, token: string): string {
  const boundary = '(?![A-Za-z0-9_])';
  return text
    // property access / optional chaining: `.gargalo`
    .replace(new RegExp(`\\.\\s*${token}${boundary}`, 'g'), (span) => blank(span))
    // object key, interface member, destructuring rename: `gargalo:` / `gargalo?:`
    .replace(new RegExp(`(^|[{,(\\s])${token}\\s*\\??\\s*:`, 'gm'), (span) => blank(span));
}

/** Every scanned file, as a path relative to `packages/runner`. */
function scannedFiles(): string[] {
  const found: string[] = [];
  const walk = (absolute: string): void => {
    for (const entry of readdirSync(absolute)) {
      const child = path.join(absolute, entry);
      if (statSync(child).isDirectory()) {
        walk(child);
        continue;
      }
      if (!/\.(ts|mjs|js)$/.test(entry)) continue;
      found.push(path.relative(PACKAGE_ROOT, child));
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

test('AC1 — no Portuguese identifier survives in packages/runner/{src,test,scripts}', () => {
  const files = scannedFiles();
  assert.ok(files.length > 20, `the sweep found only ${files.length} files; it is not walking the tree`);

  const hits = files.flatMap((relative) =>
    hitsInSource(readFileSync(path.join(PACKAGE_ROOT, relative), 'utf8')).map(
      (hit) => `${relative}:${hit.line} — ${hit.token}`,
    ),
  );

  assert.deepEqual(hits, [], `Portuguese identifiers still present (D18):\n${hits.join('\n')}`);
});

test('AC1 — no file or directory name under packages/runner/{src,test,scripts} is in Portuguese', () => {
  const offenders = scannedFiles().filter((relative) =>
    FORBIDDEN.some((group) =>
      group.bare.some((word) => new RegExp(`(^|[/\\-_.])${word}([/\\-_.]|$)`, 'i').test(relative)),
    ),
  );

  assert.deepEqual(offenders, [], `Portuguese file/directory names (D18):\n${offenders.join('\n')}`);
});

test('AC1 — the sweep bites on real Portuguese identifiers and spares the FR1/FR2 exceptions', () => {
  const caught = [
    'const trabalho = getJob(db, 1);',
    'function calcularMetricasDeFluxo(eventos) { return eventos; }',
    'export interface OpcoesDoTopografo { cliente: unknown }',
    'const { gargalo } = report;',
    'export const ARQUIVO_DE_SAIDA = "x.json";',
    'import { proporMelhoriaDeFluxo } from "./proposta.ts";',
    '// a versao corrente do grafo muda aqui',
  ];
  for (const source of caught) {
    assert.ok(hitsInSource(source).length > 0, `the sweep missed a Portuguese identifier: ${source}`);
  }

  const allowed = [
    // column-mirrored snake_case fields and evidence payload keys
    'const row = { trabalho_id: 1, no_id: "revisar", tempo_espera_ms: 0, total_ms: 0 };',
    // wire keys in key and member position
    'return { por_no: ranking, gargalo: worst };',
    'const worst = metrics.gargalo;',
    'const nodes = version.snapshot.nos ?? [];',
    // event-type strings, taxonomy values and the operation vocabulary
    "if (event.tipo !== 'pergunta.criada') continue;",
    "export const TAXONOMY_STATUS = { completed: 'concluida', failed: 'falhou' };",
    "const OPERATION_TYPES = ['adicionar_no', 'alterar_campo_no'];",
    // the prompt constants keep their Portuguese content (FR3)
    "const DEFAULT_INSTRUCTIONS = ['Você é uma sessão de trabalho do cartografo.'].join('\\n');",
    // the excluded client, called by its current spelling (FR1)
    "import { ErroDoControlPlane } from '../controller/cliente-controle.ts';",
    'const jobs = await this.#options.client.listarTrabalhosLiberados();',
    'async #dispatch(lease: Lease, jobId: number): Promise<void> {}',
    'const proposal: Proposta = await client.criarProposta(entry);',
    // English code that merely contains a forbidden token as a substring
    'export class ValidationError extends Error { readonly errors: string[]; }',
    'const finished = TERMINAL_STATUSES.includes(status);',
    // a backticked frozen name inside English prose
    '/** The `evento` table and the `trabalho.criado` type stay Portuguese. */',
  ];
  for (const source of allowed) {
    assert.deepEqual(hitsInSource(source), [], `the sweep flagged an FR1/FR2 exception: ${source}`);
  }
});
