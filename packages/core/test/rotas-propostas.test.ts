/**
 * Testes de aceite das rotas de proposta (t101, FR7/FR8/FR9).
 *
 * Aqui se prova o ciclo inteiro da D15 — aplicar ops → validar soundness no
 * resultado → gravar versão nova → mover ponteiro, e rollback movendo o
 * ponteiro de volta sem apagar nada. Os quatro casos de rejeição (AT14–AT17)
 * reproduzem, por operação semântica, exatamente os quatro contraexemplos do
 * t96: o portão de soundness precisa reprovar a proposta ANTES de a versão
 * nova existir.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type * as ModuloConnection from '../src/db/connection.ts';
import type { DocumentoGrafo, NoGrafo } from '../src/dominio/grafo.ts';
import type * as ModuloHash from '../src/dominio/hash.ts';
import type * as ModuloMigrate from '../src/db/migrate.ts';
import type * as ModuloOperacoes from '../src/dominio/operacoes.ts';
import type * as ModuloServer from '../src/server.ts';

const RAIZ_PACOTE = path.resolve(import.meta.dirname, '..');
const RAIZ_REPO = path.resolve(RAIZ_PACOTE, '..', '..');
const DIR_MIGRACOES = path.join(RAIZ_PACOTE, 'migrations');
const EXEMPLO_MINIMO = path.join(RAIZ_REPO, 'schema', 'exemplos', 'grafo-valido-minimo.json');

interface ContextoDeTeste {
  after: (fn: () => void | Promise<void>) => void;
}

interface LinhaGrafo {
  id: string;
  classe: string;
  versao_corrente_id: string | null;
}

interface LinhaVersao {
  id: string;
  grafo_id: string;
  versao_pai: string | null;
  origem: string;
  proposta_id: number | null;
  criado_em: string;
}

interface LinhaProposta {
  id: number;
  grafo_id: string;
  versao_alvo: string;
  operacoes: unknown[];
  evidencia: unknown;
  metrica_esperada: unknown;
  status: string;
  versao_aplicada_id: string | null;
  motivo_reversao: string | null;
  resultado: unknown;
}

interface RespostaAplicacao {
  erro?: string;
  proposta: LinhaProposta;
  grafo?: LinhaGrafo;
  grafo_versao?: LinhaVersao;
  soundness?: { valido: boolean; violacoes: Array<{ regra: string; alvo: unknown }> };
  estrutura?: { valido: boolean; erros: Array<{ codigo: string; alvo: unknown }> };
}

let cacheConnection: typeof ModuloConnection | null = null;
let cacheMigrate: typeof ModuloMigrate | null = null;
let cacheServer: typeof ModuloServer | null = null;
let cacheHash: typeof ModuloHash | null = null;
let cacheOperacoes: typeof ModuloOperacoes | null = null;

async function carregarConnection(): Promise<typeof ModuloConnection> {
  cacheConnection ??= (await import(
    new URL('../src/db/connection.ts', import.meta.url).href
  )) as typeof ModuloConnection;
  return cacheConnection;
}

async function carregarMigrate(): Promise<typeof ModuloMigrate> {
  cacheMigrate ??= (await import(
    new URL('../src/db/migrate.ts', import.meta.url).href
  )) as typeof ModuloMigrate;
  return cacheMigrate;
}

async function carregarServer(): Promise<typeof ModuloServer> {
  cacheServer ??= (await import(
    new URL('../src/server.ts', import.meta.url).href
  )) as typeof ModuloServer;
  return cacheServer;
}

async function carregarHash(): Promise<typeof ModuloHash> {
  cacheHash ??= (await import(
    new URL('../src/dominio/hash.ts', import.meta.url).href
  )) as typeof ModuloHash;
  return cacheHash;
}

async function carregarOperacoes(): Promise<typeof ModuloOperacoes> {
  cacheOperacoes ??= (await import(
    new URL('../src/dominio/operacoes.ts', import.meta.url).href
  )) as typeof ModuloOperacoes;
  return cacheOperacoes;
}

async function subirApp(t: ContextoDeTeste): Promise<string> {
  assert.ok(
    existsSync(path.join(RAIZ_PACOTE, 'src', 'routes', 'propostas.ts')),
    'artefato ainda não existe: packages/core/src/routes/propostas.ts',
  );
  assert.ok(
    existsSync(path.join(DIR_MIGRACOES, '0002_grafo_versao_proposta.sql')),
    'artefato ainda não existe: packages/core/migrations/0002_grafo_versao_proposta.sql',
  );

  const { abrirBanco, aplicarPragmas } = await carregarConnection();
  const { migrar } = await carregarMigrate();
  const { criarApp } = await carregarServer();

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t101-'));
  const db = abrirBanco(path.join(base, 'cartografo.db'));
  aplicarPragmas(db);
  migrar(db, DIR_MIGRACOES);

  const app = criarApp({ db });
  const endereco = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await app.close();
    db.close();
    rmSync(base, { recursive: true, force: true });
  });

  return endereco;
}

async function postar(endereco: string, rota: string, corpo: unknown): Promise<Response> {
  return fetch(`${endereco}${rota}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  });
}

async function corpoJson<T>(resposta: Response): Promise<T> {
  return (await resposta.json()) as T;
}

function grafoMinimo(): DocumentoGrafo {
  return JSON.parse(readFileSync(EXEMPLO_MINIMO, 'utf8')) as DocumentoGrafo;
}

function exigirNo(doc: DocumentoGrafo, id: string): NoGrafo {
  const no = doc.nos.find((candidato) => candidato.id === id);
  if (no === undefined) throw new Error(`fixture mudou: o nó "${id}" sumiu`);
  return no;
}

/** Registra o grafo base mínimo e devolve a linhagem recém-criada. */
async function registrarBase(
  endereco: string,
): Promise<{ documento: DocumentoGrafo; grafo: LinhaGrafo; versao: LinhaVersao }> {
  const documento = grafoMinimo();
  const resposta = await postar(endereco, '/v1/grafos', documento);
  const corpo = await corpoJson<{ grafo: LinhaGrafo; grafo_versao: LinhaVersao }>(resposta);
  assert.equal(resposta.status, 201, JSON.stringify(corpo));
  return { documento, grafo: corpo.grafo, versao: corpo.grafo_versao };
}

async function pedirGrafo(endereco: string, id: string): Promise<LinhaGrafo> {
  const resposta = await fetch(`${endereco}/v1/grafos/${id}`);
  assert.equal(resposta.status, 200);
  return (await corpoJson<{ grafo: LinhaGrafo }>(resposta)).grafo;
}

const EVIDENCIA = {
  fonte: 'telemetria',
  observacao: 'duas travessias com retrabalho depois da revisão',
};
const METRICA_ESPERADA = { nome: 'retrabalho_por_travessia', direcao: 'cai', de: 0.4, para: 0.1 };

async function criarProposta(
  endereco: string,
  grafoId: string,
  versaoAlvo: string,
  operacoes: ModuloOperacoes.Operacao[],
  metricaEsperada: unknown = METRICA_ESPERADA,
): Promise<LinhaProposta> {
  const resposta = await postar(endereco, '/v1/propostas', {
    grafo_id: grafoId,
    versao_alvo: versaoAlvo,
    operacoes,
    evidencia: EVIDENCIA,
    metrica_esperada: metricaEsperada,
  });
  const corpo = await corpoJson<{ proposta: LinhaProposta }>(resposta);
  assert.equal(resposta.status, 201, JSON.stringify(corpo));
  return corpo.proposta;
}

/** Nó novo, completo o bastante para passar em `no_com_contrato`. */
function noNovo(): NoGrafo {
  return {
    id: 'checar_fatos',
    papel: 'revisor',
    tipo_no: 'trabalho',
    descricao: 'Confere cada afirmação da nota contra a fonte citada.',
    skill_ref: {
      id: 'cartografo/checar-fatos',
      versao: '1.0.0',
      hash: `sha256:${'0'.repeat(64)}`,
    },
    contrato: {
      entrada_schema: {
        type: 'object',
        required: ['texto'],
        properties: { texto: { type: 'string', minLength: 1 } },
      },
      saida_schema: {
        type: 'object',
        required: ['aprovado'],
        properties: { aprovado: { type: 'boolean' } },
      },
      verificacoes: [
        {
          tipo: 'deterministico',
          comando: 'test -s checagem.md',
          descricao: 'O relatório de checagem existe e não está vazio.',
        },
      ],
    },
  };
}

/**
 * Insere `checar_fatos` ENTRE redigir e revisar: uma aresta de entrada (para
 * ser alcançável) e uma de saída (para terminar). São as duas condições que a
 * soundness cobra de qualquer nó novo — por isso a proposta tem duas arestas.
 */
function operacoesQuePassam(): ModuloOperacoes.Operacao[] {
  const no = noNovo();
  return [
    {
      tipo: 'adicionar_no',
      no,
      inversa: { tipo: 'remover_no', no_id: no.id },
    },
    {
      tipo: 'adicionar_aresta',
      aresta: { de: 'redigir', para: no.id, condicao: 'sempre' },
      inversa: { tipo: 'remover_aresta', aresta: { de: 'redigir', para: no.id } },
    },
    {
      tipo: 'adicionar_aresta',
      aresta: { de: no.id, para: 'revisar', condicao: 'sempre' },
      inversa: { tipo: 'remover_aresta', aresta: { de: no.id, para: 'revisar' } },
    },
  ];
}

test('AT11 — aplicar proposta gera versão nova com parent e hash corretos e move o ponteiro', async (t) => {
  const endereco = await subirApp(t);
  const { hashSnapshot } = await carregarHash();
  const { aplicarOperacoes } = await carregarOperacoes();

  const { documento, grafo, versao } = await registrarBase(endereco);
  const operacoes = operacoesQuePassam();
  const proposta = await criarProposta(endereco, grafo.id, versao.id, operacoes);
  assert.equal(proposta.status, 'pendente', 'toda proposta nasce pendente');

  const resposta = await postar(endereco, `/v1/propostas/${proposta.id}/aplicar`, {});
  const corpo = await corpoJson<RespostaAplicacao>(resposta);
  assert.equal(resposta.status, 200, JSON.stringify(corpo));

  const esperado = hashSnapshot(aplicarOperacoes(documento, operacoes));
  assert.ok(corpo.grafo_versao !== undefined);
  assert.equal(corpo.grafo_versao.id, esperado, 'o id da versão é o hash do documento resultante');
  assert.equal(corpo.grafo_versao.versao_pai, versao.id, 'a versão nova aponta para a anterior');
  assert.equal(corpo.grafo_versao.origem, 'proposta');
  assert.equal(corpo.grafo_versao.proposta_id, proposta.id);

  assert.equal(corpo.proposta.status, 'aplicada');
  assert.equal(corpo.proposta.versao_aplicada_id, esperado);

  const depois = await pedirGrafo(endereco, grafo.id);
  assert.equal(depois.versao_corrente_id, esperado, 'o ponteiro precisa ter se movido');

  // O snapshot novo é o documento com as operações aplicadas — não um diff.
  const versaoNova = await fetch(`${endereco}/v1/grafo-versoes/${encodeURIComponent(esperado)}`);
  const corpoVersao = await corpoJson<{ grafo_versao: { snapshot: DocumentoGrafo } }>(versaoNova);
  assert.deepEqual(corpoVersao.grafo_versao.snapshot, aplicarOperacoes(documento, operacoes));
});

test('AT12 — reverter restaura o ponteiro e o histórico continua íntegro', async (t) => {
  const endereco = await subirApp(t);

  const { grafo, versao } = await registrarBase(endereco);
  const proposta = await criarProposta(endereco, grafo.id, versao.id, operacoesQuePassam());

  const aplicacao = await postar(endereco, `/v1/propostas/${proposta.id}/aplicar`, {});
  assert.equal(aplicacao.status, 200);
  const versaoNova = (await corpoJson<RespostaAplicacao>(aplicacao)).grafo_versao;
  assert.ok(versaoNova !== undefined);

  const reversao = await postar(endereco, `/v1/propostas/${proposta.id}/reverter`, {
    motivo: 'o nó novo dobrou o tempo de travessia sem mexer no retrabalho',
  });
  const corpo = await corpoJson<RespostaAplicacao>(reversao);
  assert.equal(reversao.status, 200, JSON.stringify(corpo));
  assert.equal(corpo.proposta.status, 'revertida');
  assert.equal(
    corpo.proposta.motivo_reversao,
    'o nó novo dobrou o tempo de travessia sem mexer no retrabalho',
  );

  const depois = await pedirGrafo(endereco, grafo.id);
  assert.equal(depois.versao_corrente_id, versao.id, 'o ponteiro volta para a versão-alvo');

  const versoes = await corpoJson<{ versoes: LinhaVersao[] }>(
    await fetch(`${endereco}/v1/grafos/${grafo.id}/versoes`),
  );
  assert.deepEqual(
    versoes.versoes.map((linha) => linha.id).sort(),
    [versao.id, versaoNova.id].sort(),
    'append-only: a versão abandonada continua no histórico',
  );

  // E continua recuperável inteira, não só listada.
  const abandonada = await fetch(`${endereco}/v1/grafo-versoes/${encodeURIComponent(versaoNova.id)}`);
  assert.equal(abandonada.status, 200);
});

test('AT13 — reverter sem motivo devolve 400; reverter proposta pendente devolve 409', async (t) => {
  const endereco = await subirApp(t);

  const { grafo, versao } = await registrarBase(endereco);
  const proposta = await criarProposta(endereco, grafo.id, versao.id, operacoesQuePassam());

  const semMotivo = await postar(endereco, `/v1/propostas/${proposta.id}/reverter`, {});
  assert.equal(semMotivo.status, 400);
  assert.equal((await corpoJson<{ erro: string }>(semMotivo)).erro, 'motivo_obrigatorio');

  const motivoVazio = await postar(endereco, `/v1/propostas/${proposta.id}/reverter`, {
    motivo: '   ',
  });
  assert.equal(motivoVazio.status, 400, 'motivo em branco não é evidência');

  const pendente = await postar(endereco, `/v1/propostas/${proposta.id}/reverter`, {
    motivo: 'mudei de ideia',
  });
  assert.equal(pendente.status, 409);
  assert.equal((await corpoJson<{ erro: string }>(pendente)).erro, 'proposta_nao_aplicada');

  const grafoDepois = await pedirGrafo(endereco, grafo.id);
  assert.equal(grafoDepois.versao_corrente_id, versao.id);
});

/**
 * AT14–AT17: um caso por regra de soundness, cada um reproduzindo por operação
 * semântica o contraexemplo homônimo de `schema/exemplos/` (t96).
 */
const CASOS_DE_REJEICAO: Array<{
  at: string;
  contraexemplo: string;
  violacoes: Array<{ regra: string; alvo: unknown }>;
  operacoes: (documento: DocumentoGrafo) => ModuloOperacoes.Operacao[];
}> = [
  {
    at: 'AT14',
    contraexemplo: 'grafo-invalido-no-inalcancavel.json',
    violacoes: [{ regra: 'alcançável', alvo: 'checar_fatos' }],
    operacoes: () => {
      const no = noNovo();
      // Só a aresta de SAÍDA: o nó termina, mas ninguém chega nele.
      return [
        { tipo: 'adicionar_no', no, inversa: { tipo: 'remover_no', no_id: no.id } },
        {
          tipo: 'adicionar_aresta',
          aresta: { de: no.id, para: 'revisar', condicao: 'sempre' },
          inversa: { tipo: 'remover_aresta', aresta: { de: no.id, para: 'revisar' } },
        },
      ];
    },
  },
  {
    at: 'AT15',
    contraexemplo: 'grafo-invalido-sem-terminacao.json',
    violacoes: [{ regra: 'termina', alvo: 'checar_fatos' }],
    operacoes: () => {
      const no = noNovo();
      // Só a aresta de ENTRADA: chega-se ao nó, mas dele não se sai.
      return [
        { tipo: 'adicionar_no', no, inversa: { tipo: 'remover_no', no_id: no.id } },
        {
          tipo: 'adicionar_aresta',
          aresta: { de: 'redigir', para: no.id, condicao: 'sempre' },
          inversa: { tipo: 'remover_aresta', aresta: { de: 'redigir', para: no.id } },
        },
      ];
    },
  },
  {
    at: 'AT16',
    contraexemplo: 'grafo-invalido-aresta-sem-condicao.json',
    violacoes: [{ regra: 'aresta_com_condicao', alvo: { de: 'revisar', para: 'redigir' } }],
    // Ciclo de retrabalho legítimo, mas sem rótulo na transição.
    operacoes: () => [
      {
        tipo: 'adicionar_aresta',
        aresta: { de: 'revisar', para: 'redigir', condicao: '' },
        inversa: { tipo: 'remover_aresta', aresta: { de: 'revisar', para: 'redigir' } },
      },
    ],
  },
  {
    at: 'AT17',
    contraexemplo: 'grafo-invalido-no-sem-contrato.json',
    violacoes: [{ regra: 'no_com_contrato', alvo: 'revisar' }],
    // Contrato esvaziado: sem verificações, o portão não verifica nada.
    operacoes: (documento) => [
      {
        tipo: 'alterar_campo_no',
        no_id: 'revisar',
        campo: 'contrato',
        de: structuredClone(exigirNo(documento, 'revisar').contrato),
        para: {},
        inversa: {
          tipo: 'alterar_campo_no',
          no_id: 'revisar',
          campo: 'contrato',
          de: {},
          para: structuredClone(exigirNo(documento, 'revisar').contrato),
        },
      },
    ],
  },
];

for (const caso of CASOS_DE_REJEICAO) {
  test(`${caso.at} — proposta que reproduz ${caso.contraexemplo} é rejeitada com 422`, async (t) => {
    const endereco = await subirApp(t);

    const { documento, grafo, versao } = await registrarBase(endereco);
    const proposta = await criarProposta(endereco, grafo.id, versao.id, caso.operacoes(documento));

    const resposta = await postar(endereco, `/v1/propostas/${proposta.id}/aplicar`, {});
    const corpo = await corpoJson<RespostaAplicacao>(resposta);
    assert.equal(resposta.status, 422, JSON.stringify(corpo));
    assert.equal(corpo.erro, 'grafo_invalido');
    assert.deepEqual(corpo.soundness?.violacoes, caso.violacoes);
    assert.equal(corpo.proposta.status, 'rejeitada');
    assert.deepEqual(
      (corpo.proposta.resultado as { soundness?: { violacoes: unknown } } | null)?.soundness
        ?.violacoes,
      caso.violacoes,
      'o relatório fica gravado em proposta.resultado',
    );

    const depois = await pedirGrafo(endereco, grafo.id);
    assert.equal(depois.versao_corrente_id, versao.id, 'o ponteiro não pode ter se movido');

    const versoes = await corpoJson<{ versoes: LinhaVersao[] }>(
      await fetch(`${endereco}/v1/grafos/${grafo.id}/versoes`),
    );
    assert.equal(versoes.versoes.length, 1, 'nenhuma versão nova pode ter sido gravada');
  });
}

test('AT18 — proposta cuja versão-alvo deixou de ser a corrente devolve 409', async (t) => {
  const endereco = await subirApp(t);

  const { grafo, versao } = await registrarBase(endereco);
  const primeira = await criarProposta(endereco, grafo.id, versao.id, operacoesQuePassam());
  const segunda = await criarProposta(endereco, grafo.id, versao.id, [
    {
      tipo: 'alterar_campo_no',
      no_id: 'redigir',
      campo: 'papel',
      de: 'redator',
      para: 'red-team',
      inversa: {
        tipo: 'alterar_campo_no',
        no_id: 'redigir',
        campo: 'papel',
        de: 'red-team',
        para: 'redator',
      },
    },
  ]);

  assert.equal((await postar(endereco, `/v1/propostas/${primeira.id}/aplicar`, {})).status, 200);

  const desatualizada = await postar(endereco, `/v1/propostas/${segunda.id}/aplicar`, {});
  assert.equal(desatualizada.status, 409);
  assert.equal(
    (await corpoJson<{ erro: string }>(desatualizada)).erro,
    'proposta_desatualizada',
    'a base mudou debaixo da proposta; resolver isso é do topógrafo (t118)',
  );
});

test('AT19 — aplicar duas vezes a mesma proposta devolve 409 na segunda', async (t) => {
  const endereco = await subirApp(t);

  const { grafo, versao } = await registrarBase(endereco);
  const proposta = await criarProposta(endereco, grafo.id, versao.id, operacoesQuePassam());

  assert.equal((await postar(endereco, `/v1/propostas/${proposta.id}/aplicar`, {})).status, 200);

  const segunda = await postar(endereco, `/v1/propostas/${proposta.id}/aplicar`, {});
  assert.equal(segunda.status, 409);
  assert.equal((await corpoJson<{ erro: string }>(segunda)).erro, 'proposta_nao_pendente');
});

test('FR7 — versão-alvo estranha ao grafo e operação malformada devolvem 400', async (t) => {
  const endereco = await subirApp(t);
  const { grafo, versao } = await registrarBase(endereco);

  const alvoInexistente = await postar(endereco, '/v1/propostas', {
    grafo_id: grafo.id,
    versao_alvo: `sha256:${'1'.repeat(64)}`,
    operacoes: operacoesQuePassam(),
    evidencia: EVIDENCIA,
    metrica_esperada: METRICA_ESPERADA,
  });
  assert.equal(alvoInexistente.status, 400);
  assert.equal((await corpoJson<{ erro: string }>(alvoInexistente)).erro, 'versao_alvo_desconhecida');

  const semInversa = await postar(endereco, '/v1/propostas', {
    grafo_id: grafo.id,
    versao_alvo: versao.id,
    operacoes: [{ tipo: 'adicionar_no', no: noNovo() }],
    evidencia: EVIDENCIA,
    metrica_esperada: METRICA_ESPERADA,
  });
  assert.equal(semInversa.status, 400);
  assert.equal((await corpoJson<{ erro: string }>(semInversa)).erro, 'operacoes_invalidas');

  const tipoDesconhecido = await postar(endereco, '/v1/propostas', {
    grafo_id: grafo.id,
    versao_alvo: versao.id,
    operacoes: [{ tipo: 'renomear_no', no_id: 'redigir', inversa: { tipo: 'renomear_no' } }],
    evidencia: EVIDENCIA,
    metrica_esperada: METRICA_ESPERADA,
  });
  assert.equal(tipoDesconhecido.status, 400);

  const grafoDesconhecido = await postar(endereco, '/v1/propostas', {
    grafo_id: 'nao-existe',
    versao_alvo: versao.id,
    operacoes: operacoesQuePassam(),
    evidencia: EVIDENCIA,
    metrica_esperada: METRICA_ESPERADA,
  });
  assert.equal(grafoDesconhecido.status, 400);

  assert.equal((await postar(endereco, '/v1/propostas/999/aplicar', {})).status, 404);
  assert.equal(
    (await postar(endereco, '/v1/propostas/999/reverter', { motivo: 'x' })).status,
    404,
  );
});

/* -------------------------------------------------------------------------- */
/* t112 — hypothesis outcome: the next run closes the proposal                 */
/*                                                                            */
/* From here down every new identifier and test name is in English (D18/FR9);  */
/* the JSON payload keys and the route segments stay in Portuguese, mirroring  */
/* the API that is already published.                                          */
/* -------------------------------------------------------------------------- */

/** The shape `proposta.resultado` takes once the experiment is closed (FR5). */
interface HypothesisOutcome {
  veredito: string;
  antes: number;
  depois: number;
  execucao_id: number;
  avaliado_em: string;
}

/** Changes a node's `papel`, so each proposal produces a distinct snapshot. */
function roleChange(papel: string): ModuloOperacoes.Operacao[] {
  return [
    {
      tipo: 'alterar_campo_no',
      no_id: 'redigir',
      campo: 'papel',
      de: 'redator',
      para: papel,
      inversa: {
        tipo: 'alterar_campo_no',
        no_id: 'redigir',
        campo: 'papel',
        de: papel,
        para: 'redator',
      },
    },
  ];
}

/**
 * Registers real telemetry under a version, inside an execution.
 *
 * This is the evidence FR3 demands: `metricas-por-versao` (t102, FR17) only
 * sees a version that actually ran because some `trabalho` declared it.
 */
async function recordWorkUnderVersion(
  endereco: string,
  execucaoId: number,
  versaoId: string,
): Promise<void> {
  const resposta = await postar(endereco, '/v1/trabalhos', {
    titulo: 'travessia da rodada seguinte',
    no_entrada_id: 'redigir',
    execucao_id: execucaoId,
    grafo_versao_id: versaoId,
  });
  assert.equal(resposta.status, 201, 'a telemetria da rodada seguinte precisa existir de verdade');
}

/** Applies a proposal and returns the version it wrote. */
async function applyProposal(endereco: string, propostaId: number): Promise<string> {
  const resposta = await postar(endereco, `/v1/propostas/${propostaId}/aplicar`, {});
  const corpo = await corpoJson<RespostaAplicacao>(resposta);
  assert.equal(resposta.status, 200, JSON.stringify(corpo));
  assert.ok(corpo.proposta.versao_aplicada_id !== null);
  return corpo.proposta.versao_aplicada_id;
}

/** The whole prelude of the outcome route: base, applied proposal, telemetry. */
async function appliedProposalWithTelemetry(
  t: ContextoDeTeste,
  opcoes: { execucaoId?: number; metricaEsperada?: unknown } = {},
): Promise<{
  endereco: string;
  grafo: LinhaGrafo;
  versaoAlvo: string;
  proposta: LinhaProposta;
  versaoAplicada: string;
  execucaoId: number;
}> {
  const endereco = await subirApp(t);
  const execucaoId = opcoes.execucaoId ?? 1;

  const { grafo, versao } = await registrarBase(endereco);
  const proposta = await criarProposta(
    endereco,
    grafo.id,
    versao.id,
    operacoesQuePassam(),
    opcoes.metricaEsperada ?? METRICA_ESPERADA,
  );
  const versaoAplicada = await applyProposal(endereco, proposta.id);
  await recordWorkUnderVersion(endereco, execucaoId, versaoAplicada);

  return { endereco, grafo, versaoAlvo: versao.id, proposta, versaoAplicada, execucaoId };
}

/** Reads the listing route, with the querystring already assembled. */
async function listProposals(endereco: string, query = ''): Promise<LinhaProposta[]> {
  const resposta = await fetch(`${endereco}/v1/propostas${query}`);
  const corpo = await corpoJson<{ propostas: LinhaProposta[] }>(resposta);
  assert.equal(resposta.status, 200, JSON.stringify(corpo));
  return corpo.propostas;
}

test('AT20 — a metric that moved in the declared direction closes the hypothesis as confirmada', async (t) => {
  const cenario = await appliedProposalWithTelemetry(t);

  const resposta = await postar(
    cenario.endereco,
    `/v1/propostas/${cenario.proposta.id}/resultado`,
    { execucao_id: cenario.execucaoId, depois: 0.1 },
  );
  const corpo = await corpoJson<RespostaAplicacao>(resposta);
  assert.equal(resposta.status, 200, JSON.stringify(corpo));

  const resultado = corpo.proposta.resultado as HypothesisOutcome;
  assert.equal(resultado.veredito, 'confirmada');
  assert.equal(resultado.antes, 0.4, 'o "antes" é o `de` que a proposta declarou');
  assert.equal(resultado.depois, 0.1);
  assert.equal(resultado.execucao_id, cenario.execucaoId);
  assert.equal(typeof resultado.avaliado_em, 'string');

  assert.equal(corpo.proposta.status, 'aplicada', 'fechar o experimento não muda o estado');
  assert.equal(corpo.proposta.versao_aplicada_id, cenario.versaoAplicada);
});

test('AT21 — a metric that did not move is sem_efeito', async (t) => {
  const cenario = await appliedProposalWithTelemetry(t);

  const resposta = await postar(
    cenario.endereco,
    `/v1/propostas/${cenario.proposta.id}/resultado`,
    { execucao_id: cenario.execucaoId, depois: 0.4 },
  );
  const corpo = await corpoJson<RespostaAplicacao>(resposta);
  assert.equal(resposta.status, 200, JSON.stringify(corpo));
  assert.equal((corpo.proposta.resultado as HypothesisOutcome).veredito, 'sem_efeito');
  assert.equal(corpo.proposta.status, 'aplicada');
});

test('AT22 — a metric that moved the wrong way is piorou, and nothing is reverted', async (t) => {
  const cenario = await appliedProposalWithTelemetry(t);

  const resposta = await postar(
    cenario.endereco,
    `/v1/propostas/${cenario.proposta.id}/resultado`,
    { execucao_id: cenario.execucaoId, depois: 0.9 },
  );
  const corpo = await corpoJson<RespostaAplicacao>(resposta);
  assert.equal(resposta.status, 200, JSON.stringify(corpo));
  assert.equal((corpo.proposta.resultado as HypothesisOutcome).veredito, 'piorou');

  // "piorou" is data, never an action: reverting stays a human decision.
  assert.equal(corpo.proposta.status, 'aplicada');
  assert.equal(corpo.proposta.versao_aplicada_id, cenario.versaoAplicada);
  const grafo = await pedirGrafo(cenario.endereco, cenario.grafo.id);
  assert.equal(grafo.versao_corrente_id, cenario.versaoAplicada, 'o ponteiro não pode ter voltado');
});

test('AT23 — only the first outcome counts; the second call is 409 and changes nothing', async (t) => {
  const cenario = await appliedProposalWithTelemetry(t);
  const rota = `/v1/propostas/${cenario.proposta.id}/resultado`;

  const primeira = await postar(cenario.endereco, rota, {
    execucao_id: cenario.execucaoId,
    depois: 0.1,
  });
  assert.equal(primeira.status, 200);
  const gravado = (await corpoJson<RespostaAplicacao>(primeira)).proposta
    .resultado as HypothesisOutcome;

  const segunda = await postar(cenario.endereco, rota, {
    execucao_id: cenario.execucaoId,
    depois: 0.9,
  });
  assert.equal(segunda.status, 409);
  assert.equal((await corpoJson<{ erro: string }>(segunda)).erro, 'proposta_ja_avaliada');

  const [depois] = await listProposals(cenario.endereco);
  assert.deepEqual(depois.resultado, gravado, 'a segunda chamada não pode reescrever o veredito');
});

test('AT24 — a proposal that is not aplicada cannot have an outcome', async (t) => {
  const endereco = await subirApp(t);
  const { grafo, versao } = await registrarBase(endereco);
  const pendente = await criarProposta(endereco, grafo.id, versao.id, operacoesQuePassam());

  const resposta = await postar(endereco, `/v1/propostas/${pendente.id}/resultado`, {
    execucao_id: 1,
    depois: 0.1,
  });
  assert.equal(resposta.status, 409);
  assert.equal((await corpoJson<{ erro: string }>(resposta)).erro, 'proposta_nao_aplicada');

  assert.equal(
    (await postar(endereco, '/v1/propostas/999/resultado', { execucao_id: 1, depois: 0.1 })).status,
    404,
  );
});

test('AT25 — an execution with no telemetry under the applied version is refused', async (t) => {
  const cenario = await appliedProposalWithTelemetry(t, { execucaoId: 1 });
  const rota = `/v1/propostas/${cenario.proposta.id}/resultado`;

  const semTrabalho = await postar(cenario.endereco, rota, { execucao_id: 99, depois: 0.1 });
  assert.equal(semTrabalho.status, 422);
  assert.equal((await corpoJson<{ erro: string }>(semTrabalho)).erro, 'execucao_sem_evidencia');

  // Uma execução que rodou, mas sob a versão ANTERIOR, também não é evidência
  // desta proposta: o join é por versão, não por execução.
  await recordWorkUnderVersion(cenario.endereco, 2, cenario.versaoAlvo);
  const outraVersao = await postar(cenario.endereco, rota, { execucao_id: 2, depois: 0.1 });
  assert.equal(outraVersao.status, 422);
  assert.equal((await corpoJson<{ erro: string }>(outraVersao)).erro, 'execucao_sem_evidencia');

  const [proposta] = await listProposals(cenario.endereco);
  assert.equal(proposta.resultado, null, 'nada pode ter sido gravado');
});

test('AT26 — a proposal whose metrica_esperada has no shape gets no verdict', async (t) => {
  const cenario = await appliedProposalWithTelemetry(t, {
    metricaEsperada: { nome: 'retrabalho_por_travessia', de: 0.4, para: 0.1 },
  });

  const resposta = await postar(
    cenario.endereco,
    `/v1/propostas/${cenario.proposta.id}/resultado`,
    { execucao_id: cenario.execucaoId, depois: 0.1 },
  );
  assert.equal(resposta.status, 422);
  assert.equal((await corpoJson<{ erro: string }>(resposta)).erro, 'metrica_esperada_invalida');

  const [proposta] = await listProposals(cenario.endereco);
  assert.equal(proposta.resultado, null, 'veredito sobre dado incompleto não se grava');
});

test('AT27 — the reversal-suggestion queue is a filtered read over the proposals', async (t) => {
  const endereco = await subirApp(t);
  const { grafo, versao } = await registrarBase(endereco);

  // A: aplicada e piorou — a fila de sugestão de reversão é exatamente esta.
  const a = await criarProposta(endereco, grafo.id, versao.id, operacoesQuePassam());
  const versaoA = await applyProposal(endereco, a.id);
  await recordWorkUnderVersion(endereco, 1, versaoA);
  assert.equal(
    (await postar(endereco, `/v1/propostas/${a.id}/resultado`, { execucao_id: 1, depois: 0.9 }))
      .status,
    200,
  );

  // B: piorou também, mas já foi revertida por decisão humana — sai da fila.
  const b = await criarProposta(endereco, grafo.id, versaoA, roleChange('red-team'));
  const versaoB = await applyProposal(endereco, b.id);
  await recordWorkUnderVersion(endereco, 2, versaoB);
  assert.equal(
    (await postar(endereco, `/v1/propostas/${b.id}/resultado`, { execucao_id: 2, depois: 0.9 }))
      .status,
    200,
  );
  assert.equal(
    (await postar(endereco, `/v1/propostas/${b.id}/reverter`, { motivo: 'piorou de verdade' }))
      .status,
    200,
  );

  // C: aplicada, mas confirmada — hipótese que deu certo não é sugestão de nada.
  const c = await criarProposta(endereco, grafo.id, versaoA, roleChange('copidesque'));
  const versaoC = await applyProposal(endereco, c.id);
  await recordWorkUnderVersion(endereco, 3, versaoC);
  assert.equal(
    (await postar(endereco, `/v1/propostas/${c.id}/resultado`, { execucao_id: 3, depois: 0.1 }))
      .status,
    200,
  );

  // D: pendente, sem resultado nenhum.
  const d = await criarProposta(endereco, grafo.id, versaoC, roleChange('editor'));

  const fila = await listProposals(endereco, '?status=aplicada&veredito=piorou');
  assert.deepEqual(
    fila.map((proposta) => proposta.id),
    [a.id],
    'só a proposta que piorou E continua aplicada',
  );

  const todas = await listProposals(endereco);
  assert.deepEqual(
    todas.map((proposta) => proposta.id),
    [a.id, b.id, c.id, d.id],
    'sem filtro, todas as propostas em ordem de id',
  );
  assert.deepEqual(
    todas.map((proposta) => proposta.status),
    ['aplicada', 'revertida', 'aplicada', 'pendente'],
  );

  assert.deepEqual(
    (await listProposals(endereco, '?veredito=confirmada')).map((proposta) => proposta.id),
    [c.id],
  );
  assert.deepEqual(
    (await listProposals(endereco, '?status=pendente')).map((proposta) => proposta.id),
    [d.id],
  );
});
