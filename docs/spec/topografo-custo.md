# Especificação: topógrafo de custo (lente de tokens e tempo)

**Pacote:** [`packages/topografo-custo`](../../packages/topografo-custo) · **Versão da API consumida:** `v1`
**Regra de origem:** ["dois topógrafos (fluxo e custo) antes de congelar o formato de proposta"](../../notas/2026-08-14-extensao-e-qualidade.md)

Um topógrafo lê telemetria e escreve hipótese. Este lê **custo**: quantos tokens
e quanto tempo de sessão cada nó consumiu, em cada versão de grafo, numa
execução — e propõe onde mexer quando algum nó sai da curva.

O que este documento especifica não é principalmente a heurística; é a
**fronteira**. A lente de custo existe para responder, com código rodando, a uma
pergunta que a arquitetura vinha afirmando sem prova: *topógrafo é ponto de
extensão de verdade, ou só um nome para o primeiro analisador que escrevemos?*
A resposta desta ficha é mecânica — o pacote inteiro é cliente comum da API
pública, não declara driver de SQLite, não importa nada de `packages/core` e
não abre nenhum schema compartilhado. Se precisasse de qualquer uma dessas
coisas, "ponto de extensão" seria afirmação sem lastro.

---

## 1. A unidade de observação: `(versão de grafo, nó)`

`GET /v1/executions/:id/metrics-by-version` já cruza versão × telemetria
([`job.ts`](../../packages/core/src/repositories/job.ts)), mas conta
trabalhos e eventos por `grafo_versao_id` e para aí. Isso responde "a v2 andou
mais que a v1"; não responde "**qual nó** ficou caro na v2" — e uma política de
custo sem alvo não tem operação a propor.

A lente desce um nível e agrega por par:

| Campo | O que é |
|---|---|
| `grafo_versao_id`, `no_id` | o par observado |
| `tokens_total` | soma das quatro subchaves de `session.usage` |
| `sessoes_com_uso` / `sessoes_sem_uso` | quantas sessões reportaram uso, e quantas não |
| `tempo_total_segundos` | soma de `finalizada_em - aberta_em` |
| `sessoes_com_tempo` / `sessoes_sem_tempo` | idem, para os carimbos de tempo |

**Nenhuma coluna nova foi precisa.** `session.usage` e os dois carimbos já
existem e já saem em `GET /v1/sessions` junto com `no_id` e `trabalho_id`; o
`grafo_versao_id` de cada sessão se resolve pelo `job.graph_version_id`, que
já vem em `GET /v1/jobs`. A junção é feita no cliente, com dois GETs.

### Ausência nunca é zero

A regra atravessa a agregação inteira, e é herdada do core
([`session.ts`](../../packages/core/src/repositories/session.ts)): sessão com
`uso: null` **não** entra como zero tokens, e sessão ainda aberta **não** entra
como duração zero. Zero é uma medição; `null` é o engine não ter reportado nada,
e colapsar as duas coisas destrói justamente a métrica que esta lente existe
para ler.

Os contadores `sessoes_sem_uso` e `sessoes_sem_tempo` são o preço honesto disso:
eles dizem quanto do total dá para acreditar, e vão junto na evidência de toda
proposta.

### Nada some

Sessão sem trabalho (descoberta, turno de conversa) ou trabalho sem versão
declarada produzem par com `null` em alguma ponta. Essas linhas não são
descartadas: ficam num grupo à parte, ordenado por último — mesma escolha de
`metricasPorVersao`. Um relatório que esconde o que não sabe classificar mente
sobre o total.

Só as linhas **identificadas** (versão e nó preenchidos) chegam às políticas:
sem os dois campos não há nó a apontar nem snapshot em que ler a descrição.

---

## 2. As duas políticas

| Política | Pergunta | Precisa de |
|---|---|---|
| `ceiling` | este nó passou de N tokens (ou de N segundos)? | um teto declarado |
| `tier` | este nó custa muito mais que os vizinhos da mesma versão? | base amostral |

**`ceiling` é absoluta e cala quando não sabe.** Sem `--token-cap` nem
`--second-cap`, a política não roda: não há o que exceder, e inventar um
número default seria a lente decidindo por conta própria o que é caro. "Excede"
é estritamente maior. Uma linha que estoura os dois tetos continua sendo **uma**
candidata — o alvo é o nó, não o limite; `tokens` leva o rótulo por ser a
métrica primária, e o número de tempo vai na evidência de qualquer jeito.

**`tier` é relativa e exige base.** Um nó é candidato quando seu `tokens_total`
é ≥ `tierFactor` vezes a **mediana** da própria versão, e só quando a versão tem
ao menos `tierMinNodes` nós com dado de uso. Três escolhas com motivo:

- **mediana, não média** — a métrica serve para achar outlier, e média é
  puxada exatamente pelo outlier que se está procurando;
- **dentro da versão** — comparar nós de versões diferentes misturaria mudança
  de topologia com mudança de custo, e a lente não teria como dizer qual das
  duas explicou o número;
- **mínimo de nós medidos** — com dois nós, chamar um deles de outlier é ruído.
  Nó sem nenhuma sessão com `uso` não conta para o mínimo nem entra na mediana:
  não é um nó barato, é um nó não medido.

Mediana zero desliga a política: com metade dos nós medidos em zero tokens,
qualquer valor positivo passaria em qualquer fator, e todo nó viraria outlier.

Os defaults (`tierFactor = 3`, `tierMinNodes = 3`) são calibração, não
arquitetura, e estão expostos como opção de linha de comando para poderem ser
recalibrados sem tocar no desenho.

---

## 3. Por que toda proposta desta lente é advisória

Este é o ponto duro da lente, e ele é uma consequência, não uma preferência.

Nem o documento de grafo ([`grafo.schema.json`](../../schema/grafo.schema.json),
cujo nó é `additionalProperties: false`) nem o
[manifesto de skill](../../especificacoes/formatos/manifesto-skill.schema.json)
têm hoje campo de custo, de orçamento ou de tier de modelo. Uma política de
custo **não tem onde pousar** nesses formatos. E abrir qualquer um dos dois
está fora desta ficha por critério de aceite: o que se está provando é que um
segundo topógrafo cabe na API existente sem alterar formato compartilhado —
alterar um schema para caber seria refutar a própria tese.

Sobra a única mutação que o vocabulário de operações atual permite sobre um nó
sem inventar campo: `change_node_field` sobre `description`. Então toda candidata
carrega exatamente uma operação, que **anexa** uma recomendação legível à
descrição atual do nó:

```json
{
  "type": "change_node_field",
  "node_id": "implementar",
  "field": "description",
  "from": "<descrição atual>",
  "to": "<descrição atual>\n\n[cost-surveyor] token ceiling exceeded: …",
  "inverse": {
    "type": "change_node_field",
    "node_id": "implementar",
    "field": "description",
    "from": "<to>",
    "to": "<from>"
  }
}
```

Os números de verdade vão em `evidence` e `expected_metric`, que são JSON livre
por design (D15):

```json
{
  "evidence": {
    "lens": "cost",
    "node_id": "implementar",
    "graph_version_id": "sha256:…",
    "tokens_total": 412000,
    "total_seconds": 5400,
    "sessions_with_usage": 9,
    "sessions_without_usage": 1,
    "ceiling_exceeded": "tokens",
    "type": "ceiling"
  },
  "expected_metric": {
    "nome": "tokens_total of node \"implementar\" goes back under the declared ceiling",
    "direcao": "cai",
    "de": 412000,
    "para": 200000
  }
}
```

As chaves da candidata falam inglês desde o t255
([glossário](glossario-wire.md) §5.5); o CONTEÚDO de `expected_metric` continua
`{nome, direcao, de, para}` porque é o formato de hipótese congelado do
[`domain/hypothesis.ts`](../../packages/core/src/domain/hypothesis.ts) — e é
exatamente por isso que ele está aqui. Até o t255 esta lente inventava uma
métrica própria — uma frase, um alvo e o botão que produziu o alvo —, que
parecia uma hipótese e não era: o `POST /v1/proposals/:id/outcome` recusava com
`422 invalid_expected_metric`, e nenhuma proposta desta lente conseguia fechar o
próprio experimento.

`de` é o número medido; `para` é onde ele deveria chegar (o teto, ou o limiar
`fator × mediana`). `direcao` é sempre `cai`: toda candidata desta lente é um
corte de custo.

**A consequência honesta:** aplicar uma proposta desta lente não reduz custo
nenhum sozinha — ela informa quem lê o nó. Enforcement mecânico de teto ou de
tier espera uma superfície de política de verdade, que a
[nota de aprendizado](../../notas/2026-08-14-aprendizado.md) já nomeia como
superfície própria. Isso não é regressão irreversível: quando o campo existir,
a mesma agregação e as mesmas políticas passam a emitir a operação estrutural,
e só a operação muda.

---

## 4. O comando

```
topografo-custo evaluate --url <url> --execution <id>
                         [--token-cap N] [--second-cap N]
                         [--tier-factor N] [--tier-min-nodes N]
```

O caminho inteiro, em ordem:

1. `GET /v1/sessions?execution_id=` e `GET /v1/jobs?execution_id=` (em
   paralelo);
2. monta o mapa `trabalho_id -> grafo_versao_id`;
3. agrega por `(versão, nó)` e descarta as linhas não identificadas;
4. `GET /v1/graph-versions/:id` **uma vez por versão distinta** — é de onde sai a
   `description` atual, que vira o `de` da operação e o `para` da inversa;
5. avalia as duas políticas;
6. `POST /v1/proposals` por candidata, e imprime uma linha por proposta criada.

Códigos de saída seguem a convenção da CLI `cartografo`
([`cli/index.ts`](../../packages/core/src/cli/index.ts)): `0` fez o que
prometeu (inclusive quando não havia candidata), `1` resultado negativo
(servidor fora, API recusou), `2` linha de comando errada.

---

## 5. Fronteira: quatro rotas, e nenhuma a mais

| Rota | Verbo | Para quê |
|---|---|---|
| `/v1/sessions` | GET | tokens e tempo por `no_id` |
| `/v1/jobs` | GET | o mapa `trabalho_id -> grafo_versao_id` |
| `/v1/graph-versions/:id` | GET | a `description` atual do nó |
| `/v1/proposals` | POST | a candidata, como proposta pendente |

Os caminhos são inglês (D18); as **chaves** do corpo (`sessoes`, `trabalhos`,
`grafo_versao`, `proposta`) seguem em português, porque são formato e a D18 as
tira explicitamente do escopo do inglês.

A ausência mais importante da tabela é `POST /v1/proposals/:id/apply`. O
topógrafo **cria** e para: aplicar, aprovar ou reverter é decisão humana no
portão (README, princípio 5), e o inbox é ficha própria (`t111`). Isso está
travado por teste — a lista de rotas tocadas por uma execução real do comando é
asserção de aceite, não convenção de revisão.

Do mesmo teste sai a outra metade da fronteira, verificada pelo portão genérico
[`check-single-writer.mjs`](../../scripts/check-single-writer.mjs) que já roda no
lint: o pacote não declara driver de SQLite, não alcança `packages/core/src/db`
e não depende do pacote do core nem do runner. Mesma fronteira da tela (D11) e
do runner (D1) — o topógrafo não é privilegiado por ser "de dentro".

Os tipos que o pacote consome da API são **redeclarados localmente**, no
subconjunto que ele usa, em vez de importados do core — mesma escolha de
[`cliente-controle.ts`](../../packages/runner/src/controller/cliente-controle.ts).
É o que faz a lente sobreviver a campo novo no core sem mudar uma linha, e o
que impede a dependência de voltar pela porta dos tipos.

---

## 6. O que esta lente ainda não faz

Cada item aqui é escopo declarado, não esquecimento:

- **Deduplicar propostas entre execuções repetidas do comando.** Rodar duas
  vezes sobre a mesma telemetria cria propostas repetidas. Quando esta ficha foi
  escrita, checar duplicidade exigiria uma rota de listagem que não existia, e
  criá-la seria mudança no core — exatamente o que a ficha existe para não
  precisar fazer. `GET /v1/proposals` existe hoje
  ([`proposals.ts`](../../packages/core/src/routes/proposals.ts)), então o
  bloqueio caiu; a checagem continua não implementada, e continua fora de
  escopo **desta** ficha, que é sobre caber na API e não sobre idempotência.
  É ficha de quem a quiser, e a rota já está lá.
- **Campo de custo/tier real** no documento de grafo ou no manifesto de skill
  (§3).
- **Superfície de política formal** — tabela `politica` versionada, orçamento
  por execução, timeouts. Os tetos são hoje argumento de linha de comando, e a
  nota de aprendizado já nomeia "Políticas" como superfície própria.
- **Custo em dinheiro.** A lente conta tokens e segundos; preço por token é
  vocabulário de engine, e o schema de `session.finished` recusa campo de custo
  de propósito. Converter é de quem tiver a tabela de preços.
- **Cruzar com desfecho.** "Este nó é caro" e "este nó é caro **e** falha muito"
  são frases diferentes; a segunda é a lente de fluxo, e o cruzamento das duas é
  ficha de quem tiver as duas rodando lado a lado.
