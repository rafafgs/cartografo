/**
 * Rotas de lease (t103, FR5–FR9) — a fila de despacho da D5, vista do server.
 *
 * Quatro verbos cobrem o ciclo inteiro: pedir, bater heartbeat, liberar e olhar.
 * O ciclo de vida é o mesmo em todos os caminhos — `ativa` → `liberada` (o dono
 * terminou) ou `ativa` → `expirada` (o dono calou) — e nenhuma linha some.
 *
 * Duas escolhas de contrato que valem explicar:
 *
 * - **Recusa não é erro.** Teto batido e trabalho já com dono devolvem `200`
 *   com `{lease: null, motivo}`, não `409`. Do ponto de vista do runner isso é
 *   "agora não, tenta o próximo", e é o caso comum de um pool saudável — não a
 *   exceção. Erro fica para o que é erro: corpo inválido (`400`), runner
 *   desconhecido (`404`), heartbeat/liberação sobre lease que não está mais
 *   ativa (`409`).
 * - **Reconciliar é parte de pedir**, nunca uma varredura à parte (FR9): quem
 *   pede trabalho é quem descobre que uma lease morreu, na mesma transação em
 *   que a substitui. Uma rota de varredura independente só faz sentido quando
 *   houver consumidor concreto (a tela, um projeto com runners todos ociosos).
 *
 * `trabalho_id` é inteiro opaco aqui: a tabela `trabalho` é do t102 e esta rota
 * não a lê. Quem filtra elegibilidade é o controller, por `GET /v1/trabalhos`.
 */

import type { FastifyInstance } from 'fastify';

import type { BancoDeDados } from '../db/connection.ts';
import {
  buscarLease,
  concederLease,
  liberarLease,
  listarLeases,
  renovarLease,
  type FiltrosDeLease,
  type StatusDeLease,
} from '../repositorios/leases.ts';
import { buscarRunner } from '../repositorios/runners.ts';

interface ParametroId {
  Params: { id: string };
}

interface ConsultaDeLista {
  Querystring: { projeto_id?: string; runner_id?: string; status?: string };
}

const STATUS_VALIDOS: StatusDeLease[] = ['ativa', 'liberada', 'expirada'];

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function ehInteiro(valor: unknown): valor is number {
  return typeof valor === 'number' && Number.isInteger(valor);
}

/** Resolve o `:id` da rota; id não numérico é 404, não 500. */
function idDaRota(bruto: string): number | undefined {
  const numero = Number(bruto);
  return Number.isInteger(numero) ? numero : undefined;
}

/**
 * Registra as rotas de lease no escopo recebido (já com o prefixo /v1).
 *
 * @param app Escopo do Fastify.
 * @param db Banco já aberto; as rotas nunca abrem o seu (D1).
 * @param opcoes Relógio injetável, repassado aos repositórios. Em produção fica
 *   vazio; existe para os testes de expiração controlarem o tempo sem `sleep`.
 */
export function registrarLeases(
  app: FastifyInstance,
  db: BancoDeDados,
  opcoes: { agora?: () => string } = {},
): void {
  app.post('/leases', async (requisicao, resposta) => {
    const corpo = ehObjeto(requisicao.body) ? requisicao.body : {};

    const runnerId = corpo.runner_id;
    if (typeof runnerId !== 'string' || runnerId.trim() === '') {
      resposta.code(400);
      return { erro: 'corpo_invalido', campo: 'runner_id' };
    }

    for (const campo of ['projeto_id', 'trabalho_id', 'teto_runner', 'teto_projeto'] as const) {
      if (!ehInteiro(corpo[campo])) {
        resposta.code(400);
        return { erro: 'corpo_invalido', campo, mensagem: `${campo} precisa ser inteiro` };
      }
    }

    if (!ehInteiro(corpo.ttl_segundos) || corpo.ttl_segundos <= 0) {
      resposta.code(400);
      return {
        erro: 'corpo_invalido',
        campo: 'ttl_segundos',
        mensagem: 'ttl_segundos precisa ser inteiro positivo: lease sem prazo não expira',
      };
    }

    // Lease é direito de um runner pareado. Um id desconhecido não é recusa de
    // capacidade — é um runner que não existe para o control plane.
    if (buscarRunner(db, runnerId) === undefined) {
      resposta.code(404);
      return { erro: 'runner_desconhecido', runner_id: runnerId };
    }

    const resultado = concederLease(
      db,
      {
        runner_id: runnerId,
        projeto_id: corpo.projeto_id as number,
        trabalho_id: corpo.trabalho_id as number,
        teto_runner: corpo.teto_runner as number,
        teto_projeto: corpo.teto_projeto as number,
        ttl_segundos: corpo.ttl_segundos,
      },
      opcoes,
    );

    if (resultado.lease === null) return resultado;

    resposta.code(201);
    return { lease: resultado.lease };
  });

  app.post<ParametroId>('/leases/:id/heartbeats', async (requisicao, resposta) => {
    const id = idDaRota(requisicao.params.id);
    const lease = id === undefined ? undefined : buscarLease(db, id);
    if (lease === undefined) {
      resposta.code(404);
      return { erro: 'lease_desconhecida', id: requisicao.params.id };
    }

    if (lease.status !== 'ativa') {
      resposta.code(409);
      return {
        erro: 'lease_nao_ativa',
        mensagem: `só lease ativa recebe heartbeat; esta está "${lease.status}"`,
        status: lease.status,
      };
    }

    const corpo = ehObjeto(requisicao.body) ? requisicao.body : {};
    const ttl = corpo.ttl_segundos;
    if (ttl !== undefined && (!ehInteiro(ttl) || ttl <= 0)) {
      resposta.code(400);
      return { erro: 'corpo_invalido', campo: 'ttl_segundos' };
    }

    return { lease: renovarLease(db, { id: lease.id, ttl_segundos: ttl }, opcoes) };
  });

  app.post<ParametroId>('/leases/:id/liberacoes', async (requisicao, resposta) => {
    const id = idDaRota(requisicao.params.id);
    const lease = id === undefined ? undefined : buscarLease(db, id);
    if (lease === undefined) {
      resposta.code(404);
      return { erro: 'lease_desconhecida', id: requisicao.params.id };
    }

    if (lease.status !== 'ativa') {
      resposta.code(409);
      return {
        erro: 'lease_nao_ativa',
        mensagem: `só lease ativa pode ser liberada; esta está "${lease.status}"`,
        status: lease.status,
      };
    }

    return { lease: liberarLease(db, lease.id, opcoes) };
  });

  app.get<ConsultaDeLista>('/leases', async (requisicao, resposta) => {
    const { projeto_id: projeto, runner_id: runner, status } = requisicao.query;
    const filtros: FiltrosDeLease = {};

    if (projeto !== undefined) {
      const numero = Number(projeto);
      if (!Number.isInteger(numero)) {
        resposta.code(400);
        return { erro: 'filtro_invalido', campo: 'projeto_id' };
      }
      filtros.projeto_id = numero;
    }

    if (runner !== undefined) filtros.runner_id = runner;

    if (status !== undefined) {
      if (!STATUS_VALIDOS.includes(status as StatusDeLease)) {
        resposta.code(400);
        return { erro: 'filtro_invalido', campo: 'status', esperado: STATUS_VALIDOS };
      }
      filtros.status = status as StatusDeLease;
    }

    return { leases: listarLeases(db, filtros) };
  });
}
