# t280 closing note — the software factory bundle in English

**Subject:** `grafos-de-fabrica/desenvolvimento-de-software`, D24 series 1 of 3.
**Commits:** `c6bc259` (tests, red) and `526dec9` (implementation), on `ticket-280`.
**Written:** 2026-08-24, by t295, after the alpha-test round on t280 found that
none of this had been recorded anywhere.

t280's Definition of Done asked its closing note for three things — per-file
line counts before and after (#8), the full `{old id, old version, old hash} ->
{new id, new version, new hash}` table (#8), and any phrase that resisted
faithful translation (#9) — because the bets-assimetricas bundle is meant to be
planned against t280's real numbers rather than against a guess. The note was
never written: a ticket body is not writable outside refinement (flowpilot
answers `ticket_not_in_backlog`, the same wall t222 hit), and `526dec9`'s message
argues the four untranslated projection roots well but carries no table. The
numbers below are recovered from the two commits and from the live tree, and
`tests/factory-bundle-closing-note.test.mjs` holds every one of them against the
bundle so that none of it is believed on this file's word.

## Line counts

| File | Old name | Before | After |
|---|---|---|---|
| `grafo.json` | — | 520 | 520 |
| `README.md` | — | 234 | 245 |
| `skills/refine-ticket.json` | `skills/refinar-ticket.json` | 210 | 210 |
| `skills/develop-ticket.json` | `skills/desenvolver-ticket.json` | 230 | 230 |
| `skills/integrate-branch.json` | `skills/integrar-branch.json` | 197 | 197 |
| `skills/alpha-test.json` | `skills/testar-alpha.json` | 284 | 284 |
| `skills/verify-release.json` | `skills/implantar-release.json` | 184 | 185 |

Bundle total 1,859 → 1,871 (+12). The five manifests are 1,105 → 1,106 (+1): the
JSON is structurally inert under a translation, so a line count is a measure of
content volume and says nothing at all about how much work the translation is.

### Real edit volume

The number that does say something is how many lines actually changed. With the
renames paired up by hand (git's rename detection does not fire — the manifests
are rewritten past its similarity threshold, which is why `526dec9 --stat`
reports 1,438/1,426 and double-counts every renamed file):

| File | Lines changed |
|---|---|
| `README.md` | +199 / -188 |
| `grafo.json` | +133 / -133 |
| `skills/alpha-test.json` | +70 / -70 |
| `skills/develop-ticket.json` | +50 / -50 |
| `skills/refine-ticket.json` | +49 / -49 |
| `skills/integrate-branch.json` | +42 / -42 |
| `skills/verify-release.json` | +38 / -37 |
| **Total** | **+581 / -569** |

So roughly 31% of the bundle's lines were touched. `grafo.json` changed on 26% of
its lines and `README.md` on 85% of its: the graph document is mostly structure
with a thin layer of vocabulary on top, while the README is prose end to end. The
skills sit between at 20–25% — their bulk is `instructions`, and a prose line
that reflows still counts once.

## Skill pins

The five nodes were renamed with their skills: `refinar`→`refine`,
`desenvolver`→`develop`, `integrar`→`integrate`, `testar`→`test`,
`implantar`→`deploy`. The Node column below is the new node id.

Every hash is `manifestHash()` (`scripts/validate-factory-bundle.mjs`): sha256 of
the RFC-8785-canonical JSON of `{instructions, input, output, checks,
permissions, budgets}`. `id`, `version`, `description` and `origin` sit outside
it, so the renames alone would have moved nothing — what moved every hash is the
translated `instructions`, `input`, `output` and `checks`. Each bump is a patch
bump, t280's declared default for a pure translation with no behavioural change
(D22); `alpha-test` starts from 1.0.4 because t269 and t275 had already bumped it
three times.

| Node | Old id | Old version | Old hash | New id | New version | New hash |
|---|---|---|---|---|---|---|
| `refine` | `refinar-ticket` | `1.0.0` | `sha256:92e6b2ad13c2ab9c6c0c8ea5addee5e2aced0336bbe3c5d906b702f5f85e8562` | `refine-ticket` | `1.0.1` | `sha256:79667013229d5e5095c0eef985ef6759e154d444fcb247c9c25aa0181c37d735` |
| `develop` | `desenvolver-ticket` | `1.0.0` | `sha256:b2504dbfd708a13ae72350c32b80232e0836aba7c76922c704f8dd1127fa0581` | `develop-ticket` | `1.0.1` | `sha256:646ea312c75ceb326ab0a153abcec7d8bf8b0d7a7ddc8ed3bd6975468d215410` |
| `integrate` | `integrar-branch` | `1.0.0` | `sha256:7e0d21744b205bb0509d642840812c34e1f9264f1c8c4ad7a43504a8810c87d0` | `integrate-branch` | `1.0.1` | `sha256:e5d9a64ccfc7c278dc2ed3fd7a457774c0636af14d76795cafd8d23f29315910` |
| `test` | `testar-alpha` | `1.0.4` | `sha256:c23cc23679b9b9bc36cdd9ed30c925a8a7ef6a3bd976072cdff6ca12422c06df` | `alpha-test` | `1.0.5` | `sha256:18be65c9f7c13ff831fb01bf53d29233a38268dc304f89ea56f1b9eb37cc5ba6` |
| `deploy` | `implantar-release` | `1.0.0` | `sha256:aec5b3230e4317f0369540952af25a0f29a011316513a79162a1a70fad7afde8` | `verify-release` | `1.0.1` | `sha256:4ba085f8f429356305c3b0ed5e76f010493deeefd587b095418aca5569a4efe4` |

Both sides were recomputed from the manifests themselves rather than copied out
of `grafo.json`, so the old pins are confirmed to have been honest too.

## What resisted translation

**No prose phrase did.** t280's FR2 set up a `(literally "<phrase>")` convention
for a Portuguese nuance an English rendering would flatten, and the translation
used it nowhere: inline `(literally "…")` glosses in the bundle: **0**. The two
places most likely to have needed one did not — `estação redundante` came across
as "a redundant station" with the manufacturing metaphor intact, and
`não lê o relatório de quem fez e assina embaixo` as "does not read the maker's
report and countersign it". Nothing was guessed at and left unmarked either; this is a real
zero, not an unused convention.

What resisted is a different thing entirely: fourteen identifiers that are
Portuguese and stayed Portuguese, none of them for want of an English word. Each
is another package's projection vocabulary, published under that spelling to
every registered manifest, so renaming it inside the bundle would declare an
input that no dispatch delivers — a bundle that validates and a node that starves
at run time. Each root carries a `description` in the manifest now saying whose
vocabulary it is and where it is published, so the next reader does not read it
as an oversight.

| Identifier | Survives in | Why it was kept |
|---|---|---|
| `resultado` | `grafo.json`, `README.md`, `skills/alpha-test.json` | The reserved routing key of the report protocol, spelled this way by `packages/runner/src/dispatch/parse-node-result.ts` and `session.ts`'s `ROUTE_LABEL_KEY`. Only the KEY is theirs; the VALUES (`approved`/`rework`) are this graph's and are English. |
| `banco_de_testes` | `README.md`, `skills/alpha-test.json` | The runner's executor-environment vocabulary, published by `packages/runner/src/dispatch/resolve-executor-environment.ts` under `EXECUTOR_PROVIDED_INPUT_PATHS`. |
| `caminho` | `skills/alpha-test.json` | Child of `banco_de_testes`, published under the same name by the same file. |
| `comandos_de_dados` | `skills/alpha-test.json` | Child of `banco_de_testes`, same publisher. |
| `referencia` | `grafo.json`, `README.md`, `skills/verify-release.json` | Same executor-environment vocabulary; `verify-release`'s two deterministic checks interpolate `{{input.referencia.commit}}` into real git commands. |
| `modo` | `skills/verify-release.json` | Child of `referencia`, and the value `--reference-mode` echoes back. |
| `lido_em` | `skills/verify-release.json` | Child of `referencia`, same publisher. |
| `instalacao_em_uso` | `skills/verify-release.json` | A `--reference-mode` value the runner takes verbatim; an English spelling here would name a mode the CLI does not accept. |
| `ponta_do_principal` | `skills/verify-release.json` | The other `--reference-mode` value, same reason. |
| `perguntas_respondidas` | `skills/refine-ticket.json`, `skills/develop-ticket.json` | The control plane's projection vocabulary, published by `packages/core/src/domain/context.ts` for every registered manifest — and shared with the bets-assimetricas bundle. |
| `pergunta` | `skills/refine-ticket.json`, `skills/develop-ticket.json` | Child of `perguntas_respondidas`, same publisher. |
| `resposta` | `skills/refine-ticket.json`, `skills/develop-ticket.json` | Child of `perguntas_respondidas`, same publisher. |
| `desenvolvimento-de-software` | `grafo.json`, `README.md` | The `problem_class` and the directory name. Folder-and-package scope, explicitly t282's and explicitly out of t280's. |
| `flowpilot` | `grafo.json`, `README.md`, `skills/refine-ticket.json`, `skills/develop-ticket.json`, `skills/integrate-branch.json`, `skills/alpha-test.json`, `skills/verify-release.json` | A proper noun — the product this graph was ported from (D17, behavioural reference, no code dependency). Not a word to translate. |

### Five glossary entries were declared and not applied

t280's *Schema / Data Changes* section listed all four roots for renaming:
`banco_de_testes`→`test_bed` (`.caminho`→`.path`, `.comandos_de_dados`→
`.data_commands`), `referencia`→`reference` (`.modo`→`.mode`, enum
`instalacao_em_uso`/`ponta_do_principal`→`running_install`/`main_tip`,
`.lido_em`→`.read_at`), `perguntas_respondidas`→`answered_questions`
(`.pergunta`→`.question`, `.resposta`→`.answer`) and `resultado`→`result`. The
implementation dropped all five, for the reason in the table above, and that
divergence from the ticket's own glossary is the single largest judgement call in
`526dec9`. The bets-assimetricas bundle inherits the same call — at minimum for
`perguntas_respondidas`, which it also declares — and should not re-derive it.

The English words are therefore still unspent. Whoever eventually renames these
for real is renaming a cross-package projection contract in `packages/core` and
`packages/runner` first, and the bundles only afterwards; that is not a
bundle-translation ticket at all.

### One terminology divergence to settle before the bets bundle

`alpha-test`'s prose calls the checkout a **test bench** ("You are on a shared
test bench") while the glossary above spells the eventual key `test_bed`. Both
readings of `banco de testes` are defensible and neither is wrong today, since
the key was never renamed. The bets bundle should pick one and use it in both
places; if it picks `test bench`, t280's glossary entry is what needs correcting.

## What the bets-assimetricas bundle can plan against

- **Size.** `bets-assimetricas` is 2,975 lines against this bundle's 1,859 — 1.6×
  — split as `grafo.json` 687, `README.md` 330 and seven manifests totalling
  1,958 (`analisar-assimetria` 246, `coletar-fundamentos` 225, `derrubar-tese`
  327, `dimensionar-risco` 261, `escalar-decisao` 296, `registrar-travessia` 329,
  `triar-tese` 274).
- **Real edit volume.** At this bundle's ~31% touched-line rate, expect on the
  order of +930/-910 lines. Its `grafo.json` is 1.3× this one's and its README
  1.4×, and the README is the file that changes on 85% of its lines.
- **Seven skills, seven repins.** Each is a rename plus a translation plus a
  patch bump plus a `manifestHash()` recut plus a `skill_ref` repin in
  `grafo.json`. Recompute with `manifestHash()` from
  `scripts/validate-factory-bundle.mjs`; do not hand-roll the canonicalization.
- **The four projection roots are shared.** `perguntas_respondidas` is declared
  by that bundle too and stays Portuguese there for the same reason.
- **The sweep is already written.** `tests/no-portuguese-factory-bundles.test.mjs`
  walks all of `grafos-de-fabrica/**` and carves out `bets-assimetricas` by name
  in `SKIP_DIRS`. Removing that entry is that ticket's Definition of Done, and the
  gate has a case asserting that every carve-out still names a bundle that exists.

## One thing t280 preserved that is worth a second look

`grafo.json`'s `test` node declares `outcome` with the enum
`approved`/`rework`/`escalate`, while the skill it pins, `alpha-test`, declares
`outcome` as `pass`/`fail`/`escalate_human` (t275) and uses the separate
`resultado` key for the edge label. The divergence predates the translation —
the node said `aprovado`/`retrabalho`/`escala` before `526dec9` — and t280
translated it faithfully rather than fixing it, correctly, since behavioural
change was out of its scope. It is still a node contract and a pinned skill
contract disagreeing about the same key, and the bets bundle's gates should be
checked for the same shape.
