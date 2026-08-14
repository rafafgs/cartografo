/**
 * Apoio comum aos testes de aceite das entidades de domínio (t102).
 *
 * Não é um arquivo de teste (o glob do pacote é `test/*.test.ts`): é o pedaço
 * repetido de seis fichas de teste — subir o control plane contra um banco
 * descartável e falar HTTP com ele.
 *
 * Os módulos do `src/` são carregados sob demanda, atrás de um `existsSync`,
 * pela mesma razão de `test/health.test.ts:27-36`: no vermelho inicial a falha
 * precisa NOMEAR o artefato que falta, em vez de estourar um erro de resolução
 * de módulo que se parece com qualquer outro bug.
 *
 * As interfaces daqui são deliberadamente escritas à mão em vez de importadas
 * de `src/`: elas SÃO o contrato que os testes cobram da API, e um contrato que
 * se importa da implementação não cobra nada.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { BancoDeDados } from '../src/db/connection.ts';
import type * as ModuloConnection from '../src/db/connection.ts';
import type * as ModuloMigrate from '../src/db/migrate.ts';
import type * as ModuloServer from '../src/server.ts';

/** Raiz do pacote `packages/core`. */
export const RAIZ_PACOTE = path.resolve(import.meta.dirname, '..');

/** Diretório das migrações do pacote. */
export const DIR_MIGRACOES = path.join(RAIZ_PACOTE, 'migrations');

/** Artefatos que esta ficha cria; todo teste exige os que ele exercita. */
export const ARTEFATOS_T102 = Object.freeze({
  migracao: 'migrations/0002_trabalho_sessao_evento_pergunta.sql',
  eventos: 'src/db/eventos.ts',
  validacao: 'src/db/validacao-evento.ts',
  repoTrabalho: 'src/repositorios/trabalho.ts',
  repoSessao: 'src/repositorios/sessao.ts',
  repoPergunta: 'src/repositorios/pergunta.ts',
  rotasTrabalhos: 'src/routes/trabalhos.ts',
  rotasSessoes: 'src/routes/sessoes.ts',
  rotasPerguntas: 'src/routes/perguntas.ts',
  rotasExecucoes: 'src/routes/execucoes.ts',
});

/**
 * Falha nomeando o arquivo que falta, em vez de deixar o import estourar.
 *
 * @param relativos Caminhos relativos à raiz de `packages/core`.
 */
export function exigirArtefatos(...relativos: string[]): void {
  for (const relativo of relativos) {
    assert.ok(
      existsSync(path.join(RAIZ_PACOTE, relativo)),
      `artefato ainda não existe: packages/core/${relativo}`,
    );
  }
}

/** Envelope de evento, como a taxonomia (t98) o define. */
export interface Evento {
  id: number;
  tipo: string;
  projeto_id: number;
  execucao_id: number | null;
  entidade: { tipo: string; id: number | string };
  ator: { tipo: string; ref: string };
  ocorrido_em: string;
  dados: Record<string, unknown>;
}

/** Projeção de trabalho, como a API a devolve. */
export interface Trabalho {
  id: number;
  projeto_id: number;
  execucao_id: number | null;
  titulo: string;
  no_entrada_id: string;
  no_atual: string;
  bloqueado: boolean;
  motivo_bloqueio: string | null;
  grafo_versao_id: string | null;
  criado_em: string;
  atualizado_em: string;
}

/** Totais de tokens de uma sessão; `null` quando o engine não reportou nada. */
export interface UsoDeSessao {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** Projeção de sessão, como a API a devolve. */
export interface Sessao {
  id: number;
  trabalho_id: number | null;
  execucao_id: number | null;
  no_id: string | null;
  engine: string;
  engine_session_ref: string | null;
  working_dir: string;
  prompt: string;
  timeout_seconds: number | null;
  status: string;
  exit_code: number | null;
  uso: UsoDeSessao | null;
  aberta_em: string;
  finalizada_em: string | null;
}

/** Projeção de pergunta, como a API a devolve. */
export interface Pergunta {
  id: number;
  trabalho_id: number;
  sessao_id: number | null;
  execucao_id: number | null;
  tipo: string;
  pergunta: string;
  contexto: string | null;
  opcoes: string[] | null;
  recomendacao: string | null;
  resposta_padrao: string | null;
  auto_aprovavel: boolean;
  status: string;
  resposta: string | null;
  respondido_por: string | null;
  origem: string | null;
  criada_em: string;
  respondida_em: string | null;
}

/** Uma linha de `GET /v1/execucoes/:id/metricas-por-versao`. */
export interface MetricaPorVersao {
  grafo_versao_id: string | null;
  trabalhos: number;
  eventos: number;
}

/** Control plane no ar, contra um banco descartável. */
export interface ContextoTeste {
  /** Handle do banco — os testes só LEEM por ele; quem escreve é a API. */
  db: BancoDeDados;
  /** URL base do servidor. */
  url: string;
}

/** O pedaço do `TestContext` do `node:test` que este apoio usa. */
export interface GanchoDeTeste {
  after: (fn: () => void | Promise<void>) => void;
}

async function carregar<T>(relativo: string): Promise<T> {
  exigirArtefatos(relativo);
  return (await import(new URL(`../${relativo}`, import.meta.url).href)) as T;
}

/**
 * Sobe o control plane inteiro contra um banco em diretório temporário.
 *
 * @param t Contexto do teste, para registrar o encerramento.
 * @returns Banco aberto e URL base.
 */
export async function subirControlPlane(t: GanchoDeTeste): Promise<ContextoTeste> {
  const { abrirBanco, aplicarPragmas } = await carregar<typeof ModuloConnection>(
    'src/db/connection.ts',
  );
  const { migrar } = await carregar<typeof ModuloMigrate>('src/db/migrate.ts');
  const { criarApp } = await carregar<typeof ModuloServer>('src/server.ts');

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t102-'));
  const db = abrirBanco(path.join(base, 'cartografo.db'));
  aplicarPragmas(db);
  migrar(db, DIR_MIGRACOES);

  const app = criarApp({ db });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });

  t.after(async () => {
    await app.close();
    db.close();
    rmSync(base, { recursive: true, force: true });
  });

  return { db, url };
}

/** Resposta HTTP já decodificada. */
export interface Resposta<T> {
  status: number;
  corpo: T;
}

/**
 * Fala HTTP/JSON com o control plane.
 *
 * @param ctx Control plane no ar.
 * @param metodo Verbo HTTP.
 * @param caminho Caminho, já com o prefixo `/v1`.
 * @param corpo Corpo JSON, quando houver.
 * @returns Status e corpo decodificado.
 */
export async function pedir<T>(
  ctx: ContextoTeste,
  metodo: string,
  caminho: string,
  corpo?: unknown,
): Promise<Resposta<T>> {
  const resposta = await fetch(`${ctx.url}${caminho}`, {
    method: metodo,
    headers: corpo === undefined ? undefined : { 'content-type': 'application/json' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const texto = await resposta.text();
  return {
    status: resposta.status,
    corpo: (texto === '' ? undefined : JSON.parse(texto)) as T,
  };
}

/** Superfície de leitura do log que os testes usam (FR2). */
export interface ModuloEventos {
  registrarEvento: unknown;
  listarEventos: (db: BancoDeDados) => Evento[];
  buscarEventosPorEntidade: (db: BancoDeDados, tipo: string, id: number | string) => Evento[];
}

/** Carrega `src/db/eventos.ts` sob demanda (vermelho inicial nomeado). */
export async function carregarEventos(): Promise<ModuloEventos> {
  return await carregar<ModuloEventos>(ARTEFATOS_T102.eventos);
}

/** Quantos eventos existem no log, ao todo. */
export function contarEventos(ctx: ContextoTeste): number {
  const linha = ctx.db.prepare('SELECT COUNT(*) AS total FROM evento').get() as { total: number };
  return linha.total;
}

/** Atalho: cria um trabalho e devolve a projeção. */
export async function criarTrabalho(
  ctx: ContextoTeste,
  corpo: Record<string, unknown>,
): Promise<Trabalho> {
  const resposta = await pedir<Trabalho>(ctx, 'POST', '/v1/trabalhos', corpo);
  assert.equal(resposta.status, 201, `POST /v1/trabalhos devolveu ${resposta.status}`);
  return resposta.corpo;
}
