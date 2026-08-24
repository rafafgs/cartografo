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
coluna `snapshot` de `graph_version`; os grafos de fábrica são escritos nele; o
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
| `project` | objeto | não | Configuração **estática** da classe, publicada pela projeção de input em `input.project` (`t253`). Ausente significa `{}`. Ver abaixo. |
| `max_consecutive_failures` | inteiro ≥ 1 | não | Quantas sessões falhadas **em sequência**, no mesmo trabalho e no mesmo nó, bloqueiam o trabalho (`t265`). Ausente significa **3**. Ver abaixo. |

### `project`: o que a classe declara para si

O que não vem de trabalho nenhum e não é produzido por nó nenhum: repositório,
branch principal, comando de testes, convenções, documentos de registro. Até a
`t253` esse material não tinha onde morar — as skills do grafo de fábrica de
software já liam `{{input.projeto.*}}` e nada montava esse objeto. A `t259`
fechou os dois lados: aqueles manifestos passaram a ler `{{input.project.*}}`,
que é o nome que a projeção publica, e o bundle de software declara o objeto.

```json
{
  "project": {
    "repo": "git@github.com:rafaelgomes/cartografo.git",
    "branch_principal": "main",
    "comando_testes": "npm test",
    "comandos_qualidade": ["npm test", "npm run lint", "npm run typecheck"]
  }
}
```

Três coisas que o campo decide:

- **Ausência tem nome, e o nome é `{}`.** Uma classe que ainda não declara
  configuração de projeto projeta um objeto vazio, e não uma chave faltando: um
  placeholder resolve para algo honesto em vez de recusar o despacho. É o que
  mantém válido e despachável todo grafo escrito antes deste campo — mesma
  postura não-quebradora de `hooks` e do `engine` do nó.
- **As chaves de dentro são da CLASSE.** O schema abre a gaveta
  (`additionalProperties: true`) pela mesma razão que `custom_fields` existe:
  `comando_testes` é vocabulário de desenvolvimento de software e não teria
  sentido em bets assimétricas, e fechar o conjunto pediria uma edição de schema
  por classe.
- **Estático, e por isso versionado com o documento.** Muda o comando de testes,
  muda o grafo, e a mudança é proponível e reversível como qualquer outra parte
  dele (D2, D15). Valor específico de um projeto mora na **variante** daquele
  projeto (D13); o que mora aqui é o que a classe declara para si.

### `input.traversal`: a caminhada que o control plane projeta (`t270`)

Nada aqui é campo do documento — é o **irmão** de `input.project` do outro lado
da projeção. `project` é o que a classe declara e viaja congelado no snapshot;
`traversal` é o que o log diz que aconteceu com **este** trabalho, montado a
cada `GET /v1/jobs/:id/context`. Os dois chegam ao mesmo `input`, e a diferença
entre eles é quem responde por cada chave.

```json
{
  "traversal": {
    "nodes_visited": ["triagem", "coleta-fundamentos", "analise-assimetria"],
    "entered_at": "2026-08-17T22:41:03.117Z",
    "sessions_by_node": { "triagem": [11], "coleta-fundamentos": [12, 14] }
  }
}
```

| Chave | Quem fornece | O que é |
|---|---|---|
| `nodes_visited` | control plane, de `job.transitioned` | Os nós que esta travessia **executou**, em ordem de caminhada. |
| `entered_at` | control plane, de `job.transitioned` | Instante ISO-8601 em que o trabalho chegou ao nó onde está. |
| `sessions_by_node` | control plane, das sessões concluídas | `session_id`s por nó, na ordem em que fecharam. |

Três coisas que a projeção decide:

- **O nó atual não está em `nodes_visited`.** A transição registra para onde o
  trabalho **foi**, então o `to_node_id` da última é o nó em que ele está parado
  — e um nó prestes a rodar não executou. Sem esse corte,
  `red_team_executado` responderia `true` para uma travessia que só tinha
  *chegado* ao `red-team` e não tinha relatado nada, que é exatamente o
  autorrelato que o check daquela skill existe para recusar. Zero transições é
  caminhada vazia: quem está no nó de entrada ainda não executou nada.
- **Sem transição, `entered_at` é a criação do trabalho.** É a resposta honesta
  para "quando você chegou aqui?" de quem nunca saiu de onde nasceu — e é o que
  faz `{{input.traversal.entered_at}}` resolver desde o primeiro nó, em vez de
  recusar o despacho de entrada.
- **Só o control plane pode montar isso (D1).** É leitura do log append-only, e
  um runner que a reconstruísse pelas rotas públicas seria um segundo autor do
  mesmo fato. Antes da `t270` ninguém montava: `registrar-travessia` nomeava
  `{{input.nos_executados}}` e `{{input.data_de_registro}}`, o despacho recusava
  fechado, e a segunda travessia real de bets foi desbloqueada por uma pessoa
  digitando os dois valores em `fields` na mão.

As chaves de dentro são **inglês**, ao contrário de `perguntas_respondidas` ao
lado: `input.job`, `input.project` e `input.traversal` são vocabulário de
projeção do core, e vocabulário novo de formato nasce em inglês (D18). O que
está em português ali do lado é herança dos manifestos que vieram antes da
regra, não precedente.

### `max_consecutive_failures`: quantas vezes seguidas um nó pode falhar

Até a `t265` não havia teto: um trabalho cujas sessões falhavam voltava para a
fila, ganhava lease de novo e abria a sessão seguinte, para sempre. Quem parava
o laço era o operador olhando o log — foi o que aconteceu na primeira travessia
real do grafo de bets (`t198`).

```json
{
  "max_consecutive_failures": 3
}
```

Quatro coisas que o campo decide:

- **Ausência tem nome, e o nome é 3.** Resolvido na hora em que uma sessão
  fecha, nunca na validação: um grafo escrito antes deste campo continua válido
  e passa a ter teto sem ser tocado — mesma postura não-quebradora de `hooks`,
  `project` e do `engine` do nó.
- **A contagem é de cauda.** Ela anda da sessão mais recente para trás e para na
  primeira que não falhou. Falhou, falhou, funcionou, falhou é **uma** falha
  atrás de si; o sucesso zera a sequência.
- **Vale por nó, mas se declara na raiz.** O par contado é `(trabalho, nó)` —
  falhar duas vezes em `redigir` e uma em `revisar` não é sequência de três —,
  e o número é do documento inteiro. Teto por nó é decisão de outra ficha, se a
  evidência aparecer.
- **Recusa do engine não passa por aqui.** Um engine que recusa responder é
  determinístico e para na **primeira** ocorrência, do lado do runner
  (`docs/spec/runner-and-controller.md`). O teto é para a falha comum, que pode
  muito bem ser um soluço.

Quem conta é o control plane, dentro da transação que fecha a sessão: a
sequência atravessa leases e processos de runner, e nenhum runner sozinho
consegue vê-la (D1).

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
| `engine` | não | Qual engine executa este nó. Ausente = o engine default do runner. Ver abaixo. |
| `model` | não | Qual modelo daquele engine executa este nó. Ausente = o default do próprio engine. Ver abaixo. |
| `escalation_policy` | não | Quando este nó chama gente: `always`, `on_uncertainty`, `never`. Ausente = `on_uncertainty`. Ver abaixo. |
| `escalation_recipient` | não | Quem deveria ser chamado quando este nó escala. Texto livre. Ver abaixo. |
| `skill_ref` | sim | Ponteiro para a skill do registro, pinado. |
| `contrato` | sim | Entrada, saída e verificações. |

### `engine`: qual engine executa este nó

Um grafo pode misturar engines, e a escolha é **por nó** (t141). Um nó que
declara `"engine": "codex"` roda no Codex; o nó seguinte, que não declara nada,
roda no default.

```json
{
  "id": "conferir",
  "papel": "revisor",
  "tipo_no": "trabalho",
  "engine": "codex",
  "skill_ref": { "id": "cartografo/revisar-nota", "versao": "1.0.0", "hash": "sha256:2df09e…" },
  "contrato": { "entrada_schema": {}, "saida_schema": {}, "verificacoes": [] }
}
```

Três coisas que o campo decide, e que valem mais escritas do que inferidas:

- **Ausência tem nome.** Um nó sem `engine` roda no engine default do runner,
  que é `claude-code` — a constante `DEFAULT_ENGINE` de
  `packages/runner/src/dispatch/dispatch.ts`. É default nomeado e
  não implícito: a telemetria da sessão registra o engine que rodou, e ninguém
  precisa adivinhar qual foi. Por isso todo grafo escrito antes deste campo
  continua válido e continua se comportando exatamente como antes.
- **A resolução é no despacho, nunca na validação.** Quem lê `engine` é o
  runner, na hora de despachar, olhando o nó em que o trabalho está *agora*
  (`no_atual` contra `snapshot.nos`). O validador de grafo não sabe quais
  engines existem naquela máquina, e não é trabalho dele saber.
- **É texto livre, e a recusa é do runner.** Não há enum fechado no schema, pela
  mesma razão que `papel` e `skill_ref.id` também são texto livre: um enum
  obrigaria a editar o schema a cada adapter novo, e o formato é aditivo. Um nó
  que pede um engine para o qual o runner não tem rota **falha o despacho** com
  `UnknownEngineError`, antes de qualquer sessão abrir — nunca cai
  silenciosamente em outro engine, o que faria a telemetria mentir sobre o que
  de fato rodou.

Exemplo completo:
[`grafo-valido-dois-engines.json`](../../schema/exemplos/grafo-valido-dois-engines.json).

### `model`: qual modelo daquele engine executa este nó

Escolher o engine é metade da decisão; a outra metade é **quanto** de modelo o
nó precisa (t166). Um portão que confere um diff não pede o mesmo modelo que o
nó que escreveu o diff, e `model` é onde essa diferença fica escrita — por nó,
no grafo, e não numa flag de máquina.

```json
{
  "id": "conferir",
  "papel": "revisor",
  "tipo_no": "portao",
  "engine": "codex",
  "model": "gpt-5.6-luna",
  "skill_ref": { "id": "cartografo/revisar-nota", "versao": "1.0.0", "hash": "sha256:2df09e…" },
  "contrato": { "entrada_schema": {}, "saida_schema": {}, "verificacoes": [] }
}
```

Quatro coisas que o campo decide, e que valem mais escritas do que inferidas:

- **Ausência tem nome, e aqui o nome não é nosso.** Um nó sem `model` roda no
  default **do próprio engine** — não existe `DEFAULT_MODEL` no runner, de
  propósito. O runner não tem como saber a que modelos aquela instalação tem
  acesso, e uma constante aqui poria em toda sessão uma escolha que nenhum
  grafo fez. Na prática: nenhuma flag de modelo é montada, e o argv sai
  idêntico ao de antes deste campo existir. Todo grafo escrito antes da t166
  continua válido e continua se comportando exatamente como antes.
- **É texto livre, e a recusa é do engine.** Não há enum fechado no schema,
  pela mesma razão de `engine`: um enum obrigaria a editar o schema a cada
  modelo novo. Um `model` desconhecido ou digitado errado é recusado pela
  própria CLI na abertura da sessão — sessão que falha, e não erro novo de
  validação. O catálogo que a API publica (`GET /v1/engines`) é **descoberta,
  não validação**: serve para quem escreve grafo saber o que existe, e nada
  compara o nó contra ele antes do despacho.
- **Trocar o modelo é mudança de versão.** `model` é dado de grafo, então
  mudá-lo é proposta: `change_node_field` com `field: "model"` passa pelo
  mesmo caminho de sempre — aplicar, validar soundness, gravar `grafo_versao`
  nova, mover o ponteiro (D15) — e vale para `engine` do mesmo jeito desde a
  t166. Vem com inversa e com evidência, como qualquer outra proposta, e o que
  rodou sob qual decisão fica no histórico.
- **Vale na travessia seguinte, não na que está correndo.** O grafo é congelado
  durante a execução: um trabalho continua na versão em que entrou, com o
  modelo que ela declarava, e quem lê o modelo novo é o despacho que acontecer
  sob a versão nova.

Exemplo completo:
[`grafo-valido-modelo.json`](../../schema/exemplos/grafo-valido-modelo.json).

### `escalation_policy`: quando este nó chama gente

Até a `t167` a resposta era uma só para o grafo inteiro: todo nó perguntava
quando travava, e todo pedido de decisão bloqueava o trabalho até alguém
responder. Isso é o comportamento certo para um nó de arquitetura e o
comportamento errado para um nó que roda de madrugada sem ninguém do outro lado.
A política passa a ser **por nó**, e é dado do grafo — versionada, propostável e
revertível como qualquer outro campo.

```json
{
  "id": "publicar",
  "papel": "publicador",
  "tipo_no": "trabalho",
  "escalation_policy": "never",
  "escalation_recipient": "editor-de-plantao",
  "skill_ref": { "id": "cartografo/publicar-nota", "versao": "1.0.0", "hash": "sha256:e6952f…" },
  "contrato": { "entrada_schema": {}, "saida_schema": {}, "verificacoes": [] }
}
```

Os três valores:

| Valor | O que o nó faz |
|---|---|
| `always` | Escala antes de fechar o nó, **mesmo achando que sabe** a resposta. Para a decisão que uma pessoa quer ver passar por ela. |
| `on_uncertainty` | Escala quando trava. É o comportamento que todo nó sempre teve, e é o default. |
| `never` | Não tem a quem perguntar. Travar aqui é falha do contrato do próprio nó — o runner **bloqueia o trabalho com motivo**, e nenhuma pergunta é criada. |

Quatro coisas que o campo decide, e que valem mais escritas do que inferidas:

- **Ausência tem nome, e o nome é `on_uncertainty`.** Um nó sem
  `escalation_policy` se comporta exatamente como antes de o campo existir, e é
  por isso que todo grafo já escrito continua válido e continua se comportando
  igual. Mesma convenção do `engine` acima.
- **A resolução é no despacho, nunca na validação** — `resolveEscalationPolicy`
  em [`resolve-node.ts`](../../packages/runner/src/dispatch/resolve-node.ts),
  olhando o nó em que o trabalho está *agora*. Um valor fora dos três (só
  possível num snapshot que mudou de forma por baixo) resolve para o default:
  não é palpite sobre qual dos três era para ser.
- **Ao contrário do `engine`, aqui o enum é fechado.** `engine` é texto livre
  porque um enum obrigaria a editar o schema a cada adapter novo; aqui os três
  valores **são** o vocabulário, e um quarto valor não é capacidade nova, é erro
  de quem escreveu — pego pelo schema, antes de qualquer runner ler.
- **Só o `never` é determinístico.** `always` e `on_uncertainty` são instrução no
  prompt, como todo o resto do texto de sessão: se a sessão estava mesmo
  "incerta" não é conferível por máquina, e um portão que fingisse conferir isso
  estaria conferindo nada. `never` é fiação: o runner troca
  `POST /v1/input-requests` por `POST /v1/jobs/:id/blocks`, e essa troca não
  depende de a sessão obedecer à instrução.

Trocar a política de um nó é uma proposta `change_node_field` como outra qualquer
(`packages/core/src/domain/operations.ts`, `CHANGEABLE_FIELDS`): produz uma nova
`grafo_versao`, revalida o documento inteiro e tem inversa. É de propósito que
não exista caminho próprio para mudá-la — um segundo jeito de mudar um nó teria
regras próprias sobre o que é versionado.

Exemplo completo:
[`grafo-valido-escalacao-nunca.json`](../../schema/exemplos/grafo-valido-escalacao-nunca.json).
O ciclo inteiro está em [`human-escalation.md`](human-escalation.md).

### `escalation_recipient`: quem deveria ser chamado

Texto livre, sem formato imposto — pelas mesmas razões que `resposta_padrao` e
`respondido_por` também são: **não existe sistema de identidade nem de papéis
neste repositório** para validar contra, e inventar um formato agora seria
congelar um vocabulário antes do primeiro consumidor.

O campo é guardado no grafo e devolvido pelo snapshot
(`GET /v1/graph-versions/:id`). **Nada envia nada para ele**, e isso não é
esquecimento: notificação e papéis são ficha futura, e o campo existe agora para
que a política e o destinatário nasçam juntos em vez de o grafo ter de ser
reescrito quando a entrega chegar. Ele nem sequer é lido pelo runner.

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
| `saida_schema` | sim | JSON Schema do que o nó devolve ao quadro. Documentação da forma esperada e origem do vocabulário de roteamento das arestas — **não** é o schema contra o qual o relato da sessão é conferido. É aqui que o `resultado` de um nó com duas ou mais saídas se declara; no `output` da skill ele nunca entra. Ver abaixo. |
| `verificacoes` | sim | Lista com **pelo menos um** check. Como se confere o que o nó produziu. |
| `produces` | não | Nome do **balde** em que a saída estruturada deste nó se acumula na projeção de input dos nós seguintes (`t253`). Ausente = merge no topo de `input`. Ver abaixo. |

#### `saida_schema` documenta; quem valida é a skill (`t267`)

Os dois são schemas diferentes de propósito, e confundi-los custou três relatos
recusados na segunda travessia real do grafo de bets. O `saida_schema` do nó é o
que ESTE grafo espera daqui, e é dele que sai o vocabulário das arestas (a
`condition` de uma aresta casa com o `outcome` que ele declara). O que
`PATCH /v1/sessions/:id/finish` confere o objeto do bloco cercado contra é o
`output` da **skill pinada** (D9) — resolvido por
[`resolveOutputSchema`](../../packages/core/src/repositories/session.ts), pelo
caminho `job` → `graph_version` → nó → `skill_ref` → registro. Uma skill serve a
mais de um grafo, e é por isso que a validação mora nela e não no nó.

Consequência prática para quem escreve prompt de nó: mostrar o `saida_schema` a
uma sessão e dizer que é contra ele que a saída será conferida é falso. O runner
renderiza os dois hoje, cada um com o seu rótulo
([`render-skill-instructions.ts`](../../packages/runner/src/dispatch/render-skill-instructions.ts)).

**A chave `resultado` é reservada do protocolo e fica FORA dessa conferência
(`t269`).** O bloco cercado é um só, então o rótulo de rota viaja dentro do mesmo
objeto que o relato — mas ele é vocabulário deste grafo (a `condition` de uma
aresta), nunca do `output` da skill. Quando o objeto relatado traz um
`resultado` que é rótulo utilizável (string não vazia depois do `trim`, a mesma
leitura de
[`parse-node-result.ts`](../../packages/runner/src/dispatch/parse-node-result.ts)),
o control plane o retira antes de conferir e não o guarda: `session.output` e o
`data.output` do evento `session.finished` ficam com os campos da skill e mais
nada. Consequências, nas duas pontas:

- uma skill pode fechar o próprio `output` (`additionalProperties: false`) sem
  declarar `resultado`, que é o caso de `derrubar-tese@1.0.0`, e ainda assim
  aceitar o relato de um nó com duas saídas — antes da `t269` recusava todos, e
  desde a `t268` uma recusa dessas **bloqueia** o nó;
- declarar `resultado` como propriedade do `output` de uma skill não é legal: a
  chave nunca chega a ser conferida nem guardada, então a declaração não
  descreve nada. Quem precisa do rótulo lê a aresta percorrida em
  `job.transitioned`, não a saída da sessão.

Um `resultado` presente que **não** é rótulo (número, objeto, string só de
espaço) não é retirado de nada: fica no objeto e um schema fechado o recusa como
sempre recusou. Uma sessão que pôs lixo na chave de rota não entendeu o
protocolo, e lavar a chave em silêncio guardaria um relato ao lado de uma decisão
que aresta nenhuma carrega.

#### `produces`: onde a saída deste nó aterrissa

A saída estruturada de um nó — o que a sessão relata em
`PATCH /v1/sessions/:id/finish` e o control plane guarda depois de conferir
contra o `output` da skill pinada (D9), já sem a chave de rota `resultado`
(`t269`) — precisa aterrissar em algum lugar do
`input` do nó seguinte. `produces` é esse lugar, e ele é um **balde**, não uma
caixa por sessão: dois nós que declaram o mesmo nome escrevem no mesmo objeto.

```json
{ "id": "desenvolver", "contrato": { "produces": "artefato", "…": "…" } }
{ "id": "testar",      "contrato": { "…": "…" } }
{ "id": "integrar",    "contrato": { "produces": "artefato", "…": "…" } }
```

Com essas três declarações, `desenvolver` grava `artefato.branch`, `integrar`
grava `artefato.merge_commit` — e `implantar`, dois saltos adiante, lê os dois.
O portão `testar` no meio **não** declara balde: ele não produz artefato próprio,
merge no topo, e o `artefato` que já existia continua exatamente como estava.
Fosse uma caixa por sessão, o `merge_commit` chegaria num objeto que não carrega
mais o `branch`, e é esse encadeamento — não o passo isolado — que a travessia
precisa.

Duas consequências que valem escritas:

- **Ausência tem nome.** Um nó sem `produces` faz merge no topo de `input`, que
  é o que os dois grafos de fábrica já faziam por o campo não existir. É por isso
  que ele é opcional e não quebra grafo nenhum — `bets-assimetricas` continua
  resolvendo nó a nó sem declarar um balde sequer.
- **Em colisão de chave vence quem escreveu depois**, na ordem da travessia
  (`finalizada_em` da sessão). A ordem é a que aconteceu, e não a que a consulta
  devolveu.

A montagem inteira é `GET /v1/jobs/:id/context`, no control plane
(`packages/core/src/domain/context.ts`): quem escreve no banco é quem monta a
projeção (D1), e o runner é cliente dela como de qualquer outra rota.

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
`terminates` (§6) continue valendo. O que **não** é legítimo é o nó escolher
caminho livremente em runtime: as únicas decisões em voo são as dos portões,
sobre arestas já declaradas (README princípio 2).

---

## 4. `no_inicial` e `nos_finais`

`no_inicial` é único: toda travessia começa no mesmo lugar. `nos_finais` é lista
porque um grafo pode terminar de mais de um jeito (aprovado e arquivado são
ambos fins legítimos). Um nó final não precisa ser folha topológica — precisa
apenas ser um ponto onde a travessia pode parar.

### Chegar ao nó final não é ter terminado (`t262`)

**Nó final é o nó de onde não se sai — não é o nó que não faz nada.** Um nó
final é nó como qualquer outro (§2): tem `skill_ref`, tem contrato, e roda. O
que ele não tem é aresta de saída.

Daí a regra de conclusão, que o control plane deriva a cada leitura e nunca
guarda:

- **Nó final que pina uma skill** — o caso de todo grafo registrado, porque o
  schema exige `skill_ref` em todo nó (§6, `node_with_contract`) — só encerra a
  travessia quando a sessão daquele nó fecha com `status: "completed"` e um
  `output` que o `output` da skill pinada aceita. Até lá o trabalho continua
  candidato a despacho como qualquer outro. Chegar não conclui.
- **Nó final sem `skill_ref` nenhum** encerra na chegada. É ramo defensivo, não
  forma suportada de documento: nenhum grafo que passa por `POST /v1/graphs`
  chega aqui. Existe para o snapshot malformado ou anterior ao campo degradar em
  vez de estourar, mesma postura de `resolveNode` e `resolveOutputSchema`.

A regra é da **presença do pino**, nunca do `tipo_no`: portão não é entidade
separada (§2), e um portão final com skill roda exatamente como um nó de
trabalho final com skill.

Por que isso está aqui e não só no código: o grafo de fábrica de bets termina em
`registro-monitoramento`, que pina `registrar-travessia` — a etapa de registro e
monitoramento da D14 —, e o de software termina em `implantar`, que pina
`implantar-release`. Enquanto a conclusão vinha da chegada, essas duas etapas
nunca ganhavam sessão, e a travessia terminava em silêncio: sem falha, sem
evento, sem registro. Foi o buraco 2 da primeira execução real
(`notas/2026-08-17-primeira-execucao-bets.md`).

Uma sessão que fecha `completed` com relatório recusado pelo schema **não**
conclui e **não** bloqueia: o trabalho segue candidato. Teto de tentativas
falhas seguidas é problema geral do core, não deste ponto do grafo.

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
validarEstrutura(doc) // → { valid, errors: [{ code, message, target }] }
validarSoundness(doc) // → { valid, violations: [{ rule, target }] }
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
| `reachable` | Todo nó é atingível a partir de `no_inicial` seguindo `arestas`. | id do nó | [`grafo-invalido-unreachable-node.json`](../../schema/exemplos/grafo-invalido-unreachable-node.json) |
| `terminates` | De todo nó existe caminho até algum nó em `nos_finais`. | id do nó | [`grafo-invalido-sem-terminacao.json`](../../schema/exemplos/grafo-invalido-sem-terminacao.json) |
| `edge_with_condition` | Nenhuma aresta com `condicao` ausente ou vazia. | `{from, to}` | [`grafo-invalido-aresta-sem-condicao.json`](../../schema/exemplos/grafo-invalido-aresta-sem-condicao.json) |
| `node_with_contract` | Nenhum nó sem `skill_ref` ou `contrato`, nem com `verificacoes` vazio. | id do nó | [`grafo-invalido-no-sem-contrato.json`](../../schema/exemplos/grafo-invalido-no-sem-contrato.json) |

Notas de leitura:

- **`reachable` é topológica.** Ela segue arestas independentemente da
  condição: uma aresta com rótulo vazio ainda liga dois nós. Quem reclama do
  rótulo é `edge_with_condition`. As regras são independentes de propósito —
  cada contraexemplo do repositório viola exatamente uma delas, o que torna cada
  regra demonstrável isolada.
- **`terminates` é calculada de trás para frente**, das arestas invertidas a partir
  dos nós finais. Nó preso em ciclo sem saída simplesmente nunca é atingido — é
  assim que um ciclo de retrabalho legítimo passa e um esquecimento de saída não.
- **`node_with_contract` vale igual para portão**, que é nó como outro qualquer.

Rodando pela linha de comando (sai 1 se algum documento falhar):

```
node scripts/validar-grafo.mjs schema/exemplos/*.json
```

Os testes são `node --test` (o repositório ainda não tem `package.json`, por
escolha — zero dependências).

### 6.1 Contract matching: every required input has a producer (`t278`)

*(This subsection is in English per the 2026-08-18 language rule; the sections
around it are the pre-existing Portuguese of this document.)*

Structure and soundness judge the document's shape and its topology. Neither one
asks the question a session actually depends on: **when a job arrives at this
node, will the data its skill declares as required be there?** Three real
crossings answered that at dispatch time, after the sessions were paid for
(`notas/2026-08-17-segunda-execucao-bets.md` gap 5,
`notas/2026-08-17-t109-feature-do-jogo.md` gap 4). `validateContracts`
([`packages/core/src/domain/graph.ts`](../../packages/core/src/domain/graph.ts))
is that question, answered statically, before any session opens.

**It checks the PINNED SKILL's `input`/`output`, never the node's own
`entrada_schema`/`saida_schema`.** The subsection [`saida_schema` documenta; quem
valida é a skill](#saida_schema-documenta-quem-valida-é-a-skill-t267) already
draws this line for output, and it holds for input too — where the two have
already drifted: the software bundle's `refinar` node declares
`required: ["ticket_id", "pedido"]`, while `refinar-ticket@1.0.0` really requires
`["job", "project"]`. Only the skill's schema is enforced anywhere, so only the
skill's schema is checked.

**The three sources a node can count on**, and nothing else:

| Source | Paths | Who supplies it |
|---|---|---|
| Control-plane projection | `job`, `job.id`, `job.title`, `job.body`, `traversal`, `traversal.nodes_visited`, `traversal.entered_at`, `traversal.sessions_by_node`, `perguntas_respondidas`, `project`, plus `project.<key>` for each key the document's own `project` declares, plus each `custom_fields[].name` as a top-level scalar | `domain/context.ts`'s `buildNodeInput` (`ALWAYS_AVAILABLE_INPUT_PATHS`) |
| Executor environment | `banco_de_testes`, `banco_de_testes.caminho`, `banco_de_testes.comandos_de_dados`, `referencia`, `referencia.commit`, `referencia.modo`, `referencia.lido_em` | the runner, at every dispatch (`EXECUTOR_PROVIDED_INPUT_PATHS`) |
| Ancestors' output | `<balde>.<name>` for every `name` in the ancestor's skill `output.required`, where `<balde>` is its `produces` (top level when it declares none) | whichever node ran before |

`job.type` is **not** on the list: the column does not exist, the projection
omits the key when it is absent, and a skill that requires it is refused even at
the initial node. `resultado` is never counted as produced: it is the routing
label, stripped before storage (`t269`).

**A node is judged on every path into it, not on some path.** A node can have
more than one incoming edge — a rework loop, three edges into one final node — so
availability is a meet over predecessors:

```
avail(no_inicial) = BASE
avail(N)          = BASE ∪ ⋂ over every predecessor P of (avail(P) ∪ produced(P))
```

Intersection, not union, iterated to a fixed point (the set only shrinks, so it
converges in at most `nodes.length` rounds). A key produced only after a rework
loop is not there the first time the node runs, and this is what says so. It is
the same computation a compiler runs for "available expressions".

**Declared limit: one level of nesting, on both sides.** A required `project`
whose own schema requires `capital` is checked as `project` and `project.capital`
— and stops there. `project.capital.total` is **not** checked, on either the
producing or the consuming side. Two levels would mean walking arbitrary JSON
Schema (`$ref`, `allOf`, `items`) to decide what a path even means, and every
incident that motivated this rule is one level deep. A gap deeper than that
survives the check.

**The vocabulary of the report** (`ContractReport`, the `contracts` key of the
`422` and of the `201`):

| Name | What it says |
|---|---|
| `unproduced_input` | The node requires this key path and no path into it supplies one. Carries `node_id`, `key` and `produced_elsewhere_by`. |
| `skill_ref_unresolved` | The pin resolved to nothing, so this node's contract could not be read. It is not availability-checked, and it contributes nothing to its descendants. |
| `produced_elsewhere_by` | Node ids whose skill output would place this exact path *somewhere* — under a bucket the reader does not open, or on a path that does not always reach it. Empty means the key exists nowhere in the document. |

**Where it runs, and where it does not.** `cartografo import` runs it offline
over the bundle's own `skills/` (scope `contract`, alongside `graph`, `manifest`
and `pin`), which is the check a bundle author wants before anything is sent.
The three routes that write a graph version — `POST /v1/graphs`,
`POST /v1/graphs/:id/fork` and `POST /v1/proposals/:id/apply` — each answer for
the version they write, and the next subsection is how. The two DB-less
reference validators
([`scripts/validar-grafo.mjs`](../../scripts/validar-grafo.mjs) and
[`scripts/validate-factory-bundle.mjs`](../../scripts/validate-factory-bundle.mjs))
do not carry this check: it needs a skill lookup, and they have none by design.

**The outcome is on the answer, whichever it is (`t284`).** `POST /v1/graphs`
publishes `contracts` on the `201` too, and not only inside the `422`. Until
`t284` the success said `{graph, graph_version}` and nothing more, so "every
contract was checked and they hold" and "no contract was read at all" arrived at
a client as the same body — and the second one is a graph nobody has judged yet.

| `contracts` | When | What it carries |
|---|---|---|
| `{"status": "checked", "valid": …, "problems": […]}` | every pin resolved | the report above. `valid: false` is the `422`; on a `201` it is always `true` |
| `{"status": "skipped", "reason": "skill_ref_unresolved", "problems": […]}` | at least one pin unresolved | the `skill_ref_unresolved` problems and nothing else — no `valid`, because a check that did not run neither passed nor failed, and no `unproduced_input`, because those were computed with an ancestor that produces nothing only for want of a manifest |

`skipped` is what happened to the CALL, and since `t283` it is no longer the end
of the story: the same `201` carries `graph_version.contracts`, the state the
version was stored with, and §6.2 is what becomes of it. The two keys are not
the same shape and must not be read as one — `status`/`valid` is the verdict of
this call, `state` is where the version stands.

### 6.2 The state a version carries, and the one gate that reads it (`t283`)

*(In English for the same reason §6.1 is.)*

Registering a document and running work against it are two different promises,
and until `t283` they were the same code path. `POST /v1/graphs` is permissive on
purpose — a graph whose skills arrive afterwards is the ordinary case for the
screen's editor, for a forked example and for every fixture in
`schema/exemplos/` — so the check standing aside there is right. It stops being
right the moment a job runs against that version, which is where D9's "contract
is the common spine" has to hold. So the check's outcome is no longer only
reported: it is **stored on the version**, and the gate moved to execution.

`graph_version` carries `contracts_state` and `contracts_report`
(`entities-versioning.md` §1), and every read of a version publishes them as
`contracts: {state, problems}` — `GET /v1/graphs/:id/versions`,
`GET /v1/graph-versions/:id` and the `201` of all three write routes.

| `state` | What it means | How a version gets there |
|---|---|---|
| `checked` | every pin resolved and the check passed | the check ran, at birth or on a re-check |
| `unchecked` | at least one pin resolved to nothing, so the question was never answered | birth over a registry that could not answer; it is left the moment the missing manifest is registered |
| `failed` | every pin resolved and the check refused | a re-check, or applying a proposal whose result is resolved and invalid — never `POST /v1/graphs`, which answers `422` for that document instead of writing it |

`unchecked` is **not** a soft `failed`. It is the absence of an answer, and the
distinction is what tells a caller what to do: register the manifests the report
names, and the version moves on its own; a `failed` one needs a new version of
the graph.

**The three write sites, and why they answer differently.** A default here would
have been a fourth answer and the wrong one: two of the three paths would mint
versions permanently `unchecked`, because the only re-check trigger is a manifest
arriving, and a class whose skills are already registered never fires one.

- **`POST /v1/graphs`** runs the check against the registry and stores what it
  classified. `failed` still refuses with `422` and writes nothing.
- **`POST /v1/graphs/:id/fork`** *copies* the base's stored answer. It does not
  recompute and does not touch the registry: the variant is the base's snapshot
  with `lineage` swapped, and this check reads `nodes`, `edges`, `custom_fields`,
  `project` and `initial_node` — never `lineage`.
- **`POST /v1/proposals/:id/apply`** *recomputes*, because the applied document
  differs from its target — that is what a proposal is. It adds no refusal of its
  own: a resolved-but-invalid result is stored `failed`, and the gate below is
  where that bites.

**The re-check.** Registering a manifest (`POST /v1/skills`, and only when a row
is really written — a same-hash reimport changes nothing) re-runs the whole check
over every `unchecked` version that pins it, against the registry as it stands
now. Each version that is re-judged records
[`graph_version.contracts_checked`](../../especificacoes/eventos/taxonomia.md).
It re-runs the WHOLE check and not just the one pin, because a version can be
waiting on three manifests, and it may land on `failed`: resolving the last pin
is what finally makes an `unproduced_input` real evidence instead of an artefact
of an empty registry.

**The gate.** `POST /v1/jobs` refuses a `graph_version_id` that resolves to a
version whose state is not `checked`, with `409` and
`graph_version_unchecked` / `graph_version_contracts_failed`, carrying
`graph_version_id` and `contracts`. It is enforced in `createJob`
(`repositories/job.ts`), the single writer of a job row, so every future caller
inherits it. A job with **no** `graph_version_id`, or one that resolves to
nothing, is unchanged: the control plane has nothing to read, and refusing over
an absence would break the manual and imported flows for a fact it cannot check.

---

## 7. O documento como bundle exportável

Versionamos como o git pensa, sem o git no núcleo (D15). O snapshot de uma
versão de grafo é **este documento inteiro**, e é isso que a coluna `snapshot` de
`graph_version` guarda quando o control plane existir (`t100`/`t101`). Como o
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
| [`grafo-valido-dois-engines.json`](../../schema/exemplos/grafo-valido-dois-engines.json) | Dois nós de trabalho numa aresta, um sem `engine` e outro com `"engine": "codex"`: o menor documento que distingue um default de uma rota (§2). |
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
