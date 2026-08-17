// Reconstrução de estado a partir do log de eventos (t98 FR7).
//
// A prova executável do inegociável de qualidade "reprodutibilidade por event
// sourcing": grafo vN + log ⇒ estado final, sem consultar nenhuma outra fonte.
// Enquanto esta função fecha contra `exemplos/estado-final-esperado.json`, o
// log é suficiente — e no dia em que um tipo de evento novo carregar um fato
// que nenhuma projeção aqui sabe dobrar, este arquivo é onde isso aparece.
//
// Não é o control plane: é a referência do que o control plane vai ter que
// reproduzir quando existir (D6 põe a construção depois desta ficha).

/**
 * Projeções vazias — a forma completa do estado, sempre presente inteira.
 * Um trabalho que nunca aconteceu é um mapa vazio, nunca uma chave ausente.
 */
function estadoVazio() {
  return {
    trabalhos: {},
    sessoes: {},
    perguntas: {},
    leases: {},
    grafo_versao_corrente: {},
  };
}

/** Um trabalho recém-criado, antes de qualquer transição. */
function trabalhoNovo(noEntrada) {
  return { no_atual: noEntrada, bloqueado: false, historico_nos: [noEntrada] };
}

/**
 * Dobra o log e devolve o estado final de tudo que ele descreve.
 *
 * A ordem é a do campo `id` (monotônico, atribuído pelo servidor — FR1), não a
 * ordem em que os eventos chegaram nesta lista: quem lê o log de um arquivo,
 * de uma resposta paginada da API ou de um stream fora de ordem chega no mesmo
 * estado. `ocorrido_em` não serve para isso — dois eventos podem carregar o
 * mesmo carimbo, e só o id é ordenação total.
 *
 * Eventos de tipo desconhecido são ignorados de propósito: um cliente antigo
 * lendo um log novo continua reconstruindo o que entende, que é o que torna a
 * taxonomia extensível de forma aditiva (a regra dos dois consumidores só vai
 * congelar o formato depois).
 *
 * @param {Array<object>} eventos Eventos no formato do envelope.
 * @returns {{trabalhos: object, sessoes: object, perguntas: object, leases: object, grafo_versao_corrente: object}}
 */
export function reconstruirEstado(eventos) {
  const estado = estadoVazio();
  const ordenados = [...eventos].sort((a, b) => a.id - b.id);

  for (const evento of ordenados) {
    const { type, data } = evento;
    const id = evento.entity.id;

    switch (type) {
      // --- trabalho ---------------------------------------------------------
      case 'job.created':
        estado.trabalhos[id] = trabalhoNovo(data.entry_node_id);
        break;

      case 'job.transitioned': {
        const trabalho = estado.trabalhos[id];
        if (!trabalho) break;
        trabalho.no_atual = data.to_node_id;
        trabalho.historico_nos.push(data.to_node_id);
        break;
      }

      case 'job.blocked':
        if (estado.trabalhos[id]) estado.trabalhos[id].bloqueado = true;
        break;

      case 'job.unblocked':
        if (estado.trabalhos[id]) estado.trabalhos[id].bloqueado = false;
        break;

      // `job.amended` é fato de conteúdo, não de fluxo: muda o trabalho,
      // não a posição dele no grafo. Nenhuma projeção daqui se move — e é por
      // isso que ele carrega só os NOMES dos campos alterados.
      case 'job.amended':
        break;

      // --- sessão -----------------------------------------------------------
      // `open`, e não `aberta`: este é o único status que o replay INVENTA (os
      // terminais vêm do `data.status` do evento), e a projeção que ele tem de
      // reproduzir grava `open` desde a t235, que levou os valores do banco
      // para o inglês do glossário. Quem cobra a igualdade é
      // `packages/core/test/replay-consistency.test.ts`.
      case 'session.opened':
        estado.sessoes[id] = { status: 'open', exit_code: null };
        break;

      case 'session.finished':
        estado.sessoes[id] = {
          status: data.status,
          // Ausente e null são a mesma coisa aqui: o engine não reportou
          // código de saída. Nunca colapsar em zero — zero é sucesso.
          exit_code: data.exit_code ?? null,
        };
        break;

      // `session.permission_denied` é incidente, não desfecho: a sessão continua
      // exatamente onde estava, e nenhuma projeção daqui se move. Está listado
      // em vez de cair no `default` porque a diferença entre "ignorado de
      // propósito" e "esquecido" é justamente o que este arquivo existe para
      // registrar. Quem quiser contar negações lê o log, que não perde nada.
      case 'session.permission_denied':
        break;

      // --- pergunta ---------------------------------------------------------
      case 'input_request.created':
        estado.perguntas[id] = { status: 'pending', resposta: null, origem: null };
        break;

      // Os dois tipos abaixo colapsam de volta no `answer_source` user/auto do
      // flowpilot: no log a origem é o tipo do evento, na projeção volta a ser
      // um campo, porque quem lê estado quer comparar, não classificar.
      case 'input_request.answered':
        estado.perguntas[id] = {
          status: 'answered',
          resposta: data.answer,
          origem: 'user',
        };
        break;

      case 'input_request.auto_resolved':
        estado.perguntas[id] = {
          status: 'answered',
          resposta: data.answer,
          origem: 'auto',
        };
        break;

      // --- lease ------------------------------------------------------------
      case 'lease.granted':
        estado.leases[id] = { status: 'ativa' };
        break;

      case 'lease.expired':
        estado.leases[id] = { status: 'expirada' };
        break;

      // --- versão de grafo --------------------------------------------------
      // Registrar NÃO move o ponteiro: uma versão pode existir no banco sem
      // nunca ter valido (D15 — aplicar é um ato separado, e é o que move).
      case 'graph_version.registered':
        break;

      case 'graph_version.applied':
        estado.grafo_versao_corrente[data.graph_id] = id;
        break;

      // Rollback move o ponteiro de volta e não apaga nada: a versão
      // abandonada continua no log e no banco, com a telemetria dela.
      case 'graph_version.reverted':
        estado.grafo_versao_corrente[data.graph_id] = data.target_version;
        break;

      default:
        break;
    }
  }

  return estado;
}

export default reconstruirEstado;
