// Testes de contrato dos schemas de evento (t98, teste de aceite 1).
//
// A tabela abaixo É a especificação: cada tipo de evento, a entidade que ele
// descreve e os campos do payload `dados` (os marcados como opcionais ficam
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
  'trabalho.criado': {
    entidade: 'trabalho',
    obrigatorios: ['titulo', 'no_entrada_id'],
    opcionais: [],
  },
  'trabalho.transicao': {
    entidade: 'trabalho',
    obrigatorios: ['para_no_id'],
    opcionais: ['de_no_id'],
  },
  'trabalho.bloqueado': {
    entidade: 'trabalho',
    obrigatorios: ['motivo'],
    opcionais: [],
  },
  'trabalho.desbloqueado': {
    entidade: 'trabalho',
    obrigatorios: [],
    opcionais: [],
  },
  'trabalho.emendado': {
    entidade: 'trabalho',
    obrigatorios: ['campos_alterados'],
    opcionais: [],
  },
  'sessao.aberta': {
    entidade: 'sessao',
    obrigatorios: ['engine', 'working_dir', 'prompt'],
    opcionais: ['trabalho_id', 'no_id', 'engine_session_ref', 'timeout_seconds'],
  },
  'sessao.finalizada': {
    entidade: 'sessao',
    obrigatorios: ['status'],
    opcionais: ['exit_code', 'uso'],
  },
  'pergunta.criada': {
    entidade: 'pergunta',
    obrigatorios: ['trabalho_id', 'tipo', 'pergunta', 'auto_aprovavel'],
    opcionais: ['sessao_id', 'contexto', 'opcoes', 'recomendacao', 'resposta_padrao'],
  },
  'pergunta.respondida': {
    entidade: 'pergunta',
    obrigatorios: ['resposta', 'respondido_por'],
    opcionais: [],
  },
  'pergunta.auto_resolvida': {
    entidade: 'pergunta',
    obrigatorios: ['resposta', 'baseada_em'],
    opcionais: [],
  },
  'lease.concedida': {
    entidade: 'lease',
    obrigatorios: ['trabalho_id', 'runner_id', 'expira_em'],
    opcionais: [],
  },
  'lease.expirada': {
    entidade: 'lease',
    obrigatorios: ['runner_id', 'motivo'],
    opcionais: [],
  },
  'grafo_versao.registrada': {
    entidade: 'grafo_versao',
    obrigatorios: ['grafo_id', 'origem'],
    opcionais: ['versao_pai', 'proposta_id'],
  },
  'grafo_versao.aplicada': {
    entidade: 'grafo_versao',
    obrigatorios: ['grafo_id'],
    opcionais: ['proposta_id'],
  },
  'grafo_versao.revertida': {
    entidade: 'grafo_versao',
    obrigatorios: ['grafo_id', 'versao_alvo', 'motivo'],
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
    ['ator', 'dados', 'entidade', 'execucao_id', 'id', 'ocorrido_em', 'projeto_id', 'tipo'],
  );

  assert.equal(envelope.properties.id.type, 'integer');
  assert.equal(envelope.properties.tipo.type, 'string');
  assert.equal(envelope.properties.projeto_id.type, 'integer');
  assert.deepEqual([...envelope.properties.execucao_id.type].sort(), ['integer', 'null']);
  assert.equal(envelope.properties.ocorrido_em.format, 'date-time');
  assert.equal(envelope.properties.dados.type, 'object');

  const entidade = envelope.properties.entidade;
  assert.deepEqual([...entidade.required].sort(), ['id', 'tipo']);
  assert.deepEqual(
    [...entidade.properties.tipo.enum].sort(),
    ['grafo_versao', 'lease', 'pergunta', 'sessao', 'trabalho'],
  );
  assert.deepEqual([...entidade.properties.id.type].sort(), ['integer', 'string']);

  const ator = envelope.properties.ator;
  assert.deepEqual([...ator.required].sort(), ['ref', 'tipo']);
  assert.deepEqual([...ator.properties.tipo.enum].sort(), ['agente', 'sistema', 'usuario']);
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

  test(`${arquivo} fixa properties.tipo.const igual ao nome do arquivo`, () => {
    const schema = lerSchema(arquivo);
    assert.equal(schema.properties.tipo.const, tipo);
  });

  test(`${arquivo} fixa a entidade do evento`, () => {
    const schema = lerSchema(arquivo);
    assert.equal(schema.properties.entidade.properties.tipo.const, spec.entidade);
  });

  test(`${arquivo} declara os campos de dados da tabela`, () => {
    const schema = lerSchema(arquivo);
    const dados = schema.properties.dados;

    assert.deepEqual(
      [...dados.required].sort(),
      [...spec.obrigatorios].sort(),
      `${arquivo}: dados.required diverge da tabela`,
    );
    assert.deepEqual(
      Object.keys(dados.properties ?? {}).sort(),
      [...spec.obrigatorios, ...spec.opcionais].sort(),
      `${arquivo}: dados.properties diverge da tabela`,
    );
    assert.equal(
      dados.additionalProperties,
      false,
      `${arquivo}: dados deve fechar additionalProperties`,
    );
  });
}

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
