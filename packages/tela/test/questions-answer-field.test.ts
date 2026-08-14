/**
 * Acceptance tests for the accessible name of the answer field (t134, AT6/ux).
 *
 * The alpha round on `t107` found `GET /perguntas` rendering the one required
 * field of the screen as `<textarea name="resposta" required placeholder="…">`
 * and nothing else: no `<label>`, no `aria-label`. A placeholder is a hint, not
 * a name — it is gone at the first keystroke, and a reader that reaches the
 * field afterwards has nothing to announce. This is the field the whole page
 * exists to fill in.
 *
 * It is the same finding `t128` fixed on the proposal inbox one screen over,
 * and the rule pinned here is the same: the name is resolved the way a reader
 * would resolve it — `aria-label`, a `<label>` tied by `for`/`id`, or a
 * `<label>` that wraps the field — so the page stays free to change how it gets
 * there as long as the name is there. `placeholder` is never consulted, and
 * that is the whole point.
 *
 * Unlike `inbox-reason-field.test.ts` there is no DOM to stub: this page is
 * rendered on the server and what arrives is a string of HTML. So the resolver
 * below reads that string by markers and shapes rather than parsing it, in the
 * same spirit — and for the same reason — as `blocos` in `apoio.ts`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARTEFATOS_T107,
  abrirPagina,
  blocos,
  criarPergunta,
  criarTrabalho,
  exigirArtefatos,
  subirControlPlane,
  subirTela,
  type TelaNoAr,
} from './apoio.ts';

const QUESTION = {
  pergunta: 'Renumerar a migração para 0003?',
  contexto: 'A t101 corre em paralelo e é dona do mesmo espaço de numeração.',
  opcoes: ['Renumerar para 0003', 'Manter 0002'],
  recomendacao: 'Manter 0002 e renumerar só se colidir no merge.',
  resposta_padrao: 'Manter 0002',
};

/* --- reading the page ------------------------------------------------- */

/** Everything the page escaped on the way out, back to what it says. */
function decode(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

/** Visible text of a fragment: tags out, entities back, whitespace collapsed. */
function textOf(fragment: string): string {
  return decode(fragment.replaceAll(/<[^>]*>/g, ' '))
    .replaceAll(/\s+/g, ' ')
    .trim();
}

/** One attribute of an opening tag, decoded; `null` when it is absent. */
function attributeOf(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag);
  return match === null ? null : decode(match[1]);
}

/** Opening tags of the form controls in a fragment, in document order. */
function controlsOf(fragment: string): string[] {
  return [...fragment.matchAll(/<(?:textarea|input|select)\b[^>]*>/g)].map((match) => match[0]);
}

/** The opening tag of the answer field of one card. */
function answerFieldOf(card: string): string {
  const field = controlsOf(card).find((tag) => attributeOf(tag, 'name') === 'resposta');
  assert.ok(field !== undefined, 'the card has no answer field at all');
  return field;
}

interface Rotulo {
  /** The `for` attribute, or `null` when the label does not carry one. */
  readonly alvo: string | null;
  readonly interno: string;
  readonly inteiro: string;
}

function labelsOf(scope: string): Rotulo[] {
  return [...scope.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)].map((match) => ({
    alvo: attributeOf(`<label${match[1]}>`, 'for'),
    interno: match[2],
    inteiro: match[0],
  }));
}

/**
 * The labels that name a field: one pointing at its id, or one wrapping it.
 *
 * Returned rather than reduced to a name so that a test can assert on how many
 * there are — on a page that repeats a card per question, the interesting
 * failure is two fields sharing an id, which aims both labels at the first one.
 */
function namingLabelsOf(scope: string, tag: string): Rotulo[] {
  const id = attributeOf(tag, 'id');
  return labelsOf(scope).filter(
    (rotulo) => (id !== null && id !== '' && rotulo.alvo === id) || rotulo.inteiro.includes(tag),
  );
}

/**
 * The accessible name of a control, over the slice of the algorithm a
 * server-rendered page can reach: `aria-label`, a `<label for>` pointing at its
 * id, or a `<label>` wrapping it.
 *
 * `placeholder` is deliberately not consulted. The real algorithm does fall
 * back to it, last, but it disappears as soon as someone types, it is not
 * announced consistently across browser and reader pairs, and a field whose
 * only name is a placeholder has no name for anyone coming back to it after
 * filling it in.
 *
 * @param scope Fragment to look for the label in — one card, or the page.
 * @param tag Opening tag of the control whose name is being resolved.
 */
function accessibleNameOf(scope: string, tag: string): string {
  const aria = attributeOf(tag, 'aria-label');
  if (aria !== null && aria.trim() !== '') return aria.trim();

  const naming = namingLabelsOf(scope, tag);
  if (naming.length === 0) return '';
  assert.equal(naming.length, 1, `more than one <label> claims the field: ${tag}`);
  // A wrapping label may hold the field's own content; that is the value, not
  // the name, so it does not count towards what the label says.
  return textOf(naming[0].interno.replaceAll(/<textarea\b[^>]*>[\s\S]*?<\/textarea>/g, ' '));
}

/** The card of every pending question on the page, in the order shown. */
async function abrirFila(tela: TelaNoAr): Promise<{ html: string; cartoes: string[] }> {
  const pagina = await abrirPagina(tela, '/perguntas');
  assert.equal(pagina.status, 200);
  return { html: pagina.html, cartoes: blocos(pagina.html, 'pergunta').map((bloco) => bloco.trecho) };
}

/* --- the tests -------------------------------------------------------- */

test('t134 AT6 — the answer field on GET /perguntas has an accessible name', async (t) => {
  exigirArtefatos(ARTEFATOS_T107.paginas, ARTEFATOS_T107.servidor);
  const cp = await subirControlPlane(t);

  const trabalho = await criarTrabalho(cp, { titulo: 'com pergunta', no_entrada_id: 'refinar' });
  await criarPergunta(cp, { trabalho_id: trabalho.id, ...QUESTION });

  const tela = await subirTela(t, cp.url);
  const { cartoes } = await abrirFila(tela);
  assert.equal(cartoes.length, 1);

  const campo = answerFieldOf(cartoes[0]);
  assert.notEqual(
    accessibleNameOf(cartoes[0], campo),
    '',
    'the required answer field must say what it is for; a placeholder is not a name',
  );
});

test('t134 AT6 — the name comes from something that outlives the first keystroke', async (t) => {
  exigirArtefatos(ARTEFATOS_T107.paginas, ARTEFATOS_T107.servidor);
  const cp = await subirControlPlane(t);

  const trabalho = await criarTrabalho(cp, { titulo: 'com pergunta', no_entrada_id: 'refinar' });
  await criarPergunta(cp, { trabalho_id: trabalho.id, ...QUESTION });

  const tela = await subirTela(t, cp.url);
  const { cartoes } = await abrirFila(tela);
  const antes = accessibleNameOf(cartoes[0], answerFieldOf(cartoes[0]));

  // The reproduction, literally: whatever the placeholder said is gone from
  // the moment someone types into the field. What is left has to name it.
  const semPlaceholder = cartoes[0].replaceAll(/\splaceholder="[^"]*"/g, '');
  const depois = accessibleNameOf(semPlaceholder, answerFieldOf(semPlaceholder));

  assert.notEqual(depois, '');
  assert.equal(depois, antes, 'the name must not be the placeholder wearing a hat');
});

test('t134 AT6 — every field of the answer form has a name, not just a placeholder', async (t) => {
  exigirArtefatos(ARTEFATOS_T107.paginas, ARTEFATOS_T107.servidor);
  const cp = await subirControlPlane(t);

  const trabalho = await criarTrabalho(cp, { titulo: 'com pergunta', no_entrada_id: 'refinar' });
  await criarPergunta(cp, { trabalho_id: trabalho.id, ...QUESTION });

  const tela = await subirTela(t, cp.url);
  const { cartoes } = await abrirFila(tela);

  const campos = controlsOf(cartoes[0]);
  assert.ok(campos.length >= 2, 'the form has at least the answer and who is answering');
  for (const campo of campos) {
    assert.notEqual(
      accessibleNameOf(cartoes[0], campo),
      '',
      `field without an accessible name: ${campo}`,
    );
  }
});

test('t134 AT6 — two pending questions keep one name each', async (t) => {
  exigirArtefatos(ARTEFATOS_T107.paginas, ARTEFATOS_T107.servidor);
  const cp = await subirControlPlane(t);

  const trabalho = await criarTrabalho(cp, { titulo: 'com perguntas', no_entrada_id: 'refinar' });
  await criarPergunta(cp, { trabalho_id: trabalho.id, ...QUESTION });
  await criarPergunta(cp, { trabalho_id: trabalho.id, pergunta: 'E a outra, renumera?' });

  const tela = await subirTela(t, cp.url);
  const { html, cartoes } = await abrirFila(tela);
  assert.equal(cartoes.length, 2, 'both questions are pending');

  const [primeiro, segundo] = cartoes.map(answerFieldOf);
  const ids = [primeiro, segundo].map((campo) => attributeOf(campo, 'id'));
  if (ids[0] !== null) {
    assert.notEqual(
      ids[0],
      ids[1],
      'two ids the same on one page point every label at the first field',
    );
  }

  // Resolved over the WHOLE page, which is where a duplicate id shows up, and
  // where a label of the card above could be counted as naming this field.
  for (const campo of [primeiro, segundo]) {
    assert.equal(namingLabelsOf(html, campo).length, 1, `exactly one label names ${campo}`);
    assert.notEqual(accessibleNameOf(html, campo), '');
  }
});
