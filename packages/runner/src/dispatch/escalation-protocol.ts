/**
 * The three escalation paragraphs a session can be given, and nothing else
 * (t167, t223).
 *
 * Pure content: three frozen strings, no imports, no logic. They were written
 * inside `render-skill-instructions.ts` because that is the module that composes
 * them, and they left it for the reason t223 exists — that module was 616 lines
 * against a 600-line budget, and 77 of them were these literals. What moved is
 * the text; who decides which of the three a node gets is still
 * `escalationProtocol` over there, reading `resolve-node.ts`'s answer.
 *
 * They are re-exported by `render-skill-instructions.ts` and by `dispatch.ts`,
 * both unchanged: the split renames nothing, and the constant stays reachable
 * from everywhere it was already reached from.
 *
 * English, paragraphs included (D24, t309). They used to be Portuguese "like
 * every other text in this package that reaches a model" — the exemption that
 * covered every prompt here, on the grounds that a subprocess consumes them.
 * These three are the clearest case against it: they are the protocol by which
 * a session asks a person for a decision, so what they say is the product's
 * escalation behaviour, written out in full. A reader who wants to know how
 * this system escalates has nowhere else to look.
 */

/**
 * The escalation paragraph, which travels with EVERY instruction this runner
 * ever dispatches.
 *
 * It lives apart from `dispatch.ts` (which re-exports it, so the constant is
 * still reachable where `DEFAULT_INSTRUCTIONS` is) for one reason: the renderer
 * is the module that would have dropped it. A session that does not know how to
 * escalate never escalates, and the whole cycle t106 built — question, block,
 * answer, re-dispatch — would have gone quietly missing for exactly the jobs
 * t161 newly drove, the ones with a real graph behind them. Composing it into
 * both texts is what makes that impossible rather than unlikely.
 *
 * Unchanged from the literal it was extracted out of until t309, which
 * translated it; the wording, the fence and the five fields are the same.
 */
export const ESCALATION_PROTOCOL = [
  'When something the job does not settle blocks you, do NOT guess and do not',
  'sit waiting: end your turn with exactly ONE fenced block, and nothing after',
  'it:',
  '',
  '```input-request',
  '{"question": "<the decision you need, in one or two sentences>",',
  ' "context": "<the evidence, what you already tried, the alternatives>",',
  ' "options": ["<short label>", "<short label>"],',
  ' "recommendation": "<the action you would take, in the imperative>",',
  ' "default": "<the option that applies if the person simply accepts>"}',
  '```',
  '',
  'The control plane blocks the job, a person answers, and you are dispatched',
  'again — with the question and the answer already written into the prompt.',
  'There is no session resume: every dispatch is a new session that was told',
  'what happened before.',
].join('\n');

/**
 * What an `always` node is told, on top of {@link ESCALATION_PROTOCOL} (t167).
 *
 * It ADDS to the standard paragraph instead of replacing it: the block, the
 * fields and what happens after are identical — what changes is when the session
 * is expected to reach for it. A node declares `always` when the decision it
 * takes is one a person wants to see even when the session is sure, and "even
 * when you are sure" is the only sentence that carries that.
 *
 * Instruction and not enforcement, like every other line of these texts: whether
 * a session was actually certain is not machine-checkable, and pretending
 * otherwise would put a gate in front of a judgement nobody can make.
 */
export const ALWAYS_ESCALATION_PROTOCOL = [
  '**At this node, escalating is not a last resort.** Before closing the node,',
  'use the block above even if you think you know the answer: the decision at',
  'this node belongs to a person, and being sure does not stand in for going',
  'through them. If after looking there is no decision to take at all, then go',
  'ahead without asking.',
].join('\n');

/**
 * What a `never` node is told, INSTEAD of {@link ESCALATION_PROTOCOL} (t167).
 *
 * The one policy that replaces the paragraph rather than adding to it, and the
 * reason is not stylistic: at this node the runner turns an `input-request` into
 * an ordinary block, so a session handed the template would be writing a block
 * nobody will ever answer as a question. Giving it the fence and then ignoring
 * the fence is how a prompt starts lying about what the wiring does.
 *
 * What replaces it is the honest instruction: a wall here is a failure of THIS
 * node's own contract, and it is reported as one.
 */
export const NEVER_ESCALATION_PROTOCOL = [
  'This node has nobody to ask. There is no person waiting on the other side of',
  'it, so do not write a question block at all: it becomes a question for',
  'nobody, and waiting on it is waiting for an answer that never comes.',
  '',
  'If something the job does not settle blocks you, the contract of THIS node',
  'is what failed, and that is how you report it: end your turn saying, in the',
  'node result, what blocked you and why. Do not guess to fill the gap, and do',
  'not invent output — a node that could not meet its contract is a fact',
  'somebody needs to read, and the work stops here until somebody looks.',
].join('\n');
