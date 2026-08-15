/**
 * Teste de aceite fim a fim do comando `avaliar` (t114, AT9).
 *
 * Sobe o control plane de verdade como processo filho — mesmo padrão de
 * `packages/runner/test/controller/dispatch-e-lease.e2e.test.ts` — semeia uma
 * execução com telemetria real e roda o comando contra ela. Nada é simulado:
 * grafo, trabalho, sessões e proposta atravessam a API pública por HTTP.
 *
 * É este arquivo que prova o critério central da ficha: um segundo topógrafo
 * cabe na API que já existe, **sem abrir `packages/core`**. Por isso a asserção
 * final não é sobre a proposta, e sim sobre o conjunto de rotas tocadas: quatro,
 * todas de leitura menos uma, e nenhuma delas `/aplicar` — aplicar continua
 * sendo decisão humana no portão (README, princípio 5).
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import test from 'node:test';
import { setTimeout as esperar } from 'node:timers/promises';

import type * as ModuloCli from '../src/cli.ts';

const RAIZ_PACOTE = path.resolve(import.meta.dirname, '..');
const RAIZ_REPO = path.resolve(RAIZ_PACOTE, '..', '..');
const CAMINHO_BIN = path.join(RAIZ_REPO, 'packages', 'core', 'bin', 'cartografo.mjs');
const CAMINHO_GRAFO = path.join(RAIZ_REPO, 'schema', 'exemplos', 'grafo-valido-minimo.json');

/** Agrupador da rodada semeada. Opaco por design (t102). */
const EXECUCAO_ID = 7;
/** Teto de tokens do cenário: "redigir" passa, "revisar" não chega perto. */
const TETO_TOKENS = 1000;
/** Prazo da partida do control plane. Folga larga, de propósito. */
const PRAZO_MS = 30_000;

type FilhoDoComando = ChildProcessByStdio<null, Readable, Readable>;

interface ContextoDeTeste {
  after: (fn: () => void | Promise<void>) => void;
}

let cache: typeof ModuloCli | null = null;

async function carregarCli(): Promise<typeof ModuloCli> {
  assert.ok(
    existsSync(path.join(RAIZ_PACOTE, 'src', 'cli.ts')),
    'artefato ainda não existe: packages/topografo-custo/src/cli.ts',
  );
  cache ??= (await import(new URL('../src/cli.ts', import.meta.url).href)) as typeof ModuloCli;
  return cache;
}

/** Sobe o control plane de verdade e devolve a URL que ele anunciou. */
async function subirControlPlane(t: ContextoDeTeste): Promise<string> {
  assert.ok(existsSync(CAMINHO_BIN), `artefato ainda não existe: ${CAMINHO_BIN}`);

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t114-e2e-'));
  const filho: FilhoDoComando = spawn(process.execPath, [CAMINHO_BIN], {
    cwd: base,
    env: {
      ...process.env,
      CARTOGRAFO_DB_PATH: path.join(base, 'cartografo.db'),
      CARTOGRAFO_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let saida = '';
  let erros = '';
  filho.stdout.setEncoding('utf8');
  filho.stderr.setEncoding('utf8');
  filho.stdout.on('data', (pedaco: string) => {
    saida += pedaco;
  });
  filho.stderr.on('data', (pedaco: string) => {
    erros += pedaco;
  });

  t.after(async () => {
    if (filho.exitCode === null && filho.signalCode === null) {
      filho.kill('SIGTERM');
      for (let tentativa = 0; tentativa < 50; tentativa += 1) {
        if (filho.exitCode !== null || filho.signalCode !== null) break;
        await esperar(100);
      }
      if (filho.exitCode === null && filho.signalCode === null) filho.kill('SIGKILL');
    }
    rmSync(base, { recursive: true, force: true });
  });

  const prazo = Date.now() + PRAZO_MS;
  while (Date.now() < prazo) {
    if (filho.exitCode !== null) {
      throw new Error(
        `o control plane morreu antes de ficar pronto (código ${filho.exitCode})\nstdout:\n${saida}\nstderr:\n${erros}`,
      );
    }
    const linha = saida
      .split('\n')
      .map((texto) => texto.trim())
      .find((texto) => texto.startsWith('{') && texto.includes('cartografo.ready'));
    if (linha !== undefined) {
      // Desde a t124 a API não responde sem credencial. O control plane imprime
      // a que acabou de emitir; este teste a apresenta daqui para a frente, tanto
      // na semeadura quanto no comando — que é como uma pessoa o rodaria.
      const pronto = JSON.parse(linha) as { url: string; bootstrapToken: string | null };
      const anterior = globalThis.fetch;
      globalThis.fetch = async (entrada: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const alvo =
          typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
        if (!alvo.startsWith(pronto.url)) return await anterior(entrada, init);
        const cabecalhos = new Headers(init?.headers);
        if (!cabecalhos.has('authorization')) {
          cabecalhos.set('authorization', `Bearer ${pronto.bootstrapToken ?? ''}`);
        }
        return await anterior(entrada, { ...init, headers: cabecalhos });
      };
      t.after(() => {
        globalThis.fetch = anterior;
      });
      return pronto.url;
    }
    await esperar(50);
  }

  throw new Error(`o control plane não ficou pronto em ${PRAZO_MS}ms\nstdout:\n${saida}`);
}

/** POST/PATCH cru contra o control plane, com a resposta já parseada. */
async function chamar(
  urlBase: string,
  caminho: string,
  metodo: 'POST' | 'PATCH',
  corpo: unknown,
): Promise<Record<string, unknown>> {
  const resposta = await fetch(`${urlBase}${caminho}`, {
    method: metodo,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  });
  const texto = await resposta.text();
  assert.ok(
    resposta.ok,
    `${metodo} ${caminho} respondeu ${resposta.status}: ${texto}`,
  );
  return JSON.parse(texto) as Record<string, unknown>;
}

/** Abre e finaliza uma sessão de um nó, com os totais de tokens declarados. */
async function semearSessao(
  urlBase: string,
  trabalhoId: number,
  noId: string,
  tokens: number,
): Promise<void> {
  // A rota devolve a projeção da sessão crua no corpo, sem envelope (t102).
  const sessao = (await chamar(urlBase, '/v1/sessions', 'POST', {
    trabalho_id: trabalhoId,
    no_id: noId,
    engine: 'claude-code',
    working_dir: '/tmp/t114',
    prompt: `trabalhar o nó ${noId}`,
  })) as { id: number };

  await chamar(urlBase, `/v1/sessions/${sessao.id}/finish`, 'PATCH', {
    status: 'concluida',
    exit_code: 0,
    uso: {
      input_tokens: tokens,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  });
}

interface ChamadaEspiada {
  caminho: string;
  metodo: string;
  corpo: unknown;
  resposta: unknown;
}

test('AT9 — avaliar cria exatamente uma proposta pendente da lente de custo', async (t) => {
  const { executarCli } = await carregarCli();
  const urlBase = await subirControlPlane(t);

  // --- semeadura: grafo como dado, um trabalho e duas sessões de nós distintos
  const documento = JSON.parse(readFileSync(CAMINHO_GRAFO, 'utf8')) as Record<string, unknown>;
  const registro = (await chamar(urlBase, '/v1/graphs', 'POST', documento)) as {
    grafo_versao: { id: string };
  };
  const versaoId = registro.grafo_versao.id;

  const trabalho = (await chamar(urlBase, '/v1/jobs', 'POST', {
    titulo: 'nota sobre custo',
    no_entrada_id: 'redigir',
    execucao_id: EXECUCAO_ID,
    grafo_versao_id: versaoId,
  })) as { id: number };

  await semearSessao(urlBase, trabalho.id, 'redigir', 5000);
  await semearSessao(urlBase, trabalho.id, 'revisar', 100);

  // --- o comando, com a rede espiada mas real
  const chamadas: ChamadaEspiada[] = [];
  const buscar: typeof fetch = async (entrada, init) => {
    const url = String(entrada);
    const resposta = await fetch(entrada, init);
    const eco = resposta.clone();
    const texto = await eco.text();
    chamadas.push({
      caminho: new URL(url).pathname,
      metodo: init?.method ?? 'GET',
      corpo: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      resposta: texto === '' ? undefined : JSON.parse(texto),
    });
    return resposta;
  };

  const impresso: string[] = [];
  const codigo = await executarCli(
    [
      'avaliar',
      '--url',
      urlBase,
      '--execucao',
      String(EXECUCAO_ID),
      '--teto-tokens',
      String(TETO_TOKENS),
    ],
    { buscar, escrever: (texto) => impresso.push(texto) },
  );

  assert.equal(codigo, 0, `o comando saiu ${codigo}:\n${impresso.join('')}`);

  const criacoes = chamadas.filter(
    (chamada) => chamada.caminho === '/v1/proposals' && chamada.metodo === 'POST',
  );
  assert.equal(criacoes.length, 1, 'só "redigir" passa do teto; "revisar" não gera nada');

  const { proposta } = criacoes[0].resposta as {
    proposta: { id: number; status: string; evidencia: Record<string, unknown> };
  };
  assert.equal(proposta.status, 'pendente');
  assert.equal(proposta.evidencia.lente, 'custo');
  assert.equal(proposta.evidencia.tipo, 'teto');
  assert.equal(proposta.evidencia.no_id, 'redigir');
  assert.equal(proposta.evidencia.grafo_versao_id, versaoId);
  assert.equal(proposta.evidencia.tokens_total, 5000);
  assert.equal(proposta.evidencia.teto_excedido, 'tokens');

  const linhas = impresso.join('').trimEnd().split('\n').filter((linha) => linha !== '');
  assert.equal(linhas.length, 1, 'uma linha por proposta criada');
  assert.match(linhas[0], new RegExp(`\\b${proposta.id}\\b`));
  assert.match(linhas[0], /redigir/);
  assert.match(linhas[0], /teto/);
});

test('AT9 — avaliar toca só as quatro rotas do contrato, e nunca /aplicar', async (t) => {
  const { executarCli } = await carregarCli();
  const urlBase = await subirControlPlane(t);

  const documento = JSON.parse(readFileSync(CAMINHO_GRAFO, 'utf8')) as Record<string, unknown>;
  const registro = (await chamar(urlBase, '/v1/graphs', 'POST', documento)) as {
    grafo_versao: { id: string };
  };
  const trabalho = (await chamar(urlBase, '/v1/jobs', 'POST', {
    titulo: 'nota sobre custo',
    no_entrada_id: 'redigir',
    execucao_id: EXECUCAO_ID,
    grafo_versao_id: registro.grafo_versao.id,
  })) as { id: number };
  await semearSessao(urlBase, trabalho.id, 'redigir', 5000);

  const caminhos: string[] = [];
  const buscar: typeof fetch = async (entrada, init) => {
    caminhos.push(`${init?.method ?? 'GET'} ${new URL(String(entrada)).pathname}`);
    return await fetch(entrada, init);
  };

  await executarCli(
    ['avaliar', '--url', urlBase, '--execucao', String(EXECUCAO_ID), '--teto-tokens', '1000'],
    { buscar, escrever: () => undefined },
  );

  const permitidas = [
    /^GET \/v1\/sessions$/,
    /^GET \/v1\/jobs$/,
    /^GET \/v1\/graph-versions\/[^/]+$/,
    /^POST \/v1\/proposals$/,
  ];
  for (const chamada of caminhos) {
    assert.ok(
      permitidas.some((padrao) => padrao.test(chamada)),
      `rota fora do contrato desta lente: ${chamada}`,
    );
  }
  assert.ok(
    caminhos.every((chamada) => !chamada.includes('/aplicar')),
    'aplicar proposta é decisão humana no portão, nunca do topógrafo',
  );
});

/* -------------------------------------------------------------------------- */
/* t180 — a saída do comando é inglês; o subcomando e as opções continuam      */
/* como estão, porque é o que uma pessoa digita.                               */
/* -------------------------------------------------------------------------- */

test('t180 — --help imprime o uso em inglês, ainda nomeando avaliar e as opções', async () => {
  const { executarCli, USO } = await carregarCli();

  const impresso: string[] = [];
  const codigo = await executarCli(['--help'], { escrever: (texto) => impresso.push(texto) });

  assert.equal(codigo, 0);
  assert.equal(impresso.join(''), `${USO}\n`);
  assert.match(USO, /^usage: topografo-custo avaliar --url <url> --execucao <id> \[options\]$/m);
  assert.match(USO, /^subcommands:$/m);
  assert.match(USO, /^options:$/m);
  assert.match(USO, /control plane to query \(required\)/);
  assert.match(USO, /With no ceiling declared, the ceiling policy does not run/);
  // O que a pessoa digita não muda (D18 deixa a superfície publicada de fora).
  assert.match(USO, new RegExp('--teto-tokens <n>'));
  assert.match(USO, new RegExp('--tier-minimo-nos <n>'));
});

test('t180 — os erros de uso de avaliar são inglês', async () => {
  const { executarCli } = await carregarCli();

  assert.equal(
    await stderrDe(() => executarCli(['avaliar', '--execucao', '7'], { escrever: () => undefined })),
    'topografo-custo: avaliar needs --url\ntopografo-custo: run `topografo-custo --help` for the usage\n',
  );

  assert.equal(
    await stderrDe(() =>
      executarCli(['avaliar', '--url', 'http://127.0.0.1:1'], { escrever: () => undefined }),
    ),
    'topografo-custo: avaliar needs --execucao\ntopografo-custo: run `topografo-custo --help` for the usage\n',
  );
});

/**
 * Roda algo e devolve o que foi para stderr.
 *
 * `executarCli` nunca propaga `ErroDeUso` — ele imprime e devolve 2 —, então o
 * texto que importa é exatamente o que uma pessoa vê no terminal.
 */
async function stderrDe(acao: () => Promise<number>): Promise<string> {
  const pedacos: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((texto: string) => {
    pedacos.push(String(texto));
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.equal(await acao(), 2, 'erro de uso sai 2, como em `cartografo`');
  } finally {
    process.stderr.write = original;
  }
  return pedacos.join('');
}
