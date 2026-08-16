# Manifesto de skill — especificação

> Formato-produto do cartografo. O manifesto é o que faz uma capacidade —
> skill de fazer ou de portão — entrar no registro. Sem manifesto válido, não
> entra (D4).

**Estado: especificação normativa, com registro implementado.** O entregável
desta doc continua sendo o contrato — schema formal, exemplos que validam e um
fixture que é rejeitado —, e é ele que manda: quando implementação e schema
divergem, quem está errada é a implementação. O que mudou é que já existe
registro: a tabela `skill` e as rotas `POST /v1/skills` e `GET /v1/skills[/:id]`
persistem manifestos e os devolvem a quem consulta capacidades. Entram por dois
caminhos, e a diferença é D4: skill **nativa** (in-repo, já revisada no merge)
entra junto com o bundle, por `cartografo import <bundle>`; skill de **repo
externo** entra pelo pipeline com portão humano `cartografo scan-skill` →
`propose-skill` → `register-skill`. Em ambos os casos o registro reverifica
tudo por conta própria — pin, forma, proveniência —, porque assinatura humana
não é verificação. Desde a `t161` o registro também é **lido na hora de
executar**: o runner busca a skill que o nó pina, recusa o despacho se o hash
não bate com o do registro, e renderiza `instructions`, `checks` e `permissions`
para dentro da sessão
([`render-skill-instructions.ts`](../../packages/runner/src/dispatch/render-skill-instructions.ts)).
Desde a `t204` ele também **interpola** `{{input.<caminho>}}` dentro de
`instructions`, com falha fechada: caminho que não resolve aborta o despacho
antes de abrir sessão nenhuma. O que ainda não existe é quem **monta** essa
entrada — na ausência dela o despacho passa `{}`, e toda skill com placeholder
recusa (ver *Renderização e injeção*). Ainda não implementado: a interpolação
em `checks[].command`; ler `budgets` para dentro do despacho; e
reimportar/versionar uma skill já registrada (o registro é create-only por
enquanto).

| Arquivo | O que é |
|---|---|
| [`manifesto-skill.schema.json`](./manifesto-skill.schema.json) | JSON Schema draft 2020-12; a definição normativa. |
| [`exemplos/manifesto-skill.develop.json`](./exemplos/manifesto-skill.develop.json) | Exemplo completo, `role: "work"` — porte comportamental do `feature-dev`/`development.py` do flowpilot. |
| [`exemplos/manifesto-skill.verificacao-develop.json`](./exemplos/manifesto-skill.verificacao-develop.json) | Exemplo completo, `role: "gate"` — porte comportamental do `testing.py` do flowpilot. |
| [`exemplos/manifesto-skill.invalido.fixture.json`](./exemplos/manifesto-skill.invalido.fixture.json) | Fixture negativo, só de teste: prova que o schema rejeita manifesto malformado. |

## Por que este formato existe

O contrato é a peça de sustentação (README, princípio 3): sem ele o
sintetizador compõe grafo por alucinação; com ele, compor grafo vira casar
contratos. D9 fixa a forma do contrato — entrada e saída em JSON Schema,
verificação como lista de checks tipados, cada check sendo ou um comando
determinístico ou uma instrução agêntica com evidência obrigatória. D4 fixa
quem entra no registro: skill sem contrato não entra, e skill importada entra
com pin por hash e revisão humana.

O manifesto é o objeto que carrega esse contrato. Ele é o que o banco guarda,
o que o registro indexa, o que o sintetizador lê ao consultar capacidades e o
que o runner renderiza para dentro de uma sessão.

Duas coisas que o formato precisa carregar, e carrega em campo, não em prosa:

- **Papel muda; a forma do contrato não.** Tudo que executa é skill com
  contrato; o que varia é o papel (fazer, conferir). Um portão é uma skill
  como as outras — o que o distingue é `role: "gate"`, a obrigação de ter
  pelo menos um check, e a saída com `outcome`.
- **Portão verifica com evidência própria.** Nunca com o autorrelato de quem
  produziu o artefato. Isso está codificado em três lugares do manifesto do
  portão, não só no texto: `required_evidence` no check agêntico, o campo
  de entrada `artefato.gates_declarados` marcado explicitamente como
  autorrelato, e o check determinístico que roda a suíte de novo em vez de
  ler o `gates` que a sessão de develop declarou.

## Os campos

### Identificação: `id`, `version`, `hash`

- **`id`** — identificador estável, `kebab-case` (`^[a-z0-9]+(-[a-z0-9]+)*$`),
  único no registro. É a chave por onde um nó do grafo aponta para a skill.
- **`version`** — semver. Muda a cada diff aprovado no portão humano; é a
  cadeia de versão que responde "por que a skill é assim?" com log em vez de
  arqueologia.
- **`hash`** — o pin de conteúdo de D4, no formato `sha256:<64 hex>`.

O hash é calculado sobre a serialização JSON canônica (chaves ordenadas, sem
espaço insignificante — RFC 8785) do subconjunto
`{instructions, input, output, checks, permissions, budgets}`:

```bash
node -e '
const fs=require("fs"),c=require("crypto");
const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const canon=v=>Array.isArray(v)?v.map(canon):(v&&typeof v==="object"
  ?Object.keys(v).sort().reduce((o,k)=>(o[k]=canon(v[k]),o),{}):v);
const sub={instructions:m.instructions,input:m.input,output:m.output,
           checks:m.checks,permissions:m.permissions,budgets:m.budgets};
console.log("sha256:"+c.createHash("sha256")
  .update(JSON.stringify(canon(sub)),"utf8").digest("hex"));
' especificacoes/formatos/exemplos/manifesto-skill.develop.json
```

(Os dois exemplos deste diretório carregam o hash de verdade: o comando acima
reproduz o valor gravado em cada um, e
[`manifesto-skill.test.mjs`](./manifesto-skill.test.mjs) confere isso a cada
`npm test`, junto com os quatro comandos de validação da seção *Como validar*.)

O que está **dentro** do hash é comportamento: o texto que vai ser injetado na
sessão, o contrato de dados, o que a skill pode tocar e por quanto tempo ela
pode rodar. O que está **fora** (`id`, `version`, `description`, `origin`) é
metadado de catálogo. Renomear a skill ou corrigir a descrição não invalida o
pin; mudar uma linha das instruções, afrouxar um check, abrir uma permissão ou
esticar um orçamento muda o hash — que é exatamente a mudança que D4 quer
travar. Um manifesto cujo hash não bate com o próprio conteúdo é manifesto
adulterado: não roda.

Crescer o subconjunto é barato de propósito: campo ausente serializa como
nada (`JSON.stringify` derruba chave com valor `undefined`), então só um
manifesto que passa a declarar o campo novo muda de hash. Foi assim que
`budgets` entrou sem tocar no pin de nenhum manifesto já registrado.

### `role`

`work` (produz artefato) ou `gate` (confere artefato de outro nó).

Não existe um terceiro papel "rotear": rotear é consequência do `outcome` de
um portão, lido pelo executor para escolher a aresta, não uma capacidade à
parte (D3, e o princípio 2 do README — as únicas decisões em voo são as dos
portões).

`role: "gate"` obriga `checks` a ter pelo menos um item, e isso o schema
impõe. Portão sem check é portão decorativo — o limite honesto do princípio 6.

### `description`

Uma linha. É o que o sintetizador lê ao consultar o registro de capacidades,
então ela descreve o que a skill **faz**, não como.

### `input` e `output`

Documentos JSON Schema, embutidos. O schema do manifesto valida que são
objetos; a validação deles como JSON Schema é feita à parte, contra o
meta-schema oficial, na entrada do registro (o schema do manifesto não
carrega o meta-schema inteiro dentro de si).

`input` é o que o nó recebe: a projeção do estado que aquele nó precisa,
nunca a janela de contexto inteira (princípio 4). `output` é o que a sessão
tem de devolver para o trabalho ser considerado concluído.

**Regra do portão:** manifesto com `role: "gate"` declara em `output` um
campo `outcome` com enum `["pass", "fail", "escalate_human"]` — os três
resultados que o executor sabe interpretar. Essa regra é verificada na
entrada do registro, junto com a validação de `input`/`output` como JSON
Schema; o schema deste formato não a impõe estruturalmente (ver *Limites
conhecidos*).

### `preconditions`

Lista de frases: o que precisa ser verdade no estado **antes** de despachar a
sessão. O executor checa antes de abrir sessão; pré-condição não satisfeita
não vira sessão que falha, vira trabalho que não é liberado.

São condições sobre o estado, não sobre o resultado — "worktree isolado
criado" é pré-condição; "suíte verde" é check.

### `checks`

A verificação tipada de D9. Cada check tem `id` (estável dentro da skill — é
por ele que a telemetria agrega), `description` e `type`:

- **`deterministic`** exige `command`: uma linha de shell. Exit 0 = passou,
  qualquer outro = falhou. `timeout_s` opcional. É a forma preferida sempre
  que possível — rodar teste, validar schema, buildar.
- **`agentic`** exige `instruction` **e** `required_evidence` (array não
  vazio). Existe só onde há julgamento que nenhum comando resolve
  ("os critérios de aceite foram atendidos?").

`required_evidence` lista os artefatos que o veredito precisa citar. Não é
decoração: é o que impede um check agêntico de concluir por leitura de código
ou, pior, por leitura do relatório de quem produziu o artefato. Um check
agêntico sem essa lista é a falha silenciosa que o fixture negativo deste
diretório existe para pegar.

**Check em skill de `work` é autocheck.** Os checks de `develop` (suíte
verde, árvore limpa) são o que a sessão roda antes de se declarar pronta —
declaração, não prova. Quem prova é o portão, com evidência própria. Por isso
o portão de verificação roda a suíte **de novo**, em vez de ler o campo
`gates` que a sessão de develop preencheu.

### `permissions`

`filesystem` (`read`, `write`) e `network` (`allowed`, `domains`
opcional). Ambos obrigatórios: a ausência de declaração nunca é lida como
"pode tudo".

- Padrões de caminho são globs. Glob **relativo** é resolvido a partir da raiz
  do workspace da sessão; glob **absoluto** é literal (o portão do exemplo usa
  `/tmp/cartografo/**` como área de rascunho justamente por não poder escrever
  no checkout que julga).
- Array vazio significa **nenhum acesso**, não "irrestrito".
- `network.allowed: false` fecha a rede; `domains` nesse caso é ignorado.
- `network.allowed: true` **sem** `domains` declara rede irrestrita. É legal
  para skill nativa, e é rejeitado na importação (ver *Regra de importação*).

**Declarar não é aplicar** — mas, desde a `t161`, declarar chega ao despacho.
Esta especificação define a declaração; a t125 construiu o enforcement no
adapter, e a t161 ligou os dois: o runner resolve `permissions` da skill
registrada para dentro da sessão, e o que a skill declarou é o que a sessão
recebe. Cada eixo continua valendo também como contrato revisável e como base
do diff de permissão entre versões — uma skill que abre uma permissão nova muda
de hash e reaparece no portão humano.

**O que o adapter não consegue expressar, ele recusa.** Um eixo que o engine
não sabe aplicar não abre sessão nenhuma: o `claude-code` expressa "toda a
escrita ou nenhuma" e "rede aberta ou fechada", e nada entre os dois, então
`write` com glob no meio do caminho ou `network.allowed: true` **com**
`domains` fazem `startSession` recusar antes de gastar qualquer coisa
(`packages/runner/src/engine/permission-policy.ts`). É o comportamento certo —
sessão que aplica menos do que foi declarado, em silêncio, é a única saída que
um sistema de permissão não pode ter — e é uma restrição real sobre o que um
manifesto pode declarar hoje e ainda rodar.

### `budgets`

Opcional, e cada eixo dentro dele também: `timeout_s` (relógio de
parede) e `silence_s` (segundos sem nenhuma saída). Ambos inteiros, mínimo 1
— um orçamento de zero não é orçamento, e o schema recusa.

São dois cães de guarda **independentes**, porque medem coisas diferentes:
uma sessão pode ficar viva e produtiva por uma hora, e outra pode travar em
dois minutos com o processo de pé. O relógio de parede responde "isto já
custou demais"; o de silêncio responde "isto parou de acontecer". O de
silêncio reinicia a cada saída do processo, então uma sessão que fala não é
morta por ele nunca.

**Declarar encurta, nunca alonga.** O que a skill não declara herda o teto do
servidor; o que ela declara vale se for MENOR que esse teto, e é ignorado se
for maior (`resolveBudget`, `packages/runner/src/engine/resolve-budget.ts`).
Uma skill não afrouxa a própria rede de segurança — nem por engano nem de
propósito —, e é por isso que `budgets` entra no hash junto com
`permissions`: os dois são declaração de comportamento, e mudança de
comportamento reaparece no portão humano.

**Estado hoje, sem maquiagem:** nada lê `budgets` de uma skill registrada
para dentro de um despacho. A razão deixou de ser "o pipeline de renderização
não existe" — a `t161` o construiu, e `instructions`, `checks` e `permissions`
já atravessam (ver *Renderização e injeção*) —, e passou a ser simplesmente que
`budgets` ficou de fora daquela ficha. O que existe é o contrato aqui, o
mecanismo do teto no runner, e o enforcement nos dois adapters (caso C9 do kit
de conformidade). Até que alguém ligue o campo, toda sessão roda com os tetos
do servidor.

### `instructions`

O corpo em Markdown que vai ser injetado na sessão. Pode conter placeholders
`{{input.<caminho>}}`, resolvidos pelo runner contra a `input` validada
antes do despacho.

O caminho é uma ou mais partes de `[a-zA-Z0-9_]+` separadas por `.`, andadas
uma a uma dentro da `input`. Valor que é string entra **literal**, sem escape
nenhum — o manifesto foi revisado no portão de importação (D4), e escapar aqui
seria o runner reescrevendo texto revisado. Qualquer outro valor JSON (número,
booleano, `null`, lista, objeto) entra como `JSON.stringify` compacto.

**Falha fechada, e implementada desde a `t204`:** caminho que não resolve —
chave ausente, ou caminho que atravessa algo que não é objeto — não vira texto
na sessão. O despacho é recusado antes de abrir sessão
(`UnresolvedPlaceholderError`, com todos os caminhos que faltaram de uma vez),
na mesma janela em que hash divergente já recusava. Corpo sem nenhum
`{{input.` renderiza byte a byte o que sempre renderizou.

Por convenção, a mesma interpolação vale em `checks[].command` — é o que
permite um check determinístico ser estável e mesmo assim rodar o comando de
teste do projeto em questão (`{{input.projeto.comando_testes}}` nos dois
exemplos). Essa metade **ainda não está implementada**, e não por esquecimento:
nenhum código executa o `command` de um check hoje, então não há onde ligá-la.
A regra vale igual para quando existir — comando que ainda contém `{{` nunca é
executado.

### `origin`

Proveniência. `type: "native"` (escrita dentro do projeto) ou
`type: "imported"`, e nesse caso o schema passa a exigir `repo`, `ref`,
`imported_by`, `imported_at` e `reviewed_by` — a assinatura do portão de
D4, em campo obrigatório, para que "foi revisada" não seja lembrança de
ninguém.

## Renderização e injeção

O manifesto mora no banco. Ele não é um arquivo no repositório alvo, e o
sistema não depende de `CLAUDE.md` nem de nenhum markdown residente lá:

1. O executor libera o nó; o runner busca na API o manifesto da skill daquele
   nó, na versão pinada pelo grafo (`id` + `version` + `hash`).
2. O runner monta a `input` a partir da projeção de contexto daquele nó —
   estado explícito e event log, nunca janela compartilhada (princípio 4) — e
   valida contra o schema `input` do manifesto. Entrada inválida não vira
   sessão.
3. O runner confere o `hash` contra o conteúdo recebido. Divergiu, não roda.
4. O runner renderiza `instructions` interpolando `{{input.<caminho>}}`, e
   resolve os `command` dos checks determinísticos do mesmo jeito.
5. O runner entrega o texto renderizado ao EngineAdapter, que abre a sessão.
   **Como** o texto chega ao CLI — flag, stdin, arquivo efêmero — é decisão de
   cada adapter e está fora do escopo desta doc (é a interface de t99).
6. A sessão devolve um resultado; o runner valida contra o schema `output` e
   registra na API. Só o server escreve no banco (D1).

Consequência que vale explicitar: como o contrato vive no banco e é renderizado
por engine, trocar de engine não perde skill nem aprendizado — o que foi
aprendido está no manifesto versionado, não no contexto de uma sessão.

**Quanto disso roda hoje (`t204`):** os passos 1, 3 e 5 estão implementados e
cobertos por teste, e o 6 registra na API sem validar `output` contra o schema.
O passo 4 interpola `instructions` de verdade, com falha fechada — placeholder
que não resolve recusa o despacho antes de qualquer sessão —, e não resolve os
`command` dos checks (ver `checks` e *Limites conhecidos*).

**O passo 2 continua não existindo, e é ele que falta.** Não há projeção de
contexto por nó: nenhum evento e nenhuma tabela carrega a saída estruturada de
um nó, então nada monta o objeto que o `input` do nó seguinte declara. O
despacho expõe a costura (`resolveInput`, em
[`dispatch-claude-code.ts`](../../packages/runner/src/dispatch/dispatch-claude-code.ts))
e, sem ninguém para preenchê-la, passa `{}` — ou seja, **hoje toda skill com
placeholder recusa em produção**, alto e determinístico, em vez de abrir sessão
com o token cru no prompt como fazia até a `t204`. Encadear a saída de um nó na
entrada do seguinte (o `merge_commit` que `testar` pede é produzido por
`integrar`) é ficha própria, e é pré-requisito duro para despachar qualquer nó
das duas fábricas cuja skill use placeholder.

Além dos cinco campos que a renderização cita, o runner injeta na sessão o
**contrato do próprio nó** (`input_schema`, `output_schema`, `checks`,
que vivem no grafo e não no manifesto) e, num nó com duas ou mais saídas, o
protocolo de roteamento: um bloco cercado `outcome` nomeando as `condition`
das arestas daquele nó. O vocabulário de rota é o do **grafo**, nunca o
`outcome` do `output` da skill — são dois enums diferentes, de propósito
([`docs/spec/grafo.md`](../../docs/spec/grafo.md)).

## Regra de importação (D4)

`SKILL.md` público quase nunca declara entrada, saída ou verificação. Sem um
passo que **derive e registre** o contrato, o princípio 3 quebra em silêncio:
a skill entra no grafo sem ninguém saber o que ela consome, o que ela produz
nem como se confere o que ela fez.

O caso de referência é concreto. O frontmatter de
`~/flowpilot/.claude/skills/feature-dev/SKILL.md` declara três coisas —
`name`, `description`, `user_invocable` — e nada mais: nem entrada, nem saída,
nem checks, nem permissões. Onze dos doze campos obrigatórios do manifesto não
existem na origem.

A importação é, então, um pipeline de derivação assistida com portão humano.
Campo a campo do `required` do schema:

| Campo | O que a origem costuma trazer | Como se preenche na importação |
|---|---|---|
| `id` | `name` do frontmatter | Normalizado para `kebab-case`; se colidir com id já registrado, recebe prefixo de origem. Decisão humana quando há colisão. |
| `version` | nada (SKILL.md raramente versiona) | Atribuída no ato: `0.1.0` para importação nova. A referência real da origem vive em `origin.ref`, não aqui. |
| `hash` | nada | Calculado no registro, sobre o manifesto **derivado** — nunca sobre o SKILL.md de origem. É o pin que D4 exige: qualquer edição posterior no texto importado muda o hash e volta ao portão. |
| `role` | implícito no corpo | Inferido por leitura e **confirmado por humano**. `feature-dev` é `work`. Erro aqui é caro: uma skill de fazer registrada como portão vira um portão que não confere nada. |
| `description` | `description` do frontmatter | Único campo que costuma servir quase direto; revisado para descrever o que a skill faz, não como. |
| `input` | prosa ("Input: a refined ticket in `workflow/wip/`") | Derivada por leitura assistida e escrita como JSON Schema pelo revisor. Onde a prosa não diz, o revisor decide e registra — nunca se infere em silêncio. |
| `output` | prosa ("Report: files created/modified, test counts, commit hash") | Idem. Para `role: "gate"`, o revisor **tem** de incluir `outcome` com os três valores do enum, senão o executor não sabe rotear. |
| `preconditions` | seções de escopo ("Scope — when this skill applies") | Extraídas dessas seções e reescritas como condições sobre o estado, verificáveis antes do despacho. |
| `checks` | quase nunca existe de forma tipada | O ponto mais crítico. Comandos citados no corpo (`make test`, `make lint`) viram checks determinísticos; o que restar de julgamento vira check agêntico **com** `required_evidence`. Se não der para escrever nenhum check, a skill não entra: princípio 6, sem verificação não há portão. |
| `permissions` | nunca | **Nunca inferidas do texto.** Entram com o default seguro abaixo, e só são ampliadas por decisão humana registrada. |
| `instructions` | o corpo do SKILL.md | O corpo, **revisado como vetor de injeção**: remover referência a arquivo residente no repo alvo (o manifesto não depende de `CLAUDE.md`), a documento externo que a origem controla, e qualquer instrução que peça credencial, exfiltração ou execução de conteúdo baixado. Caminhos e comandos específicos da origem viram placeholders `{{input.<campo>}}` ou saem. |
| `origin` | a URL de onde veio | `type: "imported"` mais `repo`, `ref` (commit ou tag, não branch — branch se move), `imported_by`, `imported_at`, `reviewed_by`. O schema torna os cinco obrigatórios quando o tipo é `imported`. |

### Default seguro de permissões para `origin.type: "imported"`

Toda skill importada nasce com:

```json
{
  "filesystem": { "read": ["**"], "write": [] },
  "network": { "allowed": false }
}
```

Ler o workspace da sessão, não escrever nada, não falar com a rede. Ampliar
qualquer um dos três é decisão humana explícita, registrada no portão de
importação, e muda o hash — ou seja, reaparece na revisão da versão seguinte.
Em particular, `network.allowed: true` **sem** lista de `domains` é rejeitado
na importação: skill de terceiro com rede irrestrita e instruções que ninguém
escreveu é a definição do vetor de supply chain que D4 existe para fechar.

### O que o revisor humano assina

Que o `role` está certo; que `input`/`output` descrevem o que a skill de
fato consome e produz; que existe pelo menos um check e que o agêntico exige
evidência própria; que as `permissions` são o mínimo necessário; e que as
`instructions` revisadas não carregam instrução hostil. Assinado, o manifesto
entra no registro pinado por hash. Sem assinatura, não entra.

## Como validar

Os artefatos desta especificação são verificáveis hoje, sem scaffold de
projeto, com o `ajv-cli` via `npx`. Da raiz do repositório:

```bash
# 1. o schema é um JSON Schema válido (draft 2020-12)
npx --yes ajv-cli@5 compile -s especificacoes/formatos/manifesto-skill.schema.json --spec=draft2020

# 2. o exemplo de skill "fazer" valida contra o schema
npx --yes ajv-cli@5 validate -s especificacoes/formatos/manifesto-skill.schema.json \
  -d especificacoes/formatos/exemplos/manifesto-skill.develop.json --spec=draft2020

# 3. o exemplo de skill "portão" valida contra o schema
npx --yes ajv-cli@5 validate -s especificacoes/formatos/manifesto-skill.schema.json \
  -d especificacoes/formatos/exemplos/manifesto-skill.verificacao-develop.json --spec=draft2020

# 4. o fixture negativo é REJEITADO (exit != 0 é o resultado esperado aqui)
npx --yes ajv-cli@5 validate -s especificacoes/formatos/manifesto-skill.schema.json \
  -d especificacoes/formatos/exemplos/manifesto-skill.invalido.fixture.json --spec=draft2020
```

Os três primeiros saem com exit 0; o quarto sai com exit diferente de 0 — é o
que prova que o schema não é permissivo demais.

Os quatro rodam automaticamente em `npm test`, por
[`manifesto-skill.test.mjs`](./manifesto-skill.test.mjs), com `ajv` importado
direto em vez de por `npx`: portão que precisa de rede é portão vermelho no
avião. O arquivo confere também o que nenhum `ajv` conferiria — que o `hash`
gravado em cada exemplo reproduz o próprio conteúdo, e que a receita de hash
desta doc e o subconjunto pinado não se separaram.

### O fixture negativo

`exemplos/manifesto-skill.invalido.fixture.json` **não** é um exemplo de
manifesto: é material de teste. Ele é um manifesto de portão em tudo o mais
válido, com **uma** violação proposital — o check `criterios-atendidos` tem
`type: "agentic"` e não declara `required_evidence`. Violação única e
isolada de propósito: o erro que o ajv emite aponta para a regra exata, em vez
de se perder num monte de campo faltando.

```
instancePath: '/checks/0'
schemaPath:   '#/$defs/check/allOf/1/then/required'
keyword:      'required'
params:       { missingProperty: 'required_evidence' }
```

É a regra que mais importa fechar: um check agêntico sem evidência obrigatória
é exatamente o portão que conclui pelo autorrelato de quem fez o trabalho.

## Limites conhecidos

O que o schema **não** garante, e por isso é verificado na entrada do registro
ou fica para outra ticket:

- **`input`/`output` são JSON Schema de verdade.** O schema só exige que
  sejam objetos. Validar contra o meta-schema oficial é passo do registro.
- **`outcome` na saída de um portão.** A regra está documentada e os
  exemplos a cumprem, mas não é imposta estruturalmente — impô-la exigiria o
  schema do manifesto navegar dentro de um documento JSON Schema arbitrário.
- **O `hash` corresponder ao conteúdo.** O schema valida o formato
  (`sha256:` + 64 hex), não o valor. Recalcular e comparar é trabalho do
  registro, na importação e a cada leitura do manifesto pelo runner.
- **Permissão declarada ser permissão aplicada.** Enforcement é t125, e a
  `t161` ligou a declaração ao despacho. O limite que sobra é outro, e é do
  adapter: eixo que ele não sabe expressar recusa a sessão em vez de aplicá-la
  pela metade (ver `permissions`).
- **Interpolação em `checks[].command`.** A de `instructions` existe desde a
  `t204` e falha fechada; a dos comandos de check não, porque nenhum código
  executa `command` hoje — check é declarativo, lido por revisor humano e por um
  mecanismo de portão que ainda não existe. O limite que sobra na de
  `instructions` é o de quem a alimenta: sem projeção de contexto por nó, o
  despacho passa `{}` e a skill com placeholder recusa (ver *Renderização e
  injeção*).
- **Sintaxe de placeholder validada na entrada do registro.** O registro não
  confere `{{input.…}}` nenhum ao aceitar um manifesto; quem pega placeholder
  quebrado é o despacho, que recusa. Uma checagem mais cedo seria melhor
  diagnóstico, não mais segurança.
- **Detalhe de ferramenta:** o campo `origin.imported_at` usa `pattern` de
  data ISO em vez de `"format": "date"`. O ajv em modo estrito trata formato
  desconhecido como erro de compilação quando nenhum plugin de formatos está
  carregado, e o comando de validação desta doc não carrega nenhum — `pattern`
  vale a mesma restrição sem depender de plugin.

## Versionamento deste formato

O manifesto é formato-produto: schema versionado e doc de especificação, como
o schema do grafo, a taxonomia de eventos e a interface do EngineAdapter.
Vale a regra dos dois consumidores — ele não congela antes de existirem dois
consumidores reais (o control plane que persiste e um importador que deriva
manifesto de fonte externa). Até lá, mudança de campo é mudança de doc mais
mudança de schema, no mesmo commit, com os exemplos revalidados.
