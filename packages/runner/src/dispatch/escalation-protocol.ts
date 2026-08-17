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
 * English per D18. The paragraphs themselves are Portuguese, like every other
 * text in this package that reaches a model.
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
 * The text is unchanged from the literal it was extracted out of.
 */
export const ESCALATION_PROTOCOL = [
  'Quando alguma coisa que o trabalho não resolve travar você, NÃO chute e não',
  'fique esperando: termine seu turno com exatamente UM bloco cercado, e nada',
  'depois dele:',
  '',
  '```input-request',
  '{"question": "<a decisão que você precisa, em uma ou duas frases>",',
  ' "context": "<a evidência, o que você já tentou, as alternativas>",',
  ' "options": ["<rótulo curto>", "<rótulo curto>"],',
  ' "recommendation": "<a ação que você tomaria, no imperativo>",',
  ' "default": "<a opção que vale se a pessoa simplesmente aceitar>"}',
  '```',
  '',
  'O control plane bloqueia o trabalho, uma pessoa responde, e você é despachado',
  'de novo — com a pergunta e a resposta já escritas no prompt. Não existe',
  'retomada de sessão: cada despacho é uma sessão nova que foi informada do que',
  'aconteceu antes.',
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
  '**Neste nó, escalar não é último recurso.** Antes de fechar o nó, use o bloco',
  'acima mesmo que você ache que sabe a resposta: a decisão deste nó é de uma',
  'pessoa, e a sua convicção não substitui a passagem por ela. Se depois de',
  'olhar não houver decisão nenhuma a tomar, aí sim siga sem perguntar.',
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
  'Este nó não tem a quem perguntar. Não existe pessoa esperando do outro lado',
  'dele, então não escreva bloco de pergunta nenhum: ele não vira pergunta para',
  'ninguém, e ficar esperando resposta é esperar por uma resposta que não vem.',
  '',
  'Se alguma coisa que o trabalho não resolve travar você, isso é falha do',
  'contrato DESTE nó, e é assim que se relata: termine seu turno dizendo, no',
  'resultado do nó, o que travou e por quê. Não chute para preencher, e não',
  'invente saída — um nó que não conseguiu cumprir o contrato dele é um fato',
  'que alguém precisa ler, e o trabalho para aqui até alguém olhar.',
].join('\n');
