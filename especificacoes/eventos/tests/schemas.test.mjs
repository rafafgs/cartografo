// Testes de contrato dos schemas de evento (t98, teste de aceite 1).
//
// A tabela abaixo É a especificação: cada tipo de evento, a entidade que ele
// descreve e os campos do payload `data` (os marcados como opcionais ficam
// fora de `required`, mas continuam declarados em `properties`). Qualquer
// divergência entre um arquivo de schema e esta tabela é um erro do schema,
// nunca do teste — a tabela reproduz a seção "Schema / Mudanças de Dados" da
// ficha.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const DIR_SCHEMAS = fileURLToPath(new URL('../schemas/', import.meta.url));

/** tipo -> { entidade, obrigatorios, opcionais } */
export const TABELA = {
  'job.created': {
    entidade: 'job',
    obrigatorios: ['title', 'entry_node_id'],
    // `body` e `acceptance_criteria` entraram com o intake (t122): um trabalho
    // pode nascer com conteúdo, e os critérios que o intake grava são
    // preliminares — quem tem a palavra final é o nó `refinar`. `fields` entrou
    // com os campos customizados por classe (t168): o que a classe declara no
    // grafo dela, o trabalho carrega aqui. `tier` entrou com a triagem barata
    // (t175): quanto o trabalho CUSTA para rodar, nunca por qual aresta ele
    // sai — o grafo segue congelado.
    opcionais: ['body', 'acceptance_criteria', 'fields', 'tier'],
  },
  'job.transitioned': {
    entidade: 'job',
    obrigatorios: ['to_node_id'],
    opcionais: ['from_node_id'],
  },
  'job.blocked': {
    entidade: 'job',
    // `consecutive_failures` entrou com o teto de falhas consecutivas (t265):
    // quantas sessões falhadas em sequência, no mesmo nó, levantaram a bandeira.
    // Opcional porque é o único motivo de bloqueio que tem sequência atrás de
    // si — os outros quatro (falha antes da sessão, trabalho não commitado, nó
    // sem a quem perguntar, escalação comum) não contam nada, e escrever um
    // número ali seria inventar medição.
    obrigatorios: ['reason'],
    opcionais: ['consecutive_failures'],
  },
  'job.unblocked': {
    entidade: 'job',
    obrigatorios: [],
    opcionais: [],
  },
  'job.amended': {
    entidade: 'job',
    obrigatorios: ['changed_fields'],
    opcionais: [],
  },
  'job.dependency_declared': {
    entidade: 'job',
    obrigatorios: ['depends_on_job_id'],
    opcionais: [],
  },
  // O 18º tipo entrou com os ganchos declarados no grafo (t169): quando a
  // entrega de um gancho esgota as seis tentativas, o único rastro observável
  // fora da tabela de entregas é este evento. Os quatro campos são
  // obrigatórios pela mesma razão dos de `session.permission_denied` — sem saber
  // QUAL gancho, de QUAL nó, para QUAL url e com QUAL erro, o incidente não é
  // auditável, e este log existe para ser auditado.
  'job.hook_failed': {
    entidade: 'job',
    obrigatorios: ['hook_id', 'node_id', 'url', 'last_error'],
    opcionais: [],
  },
  // `silence_seconds` entrou com o segundo cão de guarda (t163): a sessão passa
  // a declarar dois orçamentos independentes — relógio de parede e silêncio —
  // e ambos são opcionais pela mesma razão, ausência = sem política própria.
  'session.opened': {
    entidade: 'session',
    obrigatorios: ['engine', 'working_dir', 'prompt'],
    opcionais: [
      'job_id',
      'node_id',
      'engine_session_ref',
      'timeout_seconds',
      'silence_seconds',
    ],
  },
  'session.finished': {
    entidade: 'session',
    obrigatorios: ['status'],
    // `timeout_reason` (t163) é o que separa as duas paradas nossas sem que o
    // enum de `status` cresça: os dois cães de guarda desembocam em
    // `timed_out`, e a causa viaja no payload.
    //
    // `models` (t172) é a identidade que faltava para a pergunta "custo por
    // modelo": até aqui o log dizia qual MOTOR rodou (`session.opened.engine`) e
    // nunca qual modelo. É lista porque uma sessão roda mais de um — medido
    // contra a CLI real, um turno só devolveu dois — e colapsar em "o" modelo
    // atribuiria a conta inteira ao errado.
    //
    // `output` e `output_schema_error` entraram com a projeção de input por nó
    // (t253): `output` é o resultado ESTRUTURADO que a sessão relata do nó, sem
    // `required` aninhado nenhum, porque a forma de dentro é conferida contra o
    // schema `output` da própria skill (D9) e não contra este envelope. Quando
    // essa conferência recusa, o valor não é gravado e o que viaja no lugar dele
    // é a lista de motivos em `output_schema_error` — nunca ao custo de registrar
    // o status terminal da sessão, que é o fato que ninguém pode perder.
    //
    // `failure_kind` e `refusal_category` entraram com a recusa do engine
    // (t265): `failed` é uma palavra só para duas coisas — um crash, que vale
    // retentar, e um engine que RECUSOU responder, que se reproduz idêntico a
    // cada tentativa (medido: quatro recusas seguidas no mesmo prompt, t198).
    // O tipo é fechado porque a palavra é nossa; a categoria é aberta porque é
    // a palavra do engine, exatamente como `models` ao lado.
    //
    // `output_accepted` entrou com o relato recusado que ainda assim movia o
    // trabalho (t268). É o mesmo fato de `output_schema_error` visto do lado de
    // quem age: a lista diz POR QUE um relato foi recusado e só existe quando
    // houve recusa, e este diz SE ele foi aceito — gravado em todo fechamento,
    // `true` inclusive quando nada foi relatado, `false` só quando o schema
    // `output` da skill pinada recusou. Booleano e não derivação da lista
    // porque quem lê é o runner, na resposta do próprio `PATCH /finish`, para
    // decidir se o trabalho anda: ali "sem motivos" e "não conferido" seriam a
    // mesma ausência, e a diferença entre as duas é um trabalho seguindo por
    // uma aresta escolhida a partir de um relato que não foi gravado.
    opcionais: [
      'exit_code',
      'usage',
      'timeout_reason',
      'failure_kind',
      'refusal_category',
      'models',
      'output',
      'output_schema_error',
      'output_accepted',
    ],
  },
  // O 17º tipo entrou com o enforcement de permissão (t125): toda tentativa de
  // usar uma ferramenta que a política da sessão negou vira telemetria. Os três
  // campos são obrigatórios — uma negação sem recurso, sem ferramenta ou sem
  // motivo não é auditável, e este log existe para ser auditado.
  'session.permission_denied': {
    entidade: 'session',
    obrigatorios: ['resource', 'tool', 'reason'],
    opcionais: [],
  },
  'input_request.created': {
    entidade: 'input_request',
    obrigatorios: ['job_id', 'kind', 'question', 'auto_approvable'],
    // `node_id` desde a t167: de qual nó a pergunta veio, carimbado pelo servidor.
    opcionais: ['session_id', 'node_id', 'context', 'options', 'recommendation', 'default_answer'],
  },
  'input_request.answered': {
    entidade: 'input_request',
    obrigatorios: ['answer', 'answered_by'],
    opcionais: [],
  },
  'input_request.auto_resolved': {
    entidade: 'input_request',
    obrigatorios: ['answer', 'based_on'],
    opcionais: [],
  },
  'lease.granted': {
    entidade: 'lease',
    obrigatorios: ['job_id', 'runner_id', 'expires_at'],
    opcionais: [],
  },
  'lease.expired': {
    entidade: 'lease',
    obrigatorios: ['runner_id', 'reason'],
    opcionais: [],
  },
  'graph_version.registered': {
    entidade: 'graph_version',
    obrigatorios: ['graph_id', 'source'],
    opcionais: ['parent_version', 'proposal_id'],
  },
  'graph_version.applied': {
    entidade: 'graph_version',
    obrigatorios: ['graph_id'],
    opcionais: ['proposal_id'],
  },
  'graph_version.reverted': {
    entidade: 'graph_version',
    obrigatorios: ['graph_id', 'target_version', 'reason'],
    opcionais: [],
  },
  // O 19º tipo entrou com a D21 (t245): o control plane declara a execução
  // concluída, e é ele — só ele (D1) — quem afirma esse fato. Sem payload, pela
  // mesma razão de `job.unblocked`: `execution_id`, `entity.id` e `occurred_at`
  // do envelope já dizem de qual rodada se fala e quando ela acabou, e um campo
  // a mais seria dado repetido dentro do próprio evento.
  'execution.finished': {
    entidade: 'execution',
    obrigatorios: [],
    opcionais: [],
  },
};

const ENVELOPE = 'envelope.schema.json';

function lerSchema(arquivo) {
  const bruto = readFileSync(join(DIR_SCHEMAS, arquivo), 'utf8');
  try {
    return JSON.parse(bruto);
  } catch (erro) {
    assert.fail(`${arquivo} não é JSON válido: ${erro.message}`);
  }
}

function arquivosDeSchema() {
  return readdirSync(DIR_SCHEMAS)
    .filter((nome) => nome.endsWith('.schema.json'))
    .sort();
}

test('o diretório contém o envelope e um schema por tipo de evento', () => {
  const esperados = [ENVELOPE, ...Object.keys(TABELA).map((t) => `${t}.schema.json`)].sort();
  assert.deepEqual(arquivosDeSchema(), esperados);
});

test('o envelope declara os campos comuns a todo evento', () => {
  const envelope = lerSchema(ENVELOPE);

  assert.deepEqual(
    [...envelope.required].sort(),
    ['actor', 'data', 'entity', 'execution_id', 'id', 'occurred_at', 'project_id', 'type'],
  );

  assert.equal(envelope.properties.id.type, 'integer');
  assert.equal(envelope.properties.type.type, 'string');
  assert.equal(envelope.properties.project_id.type, 'integer');
  assert.deepEqual([...envelope.properties.execution_id.type].sort(), ['integer', 'null']);
  assert.equal(envelope.properties.occurred_at.format, 'date-time');
  assert.equal(envelope.properties.data.type, 'object');

  const entidade = envelope.properties.entity;
  assert.deepEqual([...entidade.required].sort(), ['id', 'type']);
  // `execution` entrou com a D21 (t245): a rodada virou sujeito de evento, e o
  // `entity.id` dela é o próprio `execution_id` — inteiro, como o de quase todo
  // mundo aqui. A 0003 e a `routes/executions.ts` diziam o contrário ("não
  // existe entidade execução"), e as duas são anteriores à decisão.
  assert.deepEqual(
    [...entidade.properties.type.enum].sort(),
    ['execution', 'graph_version', 'input_request', 'job', 'lease', 'session'],
  );
  assert.deepEqual([...entidade.properties.id.type].sort(), ['integer', 'string']);

  const ator = envelope.properties.actor;
  assert.deepEqual([...ator.required].sort(), ['ref', 'type']);
  assert.deepEqual([...ator.properties.type.enum].sort(), ['agent', 'system', 'user']);
  assert.equal(ator.properties.ref.type, 'string');
});

for (const [tipo, spec] of Object.entries(TABELA)) {
  const arquivo = `${tipo}.schema.json`;

  test(`${arquivo} é JSON válido e estende o envelope`, () => {
    const schema = lerSchema(arquivo);
    assert.ok(Array.isArray(schema.allOf), `${arquivo}: falta o allOf`);
    const refs = schema.allOf.map((sub) => sub.$ref);
    assert.ok(
      refs.some((ref) => typeof ref === 'string' && ref.includes(ENVELOPE)),
      `${arquivo}: nenhum allOf referencia ${ENVELOPE} (refs: ${JSON.stringify(refs)})`,
    );
  });

  test(`${arquivo} fixa properties.type.const igual ao nome do arquivo`, () => {
    const schema = lerSchema(arquivo);
    assert.equal(schema.properties.type.const, tipo);
  });

  test(`${arquivo} fixa a entidade do evento`, () => {
    const schema = lerSchema(arquivo);
    assert.equal(schema.properties.entity.properties.type.const, spec.entidade);
  });

  test(`${arquivo} declara os campos de dados da tabela`, () => {
    const schema = lerSchema(arquivo);
    const dados = schema.properties.data;

    assert.deepEqual(
      [...dados.required].sort(),
      [...spec.obrigatorios].sort(),
      `${arquivo}: data.required diverge da tabela`,
    );
    assert.deepEqual(
      Object.keys(dados.properties ?? {}).sort(),
      [...spec.obrigatorios, ...spec.opcionais].sort(),
      `${arquivo}: data.properties diverge da tabela`,
    );
    assert.equal(
      dados.additionalProperties,
      false,
      `${arquivo}: data deve fechar additionalProperties`,
    );
  });
}

test('t175 — job.created.data.tier fecha o conjunto em trivial, standard e null', () => {
  // Estrutural, como o resto deste diretório (`exemplos.test.mjs` escreve a
  // razão): sem ajv, o que se confere é a DECLARAÇÃO — e um enum declarado é
  // exatamente o que separa "aceita os dois valores e o nulo" de "aceita
  // qualquer string". A tabela em `src/db/event-validation.ts` é a duplicata
  // que o servidor cobra em tempo de escrita; as duas têm que andar juntas, e
  // é a asserção de `opcionais` acima que pega a divergência.
  const tier = lerSchema('job.created.schema.json').properties.data.properties.tier;

  assert.ok(tier, 'job.created não declara dados.tier');
  assert.deepEqual([...tier.type].sort(), ['null', 'string'], 'null é resposta válida');
  assert.deepEqual(
    [...tier.enum].sort((a, b) => String(a).localeCompare(String(b))),
    ['standard', 'trivial', null].sort((a, b) => String(a).localeCompare(String(b))),
    'o enum fecha o conjunto: qualquer outra string é recusada',
  );
});

test('nenhum schema descreve update ou delete de evento (append-only)', () => {
  for (const arquivo of arquivosDeSchema()) {
    const bruto = readFileSync(join(DIR_SCHEMAS, arquivo), 'utf8').toLowerCase();
    for (const proibido of ['update', 'delete', 'atualiza', 'remove']) {
      assert.ok(
        !bruto.includes(proibido),
        `${arquivo}: menciona "${proibido}" — o log é append-only, a única operação é inserir`,
      );
    }
  }
});

test('taxonomia.md referencia todos os schemas', () => {
  // Item mecânico da definição de pronto. O resto do documento é prosa e é
  // conferido por revisão humana no portão de aceite (exceção ao TDD da
  // ficha); "existe schema sem entrada no catálogo" não é prosa.
  const doc = readFileSync(fileURLToPath(new URL('../taxonomia.md', import.meta.url)), 'utf8');
  const ausentes = arquivosDeSchema().filter((nome) => !doc.includes(nome));
  assert.deepEqual(ausentes, [], `schemas sem referência em taxonomia.md: ${ausentes.join(', ')}`);
});

test('nenhum tipo de evento fora do escopo da PoC', () => {
  // `service_class` (urgência) e os eventos de proposta ficam fora da PoC
  // (D6/D16). A checagem é por NOME DE TIPO, não por vocabulário: citar o
  // topógrafo numa descrição é legítimo — ele é o consumidor desta telemetria.
  const fora = [
    'service_class',
    'proposta.criada',
    'proposta.aprovada',
    'proposta.aplicada',
    'proposta.revertida',
  ];
  for (const arquivo of arquivosDeSchema()) {
    const bruto = readFileSync(join(DIR_SCHEMAS, arquivo), 'utf8');
    for (const termo of fora) {
      assert.ok(!bruto.includes(termo), `${arquivo}: contém "${termo}", que está fora de escopo`);
    }
  }
});
