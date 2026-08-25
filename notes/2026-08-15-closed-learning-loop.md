# The learning loop, closed once end to end (t165)

**When:** 2026-08-15 · **Graph:** `desenvolvimento-de-software` ·
**Database:** persistent, the `.cartografo/cartografo.db` of the ficha's checkout ·
**Engine:** the real `claude` (2.1.233), 11 sessions, none of them simulated.

Principle 5 of the README — propose, pass a gate, apply, measure, close — is the
product. Until this ficha it had never gone round once completely: `t110`
proposed, `t111` designed the inbox against routes that did not exist, `t112`
knew how to close an experiment nobody had opened. This note records the first
complete turn, with a number at every step.

## The turn

| Step | What ran | Result |
|---|---|---|
| Round 1 | `npm run traverse` over the 5 nodes, execution **1651** | 5 `concluida` sessions, 15 events, a `trabalho` with a `grafo_versao_id` |
| Proposal | `npm run surveyor -- 1651` | proposal **1**, `pendente`, the bottleneck at `refinar`, evidence citing events 2 and 3 |
| Gate | the screen: **Approve** | `pendente` → `aprovada` |
| Application | the screen: **Apply** | version `sha256:666feb7b…`, `versao_pai` = `sha256:5e506c31…`, the pointer moved |
| Round 2 | `npm run traverse` on the new version, execution **1653** | 5 `concluida` sessions, 16 events |
| Closing | `npm run close-outcome -- 1 1653` | `{"veredito":"piorou","antes":29112,"depois":31273}` |
| Reversion | the screen: **Revert** with a reason | the pointer back, the abandoned version **still listed**, `resultado` intact |
| Rejection | `surveyor -- 1653` → proposal **2** → the screen: **Reject** | `motivo_rejeicao` recorded, `resultado` still `null` |

The task of both rounds was the same one, and a real one: specify, implement,
test and "deploy" a Node utility that counts dates by day of the week. Both
`parecer.md` came out `aprovado`, with a genuinely green `node --test`.

## What the turn taught, and no test could have taught

**The hypothesis made things worse, and that is the system working.** The
topografo bet that shortening the description of the `refinar` node would bring
`tempo_agente_ms:refinar` down from 29112 to 23290. It measured 31273 on the
following round — it went up. The verdict came out of the control plane, from
two numbers anybody can redo from the log, and it is what justified the
reversion. A turn that confirmed the hypothesis on the first attempt would have
proved less: the value of the cycle is measuring, not being right.

**One round is not a measurement.** `de` and `depois` here are from ONE traversal
each. The natural variation between two sessions of the same node is on the order
of seconds (31s against 29s), and nothing in this cycle separates "the change
made it worse" from "the session took longer this time". The verdict is honest
about what it compares; whoever is going to use it to decide needs more than one
traversal per version, and that does not exist.

**`Controller.tick()` picks up the first RELEASED job, not yours.** In a
disposable database, like the spikes', there is only one job and the distinction
disappears. In this one, round 2 opened five real sessions on round 1's job —
which was still sitting there, unblocked, on the last node — and the whole log
landed on the wrong execution, at the wrong node. There is no server signal to
filter on: `concluido` becomes true the instant the job ARRIVES at a final node,
before that node's session runs, so filtering by it would skip the last node of
every traversal. Ending a job for good is `t109`'s. For now the driver refuses to
start with somebody else's released job in the queue and blocks its own on
finishing.

**Rebuilding a table in SQLite with something pointing at it.** `PRAGMA
defer_foreign_keys` — the obvious remedy for the implicit DELETE of a
`DROP TABLE` — does not solve it: the deferred-violation counter goes up on the
drop and the `RENAME` does not bring it down. A database with a single applied
proposal would not migrate. `0010` keeps the child references, zeroes them before
the drop and restores them after the rename.
