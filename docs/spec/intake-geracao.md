# Especificação: geração do rascunho de intake, do pedido à quebra proposta

**Versão da API:** `v1` · **Implementação:** [`packages/runner/src/intake/`](../../packages/runner/src/intake)
**Camada consumida:** [`docs/spec/intake.md`](./intake.md) (t122) — esta ficha não
acrescenta rota, coluna nem migração; ela é o primeiro cliente que **produz**
`items`

A [t122](./intake.md) entregou o intake em duas fases: `POST /v1/intake` propõe
um rascunho a partir de uma lista de `items` já decomposta, e
`POST /v1/intake/:id/confirmations` é o portão humano que transforma o rascunho
em `trabalho`. O §8 daquela especificação nomeava exatamente o que faltava —
*gerar o rascunho a partir do pedido em linguagem natural* — e dizia que quem
escreve `items` era decisão de ficha futura. Esta é a ficha futura.

Uma frase resume o desenho: **a sessão decompõe, o comando grava o rascunho, e o
humano continua sendo quem confirma.** Nada aqui cria ticket.

---

## 1. As quatro partes

| Parte | Onde | O que faz | Determinística? |
|---|---|---|---|
| Prompt | [`prompt.ts`](../../packages/runner/src/intake/prompt.ts) | Monta o contrato inteiro da sessão: papel, regras duras, formato do item. | Sim: função pura. |
| Orquestrador | [`generate.ts`](../../packages/runner/src/intake/generate.ts) | Recusa classe desconhecida, despacha **uma** sessão, lê o arquivo, grava o rascunho. | Tudo menos a sessão. |
| Linha de comando | [`command-line.ts`](../../packages/runner/src/intake/command-line.ts) | argv, ambiente, credencial, as duas portas e a mensagem de recusa. | Sim. |
| Entrypoint | [`cli.mjs`](../../packages/runner/src/intake/cli.mjs) | Engine, diretório de rascunho, stdout e código de saída. | — |

A divisão é a mesma do topógrafo (t146) e do sintetizador, pela razão que
`synthesize.ts` registra: **o que um teste alcança sem subir um processo é o que
continua coberto.** Por isso a leitura do argv não mora no `.mjs`.

---

## 2. O comando

```
npm run intake --workspace @cartografo/runner -- \
  "<pedido>" --class <nome> \
  [--url <url>] [--dir <caminho>] [--token <token>]
```

| Argumento | Obrigatório | Default | Papel |
|---|---|---|---|
| `<pedido>` | sim (posicional) | — | O pedido em linguagem natural, como a pessoa o descreve. |
| `--class` | **sim** | — | A classe **já registrada** cujo grafo os tickets vão atravessar. |
| `--url` | não | `http://127.0.0.1:4317` | Control plane. |
| `--dir` | não | um diretório temporário | Onde a sessão roda e escreve a resposta. |
| `--token` | não | `CARTOGRAFO_TOKEN` do ambiente | Credencial do control plane. |

A precedência da credencial é `--token` > `CARTOGRAFO_TOKEN` > nenhuma, a mesma
de [`packages/core/src/cli/url.ts`](../../packages/core/src/cli/url.ts), do
topógrafo de custo, do topógrafo de fluxo e do sintetizador. Sem credencial
nenhuma o cliente não manda cabeçalho e toma `401` — cabeçalho vazio se pareceria
com credencial. Isto está aqui desde o primeiro commit por causa da
[t146](./topografo-fluxo.md): o topógrafo nasceu sem flag de token e ficou
inteiramente inutilizável até ganhar uma.

Os códigos de saída são o contrato, porque é isso que uma pessoa (ou um script)
lê:

- **`0`** — um rascunho foi proposto. O id é a primeira linha do stdout;
- **`1`** — rodou e não deu: classe não registrada, sessão morta, arquivo
  inutilizável, ou o control plane recusou a escrita. **Nada foi gravado**;
- **`2`** — o comando foi digitado errado. Nada rodou.

`1` e `2` são separados de propósito, como no sintetizador: quem não distingue "a
sua linha de comando está errada" de "a sessão falhou" não consegue decidir se
faz sentido tentar de novo.

---

## 3. A ordem de uma rodada

```
GET /v1/classes
        │
        ├─ a classe de --class NÃO está registrada ──▶ sai 1, SEM abrir sessão
        ▼
UMA sessão de EngineAdapter, com o prompt do §5
        │
        ├─ status != completed
        ├─ intake-proposto.json ausente, ou não é JSON
        ├─ sem `items`, ou `items` vazio
        │  ──▶ sai 1, NENHUM POST /v1/intake
        ▼
POST /v1/intake  {class, request, items}
        │
        ├─ 404 unknown_graph · 400 invalid_items ──▶ sai 1
        ▼
201 {rascunho} — status `pendente`, nenhum evento, nenhum ticket
        ▼
imprime o id  ──▶  fim. Confirmar é do humano.
```

A primeira etapa é decisão, não acaso: a recusa de classe desconhecida vem
**antes** de qualquer sessão, espelhando a ordem que o sintetizador aplica à sua
própria pré-checagem. Descobrir um erro de digitação em `--class` depois de
gastar uma sessão inteira é descobrir tarde. O código de erro ecoa o da API
(`grafo_desconhecido`, [`routes/intake.ts`](../../packages/core/src/routes/intake.ts))
para que as duas recusas sejam obviamente a mesma recusa.

A sonda do engine (`verifyCli`) roda **preguiçosamente**, na primeira sessão, e
não na entrada do comando. Sondar antes tornaria a recusa de classe dependente de
ter a CLI instalada, o que trocaria uma mensagem exata por outra genérica em
exatamente o caso mais comum.

---

## 4. Por que este comando grava, e o sintetizador não

O repositório já tinha dois precedentes de "uma sessão de agente entre um pedido
e uma escrita no control plane", e eles decidiram diferente **de propósito**:

| Ficha | O que a sessão produz | Quem grava | Por quê |
|---|---|---|---|
| Sintetizador ([t115](./sintetizador.md), [D10](../../DECISOES.md)) | Um arquivo de rascunho local | Uma pessoa, rodando `cartografo import` | Registrar grafo não tem desfazer no nível da API: **a importação É o portão**. |
| Topógrafo ([t110](./topografo-fluxo.md)) | Operações de um diff semântico | O próprio comando, em `POST /v1/proposals` | Proposta nasce `pendente` e ninguém aplica: a escada de segurança é a **ausência** de um método `aplicar` no cliente. |

O intake segue o topógrafo, e a razão é o desenho da própria t122: o rascunho
nasce `pendente`, é livremente editável por `PATCH`, descartável por `/discards`,
**não emite evento nenhum**, e só vira trabalho em `/confirmations`
([§1](./intake.md)). O portão humano já está lá. Parar num arquivo para alguém
submeter à mão não acrescentaria um segundo portão — duplicaria o primeiro.

A consequência disso no cliente HTTP é literal: ele ganhou `criarIntake` e mais
nada. Não existe `confirmarIntake`, `emendarIntake` nem `descartarIntake` em
[`cliente-controle.ts`](../../packages/runner/src/controller/cliente-controle.ts),
pela mesma razão que `aplicar` nunca entrou: **um cliente que não tem o método não
toma a decisão por engano.**

---

## 5. A sessão: um turno, um arquivo, nenhum privilégio

A `SessionSpec` segue a regra normativa do
[EngineAdapter](../formatos/engine-adapter.md): `instructions` e `prompt` nunca
chegam concatenados pelo chamador.

- **`instructions`** — o papel e as regras duras do item, listadas no §6.
- **`prompt`** — o pedido **verbatim**, a classe alvo, e o contrato de saída
  repetido. O pedido não é resumido no caminho de entrada: `pedido` é gravado ao
  lado do lote, e quem refina depois lê o original, não uma paráfrase.
- **`workingDir`** — um diretório temporário. A sessão não recebe URL do control
  plane, nem credencial, nem acesso de escrita a mais nada. O único `POST` desta
  ficha é o do orquestrador.

### O contrato de saída é um arquivo, não um bloco cercado

A sessão escreve `intake-proposto.json` no diretório atual, com exatamente:

```json
{"items": [ ... ]}
```

Arquivo e não bloco ` ```cercado ``` ` em stdout, e isto é a cicatriz da
[t148](./sintetizador.md): a saída de uma CLI real é um fluxo de quadros
`stream-json`, um por linha, então as aspas do bloco chegam como `\"` e as
quebras como `\n` — e o varredor de cerca não casa com nenhuma das duas. Custou
ao sintetizador uma rodada inteira de execuções reais com todos os testes de
engine falso verdes. Nada aqui precisa observar a saída enquanto ela flui, então
o contrato que sobrevive é o que a sessão cumpre com **uma escrita**.

É a mesma escolha de `proposta-topografo.json`
([`surveyor/proposal.ts`](../../packages/runner/src/surveyor/proposal.ts)), pela
mesma razão.

---

## 6. O que o prompt ensina, e por que ele precisa ensinar tudo

`workingDir` é um diretório temporário vazio: a sessão **não consegue abrir**
[`domain/intake.ts`](../../packages/core/src/domain/intake.ts). Toda regra que
`validateItems` aplica e que o prompt não diz é uma regra que a sessão não tem
como seguir — e a conta chega como um `invalid_items` que ninguém pediu. É a
mesma lição da t138, um andar acima.

Então o prompt diz, por extenso:

| Regra | Código que reprova |
|---|---|
| `ref` e `title` são obrigatórios | `missing_required_field` |
| `ref` é identidade **local ao lote**, nunca um id real | — (morre na confirmação) |
| dois itens nunca usam o mesmo `ref` | `duplicate_ref` |
| `depends_on` cita só `ref` deste lote | `unknown_dependency` |
| nenhum item depende de si mesmo | `self_dependency` |
| as dependências não fecham ciclo (diamante pode) | `dependency_cycle` |
| `acceptance_criteria` só quando houver critério de verdade | — |
| `tier` só `"trivial"` ou `"standard"`, e omitir é permitido | `invalid_field` |

A penúltima é a que mais engana e por isso é dita com ênfase: **`null` não é `[]`**
([`domain/intake.ts:34-43`](../../packages/core/src/domain/intake.ts)). "Ninguém
escreveu critério ainda" e "declarei que não há critério" são afirmações
diferentes, e o nó que refina é justamente quem precisa distinguir as duas. Uma
lista vazia passa na validação e mente para o resto do grafo — o pior tipo de
erro, porque não aparece.

A última entrou com a t175 e é a razão de a triagem ser **de graça**: esta
sessão já está lendo o pedido e propondo a quebra, então pedir a ela que também
classifique cada item não custa sessão nova, chamada nova, nem modelo novo. O
prompt ensina os dois valores e onde fica a linha — `trivial` para rename,
typo, mudança só de documentação, ajuste de configuração sem decisão de design
dentro; `standard` para todo o resto, e `standard` na dúvida. Omitir continua
válido e significa "ninguém classificou", que **não** é `trivial`: quem omite
deixa a decisão em aberto, quem escreve `trivial` afirma que o item é pequeno, e
é essa afirmação que faz o runner rodar aquele nó num modelo mais barato.

---

## 7. O que este comando NÃO valida

`generate.ts` não espelha `validateItems`. É uma diferença deliberada em relação
ao topógrafo, que espelha `validateOperation` do lado do runner:

- uma `POST /v1/proposals` ruim é cara de ter feito — por isso o topógrafo checa
  a forma antes de gastar a escrita;
- uma `POST /v1/intake` ruim é **barata e reversível**: o rascunho é descartado,
  nenhum ticket nasceu, nenhum evento foi emitido. E o server já devolve o
  relatório inteiro (`invalid_items` com todos os problemas, nunca o primeiro).

Duplicar aquele julgamento aqui seria uma segunda cópia que pode divergir da
primeira, e a pessoa ficaria com dois veredictos para reconciliar.

---

## 8. Endpoints

| Método | Rota | Papel nesta camada |
|---|---|---|
| `GET` | `/v1/classes` | A classe está registrada? Se não está, o comando recusa antes de qualquer sessão. |
| `POST` | `/v1/intake` | A única escrita. Devolve `201 {rascunho}`, sempre `pendente`. |

Uma leitura e uma escrita. `/confirmations`, `/discards` e `PATCH` existem
([§6 da t122](./intake.md)) e **não** são chamados daqui.

---

## 9. Fora de escopo, e por quê

| Não faz | Por quê |
|---|---|
| Confirmar, emendar ou descartar o rascunho | É o portão humano da t122, intacto. O cliente nem tem os métodos. |
| Revalidar `items` do lado do runner | §7. |
| `--projeto-id` / `--execucao-id` | A rota tem default para os dois (`DEFAULT_PROJECT`); o flag entra no dia em que alguém precisar. |
| Entrar na travessia ou no laço de despacho do runner | Manual e de um tiro só, como `synthesize` e o topógrafo (README, princípio 5). |
| Conversa multi-turno para refinar o lote | Uma sessão só: retomada está fora do `EngineAdapter` v0. Editar depois é `PATCH /v1/intake/:id`, que já existe. |
| Sugerir a classe por semelhança | [D8](../../DECISOES.md) põe o nome na mão do usuário, e a classe aqui precisa já existir. |
| Tela | Só CLI, como os outros comandos do runner. |
