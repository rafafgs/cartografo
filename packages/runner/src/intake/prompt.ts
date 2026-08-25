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
 * English, the prompt's own PROSE included (D24, t309). The payload KEYS it
 * teaches went English earlier, with t255, and for the same reason they had
 * been Portuguese before: they are the wire format of `POST /v1/intake`, not
 * identifiers of ours, so they move when that format moves. A prompt left
 * behind teaches a shape the validator refuses, and the session has no way of
 * finding that out.
 *
 * The prose took longer because of an exemption that has since been lifted:
 * agent instructions were held to be text a subprocess consumes rather than
 * text anybody reads. The paragraph four above — a contract that can only be
 * read by opening a session is a contract nobody reviews — is the argument
 * against it, and it was already written here.
 *
 * {@link OUTPUT_FILE} is the exception, and it is not prose: it is a name the
 * prompt teaches and `generate.ts` reads back, so it moves only when both sides
 * and the doc move together.
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
 * (`docs/formats/engine-adapter.md`): what is stable across every intake belongs
 * here, what is specific to this request belongs in the prompt.
 */
export const INTAKE_INSTRUCTIONS = [
  'You are the intake of cartografo: you take ONE request in natural language',
  'and break it into tickets that will cross an already registered graph.',
  '',
  'You create no work and confirm nothing. What you write is a PROPOSED break-up:',
  'it is born a pending draft, a human reviews it, and only their confirmation',
  'creates a ticket. Propose something that can be reviewed — too small a',
  'break-up turns into bureaucracy, too large a one hides the real work.',
  '',
  `Write the result to the file \`${OUTPUT_FILE}\`, in the current directory, with`,
  'exactly this shape and nothing else:',
  '',
  '```json',
  '{"items": [ ... ]}',
  '```',
  '',
  'Each item has this shape:',
  '',
  '```json',
  '{"ref": "migration",',
  ' "title": "Intake migration",',
  ' "body": "What has to happen, in one or two sentences.",',
  ' "acceptance_criteria": ["the migration runs from scratch"],',
  ' "tier": "standard",',
  ' "depends_on": ["domain"]}',
  '```',
  '',
  'Hard rules:',
  '',
  '- `ref` and `title` are required in every item. `body`,',
  '  `acceptance_criteria`, `tier` and `depends_on` are optional;',
  '- `ref` is identity LOCAL TO THE BATCH: it exists only so one item can cite',
  '  another, and it dies at confirmation, when each one becomes a real id. Never',
  '  write the id of a ticket that already exists, nor a number: write a short,',
  '  readable nickname;',
  '- `depends_on` cites ONLY the `ref` of items in this same batch. A dependency',
  '  on work that already exists, or on another batch, is not supported and fails',
  '  the whole batch;',
  '- no item depends on itself, and the dependencies cannot close a cycle. A',
  '  diamond is allowed (`a` depends on `b` and on `c`, both depending on `d`); a',
  '  loop back is not (`a` → `b` → `a` fails the batch);',
  '- two items never use the same `ref`;',
  '- `acceptance_criteria` goes in only when you KNOW the criterion. If you do',
  '  not, omit the field — `null` is not `[]`. An empty list asserts "it was',
  '  declared that there is no criterion", and whoever refines later has to tell',
  '  that apart from "nobody has written any yet". The criteria from here are',
  '  preliminary either way: what produces them for real is the node that',
  '  refines, inside the graph;',
  '- `tier` is optional and says how much the item COSTS to do, not how urgent it',
  '  is and not how important. Only two values hold:',
  '  - `"trivial"`: a rename, a typo fix, a documentation-only change, a',
  '    configuration tweak — work with no design decision inside it;',
  '  - `"standard"`: anything else. When in doubt, `"standard"`.',
  '  Omit the field when you cannot say. Omitting is "nobody classified it", and',
  '  that is NOT the same as `"trivial"` — omitting leaves the decision open,',
  '  writing `"trivial"` asserts that the item is small;',
  '- do not edit anything else in the directory, do not run git and do not call',
  '  any API. Your output is the file, and the draft is recorded by whoever',
  '  dispatched you.',
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
    '# The request',
    '',
    request,
    '',
    `# Registered class: \`${className}\``,
    '',
    'The tickets of this batch will cross the graph of this class. It already',
    'exists and it is final: you do not name a class, do not correct the name and',
    'do not suggest another.',
    '',
    '# What to hand back',
    '',
    `Write \`${OUTPUT_FILE}\` in the current directory, with \`{"items": [ ... ]}\``,
    'and nothing beyond that. Worth repeating, because it is what fails a batch',
    'most often:',
    '',
    '- `ref` and `title` in every item, `ref` local to the batch and never a real',
    '  id;',
    '- `depends_on` only with a `ref` from this batch, never citing itself and',
    '  never closing a cycle;',
    '- `acceptance_criteria` only when there is a real criterion — `null` is not',
    '  `[]`.',
    '',
    'Break it up along what the request actually asks for. If it already comes',
    'with the parts named, respect them; if it does not, prefer steps somebody can',
    'review one at a time.',
  ].join('\n');
}
