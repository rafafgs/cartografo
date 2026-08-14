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
 * O wiring pergunta → bloqueio → resposta → desbloqueio mora AQUI desde t106, e
 * mora dentro das transações que já existiam: perguntar para o trabalho e o
 * trabalho continuar andando é o estado que ninguém consegue explicar depois.
 * O redespacho da sessão é do outro lado da fronteira (o `Controller` do
 * runner, t103/t106) — ver `docs/spec/escalacao-humana.md`.
 */

import type { BancoDeDados } from '../db/connection.ts';
import { registrarEvento } from '../db/eventos.ts';
import { exigirDadosValidos, type Ator } from '../db/validacao-evento.ts';
import { similaridade } from '../dominio/similaridade.ts';
import {
  ATOR_API,
  ATOR_AUTO_APROVACAO,
  ATOR_ESCALACAO,
  PROJETO_PADRAO,
  agora,
  comoBooleano,
  comoInteiro,
  jsonOuNulo,
  resolverAtor,
} from './comum.ts';
import { bloquearTrabalho, desbloquearTrabalho } from './trabalho.ts';

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
 * Registra o pedido de escalação, grava `pergunta.criada` e BLOQUEIA o trabalho
 * dono na mesma transação (FR13; t106).
 *
 * O bloqueio não é um segundo passo do chamador: quem pergunta é uma sessão que
 * está terminando, e um trabalho que fica candidato a despacho com pergunta
 * pendente é uma sessão nova repetindo a mesma pergunta para sempre. O
 * `db.transaction` aninhado vira savepoint no `better-sqlite3`, então pergunta,
 * evento e bandeira caem juntos ou não caem.
 *
 * A rota não muda de forma: `POST /v1/perguntas` continua devolvendo só a
 * pergunta, e quem quer a bandeira lê `GET /v1/trabalhos/:id`.
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

    // O motivo cita o id da pergunta (mesmo exemplo da taxonomia): quem lê o
    // trabalho descobre pelo próprio motivo o que precisa acontecer para ele
    // voltar a andar.
    bloquearTrabalho(db, trabalhoId, {
      motivo: `aguardando resposta da pergunta ${id}`,
      ator: ATOR_ESCALACAO,
    });

    return paraPergunta(lerLinha(db, id) as LinhaPergunta);
  });

  return criar();
}

/**
 * Fecha uma pergunta com uma resposta, seja de quem for, e DESBLOQUEIA o
 * trabalho que esperava por ela (FR14/FR15; t106).
 *
 * O molde compartilhado por FR14 e FR15: a única coisa que muda entre humano e
 * portão automático é o tipo do evento, o `origem` da projeção e o ator.
 *
 * O desbloqueio reusa o MESMO ator do evento de resposta — `usuario` quando
 * gente respondeu, o portão quando foi automático. A taxonomia pede isso
 * explicitamente para `trabalho.desbloqueado`, e é o que impede a auditoria de
 * concluir que "o sistema" destravou tudo o que um humano destravou.
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

    // Baixa a bandeira que `criarPergunta` levantou. Sem condicional de
    // propósito: o trabalho pode ter sido bloqueado por outra razão junto, e
    // "respondi e o trabalho continuou parado" é o pior desfecho possível para
    // quem acabou de responder. Trabalho inexistente devolve `null` e não faz
    // nada — a pergunta continua respondida.
    desbloquearTrabalho(db, linha.trabalho_id, { ator });

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

/**
 * Um precedente: pergunta já respondida do mesmo projeto, com o quanto ela se
 * parece com a consultada.
 *
 * Carrega a DECISÃO (`resposta`) e a procedência dela (`origem`,
 * `respondido_por`, `respondida_em`), porque é isso que quem está respondendo
 * agora precisa ver: não basta saber que já perguntaram parecido, é preciso
 * saber o que se decidiu, quem decidiu e quando.
 */
export interface Precedente {
  id: number;
  tipo: string;
  pergunta: string;
  resposta: string | null;
  respondido_por: string | null;
  origem: string | null;
  criada_em: string;
  respondida_em: string | null;
  /** Escore em `[0, 1]`, arredondado a 2 casas — ver `dominio/similaridade.ts`. */
  similaridade: number;
}

type LinhaPrecedente = Omit<Precedente, 'similaridade'>;

/** Quantos precedentes voltam quando o chamador não diz. */
const LIMITE_PADRAO_DE_PRECEDENTES = 5;

/** Teto do `limite`: a rota apara, não recusa (é botão de tamanho, não regra). */
const LIMITE_MAXIMO_DE_PRECEDENTES = 20;

const COLUNAS_PRECEDENTE = `
  p.id, p.tipo, p.pergunta, p.resposta, p.respondido_por, p.origem,
  p.criada_em, p.respondida_em
`;

/** Duas casas: o escore é para LER e comparar, não para fazer conta em cima. */
function arredondarEscore(escore: number): number {
  return Math.round(escore * 100) / 100;
}

/**
 * As perguntas já respondidas do mesmo projeto mais parecidas com a de `:id`
 * (t113).
 *
 * O recorte é o projeto de quem pergunta — o `projeto_id` chega pelo `trabalho`
 * dono, o mesmo caminho que `criarPergunta` já percorre. Precedente de outro
 * projeto seria decisão de outro contexto entrando como se fosse história da
 * casa, e é justamente o isolamento que o resto do código já aplica (leases,
 * trabalho).
 *
 * A própria pergunta nunca entra na lista: respondida, ela casaria consigo
 * mesma com escore 1 e ocuparia o topo do próprio ranking para sempre.
 *
 * A varredura é ingênua de propósito: lê todas as respondidas do projeto e
 * pontua em memória. Com o volume da PoC isso é irrelevante, e índice ou cache
 * antes de existir uma base grande seria otimizar contra um problema imaginado
 * — a nota de gotcha da ficha registra quando revisitar.
 *
 * @param db Handle aberto.
 * @param id Id da pergunta consultada (pendente ou não).
 * @param opcoes `limite` de itens; aparado em `[1, 20]`, default 5.
 * @returns Precedentes em ordem de escore, ou `null` se a pergunta não existe.
 */
export function buscarPrecedentes(
  db: BancoDeDados,
  id: number,
  opcoes: { limite?: number } = {},
): Precedente[] | null {
  const alvo = lerLinha(db, id);
  if (alvo === undefined) return null;

  // O projeto de quem pergunta vem do trabalho dono — mesmo caminho de
  // `criarPergunta`. Trabalho ausente é impossível pela FK, e mesmo assim a
  // resposta honesta é "nenhum precedente", nunca um erro.
  const dono = db.prepare('SELECT projeto_id FROM trabalho WHERE id = ?').get(alvo.trabalho_id) as
    | { projeto_id: number }
    | undefined;
  if (dono === undefined) return [];

  const limite = Math.min(
    Math.max(opcoes.limite ?? LIMITE_PADRAO_DE_PRECEDENTES, 1),
    LIMITE_MAXIMO_DE_PRECEDENTES,
  );

  const candidatas = db
    .prepare(
      `SELECT ${COLUNAS_PRECEDENTE}
         FROM pergunta p
         JOIN trabalho t ON t.id = p.trabalho_id
        WHERE p.status = 'respondida'
          AND p.id <> ?
          AND t.projeto_id = ?`,
    )
    .all(id, dono.projeto_id) as LinhaPrecedente[];

  // Empate de escore vai para a decisão mais RECENTE: quando duas decisões
  // antigas se parecem igualmente com a de hoje, a última é a que vale. As
  // datas são ISO 8601, então ordem lexicográfica é ordem cronológica.
  const maisRecente = (a: LinhaPrecedente, b: LinhaPrecedente): number =>
    (b.respondida_em ?? '').localeCompare(a.respondida_em ?? '');

  return candidatas
    .map((linha) => ({ linha, escore: similaridade(alvo.pergunta, linha.pergunta) }))
    .filter((par) => par.escore > 0)
    .sort((a, b) => b.escore - a.escore || maisRecente(a.linha, b.linha))
    .slice(0, limite)
    .map(({ linha, escore }) => ({ ...linha, similaridade: arredondarEscore(escore) }));
}
