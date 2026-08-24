# t293 closing note — the bets factory bundle in English

**Subject:** `grafos-de-fabrica/bets-assimetricas`, the second half of D24's
series item 1, split from t280 on 2026-08-24.
**Commits:** `771e396` (tests, red), `b9eed94` (implementation), `1b858d2` (doc
comments), on `ticket-293`.
**Written:** 2026-08-24, during development, which is the point — t280's note
had to be reconstructed after the fact by t295 because it was never written the
first time.

With this bundle translated and the sweep's carve-out lifted, D24 series 1 is
closed: `tests/no-portuguese-factory-bundles.test.mjs` now reads every bundle
the repository ships, and `SKIP_DIRS` is empty.

## Line counts

| File | Old name | Before | After |
|---|---|---|---|
| `grafo.json` | — | 687 | 687 |
| `README.md` | — | 330 | 339 |
| `skills/triage-thesis.json` | `skills/triar-tese.json` | 274 | 274 |
| `skills/collect-fundamentals.json` | `skills/coletar-fundamentos.json` | 225 | 225 |
| `skills/analyze-asymmetry.json` | `skills/analisar-assimetria.json` | 246 | 246 |
| `skills/red-team-thesis.json` | `skills/derrubar-tese.json` | 327 | 327 |
| `skills/size-risk.json` | `skills/dimensionar-risco.json` | 261 | 261 |
| `skills/escalate-decision.json` | `skills/escalar-decisao.json` | 296 | 296 |
| `skills/record-crossing.json` | `skills/registrar-travessia.json` | 329 | 329 |

Bundle total 2,975 → 2,984 (+9), all nine of them in the README. Every manifest
and `grafo.json` came out at exactly the line count it went in with, which is
the same observation t280 made and worth repeating: pretty-printed JSON is
structurally inert under a translation, so a line count measures content volume
and says nothing about the work.

### Real edit volume

The number that does say something. Renames paired by hand, because git's rename
detection does not fire on manifests rewritten past its similarity threshold:

| File | Lines changed |
|---|---|
| `README.md` | +289 / -280 |
| `grafo.json` | +223 / -223 |
| `skills/record-crossing.json` | +102 / -102 |
| `skills/red-team-thesis.json` | +100 / -100 |
| `skills/escalate-decision.json` | +85 / -85 |
| `skills/size-risk.json` | +75 / -75 |
| `skills/analyze-asymmetry.json` | +74 / -74 |
| `skills/triage-thesis.json` | +69 / -69 |
| `skills/collect-fundamentals.json` | +60 / -60 |
| **Total** | **+1,077 / -1,068** |

About 36% of the bundle's lines touched, against t280's ~31%. `grafo.json`
changed on 32% of its lines where the software one changed on 26% — this
document carries a thicker layer of domain vocabulary over the same structure —
and the README on 85%, exactly the sister bundle's rate, because a README is
prose end to end either way.

t280's note projected "+930/-910 at this bundle's ~31% rate". The real figure
came in ~15% above that projection, and the reason is the seven `project` and
`custom_fields` descriptions in `grafo.json` that the sister bundle does not
have.

## Skill pins

Every hash is `manifestHash()` (`scripts/validate-factory-bundle.mjs`): sha256 of
the RFC-8785-canonical JSON of `{instructions, input, output, checks,
permissions, budgets}`. `id`, `version`, `description` and `origin` sit outside
it, so the renames alone moved nothing — what moved every hash is the translated
`instructions`, `input`, `output` and `checks`. Each bump is a patch bump, the
default t280 fixed for a pure translation with no behavioural change (D22).
Four of the seven start above `1.0.0` because t270, t276 and t278 had already
bumped them.

| Node | Old id | Old version | Old hash | New id | New version | New hash |
|---|---|---|---|---|---|---|
| `triage` | `triar-tese` | `1.0.0` | `sha256:96b431c28c185be965cf10d4d4cf4932ce66ac6a3e2dac4b0201a14fe8b04bd4` | `triage-thesis` | `1.0.1` | `sha256:3093ac78e5826e352ed222e8c82189dc2e1d6b7fe0dc598b73569360b9b8a729` |
| `collect-fundamentals` | `coletar-fundamentos` | `1.0.0` | `sha256:c5046a5e03e6778ee97e2e8e659559847a30c119d6f448f017505ab33cf2beb5` | `collect-fundamentals` | `1.0.1` | `sha256:1776cb3a2955cc84556d69902e3d18b34642d6ce8090d6c9f5af1a8ad5801e28` |
| `analyze-asymmetry` | `analisar-assimetria` | `1.0.0` | `sha256:1a09017b5be2156ee8343c9a6bae889e5987beeabaa8fd8e06d0d4305744217f` | `analyze-asymmetry` | `1.0.1` | `sha256:a89150efb476a0c627d6b43bb1b1e08b6b687a668a3c148d8948a96bfe86a8ab` |
| `red-team` | `derrubar-tese` | `1.0.1` | `sha256:34b50136adf7fe1bea8c3db98aff742a6e2d829cf4e0b691f7a3f1ebdd4f1e1d` | `red-team-thesis` | `1.0.2` | `sha256:ff37cb32a0290f709a3eb64a5c092dcf7ec9a3d68a20a98cbe44f015888642f7` |
| `size-risk` | `dimensionar-risco` | `1.1.0` | `sha256:636446f4cd3e3fe75e4bf36126b0abd9f45b81c6ec840f286b4963c3c7623eae` | `size-risk` | `1.1.1` | `sha256:b7104f7c5dca46cba02c4b943631f23394d6c61b566f4f815006ca94b2648ca2` |
| `decide` | `escalar-decisao` | `1.0.1` | `sha256:66fea7f172244bbc1414e19985d627d0edf999ac8083110a6fa8163083372d6d` | `escalate-decision` | `1.0.2` | `sha256:235ad5ca786027854fd98580352e0510ba408f0807b0c9f973d68638ba390a32` |
| `record-monitoring` | `registrar-travessia` | `1.0.1` | `sha256:63e199a941ff15f7e215373bf16d73ecb08d964743600f2b227de1ee8a04c25a` | `record-crossing` | `1.0.2` | `sha256:e829755d676f9c55d0d3bb2beef68bb2201aab145a48c350dcc8b00de51ddbee` |

Both sides were read out of the manifests themselves rather than copied from
`grafo.json`, so the old pins are confirmed honest too. `AT6` of
`tests/factory-graph-2.test.mjs` recomputes all seven from a canonicalizer of its
own on every run, which is why no number here is believed on this file's word.

## The glossary that was applied

The ticket proposed a full default and asked for the final choice to be recorded
here rather than escalated. **Every proposed default was taken as written** —
seven skill ids, seven node ids, nine edge conditions, seven roles — with one
addition the ticket's table did not cover.

**The addition: `tamanho_pretendido` → `intended_size`.** It is a `custom_fields`
name, not a node, edge, role or skill id, so no row of the ticket's table
governed it. It was translated because Functional Requirement 3 covers it —
it is an `input` property of the entry skill — and because the projection reads
custom-field names off the document's own `custom_fields`
(`packages/core/src/domain/graph.ts`), so renaming it in `grafo.json`, in the
manifest and in the job's `fields` is self-consistent by construction. The other
four class fields (`premise_source`, `asset`, `downside`, `upside`) were already
English.

The domain vocabulary underneath, which the ticket left to the developer:

| Portuguese | English | | Portuguese | English |
|---|---|---|---|---|
| `tese_triada` | `triaged_thesis` | | `objecoes` | `objections` |
| `titulo` / `ativo` / `hipotese` | `title` / `asset` / `hypothesis` | | `objecao` / `gravidade` | `objection` / `severity` |
| `escopo_de_pesquisa` | `research_scope` | | `resposta_da_tese` | `thesis_answer` |
| `criterios_avaliados` | `evaluated_criteria` | | `contra_evidencia_pesquisada` | `researched_counter_evidence` |
| `criterio` / `veredito` / `evidencia` | `criterion` / `verdict` / `evidence` | | `afirmacao_atacada` / `achado` | `claim_attacked` / `finding` |
| `justificativa` / `nota` | `rationale` / `note` | | `dimensionamento` | `sizing` |
| `fundamentos` / `resumo` / `numeros` | `fundamentals` / `summary` / `figures` | | `tamanho_posicao_pct` | `position_size_pct` |
| `metrica` / `valor` / `periodo` / `fonte` | `metric` / `value` / `period` / `source` | | `perda_maxima_aceita_pct` | `max_accepted_loss_pct` |
| `riscos_conhecidos` / `lacunas` | `known_risks` / `gaps` | | `gatilho_de_saida` / `horizonte` | `exit_trigger` / `horizon` |
| `premissas` / `premissa` | `assumptions` / `assumption` | | `correlacao_com_carteira` | `portfolio_correlation` |
| `confianca` | `confidence` | | `decisao_humana` | `human_decision` |
| `fontes_preferidas` | `preferred_sources` | | `pergunta_id` / `resposta_literal` | `question_id` / `literal_answer` |
| `assimetria` / `cenarios` | `asymmetry` / `scenarios` | | `metricas_processo` | `process_metrics` |
| `upside_alvo_pct` | `upside_target_pct` | | `red_team_executado` | `red_team_ran` |
| `razao_assimetria` | `asymmetry_ratio` | | `fracao_premissas_com_fonte` | `sourced_assumptions_fraction` |
| `nome` / `probabilidade` / `retorno_pct` | `name` / `probability` / `return_pct` | | `desfecho_final` | `final_outcome` |
| `premissas_chave` | `key_assumptions` | | `nos_executados` | `nodes_executed` |
| `criterios_de_triagem` | `triage_criteria` | | `registro` / `tese_id` | `record` / `thesis_id` |
| `circulo_de_competencia` | `circle_of_competence` | | `monitoramento` / `gatilho` / `prazo` | `monitoring` / `trigger` / `deadline` |
| `carteira` / `posicoes_abertas` | `portfolio` / `open_positions` | | `data_de_registro` | `record_date` |
| `exposicao_atual_pct` | `current_exposure_pct` | | `moeda` | `currency` |

Enum values moved with them: `atende`/`nao_atende`/`indeterminado` →
`meets`/`does_not_meet`/`undetermined`, `alta`/`media`/`baixa` →
`high`/`medium`/`low`, `monitorando`/`arquivado` → `monitoring`/`archived`.

**`travessia` is `crossing` in this project's own English**, which is why the
final skill is `record-crossing` and not `record-traversal`: it is the word the
founder's own bet-round notes use, and `input.traversal` (the control plane's
projection key, t270) is a different thing living at a different level.

## What resisted translation

**No prose phrase did**, and the count of inline `(literally "…")` glosses in
the bundle is **0** — the same real zero t280 recorded, not an unused
convention. The three phrases most at risk of needing one did not:
`"acho que" não é fonte` came across as `"I reckon" is not a source`, which
keeps the register of casual over-confidence the original picked;
`piso narrativo` as `a narrative floor`, the metaphor intact because English
builds it the same way; and `a morte mais barata do grafo` as
`the cheapest death in the graph`, which is the same sentence in both languages.
Nothing was guessed at and left unmarked either.

What resisted is the same thing that resisted in the sister bundle: identifiers
that are Portuguese and stayed Portuguese, none of them for want of an English
word.

| Identifier | Survives in | Why it was kept |
|---|---|---|
| `perguntas_respondidas` | `grafo.json`, `README.md`, `skills/triage-thesis.json`, `skills/collect-fundamentals.json`, `skills/escalate-decision.json` | The control plane's projection vocabulary, published by `packages/core/src/domain/context.ts` for every registered manifest. Three of t280's fourteen were this bundle's problem, and these are they. |
| `pergunta` | the same three manifests | Child of `perguntas_respondidas`, same publisher. |
| `resposta` | the same three manifests | Child of `perguntas_respondidas`, same publisher. `escalate-decision`'s check reads it by name. |
| `resultado` | `grafo.json`, `README.md`, all three gate manifests | The reserved routing key of the report protocol, spelled this way by `packages/runner/src/dispatch/parse-node-result.ts` and `session.ts`'s `ROUTE_LABEL_KEY`. Only the KEY is theirs; the VALUES are this graph's and are English. |
| `bets-assimetricas` | `grafo.json`, `README.md` | The `problem_class` and the directory name. Folder-and-package scope, explicitly t282's. |
| `Trabalho #N` | `skills/triage-thesis.json` | **New, and not in t280's table.** The heading `packages/runner/src/dispatch/prompt.ts:70` really writes at the top of every session. `triage-thesis` tells the session to read the work number off it, so translating the quotation would point at a heading that does not exist. It moves when `prompt.ts` moves, and that is not a bundle ticket. |
| `tese-<n>` | `skills/triage-thesis.json` | The id prefix of a triaged thesis, and therefore data already written into the fixture and into every past run. Renaming it is a data migration, not a translation. |

Each of the first three carries a `description` in the manifest now saying whose
vocabulary it is and where it is published, the same way t280 left them in the
sister bundle, so the next reader does not read them as an oversight.

## The two divergences, carried across and not repaired

t280's note flagged both and asked for the bets gates to be checked for the same
shape. They have it, and the ticket's Out of Scope settled what to do:

1. **`grafo.json`'s node contract does not declare `resultado`; the pinned skill
   does.** The three gate manifests declare it (t260 for `triage-thesis`, t276
   for the other two); the node `output_schema`s in `grafo.json` declare only
   `outcome`. Preserved exactly.
2. **The closing prose of all three gates still teaches
   `resultado: "passed"`/`"failed"`.** The pinned schema's field is `outcome`
   with the enum `pass`/`fail`/`escalate_human`, and `resultado` carries the edge
   label. A real session that follows the prose emits a label matching no edge
   and stops the work at the node. Translated word for word — `passou` became
   `passed`, `falhou` became `failed` — so the mismatch survives with exactly the
   force it had.

Both are recorded in the bundle's own README, divergence 7, which now says
plainly that the translation carried them rather than fixing them.
**A follow-up ticket is worth filing for the pair**, and it is one ticket: the
three gates are wrong the same way, and the repair crosses AT8 of
`tests/factory-graph-2.test.mjs`, which matches the prohibitive prose by the word
`passed`.

A third, smaller one was preserved for the same reason and is worth naming
because nobody had recorded it: **`grafo.json`'s `record-monitoring` node
requires `nodes_executed` and `record_date`, while the manifest it pins requires
`traversal`.** The node contract was never updated when t270 moved the final
node onto `input.traversal`. It breaks nothing today — the contract check reads
the MANIFEST's schema, not the node's — and it was translated faithfully rather
than reconciled.

And a fourth, which is cosmetic and preserved on the same principle:
`record-crossing`'s `instructions` carry an **empty `## The metrics are process
metrics` heading**, immediately followed by `## What this graph does not
measure`. The paragraph that belonged under the first one is the list of
derivations two sections further down. It was that way in Portuguese, it is that
way in English, and reflowing it would have been a content change wearing a
translation's clothes.

## Real dependents beyond the ticket's declared surface

The ticket declared 16 paths and asked (Definition of Done #9) for anything else
to be named here rather than touched in silence. Six more files mention this
bundle's vocabulary. **None of them breaks**, and none was touched:

| File | What goes stale | Why it does not break |
|---|---|---|
| `packages/core/test/domain-custom-fields.test.ts:43-134` | A `DECLARATIONS` fixture mirroring the bets `custom_fields`, with `required_at: 'triagem'` and the node ids `coleta-fundamentos` / `dimensionamento-risco`, under a comment saying it is "what `grafos-de-fabrica/bets-assimetricas/grafo.json` declares". | The function under test is generic; the fixture is its own data. The comment is now false. |
| `packages/runner/test/engine/permission-enforcement.codex.test.ts:205,210` | A test NAME (`the derrubar-tese policy`) and a comment citing `skills/derrubar-tese.json`, a path that no longer exists. | The test builds its permissions inline and never reads the file. |
| `packages/runner/test/dispatch/factory-bundle-permission-policy.test.ts:113` | A comment citing `coletar-fundamentos` as the bundle's open-network skill. | Reads only the software bundle. |
| `tests/graph-schema.test.mjs:663` | A comment citing `{{input.project.criterios_de_triagem}}`. | The assertion below it only checks that `graph.project` is an object. |
| `packages/core/src/repositories/job.ts`, `packages/core/src/repositories/session.ts`, `packages/runner/src/dispatch/render-input-values.ts` | Comment-only illustrative mentions of bets vocabulary. | Named in the ticket's own Out of Scope, left for a t291-class sweep. |

`packages/core/test/cli-atlas-publish.test.ts`, `packages/core/test/cli-support.ts`
and `scripts/publish-atlas-bundle.test.mjs` read the bundle by DIRECTORY and by
`problem_class`, both of which are t282's and unchanged, so they neither break
nor go stale.

## Three scoping calls a reader might otherwise mistake for an oversight

1. **`tests/fixtures/tese-exemplo-bets-assimetricas.json` keeps its Portuguese
   frame keys** — `travessia`, `no`, `entrada`, `saida`, `aresta_esperada`,
   `pergunta_de_alocacao`, `decisao_sem_resposta_humana`, `saida_tentada`. The
   ticket scopes the fixture to the `"no"` values, the `"aresta_esperada"` value
   and the top-level description; those keys are the fixture's own structure,
   not the bundle's. The payload keys INSIDE `entrada`/`saida` did move, and had
   to: `additionalProperties: false` on every manifest means the fixture is
   validated against the translated schemas.
2. **The Portuguese thesis prose stays**, in the fixture and in the e2e
   crossing's payload values. It is the language the worked example was written
   in, it is not the bundle's vocabulary, and the ticket did not ask for it. A
   future ticket that wants an all-English example is welcome to it; it is a
   rewrite of an example, not a translation of a contract.
3. **Historical quotations keep their old spelling.** The e2e header records what
   `triar-tese` read BEFORE t260 (`{{input.tese.titulo}}` and friends) and what
   `registrar-travessia` named before t270 (`{{input.nos_executados}}`).
   Translating a quotation of a bug makes the bug's record false, so those stay
   as they were, with the current id named alongside.

## One thing this ticket was told to fix and did not

Functional Requirement 14 lists nine stale comments. Eight were fixed. The
ninth, `packages/runner/scripts/spike-graph-traversal.mjs:99`, is **not stale**:
it quotes `schema/exemplos/grafo-valido-flowpilot.json`, which really does still
declare `cartografo/refinar-ticket`, `cartografo/desenvolver-ticket` and the
other three namespaced Portuguese ids. That example is a document that validates
against the graph schema and that nothing can register — which is exactly the
point the comment is making. Renaming the citation would have made a true
comment false. The file itself is a legitimate target for the folder-and-name
ticket (t282) or for whoever eventually translates `schema/exemplos/`.

## What the next bundle ticket can plan against

There is no next bundle: these two are all the repository ships, and both are
translated. What is left of D24 is t281 (`docs/`, `especificacoes/`,
`DECISIONS.md`, `notas/`) and t282 (folder, package, bin and script names), and
neither of them inherits a factory-bundle carve-out — `SKIP_DIRS` is empty and a
gate now holds it that way.

Two things they will hit that this ticket met first:

- **`packages/runner/src/dispatch/prompt.ts:70` still writes `# Trabalho #N`.**
  It is the first line of every session prompt in the system, and one factory
  manifest quotes it by name. Whoever translates it has to move the manifest's
  quotation in the same commit, recut that manifest's hash and repin the node —
  a prompt-string change that is also a D4 pin change, which is not obvious from
  the diff.
- **The five glossary entries t280 declared and did not apply are still
  unspent** (`banco_de_testes`, `referencia`, `perguntas_respondidas`,
  `resultado` and their children). This ticket inherited the call for the three
  roots it declares and did not re-derive it. Whoever spends them is renaming a
  cross-package projection contract in `packages/core` and `packages/runner`
  first, and the bundles only afterwards.
