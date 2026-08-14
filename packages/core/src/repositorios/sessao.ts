/**
 * Repositório da sessão — a execução de um agente por um EngineAdapter.
 *
 * No flowpilot isto era uma linha mutável que nascia `pending` e era atualizada
 * até `completed`. Aqui são DOIS fatos (`sessao.aberta`, `sessao.finalizada`) e
 * uma projeção derivada deles — a consequência 2 da regra append-only da
 * taxonomia.
 *
 * O cuidado que atravessa o arquivo: `uso` ausente é `null`, nunca zero. Zero
 * tokens é uma medição; ausência é o engine não ter reportado nada, e colapsar
 * as duas coisas destrói a única métrica de custo que a PoC vai ter.
 */

import type { BancoDeDados } from '../db/connection.ts';
import { registrarEvento } from '../db/eventos.ts';
import { exigirDadosValidos } from '../db/validacao-evento.ts';
import {
  ATOR_RUNNER,
  PROJETO_PADRAO,
  agora,
  inteiroOuNulo,
  inteiroOuPadrao,
  jsonOuNulo,
  resolverAtor,
} from './comum.ts';

/** Totais de tokens congelados no fim da vida da sessão. */
export interface UsoDeSessao {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** Projeção da sessão, como a API a devolve. */
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

interface LinhaSessao extends Omit<Sessao, 'uso'> {
  uso: string | null;
}

const COLUNAS = `
  id, trabalho_id, execucao_id, no_id, engine, engine_session_ref, working_dir,
  prompt, timeout_seconds, status, exit_code, uso, aberta_em, finalizada_em
`;

function paraSessao(linha: LinhaSessao): Sessao {
  return { ...linha, uso: jsonOuNulo<UsoDeSessao>(linha.uso) };
}

function lerLinha(db: BancoDeDados, id: number): LinhaSessao | undefined {
  return db.prepare(`SELECT ${COLUNAS} FROM sessao WHERE id = ?`).get(id) as
    | LinhaSessao
    | undefined;
}

/**
 * Busca uma sessão pela projeção.
 *
 * @param db Handle aberto.
 * @param id Id da sessão.
 * @returns A sessão, ou `null` se não existe.
 */
export function buscarSessao(db: BancoDeDados, id: number): Sessao | null {
  const linha = lerLinha(db, id);
  return linha === undefined ? null : paraSessao(linha);
}

/** Corpo de `POST /v1/sessoes`. */
export interface EntradaAbrirSessao {
  trabalho_id?: unknown;
  no_id?: unknown;
  engine?: unknown;
  engine_session_ref?: unknown;
  working_dir?: unknown;
  prompt?: unknown;
  timeout_seconds?: unknown;
  execucao_id?: unknown;
  projeto_id?: unknown;
  ator?: unknown;
}

/**
 * Abre a sessão e grava `sessao.aberta` (FR10).
 *
 * `execucao_id` e `projeto_id` são herdados do trabalho servido quando há um —
 * a sessão pertence à rodada do trabalho, e pedir que o chamador repita isso
 * seria convidar a divergência. Sem trabalho (sessão de descoberta, turno de
 * conversa), valem o que veio no corpo.
 *
 * @param db Handle aberto.
 * @param entrada Corpo da requisição.
 * @returns A sessão aberta, ou `null` se o `trabalho_id` informado não existe.
 * @throws {ErroDeValidacao} Quando falta campo obrigatório.
 */
export function abrirSessao(db: BancoDeDados, entrada: EntradaAbrirSessao): Sessao | null {
  const dados = exigirDadosValidos('sessao.aberta', {
    trabalho_id: entrada.trabalho_id,
    no_id: entrada.no_id,
    engine: entrada.engine,
    engine_session_ref: entrada.engine_session_ref,
    working_dir: entrada.working_dir,
    prompt: entrada.prompt,
    timeout_seconds: entrada.timeout_seconds,
  });

  const trabalhoId = dados.trabalho_id as number | null;
  const dono =
    trabalhoId === null
      ? undefined
      : (db.prepare('SELECT projeto_id, execucao_id FROM trabalho WHERE id = ?').get(trabalhoId) as
          | { projeto_id: number; execucao_id: number | null }
          | undefined);
  if (trabalhoId !== null && dono === undefined) return null;

  const projetoId = dono?.projeto_id ?? inteiroOuPadrao('projeto_id', entrada.projeto_id, PROJETO_PADRAO);
  const execucaoId = dono?.execucao_id ?? inteiroOuNulo('execucao_id', entrada.execucao_id);
  const ator = resolverAtor(entrada.ator, ATOR_RUNNER);

  const abrir = db.transaction((): Sessao => {
    const carimbo = agora();
    const resultado = db
      .prepare(
        `INSERT INTO sessao (
           trabalho_id, execucao_id, no_id, engine, engine_session_ref, working_dir,
           prompt, timeout_seconds, status, exit_code, uso, aberta_em, finalizada_em
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'aberta', NULL, NULL, ?, NULL)`,
      )
      .run(
        trabalhoId,
        execucaoId,
        dados.no_id as string | null,
        dados.engine as string,
        dados.engine_session_ref as string | null,
        dados.working_dir as string,
        dados.prompt as string,
        dados.timeout_seconds as number | null,
        carimbo,
      );

    const id = Number(resultado.lastInsertRowid);
    registrarEvento(db, {
      tipo: 'sessao.aberta',
      projeto_id: projetoId,
      execucao_id: execucaoId,
      entidade: { tipo: 'sessao', id },
      ator,
      ocorrido_em: carimbo,
      dados,
    });

    return paraSessao(lerLinha(db, id) as LinhaSessao);
  });

  return abrir();
}

/** Corpo de `PATCH /v1/sessoes/:id/finalizar`. */
export interface EntradaFinalizarSessao {
  status?: unknown;
  exit_code?: unknown;
  uso?: unknown;
  ator?: unknown;
}

/**
 * Fecha a sessão e grava `sessao.finalizada` (FR11).
 *
 * @param db Handle aberto.
 * @param id Id da sessão.
 * @param entrada Corpo da requisição.
 * @returns A sessão fechada, ou `null` se não existe.
 * @throws {ErroDeValidacao} Quando o status está fora do enum ou `uso` não fecha.
 */
export function finalizarSessao(
  db: BancoDeDados,
  id: number,
  entrada: EntradaFinalizarSessao,
): Sessao | null {
  const linha = lerLinha(db, id);
  if (linha === undefined) return null;

  const dados = exigirDadosValidos('sessao.finalizada', {
    status: entrada.status,
    exit_code: entrada.exit_code,
    uso: entrada.uso,
  });
  const uso = dados.uso as UsoDeSessao | null;
  const ator = resolverAtor(entrada.ator, ATOR_RUNNER);

  const projeto = db
    .prepare('SELECT projeto_id FROM trabalho WHERE id = ?')
    .get(linha.trabalho_id) as { projeto_id: number } | undefined;

  const fechar = db.transaction((): Sessao => {
    const carimbo = agora();
    db.prepare(
      `UPDATE sessao SET status = ?, exit_code = ?, uso = ?, finalizada_em = ? WHERE id = ?`,
    ).run(
      dados.status as string,
      dados.exit_code as number | null,
      // `uso` ausente grava NULL de verdade, nunca um objeto de zeros.
      uso === null ? null : JSON.stringify(uso),
      carimbo,
      id,
    );

    registrarEvento(db, {
      tipo: 'sessao.finalizada',
      projeto_id: projeto?.projeto_id ?? PROJETO_PADRAO,
      execucao_id: linha.execucao_id,
      entidade: { tipo: 'sessao', id },
      ator,
      ocorrido_em: carimbo,
      dados,
    });

    return paraSessao(lerLinha(db, id) as LinhaSessao);
  });

  return fechar();
}

/**
 * As sessões de uma execução ou de um trabalho (FR12; t107 FR2).
 *
 * O recorte por trabalho existe porque a linha do tempo da tela precisa do FIM
 * das sessões, e `GET /v1/trabalhos/:id/eventos` não o entrega: o payload de
 * `sessao.finalizada` não carrega `trabalho_id`, e o comentário de
 * `src/db/eventos.ts` já dizia para onde mandar quem quer esse fato — "quem
 * quer o fim da sessão pergunta pela sessão". Faltava só por onde perguntar.
 *
 * Os dois filtros se somam em AND: são recortes, não modos.
 *
 * @param db Handle aberto.
 * @param filtro Recortes opcionais por execução e por trabalho.
 * @returns Sessões em ordem de id.
 */
export function listarSessoes(
  db: BancoDeDados,
  filtro: { execucao_id?: number; trabalho_id?: number } = {},
): Sessao[] {
  const condicoes: string[] = [];
  const valores: unknown[] = [];

  if (filtro.execucao_id !== undefined) {
    condicoes.push('execucao_id = ?');
    valores.push(filtro.execucao_id);
  }
  if (filtro.trabalho_id !== undefined) {
    condicoes.push('trabalho_id = ?');
    valores.push(filtro.trabalho_id);
  }

  const onde = condicoes.length === 0 ? '' : `WHERE ${condicoes.join(' AND ')}`;
  const linhas = db
    .prepare(`SELECT ${COLUNAS} FROM sessao ${onde} ORDER BY id`)
    .all(...valores) as LinhaSessao[];
  return linhas.map(paraSessao);
}
