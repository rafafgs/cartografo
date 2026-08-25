# What the cartografo is (the plain explanation)

> **Living document (D19).** This file explains the product in plain language,
> with no jargon, for whoever has just arrived. Every delivery that changes the
> product's visible behaviour updates this file in the same delivery.
> What already runs today is in the "How to run it" of `README.md`; what is
> still being built on the current board is marked here with *(under
> construction)*.

## In one sentence

A local, open server where you declare problems, get process maps with
verification gates, AI agents carry out the work under governance while you
handle the exceptions, and every map improves from version to version on the
strength of its own history.

## What you can do with it

**Install it and bring it up in one command.** `npx cartografo` creates the
local database and brings up the server; `npx cartografo-screen` opens the
interface. Everything on your machine; everything the screen shows comes from a
public API any tool can consume.

**Start from ready-made maps.** Factory graphs come in the box: the software
development one and the investment thesis one. Import one with a single command
and you already have a governed process.

**Declare a new problem and get a map** *(under construction: it is a terminal
command, not a flow on the screen)*. You describe the problem; the synthesizer
proposes a map using the registered skills; you edit it; the system validates it
formally; the map goes in registered and versioned. What is missing is the
packaging, not the piece: the synthesizer is a copilot you call by hand (`npm run
synthesize --workspace @cartografo/runner`), which writes a draft into a file and
stops there — the one who reads it, corrects it and registers it with
`cartografo import` is you, through the same formal validation gate every other
map goes through. What does not exist yet is "declare it on the screen and
receive the map" without going through the terminal.

**Edit the map yourself.** It is not only about approving what the evaluator
proposes: on the screen you can add a step, remove another, change who does what
and how that is verified, and connect or cut the paths between steps. What you
save does not become a map straight away — it becomes a proposal, which goes
through the same formal verification as ever and only lands if the resulting map
still holds up (every step reachable, every traversal ending, every path
labelled, every step with a contract). When it does not hold up, the screen says
which step or which path broke which rule, and nothing is written. Changing the
identity of a step that already exists is not possible: to do that, remove it and
create it again.

**Work comes in and crosses on its own.** You make a request; intake proposes the
breakdown into tickets and you confirm it. The tickets cross the map: CLI agents
carry out each step with instructions and contracts coming from the database,
gates verify every passage with evidence, and a decision that is not a machine's
arrives on the screen and waits for you. **Every step receives what the previous
ones produced** — the specification refinement wrote reaches whoever develops,
the branch development left reaches whoever integrates —, assembled by the
control plane out of what each session reported, and never by a file somebody
remembered to pass along. Every map decides which fields its tickets carry — an
investment thesis asks for the asset, the source of the assumption, the downside
and the upside, which a software ticket would have nowhere to keep — and a field
declared mandatory at a given step holds up the exit from that step until
somebody fills it in.

**Choose the engine and the model step by step.** Every step of the map can say
which CLI agent it runs on and with which model — the node that writes uses the
big model, the gate that checks uses a smaller and cheaper one. Whatever says
nothing runs on the default, and changing that choice is a proposal like any
other: it becomes a new version of the map, with evidence and with a way back.
The models each engine offers show up in the API, along with where the list came
from.

**Small work runs on a cheap model, without you choosing anything.** When it
proposes the breakdown, intake also says of every ticket whether it is small — a
rename, a typo, a documentation-only change — or real work. The classification
comes for free: it is the same session that was already reading the request. From
there on the small ticket crosses the whole map on a cheaper model, with nobody
choosing a model ticket by ticket, and a round with tickets of mixed sizes comes
out cheaper than one that treats them all alike. A ticket nobody classified runs
the way it always ran, and a step that fixed its own model still rules over it.
The classification changes what a ticket costs, never where it goes: the path
through the map is the same.

**Decide, step by step, when you want to be called.** Every step of the map says
how much it insists on talking to you: always (it calls before closing, even when
it thinks it knows), when it gets stuck (the default), or never — and then
getting stuck does not become a question in your queue, it becomes work halted
with the reason written down, for steps that run with nobody on the other side.
The step can also name who ought to be called, for when roles exist. Changing
that is a proposal like any other: a new version of the map is born, and it can
be undone. And the round's report shows how many questions each step asked.

**Stop insisting when insisting does not help.** A job whose sessions fail is not
retried forever: after three failures in a row at the same step it stops, with
the reason written down naming the step and the number of attempts — and the
number belongs to the map, so a class that wants more patience (or none) says so
in the map itself. And when the reason is the agent **refusing** the request
rather than getting it wrong, the job stops on the first attempt: a refusal is the
same answer every time, and trying again only burns a session. In both cases the
one who unblocks it is you, after looking at what the sessions said.

**Make the map raise a flag on its own when something happens.** A step of the
map can say "when a ticket arrives here, tell this address" or "when it gets
stuck here, call that one" — and the notice goes out signed, with retries, to the
service you name. The notice lives inside the map, and not in a configuration off
to the side: it travels with the map when you export it, it changes by proposal
like any other part of it, and it is undone together with the version that
introduced it. The key that signs the notice is the one thing that does not live
there: it is registered separately, and the map keeps only its name — a map is a
thing you publish, and a secret written on a map is a secret belonging to whoever
reads the map. If the destination does not answer, the ticket does not get stuck
— it carries on down its path, and the failed notice becomes a record you can
look at.

**Switch it off without leaving a trace.** What carries out the jobs is a
separate process, which you start and stop whenever you want. Asking it to stop
always ends: it stops picking up new work, gives what was already running some
time (two minutes, by default) to finish on its own and, once that time is spent
— or if you ask again —, closes the session in progress. No agent it started
carries on running after it leaves, and the interrupted work does not stay stuck:
it goes back to the queue and somebody picks it up again. The one exception is
killing the process by force, mid-cut (`kill -9`), which gives nobody a chance to
clean anything up — and even then the work returns to the queue on its own.

**See everything.** The board shows where every job is; every ticket has a
timeline (agent working, waiting on you, queueing); every question carries the
context to answer it without opening the repository; the history makes it
possible to reconstruct any execution.

**Build on top, without reading the code.** Everything the screen does goes
through a public API — and that API describes itself: the server publishes the
`/openapi.json` document and a browsable page at `/docs`, both generated from the
routes it really registers. It is not a hand-written document that ages: a new
route shows up there the same instant it comes into being. Whoever wants to
integrate another tool points a client at the document and already knows what
exists. The calls of the basic flow — register a map, create a ticket, answer a
question — already come with their input and output format written down; the rest
appear listed and gain a contract little by little. The document and the page ask
for no credential, because a schema is not data; everything that is data stays
behind the token.

**The map improves, with your hand at the gate.** After a round, an evaluator
reads the history and deposits proposals in your inbox, each one with the diff,
the evidence and the metric it expects to move. You approve, and the new version
is born. There are two evaluators: the flow one (where the round spent time) and
the cost one (tokens and time per node). Both are called by hand — `npx
cost-surveyor evaluate …` —, and now on their own as well, if you let them.
Projects that diverge get a variant of the map of their own, and what the variant
learns goes back to the base map as a proposal, through the same gate.

**The map watches on its own.** `npx cartografo-surveyor watch …` listens to the
control plane and, every time a round ends, runs both lenses over it with nobody
typing anything. You still switch the observer on — it does not come up with the
system —, but after that the inbox fills up on its own. Running twice over the
same round does not duplicate a proposal: the one that deduplicates is the
control plane.

**The map improving on its own** *(under construction)*. What is missing is the
ladder's top step, and it is the one about deciding, not the one about looking:
**applying** a proposal without you still does not exist, automatically measuring
whether a proposal's hypothesis was confirmed in the following round does not
either (today the one that closes the experiment is an explicit call, and it
demands execution evidence), and turning a repeated answer into an automatic
answer likewise — the API already knows how to list a question's precedents, but
nobody reads them to answer for you. Meanwhile, no change to a map happens
without an approval of yours, which is the order the safety ladder asks for.

**Share what it learned.** Any map exports as a file, with every step's contract
inside and the skills pinned by hash; it imports into another cartografo and
produces exactly the same version, because the id of a version is the canonical
hash of the document. One caveat worth knowing: the skills' INSTRUCTIONS do not
travel in that file — it carries the pin (id, version and hash) that identifies
each one. Whoever wants to take the instructions along takes the map's folder,
with `graph.json` and `skills/` side by side, which is the format the factory maps
use and which `import` also accepts.

Improving a step's instructions is not a dead end: the versions of a skill coexist
in the registry, so the new version lands beside the old one instead of
overwriting it, and no map already running changes behaviour because somebody
published something better. Pointing a step at the new version is a proposal like
any other change to a map — with your approval, and refused out of hand if that
version does not exist in the registry.

## What it deliberately is not

It is not SaaS and not multi-user; the evolution never applies anything without
human approval; and it only serves work where the contract of each step can be
written down. Where no verification is possible the map would be decorative, and
we would rather say so on the packaging.

## The minimal vocabulary

- **Map (graph)**: the drawing of the process for one kind of problem; steps
  (nodes), paths (edges) and verifications (gates). Versioned like commits.
- **Ticket (traveller)**: one unit of work crossing the map.
- **Skill**: the instructions and the contract of a step (what goes in, what
  comes out, how it is verified).
- **Gate**: the verification between steps; deterministic where it can be (a
  command), with judgement where it must be (an agent with evidence).
- **Proposal**: a suggested change to the map, with evidence and a metric; a
  hypothesis you approve or reject.
- **Topografo**: the evaluator that reads the history and writes proposals.
