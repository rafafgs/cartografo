/**
 * Apoio comum aos testes de aceite da tela (t107).
 *
 * Não é arquivo de teste (o glob do pacote é `test/*.test.ts`): é o pedaço
 * repetido de quatro fichas — subir um control plane DE VERDADE, subir a tela
 * DE VERDADE contra ele, e falar HTTP com os dois.
 *
 * O control plane sobe como PROCESSO FILHO, e não por importação. É a D11 sendo
 * exercida em vez de declarada: a tela não pode importar nada de
 * `packages/core`, não declara driver de SQLite e não conhece o caminho do
 * banco — a única superfície entre os dois pacotes é a porta HTTP, e um teste
 * que importasse o core para semear dados provaria menos do que promete (é o
 * mesmo padrão de `packages/runner/test/controller/dispatch-e-lease.e2e.test.ts`).
 *
 * Por consequência, TODA a semeadura de dados destes testes é feita pela API
 * pública, e toda a verificação de estado também.
 *
 * A tela, ao contrário, sobe EM PROCESSO: `bin/tela.mjs` é casca fina (exceção
 * de TDD declarada na ficha) e o que os testes exercitam é `src/servidor.ts`.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as esperar } from 'node:timers/promises';

import type * as ModuloServidor from '../src/servidor.ts';

/** Raiz do pacote `packages/tela`. */
export const RAIZ_PACOTE = path.resolve(import.meta.dirname, '..');

/** Raiz do monorepo. */
export const RAIZ_REPO = path.resolve(RAIZ_PACOTE, '..', '..');

/** O comando do control plane, rodado como processo filho. */
export const CAMINHO_BIN_CORE = path.join(RAIZ_REPO, 'packages', 'core', 'bin', 'cartografo.mjs');

/** Artefatos que esta ficha cria; todo teste exige os que ele exercita. */
export const ARTEFATOS_T107 = Object.freeze({
  cliente: 'src/cliente.ts',
  linhaDoTempo: 'src/linha-do-tempo.ts',
  paginas: 'src/paginas.ts',
  servidor: 'src/servidor.ts',
  bin: 'bin/tela.mjs',
});

/** Prazo para o control plane ficar de pé. Folga larga sobre o normal (~2s). */
const PRAZO_PRONTIDAO_MS = 60_000;

/** `stdio: ['ignore', 'pipe', 'pipe']` — sem stdin, com stdout/stderr lidos. */
type FilhoDoComando = ChildProcessByStdio<null, Readable, Readable>;

/** O pedaço do `TestContext` do `node:test` que este apoio usa. */
export interface GanchoDeTeste {
  after: (fn: () => void | Promise<void>) => void;
}

/**
 * Falha nomeando o arquivo que falta, em vez de deixar o import estourar.
 *
 * @param relativos Caminhos relativos à raiz de `packages/tela`.
 */
export function exigirArtefatos(...relativos: string[]): void {
  for (const relativo of relativos) {
    assert.ok(
      existsSync(path.join(RAIZ_PACOTE, relativo)),
      `artefato ainda não existe: packages/tela/${relativo}`,
    );
  }
}

/** Control plane no ar, do ponto de vista de quem só fala HTTP com ele. */
export interface ControlPlaneNoAr {
  /** URL base anunciada pelo próprio comando. */
  url: string;
}

/**
 * Sobe o control plane de verdade e resolve quando ele anuncia prontidão.
 *
 * @param t Contexto do teste, para encerrar o processo no fim.
 * @returns O control plane no ar.
 */
export async function subirControlPlane(t: GanchoDeTeste): Promise<ControlPlaneNoAr> {
  assert.ok(existsSync(CAMINHO_BIN_CORE), `artefato ainda não existe: ${CAMINHO_BIN_CORE}`);

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t107-'));
  const filho: FilhoDoComando = spawn(process.execPath, [CAMINHO_BIN_CORE], {
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

  const prazo = Date.now() + PRAZO_PRONTIDAO_MS;
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
    if (linha !== undefined) return { url: (JSON.parse(linha) as { url: string }).url };
    await esperar(50);
  }

  throw new Error(`o control plane não ficou pronto em ${PRAZO_PRONTIDAO_MS}ms\nstdout:\n${saida}`);
}

/** A tela no ar. */
export interface TelaNoAr {
  url: string;
}

/**
 * Sobe a tela contra um control plane, em porta efêmera.
 *
 * @param t Contexto do teste, para encerrar o servidor no fim.
 * @param urlControlPlane Endereço do control plane que a tela vai ler.
 * @returns A tela no ar.
 */
export async function subirTela(t: GanchoDeTeste, urlControlPlane: string): Promise<TelaNoAr> {
  exigirArtefatos(ARTEFATOS_T107.servidor);
  const { iniciarTela } = (await import(
    new URL('../src/servidor.ts', import.meta.url).href
  )) as typeof ModuloServidor;

  const tela = await iniciarTela({ urlControlPlane, porta: 0 });
  t.after(async () => {
    await tela.encerrar();
  });
  return { url: tela.url };
}

/** Resposta HTTP/JSON do control plane. */
export interface RespostaJson<T> {
  status: number;
  corpo: T;
}

/**
 * Fala JSON com o control plane — a semeadura e a conferência dos testes.
 *
 * @param cp Control plane no ar.
 * @param metodo Verbo HTTP.
 * @param caminho Caminho, já com o prefixo `/v1`.
 * @param corpo Corpo JSON, quando houver.
 * @returns Status e corpo decodificado.
 */
export async function api<T>(
  cp: ControlPlaneNoAr,
  metodo: string,
  caminho: string,
  corpo?: unknown,
): Promise<RespostaJson<T>> {
  const resposta = await fetch(`${cp.url}${caminho}`, {
    method: metodo,
    headers: corpo === undefined ? undefined : { 'content-type': 'application/json' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const texto = await resposta.text();
  return { status: resposta.status, corpo: (texto === '' ? undefined : JSON.parse(texto)) as T };
}

/** Projeção de trabalho, como a API pública a devolve. */
export interface Trabalho {
  id: number;
  execucao_id: number | null;
  titulo: string;
  no_atual: string;
  bloqueado: boolean;
  motivo_bloqueio: string | null;
  criado_em: string;
}

/** Projeção de sessão, como a API pública a devolve. */
export interface Sessao {
  id: number;
  trabalho_id: number | null;
  execucao_id: number | null;
  engine: string;
  status: string;
  aberta_em: string;
  finalizada_em: string | null;
}

/** Projeção de pergunta, como a API pública a devolve. */
export interface Pergunta {
  id: number;
  trabalho_id: number;
  pergunta: string;
  contexto: string | null;
  opcoes: string[] | null;
  recomendacao: string | null;
  resposta_padrao: string | null;
  status: string;
  resposta: string | null;
  respondido_por: string | null;
  criada_em: string;
  respondida_em: string | null;
}

/** Atalho: cria um trabalho pela API pública. */
export async function criarTrabalho(
  cp: ControlPlaneNoAr,
  corpo: Record<string, unknown>,
): Promise<Trabalho> {
  const resposta = await api<Trabalho>(cp, 'POST', '/v1/jobs', corpo);
  assert.equal(resposta.status, 201, `POST /v1/jobs devolveu ${resposta.status}`);
  return resposta.corpo;
}

/** Atalho: abre uma sessão pela API pública. */
export async function abrirSessao(
  cp: ControlPlaneNoAr,
  corpo: Record<string, unknown>,
): Promise<Sessao> {
  const resposta = await api<Sessao>(cp, 'POST', '/v1/sessions', {
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'trabalhe',
    ...corpo,
  });
  assert.equal(resposta.status, 201, `POST /v1/sessions devolveu ${resposta.status}`);
  return resposta.corpo;
}

/** Atalho: cria uma pergunta pela API pública. */
export async function criarPergunta(
  cp: ControlPlaneNoAr,
  corpo: Record<string, unknown>,
): Promise<Pergunta> {
  const resposta = await api<Pergunta>(cp, 'POST', '/v1/input-requests', {
    tipo: 'pergunta',
    auto_aprovavel: false,
    ...corpo,
  });
  assert.equal(resposta.status, 201, `POST /v1/input-requests devolveu ${resposta.status}`);
  return resposta.corpo;
}

/** Página HTML já lida. */
export interface Pagina {
  status: number;
  tipo: string | null;
  html: string;
}

/**
 * Pede uma página da tela.
 *
 * @param tela Tela no ar.
 * @param caminho Caminho da rota.
 * @returns Status, content-type e corpo.
 */
export async function abrirPagina(tela: TelaNoAr, caminho: string): Promise<Pagina> {
  const resposta = await fetch(`${tela.url}${caminho}`);
  return {
    status: resposta.status,
    tipo: resposta.headers.get('content-type'),
    html: await resposta.text(),
  };
}

/** Resposta a um submit de formulário. */
export interface Submissao {
  status: number;
  destino: string | null;
}

/**
 * Envia um formulário da tela, como um navegador o enviaria.
 *
 * `redirect: 'manual'` é o ponto: o teste precisa VER o 303 e para onde ele
 * aponta, e não o resultado de já tê-lo seguido.
 *
 * @param tela Tela no ar.
 * @param caminho Caminho da rota de escrita.
 * @param campos Campos do formulário.
 * @returns Status e o `Location` do redirecionamento.
 */
export async function enviarFormulario(
  tela: TelaNoAr,
  caminho: string,
  campos: Record<string, string>,
): Promise<Submissao> {
  const resposta = await fetch(`${tela.url}${caminho}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(campos).toString(),
    redirect: 'manual',
  });
  return { status: resposta.status, destino: resposta.headers.get('location') };
}

/** Um bloco de HTML recortado por um marcador `data-*`. */
export interface Bloco {
  valor: string;
  trecho: string;
}

/**
 * Recorta o HTML nos pontos em que um marcador `data-*` aparece.
 *
 * Corte por marcador, não parser: os `data-*` da tela são contrato declarado em
 * `docs/spec/tela.md` justamente para que os testes possam afirmar sobre
 * ESTRUTURA (o que está dentro de qual grupo, em que ordem) sem congelar a
 * marcação inteira. Cada bloco vai do marcador até o próximo marcador do mesmo
 * nome — o suficiente para "este título está sob este grupo".
 *
 * @param html Página inteira.
 * @param atributo Nome do marcador, sem o prefixo `data-` (ex.: `no-atual`).
 * @returns Blocos na ordem em que aparecem.
 */
export function blocos(html: string, atributo: string): Bloco[] {
  const padrao = new RegExp(`data-${atributo}="([^"]*)"`, 'g');
  const marcas: { valor: string; inicio: number }[] = [];
  let casamento: RegExpExecArray | null;
  while ((casamento = padrao.exec(html)) !== null) {
    marcas.push({ valor: casamento[1], inicio: casamento.index });
  }
  return marcas.map((marca, indice) => ({
    valor: marca.valor,
    trecho: html.slice(marca.inicio, marcas[indice + 1]?.inicio ?? html.length),
  }));
}
