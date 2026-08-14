/**
 * Testes de aceite do cliente HTTP da lente de custo (t114, AT8).
 *
 * Tudo com `fetch` falso injetado, sem rede real: o que esta ficha prova é o
 * contrato que o topógrafo usa da API pública — quatro rotas, nenhuma a mais —
 * e não o comportamento do control plane, que tem os testes dele no core.
 *
 * Mesmo padrão de `packages/tela/src/index.ts:28`: `buscar` é injetável só para
 * teste; em produção é o `fetch` global.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as ModuloCliente from '../src/cliente.ts';

const RAIZ_PACOTE = path.resolve(import.meta.dirname, '..');
const RAIZ_REPO = path.resolve(RAIZ_PACOTE, '..', '..');
const CAMINHO_FICHA = path.join(RAIZ_REPO, 'docs', 'spec', 'topografo-custo.md');

let cache: typeof ModuloCliente | null = null;

async function carregar(): Promise<typeof ModuloCliente> {
  assert.ok(
    existsSync(path.join(RAIZ_PACOTE, 'src', 'cliente.ts')),
    'artefato ainda não existe: packages/topografo-custo/src/cliente.ts',
  );
  cache ??= (await import(
    new URL('../src/cliente.ts', import.meta.url).href
  )) as typeof ModuloCliente;
  return cache;
}

interface Chamada {
  url: string;
  metodo: string;
  corpo: unknown;
}

/** `fetch` falso que anota a chamada e devolve o corpo combinado. */
function espiao(corpoDaResposta: unknown): { chamadas: Chamada[]; buscar: typeof fetch } {
  const chamadas: Chamada[] = [];
  const buscar: typeof fetch = async (entrada, init) => {
    chamadas.push({
      url: String(entrada),
      metodo: init?.method ?? 'GET',
      corpo: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(corpoDaResposta), {
      status: init?.method === 'POST' ? 201 : 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { chamadas, buscar };
}

test('AT8 — buscarSessoes e buscarTrabalhos põem execucao_id na query quando informado', async () => {
  const { buscarSessoes, buscarTrabalhos } = await carregar();

  const dasSessoes = espiao({ sessoes: [{ id: 1 }] });
  const sessoes = await buscarSessoes('http://127.0.0.1:4317', { execucao_id: 7 }, dasSessoes.buscar);
  assert.equal(sessoes.length, 1);
  assert.deepEqual(
    dasSessoes.chamadas.map((chamada) => chamada.url),
    ['http://127.0.0.1:4317/v1/sessions?execucao_id=7'],
  );

  const dosTrabalhos = espiao({ trabalhos: [{ id: 1 }] });
  await buscarTrabalhos('http://127.0.0.1:4317', { execucao_id: 7 }, dosTrabalhos.buscar);
  assert.deepEqual(
    dosTrabalhos.chamadas.map((chamada) => chamada.url),
    ['http://127.0.0.1:4317/v1/jobs?execucao_id=7'],
  );

  // Sem filtro não sobra `?` pendurado na URL.
  const semFiltro = espiao({ sessoes: [] });
  await buscarSessoes('http://127.0.0.1:4317/', {}, semFiltro.buscar);
  assert.deepEqual(
    semFiltro.chamadas.map((chamada) => chamada.url),
    ['http://127.0.0.1:4317/v1/sessions'],
    'a barra final da url base é normalizada, como em packages/tela',
  );
});

test('AT8 — criarProposta faz POST /v1/proposals com as cinco chaves do contrato', async () => {
  const { criarProposta } = await carregar();

  const entrada = {
    grafo_id: 'nota-curta',
    versao_alvo: 'sha256:v1',
    operacoes: [
      {
        tipo: 'alterar_campo_no' as const,
        no_id: 'redigir',
        campo: 'descricao' as const,
        de: 'antes',
        para: 'depois',
        inversa: {
          tipo: 'alterar_campo_no' as const,
          no_id: 'redigir',
          campo: 'descricao' as const,
          de: 'depois',
          para: 'antes',
        },
      },
    ],
    evidencia: { lente: 'custo' as const },
    metrica_esperada: { descricao: 'cair abaixo do teto' },
  };

  const { chamadas, buscar } = espiao({ proposta: { id: 42, status: 'pendente' } });
  const proposta = await criarProposta('http://127.0.0.1:4317', entrada, buscar);

  assert.equal(proposta.id, 42);
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].url, 'http://127.0.0.1:4317/v1/proposals');
  assert.equal(chamadas[0].metodo, 'POST');
  assert.deepEqual(Object.keys(chamadas[0].corpo as object).sort(), [
    'evidencia',
    'grafo_id',
    'metrica_esperada',
    'operacoes',
    'versao_alvo',
  ]);
  assert.deepEqual(chamadas[0].corpo, entrada);
});

test('AT8 — buscarGrafoVersao lê o snapshot pela rota pública de versão', async () => {
  const { buscarGrafoVersao } = await carregar();

  const { chamadas, buscar } = espiao({
    grafo_versao: { id: 'sha256:v1', grafo_id: 'nota-curta', snapshot: { nos: [] } },
  });
  const versao = await buscarGrafoVersao('http://127.0.0.1:4317', 'sha256:v1', buscar);

  assert.equal(versao.grafo_id, 'nota-curta');
  assert.deepEqual(
    chamadas.map((chamada) => chamada.url),
    ['http://127.0.0.1:4317/v1/graph-versions/sha256%3Av1'],
    'o id da versão carrega ":" e precisa entrar escapado no caminho',
  );
});

/**
 * Os caminhos pré-D18 que a API deixou de servir (t127/t130/t132/t133).
 *
 * Lista escrita à mão, e é o ponto: um caminho renomeado no core não quebra
 * nenhum teste desta ficha, porque todo teste de unidade aqui fala com `fetch`
 * falso. Foi assim que a lente inteira ficou apontada para rotas que respondiam
 * 404 sem nada acusar (t136). Quem renomear de novo acrescenta a linha aqui.
 */
const CAMINHOS_PRE_D18 = Object.freeze([
  '/v1/sessoes',
  '/v1/trabalhos',
  '/v1/grafos',
  '/v1/grafo-versoes',
  '/v1/propostas',
  '/v1/execucoes',
]);

/** A fronteira da lente: as quatro rotas do §5, e nenhuma a mais. */
const FRONTEIRA = Object.freeze([
  ['/v1/sessions', 'GET'],
  ['/v1/jobs', 'GET'],
  ['/v1/graph-versions/:id', 'GET'],
  ['/v1/proposals', 'POST'],
]);

/** O texto de uma seção `## N.` da ficha, até a próxima seção. */
function secao(ficha: string, numero: number): string {
  const inicio = ficha.indexOf(`\n## ${numero}.`);
  assert.notEqual(inicio, -1, `a ficha não tem a seção ${numero}`);
  const resto = ficha.slice(inicio + 1);
  const fim = resto.indexOf('\n## ');
  return fim === -1 ? resto : resto.slice(0, fim);
}

test('t136 — a ficha não cita nenhum caminho pré-D18 da API', () => {
  assert.ok(existsSync(CAMINHO_FICHA), `artefato ainda não existe: ${CAMINHO_FICHA}`);
  const ficha = readFileSync(CAMINHO_FICHA, 'utf8');

  for (const caminho of CAMINHOS_PRE_D18) {
    const linhas = ficha
      .split('\n')
      .map((texto, indice) => [indice + 1, texto] as const)
      .filter(([, texto]) => new RegExp(`${caminho}\\b`).test(texto));

    assert.deepEqual(
      linhas,
      [],
      `a ficha promete ${caminho}, que a API não serve mais (D18):\n` +
        linhas.map(([numero, texto]) => `  ${numero}: ${texto.trim()}`).join('\n'),
    );
  }
});

test('t136 — a tabela de fronteira do §5 é exatamente o que o cliente chama', () => {
  const ficha = readFileSync(CAMINHO_FICHA, 'utf8');

  const tabela = [...secao(ficha, 5).matchAll(/^\|\s*`(\/v1\/[^`]+)`\s*\|\s*(GET|POST|PATCH)\s*\|/gm)]
    .map((linha) => [linha[1], linha[2]]);

  assert.deepEqual(
    tabela,
    FRONTEIRA.map((linha) => [...linha]),
    'a tabela do §5 e as rotas de src/cliente.ts precisam dizer a mesma coisa',
  );
});

test('AT8 — resposta de erro vira exceção com status e corpo, não silêncio', async () => {
  const { buscarSessoes, ErroDaApi } = await carregar();

  const buscar: typeof fetch = async () =>
    new Response(JSON.stringify({ erro: 'parametro_invalido' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });

  await assert.rejects(
    () => buscarSessoes('http://127.0.0.1:4317', { execucao_id: 7 }, buscar),
    (erro: unknown) => {
      assert.ok(erro instanceof ErroDaApi);
      assert.equal(erro.status, 400);
      assert.deepEqual(erro.corpo, { erro: 'parametro_invalido' });
      return true;
    },
  );
});
