# Manifesto de skill — especificação

> Formato-produto do cartografo. O manifesto é o que faz uma capacidade —
> skill de fazer ou de portão — entrar no registro. Sem manifesto válido, não
> entra (D4).

**Estado: especificação.** Nada aqui está implementado; o control plane que
persiste e renderiza manifestos ainda não existe (t100+). O entregável desta
doc é o contrato: schema formal, exemplos que validam e um fixture que é
rejeitado — para que a implementação futura (banco, API, importador) não
precise adivinhar nenhum campo.

| Arquivo | O que é |
|---|---|
| [`manifesto-skill.schema.json`](./manifesto-skill.schema.json) | JSON Schema draft 2020-12; a definição normativa. |
| [`exemplos/manifesto-skill.develop.json`](./exemplos/manifesto-skill.develop.json) | Exemplo completo, `papel: "fazer"` — porte comportamental do `feature-dev`/`development.py` do flowpilot. |
| [`exemplos/manifesto-skill.verificacao-develop.json`](./exemplos/manifesto-skill.verificacao-develop.json) | Exemplo completo, `papel: "portao"` — porte comportamental do `testing.py` do flowpilot. |
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
  como as outras — o que o distingue é `papel: "portao"`, a obrigação de ter
  pelo menos um check, e a saída com `resultado`.
- **Portão verifica com evidência própria.** Nunca com o autorrelato de quem
  produziu o artefato. Isso está codificado em três lugares do manifesto do
  portão, não só no texto: `evidencia_obrigatoria` no check agêntico, o campo
  de entrada `artefato.gates_declarados` marcado explicitamente como
  autorrelato, e o check determinístico que roda a suíte de novo em vez de
  ler o `gates` que a sessão de develop declarou.

## Os campos

### Identificação: `id`, `versao`, `hash`

- **`id`** — identificador estável, `kebab-case` (`^[a-z0-9]+(-[a-z0-9]+)*$`),
  único no registro. É a chave por onde um nó do grafo aponta para a skill.
- **`versao`** — semver. Muda a cada diff aprovado no portão humano; é a
  cadeia de versão que responde "por que a skill é assim?" com log em vez de
  arqueologia.
- **`hash`** — o pin de conteúdo de D4, no formato `sha256:<64 hex>`.

O hash é calculado sobre a serialização JSON canônica (chaves ordenadas, sem
espaço insignificante — RFC 8785) do subconjunto
`{instrucoes, entrada, saida, checks, permissoes}`:

```bash
node -e '
const fs=require("fs"),c=require("crypto");
const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const canon=v=>Array.isArray(v)?v.map(canon):(v&&typeof v==="object"
  ?Object.keys(v).sort().reduce((o,k)=>(o[k]=canon(v[k]),o),{}):v);
const sub={instrucoes:m.instrucoes,entrada:m.entrada,saida:m.saida,
           checks:m.checks,permissoes:m.permissoes};
console.log("sha256:"+c.createHash("sha256")
  .update(JSON.stringify(canon(sub)),"utf8").digest("hex"));
' especificacoes/formatos/exemplos/manifesto-skill.develop.json
```

(Os dois exemplos deste diretório carregam o hash de verdade: o comando acima
reproduz o valor gravado em cada um.)

O que está **dentro** do hash é comportamento: o texto que vai ser injetado na
sessão, o contrato de dados e o que a skill pode tocar. O que está **fora**
(`id`, `versao`, `descricao`, `origem`) é metadado de catálogo. Renomear a
skill ou corrigir a descrição não invalida o pin; mudar uma linha das
instruções, afrouxar um check ou abrir uma permissão muda o hash — que é
exatamente a mudança que D4 quer travar. Um manifesto cujo hash não bate com
o próprio conteúdo é manifesto adulterado: não roda.

### `papel`

`fazer` (produz artefato) ou `portao` (confere artefato de outro nó).

Não existe um terceiro papel "rotear": rotear é consequência do `resultado` de
um portão, lido pelo executor para escolher a aresta, não uma capacidade à
parte (D3, e o princípio 2 do README — as únicas decisões em voo são as dos
portões).

`papel: "portao"` obriga `checks` a ter pelo menos um item, e isso o schema
impõe. Portão sem check é portão decorativo — o limite honesto do princípio 6.

### `descricao`

Uma linha. É o que o sintetizador lê ao consultar o registro de capacidades,
então ela descreve o que a skill **faz**, não como.

### `entrada` e `saida`

Documentos JSON Schema, embutidos. O schema do manifesto valida que são
objetos; a validação deles como JSON Schema é feita à parte, contra o
meta-schema oficial, na entrada do registro (o schema do manifesto não
carrega o meta-schema inteiro dentro de si).

`entrada` é o que o nó recebe: a projeção do estado que aquele nó precisa,
nunca a janela de contexto inteira (princípio 4). `saida` é o que a sessão
tem de devolver para o trabalho ser considerado concluído.

**Regra do portão:** manifesto com `papel: "portao"` declara em `saida` um
campo `resultado` com enum `["passou", "falhou", "escalar_humano"]` — os três
resultados que o executor sabe interpretar. Essa regra é verificada na
entrada do registro, junto com a validação de `entrada`/`saida` como JSON
Schema; o schema deste formato não a impõe estruturalmente (ver *Limites
conhecidos*).

### `pre_condicoes`

Lista de frases: o que precisa ser verdade no estado **antes** de despachar a
sessão. O executor checa antes de abrir sessão; pré-condição não satisfeita
não vira sessão que falha, vira trabalho que não é liberado.

São condições sobre o estado, não sobre o resultado — "worktree isolado
criado" é pré-condição; "suíte verde" é check.

### `checks`

A verificação tipada de D9. Cada check tem `id` (estável dentro da skill — é
por ele que a telemetria agrega), `descricao` e `tipo`:

- **`deterministico`** exige `comando`: uma linha de shell. Exit 0 = passou,
  qualquer outro = falhou. `timeout_s` opcional. É a forma preferida sempre
  que possível — rodar teste, validar schema, buildar.
- **`agentico`** exige `instrucao` **e** `evidencia_obrigatoria` (array não
  vazio). Existe só onde há julgamento que nenhum comando resolve
  ("os critérios de aceite foram atendidos?").

`evidencia_obrigatoria` lista os artefatos que o veredito precisa citar. Não é
decoração: é o que impede um check agêntico de concluir por leitura de código
ou, pior, por leitura do relatório de quem produziu o artefato. Um check
agêntico sem essa lista é a falha silenciosa que o fixture negativo deste
diretório existe para pegar.

**Check em skill de `fazer` é autocheck.** Os checks de `develop` (suíte
verde, árvore limpa) são o que a sessão roda antes de se declarar pronta —
declaração, não prova. Quem prova é o portão, com evidência própria. Por isso
o portão de verificação roda a suíte **de novo**, em vez de ler o campo
`gates` que a sessão de develop preencheu.

### `permissoes`

`filesystem` (`leitura`, `escrita`) e `rede` (`permitido`, `dominios`
opcional). Ambos obrigatórios: a ausência de declaração nunca é lida como
"pode tudo".

- Padrões de caminho são globs. Glob **relativo** é resolvido a partir da raiz
  do workspace da sessão; glob **absoluto** é literal (o portão do exemplo usa
  `/tmp/cartografo/**` como área de rascunho justamente por não poder escrever
  no checkout que julga).
- Array vazio significa **nenhum acesso**, não "irrestrito".
- `rede.permitido: false` fecha a rede; `dominios` nesse caso é ignorado.
- `rede.permitido: true` **sem** `dominios` declara rede irrestrita. É legal
  para skill nativa, e é rejeitado na importação (ver *Regra de importação*).

**Declarar não é aplicar.** Esta especificação define a declaração; o
enforcement em runtime (sandbox de filesystem e rede) é t125. Até lá o campo
vale como contrato revisável e como base do diff de permissão entre versões —
uma skill que abre uma permissão nova muda de hash e reaparece no portão
humano.

### `instrucoes`

O corpo em Markdown que vai ser injetado na sessão. Pode conter placeholders
`{{entrada.<caminho>}}`, resolvidos pelo runner contra a `entrada` validada
antes do despacho.

Por convenção, a mesma interpolação vale em `checks[].comando` — é o que
permite um check determinístico ser estável e mesmo assim rodar o comando de
teste do projeto em questão (`{{entrada.projeto.comando_testes}}` nos dois
exemplos). O motor de interpolação nasce junto do control plane (t100+); a
regra que ele tem de obedecer já é decidida aqui: **falha fechada** —
placeholder que não resolve aborta o despacho, e comando que ainda contém
`{{` nunca é executado.

### `origem`

Proveniência. `tipo: "nativa"` (escrita dentro do projeto) ou
`tipo: "importada"`, e nesse caso o schema passa a exigir `repo`, `ref`,
`importado_por`, `importado_em` e `revisado_por` — a assinatura do portão de
D4, em campo obrigatório, para que "foi revisada" não seja lembrança de
ninguém.

## Renderização e injeção

O manifesto mora no banco. Ele não é um arquivo no repositório alvo, e o
sistema não depende de `CLAUDE.md` nem de nenhum markdown residente lá:

1. O executor libera o nó; o runner busca na API o manifesto da skill daquele
   nó, na versão pinada pelo grafo (`id` + `versao` + `hash`).
2. O runner monta a `entrada` a partir da projeção de contexto daquele nó —
   estado explícito e event log, nunca janela compartilhada (princípio 4) — e
   valida contra o schema `entrada` do manifesto. Entrada inválida não vira
   sessão.
3. O runner confere o `hash` contra o conteúdo recebido. Divergiu, não roda.
4. O runner renderiza `instrucoes` interpolando `{{entrada.<caminho>}}`, e
   resolve os `comando` dos checks determinísticos do mesmo jeito.
5. O runner entrega o texto renderizado ao EngineAdapter, que abre a sessão.
   **Como** o texto chega ao CLI — flag, stdin, arquivo efêmero — é decisão de
   cada adapter e está fora do escopo desta doc (é a interface de t99).
6. A sessão devolve um resultado; o runner valida contra o schema `saida` e
   registra na API. Só o server escreve no banco (D1).

Consequência que vale explicitar: como o contrato vive no banco e é renderizado
por engine, trocar de engine não perde skill nem aprendizado — o que foi
aprendido está no manifesto versionado, não no contexto de uma sessão.

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
| `versao` | nada (SKILL.md raramente versiona) | Atribuída no ato: `0.1.0` para importação nova. A referência real da origem vive em `origem.ref`, não aqui. |
| `hash` | nada | Calculado no registro, sobre o manifesto **derivado** — nunca sobre o SKILL.md de origem. É o pin que D4 exige: qualquer edição posterior no texto importado muda o hash e volta ao portão. |
| `papel` | implícito no corpo | Inferido por leitura e **confirmado por humano**. `feature-dev` é `fazer`. Erro aqui é caro: uma skill de fazer registrada como portão vira um portão que não confere nada. |
| `descricao` | `description` do frontmatter | Único campo que costuma servir quase direto; revisado para descrever o que a skill faz, não como. |
| `entrada` | prosa ("Input: a refined ticket in `workflow/wip/`") | Derivada por leitura assistida e escrita como JSON Schema pelo revisor. Onde a prosa não diz, o revisor decide e registra — nunca se infere em silêncio. |
| `saida` | prosa ("Report: files created/modified, test counts, commit hash") | Idem. Para `papel: "portao"`, o revisor **tem** de incluir `resultado` com os três valores do enum, senão o executor não sabe rotear. |
| `pre_condicoes` | seções de escopo ("Scope — when this skill applies") | Extraídas dessas seções e reescritas como condições sobre o estado, verificáveis antes do despacho. |
| `checks` | quase nunca existe de forma tipada | O ponto mais crítico. Comandos citados no corpo (`make test`, `make lint`) viram checks determinísticos; o que restar de julgamento vira check agêntico **com** `evidencia_obrigatoria`. Se não der para escrever nenhum check, a skill não entra: princípio 6, sem verificação não há portão. |
| `permissoes` | nunca | **Nunca inferidas do texto.** Entram com o default seguro abaixo, e só são ampliadas por decisão humana registrada. |
| `instrucoes` | o corpo do SKILL.md | O corpo, **revisado como vetor de injeção**: remover referência a arquivo residente no repo alvo (o manifesto não depende de `CLAUDE.md`), a documento externo que a origem controla, e qualquer instrução que peça credencial, exfiltração ou execução de conteúdo baixado. Caminhos e comandos específicos da origem viram placeholders `{{entrada.<campo>}}` ou saem. |
| `origem` | a URL de onde veio | `tipo: "importada"` mais `repo`, `ref` (commit ou tag, não branch — branch se move), `importado_por`, `importado_em`, `revisado_por`. O schema torna os cinco obrigatórios quando o tipo é `importada`. |

### Default seguro de permissões para `origem.tipo: "importada"`

Toda skill importada nasce com:

```json
{
  "filesystem": { "leitura": ["**"], "escrita": [] },
  "rede": { "permitido": false }
}
```

Ler o workspace da sessão, não escrever nada, não falar com a rede. Ampliar
qualquer um dos três é decisão humana explícita, registrada no portão de
importação, e muda o hash — ou seja, reaparece na revisão da versão seguinte.
Em particular, `rede.permitido: true` **sem** lista de `dominios` é rejeitado
na importação: skill de terceiro com rede irrestrita e instruções que ninguém
escreveu é a definição do vetor de supply chain que D4 existe para fechar.

### O que o revisor humano assina

Que o `papel` está certo; que `entrada`/`saida` descrevem o que a skill de
fato consome e produz; que existe pelo menos um check e que o agêntico exige
evidência própria; que as `permissoes` são o mínimo necessário; e que as
`instrucoes` revisadas não carregam instrução hostil. Assinado, o manifesto
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

### O fixture negativo

`exemplos/manifesto-skill.invalido.fixture.json` **não** é um exemplo de
manifesto: é material de teste. Ele é um manifesto de portão em tudo o mais
válido, com **uma** violação proposital — o check `criterios-atendidos` tem
`tipo: "agentico"` e não declara `evidencia_obrigatoria`. Violação única e
isolada de propósito: o erro que o ajv emite aponta para a regra exata, em vez
de se perder num monte de campo faltando.

```
instancePath: '/checks/0'
schemaPath:   '#/$defs/check/allOf/1/then/required'
keyword:      'required'
params:       { missingProperty: 'evidencia_obrigatoria' }
```

É a regra que mais importa fechar: um check agêntico sem evidência obrigatória
é exatamente o portão que conclui pelo autorrelato de quem fez o trabalho.

## Limites conhecidos

O que o schema **não** garante, e por isso é verificado na entrada do registro
ou fica para outra ticket:

- **`entrada`/`saida` são JSON Schema de verdade.** O schema só exige que
  sejam objetos. Validar contra o meta-schema oficial é passo do registro.
- **`resultado` na saída de um portão.** A regra está documentada e os
  exemplos a cumprem, mas não é imposta estruturalmente — impô-la exigiria o
  schema do manifesto navegar dentro de um documento JSON Schema arbitrário.
- **O `hash` corresponder ao conteúdo.** O schema valida o formato
  (`sha256:` + 64 hex), não o valor. Recalcular e comparar é trabalho do
  registro, na importação e a cada leitura do manifesto pelo runner.
- **Permissão declarada ser permissão aplicada.** Enforcement é t125.
- **Interpolação.** A convenção `{{entrada.<caminho>}}` e a regra de falha
  fechada estão decididas aqui; o motor nasce com o control plane (t100+).
- **Detalhe de ferramenta:** o campo `origem.importado_em` usa `pattern` de
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
