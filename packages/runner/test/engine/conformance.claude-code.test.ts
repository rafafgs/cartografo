/**
 * O `ClaudeCodeAdapter` rodando o kit de conformidade inteiro (C1–C7).
 *
 * O kit não sabe nada deste adapter: ele recebe uma fábrica e um caminho de
 * fake engine. Toda a especificidade do Claude Code mora neste arquivo — a
 * costura que troca o binário real pelo fake, e o formato do quadro
 * `stream-json` de onde o `engineRef` sai. É essa fronteira que faz a mesma
 * suíte servir ao segundo adapter (t119) sem cópia.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import { buildCommand } from '../../src/engine/command.ts';
import { runConformanceKit } from '../../src/engine/conformance-kit.ts';

const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

const REF_DO_ENGINE = 'ref-de-sessao-do-engine-abc123';

runConformanceKit(
  (fakeEnginePath) =>
    new ClaudeCodeAdapter({
      // A costura exigida pelo kit: o argv que a CLI `claude` receberia,
      // inteiro e sem edição, entregue ao fake engine. Trocar só o binário é o
      // que faz C2 medir a injeção de verdade, e não uma versão simplificada
      // dela montada para o teste.
      commandBuilder: (spec) => ({
        command: process.execPath,
        args: [fakeEnginePath, ...buildCommand(spec).args],
      }),
      // Grace curto: C4 espera a escalada para SIGKILL dentro do prazo do caso.
      graceMs: 300,
    }),
  FAKE_ENGINE,
  {
    quadroDeEngineRef: {
      linha: JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: REF_DO_ENGINE,
        model: 'claude-opus-5',
      }),
      refEsperada: REF_DO_ENGINE,
    },
  },
);

test('engineName é o identificador estável persistido na linha da sessão', () => {
  assert.equal(new ClaudeCodeAdapter().engineName, 'claude-code');
});

test('capabilities declara só o que tem consumidor', () => {
  // `hasStructuredOutput` porque `stream-json` é parseável. As outras duas
  // ficam AUSENTES, não `false` explícito: nenhuma tem consumidor no v0, e
  // "declarar a quarta, quinta e sexta antes de alguém ler é como o formato
  // apodrece" (`docs/formatos/engine-adapter.md:160-165`). Ausente já é
  // `false` por `resolveCapabilities`.
  const declaradas = new ClaudeCodeAdapter().capabilities();

  assert.deepEqual(declaradas, { hasStructuredOutput: true });
  assert.ok(!('hasResume' in declaradas));
  assert.ok(!('reportsUsage' in declaradas));
});
