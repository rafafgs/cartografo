# Is this graph engineering or loop engineering? (2026-08-14)

An objection Rafael raised while iterating on the idea; it is also the number-one
objection to expect once the project is public. Recorded here with the answer.

## The objection

cartografo's evolution cycle (synthesize → execute → evaluate → propose → apply →
repeat) has the shape of a loop. Does that not make the project loop engineering
with extra steps?

## The answer

**The execution layer is graph engineering without ambiguity**: a frozen
topology, distinct roles, conditional gates, explicit state, cycles and exits.
The loops that exist there (re-dispatch, re-test) are cycles of the graph,
criterion 4, not a regression.

**The smell of a loop comes from the evolution layer, and the difference is in
what the cycle carries.** In loop engineering, the loop carries *attempts*: it
iterates in flight until a passing condition, every iteration is disposable, and
when one passes the earlier ones become rubbish; what improves is the artifact of
that round, and the next process starts from zero. In cartografo, the cycle
carries *versions*: it runs between executions (not inside one), every turn
produces a graph v(n+1) with a diff against v(n), justified by real telemetry
from v(n); nothing is discarded, everything is auditable and reversible; the one
who decides "better" is a human at a gate, not a computed condition; and what
improves is the process of the next executions. A loop carries attempts;
cartografo carries versions.

**The structural argument**: the meta-process passes the test of the four
criteria. Distinct roles (synthesizer, validator, topografo, human); a
conditional edge (the validation gate can reject the synthesized graph); explicit
state (graphs versioned in the database); cycles and exits (a rejected proposal
goes back, an approved one applies, a rollback exists). The meta-process is
itself a small fixed graph whose travellers are graphs. The perceived "loop" is
the cycle edge of that meta-graph. It is graphs all the way down; the recursion
closes.

**The theoretical name for the distinction**: single-loop learning corrects the
action within the rules (gates during the execution; it is what loop engineering
automates); double-loop learning revises the rules themselves (the topografo
proposing a change of topology). cartografo is double-loop over the graph — a
team's retrospective, automated, with the versioning rigour a human
retrospective does not have.

## The two modes of degeneration (and the decisions that block them)

1. **Regenerating the topology per execution until it works** (the AgentConductor
   pattern: regenerate the YAML until success or until the budget blows) — it
   treats the graph as a draft to iterate on. Blocked by principle 2 and by D2:
   frozen during, versioned between.
2. **Auto-applied proposals optimizing a single metric** (a DSPy-style compile
   loop) — it reduces the graph to a vector of parameters. Blocked by principle
   5: the human defines "better" before any auto-application.

If either of those two barriers falls, the project really does become loop
engineering — and loses both the governance and the differentiator.
