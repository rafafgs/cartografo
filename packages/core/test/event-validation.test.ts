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
