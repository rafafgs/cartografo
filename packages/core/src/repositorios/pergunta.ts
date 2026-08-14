/**
 * Repositório da pergunta — escalação humana como entidade de primeira classe.
 *
 * Pergunta e aprovação são o mesmo animal; o campo `tipo` é a única diferença.
 * E a ORIGEM da resposta é o TIPO DO EVENTO (`pergunta.respondida` vs
 * `pergunta.auto_resolvida`), não uma coluna do log: a auditoria de "isto foi
 * aprovado por gente ou pelo sistema?" tem que sobreviver a alguém alterar uma
 * linha de projeção. Na projeção a origem volta a ser campo, porque quem lê
 * estado quer comparar, não classificar.
 *
 * O que este arquivo NÃO faz, de propósito: bloquear o trabalho ao criar a
 * pergunta. Esse wiring (pergunta → bloqueio → resposta → desbloqueio →
 * retomada da sessão) é o critério de aceite central de t106; antecipá-lo aqui
 * criaria dois donos para o mesmo ciclo.
 */

import type { BancoDeDados } from '../db/connection.ts';
import { registrarEvento } from '../db/eventos.ts';
import { exigirDadosValidos, type Ator } from '../db/validacao-evento.ts';
import {
  ATOR_API,
  ATOR_AUTO_APROVACAO,
  PROJETO_PADRAO,
  agora,
  comoBooleano,
  comoInteiro,
  jsonOuNulo,
  resolverAtor,
} from './comum.ts';

/** Projeção da pergunta, como a API a devolve. */
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

interface LinhaPergunta extends Omit<Pergunta, 'opcoes' | 'auto_aprovavel'> {
  opcoes: string | null;
  auto_aprovavel: number;
}

const COLUNAS = `
  id, trabalho_id, sessao_id, execucao_id, tipo, pergunta, contexto, opcoes,
  recomendacao, resposta_padrao, auto_aprovavel, status, resposta,
  respondido_por, origem, criada_em, respondida_em
`;

function paraPergunta(linha: LinhaPergunta): Pergunta {
  return {
    ...linha,
    opcoes: jsonOuNulo<string[]>(linha.opcoes),
    auto_aprovavel: comoBooleano(linha.auto_aprovavel),
  };
}

function lerLinha(db: BancoDeDados, id: number): LinhaPergunta | undefined {
  return db.prepare(`SELECT ${COLUNAS} FROM pergunta WHERE id = ?`).get(id) as
    | LinhaPergunta
    | undefined;
}

/**
 * Busca uma pergunta pela projeção.
 *
 * @param db Handle aberto.
 * @param id Id da pergunta.
 * @returns A pergunta, ou `null` se não existe.
 */
export function buscarPergunta(db: BancoDeDados, id: number): Pergunta | null {
  const linha = lerLinha(db, id);
  return linha === undefined ? null : paraPergunta(linha);
}

/** Corpo de `POST /v1/perguntas`. */
export interface EntradaCriarPergunta {
  trabalho_id?: unknown;
  sessao_id?: unknown;
  tipo?: unknown;
  pergunta?: unknown;
  contexto?: unknown;
  opcoes?: unknown;
  recomendacao?: unknown;
  resposta_padrao?: unknown;
  auto_aprovavel?: unknown;
  ator?: unknown;
}

/**
 * Registra o pedido de escalação e grava `pergunta.criada` (FR13).
 *
 * @param db Handle aberto.
 * @param entrada Corpo da requisição.
 * @returns A pergunta pendente, ou `null` se o trabalho não existe.
 * @throws {ErroDeValidacao} Quando falta campo obrigatório.
 */
export function criarPergunta(
  db: BancoDeDados,
  entrada: EntradaCriarPergunta,
): Pergunta | null {
  const dados = exigirDadosValidos('pergunta.criada', {
    trabalho_id: entrada.trabalho_id,
    sessao_id: entrada.sessao_id,
    tipo: entrada.tipo,
    pergunta: entrada.pergunta,
    contexto: entrada.contexto,
    opcoes: entrada.opcoes,
    recomendacao: entrada.recomendacao,
    resposta_padrao: entrada.resposta_padrao,
    auto_aprovavel: entrada.auto_aprovavel,
  });

  const trabalhoId = dados.trabalho_id as number;
  const dono = db
    .prepare('SELECT projeto_id, execucao_id FROM trabalho WHERE id = ?')
    .get(trabalhoId) as { projeto_id: number; execucao_id: number | null } | undefined;
  if (dono === undefined) return null;

  const opcoes = dados.opcoes as string[] | null;
  const ator = resolverAtor(entrada.ator, ATOR_API);

  const criar = db.transaction((): Pergunta => {
    const carimbo = agora();
    const resultado = db
      .prepare(
        `INSERT INTO pergunta (
           trabalho_id, sessao_id, execucao_id, tipo, pergunta, contexto, opcoes,
           recomendacao, resposta_padrao, auto_aprovavel, status, resposta,
           respondido_por, origem, criada_em, respondida_em
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', NULL, NULL, NULL, ?, NULL)`,
      )
      .run(
        trabalhoId,
        dados.sessao_id as number | null,
        dono.execucao_id,
        dados.tipo as string,
        dados.pergunta as string,
        dados.contexto as string | null,
        opcoes === null ? null : JSON.stringify(opcoes),
        dados.recomendacao as string | null,
        dados.resposta_padrao as string | null,
        comoInteiro(dados.auto_aprovavel as boolean),
        carimbo,
      );

    const id = Number(resultado.lastInsertRowid);
    registrarEvento(db, {
      tipo: 'pergunta.criada',
      projeto_id: dono.projeto_id,
      execucao_id: dono.execucao_id,
      entidade: { tipo: 'pergunta', id },
      ator,
      ocorrido_em: carimbo,
      dados,
    });

    return paraPergunta(lerLinha(db, id) as LinhaPergunta);
  });

  return criar();
}

/**
 * Fecha uma pergunta com uma resposta, seja de quem for.
 *
 * O molde compartilhado por FR14 e FR15: a única coisa que muda entre humano e
 * portão automático é o tipo do evento, o `origem` da projeção e o ator.
 */
function responder(
  db: BancoDeDados,
  id: number,
  tipo: 'pergunta.respondida' | 'pergunta.auto_resolvida',
  origem: 'usuario' | 'auto',
  brutos: Record<string, unknown>,
  respondidoPor: string | null,
  ator: Ator,
): Pergunta | null {
  const linha = lerLinha(db, id);
  if (linha === undefined) return null;

  const dados = exigirDadosValidos(tipo, brutos);

  const dono = db.prepare('SELECT projeto_id FROM trabalho WHERE id = ?').get(linha.trabalho_id) as
    | { projeto_id: number }
    | undefined;

  const fechar = db.transaction((): Pergunta => {
    const carimbo = agora();
    db.prepare(
      `UPDATE pergunta
          SET status = 'respondida', resposta = ?, respondido_por = ?, origem = ?, respondida_em = ?
        WHERE id = ?`,
    ).run(dados.resposta as string, respondidoPor, origem, carimbo, id);

    registrarEvento(db, {
      tipo,
      projeto_id: dono?.projeto_id ?? PROJETO_PADRAO,
      execucao_id: linha.execucao_id,
      entidade: { tipo: 'pergunta', id },
      ator,
      ocorrido_em: carimbo,
      dados,
    });

    return paraPergunta(lerLinha(db, id) as LinhaPergunta);
  });

  return fechar();
}

/** Corpo de `PATCH /v1/perguntas/:id/resposta`. */
export interface EntradaResposta {
  resposta?: unknown;
  respondido_por?: unknown;
  ator?: unknown;
}

/**
 * Registra a resposta do humano (FR14).
 *
 * O ator default é o próprio `respondido_por`: `ator.ref` e o campo do payload
 * são redundantes POR DESENHO — a auditoria de "o que foi perguntado,
 * respondido, quando e por quem" tem que sobreviver a uma leitura só do
 * payload.
 *
 * @param db Handle aberto.
 * @param id Id da pergunta.
 * @param entrada Corpo da requisição.
 * @returns A pergunta respondida, ou `null` se não existe.
 */
export function responderPergunta(
  db: BancoDeDados,
  id: number,
  entrada: EntradaResposta,
): Pergunta | null {
  const respondidoPor =
    typeof entrada.respondido_por === 'string' ? entrada.respondido_por : null;
  const ator = resolverAtor(entrada.ator, {
    tipo: 'usuario',
    ref: respondidoPor ?? 'desconhecido',
  });

  return responder(
    db,
    id,
    'pergunta.respondida',
    'usuario',
    { resposta: entrada.resposta, respondido_por: entrada.respondido_por },
    respondidoPor,
    ator,
  );
}

/** Corpo de `PATCH /v1/perguntas/:id/auto_resolucao`. */
export interface EntradaAutoResolucao {
  resposta?: unknown;
  baseada_em?: unknown;
  ator?: unknown;
}

/**
 * Registra a resposta dada pelo portão de auto-aprovação em nome do humano (FR15).
 *
 * `baseada_em` é enum fechado (`recomendacao`/`resposta_padrao`/`precedente`):
 * uma auto-aprovação que não sabe dizer de onde tirou a resposta é uma decisão
 * sem rastro, e a escada de segurança da evolução depende exatamente desse
 * rastro.
 *
 * @param db Handle aberto.
 * @param id Id da pergunta.
 * @param entrada Corpo da requisição.
 * @returns A pergunta respondida, ou `null` se não existe.
 */
export function autoResolverPergunta(
  db: BancoDeDados,
  id: number,
  entrada: EntradaAutoResolucao,
): Pergunta | null {
  return responder(
    db,
    id,
    'pergunta.auto_resolvida',
    'auto',
    { resposta: entrada.resposta, baseada_em: entrada.baseada_em },
    ATOR_AUTO_APROVACAO.ref,
    resolverAtor(entrada.ator, ATOR_AUTO_APROVACAO),
  );
}

/**
 * A fila de perguntas de uma execução (FR16).
 *
 * Devolve a pergunta INTEIRA — contexto, opções, recomendação e resposta
 * padrão. O critério é o do enunciado: quem responde tem que conseguir decidir
 * sem abrir o repositório.
 *
 * @param db Handle aberto.
 * @param filtro Recortes opcionais por status e execução.
 * @returns Perguntas em ordem de id.
 */
export function listarPerguntas(
  db: BancoDeDados,
  filtro: { status?: string; execucao_id?: number } = {},
): Pergunta[] {
  const condicoes: string[] = [];
  const valores: unknown[] = [];

  if (filtro.status !== undefined) {
    condicoes.push('status = ?');
    valores.push(filtro.status);
  }
  if (filtro.execucao_id !== undefined) {
    condicoes.push('execucao_id = ?');
    valores.push(filtro.execucao_id);
  }

  const onde = condicoes.length === 0 ? '' : `WHERE ${condicoes.join(' AND ')}`;
  const linhas = db
    .prepare(`SELECT ${COLUNAS} FROM pergunta ${onde} ORDER BY id`)
    .all(...valores) as LinhaPergunta[];
  return linhas.map(paraPergunta);
}
