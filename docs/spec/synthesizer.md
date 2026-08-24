# Especificação: sintetizador copiloto, da declaração ao rascunho

**Versão da API:** `v1` · **Implementação:** [`packages/runner/src/synthesizer/`](../../packages/runner/src/synthesizer)
**Decisão de origem:** [D10](../../DECISIONS.md) — "sintetizador como copiloto no MVP: ele propõe, o humano edita, e a edição humana É o portão inteiro"

Toda a pilha até aqui executa grafos que alguém escreveu à mão. Esta camada é a
primeira que **produz** um: recebe um problema em linguagem natural, consulta o
que já existe no registro, e devolve uma topologia no formato de
[`schema/grafo.schema.json`](../../schema/grafo.schema.json) para uma pessoa
editar.

Duas fronteiras organizam o documento inteiro, e é melhor lê-las antes de
qualquer detalhe:

- **O sintetizador não registra nada.** Ele para num arquivo de rascunho. Quem
  transforma rascunho em classe é `cartografo import` ([t108](../../packages/core/src/cli/import.ts)),
  rodado por uma pessoa depois de ela editar o arquivo. Não existe `POST
  /v1/graphs` nesta camada e o cliente dela nem tem o método — mesma disciplina
  que mantém `aplicar` fora do cliente do topógrafo.
- **O sintetizador não nomeia classe.** [D8](../../DECISIONS.md) põe isso na mão
  do usuário: `--class` é obrigatória, e as classes parecidas que o comando
  calcula são *sugestão*, impressas e embutidas no prompt, sem poder nenhum
  sobre o nome.

Junto, isso é a escada de segurança do [README, princípio 5](../../README.md)
aplicada ao sintetizador: a peça mais autônoma do sistema é a que menos escreve.

---

## 1. As cinco partes

| Parte | Onde | O que faz | Determinística? |
|---|---|---|---|
| Cliente de leitura | [`control-plane-client.ts`](../../packages/runner/src/synthesizer/control-plane-client.ts) | As três leituras da API. Nenhuma escrita. | Sim (é HTTP). |
| Similaridade | [`similarity.ts`](../../packages/runner/src/synthesizer/similarity.ts) | Pontua a declaração contra as classes registradas. | Sim: função pura. |
| Prompt | [`prompt.ts`](../../packages/runner/src/synthesizer/prompt.ts) | Monta o contrato inteiro da sessão. | Sim: função pura. |
| Parser da cerca | [`parse-graph-proposal.ts`](../../packages/runner/src/synthesizer/parse-graph-proposal.ts) | Extrai o documento do bloco ` ```grafo-proposto `. | Sim: função pura, nunca lança. |
| Orquestrador | [`synthesize.ts`](../../packages/runner/src/synthesizer/synthesize.ts) | Recusa, pontua, despacha **uma** sessão, grava o rascunho. | Tudo menos a sessão. |

O entrypoint ([`cli.mjs`](../../packages/runner/src/synthesizer/cli.mjs)) é
fiação e nada mais: engine, diretório de rascunho, stdout e código de saída. Toda
decisão — inclusive a leitura do argv — mora em `synthesize.ts`, onde um teste
alcança sem precisar subir um processo.

---

## 2. O comando

```
npm run synthesize --workspace @cartografo/runner -- \
  "<declaração do problema>" --class <nome> \
  [--url <url>] [--out <caminho>] [--timeout <segundos>]
```

| Argumento | Obrigatório | Default | Papel |
|---|---|---|---|
| `<declaração>` | sim (posicional) | — | O problema em linguagem natural, como a pessoa o descreve. |
| `--class` | **sim** | — | O nome da classe. Quem nomeia é o usuário (D8). |
| `--url` | não | `http://127.0.0.1:4317` | Control plane. |
| `--out` | não | `<classe>.grafo.rascunho.json` no diretório atual | Onde gravar o rascunho. |
| `--timeout` | não | `900` | Limite de relógio da sessão, em segundos. |

Os códigos de saída são o contrato, porque é isso que uma pessoa (ou um script)
lê:

- **`0`** — um rascunho foi gravado. O caminho é a primeira linha do stdout;
- **`1`** — rodou e não deu: classe já registrada, sessão morta, ou nenhum bloco
  válido. **Nada foi gravado**;
- **`2`** — o comando foi digitado errado. Nada rodou.

`1` e `2` são separados de propósito: quem não distingue "a sua linha de comando
está errada" de "a sessão falhou" não consegue decidir se faz sentido tentar de
novo.

---

## 3. A ordem de uma rodada

```
GET /v1/classes
        │
        ├─ a classe de --class já tem grafo base ──▶ sai 1, SEM abrir sessão
        ▼
para cada classe com versão corrente:
  GET /v1/graph-versions/:id  ──▶  similarity(declaração, nome + descricao)
        ▼
top 3 com score > 0  (sugestão não bloqueante: impressa e embutida no prompt)
        ▼
GET /v1/skills   ──▶  catálogo de capacidades
        ▼
UMA sessão de EngineAdapter, com o prompt do §5
        │
        ├─ status != completed, ou nenhum bloco `grafo-proposto` válido
        │  ──▶ sai 1, imprime a saída bruta, NÃO grava arquivo
        ▼
grava <classe>.grafo.rascunho.json  (JSON identado com 2 espaços)
        ▼
imprime o caminho + resumo de uma linha  ──▶  fim. Nenhum POST.
```

A ordem das duas primeiras etapas é decisão, não acaso: a recusa de classe já
registrada vem **antes** do catálogo e antes de qualquer sessão. Estender uma
linhagem existente é fluxo de proposta ([D13](../../DECISIONS.md), t118), e
descobrir isso depois de gastar uma sessão é descobrir tarde. O código de erro
ecoa o da API (`classe_ja_registrada`, [`routes/graphs.ts`](../../packages/core/src/routes/graphs.ts))
para que as duas recusas sejam obviamente a mesma recusa.

---

## 4. A similaridade, e por que ela não decide nada

O sinal é `metadata.nome` + `metadata.descricao` da **versão corrente** de cada
classe, nunca o id da classe sozinho: `nota-curta` são dois tokens, e dois
tokens contra uma frase produzem um número que não diz nada — o heurístico tem
piso de 3 caracteres por token, justamente para não deixar preposição pontuar.

O heurístico é o Jaccard de [t113](../../packages/core/src/domain/similarity.ts),
**portado** para o runner em vez de importado. É a mesma troca que o core já fez
quando `domain/graph.ts` portou `scripts/validar-grafo.mjs`: o runner é cliente
comum da API ([D1](../../DECISIONS.md)/[D11](../../DECISIONS.md)), fala HTTP e nada
mais, e uma dependência de compilação no `domain/` do control plane seria a
primeira rachadura na parede que
[`test/no-privileged-access.test.ts`](../../packages/runner/test/no-privileged-access.test.ts)
existe para manter em pé.

Cópia que pode divergir é pior que cópia nenhuma, então a paridade é **teste**,
não promessa: `test/synthesizer/similarity.test.ts` roda os casos de
`packages/core/test/domain-similarity.test.ts` contra o port. Mudar o heurístico
de um lado acusa do outro.

O teto é 3, espelhando o topo da base de precedentes. O corte não é por custo: uma
lista longa o bastante para incluir parecença fraca ensina a sessão que tudo se
parece com tudo — exatamente a falha que o piso de 3 caracteres evita uma camada
abaixo.

Uma classe sem versão corrente, ou cuja versão não pôde ser lida, é **pulada em
silêncio**. Isto é contexto opcional; derrubar o comando inteiro por causa de um
precedente seria deixar o acessório quebrar o principal.

---

## 5. A sessão: um turno, um bloco, nenhum privilégio

A `SessionSpec` segue a regra normativa do
[EngineAdapter](../formatos/engine-adapter.md): `instructions` e `prompt` nunca
chegam concatenados pelo chamador.

- **`instructions`** — o papel e as regras duras: a `classe` é do usuário e é
  literal; `linhagem` é sempre `{"tipo": "base"}`; todo `skill_ref` é copiado do
  catálogo; todo nó precisa de aresta de entrada e de saída; toda aresta tem
  `condicao`; todo `contrato` traz `verificacoes` com pelo menos uma verificação.
- **`prompt`** — a declaração verbatim, a classe alvo, os precedentes do §4 e o
  catálogo inteiro de skills (`id`, `versao`, `hash`, `papel`, `descricao`,
  `entrada`, `saida`, `checks` de cada uma), mais o contrato de saída.
- **`workingDir`** — um diretório temporário. A sessão não recebe URL do control
  plane, nem credencial, nem acesso de escrita a mais nada.

O catálogo carrega contrato de entrada, contrato de saída e checks porque é isso
que faz compor deixar de ser adivinhação: com contrato, montar grafo é casar
contratos ([README, princípio 3](../../README.md), [D9](../../DECISIONS.md)).

O que **não** vai no prompt é tão deliberado quanto o que vai: `instrucoes`,
`permissoes` e `origem` de cada skill ficam de fora. O texto de instrução de uma
skill importada é conteúdo que ninguém neste repositório escreveu — é o vetor de
prompt injection que a [D4](../../DECISIONS.md) fecha pinando por hash, e
despejá-lo dentro do prompt de quem está compondo seria abrir pela janela a porta
que a decisão fechou.

A regra mais dura do prompt é sobre `skill_ref`: **copiado literalmente do
catálogo, nunca inventado**. Um pin é o que impede troca silenciosa de capacidade
por baixo de um grafo já validado (D4), e um hash que o modelo inventou não é um
pin — é um grafo que vai ser reprovado no `import` depois de já ter custado a
edição de alguém.

### O prompt é a única fonte do formato

`workingDir` é um diretório temporário vazio: a sessão **não consegue abrir**
[`schema/grafo.schema.json`](../../schema/grafo.schema.json). Toda regra que o
portão de `cartografo import` (§7) aplica e que o prompt não diz é uma regra que
a sessão não tem como seguir — e a conta chega como `grafo_invalido` depois de a
pessoa já ter editado o rascunho.

Foi assim que t138 apareceu na rodada alpha: um rascunho obedecia cada palavra do
prompt e ainda assim voltava com `soundness no_com_contrato`, porque
`contrato.verificacoes` tem `minItems: 1` no schema e o prompt não falava disso.
Duas consequências viraram texto:

- **`verificacoes` com pelo menos uma verificação**, dito nas regras duras e
  repetido no contrato de saída, com o nome da regra de soundness que reprova a
  lista vazia. Vale igual para portão, que é nó como outro qualquer.
- **Um check do catálogo não é uma `verificacao`.** Os dois formatos divergem em
  `evidencia_obrigatoria`: lista de artefatos no
  [manifesto de skill](../../especificacoes/formatos/manifesto-skill.md), o
  literal `true` no documento de grafo. Como o catálogo imprime os `checks` de
  cada skill logo acima, o prompt mostra os dois formatos de verificação por
  extenso e diz para reescrever, não copiar. `prompt.test.ts` valida esses
  exemplos contra o schema de verdade, então eles não podem divergir do formato
  que existem para ensinar.

Isto continua não sendo validação (§9): o sintetizador não confere o documento
que recebeu de volta. É só o formato dito por inteiro para quem não pode lê-lo.

---

## 6. A cerca ` ```grafo-proposto `

A sessão termina o turno com exatamente um bloco cercado:

````
```grafo-proposto
{ … documento de grafo … }
```
````

O parser é o mesmo algoritmo de
[`parse-input-request.ts`](../../packages/runner/src/dispatch/parse-input-request.ts),
com as três regras intactas, porque elas nunca foram sobre escalação — são sobre
ler um valor JSON cercado no meio de prosa de modelo:

1. **A extensão do bloco sai do JSON, nunca de uma busca pela cerca de
   fechamento.** Um grafo proposto é cheio de prosa escrita por modelo, e prosa
   sobre grafo cita exemplo cercado de grafo; varrer até o próximo ``` cortaria
   o documento ao meio.
2. **Bloco malformado é ignorado, nunca lançado.** Saída ruim de modelo não
   derruba o comando: o chamador recebe `null` e o §3 transforma isso em saída 1
   com a saída bruta impressa.
3. **O último bloco válido vence.** Sessão que rascunha, se corrige e responde
   respondeu com o último documento.

A cerca tem nome próprio em vez de reaproveitar `input-request` por uma razão
concreta: os dois blocos podem aparecer no mesmo fluxo — uma sessão de síntese é
tão livre para escalar quanto qualquer outra — e dois contratos dividindo um nome
de cerca é como um despacho acaba lendo uma pergunta como se fosse um grafo.

O parser **não valida** o documento. Estrutura e soundness são o portão de
`cartografo import`; duplicar aquele julgamento aqui daria à pessoa dois
veredictos para reconciliar, e o ponto inteiro da ficha é que a edição humana é o
portão.

---

## 7. O rascunho, e o passo manual obrigatório

Em caso de sucesso o comando grava o documento com indentação de 2 espaços — a
próxima coisa que acontece com o arquivo é alguém abrir num editor — e imprime
três linhas: o caminho, o resumo (contagem de nós, de arestas, classes
parecidas) e o comando seguinte.

O sufixo `.grafo.rascunho.json` diz em voz alta o que o arquivo é. Ele **não
existe** para o control plane: nenhuma linha em `grafo`, nenhuma em
`grafo_versao`, nenhum evento. Ele passa a existir quando uma pessoa rodar

```
cartografo import <arquivo>
```

que é onde o portão de estrutura e soundness roda
([`domain/graph.ts`](../../packages/core/src/domain/graph.ts)) e onde a linhagem
base nasce. Esta ficha não escreveu validação nova nenhuma: o "humano edita, e a
edição é o portão inteiro" da D10 é satisfeito inteiramente por um comando que já
existia.

---

## 8. Endpoints

| Método | Rota | Papel nesta camada |
|---|---|---|
| `GET` | `/v1/classes` | A classe já tem grafo base? Se tem, o comando recusa antes de qualquer sessão. |
| `GET` | `/v1/graph-versions/:id` | A versão corrente de cada classe, de onde saem `metadata.nome` e `metadata.descricao` para a pontuação. |
| `GET` | `/v1/skills` | O catálogo de capacidades registradas ([t117](../../packages/core/src/routes/skills.ts)). |

Três rotas, **todas de leitura**. O contrato consumido de `/v1/skills` é o
subconjunto `{id, versao, hash, papel, descricao, entrada, saida, checks}` da
projeção que a rota devolve; se ela mudar,
[`control-plane-client.ts`](../../packages/runner/src/synthesizer/control-plane-client.ts)
é o único arquivo a ajustar.

---

## 9. Fora de escopo, e por quê

| Não faz | Por quê |
|---|---|
| Registrar ou validar o grafo sintetizado | É `cartografo import` (t108), sem mudança. Um segundo validador daria dois veredictos à mesma pessoa. |
| Fork de variante | Nasce de proposta com evidência (D13, t118), não de síntese. |
| Importar skill externa | É o portão da D4, com revisão humana e derivação de contrato. Aqui o registro nativo é só lido. |
| Telemetria da sessão (`sessao`/`evento`) | Não há `trabalho` nem `execução` a que pendurar a sessão. Entra quando houver um segundo consumidor do fluxo de síntese — regra dos dois consumidores. |
| Conversa multi-turno com o copiloto | Uma sessão só: retomada está fora do `EngineAdapter` v0 ([`engine-adapter.md`](../formatos/engine-adapter.md)). Editar o rascunho é o turno seguinte, e ele é da pessoa. |
| Tela | Só CLI, como os outros comandos do runner. |
