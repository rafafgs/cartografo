/**
 * Unit tests of the validator's own non-empty-string rule (t157, FR5).
 *
 * `src/db/event-validation.ts` adds a rule the JSON schemas of
 * `especificacoes/eventos/schemas/` do not declare: a `string` field cannot be
 * the empty string. That rule is this file's own contract — and until t157 it
 * applied to scalar strings only, so `campos_alterados: ['']` walked into the
 * log while `titulo: ''` was refused. An internally inconsistent mirror is the
 * drift the header of that file exists to prevent.
 *
 * The event-type strings and the payload keys stay in Portuguese: they mirror
 * the taxonomy (t127, FR8).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ValidationError, requireValidData } from '../src/db/event-validation.ts';

/** Asserts that a payload is refused, and that the message names the field. */
function refuses(type: string, data: Record<string, unknown>, field: string): void {
  assert.throws(
    () => requireValidData(type, data),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError, `${type} has to fail with a ValidationError`);
      assert.ok(
        error.errors.some((detail) => detail.includes(field)),
        `the errors have to name ${field}: ${JSON.stringify(error.errors)}`,
      );
      return true;
    },
    `${type} accepted ${JSON.stringify(data)}`,
  );
}

test('t157 FR5 — an empty item is refused in a required string-list', () => {
  refuses('trabalho.emendado', { campos_alterados: [''] }, 'campos_alterados');
  refuses('trabalho.emendado', { campos_alterados: ['titulo', ''] }, 'campos_alterados');
});

test('t157 FR5 — an empty item is refused in an optional string-list too', () => {
  refuses(
    'trabalho.criado',
    { titulo: 'x', no_entrada_id: 'y', criterios_de_aceite: [''] },
    'criterios_de_aceite',
  );
  refuses(
    'pergunta.criada',
    {
      trabalho_id: 1,
      tipo: 'pergunta',
      pergunta: 'qual caminho?',
      opcoes: ['seguir', ''],
      auto_aprovavel: false,
    },
    'opcoes',
  );
});

test('t157 FR5 — the rule is the same one scalar strings already carry', () => {
  refuses('trabalho.criado', { titulo: '', no_entrada_id: 'y' }, 'titulo');
});

test('t157 FR5 — a list of real strings still passes', () => {
  assert.deepEqual(requireValidData('trabalho.emendado', { campos_alterados: ['titulo'] }), {
    campos_alterados: ['titulo'],
  });
  assert.deepEqual(
    requireValidData('trabalho.criado', {
      titulo: 'x',
      no_entrada_id: 'y',
      criterios_de_aceite: ['a nota cabe em uma tela'],
    }),
    {
      titulo: 'x',
      no_entrada_id: 'y',
      corpo: null,
      criterios_de_aceite: ['a nota cabe em uma tela'],
    },
  );
  // An absent optional list is still absent, not an empty-item violation.
  assert.deepEqual(requireValidData('trabalho.criado', { titulo: 'x', no_entrada_id: 'y' }), {
    titulo: 'x',
    no_entrada_id: 'y',
    corpo: null,
    criterios_de_aceite: null,
  });
});

/** Everything `sessao.aberta` requires, so a case only has to vary its own field. */
const OPEN_SESSION = Object.freeze({
  engine: 'claude-code',
  working_dir: '/tmp/cartografo',
  prompt: 'faça algo e conte o que aconteceu',
});

test('t163 — sessao.aberta accepts the silence budget, and absent reads as null', () => {
  assert.equal(
    requireValidData('sessao.aberta', { ...OPEN_SESSION, silence_seconds: 900 }).silence_seconds,
    900,
  );
  // Zero is a legitimate measurement here, exactly as it is for `timeout_seconds`:
  // the schema's floor is 0, and "no policy" is expressed by absence, not by a
  // number. What a non-positive DECLARED budget means is `resolveBudget`'s
  // business, one layer up, and not this contract's.
  assert.equal(
    requireValidData('sessao.aberta', { ...OPEN_SESSION, silence_seconds: 0 }).silence_seconds,
    0,
  );
  assert.equal(
    requireValidData('sessao.aberta', { ...OPEN_SESSION }).silence_seconds,
    null,
    'an absent budget is a session that declares no policy, never a zero',
  );
  refuses('sessao.aberta', { ...OPEN_SESSION, silence_seconds: -1 }, 'silence_seconds');
  refuses('sessao.aberta', { ...OPEN_SESSION, silence_seconds: '900' }, 'silence_seconds');
});

test('t163 — sessao.finalizada accepts the two watchdog causes and nothing else', () => {
  for (const reason of ['wall_clock', 'silence']) {
    assert.equal(
      requireValidData('sessao.finalizada', { status: 'tempo_esgotado', timeout_reason: reason })
        .timeout_reason,
      reason,
    );
  }
  assert.equal(
    requireValidData('sessao.finalizada', { status: 'concluida' }).timeout_reason,
    null,
    'a session that did not run a watchdog out has no cause to report',
  );
  refuses(
    'sessao.finalizada',
    { status: 'tempo_esgotado', timeout_reason: 'travada' },
    'timeout_reason',
  );
});
