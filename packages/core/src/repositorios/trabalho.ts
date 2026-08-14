/**
 * Repositório do trabalho — o "viajante" que anda pelo grafo.
 *
 * Toda escrita daqui grava a projeção E o evento correspondente na MESMA
 * transação do SQLite (FR18). Não é zelo excessivo: a projeção é derivada do
 * log, e um estado que existe sem o fato que o produziu é um estado que o
 * replay não reproduz — exatamente o que `test/replay-consistencia.test.ts`
 * cobra.
 *
 * As funções devolvem `null` quando o trabalho não existe; traduzir isso em 404
 * é papel da rota.
 */

import type { BancoDeDados } from '../db/connection.ts';
import { listarEventos, registrarEvento } from '../db/eventos.ts';
import { exigirDadosValidos, type Ator, type Evento } from '../db/validacao-evento.ts';
import {
  ATOR_API,
  PROJETO_PADRAO,
  agora,
  comoBooleano,
  comoInteiro,
  inteiroOuNulo,
  inteiroOuPadrao,
  resolverAtor,
  textoOuNulo,
} from './comum.ts';

/** Projeção do trabalho, como a API a devolve. */
export interface Trabalho {
  id: number;
  projeto_id: number;
  execucao_id: number | null;
  titulo: string;
  no_entrada_id: string;
  no_atual: string;
  bloqueado: boolean;
  motivo_bloqueio: string | null;
  /** Versão de grafo sob a qual o trabalho corre. Solto: `grafo_versao` é de t101 (D15). */
  grafo_versao_id: string | null;
  criado_em: string;
  atualizado_em: string;
}

/** Uma linha do agrupamento versão × telemetria (FR17). */
export interface MetricaPorVersao {
  grafo_versao_id: string | null;
  trabalhos: number;
  eventos: number;
}

interface LinhaTrabalho {
  id: number;
  projeto_id: number;
  execucao_id: number | null;
  titulo: string;
  no_entrada_id: string;
  no_atual: string;
  bloqueado: number;
  motivo_bloqueio: string | null;
  grafo_versao_id: string | null;
  criado_em: string;
  atualizado_em: string;
}

const COLUNAS = `
  id, projeto_id, execucao_id, titulo, no_entrada_id, no_atual,
  bloqueado, motivo_bloqueio, grafo_versao_id, criado_em, atualizado_em
`;

/**
 * Predicado de "este evento fala deste trabalho", em SQL.
 *
 * É a mesma regra da linha do tempo (FR9), aqui em forma de subconsulta para
 * poder contar sem materializar. Leitura pura: quem ESCREVE em `evento`
 * continua sendo só `src/db/eventos.ts`.
 */
const EVENTOS_DO_TRABALHO = `
  SELECT COUNT(*) FROM evento e
   WHERE (e.entidade_tipo = 'trabalho' AND e.entidade_id = CAST(t.id AS TEXT))
      OR (e.entidade_tipo IN ('sessao','pergunta')
          AND json_extract(e.dados, '$.trabalho_id') = t.id)
`;

function paraTrabalho(linha: LinhaTrabalho): Trabalho {
  return { ...linha, bloqueado: comoBooleano(linha.bloqueado) };
}

function lerLinha(db: BancoDeDados, id: number): LinhaTrabalho | undefined {
  return db.prepare(`SELECT ${COLUNAS} FROM trabalho WHERE id = ?`).get(id) as
    | LinhaTrabalho
    | undefined;
}

/**
 * Busca um trabalho pela projeção.
 *
 * @param db Handle aberto.
 * @param id Id do trabalho.
 * @returns O trabalho, ou `null` se não existe.
 */
export function buscarTrabalho(db: BancoDeDados, id: number): Trabalho | null {
  const linha = lerLinha(db, id);
  return linha === undefined ? null : paraTrabalho(linha);
}

/** Corpo de `POST /v1/trabalhos`. */
export interface EntradaCriarTrabalho {
  titulo?: unknown;
  no_entrada_id?: unknown;
  execucao_id?: unknown;
  projeto_id?: unknown;
  grafo_versao_id?: unknown;
  ator?: unknown;
}

/**
 * Cria o trabalho no nó de entrada e grava `trabalho.criado` (FR4).
 *
 * `grafo_versao_id` entra na PROJEÇÃO e não no payload do evento: o schema de
 * `trabalho.criado` não o declara, e um log que carrega campo fora de contrato
 * é um log que nenhum consumidor consegue validar.
 *
 * @param db Handle aberto.
 * @param entrada Corpo da requisição.
 * @returns O trabalho criado.
 * @throws {ErroDeValidacao} Quando falta campo obrigatório.
 */
export function criarTrabalho(db: BancoDeDados, entrada: EntradaCriarTrabalho): Trabalho {
  // Validar ANTES de abrir a transação: uma requisição inválida não pode nem
  // consumir um id da sequência (FR3).
  const dados = exigirDadosValidos('trabalho.criado', {
    titulo: entrada.titulo,
    no_entrada_id: entrada.no_entrada_id,
  });
  const projetoId = inteiroOuPadrao('projeto_id', entrada.projeto_id, PROJETO_PADRAO);
  const execucaoId = inteiroOuNulo('execucao_id', entrada.execucao_id);
  const grafoVersaoId = textoOuNulo('grafo_versao_id', entrada.grafo_versao_id);
  const ator = resolverAtor(entrada.ator, ATOR_API);
  const noEntrada = dados.no_entrada_id as string;

  const criar = db.transaction((): Trabalho => {
    const carimbo = agora();
    const resultado = db
      .prepare(
        `INSERT INTO trabalho (
           projeto_id, execucao_id, titulo, no_entrada_id, no_atual,
           bloqueado, motivo_bloqueio, grafo_versao_id, criado_em, atualizado_em
         ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
      )
      .run(
        projetoId,
        execucaoId,
        dados.titulo as string,
        noEntrada,
        noEntrada,
        grafoVersaoId,
        carimbo,
        carimbo,
      );

    const id = Number(resultado.lastInsertRowid);
    registrarEvento(db, {
      tipo: 'trabalho.criado',
      projeto_id: projetoId,
      execucao_id: execucaoId,
      entidade: { tipo: 'trabalho', id },
      ator,
      ocorrido_em: carimbo,
      dados,
    });

    return paraTrabalho(lerLinha(db, id) as LinhaTrabalho);
  });

  return criar();
}

/**
 * Grava um evento sobre um trabalho que já existe e atualiza a projeção.
 *
 * O molde de FR5–FR7: carrega a linha (404 vira `null` sem gravar nada),
 * valida o payload, e só então abre a transação em que projeção e evento caem
 * juntos.
 */
function mutar(
  db: BancoDeDados,
  id: number,
  tipo: string,
  ator: unknown,
  atorPadrao: Ator,
  montar: (linha: LinhaTrabalho) => {
    dados: Record<string, unknown>;
    sql: string;
    valores: unknown[];
  },
): Trabalho | null {
  const linha = lerLinha(db, id);
  if (linha === undefined) return null;

  const { dados: brutos, sql, valores } = montar(linha);
  const dados = exigirDadosValidos(tipo, brutos);
  const atorFinal = resolverAtor(ator, atorPadrao);

  const aplicar = db.transaction((): Trabalho => {
    const carimbo = agora();
    db.prepare(`UPDATE trabalho SET ${sql}, atualizado_em = ? WHERE id = ?`).run(
      ...valores,
      carimbo,
      id,
    );
    registrarEvento(db, {
      tipo,
      projeto_id: linha.projeto_id,
      execucao_id: linha.execucao_id,
      entidade: { tipo: 'trabalho', id },
      ator: atorFinal,
      ocorrido_em: carimbo,
      dados,
    });
    return paraTrabalho(lerLinha(db, id) as LinhaTrabalho);
  });

  return aplicar();
}

/** Corpo de `POST /v1/trabalhos/:id/transicoes`. */
export interface EntradaTransicao {
  para_no_id?: unknown;
  ator?: unknown;
}

/**
 * Move o trabalho de nó e grava `trabalho.transicao` (FR5).
 *
 * `de_no_id` é `null` na PRIMEIRA transição — o trabalho saindo do nó de
 * entrada pela primeira vez — e o nó corrente daí em diante. Quem responde
 * "primeira?" é o log, não a projeção: um trabalho pode voltar ao nó de entrada
 * mais tarde, e aí `no_atual == no_entrada_id` já não distingue nada.
 *
 * @param db Handle aberto.
 * @param id Id do trabalho.
 * @param entrada Corpo da requisição.
 * @returns O trabalho atualizado, ou `null` se não existe.
 */
export function transicionarTrabalho(
  db: BancoDeDados,
  id: number,
  entrada: EntradaTransicao,
): Trabalho | null {
  const jaAndou =
    db
      .prepare(
        `SELECT 1 FROM evento
          WHERE tipo = 'trabalho.transicao' AND entidade_tipo = 'trabalho' AND entidade_id = ?
          LIMIT 1`,
      )
      .get(String(id)) !== undefined;

  return mutar(db, id, 'trabalho.transicao', entrada.ator, ATOR_API, (linha) => ({
    dados: { de_no_id: jaAndou ? linha.no_atual : null, para_no_id: entrada.para_no_id },
    sql: 'no_atual = ?',
    valores: [entrada.para_no_id],
  }));
}

/** Corpo de `POST /v1/trabalhos/:id/bloqueios`. */
export interface EntradaBloqueio {
  motivo?: unknown;
  ator?: unknown;
}

/**
 * Levanta a bandeira de bloqueio e grava `trabalho.bloqueado` (FR6).
 *
 * Bloqueio é fato de bandeira, não de movimento: o trabalho não sai do nó.
 *
 * @param db Handle aberto.
 * @param id Id do trabalho.
 * @param entrada Corpo da requisição.
 * @returns O trabalho atualizado, ou `null` se não existe.
 */
export function bloquearTrabalho(
  db: BancoDeDados,
  id: number,
  entrada: EntradaBloqueio,
): Trabalho | null {
  return mutar(db, id, 'trabalho.bloqueado', entrada.ator, ATOR_API, () => ({
    dados: { motivo: entrada.motivo },
    sql: 'bloqueado = ?, motivo_bloqueio = ?',
    valores: [comoInteiro(true), entrada.motivo],
  }));
}

/** Corpo de `POST /v1/trabalhos/:id/desbloqueios`. */
export interface EntradaDesbloqueio {
  ator?: unknown;
}

/**
 * Baixa a bandeira e grava `trabalho.desbloqueado` (FR6).
 *
 * O evento não tem payload: o fato é a própria queda da bandeira.
 *
 * @param db Handle aberto.
 * @param id Id do trabalho.
 * @param entrada Corpo da requisição.
 * @returns O trabalho atualizado, ou `null` se não existe.
 */
export function desbloquearTrabalho(
  db: BancoDeDados,
  id: number,
  entrada: EntradaDesbloqueio,
): Trabalho | null {
  return mutar(db, id, 'trabalho.desbloqueado', entrada.ator, ATOR_API, () => ({
    dados: {},
    sql: 'bloqueado = ?, motivo_bloqueio = NULL',
    valores: [comoInteiro(false)],
  }));
}

/** Corpo de `PATCH /v1/trabalhos/:id`. */
export interface EntradaEmenda {
  titulo?: unknown;
  ator?: unknown;
}

/**
 * Emenda o conteúdo do trabalho e grava `trabalho.emendado` (FR7).
 *
 * O evento carrega os NOMES dos campos alterados e nunca o conteúdo novo: isto
 * é registro de auditoria, não histórico de versões. Quem quer o texto novo lê
 * o trabalho.
 *
 * @param db Handle aberto.
 * @param id Id do trabalho.
 * @param entrada Corpo da requisição.
 * @returns O trabalho atualizado, ou `null` se não existe.
 */
export function emendarTrabalho(
  db: BancoDeDados,
  id: number,
  entrada: EntradaEmenda,
): Trabalho | null {
  return mutar(db, id, 'trabalho.emendado', entrada.ator, ATOR_API, () => ({
    dados: { campos_alterados: ['titulo'] },
    sql: 'titulo = ?',
    valores: [entrada.titulo],
  }));
}

/**
 * O quadro atual: um trabalho por linha (FR8).
 *
 * @param db Handle aberto.
 * @param filtro Recorte opcional por execução.
 * @returns Trabalhos em ordem de id.
 */
export function listarTrabalhos(
  db: BancoDeDados,
  filtro: { execucao_id?: number } = {},
): Trabalho[] {
  const linhas = (
    filtro.execucao_id === undefined
      ? db.prepare(`SELECT ${COLUNAS} FROM trabalho ORDER BY id`).all()
      : db
          .prepare(`SELECT ${COLUNAS} FROM trabalho WHERE execucao_id = ? ORDER BY id`)
          .all(filtro.execucao_id)
  ) as LinhaTrabalho[];
  return linhas.map(paraTrabalho);
}

/**
 * A linha do tempo do trabalho (FR9).
 *
 * @param db Handle aberto.
 * @param id Id do trabalho.
 * @returns Eventos em ordem de id, ou `null` se o trabalho não existe.
 */
export function linhaDoTempoDoTrabalho(db: BancoDeDados, id: number): Evento[] | null {
  if (lerLinha(db, id) === undefined) return null;
  return listarEventos(db, { trabalho_id: id });
}

/**
 * Versão de grafo × telemetria, para uma execução (FR17).
 *
 * É o join que o topógrafo vai precisar depois da PoC: sem contar trabalhos E
 * eventos POR versão, "a v2 é melhor que a v1" não passa de opinião (D15).
 * Trabalhos sem versão declarada caem num grupo `null` em vez de sumir — um
 * relatório que esconde o que não sabe classificar mente sobre o total.
 *
 * @param db Handle aberto.
 * @param execucaoId Execução a agrupar.
 * @returns Uma linha por versão, versões nomeadas primeiro e `null` por último.
 */
export function metricasPorVersao(db: BancoDeDados, execucaoId: number): MetricaPorVersao[] {
  const linhas = db
    .prepare(
      `SELECT t.grafo_versao_id           AS grafo_versao_id,
              COUNT(*)                    AS trabalhos,
              COALESCE(SUM((${EVENTOS_DO_TRABALHO})), 0) AS eventos
         FROM trabalho t
        WHERE t.execucao_id = ?
        GROUP BY t.grafo_versao_id`,
    )
    .all(execucaoId) as MetricaPorVersao[];

  return linhas.sort((a, b) => {
    if (a.grafo_versao_id === null) return 1;
    if (b.grafo_versao_id === null) return -1;
    return a.grafo_versao_id.localeCompare(b.grafo_versao_id);
  });
}
