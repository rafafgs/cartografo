/**
 * The fields a problem class declares on its own tickets (t168).
 *
 * The DEFINITION lives in the class's graph document (`custom_fields`), never in
 * the `trabalho` schema: `downside`, `upside` and `premise_source` are the
 * vocabulary of asymmetric bets (D14) and mean nothing in software delivery, so
 * a column per class would be a migration per problem class. The VALUES live in
 * `trabalho.campos`, a JSON object like `criterios_de_aceite` beside it.
 *
 * A pure module, with no `Database` and no clock, in the spirit of
 * `domain/graph.ts` and `domain/intake.ts`: "is this ticket allowed to leave
 * this node?" is a structural question over two pieces of data, and keeping it
 * here is what lets the transition route enforce it as a DETERMINISTIC gate
 * (D9) — no session, no runner, no template engine — and what lets a test ask
 * the same question without a server.
 *
 * What is deliberately NOT here (t168, Out of Scope): checking a value against
 * its field's declared `type` (`type` is metadata in v1, the same posture the
 * skill manifest takes with `budgets`), and validating the definitions
 * themselves — a `required_at` naming a node that does not exist fails inertly,
 * because a node nobody stands on never demands anything.
 *
 * The field NAMES are wire vocabulary: they come out of the class's document and
 * go into the 400's `details` exactly as the class wrote them. The code around
 * them is English.
 */

/** One declaration, as `custom_fields` of the graph document carries it. */
export interface CustomFieldDefinition {
  /** Key inside `trabalho.campos`, snake_case. */
  name: string;
  /** Declared type of the value. Metadata in v1 — nothing checks against it yet. */
  type: 'string' | 'number' | 'boolean';
  /**
   * Node that demands the field filled in, or `null` when nobody does.
   *
   * `null` and not absent: the key is required in the document, so "informative
   * field" is a decision somebody wrote down, not a line somebody forgot.
   */
  required_at: string | null;
  description?: string;
}

/** The values themselves: a flat map of what a person can type. */
export type ScalarMap = Record<string, string | number | boolean>;

/**
 * Is this a flat object of string/number/boolean?
 *
 * `null` as a VALUE is refused on purpose: "the field exists and holds nothing"
 * is the same fact as "nobody filled it", and letting the two into the database
 * as different states would give the gate below two ways of being empty.
 *
 * @param value Anything, straight off a request body.
 * @returns Whether it is a well-shaped map of scalars.
 */
export function isScalarMap(value: unknown): value is ScalarMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (entry) =>
      typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean',
  );
}

/**
 * The fields a node demands and this ticket does not carry.
 *
 * Emptiness is `undefined`/`null` and nothing else: `false` and `0` are FILLED
 * values, and a truthiness test here would go on demanding the field from
 * whoever answered "no" or "nothing" — the classic way a gate like this starts
 * lying about what it checked.
 *
 * @param definitions What the class declared; `undefined` for a graph version
 *   written before this feature existed, which then demands nothing.
 * @param nodeId Node the ticket is about to leave.
 * @param fields The ticket's `campos`, as they are stored.
 * @returns Names of the missing fields, in declaration order. Empty means the
 *   ticket may cross.
 */
export function missingRequiredFields(
  definitions: readonly CustomFieldDefinition[] | undefined,
  nodeId: string,
  fields: Record<string, unknown> | null | undefined,
): string[] {
  if (!Array.isArray(definitions)) return [];

  return definitions
    .filter((definition) => definition?.required_at === nodeId)
    .map((definition) => definition.name)
    .filter((name) => fields === null || fields === undefined || isAbsent(fields[name]));
}

const isAbsent = (value: unknown): boolean => value === undefined || value === null;
