# Grafo de fábrica 1 — desenvolvimento de software

> O primeiro mapa real do cartografo: o fluxo de entrega de software, com os
> cinco manifestos de skill que os nós dele pinam por hash. Grafo de fábrica no
> sentido da **D14** — entregue pronto para uso, não sintetizado.

**Estado: conteúdo, não formato.** Esta ticket (`t105`) não desenha formato
novo: aplica os dois já fechados — o documento de grafo
([`docs/spec/grafo.md`](../../docs/spec/grafo.md), `t96`) e o manifesto de skill
([`especificacoes/formatos/manifesto-skill.md`](../../especificacoes/formatos/manifesto-skill.md),
`t97`) — para produzir o primeiro conteúdo real. É insumo direto da PoC (D16) e
a semente da biblioteca de fábrica.

| Arquivo | O que é |
|---|---|
| [`grafo.json`](./grafo.json) | O documento de grafo: cinco nós, cinco arestas, um `skill_ref` pinado por nó. |
| [`skills/refinar-ticket.json`](./skills/refinar-ticket.json) | `fazer` — pedido bruto vira especificação executável. |
| [`skills/desenvolver-ticket.json`](./skills/desenvolver-ticket.json) | `fazer` — implementação em checkout isolado, testes de aceite primeiro. |
| [`skills/integrar-branch.json`](./skills/integrar-branch.json) | `fazer` — merge reconciliando os dois lados, com qualidade reverificada na árvore mesclada. |
| [`skills/testar-alpha.json`](./skills/testar-alpha.json) | `portao` — caminhada semântica dos critérios de aceite contra a aplicação rodando. |
| [`skills/implantar-release.json`](./skills/implantar-release.json) | `fazer` — verificação determinística de que o merge commit está publicado. |

## A topologia

```
refinar ──sempre──▶ desenvolver ──sempre──▶ integrar ──sempre──▶ testar
                          ▲                                        │
                          └──────────── retrabalho ────────────────┤
                                                                   │
                                                    implantar ◀──aprovado
```

`no_inicial: "refinar"`, `nos_finais: ["implantar"]`. Um nó por estado de
atividade do flowpilot; os estados de fila (`to_refine`, `to_develop`, …) são
plumbing de escalonamento e não viram nó, e por isso `backlog`/`done` também
ficam fora. Não existe aresta de reprovação separada: a única volta é o ciclo
de retrabalho `testar → desenvolver`.

O `grafo.json` **parte de**
[`schema/exemplos/grafo-valido-flowpilot.json`](../../schema/exemplos/grafo-valido-flowpilot.json)
— o exemplo-mestre do `t96`, lido como referência e **nunca modificado**. Dois
lugares diferem dele. O `skill_ref` de cada nó: no exemplo os hashes são
placeholders reprodutíveis (nenhuma skill real existia para pinar) e os ids
carregam um prefixo ilustrativo `cartografo/`; aqui os ids são kebab-case puro,
iguais ao `id` de cada manifesto, e os hashes são os hashes reais do conteúdo
pinado. E o `contrato.verificacoes` de cada nó, que no exemplo ilustrava o
formato com comandos de uma stack inventada (`make check`, `make smoke`) e aqui
restata os `checks` do manifesto pinado — ver "Divergências registradas".

Por D17 o flowpilot é **referência de comportamento, sem dependência de
código**: o porte é reimplementação, e nada neste bundle lê nada de lá em tempo
de execução.

## Como validar

```bash
# grafo + manifestos + pinos de hash + paridade das verificações, tudo de uma vez
node ../../scripts/validate-factory-bundle.mjs .

# checagem cruzada do formato dos manifestos, com um validador de terceiro
npx --yes ajv-cli@5 validate \
  -s ../../especificacoes/formatos/manifesto-skill.schema.json \
  -d './skills/*.json' --spec=draft2020
```

O primeiro comando confere as quatro coisas que fazem disto um bundle e não um
punhado de JSON no mesmo diretório: o grafo é sound pelas quatro regras do
`t96`, cada manifesto vale contra o schema do `t97`, **cada pino fecha** — o
hash recalculado do conteúdo de cada manifesto bate com o que o `skill_ref` do
nó correspondente pina (D4) — e **as duas declarações de como cada nó se
verifica batem**: `contrato.verificacoes` no grafo e `checks` no manifesto
pinado trazem a mesma quantidade de itens, a mesma sequência de `tipo` e o
mesmo `comando` em todo item determinístico (`t176`).

O hash é o do procedimento canônico da especificação do manifesto: `sha256` do
JSON canônico de `{instrucoes, entrada, saida, checks, permissoes}`. Mexeu numa
linha de `instrucoes`, afrouxou um check ou abriu uma permissão, o hash muda e
o bundle para de validar até o `skill_ref` do nó ser atualizado — que é
exatamente a mudança que D4 quer trazer de volta ao portão humano.

Os testes de aceite deste bundle estão em
[`tests/factory-graph-1.test.mjs`](../../tests/factory-graph-1.test.mjs)
(`node --test`), e os do validador em
[`scripts/validate-factory-bundle.test.mjs`](../../scripts/validate-factory-bundle.test.mjs).

## Convenção de diretório

`grafos-de-fabrica/<classe>/` é a forma do bundle, nomeada a partir da string
de `classe` do documento (D8), e ela é a mesma do atlas: um subdiretório por
classe, com `grafo.json` e os manifestos que os nós pinam. O layout, o passo de
publicação e a verificação de integridade na travessia estão em
[`docs/formatos/atlas-bundle.md`](../../docs/formatos/atlas-bundle.md) — v0,
não congelada, pela regra dos dois consumidores.

Na prática isso quer dizer que este diretório e um checkout de atlas são
entradas intercambiáveis do mesmo comando, e que publicar este bundle num atlas
é copiá-lo para lá depois de validado:

```sh
node scripts/publish-atlas-bundle.mjs \
  grafos-de-fabrica/desenvolvimento-de-software ../atlas
```

O registro de skills do control plane já existe, e `cartografo import
grafos-de-fabrica/desenvolvimento-de-software` registra os cinco manifestos
(`POST /v1/skills`, cada um revalidado pelo servidor) antes de mandar o grafo:
manifesto que o registro recusa aborta a importação e o grafo não sobe. O
validador determinístico acima continua sendo o critério de aceite **do
bundle como artefato de repositório** — ele roda sem servidor nenhum, no
`npm test`, e é o que garante que o diretório está íntegro antes de qualquer
importação. O caminho pela API tem cobertura própria em
[`packages/core/test/cli-import-export.test.ts`](../../packages/core/test/cli-import-export.test.ts).

## Divergências registradas

Dois lugares onde este porte se afasta do que a fonte faz ou do que o rascunho
do `t96` sugeria, mais um que já foi reconciliado. Ficam escritas porque
divergência não registrada vira armadilha para quem vier depois.

1. **`implantar` é nó agêntico e não deveria ser.** No flowpilot esta etapa
   nunca abre sessão: é uma varredura 100% determinística (uma pergunta de
   ancestralidade de commit, três respostas possíveis). O `tipo_no` do schema
   do grafo só conhece `trabalho` e `portao`, ambos despachando skill por
   engine, e criar um terceiro tipo "sem sessão" agora violaria a regra dos
   dois consumidores — o schema do grafo só estende depois de dois grafos
   reais pressionando. O porte deixa o nó agêntico com checks 100%
   determinísticos e instruções triviais; quando houver um segundo caso real,
   o tipo novo entra com dois consumidores para provar o formato.
2. **Dois vocabulários para o resultado do portão.** O `saida_schema` do nó
   `testar` (herdado do exemplo) usa `aprovado`/`retrabalho`/`escala`, que são
   os rótulos das arestas; o manifesto usa o enum que o formato de portão
   exige, `passou`/`falhou`/`escalar_humano`. O mapeamento é direto e está
   escrito nas `instrucoes` de `testar-alpha`: `passou` → aresta `aprovado`,
   `falhou` → aresta `retrabalho`.

**Reconciliada pelo `t176` — o manifesto é a única fonte que declara COMO um nó
se verifica.** O grafo nascia do exemplo-mestre do `t96` com `make check` em
`desenvolver`, `integrar` e `testar` e `make smoke` em `implantar`: tecnologia
hardcoded, e no caso do `testar` o **oposto** do que o manifesto manda — a
skill de teste proíbe explicitamente rerodar os gates que a integração já rodou
contra esta mesma árvore (`flowpilot testing.py:77`, "NEVER re-run the quality
gates as the validation"). Onde os dois discordavam, valeu o manifesto: é ele
que o runner injeta na sessão. Hoje o `contrato.verificacoes` de cada nó
restata os `checks` do manifesto que o nó pina — mesma quantidade, mesma
sequência de `tipo`, mesmo `comando` nos determinísticos — e o `testar` ficou
só com a caminhada semântica. Os dois continuam sendo **formatos distintos para
a mesma verificação**, não o mesmo campo duplicado: `evidencia_obrigatoria` é
lista de artefatos no manifesto e o literal `true` no grafo, e o texto de um
item agêntico é reescrito em cada formato em vez de copiado — a disciplina que
`packages/runner/src/synthesizer/prompt.ts` já instrui ao sintetizador. Voltar
a divergir na estrutura agora derruba o validador, sem depender de revisão
manual de paridade.

E uma consequência que vale explicitar: **escalar para humano não é aresta**.
As cinco skills carregam o mesmo contrato de escalação (o bloco
`input-request`), e uma sessão que precisa do fundador pausa em vez de rotear —
o trabalho fica bloqueado, a pergunta entra na fila de escalação, e ao ser
respondida a sessão retoma e só então resolve. `escalar_humano` existe no enum
porque o formato de portão exige os três valores, mas neste grafo nenhuma
sessão o emite: as únicas decisões em voo são saídas de portão sobre arestas já
declaradas.
