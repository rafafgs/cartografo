// Validação do log de exemplo contra os schemas (t98, teste de aceite 2).
//
// Sem ajv e sem package.json: o repo ainda é pré-implementação e a primeira
// dependência do projeto não entra por uma ficha de especificação. A validação
// aqui é estrutural — chaves obrigatórias presentes, enums respeitados,
// nenhuma chave de `dados` fora do contrato — que é o suficiente para provar
// que o exemplo e os schemas falam do mesmo formato.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const DIR_SCHEMAS = fileURLToPath(new URL('../schemas/', import.meta.url));
const LOG = fileURLToPath(new URL('../exemplos/log-exemplo.jsonl', import.meta.url));

const ENVELOPE = 'envelope.schema.json';
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function lerSchemas() {
  const envelope = JSON.parse(readFileSync(join(DIR_SCHEMAS, ENVELOPE), 'utf8'));
  const porTipo = new Map();
  for (const nome of readdirSync(DIR_SCHEMAS)) {
    if (!nome.endsWith('.schema.json') || nome === ENVELOPE) continue;
    const schema = JSON.parse(readFileSync(join(DIR_SCHEMAS, nome), 'utf8'));
    porTipo.set(schema.properties.tipo.const, schema);
  }
  return { envelope, porTipo };
}

function lerLog() {
  return readFileSync(LOG, 'utf8')
    .split('\n')
    .map((linha, indice) => ({ linha: linha.trim(), numero: indice + 1 }))
    .filter(({ linha }) => linha.length > 0)
    .map(({ linha, numero }) => {
      try {
        return { evento: JSON.parse(linha), numero };
      } catch (erro) {
        assert.fail(`linha ${numero} não é JSON válido: ${erro.message}`);
      }
    });
}

const { envelope, porTipo } = lerSchemas();
const linhas = lerLog();

test('o log de exemplo não está vazio', () => {
  assert.ok(linhas.length > 0, 'log-exemplo.jsonl não tem nenhum evento');
});

for (const { evento, numero } of linhas) {
  const rotulo = `linha ${numero} (${evento.tipo})`;

  test(`${rotulo}: envelope completo e bem tipado`, () => {
    for (const chave of envelope.required) {
      assert.ok(chave in evento, `${rotulo}: falta o campo obrigatório "${chave}"`);
    }
    assert.equal(typeof evento.id, 'number');
    assert.ok(Number.isInteger(evento.id), `${rotulo}: id precisa ser inteiro`);
    assert.equal(typeof evento.projeto_id, 'number');
    assert.ok(
      evento.execucao_id === null || Number.isInteger(evento.execucao_id),
      `${rotulo}: execucao_id precisa ser inteiro ou null`,
    );
    assert.match(evento.ocorrido_em, ISO_8601, `${rotulo}: ocorrido_em não é date-time ISO 8601`);

    assert.ok(
      envelope.properties.entidade.properties.tipo.enum.includes(evento.entidade.tipo),
      `${rotulo}: entidade.tipo "${evento.entidade.tipo}" fora do enum`,
    );
    assert.ok(
      ['number', 'string'].includes(typeof evento.entidade.id),
      `${rotulo}: entidade.id precisa ser inteiro ou string`,
    );
    assert.ok(
      envelope.properties.ator.properties.tipo.enum.includes(evento.ator.tipo),
      `${rotulo}: ator.tipo "${evento.ator.tipo}" fora do enum`,
    );
    assert.equal(typeof evento.ator.ref, 'string');
    assert.equal(typeof evento.dados, 'object');
    assert.ok(evento.dados !== null, `${rotulo}: dados não pode ser null`);
  });

  test(`${rotulo}: bate com o schema do seu tipo`, () => {
    const schema = porTipo.get(evento.tipo);
    assert.ok(schema, `${rotulo}: nenhum schema declara o tipo "${evento.tipo}"`);

    assert.equal(
      evento.entidade.tipo,
      schema.properties.entidade.properties.tipo.const,
      `${rotulo}: entidade.tipo diverge do schema`,
    );

    const dados = schema.properties.dados;
    for (const chave of dados.required) {
      assert.ok(chave in evento.dados, `${rotulo}: falta dados.${chave}`);
    }
    const declaradas = Object.keys(dados.properties ?? {});
    for (const chave of Object.keys(evento.dados)) {
      assert.ok(
        declaradas.includes(chave),
        `${rotulo}: dados.${chave} não está declarado no schema`,
      );
    }
  });
}

test('todos os tipos de evento aparecem pelo menos uma vez', () => {
  const presentes = new Set(linhas.map(({ evento }) => evento.tipo));
  const faltando = [...porTipo.keys()].filter((tipo) => !presentes.has(tipo)).sort();
  assert.deepEqual(faltando, [], `tipos ausentes do log de exemplo: ${faltando.join(', ')}`);
});

test('os ids são monotônicos — a ordem do log', () => {
  const ids = linhas.map(({ evento }) => evento.id);
  for (let i = 1; i < ids.length; i += 1) {
    assert.ok(ids[i] > ids[i - 1], `id ${ids[i]} não é maior que o anterior ${ids[i - 1]}`);
  }
});

test('o log descreve uma única execução ponta a ponta', () => {
  const execucoes = new Set(
    linhas.map(({ evento }) => evento.execucao_id).filter((id) => id !== null),
  );
  assert.equal(execucoes.size, 1, `esperava uma execução só, achei ${[...execucoes].join(', ')}`);

  const projetos = new Set(linhas.map(({ evento }) => evento.projeto_id));
  assert.equal(projetos.size, 1, `esperava um projeto só, achei ${[...projetos].join(', ')}`);
});
