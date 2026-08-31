# EngineAdapter — v1 specification

> **Status:** v1, **frozen**. The rule of two consumers
> (`notes/2026-08-14-extension-and-quality.md:58-64`) demands two *implemented*
> adapters before a format is locked, and both exist:
> `packages/runner/src/engine/claude-code-adapter.ts` and
> `packages/runner/src/engine/codex-adapter.ts`, each certified by the
> kit's cases against the fake engine — seven at the freeze, nine since the
> inactivity watchdog added C9, ten since session continuation added C10
>, eleven since a prompt too big for the argv added C11.
>
> **Gap recorded at the freeze:** the manual proof of the Codex adapter
> against the real CLI ran as far as the 401 — the machine has no OpenAI
> credential (`codex doctor`: "no Codex credentials were found") — so its
> credentialed half, the one that demands that the session *did work*, is
> pending a run with `OPENAI_API_KEY`. What the uncredentialed run already
> proved is in the script of
> `packages/runner/scripts/spike-real-session-codex.mjs`; the freeze stands on
> the C1–C7 certification, which is green.
>
> **Gap CLOSED (2026-08-15).** The credential turned up and
> `spike-real-session-codex.mjs` ran, without a line changed in its body,
> against an authenticated `codex-cli 0.147.0`: a `completed` session with exit
> 0 in 11.8s, `onEngineRef` receiving the `thread_id` of the `thread.started`
> frame (`01a00665-7730-…`), both events validating against the taxonomy's
> schemas and — the half that was missing — `PROVA-T119.md` created in the
> workdir with exactly the sentence asked for. The session *worked*. Along with
> it ran `scripts/spike-two-engine-traversal.mjs`: one graph, one
> job, two `Controller.tick()`s, `redigir` on `claude-code` and `conferir` on
> `codex`, each `session.opened` recording its own engine and the Codex node
> reading the file the Claude node wrote.
>
> Two things the credentialed run measured that were written down nowhere —
> neither of them changes the interface, both change what an operator has to
> prepare:
>
> - **Of the three credential variables, only `CODEX_API_KEY` really
>   authenticates.** A measurement of what `codex doctor` REPORTS about each one
>   (`codex-adapter.ts`, `CODEX_CREDENTIAL_VARIABLES`); what was missing was
>   running a session with each and seeing which of them actually closes the
>   handshake. `OPENAI_API_KEY` exported and nothing else — which was the path
>   this ticket assumed — makes every turn die at
>   `401 Unauthorized ... wss://api.openai.com/v1/responses`, consistent with the
>   `auth mode none` already noted for it. With the SAME key exported as
>   `CODEX_API_KEY`, and a `CODEX_HOME` with no `auth.json` at all, the session
>   comes up and completes. Both proofs of this ticket ran that way: environment
>   only, no `codex login`, no credential in any file.
> - **`codex exec` runs in a read-only sandbox by default.** The session politely
>   answers that the environment is read-only, exits 0 and produces no file at
>   all — the most dangerous outcome there is for a proof that only looks at the
>   exit code. Writing demands `sandbox_mode = "workspace-write"` in
>   `CODEX_HOME`'s `config.toml`. `buildCommand` still passes no sandbox flag, on
>   purpose: touching that would rewrite the argv of an adapter already certified
>   on C1–C7.
>
> What authorizes the freeze is not the count, it is what the count is there to
> measure: building the second adapter **demanded no change at all** to the
> interface or to the kit. `CodexAdapter` came in through the interface as it
> stood and reused `src/engine/conformance-kit.ts` and
> `test/fixtures/fake-engine.mjs` with no copy and no edit — the hypothesis the
> rule of two consumers orders tested before locking, tested.
>
> Frozen means additive from here on: a new field comes in optional (that is what
> `EngineCapabilities` being wholly optional is for), and a published symbol does
> not change its name or its shape without a recorded decision. The growths under
> that rule, in order, each one optional and touching none of the symbols that
> already existed:
>
> - **`SessionSpec.permissions`** — a declared permission policy, with the
>   adapter applying what it can and refusing what it cannot.
> - **`SessionSpec.silenceSeconds` and `onFinished`'s third argument** —
>   the second watchdog, and the cause beside the status.
> - **`SessionSpec.model`, `listModels()`, `EngineModel` and `ModelCatalog`**
>   — the model pinned per node, and the catalogue each adapter publishes.
>   The first growth that added a METHOD, and therefore optional in the member
>   itself (`listModels?()`), not only in the fields.
> - **`SessionSpec.resumeFrom`** — continuing an earlier session from the
>   `engineRef` `onEngineRef` was already capturing. It is the growth that gave a
>   consumer to a capability declared and never implemented: `claude-code`
>   started declaring `hasResume`, `codex` still refuses the field at the door,
>   and C10 certifies both sides.
>
> Where the feasibility analysis below and "Out of scope (v0)" disagree, **the
> scope decision is the one that holds**: the table is an exploratory survey of a
> CLI, not a promise of surface. The live case is still `hasResume`, now only on
> the Codex side — `codex exec resume` exists, the table suggests declaring it,
> and that adapter still does not declare it, because there resume is a
> **subcommand** that replaces `exec` in the argv, and not a flag added to it: a
> different mechanism, a ticket of its own.
>
> **This document's gate:** `scripts/check-engine-adapter-spec.sh`. It checks
> structure and syntax (the headings, the kit's coverage, the source citation,
> and that every `typescript` block in here compiles under `tsc --strict`).
> Architectural judgement is a human gate.

## Why this interface exists

Flowpilot's `engine` is a field; in the cartografo it is an interface —
"EngineAdapter (open a session with prompt/workdir/skills/timeout), follow the
output, harvest the exit. Claude Code is the first adapter, not a dependency"
(`notes/2026-08-14-architecture-brain-dump.md:11-14`). It is one of the four
formats treated as a product (`:17` of the extension note), and what holds up its
quality when a third party plugs in a new CLI is this specification's
**conformance kit**, not the goodwill of whoever implements it.

Three boundaries are worth more than any detail below:

1. **No engine vocabulary above this line.** A binary's name, a flag, an
   environment variable and a frame's format are each adapter's private business.
   Whoever is above speaks `SessionSpec`, `SessionStatus` and `SessionListener`,
   and nothing else.
2. **The listener is the only way out.** The adapter does not write to the
   database (D1), does not call the API and persists nothing: it reports, and
   whoever called it decides what to do with that. It is what keeps the runner
   stateless and the server the only writer.
3. **Depend on the minimum, explore the maximum.** The baseline is a CLI that
   takes a prompt, runs commands and returns output. Every capability beyond that
   is offered where it exists, never demanded.

## The TypeScript interface

The stack is fixed by D17 (TypeScript, a CLI subprocess). Everything here is a
type declaration — this repository is pre-code, and the implementation is a
future ticket in D6's order.

### Session status

A union of string literals, not an enum: the value persists in a text column and
crosses JSON in the API with no translation, and adding a member is not a
migration.

```typescript
/**
 * The life cycle of an agent session, in the minimal vocabulary every headless
 * CLI can express.
 *
 * `timed_out` exists separately from `failed` because the operational answer is
 * another one: it was WE who killed the session when the clock ran out, and the
 * retry ladder can react to that without treating it as a bug in the work.
 * Statuses specific to one engine (quota exhausted, expired resume) do NOT enter
 * the baseline — they are an extension belonging to whoever has them, and a
 * consumer that branches on them has already broken boundary 1.
 */
export type SessionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

/** The statuses from which nothing transitions further without a new action. */
export const TERMINAL_STATUSES: readonly SessionStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "timed_out",
];

export function isTerminal(status: SessionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
```

### What is asked of an engine

```typescript
/** Everything an engine needs in order to run one unit of work. */
export interface SessionSpec {
  /** The directory the session runs in (typically a git worktree). */
  readonly workingDir: string;

  /**
   * The node's instructions, coming from the database. It is the node's
   * contract rendered — "the node's instructions come out of the database and
   * are injected into the session by the runner"
   * (`notes/2026-08-14-architecture-brain-dump.md:17-20`). They never come out
   * of CLAUDE.md or of a markdown file resident in the target repository.
   */
  readonly instructions: string;

  /** The content specific to this task/turn. See the normative rule below. */
  readonly prompt: string;

  /** The wall-clock limit; past it the session is killed. */
  readonly timeoutSeconds: number;

  /**
   * The seconds of SILENCE tolerated before the session is killed — a second
   * watchdog, independent of the wall clock, and measuring something else: the
   * clock says "this has already cost too much", inactivity says "this stopped
   * happening". It restarts on every output from the process, so a session that
   * talks is never killed by it.
   *
   * Absent or `<= 0` means no inactivity watchdog, which is the same posture the
   * wall clock already has through its own `> 0` guard, and the behaviour of
   * every session opened before this field existed.
   */
  readonly silenceSeconds?: number;

  /**
   * The `engineRef` of an earlier session, to be continued rather than started
   * from scratch — the same opaque string `onEngineRef` reported for it.
   *
   * Absent (or empty) means a brand-new session, which is the behaviour of every
   * session opened before this field existed. Present means the caller is asking
   * for that session's context back, and an adapter that cannot do it has to
   * REFUSE before opening — the same honesty rule as `permissions` below. Losing
   * this field in silence is the one failure nobody downstream can detect: a
   * session that continued nothing is identical, from outside, to one that
   * continued.
   *
   * What continuing demands beyond the ref is the engine's business, and it is
   * not always the ref alone. Measured on `claude-code` (see "Adjustments
   * made in review", item 7): there the ref is enough, and the `workingDir` does
   * not take part.
   */
  readonly resumeFrom?: string;

  /**
   * Which model of the engine runs this session, when the node pinned one.
   *
   * Absent means the ENGINE'S OWN default: no model flag is assembled, and the
   * argv comes out identical to the one before this field existed — the same
   * discipline as `silenceSeconds` and `permissions`. It is the only honest
   * default: this layer has no way of knowing which models an installation has
   * access to, and inventing one here would put into the telemetry a choice
   * nobody made.
   *
   * An unknown or mistyped id is refused by the engine itself, when the session
   * opens, as a `SessionStartError` or a session that fails. `listModels()`'s
   * catalogue is discovery, never a gate.
   */
  readonly model?: string;

  /**
   * How much this work COSTS to run, as intake triaged it.
   *
   * It is not `model` under another name, and the difference is one of layer.
   * `model` is the id the GRAPH fixed for this node: engine vocabulary, crossing
   * the boundary because a graph document wrote it. `modelTier` is THIS
   * interface's vocabulary — two values of ours — and it is the adapter that
   * answers, each in its own language, how much "trivial" costs on it. It is
   * what lets the runner ask for the cheap one without ever knowing which the
   * cheap model of any CLI is.
   *
   * **`model` beats `modelTier`.** When both arrive, the adapter assembles ONE
   * model flag, and the value is `model`'s: a model id is a decision somebody
   * recorded in a graph document, and a triage heuristic does not override a
   * recorded decision. Assembling both would be an argv with two model flags,
   * which is not a preference — it is a broken command.
   *
   * Absent is "no triage", and it is the behaviour of every session opened
   * before this field existed. `standard` assembles no flag either: it states
   * "the engine's default serves", which is a different sentence from "nobody
   * classified this" and produces the same argv on purpose — the closed pair
   * exists so that the triage can say both things, not so that the adapter acts
   * on both.
   *
   * The set is closed, unlike `model`'s: a third value here is not new data some
   * engine understands, it is an error by whoever wrote it.
   */
  readonly modelTier?: 'trivial' | 'standard';

  /**
   * Opaque additions to the engine process's environment. Deliberately untyped
   * from this layer's point of view: what the keys mean is the engine's
   * business.
   */
  readonly envOverrides?: Readonly<Record<string, string>>;

  /**
   * What this session may touch. Absent = no restriction, which is the
   * behaviour of every session opened before this field existed.
   */
  readonly permissions?: SessionPermissions;
}
```

### Normative rule: `instructions` and `prompt` never arrive concatenated

**The caller never concatenates the two fields.** It hands both over separately
and each adapter decides how it injects them — "the engine's flag/stdin/ephemeral
file" (`notes/2026-08-14-architecture-brain-dump.md:17-18`).

This is not type fussiness: the feasibility review below measured the divergence.
Claude Code has native `--system-prompt` and `--append-system-prompt`; `codex
exec` has no system prompt flag at all, and resolves an instruction through an
`AGENTS.md` in the workdir or through the `base_instructions` configuration key.
A `SessionSpec` with a single `prompt` field would already have taken, in the
caller and with no review, the decision that all injection is string
concatenation — and would have erased the difference precisely on the engine that
does it better.

```typescript
/**
 * An engine with no native system prompt: the adapter concatenates internally
 * (equivalent to what flowpilot does today). The caller never sees it.
 */
export function composeSingleArgument(spec: SessionSpec): string {
  return `${spec.instructions}\n\n---\n\n${spec.prompt}`;
}

/**
 * An engine with a native flag: the instructions become a system prompt and the
 * prompt goes in clean. The same `SessionSpec`, a better injection — with the
 * caller knowing nothing about it.
 */
export function composeWithSystemPromptFlag(spec: SessionSpec): string[] {
  return ["--system-prompt", spec.instructions, spec.prompt];
}
```

A corollary for the kit: the skill injection case is verified by what the
**engine's process actually received**, never by what was assembled in the
`SessionSpec` — checking the spec would be testing the test.

### The session's permissions

This is the field tension 1 of this specification recorded as missing and left
"for D4's ticket". It is **additive and optional**, for the capabilities'
own compatibility reason: a third party's adapter that builds the `SessionSpec`
literally cannot stop compiling because a permission policy came into being.

```typescript
export interface SessionPermissions {
  readonly filesystem: { readonly write: readonly string[] };
  readonly network: { readonly allowed: boolean; readonly domains?: readonly string[] };
}
```

The vocabulary comes from the skill manifest (`permissoes.filesystem.escrita`,
`permissoes.rede`), with one deliberate absence:
`permissoes.filesystem.leitura` has **no** counterpart here. Neither of the two
analysed engines restricts reading below the workspace without breaking an
ordinary skill, and declaring a field no adapter applies would be the dead
capability the rejection of `hasNativeSystemPrompt` already refused once.

**What an adapter does with this is its own business — including refusing.** An
engine that cannot express the requested policy has to say so BEFORE opening the
session, with `SessionStartError`; opening a session that silently applies less
than was asked for is the outcome this interface forbids. The caller is left with
three possible answers, all of them honest: the session comes up with the policy
applied, the session comes up with no restriction (the policy is absent), or the
session does not come up.

**The state today, with no make-up:** **both** adapters read this field, each
with the mechanism its engine has. It was not always so: the
`CodexAdapter` **ignored** the field — it neither applied nor refused — and in
that state it did not honour the rule of the paragraph above. It was tolerable
only while nothing populated `permissions`, and that stopped holding,
when `render-skill-instructions.ts` started deriving the policy from the
registered skill's manifest and the dispatch started handing it to whichever
engine the node resolved to — `codex` included. The ticket that closed the hole
is what followed the answer this paragraph had already foreseen: **not**
to reuse `claude-code`'s gating by tool name, but to map both axes onto the
native `-s, --sandbox`, which is a guarantee of another nature (see tension 1).

#### What the reference adapter guarantees

`claude-code` has no OS sandbox (there is no equivalent to `codex exec`'s
`-s, --sandbox`); what exists is **gating by tool name** (`--disallowedTools`,
with the `"Bash(git *)"` pattern documented in `claude --help` itself). Each
axis, and what happens to it:

| Declared policy | Outcome | How |
|---|---|---|
| `rede.permitido: true` with no `dominios` | passes straight through | nothing to apply |
| `rede.permitido: true` with `dominios` | **refused** | an allowlist by domain would demand an egress proxy, which the engine does not have |
| `rede.permitido: false` | applied | denies `WebFetch`, `WebSearch` and the patterns `Bash(curl *)`, `Bash(wget *)`, `Bash(nc *)`, `Bash(netcat *)`, `Bash(ssh *)`, `Bash(scp *)`, `Bash(telnet *)` |
| `escrita: []` | applied | denies `Edit`, `Write`, `NotebookEdit` |
| `escrita: ["**"]` | passes straight through | the whole workspace is writable |
| a narrower `escrita` | **refused** | translating a glob into a fine-grained tool rule is a future ticket |

**The residual gap, written down because it exists.** `Bash` is still a path to
the network and to writing that no list of names closes completely: `python -c`,
a script from the repository itself or a utility the patterns above do not name
reach the network with the network policy "applied". This is *best-effort within
what the engine allows* — the ruler
`notes/2026-08-14-extension-and-quality.md:44-45` already fixed ("a sandbox where
the engine allows one") — and it is **not** process isolation. Really closing the
gap demands an OS sandbox per platform (`sandbox-exec`, a network namespace, a
container), which is a change of mechanism and a ticket of its own. Every denied
attempt becomes a `session.permission_denied` event in the log: what the gating
does not prevent, the telemetry at least records.

**Measured against the real CLI** (`claude 2.1.233`, script in
`packages/runner/scripts/spike-permission-enforcement.mjs`, run on 2026-08-15):

- an entry denied **by name** (`WebFetch`, `Write`, `Edit`) → the tool is simply
  **not offered** to the model. It appears in no `tool_use`, and therefore
  **generates no telemetry**: there is no attempt to record, there is a tool that
  never existed in that session;
- an entry denied **by pattern** (`Bash(curl *)`) → `Bash` stays available and
  the refusal happens on the call, with an error `tool_result`
  (`"Permission to use Bash with command curl … has been denied."`). **That is
  the case that produces `session.permission_denied`**, and it is the reason the
  tracker matches a pattern against the command, and not only a name against a
  name;
- the gap, confirmed on both axes: `node -e "fetch(…)"` brought back HTTP 200
  with the network "closed", and `printf > file` wrote into the workdir with
  `escrita: []`. Both went through `Bash`, which was available — as it has to be,
  on pain of the session being unable to work.

#### What the Codex adapter guarantees

Here the mechanism is another, and a stronger one: `codex exec` has
`-s, --sandbox <read-only|workspace-write|danger-full-access>`, a real OS
sandbox, and the network inside `workspace-write` is the configuration key
`sandbox_workspace_write.network_access`, passed per invocation with the CLI's
generic `-c, --config`. There is no gating by tool name at all: the two axes
become **one** sandbox mode, resolved in `codex-permission-policy.ts` — a module
of its own, sharing nothing with `claude-code`'s `permission-policy.ts`, for the
same reason `command.ts` and `codex-command.ts` are two.

| Declared policy | Outcome | How |
|---|---|---|
| `escrita: []` + `rede.permitido: false` | applied | `-s read-only` |
| `escrita: ["**"]` + `rede.permitido: false` | applied | `-s workspace-write -c sandbox_workspace_write.network_access=false` |
| `escrita: ["**"]` + `rede.permitido: true` with no `dominios` | applied | `-s workspace-write -c sandbox_workspace_write.network_access=true` |
| `escrita: []` + `rede.permitido: true` | **refused** | no sandbox mode combines closed writing with an open network (measured; see the table below) |
| a narrower `escrita` | **refused** | the modes are whole-workspace concessions; a glob in between has nowhere to land |
| `rede.permitido: true` with `dominios` | **refused** | the sandbox opens the network or closes the network, whole; an allowlist by domain would demand an egress proxy |

An absent `permissions` still means no flag at all in the argv — the CLI resolves
its own default, which is already `read-only`. `danger-full-access` is
**unreachable** by construction: no combination of the two axes selects it.

A refusal sums the reasons of both axes rather than stopping at the first, for
the reference adapter's own reason: a session refused for one reason, corrected,
and refused again for the other is a round trip that helps nobody. The
closed-writing-with-open-network combination is the only one that is **not** a
limitation of a single axis, and that is why it has a constant and a message of
its own — blaming one of the two fields would send the skill's author to fix what
is not the problem.

**Measured against the real CLI** (`codex-cli 0.147.0`, run on 2026-08-16 with
`codex sandbox`, which resolves the same configuration as the `exec`
subcommand):

| `sandbox_mode` | `network_access` | writing | network |
|---|---|---|---|
| `read-only` | `false` | blocked | blocked |
| `read-only` | `true` | blocked | **blocked** |
| `workspace-write` | `false` | allowed | blocked |
| `workspace-write` | `true` | allowed | allowed |

The second row is what decides the design: the key **has no effect** under
`read-only`. This answers, with a measurement rather than a reading of `--help`,
the question left open — there is no combination of closed writing with an
open network to ask for, and that is why it is refused instead of approximated.

**The residual gap, here too.** The sandbox is the OS's, so `Bash` is not the
back door it is on the other engine — the `python -c` hole and its relatives are
closed by mechanism, not by a list of names. What does **not** exist is
telemetry: `session.permission_denied` is fed by `parse-permission-denial.ts`,
which matches `claude-code` tool names against `tool_use`/`tool_result` frames. A
Codex sandbox denial is a signal of a completely different shape (stderr and the
process's exit code, not a tool-call frame), and the tracker as it stands records
**nothing** for this engine. That is outside this scope and is a piece of
own.

### Capabilities

```typescript
/**
 * What an engine does beyond the baseline.
 *
 * Every field is OPTIONAL by a compatibility decision: in a published format,
 * adding a mandatory flag breaks the compilation of every third-party adapter
 * that builds the object literally. Absent is `false` — the safe direction to
 * err in.
 *
 * `hasResume` gained a consumer (`SessionSpec.resumeFrom`) and
 * `reportsUsage` another (`SessionFinishDetail.usage`), down the same path: the
 * capability had been in the CLI all along, and what was missing was somebody to
 * read it. All three have a consumer now, and the rule that governed the three
 * still holds for the fourth — declaring the fourth, the fifth and the sixth
 * before anybody reads them is how a format rots.
 */
export interface EngineCapabilities {
  /**
   * Continues an earlier session from an `engineRef` — what
   * `SessionSpec.resumeFrom` asks for. An adapter that does not declare this has
   * to refuse that field, never ignore it.
   */
  readonly hasResume?: boolean;
  /** Emits machine-readable frames, not only text. */
  readonly hasStructuredOutput?: boolean;
  /** The output carries aggregatable token accounting. */
  readonly reportsUsage?: boolean;
}

/** The baseline: a CLI that only takes a prompt, runs commands and returns output. */
export const BASELINE_CAPABILITIES: Required<EngineCapabilities> = {
  hasResume: false,
  hasStructuredOutput: false,
  reportsUsage: false,
};

/** Normalizes what an adapter declared against the baseline. */
export function resolveCapabilities(
  declared: EngineCapabilities = {},
): Required<EngineCapabilities> {
  return {
    hasResume: declared.hasResume ?? false,
    hasStructuredOutput: declared.hasStructuredOutput ?? false,
    reportsUsage: declared.reportsUsage ?? false,
  };
}
```

### The listener

A callback, never a synchronous return: the session lasts minutes or hours, and
the consumer needs the output while it happens — it is what the telemetry D16
demands is made of.

```typescript
/**
 * A session's token totals, frozen at the end of its life.
 *
 * The four keys are exactly the ones the event taxonomy's `uso` has demanded
 * from the start — this type is the adapter's side of the same accounting, and the
 * equality of the names is what lets it cross from the interface to the log with
 * no translation in between. There is no field for cost in money: cost is engine
 * vocabulary, and the price ruler belongs to whoever has the table.
 *
 * **Four, and only four.** A real CLI reports far more than that in the terminal
 * frame (a service tier, a cache breakdown, iterations), and the log's contract
 * closes `additionalProperties`. Whoever implements this type CHOOSES the four;
 * an adapter that forwards the engine's whole object hands the consumer a
 * payload the control plane refuses.
 */
export interface SessionUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly cache_read_input_tokens: number;
}

/**
 * What the adapter knows about a terminal outcome beyond the status itself.
 *
 * It was born of a single fact, and deliberately narrow: with two watchdogs, a
 * `timed_out` stopped saying which of them bit. Growing `SessionStatus` instead
 * was rejected once already, for quota/limit states, and the reasoning holds
 * just the same — "the real reason lives in the event log, which is append-only
 * and loses nothing" (see *Rejected — a richer `SessionStatus`*). One status,
 * one cause beside it.
 *
 * It is also this frozen interface's additive growth point, and usage collected
 * on it: the two accounting fields below came in here without touching
 * `EngineAdapter`'s shape or `onFinished`'s signature.
 *
 * Optional in every direction: the parameter, each field, and what a consumer
 * does with them. An adapter with nothing to add reports two arguments, as it
 * always reported.
 */
export interface SessionFinishDetail {
  /**
   * Which watchdog stopped the session, when the one that decided to stop was
   * the adapter ITSELF.
   *
   * Absent on a `cancel()` conducted from outside: whoever cancelled knows their
   * own reason, and inventing one here would put into the telemetry a cause
   * nobody measured.
   */
  readonly timeoutReason?: "wall_clock" | "silence";

  /**
   * The tokens the session spent, when the engine reported them.
   *
   * Absent is "the engine did not count" — a session that died before the
   * terminal frame, a malformed frame, or a build of the CLI that does not carry
   * the count. An object of zeros in place of the absence is the one forbidden
   * reading: zero is a measurement, absence is silence, and putting the two
   * together destroys the whole cost metric (the same rule the taxonomy's `uso`
   * has carried from the start).
   */
  readonly usage?: SessionUsage;

  /**
   * Which models ran the session, when the engine named them.
   *
   * A list, and not a single identifier, because a session runs more than one
   * model: measured against the real CLI, a single turn already returned two —
   * the main turn's and a cheaper auxiliary's. Collapsing into "the" model would
   * attribute the whole bill to the wrong one, which is the same error the rule
   * above forbids for tokens.
   *
   * Absent follows `usage`'s discipline; an empty list is not an answer.
   */
  readonly models?: readonly string[];

  /**
   * What KIND of failure this was, when the engine said something the status
   * cannot carry.
   *
   * The third use of this interface's additive growth point, and it is here for
   * the same reason `timeoutReason` is: `failed` is one word for facts that
   * deserve different answers. A crash is worth retrying — the process died and
   * the next attempt may not. An engine REFUSAL is not: measured on a real run, the
   * same prompt was refused four times in a row before a fifth session worked,
   * so a consumer that retries it buys the same answer again. A `quota` is worth
   * retrying LATER: the account hit its own limit, which is nobody's mistake and
   * stops being true at an instant the engine usually names — measured,
   * three attempts burned in twenty seconds and a work flagged as broken for it.
   *
   * A closed set, and the opposite openness decision from `refusalCategory`
   * below: these words are OURS, and a value enters here when a kind of failure
   * is measured, never because an engine invented one. This is also where a
   * quota state was NOT allowed to become a seventh `SessionStatus` (see
   * *Rejected — a richer `SessionStatus`*): one status, one cause beside it.
   *
   * Absent is the ordinary case and covers every session opened before the
   * field existed. It is never inferred from an exit code: a non-zero exit is
   * what all three have in common, which is exactly why the field had to exist.
   */
  readonly failureKind?: "engine_refusal" | "quota";

  /**
   * How the engine itself classified the refusal, when it classified it.
   *
   * The engine's own word, verbatim and unmapped — `reasoning_extraction` is
   * what the bisection read off the real frame. Open vocabulary, like `models`
   * and unlike `failureKind`: a closed enum here would demand a release of this
   * format every time an engine names a new category, and a category nobody can
   * record is a diagnosis nobody can make.
   *
   * Absent is "the engine refused and said no more than that", a real shape of
   * the frame and not a defect — the refusal itself travels in `failureKind`.
   */
  readonly refusalCategory?: string;

  /**
   * When the account's quota resets, as the engine best said it.
   *
   * An ISO 8601 instant, and the one field here that never reaches the wire:
   * there is no key for it in the control plane's session closure and no row in
   * the event contract. It is a scheduling hint for whoever holds the work — wait
   * until this instant instead of guessing at a backoff — and a hint that
   * outlived the process that read it would be a measurement, which it is not.
   *
   * Absent is a case every consumer must answer for: no engine promises this
   * text, and an adapter that could not parse what it was given reports nothing
   * rather than a date it made up. Meaningful only beside
   * `failureKind: "quota"`.
   */
  readonly quotaResetAt?: string;
}

/**
 * Where everything a session produces leaves the adapter through.
 *
 * Nothing escapes through an engine-specific channel: what the caller needs
 * arrives here, and it is what makes it possible to append to the event log and
 * update the session's row without knowing which CLI ran (D1 — the adapter
 * reports, the server writes).
 */
export interface SessionListener {
  /**
   * A line emitted by the engine (stdout and stderr merged, in arrival order),
   * raw and unparsed. Raw is a requirement: not every line is a structured frame
   * — a CLI writes its dying scream in plain text in the middle of the stream,
   * and the log is only replayable (event sourcing) if it keeps both.
   */
  onOutput(line: string): void;

  /**
   * The identifier the engine itself gave the session, as soon as it is known.
   *
   * Optional and an opaque string: every CLI calls it something different and
   * none guarantees the format. It was captured for telemetry and audit before
   * anybody could use it, "cheap to add before there is a published adapter and
   * expensive to bolt on afterwards" — and resume collected on that bet: it is
   * this value that comes back in `SessionSpec.resumeFrom` to continue a
   * session.
   */
  onEngineRef?(engineRef: string): void;

  /**
   * Called EXACTLY ONCE, on reaching a terminal status.
   *
   * `exitCode` is `number | null`: in POSIX, a process killed by a signal has no
   * exit code, and that is precisely what happens in the kit's timeout and
   * cancellation cases. `null` is "there was none", not "zero".
   *
   * `detail` is only filled in when the adapter has something the status does
   * not carry — which of the two watchdogs stopped the session, and
   * the tokens and the models it consumed. A consumer written before it existed
   * still works: an extra argument to a two-parameter callback is ignored.
   */
  onFinished(
    status: SessionStatus,
    exitCode: number | null,
    detail?: SessionFinishDetail,
  ): void;
}
```

### The adapter

```typescript
/**
 * A model the engine offers.
 *
 * `id` is the identifier that goes after the engine's model flag — the string a
 * node's `model` has to match — and nothing else: it is not a display name, nor
 * a family nickname the CLI happens to resolve. `label` is what a person reads,
 * when the adapter has one to give.
 *
 * `origin` is the field that keeps the catalogue honest. `cli` means the binary
 * was asked and answered; `catalog` means the adapter is reciting a list it
 * carries. Putting the two together would make "these are the models" a
 * statement nobody can weigh — the same demotion `CliProbe.authenticated`
 * already took, and for the same reason.
 */
export interface EngineModel {
  readonly id: string;
  readonly label?: string;
  readonly origin: "cli" | "catalog";
}

/**
 * Everything an engine says it can run, at one instant.
 *
 * `resolvedAt` is not decoration: a static catalogue and a CLI's answer age
 * differently, and a consumer with no stamp cannot tell a fresh report from one
 * a runner left behind before dying.
 */
export interface ModelCatalog {
  readonly models: readonly EngineModel[];
  readonly resolvedAt: string;
}

/** The result of the CLI's preflight, consumed by the installation wizard. */
export interface CliProbe {
  /** The binary exists and answers. */
  readonly available: boolean;
  readonly version: string | null;
  /**
   * Best effort, never a guarantee: there is an engine whose credential failure
   * only shows up in the middle of the first session (see "Feasibility"). `true`
   * means "I found no reason for it to fail", not "it will authenticate".
   */
  readonly authenticated: boolean;
}

export interface EngineAdapter {
  /** A stable identifier, persisted on the session's row. */
  readonly engineName: string;

  /**
   * Opens a session and returns THIS ADAPTER'S LOCAL handle for it — which is
   * not the engine's `engineRef` and must not be confused with it.
   *
   * It resolves as soon as the session is up; the work carries on and is
   * reported by the listener. It rejects with `SessionStartError` if it did not
   * come up.
   */
  startSession(spec: SessionSpec, listener: SessionListener): Promise<string>;

  /** The current status. Throws `UnknownSessionError` for an unknown handle. */
  getStatus(sessionId: string): Promise<SessionStatus>;

  /**
   * Stops a session in flight; a no-op if it already ended.
   *
   * `status` is the terminal status to report in `onFinished`, default
   * `"cancelled"` (somebody pressed the button). A watchdog passes
   * `"timed_out"`. Recording the reason HERE is what takes the watchdog out of
   * the race with the adapter's own streaming thread: the alternative —
   * cancelling and then overwriting the row the thread has just written — loses
   * whichever write arrives last.
   *
   * Throws `UnknownSessionError` for an unknown handle.
   */
  cancel(sessionId: string, status?: SessionStatus): Promise<void>;

  /**
   * Declares what this engine does beyond the baseline. Logically not
   * mandatory: an adapter with nothing to say returns `BASELINE_CAPABILITIES`,
   * and the safe default is every flag false.
   */
  capabilities(): EngineCapabilities;

  /** A preflight that spends no quota. */
  verifyCli(): Promise<CliProbe>;

  /**
   * Which models this engine can run, as far as the adapter knows.
   *
   * The METHOD is optional, and not only its fields — that is the compatibility
   * statement: a third party's adapter written before this existed still
   * compiles, which is what "growth of a published format is additive" has to
   * mean after the v1 freeze. Whoever consumes it checks the method before
   * calling and skips the adapter that does not have it.
   *
   * Discovery, never enforcement: nothing validates the `model` declared on a
   * node against this list, and an engine with an out-of-date catalogue still
   * refuses a bad id on its own, which is where the truth actually lives.
   */
  listModels?(): Promise<ModelCatalog>;
}
```

### Errors

```typescript
export class EngineError extends Error {}

/** The session could not be opened (a missing binary, a missing workdir, spawn). */
export class SessionStartError extends EngineError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SessionStartError";
  }
}

/**
 * The handle never existed IN THIS ADAPTER.
 *
 * `getStatus` and `cancel` over an unknown handle THROW — they never return an
 * invented status. A consolation `"failed"` here becomes, further up, a live
 * session marked as dead, and the difference between "I do not know" and "it
 * went wrong" is exactly what the telemetry has to preserve.
 */
export class UnknownSessionError extends EngineError {
  constructor(public readonly sessionId: string) {
    super(`Unknown session handle: ${sessionId}`);
    this.name = "UnknownSessionError";
  }
}
```

### Invariants the interface cannot express in a type

All of them checked by the kit below:

1. `onFinished` is called exactly once, always, including when the process is
   killed by a signal — never zero times, never twice.
2. After `onFinished`, no `onOutput` arrives.
3. `getStatus` only returns a terminal status after `onFinished` has run.
4. Every line the engine emits reaches `onOutput`, in the original order.
5. No process is left orphaned: not by a timeout, not by a cancellation, not by
   an engine that ignores SIGTERM.
6. **The engine process's `stdin` is closed, redirected to `/dev/null`, or
   written and then closed by the adapter.** What the invariant forbids is the
   fourth form: a pipe open, nothing written, nobody closing — the engine waits
   for EOF forever. It is not an implementation detail — see "Adjustments made in
   review", item 1, which still holds whole; item 10 is what added the third
   mechanism, when large content started needing a channel outside the argv.
7. **The adapter never gives the engine access to a directory beyond
   `spec.workingDir`.** In `claude-code` that is `--add-dir`, which the adapter
   assembles on no path at all; in another engine it will be another flag. The
   invariant is the same: an extra directory hands back, in a single flag, the
   write scope the policy has just closed — and the `workingDir` is the only
   place a session has a right to touch.

## The conformance kit

This is the suite a third party's adapter has to pass in order to come in
(`notes/2026-08-14-extension-and-quality.md:21-23`). It runs against a **fake
engine** — a controllable script, injected through the adapter's
command-building seam — so that CI never needs the real CLI installed or
authenticated. Running against the real CLI is a manual gate, separately.

The first six cases are mandatory. C7 comes along because it is the only check of
the error contract and costs one line, C8 because it is the only one that proves
the `cancel()` contract under concurrency — the stopping callers (the clock, the
inactivity watchdog and `cancel()`) competing for the same session —, and C9
because the second watchdog is the only thing in this adapter that is only
proved by time: that it rearms on every output, and that it bites when the output
stops.

C10 comes in for another reason, and it is the first case whose expected
outcome **depends on what the adapter declares**: `hasResume` splits the engines
in two, and both sides are conformant — continuing, or refusing. What is not
conformant is the third answer, accepting `resumeFrom` and opening a new session
anyway, and that is precisely the one no consumer can detect on its own: a
session that continued nothing is identical, from outside, to one that continued.
It is the same honesty rule `permissions` already made normative, applied to the
field where the silent loss costs most.

C11 comes in for a reason none of the earlier ones had: it is the only
case whose failure mode is **outside** the adapter and **below** it. The ceiling
is the operating system's, the `spawn` dies with `E2BIG` before a process exists,
and there is no session and no `onFinished` for the problem to be reported
through — the adapter simply stops working at a size nobody declared. It is C2's
other half: that one asks whether the content arrives, this one asks whether it
keeps arriving when there is too much content to fit where it usually goes.

| Name | Setup | Expected result |
|---|---|---|
| **C1 — basic session** | The fake engine emits N lines and exits 0. | `getStatus` is `"running"` right after the start; `onFinished("completed", 0)` once; `getStatus` moves to `"completed"`. No `onOutput` after the `onFinished`. |
| **C2 — skill injection** | `instructions` carries a unique marker (e.g. `MARCADOR-a1b2c3`); `prompt` does not contain it. The fake engine writes to a file EVERYTHING it received — argv, environment, stdin and files created in the workdir. | The marker appears in what the **process** received, by any of the legitimate paths (an argument, a system prompt flag, stdin, an ephemeral file). Forbidden assertion: inspecting the `SessionSpec` — that would test the test, not the adapter. |
| **C3 — timeout** | A fake engine that never ends on its own; a short `timeoutSeconds`. | `onFinished("timed_out", …)` fires close to the deadline, once; the process no longer exists afterwards (no orphan); the clock is not left armed. |
| **C4 — process death** | A fake engine that installs a handler ignoring SIGTERM and stays alive. | After the grace period the adapter escalates to SIGKILL; `onFinished` happens all the same and is not left hanging. It also covers the child that outlives its parent. |
| **C5 — cancellation** | A long session; calling `cancel(handle, "timed_out")` half way. | The status reported to `onFinished` is **the one that was passed**, `"timed_out"`, not a fixed `"cancelled"`. Repeating with `cancel(handle)` and no argument must give `"cancelled"`. Calling `cancel` on an already terminal session is a silent no-op, not an error. |
| **C6 — event harvesting** | The fake engine emits a known sequence of lines — including one that is not a structured frame — and exits with a non-zero code. | Every line reaches `onOutput`, **in the original order and unparsed**; `onFinished` reports `"failed"` with the exact exit code. The variant exiting 0 reports `"completed"` with 0. |
| **C7 — unknown handle** | A handle never started in this adapter. | `getStatus` and `cancel` reject with `UnknownSessionError`. Neither of the two invents a status. |
| **C8 — stop race** | A fake engine that ignores SIGTERM and never ends on its own; a long `timeoutSeconds`, so that the internal clock never fires on its own account. Two stops in a row, with no sleep between them, with different statuses — the second falls inside the first's grace window: `cancel(handle, "timed_out")` and then `cancel(handle, "cancelled")`. | The FIRST wins: `onFinished` and `getStatus` report `"timed_out"`, no matter whether the process died on the SIGTERM or on the SIGKILL. The second stop is a complete no-op — it does not overwrite the status, does not signal again, does not rearm the escalation or the safety net (`onFinished` exactly once). Repeated with the statuses swapped, the expectation becomes `"cancelled"`: what wins is the order, not the literal. |
| **C9 — inactivity** | The fake engine emits a beat every `silenceSeconds / 2`, crossing two whole windows, and then goes quiet forever without exiting; a long `timeoutSeconds`, so that the wall clock never fires on its own account. | `onFinished("timed_out", null, {timeoutReason: "silence"})` exactly once, inside a `silenceSeconds` window counted from the LAST beat — never from the start of the session, which is what a watchdog with no rearm would do. Every beat reached `onOutput` before that. No orphan. A `cancel()` afterwards is a silent no-op. |
| **C10 — session continuation** | One session, and then another with `resumeFrom` holding the `engineRef` the first reported, in the SAME `workingDir`. The case reads `capabilities().hasResume` and demands the corresponding outcome — it never hard-codes which adapter is running. | Declaring `hasResume`: the ref reaches the **process** by some legitimate path (C2's discipline — inspecting the `SessionSpec` would test the test), the continued session completes, and the local handle is ANOTHER one, because the ref belongs to the engine and the handle to the adapter. Not declaring it: `startSession` rejects with `SessionStartError` **before the spawn** — no process, no sidecar, no `onFinished`. |
| **C11 — a prompt too big for the argv** | `instructions` + `prompt` summing ~300 KB, with a short, unique marker inside the `prompt`. The size is chosen to pass both real operating-system ceilings at once: 128 KiB per argument on Linux (`MAX_ARG_STRLEN`) and the whole argv+envp block on macOS (`ARG_MAX`). | The session reaches a terminal status with no spawn failure — the failure mode here is the `spawn` dying with `E2BIG` before there is a session to report anything at all. The marker reaches the **process** by some legitimate path (C2's discipline, and the same four paths), and the content is **not** in the `argv`: an adapter that merely fitted inside the CI machine's ceiling would pass the case and break on the next machine. Which channel it uses is the adapter's decision, and the case demands none. |

Notes on running it:

- **No real CLI in CI.** The seam is the command building; swapping the binary
  for the fake engine is what keeps the suite deterministic. An adapter that does
  not expose that seam is an adapter that cannot be certified — that is a
  requirement of the kit, not a suggestion.
- **C3 and C4 are the expensive ones.** They are the two that only fail under
  real load and are the reason the kit exists: an adapter that leaks a process
  brings the runner's machine down after the hundredth session, not the first.
- **Asynchronous, with a deadline.** Every case waits for a terminal status with
  a limit of its own and fails with an explicit message when it runs out; no
  fixed `sleep`.

## Feasibility: a second CLI

The rule of two consumers demands a second real engine before freezing. Here it
is **analysed, not implemented** — implementing it is a future ticket.

**The choice: Codex CLI (OpenAI)**, for its structural resemblance to Claude
Code's `stream-json`. The evidence was gathered in this ticket, on 2026-08-14,
against `codex-cli 0.147.0` executed through `npx --yes @openai/codex@latest`
(the CLI was not installed on the machine), and against an already installed
`claude 2.1.232`. The primary sources:

- `codex --help` and `codex exec --help`, run here — the output is transcribed in
  the citations below.
- A real execution of `codex exec --json --skip-git-repo-check --ephemeral` with
  no credential, which yielded the shape of the frames and the exit code.
- Strings from the distributed binary, for the instruction keys.
- The official repository and docs: `https://github.com/openai/codex` and
  `https://developers.openai.com/codex/`.
- An alternative evaluated and set aside for now: Gemini CLI, headless mode
  through `-p`/`--prompt` with `--output-format json|jsonl`
  (`https://geminicli.com/docs/cli/headless/`). It serves, and the mechanics are
  the same; Codex was chosen for having its headless mode in a dedicated
  subcommand (`codex exec`), which gives an adapter a smaller and more stable
  flag surface.

### A method-by-method mapping

| Element of the interface | The mechanics in `codex exec` | Evidence |
|---|---|---|
| `engineName` | `"codex"`. | — |
| `startSession` | `codex exec [OPTIONS] [PROMPT]` — "Run Codex non-interactively". An ordinary subprocess, with no daemon. | `codex --help`: `exec  Run Codex non-interactively [aliases: e]` |
| `SessionSpec.workingDir` | `-C, --cd <DIR>` ("use the specified directory as its working root"). It needs `--skip-git-repo-check` when the directory is not a git repository — a real trap for a test worktree. | `codex exec --help` |
| `SessionSpec.instructions` | **No system prompt flag.** Three paths internal to the adapter: concatenating into the prompt; writing an ephemeral `AGENTS.md` in the workdir; or `-c base_instructions=<...>`. | `codex exec --help` lists no system prompt flag; `grep -a` on the distributed binary finds `AGENTS.md` (70 occurrences) and `base_instructions` (14). The measured contrast: `claude --help` lists `--system-prompt <prompt>` and `--append-system-prompt <prompt>`. |
| `SessionSpec.prompt` | A positional argument **preceded by `--`**, and stdin when the content does not fit in the argv. The `--` is not decoration: `codex exec "-1 apples"` answers `error: unexpected argument '-1' found` and does not open. On the stdin path the positional **disappears with it** — the `<stdin>` block is only appended when both channels carry content, and omitting the positional entirely was measured by reading the prompt clean. No shell in between in either case: a direct argv, with zero quoting-injection surface. | `codex exec --help`: "Initial instructions for the agent. If not provided as an argument (or if `-` is used), instructions are read from stdin. If stdin is piped and a prompt is also provided, stdin is appended as a `<stdin>` block"; the `-1` error and the `--` success measured against `codex-cli 0.147.0` |
| `SessionSpec.timeoutSeconds` | **There is no timeout flag** — neither here nor in Claude Code. It is the adapter's clock over the process, exactly as the interface presumes. | its absence in `codex exec --help` |
| `SessionSpec.envOverrides` | The subprocess's environment, plus `-c key=value` for configuration. | `codex exec --help` |
| `SessionListener.onOutput` | `--json` ("Print events to stdout as JSONL"). Runtime error lines come out as plain **non-JSON** text in the same stream — which confirms the contract of a raw, unparsed line. | A real execution: among the JSON frames came lines like `ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized` |
| `SessionListener.onEngineRef` | The stream's first frame: `{"type":"thread.started","thread_id":"01a000e7-…"}`. | A real execution |
| `SessionListener.onFinished` (status) | A terminal `turn.completed` / `turn.failed` frame, with the same pattern as Claude Code's `result`: classify by the structured frame, fall back to the exit code when there is no frame. | A real execution produced `{"type":"turn.failed","error":{"message":"unexpected status 401 …"}}` |
| `SessionListener.onFinished` (exit code) | It exits **1** on a failed turn — it does not mask the failure behind a 0. | A real execution, measured with no pipe: `REAL_EXIT=1` |
| `getStatus` | The adapter's local state, as in Claude Code: the CLI has no state query. | — |
| `cancel` | A signal to the process: SIGTERM, SIGKILL after a grace period. No cancellation subcommand. | its absence in `codex --help` |
| `capabilities` | `hasStructuredOutput: true` (JSONL), `hasResume: true` (`codex exec resume [SESSION_ID]`). `reportsUsage` to be confirmed against a real corpus. | `codex exec resume --help`: "Resume a previous session by id" |
| `verifyCli` | `codex --version` → `codex-cli 0.147.0`; `codex doctor` ("Diagnose local Codex installation, config, auth, and runtime health") as a richer probe. See item 3 of the adjustments. | `codex --help`, `codex --version` |
| `SessionStartError` | A spawn failure or a missing workdir — the same class of error on both engines. | — |
| `UnknownSessionError` | Purely the adapter's; no engine takes part. | — |

### Conclusion

The interface serves Codex CLI with no structural change: both engines are
headless subprocesses with a JSONL event stream, an engine ref in the first
frame, a terminal frame and an exit code. The real divergences are **three**, and
all of them fall exactly where the adapter's boundary was drawn to absorb them:
how the instructions go in, what the terminal frame is called, and what the
authentication probe can promise. None of them leaks upwards.

What the review *changed* is in the next section.

## Adjustments made in review

Ten changes and two explicit rejections — four from the original review, plus
what grew after the v1 freeze (items 5 to 10). Nothing here is decorative: items 1, 3, 6, 7,
8 and 10 came out of running the CLIs, not out of reading documentation.

1. **A closed `stdin` became a normative invariant (new).** Running `codex exec`
   with a non-TTY stdin, the CLI printed
   `Reading additional input from stdin...` before starting — and
   `codex exec --help` confirms it: "If stdin is piped and a prompt is also
   provided, stdin is appended as a `<stdin>` block". An adapter that leaves a
   pipe open and never writes to it stalls the session forever: the engine waits
   for EOF, the timeout does fire, but the cost is a whole session lost to a
   library default. Before this review that was an implementation detail copied
   from flowpilot; now it is invariant 6, and the kit's C1 exercises it for free.

2. **`exitCode` became `number | null` instead of `number`.** A process killed by
   a signal has no exit code in POSIX, and that is what happens in C3 and C4 —
   the two cases the kit demands. A plain `number` would force every adapter to
   invent a `-1` or a `137`, and the telemetry would lose the difference between
   "it exited with an error" and "it never got to exit". It holds for both
   engines.

3. **`CliProbe.authenticated` was demoted to best effort, in writing.** The
   execution with no credential showed that Codex **opens the session
   normally** — `thread.started` and `turn.started` come out before any sign of
   trouble — and only fails on trying to talk to the API, with the 401 arriving
   as `{"type":"error","message":"Reconnecting... 2/5 …"}` frames in the middle
   of the stream. Which is to say: there is no cheap probe that guarantees
   authentication for every engine. The field stays in the interface (the
   installation wizard needs it), but the document now says what it promises, and
   no consumer may treat it as a guarantee.

4. **`EngineCapabilities`'s fields became optional.** The reason is one of
   published format, not of taste: adding a mandatory flag to an interface third
   parties implement breaks the compilation of all of them at once. Optional plus
   `resolveCapabilities()` makes the growth additive, which is what "a versioned
   schema" has to mean in practice.

**Rejected — a `hasNativeSystemPrompt` flag.** The divergence is real and
measured (`claude --help` has `--system-prompt`; `codex exec --help` has no
equivalent), and the temptation to expose that as a capability is strong. But no
consumer above the adapter would do anything different knowing it: `instructions`
arrives separately precisely so that the choice of mechanism dies inside the
adapter. Declaring the flag would be a statement with no consumer — and that is
how a format-as-product starts accumulating a dead field. What the divergence
produced was the **normative rule** of the separation, which is now written down,
and the kit's C2, which verifies it by what the process received.

5. **`SessionSpec.silenceSeconds` and `onFinished`'s third argument**. The
   first additive growth after the v1 freeze that touches the listener, and it
   obeys the same rule `SessionSpec.permissions` obeyed: an optional field, an
   optional parameter, no published symbol changing its name or its shape. A
   third party's adapter that ignores `silenceSeconds` still compiles and still
   passes C1–C8; what it does not pass is C9, which is exactly what "this
   capability is new" has to mean in a certification kit.

   The pair comes together out of necessity: with two watchdogs, `"timed_out"`
   stopped saying which one bit, and that is a real operational question ("the
   session cost too much" and "the session stopped happening" ask for different
   reactions). The answer was NOT a new status — see the paragraph just below,
   which rejected that on its own account — but an optional cause beside the
   status, which lands in the event log as
   `session.finished.data.timeout_reason`.

6. **`SessionSpec.model`, `listModels()`, `EngineModel` and `ModelCatalog`**
  . The second additive growth after the v1 freeze, and it obeys the same
   rule `permissions` and `silenceSeconds` obeyed: an optional
   field, no published symbol changing its name or its shape. The difference is
   that this time what grew was a METHOD of the interface, and that is why
   `listModels?()` is optional in the member itself, not only in the fields — a
   third party's adapter that never heard of a catalogue still compiles and still
   passes the whole kit. No case demands `listModels`: it is an optional
   capability, not a baseline every adapter has to meet, and a unit test per
   adapter covers it. (The C10 the kit gained is the next item's, about session
   continuation, and has nothing to do with catalogues.)

   The `model`/`listModels` pair comes together because one without the other is
   half a delivery: pinning a model per node without publishing which ones exist
   forces whoever writes a graph to guess an identifier, and publishing a
   catalogue with no way to pin is a menu with no order.

   **The gap, written down because it exists.** `claude --help` has
   `--model <model>` and `codex exec --help` has `-m, --model <MODEL>` — both of
   them SET a model, and neither exposes a subcommand or a flag that LISTS the
   available ones (run against both binaries in this ticket). `listModels()`'s
   `cli` path is in the interface for the future engine that has one; both of
   today's adapters always resolve to their own static catalogue, always
   `origin: 'catalog'`. It is the same kind of written honesty
   `CliProbe.authenticated` already carries — "best effort, never a guarantee" —
   and it is what `origin` exists for: without it, "these are the models" would be
   a statement nobody can weigh.

7. **`SessionSpec.resumeFrom`, and what the real CLI answered about it**
   (2026-08-16). The same additive growth as the three before it: an optional
   field, no published symbol changing its name or its shape, and a new case in
   the kit (C10) for what came into being. The difference is that this field gave
   a consumer to a capability the interface had declared since the freeze and no
   adapter implemented — `hasResume` was exactly the kind of flag the note above
   orders not to declare before somebody reads it, and from here on somebody
   reads it.

   **Measured against the real CLI** (`claude 2.1.233`, script in
   `packages/runner/scripts/spike-session-resume.mjs`, two runs on 2026-08-16).
   The script tells a unique marker to session A, captures its `engineRef`, and
   asks for the marker back in a session B whose prompt never mentions it:

   - **resume really carries context.** Session B answered the marker it was
     never told, measured in the `result` frame — not in a reproduced transcript
     line, which would be an echo and not memory;
   - **and it does NOT demand the same `workingDir`** — which **contradicts what
     the work assumed**. It started from a reading of
     `packages/runner/src/dispatch/session-worktree.ts:16-26` (every dispatch
     creates a new worktree) supposing that Claude Code's resume was keyed by
     directory, and therefore useless in production until somebody reused the
     directory. It is not: with the same ref, from a directory that session never
     saw, session B recited the marker just the same. Both runs agreed. Whoever
     dispatches a resume has one dependency fewer than this ticket imagined;
   - **the continued session reports the SAME `engineRef`.** It is not a new id
     with a pointer to the earlier one: B's stream `session_id` is, literally,
     A's. A consequence for whoever models the telemetry of a recycled session —
     `engine_session_ref` does **not** identify an execution, it identifies the
     conversation, and a table that treats it as a session's unique key collides
     on the second continuation.

8. **`SessionFinishDetail.usage` and `SessionFinishDetail.models`, and the frame
   that measured them** (2026-08-16; the evidence fixed here). The
   same additive growth as the earlier ones: two optional fields on a type that
   already existed, no published symbol changing its name or its shape,
   `EngineAdapter` and `onFinished`'s signature untouched. And the second case in
   a row of a capability declared at the freeze finally gaining a reader —
   `reportsUsage` had been in the interface ever since and no adapter declared
   it, for `hasResume`'s reason: the CLI had known how to count all along, what
   was missing was somebody to read it.

   **Measured against the real CLI** (`claude 2.1.233`, script in
   `packages/runner/scripts/spike-real-session.mjs`, run on 2026-08-16). The
   `usage` of the terminal `result` frame, verbatim — it is this object that
   `packages/runner/test/engine/conformance.claude-code.test.ts` uses as a
   fixture, and it is because it is whole, and not cut down to the four keys,
   that the test can tell an adapter that CHOOSES from one that forwards:

   ```json
   {
     "input_tokens": 2,
     "cache_creation_input_tokens": 3022,
     "cache_read_input_tokens": 15688,
     "output_tokens": 5,
     "output_tokens_details": { "thinking_tokens": 0 },
     "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
     "service_tier": "standard",
     "cache_creation": { "ephemeral_1h_input_tokens": 3022, "ephemeral_5m_input_tokens": 0 },
     "inference_geo": "not_available",
     "speed": "standard"
   }
   ```

   Ten keys where the taxonomy's `uso` accepts four and closes
   `additionalProperties`. The adapter CHOOSES the four, and the fate of the
   other six is decided here, in writing, instead of implicitly in the code:

   - **`cache_creation` is NOT added to `cache_creation_input_tokens`.** It is
     the same number broken down by TTL — 3022 = 3022 (1h) + 0 (5m). The flat
     field is already the total, and adding the breakdown on top would count the
     cache twice;
   - **`output_tokens_details.thinking_tokens` is not either**, by the same
     arithmetic: it is a subdivision of `output_tokens`, already contained in it;
   - **`service_tier`, `inference_geo`, `speed` and `server_tool_use` are not a
     token count** of any of the four natures, and there is nowhere to fold them
     into without inventing. They stay out, and they stay out named: whoever
     finds an honest mapping for one of them changes this list before changing
     the code.

   The same frame brought `modelUsage` with TWO models in a session of a single
   turn — the main turn's and a cheaper auxiliary's. The per-model totals **do
   not add up** to the `usage` above (`input_tokens` 2 at the top, against
   523 + 2 in the breakdown): the top describes the main turn, the breakdown
   describes every model that ran. That is why `models` carries IDENTITY and
   never a second accounting — summing there would produce a total that disagrees
   with the very frame that produced it.

   **Absence is still absence.** A frame with no `usage`, a `usage` missing any
   one of the four counts, or a session that died before the terminal frame
   report no field at all. Zero is a measurement; filling the silence with zeros
   is the one forbidden reading, and it is the same rule the taxonomy's `uso` has
   carried from the start.

9. **`SessionSpec.modelTier`** (2026-08-16). The ninth additive growth, the
   same shape as the earlier ones: an optional field, no published symbol
   changing its name or its shape, no adapter obliged to move. What it adds is a
   vocabulary, not a piece of data: `model` (item 6) crosses the boundary because
   a graph document wrote an engine id; `modelTier` has two OF OUR values, and it
   is the adapter that answers how much "trivial" costs on it. Without it, a
   runner that wanted to run cheap work would have to know the name of every
   CLI's cheap model — which is exactly invariant 1 ("no engine vocabulary above
   this line") upside down.

   Two decisions the field forces, and both are in its comment:

   - **`model` beats `modelTier`.** Both arrive together when a node fixed a
     model and the work was triaged; the adapter assembles a single flag, with
     `model`'s value. It is not a style preference: two model flags in the same
     argv is a broken command, and between an id somebody recorded in a graph and
     a triage heuristic, the one that gives way is the heuristic.
   - **`standard` assembles no flag**, and produces an argv identical to an
     absent `modelTier`. The pair exists so that the TRIAGE can say "I looked and
     it is ordinary" instead of staying quiet — a distinction that counts in the
     telemetry, and that the adapters deliberately do not use.

   The two adapters diverge here, in writing and on purpose. `claude-code` has a
   documented default (`claude-haiku-4-5`, overridable through
   `CLAUDE_TRIVIAL_MODEL`); `codex` has **no default at all** and only assembles
   the flag if `CODEX_TRIVIAL_MODEL` is set. Nothing in this repository
   establishes which of OpenAI's models is the cheap one, and a guessed id would
   reach the CLI as a session that dies on an unknown model. The gap is written
   down and is tested as a gap (`test/engine/codex-command.test.ts`), rather than
   made up — the same posture as `origin: 'catalog'` in item 6.

10. **The large content left the argv, and the prompt stopped being readable as a
    flag** (2026-08-16). The first item of this list that does **not**
    touch the interface: no new symbol, no new field, nothing in `types.ts`. What
    it exercises is a path the normative rule already allowed for and that no
    adapter had taken — each adapter decides how it injects, through the engine's
    flag, through stdin or through an ephemeral file — and that is why it fits
    entirely below boundary 1, in a frozen document, with no format decision at
    all.

    **Two bugs, both reproduced against the installed CLIs**
    (`claude 2.1.233`, `codex-cli 0.147.0`):

    - **`E2BIG`.** Both adapters put the whole composed content in the `argv`.
      Linux limits a SINGLE element to 128 KiB (`MAX_ARG_STRLEN`) and macOS
      limits the whole argv+envp block (`ARG_MAX`); `SessionSpec.prompt` is "the
      skill's instructions + the work + earlier questions + the transcript on a
      resume" and grows without a ceiling in a long or continued session. Past
      that the session does not fail, it **does not open**: what dies is the
      `spawn`, before there is a process, an output or a session to report
      anything through;
    - **a prompt starting with `-` read as a flag.** `claude --print "-1 apples
      remain"` answers `error: unknown option '-1 apples remain'`;
      `codex exec "-1 apples"` answers `error: unexpected argument '-1' found`. A
      node's instruction is prose somebody else wrote — a list with a dash, a
      negative number — and nothing guarantees what lands in the first column.
      Both CLIs accept `--` before the positional, and it was measured that it
      does not disturb any of the earlier flags (`--resume`, `--model`, `-m`,
      `-s`, `-C`, `--disallowedTools`), which all still come BEFORE it.

    **The design is by size, and the old path stays intact.** Below 64 KiB
    combined — UTF-8 bytes of `instructions` + `prompt`, never `.length`, because
    this project's content is Portuguese and an accented character is two bytes
    to the kernel and one unit to JavaScript — the argv is exactly the one from
    before, with the extra `--`. Above it, `claude-code` writes the instructions
    into an ephemeral 0600 file in the `workingDir` (`--system-prompt-file`,
    which the main `--help` does not list but the description of `--bare` cites
    as `--system-prompt[-file]`, and which was measured working) and sends the
    prompt through stdin; `codex` sends the whole composition through stdin and
    drops the positional along with it. In both cases the composition still comes
    out of this document's functions — `composeWithSystemPromptFlag` and
    `composeSingleArgument` — and what changes is the destination, never the
    format.

    **Invariant 6 grew from two mechanisms to three**, and item 1's concern is
    intact: what it forbids is the pipe nobody writes to and nobody closes.
    Writing and closing satisfies the same concern by another path, and in both
    adapters the condition that opens the pipe is literally the same one that
    triggers the write, which makes the third form impossible to happen by
    accident.

    Neither adapter refuses a session by size, and that is a written decision:
    with both of them gaining a channel outside the argv, there is no size that
    justifies refusing. A third adapter with neither argv headroom nor stdin nor
    a file refuses at the door, by the same honesty rule `resumeFrom` and
    `permissions` already follow — but it does not exist today, and a refusal
    path with no consumer is the same dead field this section rejects on every
    other line.

**Rejected — a richer `SessionStatus`.** Codex and Claude Code both have
quota/limit states of their own (the `Reconnecting... n/5` above is one of them).
Tempting to promote to the baseline; wrong for now. A third engine with no
concept of a quota window would have to pretend, and the rule of two consumers
holds for the status vocabulary as much as for the methods. It stays `failed`,
and the real reason lives in the event log, which is append-only and loses
nothing.

That same reasoning applies to a case that is no engine's, but ours: the
second watchdog. A `stalled`/`travada` separate from `timed_out` was the obvious
port from flowpilot and would have been the wrong decision for the identical
reason — what changes between the two stops is not the outcome, it is the cause,
and a cause is data, not vocabulary. `SessionStatus` still has six members.

## Out of scope (v0)

Recorded so that whoever reads later does not presume an oversight:

- **Usage counting (`SessionUsage`) and transcript projection.** They existed in
  flowpilot; the PoC's ruler (D16) asks for dispatched sessions and complete
  telemetry, and mentioned neither of the two.

  **Both left this list.** The transcript first; usage counting after, and it
  too **only for `claude-code`**: that CLI's terminal `result` frame always
  brought `usage` and `modelUsage`, the reference adapter now reads them,
  declares `reportsUsage` and hands them over through `SessionFinishDetail`. What
  stays out is **Codex**'s counting — its `reportsUsage` is still "to be
  confirmed against a real corpus" in the mapping table above, even after the
  credentialed spike, and declaring the capability without having measured the
  frame would be exactly the unbacked statement this document refuses everywhere.
  A piece of its own, with the same gate used here: run the real CLI and
  look at the frame.

  **Resume LEFT this list, only for `claude-code`** (recorded here rather
  than disappearing without a trace, like the two entries of the freeze below).
  `onEngineRef` had always captured "the key resume is going to need", and it
  gave that key back through `SessionSpec.resumeFrom`: the reference adapter
  declares `hasResume` and assembles `--resume <ref>`. What stays out, and stays
  undeclared, is **Codex**'s resume: `codex exec resume` exists, but it is a
  subcommand and not a flag — a mechanism of another nature, a ticket of its own
  — and until then that adapter refuses `resumeFrom` at the door, which is the
  honest answer and what C10 demands of it. Also still out are the layers ABOVE
  the adapter the original hypothesis wanted: N:M telemetry between a session and
  a work item, a recycling policy as graph data and worktree reuse across
  dispatches. Nothing in `dispatch` calls `resumeFrom` yet.
- **An operating-system sandbox.** Skill permissions **left** this list
  (see "The session's permissions" and tension 1, now resolved); what stays out
  is process isolation — `sandbox-exec`, a network namespace, a container. What
  exists today is gating by tool name, within what the engine allows, with the
  residual gap written down.
- **SDK versus subprocess.** A CLI subprocess is assumed, in line with D17 and
  with flowpilot's precedent.

Two entries **left** this list at the freeze for v1, for having stopped
being true — recorded here rather than disappearing without a trace:
"implementing any adapter at all, neither Claude Code nor Codex" (the first left
with the reference adapter, the second here) and "freezing the interface: two real
adapters first" (which is what this document has just done).

## A review against the recorded decisions

- **D1 (only the server writes)** — respected by construction: the listener is
  the adapter's only way out, and whoever persists is whoever called.
- **D6 (the order of the MVP)** — this ticket is the specification the building
  of the first adapter consumes; no synthesizer is touched.
- **D17 (the stack and the relationship with flowpilot)** — TypeScript, a CLI
  subprocess, flowpilot as a behavioural reference. Not a line of code ported;
  what came from there were the decisions and the scars.
- **D9 (the contract format)** — a tension recorded, not decided here, in the
  section below.
- **D4 (the skill import gate)** — tension 1 below came off the page: the
  field exists, the reference adapter applies what it can and refuses what it
  cannot.

### Tensions found (for the human gate, not decided here)

1. **D4 × the absence of a permission policy in `SessionSpec` — RESOLVED in
   permissions.** The field is `permissions?: SessionPermissions` (see "The session's
   permissions"), and the question the tension said was not neutral — who answers
   for the policy, the manifest or the adapter — was answered like this: **the
   manifest declares, the adapter applies or refuses**. The adapter's default
   stops holding the instant the policy arrives; where it does not arrive, the
   behaviour is the one from before. Resolving the second half (fetching the
   registered manifest's `permissoes` from the node's `skill_ref` and populating
   the field) belongs to the skill rendering pipeline, which does not exist yet.
   The original record, which is still true about the CLIs, stays below.

   > *As it was recorded, before that:* both CLIs have first-class permission
   > control — `codex exec` brings
   > `-s, --sandbox <read-only|workspace-write|danger-full-access>`,
   > `--approve-for-me` and `--dangerously-bypass-approvals-and-sandbox`;
   > `claude` brings `--permission-mode` with
   > `acceptEdits|auto|bypassPermissions|manual|dontAsk|plan`. Careful with
   > `-a, --ask-for-approval`: it belongs to the **interactive** `codex` (the top
   > level) and does not exist in the `exec` subcommand, which dies with
   > `error: unexpected argument '-a' found` — exec's non-interactive approval is
   > the two flags above. The v0 `SessionSpec` **has nowhere to express this**:
   > today the policy can only come from a default hard-coded in the adapter or
   > from `envOverrides`, which is opaque by definition and therefore
   > unauditable. When D4 comes off the page — permissions declared in the
   > skill's manifest, pinned by hash — exactly this field will be missing, and
   > it is additive but it is not neutral (it defines who answers for the policy:
   > the manifest or the adapter). It waits for D4's ticket.

   That record left a warning, and it was resolved — without working around it.
   The warning was: `codex exec`'s `-s/--sandbox` is a real sandbox, of another
   nature than `claude-code`'s gating by tool name, and reusing the gating logic
   there would be translating a hard guarantee into a weak one with nobody asking
   for it. The second real consumer the rule of two consumers
   ordered waiting for (the skill's manifest started populating `permissions` for
   any engine), and with it Codex got a policy of its own: a
   `codex-permission-policy.ts` that maps both axes onto the CLI's real sandbox
   modes, without sharing a line with the other engine's tool vocabulary. The
   hard guarantee stays hard, and what the CLI does not know how to combine
   became an explicit refusal instead of a silent approximation (see "What the
   Codex adapter guarantees").
2. **D9 × the shape of this contract.** D9 orders a contract to be an
   input/output JSON Schema plus typed checks. This specification is a TS type
   plus a conformance table in prose. The reading adopted here is that D9 governs
   **capabilities** (a skill, a gate, a node) — the things that cross the graph —
   and not the session transport interface, which is code and whose verification
   is the conformance suite. If the correct reading is the other one, the kit
   above is the natural candidate to become a list of typed checks, and the
   `SessionSpec` to become a JSON Schema. The same question holds for the three
   sibling specifications (the graph schema, the skill manifest, the event
   taxonomy) — better answered once, for all four.
