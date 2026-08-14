// Prova de replay (t98, teste de aceite 3).
//
// O inegociável de qualidade é "reprodutibilidade por event sourcing": o
// estado final de uma execução tem que sair do log e de mais nada. Este teste
// dobra o log de exemplo com o reducer e compara com um estado esperado
// calculado à mão a partir do mesmo log.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LOG = fileURLToPath(new URL('../exemplos/log-exemplo.jsonl', import.meta.url));
const ESPERADO = fileURLToPath(new URL('../exemplos/estado-final-esperado.json', import.meta.url));
const REDUCER = '../reducers/reconstruir-estado.mjs';

function lerLog() {
  return readFileSync(LOG, 'utf8')
    .split('\n')
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0)
    .map((linha) => JSON.parse(linha));
}

test('reconstruirEstado reproduz o estado final esperado', async () => {
  const { reconstruirEstado } = await import(REDUCER);
  const eventos = lerLog();
  const esperado = JSON.parse(readFileSync(ESPERADO, 'utf8'));

  assert.deepStrictEqual(reconstruirEstado(eventos), esperado);
});

test('reconstruirEstado é determinístico e não depende da ordem de leitura', async () => {
  const { reconstruirEstado } = await import(REDUCER);
  const eventos = lerLog();

  assert.deepStrictEqual(reconstruirEstado(eventos), reconstruirEstado([...eventos].reverse()));
});

test('reconstruirEstado não muta a lista de eventos que recebe', async () => {
  const { reconstruirEstado } = await import(REDUCER);
  const eventos = lerLog();
  const antes = JSON.stringify(eventos);

  reconstruirEstado(eventos);

  assert.equal(JSON.stringify(eventos), antes);
});

test('um log vazio reconstrói um estado vazio', async () => {
  const { reconstruirEstado } = await import(REDUCER);

  assert.deepStrictEqual(reconstruirEstado([]), {
    trabalhos: {},
    sessoes: {},
    perguntas: {},
    leases: {},
    grafo_versao_corrente: {},
  });
});
