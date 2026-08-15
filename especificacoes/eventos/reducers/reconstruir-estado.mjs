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
    const { tipo, dados } = evento;
    const id = evento.entidade.id;

    switch (tipo) {
      // --- trabalho ---------------------------------------------------------
      case 'trabalho.criado':
        estado.trabalhos[id] = trabalhoNovo(dados.no_entrada_id);
        break;

      case 'trabalho.transicao': {
        const trabalho = estado.trabalhos[id];
        if (!trabalho) break;
        trabalho.no_atual = dados.para_no_id;
        trabalho.historico_nos.push(dados.para_no_id);
        break;
      }

      case 'trabalho.bloqueado':
        if (estado.trabalhos[id]) estado.trabalhos[id].bloqueado = true;
        break;

      case 'trabalho.desbloqueado':
        if (estado.trabalhos[id]) estado.trabalhos[id].bloqueado = false;
        break;

      // `trabalho.emendado` é fato de conteúdo, não de fluxo: muda o trabalho,
      // não a posição dele no grafo. Nenhuma projeção daqui se move — e é por
      // isso que ele carrega só os NOMES dos campos alterados.
      case 'trabalho.emendado':
        break;

      // --- sessão -----------------------------------------------------------
      case 'sessao.aberta':
        estado.sessoes[id] = { status: 'aberta', exit_code: null };
        break;

      case 'sessao.finalizada':
        estado.sessoes[id] = {
          status: dados.status,
          // Ausente e null são a mesma coisa aqui: o engine não reportou
          // código de saída. Nunca colapsar em zero — zero é sucesso.
          exit_code: dados.exit_code ?? null,
        };
        break;

      // `sessao.permissao_negada` é incidente, não desfecho: a sessão continua
      // exatamente onde estava, e nenhuma projeção daqui se move. Está listado
      // em vez de cair no `default` porque a diferença entre "ignorado de
      // propósito" e "esquecido" é justamente o que este arquivo existe para
      // registrar. Quem quiser contar negações lê o log, que não perde nada.
      case 'sessao.permissao_negada':
        break;

      // --- pergunta ---------------------------------------------------------
      case 'pergunta.criada':
        estado.perguntas[id] = { status: 'pendente', resposta: null, origem: null };
        break;

      // Os dois tipos abaixo colapsam de volta no `answer_source` user/auto do
      // flowpilot: no log a origem é o tipo do evento, na projeção volta a ser
      // um campo, porque quem lê estado quer comparar, não classificar.
      case 'pergunta.respondida':
        estado.perguntas[id] = {
          status: 'respondida',
          resposta: dados.resposta,
          origem: 'usuario',
        };
        break;

      case 'pergunta.auto_resolvida':
        estado.perguntas[id] = {
          status: 'respondida',
          resposta: dados.resposta,
          origem: 'auto',
        };
        break;

      // --- lease ------------------------------------------------------------
      case 'lease.concedida':
        estado.leases[id] = { status: 'ativa' };
        break;

      case 'lease.expirada':
        estado.leases[id] = { status: 'expirada' };
        break;

      // --- versão de grafo --------------------------------------------------
      // Registrar NÃO move o ponteiro: uma versão pode existir no banco sem
      // nunca ter valido (D15 — aplicar é um ato separado, e é o que move).
      case 'grafo_versao.registrada':
        break;

      case 'grafo_versao.aplicada':
        estado.grafo_versao_corrente[dados.grafo_id] = id;
        break;

      // Rollback move o ponteiro de volta e não apaga nada: a versão
      // abandonada continua no log e no banco, com a telemetria dela.
      case 'grafo_versao.revertida':
        estado.grafo_versao_corrente[dados.grafo_id] = dados.versao_alvo;
        break;

      default:
        break;
    }
  }

  return estado;
}

export default reconstruirEstado;
