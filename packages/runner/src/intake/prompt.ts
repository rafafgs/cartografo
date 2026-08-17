/**
 * The intake session's prompt: everything the decomposition is given (t144, FR1/FR2).
 *
 * A pure function, tested on its own, for the reason `synthesizer/prompt.ts`
 * records about its own subject: this text IS the contract of the ficha. Between
 * a request in natural language and a batch of tickets a person will confirm,
 * the only thing standing is what is written here — and a contract that can only
 * be read by opening a session is a contract nobody reviews.
 *
 * Two inputs go in, and each one is a requirement:
 *
 * - the **request**, verbatim, as the person typed it. The session summarizes
 *   nothing on the way in: `pedido` is stored beside the batch, and the node that
 *   refines reads the original, not a paraphrase;
 * - the **class name**, verbatim. It is already registered — the orchestrator
 *   refused before opening this session otherwise — and D8 keeps the naming of a
 *   class in the user's hands either way.
 *
 * Every rule `validateItems` enforces (`packages/core/src/domain/intake.ts`) has
 * to be stated here, and "has to" is literal: the session runs in an empty
 * temporary directory, so it cannot open that file and read the format for
 * itself. A rule that lives only in the validator is a rule the session cannot
 * follow, and the bill arrives as an `invalid_items` nobody asked for — the
 * same failure mode t138 was for the synthesizer.
 *
 * The nuance that is easiest to get wrong is `acceptance_criteria`: `null` is
 * NOT `[]` (`domain/intake.ts:34-43`). "Nobody has written any criteria yet" and
 * "it was declared that there are none" are different statements, and the node
 * that refines is the one that has to tell them apart.
 *
 * English per D18; the prompt's own PROSE is Portuguese, like every other agent
 * instruction in this repository. The payload KEYS it teaches went English with
 * t255, and for the same reason they were Portuguese before: they are the wire
 * format of `POST /v1/intake`, not identifiers of ours — so they move when that
 * format moves. A prompt left behind teaches a shape the validator refuses, and
 * the session has no way of finding that out.
 */

/**
 * Where the session writes its answer.
 *
 * A file in the working directory, not a fenced block in stdout, and the choice
 * is `surveyor/proposal.ts`'s for the same reason: the output of a real CLI is a
 * stream of `stream-json` frames with prose in between, so a fenced block
 * arrives with its own quotes escaped and its newlines flattened — which is
 * exactly the decoding fragility t148 cost the synthesizer a whole round of real
 * runs. Nothing here needs to watch the output while it streams, so the contract
 * that survives is the one the session fulfils with a single write.
 *
 * The file NAME stays as it is: it is data the session is told to write, not a
 * code identifier.
 */
export const OUTPUT_FILE = 'intake-proposto.json';

/**
 * The session's role and its hard rules, for `SessionSpec.instructions`.
 *
 * Separate from the prompt because the `EngineAdapter` contract is explicit that
 * the two are never concatenated by the caller
 * (`docs/formatos/engine-adapter.md`): what is stable across every intake belongs
 * here, what is specific to this request belongs in the prompt.
 */
export const INTAKE_INSTRUCTIONS = [
  'Você é o intake do cartografo: recebe UM pedido em linguagem natural e o quebra',
  'em tickets que vão atravessar um grafo já registrado.',
  '',
  'Você não cria trabalho e não confirma nada. O que você escreve é uma PROPOSTA de',
  'quebra: ela nasce como rascunho pendente, um humano revisa, e só a confirmação',
  'dele faz nascer ticket. Proponha algo que dê para revisar — quebra pequena',
  'demais vira burocracia, quebra grande demais esconde o trabalho de verdade.',
  '',
  `Escreva o resultado no arquivo \`${OUTPUT_FILE}\`, no diretório atual, com`,
  'exatamente esta forma e nada mais:',
  '',
  '```json',
  '{"items": [ ... ]}',
  '```',
  '',
  'Cada item tem esta forma:',
  '',
  '```json',
  '{"ref": "migracao",',
  ' "title": "Migração do intake",',
  ' "body": "O que precisa acontecer, em uma ou duas frases.",',
  ' "acceptance_criteria": ["a migração roda do zero"],',
  ' "tier": "standard",',
  ' "depends_on": ["dominio"]}',
  '```',
  '',
  'Regras duras:',
  '',
  '- `ref` e `title` são obrigatórios em todo item. `body`,',
  '  `acceptance_criteria`, `tier` e `depends_on` são opcionais;',
  '- `ref` é identidade LOCAL AO LOTE: ela existe só para um item citar outro, e',
  '  morre na confirmação, quando cada uma vira um id real. Nunca escreva id de',
  '  ticket que já existe, nem número: escreva um apelido curto e legível;',
  '- `depends_on` cita SOMENTE `ref` de itens deste mesmo lote. Dependência de',
  '  trabalho que já existe, ou de outro lote, não é suportada e reprova o lote',
  '  inteiro;',
  '- nenhum item depende de si mesmo, e as dependências não podem fechar ciclo.',
  '  Diamante pode (`a` depende de `b` e de `c`, os dois dependendo de `d`);',
  '  volta pode não (`a` → `b` → `a` reprova o lote);',
  '- dois itens nunca usam o mesmo `ref`;',
  '- `acceptance_criteria` só entra quando você SABE o critério. Se não sabe,',
  '  omita o campo — `null` não é `[]`. Lista vazia afirma "declarei que não há',
  '  critério", e quem refina depois precisa distinguir isso de "ninguém escreveu',
  '  ainda". Os critérios daqui são preliminares de qualquer forma: quem os produz',
  '  de verdade é o nó que refina, dentro do grafo;',
  '- `tier` é opcional e diz quanto o item CUSTA para fazer, não sua urgência e',
  '  nem sua importância. Só dois valores valem:',
  '  - `"trivial"`: rename, correção de typo, mudança só de documentação, ajuste',
  '    de configuração — trabalho sem decisão de design dentro dele;',
  '  - `"standard"`: qualquer outra coisa. Na dúvida, `"standard"`.',
  '  Omita o campo quando não der para dizer. Omitir é "ninguém classificou", e',
  '  isso NÃO é o mesmo que `"trivial"` — quem omite deixa a decisão em aberto,',
  '  quem escreve `"trivial"` afirma que o item é pequeno;',
  '- não edite mais nada no diretório, não rode git e não chame API nenhuma. Sua',
  '  saída é o arquivo, e o rascunho é gravado por quem despachou você.',
].join('\n');

/**
 * Assembles the prompt of one intake session: the request and the class.
 *
 * @param request The request in natural language, in the user's own words.
 * @param className The registered class the batch will run over.
 * @returns The prompt, ready for `SessionSpec.prompt`.
 */
export function buildIntakePrompt(request: string, className: string): string {
  return [
    '# Pedido',
    '',
    request,
    '',
    `# Classe registrada: \`${className}\``,
    '',
    'Os tickets deste lote vão atravessar o grafo desta classe. Ela já existe e é',
    'final: você não nomeia classe, não corrige o nome e não sugere outra.',
    '',
    '# O que devolver',
    '',
    `Escreva \`${OUTPUT_FILE}\` no diretório atual, com \`{"items": [ ... ]}\` e nada`,
    'além disso. Vale relembrar, porque é o que mais reprova lote:',
    '',
    '- `ref` e `title` em todo item, `ref` local ao lote e nunca um id real;',
    '- `depends_on` só com `ref` deste lote, sem citar a si mesmo e sem fechar',
    '  ciclo;',
    '- `acceptance_criteria` só quando houver critério de verdade — `null` não é',
    '  `[]`.',
    '',
    'Quebre pelo que o pedido realmente pede. Se ele já vem com as partes',
    'nomeadas, respeite-as; se não vem, prefira etapas que alguém consiga revisar',
    'uma a uma.',
  ].join('\n');
}
