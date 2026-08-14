/**
 * As cinco views da tela, renderizadas no servidor (t107, FR5–FR8, FR10).
 *
 * Sem framework, sem bundler, sem passo de build: cada página é montada no
 * request, a partir do que `cliente.ts` acabou de ler da API pública. É uma
 * escolha de ESCALA, não de gosto — a tela é um cliente HTTP de leitura com um
 * formulário, e um pipeline de front-end aqui custaria mais manutenção do que
 * a coisa toda que ele serviria. O único JavaScript que vai ao navegador são as
 * oito linhas que copiam uma opção para o campo de resposta; sem ele, o
 * formulário continua funcionando por digitação.
 *
 * ## Os marcadores `data-*` são contrato
 *
 * `data-no-atual`, `data-trabalho`, `data-execucao`, `data-campo`,
 * `data-sessao`, `data-pergunta` e `data-segmento` existem para que os testes
 * de aceite possam afirmar sobre ESTRUTURA — o que está dentro de qual grupo,
 * em que ordem — sem congelar a marcação inteira. Estão documentados em
 * `docs/spec/tela.md`; mudar um deles é mudar o contrato, não o CSS.
 *
 * ## Escapar não é detalhe
 *
 * Título de trabalho, texto de pergunta e motivo de bloqueio são dados de fora,
 * gravados por uma API que ainda não tem autenticação (t124). Tudo o que entra
 * em HTML passa por `escapar`, sem exceção.
 */

import type { ClienteApi, Pergunta, ResumoDeExecucao, Sessao, Trabalho } from './cliente.ts';
import { montarLinhaDoTempo, type LinhaDoTempo, type Segmento } from './linha-do-tempo.ts';

/** Uma página pronta para ir ao navegador. */
export interface Pagina {
  status: number;
  html: string;
}

/**
 * Quem consta como autor de uma resposta enquanto não há autenticação (t124).
 *
 * Honesto de propósito: registrar "tela" é dizer que a resposta veio por esta
 * porta, o que é tudo o que o sistema realmente sabe. Inventar um usuário seria
 * pior do que admitir a lacuna — o evento `pergunta.respondida` é auditoria.
 */
export const RESPONDIDO_POR_PADRAO = 'tela';

const ESTILO = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 1.5rem 2rem 4rem; }
  header.topo { display: flex; align-items: baseline; gap: 1.5rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
  header.topo h1 { font-size: 1.1rem; margin: 0; letter-spacing: .02em; }
  nav a { margin-right: 1rem; }
  h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .08em; opacity: .7; margin: 1.75rem 0 .6rem; }
  .quadro { display: flex; gap: 1rem; align-items: flex-start; flex-wrap: wrap; }
  .grupo { flex: 1 1 16rem; min-width: 15rem; }
  .cartao { border: 1px solid currentColor; border-radius: 6px; padding: .6rem .7rem; margin-bottom: .5rem; opacity: .95; }
  .cartao .id { font-size: .75rem; opacity: .6; }
  .bloqueado { border-width: 2px; }
  .motivo { font-size: .8rem; margin-top: .35rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid currentColor; font-variant-numeric: tabular-nums; }
  th { font-size: .75rem; text-transform: uppercase; letter-spacing: .06em; opacity: .7; }
  .pergunta { border: 1px solid currentColor; border-radius: 6px; padding: .8rem 1rem; margin-bottom: 1rem; max-width: 52rem; }
  .pergunta dl { display: grid; grid-template-columns: max-content 1fr; gap: .2rem .8rem; margin: .5rem 0; font-size: .9rem; }
  .pergunta dt { opacity: .6; }
  .pergunta dd { margin: 0; }
  form textarea { width: 100%; min-height: 3.5rem; font: inherit; padding: .4rem; }
  form .opcoes { display: flex; gap: .4rem; flex-wrap: wrap; margin: .4rem 0; }
  .linha-do-tempo { list-style: none; padding: 0; max-width: 52rem; }
  .segmento { display: grid; grid-template-columns: 11rem 1fr; gap: .8rem; padding: .35rem 0; border-bottom: 1px solid currentColor; }
  .segmento .balde { font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; }
  .vazio { opacity: .6; font-style: italic; }
`;

/** Tudo o que entra em HTML passa por aqui. Sem exceção. */
export function escapar(valor: unknown): string {
  return String(valor)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** A casca comum: mesma navegação em toda página, para não haver beco sem saída. */
function layout(titulo: string, corpo: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapar(titulo)} · cartografo</title>
<style>${ESTILO}</style>
</head>
<body>
<header class="topo">
  <h1>cartografo</h1>
  <nav>
    <a href="/">quadro</a>
    <a href="/execucoes">execuções</a>
    <a href="/perguntas">perguntas</a>
  </nav>
</header>
${corpo}
</body>
</html>
`;
}

/** Duração legível: o que interessa é a ordem de grandeza, não o milissegundo. */
export function formatarDuracao(ms: number | null): string {
  if (ms === null) return 'em aberto';
  if (ms < 1000) return `${ms}ms`;
  const segundos = Math.round(ms / 1000);
  if (segundos < 90) return `${segundos}s`;
  const minutos = Math.round(segundos / 60);
  if (minutos < 90) return `${minutos}min`;
  const horas = Math.floor(minutos / 60);
  const resto = minutos % 60;
  if (horas < 48) return resto === 0 ? `${horas}h` : `${horas}h ${resto}min`;
  return `${Math.floor(horas / 24)}d ${horas % 24}h`;
}

function cartaoDeTrabalho(trabalho: Trabalho): string {
  const classes = trabalho.bloqueado ? 'cartao bloqueado' : 'cartao';
  const motivo =
    trabalho.bloqueado && trabalho.motivo_bloqueio !== null
      ? `<p class="motivo">⛔ ${escapar(trabalho.motivo_bloqueio)}</p>`
      : trabalho.bloqueado
        ? '<p class="motivo">⛔ bloqueado, sem motivo declarado</p>'
        : '';
  return `<article class="${classes}" data-trabalho="${trabalho.id}">
      <div class="id">#${trabalho.id}</div>
      <a href="/trabalhos/${trabalho.id}">${escapar(trabalho.titulo)}</a>
      ${motivo}
    </article>`;
}

/**
 * O quadro: uma coluna por nó ocupado, cartões dentro.
 *
 * Agrupar por `no_atual` é o que transforma uma lista em quadro — a pergunta
 * que a tela existe para responder é "onde o trabalho está travando?", e ela só
 * aparece quando as colunas existem. O rótulo é o id CRU do nó: pegar
 * `papel`/`descricao` do snapshot do grafo é aditivo e ficou fora do escopo.
 */
function quadroDeTrabalhos(trabalhos: Trabalho[]): string {
  if (trabalhos.length === 0) return '<p class="vazio">Nenhum trabalho por aqui ainda.</p>';

  const porNo = new Map<string, Trabalho[]>();
  for (const trabalho of trabalhos) {
    const grupo = porNo.get(trabalho.no_atual) ?? [];
    grupo.push(trabalho);
    porNo.set(trabalho.no_atual, grupo);
  }

  const colunas = [...porNo.entries()]
    .sort(([um], [outro]) => um.localeCompare(outro))
    .map(
      ([no, doNo]) => `<section class="grupo" data-no-atual="${escapar(no)}">
    <h2>${escapar(no)} <span class="id">(${doNo.length})</span></h2>
    ${doNo.map(cartaoDeTrabalho).join('\n    ')}
  </section>`,
    );

  return `<div class="quadro">\n  ${colunas.join('\n  ')}\n</div>`;
}

function tabelaDeSessoes(sessoes: Sessao[]): string {
  if (sessoes.length === 0) return '<p class="vazio">Nenhuma sessão nesta execução.</p>';

  const linhas = sessoes.map((sessao) => {
    const uso =
      sessao.uso === null
        ? '—'
        : `${sessao.uso.input_tokens} in / ${sessao.uso.output_tokens} out`;
    return `<tr data-sessao="${sessao.id}">
      <td>#${sessao.id}</td>
      <td>${sessao.trabalho_id === null ? '—' : `<a href="/trabalhos/${sessao.trabalho_id}">#${sessao.trabalho_id}</a>`}</td>
      <td>${escapar(sessao.engine)}</td>
      <td>${escapar(sessao.status)}</td>
      <td>${escapar(sessao.aberta_em)}</td>
      <td>${sessao.finalizada_em === null ? '<span class="vazio">em andamento</span>' : escapar(sessao.finalizada_em)}</td>
      <td>${escapar(uso)}</td>
    </tr>`;
  });

  return `<table>
  <thead><tr><th>sessão</th><th>trabalho</th><th>engine</th><th>status</th><th>aberta em</th><th>finalizada em</th><th>uso</th></tr></thead>
  <tbody>
    ${linhas.join('\n    ')}
  </tbody>
</table>`;
}

/** Uma pergunta em modo leitura — a versão com formulário mora em `/perguntas`. */
function resumoDePergunta(pergunta: Pergunta): string {
  return `<article class="pergunta" data-pergunta="${pergunta.id}">
  <strong>${escapar(pergunta.pergunta)}</strong>
  <p class="motivo">trabalho <a href="/trabalhos/${pergunta.trabalho_id}">#${pergunta.trabalho_id}</a> · desde ${escapar(pergunta.criada_em)} · <a href="/perguntas">responder</a></p>
</article>`;
}

/**
 * A pergunta com o formulário inline.
 *
 * O card carrega TUDO o que a API guardou — contexto, opções, recomendação e
 * resposta padrão — porque o critério é o mesmo de `GET /v1/perguntas`: quem
 * responde tem que conseguir decidir sem abrir o repositório.
 */
function cartaoDePergunta(pergunta: Pergunta): string {
  const campo = (rotulo: string, valor: string | null): string =>
    valor === null || valor === '' ? '' : `<dt>${rotulo}</dt><dd>${escapar(valor)}</dd>`;

  const opcoes =
    pergunta.opcoes === null || pergunta.opcoes.length === 0
      ? ''
      : `<div class="opcoes">${pergunta.opcoes
          .map(
            (opcao) =>
              `<button type="button" data-opcao="${escapar(opcao)}">${escapar(opcao)}</button>`,
          )
          .join('\n      ')}</div>`;

  return `<article class="pergunta" data-pergunta="${pergunta.id}">
  <strong>${escapar(pergunta.pergunta)}</strong>
  <dl>
    <dt>trabalho</dt><dd><a href="/trabalhos/${pergunta.trabalho_id}">#${pergunta.trabalho_id}</a></dd>
    ${campo('criada em', pergunta.criada_em)}
    ${campo('contexto', pergunta.contexto)}
    ${campo('recomendação', pergunta.recomendacao)}
    ${campo('resposta padrão', pergunta.resposta_padrao)}
  </dl>
  <form method="post" action="/perguntas/${pergunta.id}/resposta">
    ${opcoes}
    <textarea name="resposta" required placeholder="a resposta, como você a daria a uma pessoa">${escapar(pergunta.resposta_padrao ?? '')}</textarea>
    <p>
      <label>quem responde <input name="respondido_por" value="${escapar(RESPONDIDO_POR_PADRAO)}"></label>
      <button type="submit">responder</button>
    </p>
  </form>
</article>`;
}

/**
 * O único JavaScript que a tela envia: copiar a opção clicada para o campo.
 *
 * Progressive enhancement de verdade — sem ele, digitar a resposta continua
 * funcionando, e nenhuma outra tela depende de script nenhum.
 */
const SCRIPT_DE_OPCOES = `<script>
document.addEventListener('click', function (evento) {
  var alvo = evento.target;
  if (alvo === null || alvo.dataset === undefined || alvo.dataset.opcao === undefined) return;
  var formulario = alvo.closest('form');
  var campo = formulario === null ? null : formulario.querySelector('textarea[name="resposta"]');
  if (campo !== null) { campo.value = alvo.dataset.opcao; campo.focus(); }
});
</script>`;

function segmentoEmHtml(segmento: Segmento): string {
  const rotulo = segmento.categoria.replaceAll('_', ' ');
  const detalhe = segmento.detalhe === null ? '' : ` — ${escapar(segmento.detalhe)}`;
  const no = segmento.no_id === null ? '' : ` <span class="id">@${escapar(segmento.no_id)}</span>`;
  const fim = segmento.fim === null ? 'agora' : escapar(segmento.fim);
  return `  <li class="segmento" data-segmento="${segmento.categoria}" data-inicio="${escapar(segmento.inicio)}" data-fim="${segmento.fim === null ? '' : escapar(segmento.fim)}">
    <span class="balde">${escapar(rotulo)}</span>
    <span>${escapar(formatarDuracao(segmento.duracao_ms))}${no}${detalhe}<br><span class="id">${escapar(segmento.inicio)} → ${fim}</span></span>
  </li>`;
}

function totaisEmHtml(linha: LinhaDoTempo): string {
  return `<table>
  <thead><tr><th>balde</th><th>tempo fechado</th></tr></thead>
  <tbody>
    <tr><td>fila</td><td>${escapar(formatarDuracao(linha.totais.fila))}</td></tr>
    <tr><td>agente trabalhando</td><td>${escapar(formatarDuracao(linha.totais.agente_trabalhando))}</td></tr>
    <tr><td>esperando humano</td><td>${escapar(formatarDuracao(linha.totais.esperando_humano))}</td></tr>
  </tbody>
</table>`;
}

/**
 * `GET /` — o quadro inteiro (FR5).
 *
 * @param cliente Cliente da API pública.
 * @returns A página do quadro.
 */
export async function paginaQuadro(cliente: ClienteApi): Promise<Pagina> {
  const trabalhos = await cliente.listarTrabalhos();
  return {
    status: 200,
    html: layout(
      'quadro',
      `<h2>quadro · ${trabalhos.length} trabalho(s)</h2>\n${quadroDeTrabalhos(trabalhos)}`,
    ),
  };
}

/**
 * `GET /execucoes` — a lista de rodadas (FR6).
 *
 * @param cliente Cliente da API pública.
 * @returns A página da lista de execuções.
 */
export async function paginaExecucoes(cliente: ClienteApi): Promise<Pagina> {
  const execucoes = await cliente.listarExecucoes();

  const linha = (execucao: ResumoDeExecucao): string => {
    const rotulo =
      execucao.execucao_id === null
        ? '<span class="vazio">sem execução</span>'
        : `<a href="/execucoes/${execucao.execucao_id}">#${execucao.execucao_id}</a>`;
    return `<tr data-execucao="${execucao.execucao_id ?? ''}">
      <td>${rotulo}</td>
      <td data-campo="trabalhos">${execucao.trabalhos}</td>
      <td data-campo="trabalhos_bloqueados">${execucao.trabalhos_bloqueados}</td>
      <td data-campo="perguntas_pendentes">${execucao.perguntas_pendentes}</td>
    </tr>`;
  };

  const corpo =
    execucoes.length === 0
      ? '<p class="vazio">Nenhuma execução ainda.</p>'
      : `<table>
  <thead><tr><th>execução</th><th>trabalhos</th><th>bloqueados</th><th>perguntas pendentes</th></tr></thead>
  <tbody>
    ${execucoes.map(linha).join('\n    ')}
  </tbody>
</table>`;

  return { status: 200, html: layout('execuções', `<h2>execuções</h2>\n${corpo}`) };
}

/**
 * `GET /execucoes/:id` — quadro, sessões e perguntas de uma rodada (FR7).
 *
 * Execução é agrupador opaco, não entidade: uma rodada sem nada responde 200
 * com página vazia, nunca 404 — é a mesma leitura que o control plane já faz em
 * `GET /v1/execucoes/:id/metricas-por-versao`.
 *
 * @param cliente Cliente da API pública.
 * @param execucaoId Id da execução.
 * @returns A página da execução.
 */
export async function paginaExecucao(cliente: ClienteApi, execucaoId: number): Promise<Pagina> {
  const [trabalhos, sessoes, perguntas] = await Promise.all([
    cliente.listarTrabalhos({ execucao_id: execucaoId }),
    cliente.listarSessoes({ execucao_id: execucaoId }),
    cliente.listarPerguntas({ execucao_id: execucaoId, status: 'pendente' }),
  ]);

  const filaDePerguntas =
    perguntas.length === 0
      ? '<p class="vazio">Ninguém esperando resposta nesta execução.</p>'
      : perguntas.map(resumoDePergunta).join('\n');

  return {
    status: 200,
    html: layout(
      `execução ${execucaoId}`,
      `<h2>execução #${execucaoId} · ${trabalhos.length} trabalho(s)</h2>
${quadroDeTrabalhos(trabalhos)}
<h2>sessões</h2>
${tabelaDeSessoes(sessoes)}
<h2>perguntas pendentes</h2>
${filaDePerguntas}`,
    ),
  };
}

/**
 * `GET /perguntas` — o inbox de escalação, com resposta inline (FR8).
 *
 * @param cliente Cliente da API pública.
 * @returns A página da fila de perguntas.
 */
export async function paginaPerguntas(cliente: ClienteApi): Promise<Pagina> {
  const perguntas = await cliente.listarPerguntas({ status: 'pendente' });

  const corpo =
    perguntas.length === 0
      ? '<p class="vazio">Ninguém esperando resposta. 🎉</p>'
      : `${perguntas.map(cartaoDePergunta).join('\n')}\n${SCRIPT_DE_OPCOES}`;

  return {
    status: 200,
    html: layout('perguntas', `<h2>perguntas pendentes · ${perguntas.length}</h2>\n${corpo}`),
  };
}

/**
 * `GET /trabalhos/:id` — a linha do tempo em três baldes (FR10).
 *
 * As três chamadas saem em paralelo e a reconstrução é feita em
 * `linha-do-tempo.ts`; aqui só se desenha o que ela devolveu. O cabeçalho vem
 * de uma quarta leitura, a projeção do trabalho: o título corrente está lá e
 * NÃO no log — `trabalho.emendado` grava só o nome do campo alterado, de modo
 * que reconstruir o título a partir dos eventos daria o título ANTIGO.
 *
 * @param cliente Cliente da API pública.
 * @param trabalhoId Id do trabalho.
 * @returns A página do trabalho, ou 404 quando ele não existe.
 */
export async function paginaTrabalho(cliente: ClienteApi, trabalhoId: number): Promise<Pagina> {
  const [trabalho, eventos, sessoes, perguntas] = await Promise.all([
    cliente.buscarTrabalho(trabalhoId),
    cliente.eventosDoTrabalho(trabalhoId),
    cliente.listarSessoes({ trabalho_id: trabalhoId }),
    cliente.listarPerguntas({ trabalho_id: trabalhoId }),
  ]);

  if (trabalho === null || eventos === null) {
    return paginaDeErro(404, 'trabalho não encontrado', `Não existe trabalho #${trabalhoId}.`);
  }

  const linha = montarLinhaDoTempo({ eventos, sessoes, perguntas });
  const estado = linha.concluido
    ? 'concluído'
    : trabalho.bloqueado
      ? `bloqueado — ${trabalho.motivo_bloqueio ?? 'sem motivo declarado'}`
      : 'em curso';

  const execucao =
    trabalho.execucao_id === null
      ? '<span class="vazio">sem execução</span>'
      : `<a href="/execucoes/${trabalho.execucao_id}">#${trabalho.execucao_id}</a>`;

  const segmentos =
    linha.segmentos.length === 0
      ? '<p class="vazio">Nada aconteceu com este trabalho ainda.</p>'
      : `<ul class="linha-do-tempo">\n${linha.segmentos.map(segmentoEmHtml).join('\n')}\n</ul>`;

  return {
    status: 200,
    html: layout(
      trabalho.titulo,
      `<h2>#${trabalho.id} · ${escapar(trabalho.titulo)}</h2>
<p>nó atual <strong>${escapar(trabalho.no_atual)}</strong> · execução ${execucao} · ${escapar(estado)}</p>
<h2>linha do tempo</h2>
${segmentos}
<h2>totais</h2>
${totaisEmHtml(linha)}`,
    ),
  };
}

/**
 * Uma página de erro — a tela nunca devolve stack trace nem 200 mentiroso.
 *
 * @param status Código HTTP.
 * @param titulo Linha curta do que houve.
 * @param detalhe O que fazer a seguir, quando há o que fazer.
 * @returns A página de erro.
 */
export function paginaDeErro(status: number, titulo: string, detalhe: string): Pagina {
  return {
    status,
    html: layout(
      titulo,
      `<h2>${escapar(titulo)}</h2>\n<p>${escapar(detalhe)}</p>\n<p><a href="/">voltar ao quadro</a></p>`,
    ),
  };
}
