# Especificação: documento de grafo

**Versão do formato:** 1.0.0 · **Schema:** [`schema/grafo.schema.json`](../../schema/grafo.schema.json)
(JSON Schema draft 2020-12, `$id: urn:cartografo:schema:grafo:1.0.0`)
**Validador de referência:** [`scripts/validar-grafo.mjs`](../../scripts/validar-grafo.mjs)

O grafo é **dado, não código** (D15). Este documento especifica o formato desse
dado: o que um grafo de trabalho declara, o que cada campo significa, e as
quatro regras formais que separam um grafo executável de um desenho bonito.

É o ponto de extensão nº 1 do projeto — dos quatro formatos tratados como
produto (`notas/2026-08-14-extensao-e-qualidade.md`), este é o primeiro, e tudo
o que vem depois o consome: o control plane guarda este documento inteiro na
coluna `snapshot` de `grafo_versao`; os grafos de fábrica são escritos nele; o
atlas o empacota.

---

## 1. O documento

Um grafo é **um arquivo JSON**, com sete chaves de nível superior. Não há
segundo arquivo, nem include, nem referência externa a resolver: o documento é
autocontido de propósito (ver §7).

```json
{
  "classe": "desenvolvimento-de-software",
  "linhagem": { "tipo": "base" },
  "metadata": { "nome": "...", "versao_schema": "1.0.0" },
  "nos": [ /* ... */ ],
  "arestas": [ /* ... */ ],
  "no_inicial": "refinar",
  "nos_finais": ["implantar"]
}
```

| Campo | Tipo | Obrigatório | O que é |
|---|---|---|---|
| `classe` | string | sim | Identidade da classe de problema, nomeada pelo usuário (D8). Raiz de versionamento do grafo e unidade de agregação da telemetria. |
| `linhagem` | objeto | sim | Posição na linhagem da classe: base ou variante (D13). Ver §5. |
| `metadata` | objeto | sim | Nome, descrição, versão do schema, data, origem. Gaveta deliberadamente aberta a chaves extras. |
| `nos` | lista | sim | As etapas. Pelo menos uma. Ver §2. |
| `arestas` | lista | sim | As transições. Ver §3. |
| `no_inicial` | id de nó | sim | Onde toda travessia começa. Precisa existir em `nos`. |
| `nos_finais` | lista de ids | sim | Onde a travessia termina. Pelo menos um; todos precisam existir em `nos`. |

**Ids de nó** são minúsculas, dígitos, hífen e underscore (`^[a-z0-9][a-z0-9_-]*$`),
únicos dentro do documento. São a chave por onde arestas, telemetria e propostas
de mutação se referem ao nó — trocar um id é uma operação semântica, não um
rename cosmético.

Os nomes de campo estão **em português**, como o resto do repositório. Vale
reavaliar para inglês quando o schema estiver perto de congelar (regra dos dois
consumidores: depois do grafo de fábrica 2, `t116`), não antes.

---

## 2. Nó

Uma etapa do grafo. Tudo que executa no sistema é skill com contrato; o que muda
é o papel — **fazer, conferir, rotear**.

```json
{
  "id": "testar",
  "papel": "tester",
  "tipo_no": "portao",
  "descricao": "Exercita o comportamento entregue e roteia.",
  "skill_ref": { "id": "cartografo/testar-alpha", "versao": "1.0.0", "hash": "sha256:5f5184…" },
  "contrato": { "entrada_schema": {}, "saida_schema": {}, "verificacoes": [] }
}
```

| Campo | Obrigatório | O que é |
|---|---|---|
| `id` | sim | Identificador único no documento. |
| `papel` | sim | Quem faz o trabalho, na linguagem do domínio: `arquiteto`, `desenvolvedor`, `red-team`. |
| `tipo_no` | sim | `trabalho` ou `portao`. |
| `descricao` | não | O que o nó faz, em uma frase. |
| `skill_ref` | sim | Ponteiro para a skill do registro, pinado. |
| `contrato` | sim | Entrada, saída e verificações. |

### `tipo_no`: por que portão é nó

**Portão não é entidade separada.** Um portão é um nó cujo papel é conferir e
rotear, e ele carrega skill e contrato exatamente como qualquer outro nó
(`notas/2026-08-14-aprendizado.md`). A distinção `trabalho` / `portao` existe
para leitura e telemetria — "quanto tempo o trabalho passou em verificação?" —,
não para dar ao portão um lugar privilegiado no formato.

Duas consequências que o formato herda dessa escolha:

- Portão é **determinístico sempre que possível** (rodar teste, validar schema,
  build) e **agêntico só onde há julgamento**. Isso aparece no contrato, em
  `verificacoes`, não em um campo próprio do nó.
- Portão agêntico verifica com **evidência própria** — roda o resultado — nunca
  com o relato de quem fez o trabalho. Daí `evidencia_obrigatoria` ser
  `const: true` no schema: um check agêntico sem evidência anexada não é
  verificação, é opinião.

### `skill_ref`: ponteiro pinado

```json
{ "id": "cartografo/testar-alpha", "versao": "1.0.0", "hash": "sha256:<64 hex>" }
```

Ponteiro **opaco**: o formato interno do manifesto de skill é outro documento
(`t97`); aqui só o pin importa. Os três campos são obrigatórios porque skill
importada de repositório externo é vetor de prompt injection (D4) — o hash é o
que impede a troca silenciosa do conteúdo de uma skill por baixo de um grafo já
validado. `versao` é semver; `hash` é `sha256:` seguido de 64 hex.

> Nos exemplos deste repositório os hashes são **placeholders reprodutíveis**:
> `sha256` da string `placeholder:<id da skill>@<versao>`. Nenhuma skill real
> existe ainda para ser pinada.

### `contrato`: a peça de sustentação

Entrada e saída em JSON Schema, verificação como lista de checks tipados (D9,
README princípio 3). Sem contrato o sintetizador compõe por alucinação; com
contrato, compor grafo vira **casar contratos**.

| Campo | Obrigatório | O que é |
|---|---|---|
| `entrada_schema` | sim | JSON Schema da projeção de estado que o nó recebe. Projeção, não janela comum (README princípio 4). |
| `saida_schema` | sim | JSON Schema do que o nó devolve ao quadro. |
| `verificacoes` | sim | Lista com **pelo menos um** check. Como se confere o que o nó produziu. |

Cada verificação é de um de dois tipos:

```json
{ "tipo": "deterministico", "comando": "make check", "descricao": "…" }
```
```json
{ "tipo": "agentico",
  "instrucao": "Rode o comportamento e confira cada critério de aceite. Anexe a saída.",
  "evidencia_obrigatoria": true,
  "descricao": "…" }
```

O limite honesto do framework está aqui: **densidade de verificação** (README
princípio 6). Onde não dá para escrever a verificação de uma etapa, não há
portão; sem portão, o grafo é decorativo.

---

## 3. Aresta

Uma transição rotulada entre dois nós.

```json
{ "de": "testar", "para": "desenvolver", "condicao": "retrabalho", "descricao": "…" }
```

| Campo | Obrigatório | O que é |
|---|---|---|
| `de` | sim | Id do nó de origem; precisa existir em `nos`. |
| `para` | sim | Id do nó de destino; precisa existir em `nos`. |
| `condicao` | sim | String não vazia. Ver abaixo. |
| `descricao` | não | Quando esta transição acontece. |

**`condicao` é um rótulo, não uma expressão.** Duas formas:

- **Rótulo de resultado do nó de origem** (`"aprovado"`, `"retrabalho"`) quando a
  origem tem múltiplas saídas — tipicamente um portão. O rótulo casa com o
  `resultado` que o `saida_schema` do nó de origem declara.
- **O literal `"sempre"`** quando a origem tem saída única.

Não há linguagem de expressão booleana, e isso é deliberado: desenhar uma antes
de existirem dois grafos reais pressionando o formato é desenhar para um caso de
uso que ainda não existe (regra dos dois consumidores). Quando o segundo grafo
de fábrica (`t116`) pedir mais, o formato ganha mais — com evidência.

Ciclo é legítimo (o retrabalho `testar → desenvolver` é um), desde que a regra
`termina` (§6) continue valendo. O que **não** é legítimo é o nó escolher
caminho livremente em runtime: as únicas decisões em voo são as dos portões,
sobre arestas já declaradas (README princípio 2).

---

## 4. `no_inicial` e `nos_finais`

`no_inicial` é único: toda travessia começa no mesmo lugar. `nos_finais` é lista
porque um grafo pode terminar de mais de um jeito (aprovado e arquivado são
ambos fins legítimos). Um nó final não precisa ser folha topológica — precisa
apenas ser um ponto onde a travessia pode parar.

---

## 5. Classe e linhagem

`classe` (D8) é nomeada pelo usuário na declaração do problema; o sintetizador
apenas sugere uma classe existente quando reconhece semelhança. Ela é a raiz de
versionamento do grafo e a unidade de agregação da telemetria — dois grafos da
mesma classe são comparáveis; de classes diferentes, não.

`linhagem` (D13) posiciona este grafo dentro da classe:

```json
{ "tipo": "base" }
```
```json
{ "tipo": "variante", "base_classe": "desenvolvimento-de-software",
  "origem_proposta_id": "prop-2026-08-31-004" }
```

| Campo | Obrigatório | O que é |
|---|---|---|
| `tipo` | sim | `base` (o grafo canônico da classe) ou `variante` (fork de um base). |
| `base_classe` | quando `variante` | Classe do grafo-base do qual a variante saiu. |
| `origem_proposta_id` | não | Proposta do topógrafo que originou o fork. |

Um `base` não declara `base_classe` nem `origem_proposta_id` — o schema proíbe.

`origem_proposta_id` é opcional, mas quase sempre presente: **fork nunca nasce
de decisão a priori**, e sim de proposta do topógrafo com evidência de
divergência sistemática na telemetria (D13). A exceção prevista é a variante
importada de um atlas externo, que não tem proposta local de origem. O
aprendizado flui nos dois sentidos e sempre com portão: diff de variante que
supera o base vira proposta de promoção; melhoria no base é oferecida às
variantes, nunca forçada.

---

## 6. Soundness

Validação de **forma** é o JSON Schema. Validação de **soundness** é semântica e
mora em [`scripts/validar-grafo.mjs`](../../scripts/validar-grafo.mjs), que
exporta duas funções:

```js
validarEstrutura(doc) // → { valido, erros: [{ codigo, mensagem, alvo }] }
validarSoundness(doc) // → { valido, violacoes: [{ regra, alvo }] }
```

`validarEstrutura` cobre integridade de forma e de referência: chaves
obrigatórias presentes, ids de nó únicos, toda aresta e todo id em
`no_inicial`/`nos_finais` apontando para nó existente. `validarSoundness` roda
as quatro regras abaixo, nesta ordem. Nenhuma das duas lança exceção em
documento malformado: o sintetizador precisa do relatório inteiro, não do
primeiro erro.

As regras vêm de workflow nets (van der Aalst) e são um dos inegociáveis de
qualidade do projeto. É delas que sai a frase de posicionamento: **"verificamos
formalmente os grafos que a IA propõe"**.

| Regra | O que exige | Alvo relatado | Contraexemplo |
|---|---|---|---|
| `alcançável` | Todo nó é atingível a partir de `no_inicial` seguindo `arestas`. | id do nó | [`grafo-invalido-no-inalcancavel.json`](../../schema/exemplos/grafo-invalido-no-inalcancavel.json) |
| `termina` | De todo nó existe caminho até algum nó em `nos_finais`. | id do nó | [`grafo-invalido-sem-terminacao.json`](../../schema/exemplos/grafo-invalido-sem-terminacao.json) |
| `aresta_com_condicao` | Nenhuma aresta com `condicao` ausente ou vazia. | `{de, para}` | [`grafo-invalido-aresta-sem-condicao.json`](../../schema/exemplos/grafo-invalido-aresta-sem-condicao.json) |
| `no_com_contrato` | Nenhum nó sem `skill_ref` ou `contrato`, nem com `verificacoes` vazio. | id do nó | [`grafo-invalido-no-sem-contrato.json`](../../schema/exemplos/grafo-invalido-no-sem-contrato.json) |

Notas de leitura:

- **`alcançável` é topológica.** Ela segue arestas independentemente da
  condição: uma aresta com rótulo vazio ainda liga dois nós. Quem reclama do
  rótulo é `aresta_com_condicao`. As regras são independentes de propósito —
  cada contraexemplo do repositório viola exatamente uma delas, o que torna cada
  regra demonstrável isolada.
- **`termina` é calculada de trás para frente**, das arestas invertidas a partir
  dos nós finais. Nó preso em ciclo sem saída simplesmente nunca é atingido — é
  assim que um ciclo de retrabalho legítimo passa e um esquecimento de saída não.
- **`no_com_contrato` vale igual para portão**, que é nó como outro qualquer.

Rodando pela linha de comando (sai 1 se algum documento falhar):

```
node scripts/validar-grafo.mjs schema/exemplos/*.json
```

Os testes são `node --test` (o repositório ainda não tem `package.json`, por
escolha — zero dependências).

---

## 7. O documento como bundle exportável

Versionamos como o git pensa, sem o git no núcleo (D15). O snapshot de uma
versão de grafo é **este documento inteiro**, e é isso que a coluna `snapshot` de
`grafo_versao` guarda quando o control plane existir (`t100`/`t101`). Como o
documento é autocontido, ele **já é o bundle mínimo exportável**: uma versão
qualquer sai como um arquivo, atravessa a borda (atlas, backup, espelho em repo
do usuário, futura aprovação via PR) e volta sem precisar do banco de origem.

O que o formato pressupõe do resto do sistema:

- **Diff semântico, não diff de linha.** Uma proposta do topógrafo é uma lista de
  operações tipadas sobre este documento (acrescentar nó, redirecionar aresta,
  apertar verificação), cada uma com sua inversa. A ordem das chaves e a
  formatação do JSON não carregam significado.
- **Append-only.** Aplicar proposta é: aplicar ops → validar soundness no
  resultado → gravar versão nova → mover ponteiro. Rollback move o ponteiro de
  volta; nada se apaga.

Empacotamento multi-grafo e multi-arquivo — layout do atlas, passo de
publicação, verificação de integridade na travessia — está em
[`docs/formatos/atlas-bundle.md`](../formatos/atlas-bundle.md), que trata um
diretório por classe (`grafo.json` mais os manifestos que os nós pinam) e
mantém a verificação nos dois hashes que já existem: o `id` da versão de grafo
e o `skill_ref.hash` de cada nó. Aqui termina em: um grafo, um arquivo,
autocontido.

---

## 8. Exemplos

Todos em [`schema/exemplos/`](../../schema/exemplos/), todos exercitados por
`tests/schema-grafo.test.mjs`.

| Arquivo | Para que serve |
|---|---|
| [`grafo-valido-minimo.json`](../../schema/exemplos/grafo-valido-minimo.json) | O menor documento sound: um nó de trabalho, um portão terminal, uma aresta `"sempre"`. Esqueleto para o primeiro grafo. |
| [`grafo-valido-flowpilot.json`](../../schema/exemplos/grafo-valido-flowpilot.json) | **Exemplo-mestre.** Ver abaixo. |
| `grafo-invalido-*.json` | Um contraexemplo por regra de soundness (§6). |

### O exemplo-mestre: o fluxo do flowpilot

[`grafo-valido-flowpilot.json`](../../schema/exemplos/grafo-valido-flowpilot.json)
é o fluxo de entrega de software do flowpilot expresso neste formato, e é
**insumo direto do grafo de fábrica 1 (`t105`)**: a ticket do grafo de fábrica
parte deste arquivo em vez de partir de uma folha em branco. Por D17 o flowpilot
é referência de comportamento **sem dependência de código** — o porte é
reimplementação, e nada aqui lê nada de lá em tempo de execução.

Cinco nós, um por estado de atividade:

| Nó | Papel | `tipo_no` | Estado no flowpilot |
|---|---|---|---|
| `refinar` | arquiteto | trabalho | `refining` |
| `desenvolver` | desenvolvedor | trabalho | `developing` |
| `integrar` | integrador | trabalho | `integrating` |
| `testar` | tester | **portao** | `testing` |
| `implantar` | deployer | trabalho | `deploying` |

Cinco arestas, seguindo `ALLOWED_TRANSITIONS`:

```
refinar ──sempre──▶ desenvolver ──sempre──▶ integrar ──sempre──▶ testar
                          ▲                                        │
                          └──────────── retrabalho ────────────────┤
                                                                   │
                                                    implantar ◀──aprovado
```

Duas decisões de modelagem que o porte tomou:

1. **Os estados de fila do flowpilot não viram nó.** `to_refine`, `to_develop`,
   `to_integrate`, `to_test` e `to_deploy` são plumbing de escalonamento do
   controller — onde o trabalho espera, não o que o trabalho faz. As arestas do
   grafo são as transições de `ALLOWED_TRANSITIONS` com essas filas colapsadas.
   Pelo mesmo critério, `backlog` e `done` ficam fora: `implantar` é o nó final,
   e o `deploying → done` do flowpilot não tem nó de destino aqui.
2. **`testar` é `portao`.** É o único nó com múltiplas saídas, e o que ele
   produz é um veredito que roteia — `aprovado` segue para implantação,
   `retrabalho` volta para desenvolvimento (o ciclo de teste alfa do flowpilot).
   Os demais são `trabalho`: entregam artefato e têm saída única.

Ficaram deliberadamente de fora as três arestas de `TRIVIAL_EXTRA_TRANSITIONS`
(os atalhos por `work_tier`): tier é política de escalonamento aplicada sobre a
topologia, não topologia. Se o porte precisar delas, entram como decisão da
`t105`, com registro.
