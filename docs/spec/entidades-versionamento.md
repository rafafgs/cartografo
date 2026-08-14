# Especificação: entidades de versionamento e API

**Versão da API:** `v1` · **Migração:** [`packages/core/migrations/0002_grafo_versao_proposta.sql`](../../packages/core/migrations/0002_grafo_versao_proposta.sql)
**Decisão de origem:** [D15](../../DECISOES.md) — "versionamento de grafos: no banco, com as ideias do git"

O grafo é dado (D15), e [`docs/spec/grafo.md`](grafo.md) especifica o formato
desse dado. Este documento especifica onde ele **mora** e como ele **anda**: as
três tabelas que guardam linhagem, snapshot e hipótese; o procedimento que dá
identidade a uma versão; o vocabulário de diff semântico; e a API que expõe
tudo isso.

A ideia toda cabe em uma frase: versionamos como o git pensa, sem git no
núcleo. Uma versão é endereçada pelo hash do próprio conteúdo, aponta para o
pai, e nunca é reescrita; o que muda é um ponteiro. Rollback move o ponteiro de
volta e não apaga nada — é o que deixa o topógrafo (`t110`) cruzar depois
"versão × telemetria" por join, inclusive nas versões que foram abandonadas.

---

## 1. As três entidades

| Entidade | O que é | Muda? |
|---|---|---|
| `grafo` | A **linhagem**: a classe, o tipo de linhagem (base ou variante) e o ponteiro para a versão que vale hoje. | Só o ponteiro. |
| `grafo_versao` | Um **snapshot** imutável do documento inteiro, endereçado pelo hash do conteúdo, com ponteiro para o pai. | Nunca. |
| `proposta` | Uma **hipótese**: versão-alvo, diff semântico com inversas, evidência que a motivou e métrica que ela espera mover. | Só o status e o resultado. |

`classe` é coluna de `grafo`, não tabela própria: a D8 fixa a classe como
identidade nomeada pelo usuário e **raiz de versionamento**, e a D13 descreve
classe e variante como atributos do grafo, não como entidade com ciclo de vida
próprio. Por isso a linhagem base de uma classe nasce com `id = classe`. Se um
dia existir classe navegável sem grafo (t118), extrair a tabela é aditivo.

```sql
CREATE TABLE grafo (
  id                  TEXT PRIMARY KEY,          -- classe, para a linhagem base (D8)
  classe              TEXT NOT NULL,
  linhagem_tipo       TEXT NOT NULL CHECK (linhagem_tipo IN ('base', 'variante')),
  base_classe         TEXT,                      -- só variante (D13)
  origem_proposta_id  INTEGER REFERENCES proposta(id),
  versao_corrente_id  TEXT REFERENCES grafo_versao(id),
  criado_em           TEXT NOT NULL,
  CHECK (
    (linhagem_tipo = 'base' AND base_classe IS NULL)
    OR (linhagem_tipo = 'variante' AND base_classe IS NOT NULL)
  )
);

CREATE UNIQUE INDEX grafo_classe_base_unico ON grafo (classe) WHERE linhagem_tipo = 'base';

CREATE TABLE grafo_versao (
  id          TEXT PRIMARY KEY,        -- sha256:<64 hex> do snapshot canônico (§2)
  grafo_id    TEXT NOT NULL REFERENCES grafo(id),
  versao_pai  TEXT REFERENCES grafo_versao(id),
  snapshot    TEXT NOT NULL,           -- documento de grafo completo, canonicalizado
  origem      TEXT NOT NULL CHECK (origem IN ('manual', 'sintetizador', 'proposta')),
  proposta_id INTEGER REFERENCES proposta(id),
  criado_em   TEXT NOT NULL
);

CREATE TABLE proposta (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  grafo_id            TEXT NOT NULL REFERENCES grafo(id),
  versao_alvo         TEXT NOT NULL REFERENCES grafo_versao(id),
  operacoes           TEXT NOT NULL,   -- JSON: Operacao[] (§3)
  evidencia           TEXT NOT NULL,   -- JSON
  metrica_esperada    TEXT NOT NULL,   -- JSON
  status              TEXT NOT NULL DEFAULT 'pendente'
                        CHECK (status IN ('pendente', 'aplicada', 'revertida', 'rejeitada')),
  versao_aplicada_id  TEXT REFERENCES grafo_versao(id),
  motivo_reversao     TEXT,
  resultado           TEXT,            -- JSON
  criado_em           TEXT NOT NULL,
  atualizado_em       TEXT NOT NULL
);
```

Notas de leitura:

- **`versao_corrente_id` é o único campo que responde "o que vale hoje".** Não
  há flag `ativa` em `grafo_versao`: duas fontes para o mesmo fato divergem.
- **`origem` distingue quem produziu o snapshot** — `manual` (importado ou
  escrito à mão), `sintetizador` (D10) ou `proposta` (topógrafo). Na PoC só
  `manual` e `proposta` acontecem; o valor existe porque origem é fato do dado,
  não da fase.
- **Os nomes de coluna copiam literalmente os schemas de evento** já
  especificados em
  [`especificacoes/eventos/schemas/`](../../especificacoes/eventos/schemas)
  (`grafo_id`, `versao_pai`, `origem`, `proposta_id`, `motivo`). Nenhuma rota
  desta camada emite evento — a tabela append-only de eventos é do `t102` — mas
  quando ela existir, a emissão será mapeamento direto, não tradução.
- **Nada se apaga.** Não existe `DELETE` nem `UPDATE` de `grafo_versao` em
  nenhum caminho de código. O único `UPDATE` de `grafo` é o do ponteiro.

---

## 2. Identidade de uma versão: o hash do snapshot

`grafo_versao.id` é `sha256:` seguido do sha256 da serialização JSON **canônica**
(chaves ordenadas recursivamente, a parte da RFC 8785 que estes formatos usam)
do documento de grafo **inteiro**.

```
id = "sha256:" + sha256( JSON.stringify( canonicalizar( documento ) ) )
```

Duas consequências deliberadas:

1. **Cobre o documento inteiro**, ao contrário do hash de manifesto de skill
   ([`manifesto-skill.md`](../../especificacoes/formatos/manifesto-skill.md)),
   que cobre só `{instrucoes, entrada, saida, checks, permissoes}`. Lá metadado
   de catálogo não pode invalidar o pino; aqui vale o oposto — o snapshot de uma
   versão **é** o documento inteiro ([`grafo.md` §7](grafo.md)), e mudar a
   descrição do grafo é uma versão nova.
2. **Reordenar chave não é mudança.** A ordem das chaves e a formatação do JSON
   não carregam significado no documento de grafo; dois arquivos que só diferem
   nisso têm o mesmo hash e são a mesma versão.

Como o hash É a identidade, um resultado idêntico a uma versão que já existe na
linhagem não é uma versão nova: é proposta sem efeito, e a aplicação a recusa
(§5).

Implementação: [`packages/core/src/dominio/hash.ts`](../../packages/core/src/dominio/hash.ts)
(mesma função `canonicalizar` de `scripts/validar-bundle-fabrica.mjs`).

---

## 3. Vocabulário de operações semânticas

Uma proposta carrega um **diff semântico**, não um diff de linha (D15): lista de
operações tipadas, cada uma com a própria inversa. É o que torna a proposta
julgável ("acrescenta um portão de red team antes de implantar") em vez de
legível apenas como patch, e o que dá caminho de volta a qualquer mudança.

| Tipo | Campos | Inversa |
|---|---|---|
| `adicionar_no` | `no` (documento do nó) | `remover_no` do mesmo `id` |
| `remover_no` | `no_id` | `adicionar_no` do mesmo nó |
| `adicionar_aresta` | `aresta` (`de`, `para`, `condicao`) | `remover_aresta` das mesmas pontas |
| `remover_aresta` | `aresta` (`de`, `para`) | `adicionar_aresta` da mesma aresta |
| `alterar_campo_no` | `no_id`, `campo`, `de`, `para` | `alterar_campo_no` com `de`/`para` trocados |

`alterar_campo_no` troca `papel`, `descricao`, `skill_ref` ou `contrato`
inteiro. `id` e `tipo_no` **não** são campos alteráveis: o id é a chave por onde
arestas, telemetria e propostas se referem ao nó, e trocá-lo é operação
semântica própria, não rename cosmético.

```json
{
  "tipo": "adicionar_aresta",
  "aresta": { "de": "testar", "para": "red_team", "condicao": "aprovado" },
  "inversa": { "tipo": "remover_aresta", "aresta": { "de": "testar", "para": "red_team" } }
}
```

Duas fronteiras:

- **Validar operação é estrutural.** `validarOperacao` confere chaves, tipos e a
  compatibilidade da inversa (tipo pareado e **mesmo alvo** — inversa de outro
  nó não é inversa). Ela não impede a operação de produzir um grafo quebrado:
  quem reprova isso é o portão de soundness, depois de aplicar. Uma aresta com
  `condicao: ""` é operação bem formada **e** grafo não sound; os dois
  julgamentos são de camadas diferentes, e é isso que faz o erro chegar ao
  cliente com o nome da regra em vez de um 400 genérico.
- **Aplicar recusa alvo inexistente.** Remover um nó que não está no snapshot
  estoura em vez de virar no-op silencioso: a proposta está falando de outra
  versão do grafo, e gravar "aplicou, nada mudou" seria uma versão mentindo
  sobre o que aconteceu.

Cinco operações são o mínimo que prova o ciclo aplicar/soundness/reverter — não
o vocabulário final do topógrafo. Crescer é aditivo, e a regra dos dois
consumidores diz para esperar um segundo consumidor real (`t110`) antes de
congelar.

Implementação: [`packages/core/src/dominio/operacoes.ts`](../../packages/core/src/dominio/operacoes.ts).

---

## 4. O portão de validação

Todo documento que entra no banco — registrado direto ou produzido por proposta
— passa pelo mesmo par de checagens, que é o porte TypeScript do validador de
referência do `t96` ([`grafo.md` §6](grafo.md)):

- `validarEstrutura` — forma e integridade referencial (`{valido, erros}`);
- `validarSoundness` — as quatro regras de workflow net, na ordem `alcançável`,
  `termina`, `aresta_com_condicao`, `no_com_contrato` (`{valido, violacoes}`).

O relatório devolvido no `422` é exatamente o de
[`scripts/validar-grafo.mjs`](../../scripts/validar-grafo.mjs) — mesmos códigos,
mesmos alvos, mesma ordem. A paridade entre os dois validadores é travada por
teste sobre todos os fixtures de `schema/exemplos/`
([`test/dominio-grafo.test.ts`](../../packages/core/test/dominio-grafo.test.ts)):
o script vive fora da árvore publicável do pacote, então a duplicação é
deliberada — e vigiada.

Não há schema Fastify/ajv declarado contra
[`schema/grafo.schema.json`](../../schema/grafo.schema.json): o schema é draft
2020-12 e o ajv que vem no Fastify v5 está configurado para draft-07.
Reconfigurar o compilador é possível e fica para quando alguém precisar da
validação de forma completa na borda HTTP.

Implementação: [`packages/core/src/dominio/grafo.ts`](../../packages/core/src/dominio/grafo.ts).

---

## 5. Os fluxos que mexem no ponteiro — e o que fecha a hipótese

### Registrar uma linhagem nova

`POST /v1/grafos` recebe o documento cru e faz, em uma transação: valida →
cria `grafo` → cria `grafo_versao` (`versao_pai: null`, `origem: "manual"`) →
aponta `versao_corrente_id` para ela.

Registrar **não** move o ponteiro
([`taxonomia.md`](../../especificacoes/eventos/taxonomia.md)) — exceto aqui, no
bootstrap de uma linhagem nova, porque não existe "corrente" anterior a
preservar e uma linhagem sem ponteiro seria um grafo que existe sem valer.

### Bifurcar uma linhagem

`POST /v1/grafos/:id/fork` cria a **variante** de um base (D13) e é o segundo —
e último — bootstrap desta camada, com a mesma exceção de ponteiro do fluxo
acima:

```
conferir que :id existe e é linhagem base
        ↓
montar o documento: snapshot CORRENTE do base, só trocando linhagem
        ↓ (hash já existente em qualquer linhagem: 409, nada é escrito)
gravar grafo (linhagem_tipo = variante, classe e base_classe = classe do base)
        ↓
gravar grafo_versao (versao_pai = versão corrente do base)
        ↓
mover versao_corrente_id da variante
```

Semântica de branch: bifurcar **não carrega diff nenhum**. Um `git branch` não
muda conteúdo — cria ponteiro e parentesco, e a variante e o base andam
separados depois, pelo fluxo de proposta comum, que não precisa de caso
especial para variante.

Duas consequências que o desenho assume de propósito:

- **O parentesco atravessa a linhagem.** `versao_pai` da primeira versão da
  variante é a versão corrente do **base**. O schema permite: `versao_pai` só
  referencia `grafo_versao(id)`, sem exigir o mesmo `grafo_id`. É esse ponteiro
  que vai ancorar o diff entre linhagens quando promoção e oferta existirem.
- **O hash é global, não escopado por linhagem.** Duas bifurcações do mesmo base
  com a mesma origem (ou ambas sem origem) produziriam o mesmo documento, e
  `grafo_versao.grafo_id` é coluna única — uma linha não pode pertencer a duas
  linhagens ao mesmo tempo. A segunda é recusada com `409
  bifurcacao_sem_efeito`, antes de qualquer escrita.

O corpo pede `id` (a identidade da linhagem que nasce; a `classe` é herdada do
base) e aceita `origem_proposta_id` opcional. Ele é conferido **só por
existência**, em qualquer status: o topógrafo ainda não sabe propor um fork.
Quando presente, a versão nasce com `origem: "proposta"`; ausente, com
`origem: "manual"` — o mesmo tratamento que o bootstrap do base já dá a uma
versão sem proposta por trás.

O tipo do campo diverge de propósito entre banco e documento:
`grafo.origem_proposta_id` é `INTEGER REFERENCES proposta(id)`, e
`linhagem.origem_proposta_id` é `string` no
[`grafo.schema.json`](../../schema/grafo.schema.json) — pensado para acomodar
id de fora, como o de um atlas importado. O inteiro fica no banco e vira
`String(id)` no documento. Sem `origem_proposta_id`, a chave é **omitida** do
documento, nunca `null`, como o `base` já faz com os dois campos que o schema
lhe proíbe.

### Aplicar uma proposta

`POST /v1/propostas/:id/aplicar` é o fluxo da D15 inteiro, e a ordem não é
negociável:

```
aplicar operações sobre uma CÓPIA do snapshot-alvo
        ↓
validar estrutura + soundness NO RESULTADO
        ↓ (reprovado: status = rejeitada, relatório em resultado, 422)
calcular o hash do documento resultante
        ↓
gravar grafo_versao (versao_pai = versao_alvo, origem = proposta)
        ↓
mover grafo.versao_corrente_id
        ↓
status = aplicada, versao_aplicada_id = hash
```

O portão roda sobre o documento que **sairia**, não sobre o que entrou: é a
composição das operações que quebra o grafo — cada uma isolada pode ser
impecável. Reprovada, nada entra no banco além do status e do relatório: a
versão nova nunca chega a existir.

Rejeição não apaga a proposta. Uma hipótese reprovada é evidência para o
topógrafo, não lixo.

### Reverter

`POST /v1/propostas/:id/reverter` move `versao_corrente_id` de volta para
`versao_alvo` e grava `motivo_reversao`. A versão abandonada continua em
`grafo_versao` e continua listada no histórico — append-only não tem exceção.

`motivo` é **obrigatório**, espelhando `dados.motivo` do evento
[`grafo_versao.revertida`](../../especificacoes/eventos/schemas/grafo_versao.revertida.schema.json):
é a evidência que o topógrafo vai cruzar com a telemetria da versão abandonada.
Reverter sem dizer por quê perde a metade útil do fato.

### Fechar o experimento

Proposta é hipótese, aprovação é experimento, a telemetria da rodada seguinte é
o resultado ([`notas/2026-08-14-aprendizado.md`](../../notas/2026-08-14-aprendizado.md)).
`POST /v1/propostas/:id/resultado` é onde esse ciclo fecha: recebe
`{execucao_id, depois}` e grava o veredito da hipótese em `proposta.resultado`.

Duas formas até então opacas ficam exigidas **aqui, e só aqui**:

```jsonc
// proposta.metrica_esperada — o que a hipótese declarou que ia mover
{ "nome": "retrabalho_por_travessia", "direcao": "cai", "de": 0.4, "para": 0.1 }

// proposta.resultado — o veredito, escrito uma única vez
{ "veredito": "piorou", "antes": 0.4, "depois": 0.9,
  "execucao_id": 7, "avaliado_em": "2026-08-14T18:20:31.004Z" }
```

`POST /v1/propostas` **continua sem validar** `metrica_esperada`: mudar um
endpoint já publicado é outra ticket, e uma proposta antiga com métrica
incompleta simplesmente não tem veredito a calcular (`422`).

A regra do veredito, sem faixa de tolerância — comparação numérica estrita:

| Movimento de `depois` em relação a `de` | Veredito |
|---|---|
| Igual | `sem_efeito` |
| Na direção declarada (`cai` → menor; `sobe` → maior) | `confirmada` |
| Na direção oposta | `piorou` |

A linha de base é `de`, nunca `para`: `para` é a meta que a proposta esperava, e
julgar contra ela transformaria "andou para o lado certo, menos do que se
esperava" em fracasso.

Três garantias em volta do cálculo:

- **`depois` é de quem chama.** Não existe motor de métricas nomeadas na v1;
  quem calcula é o topógrafo (`t110`), que já precisou calcular a mesma métrica
  para escrever `metrica_esperada` na criação da proposta.
- **A execução seguinte é demonstrada, não alegada.** `execucao_id` é conferido
  contra `metricasPorVersao` (`t102`, FR17): sem ao menos um `trabalho` daquela
  execução registrado sob `versao_aplicada_id`, é `422 execucao_sem_evidencia`.
  É o join que prova que a versão aplicada realmente rodou.
- **Só a primeira chamada conta.** Com `resultado` já preenchido, a rota é
  `409 proposta_ja_avaliada` e nada muda. Reavaliar seria reescrever o passado
  de uma hipótese.

Fechar o experimento **não muda o status**: uma proposta que piorou continua
`aplicada`, e esta rota nunca chama a reversão. "Piorou" é dado, não ação — a
escada de segurança da evolução (README, princípio 5) manda sugerir e passar
por portão humano, não reverter sozinho. A fila dessas sugestões é uma leitura
filtrada, `GET /v1/propostas?status=aplicada&veredito=piorou`, e nada além
disso: notificação ativa, se um dia existir, é decisão de outra ticket.

### Estados da proposta

```
                 aplicar (portão reprova)
   pendente ──────────────────────────────▶ rejeitada
      │
      │ aplicar (portão aprova)
      ▼
   aplicada ──────────────────────────────▶ revertida
                 reverter (com motivo)
```

`aprovada`/`rejeitada` como ação humana explícita é do inbox (`t111`); nesta
camada o único caminho para `rejeitada` é o portão reprovar.

O veredito é ortogonal a este diagrama: ele escreve `resultado` e deixa o estado
onde estava. `resultado` acumula dois usos que nunca coexistem — o relatório que
reprovou uma proposta `rejeitada`, ou o veredito da hipótese de uma proposta que
chegou a ser `aplicada`.

---

## 6. Endpoints

Todos sob `/v1`. Nenhum exige autenticação (`t124`) e nenhum emite evento de
telemetria (`t102`).

Os caminhos abaixo estão na grafia em português deste documento; a superfície
implementada foi renomeada para inglês pelo `t127` (D18), e é ela que vale:
`/v1/graphs`, `/v1/graphs/:id/fork`, `/v1/graph-versions/:id`, `/v1/proposals`,
`/v1/proposals/:id/apply` etc. Reescrever a tabela inteira é outra ticket.

| Método | Rota | O que faz |
|---|---|---|
| `POST` | `/v1/grafos` | Registra uma linhagem **base** nova a partir do documento completo (corpo cru, sem envelope). |
| `POST` | `/v1/grafos/:id/fork` | Bifurca um base em uma **variante** (§5). Corpo: `{id, origem_proposta_id?}`. |
| `GET` | `/v1/classes` | Catálogo de classes registradas. |
| `GET` | `/v1/grafos` | Todas as linhagens. |
| `GET` | `/v1/grafos/:id` | Uma linhagem, com o ponteiro de versão corrente. |
| `GET` | `/v1/grafos/:id/versoes` | A cadeia inteira de versões, inclusive as abandonadas por reversão. |
| `GET` | `/v1/grafo-versoes/:id` | Uma versão, com o `snapshot` completo. |
| `POST` | `/v1/propostas` | Cria uma proposta pendente. |
| `GET` | `/v1/propostas` | Lista as propostas em ordem de `id`; filtros opcionais `status` e `veredito`. |
| `POST` | `/v1/propostas/:id/aplicar` | Executa o fluxo do §5. |
| `POST` | `/v1/propostas/:id/reverter` | Move o ponteiro de volta; exige `motivo`. |
| `POST` | `/v1/propostas/:id/resultado` | Fecha o experimento: grava o veredito da hipótese. Não muda o status. |

Códigos de erro, por rota:

| Situação | Código | `erro` |
|---|---|---|
| Documento reprovado no portão | `422` | `grafo_invalido` (com `estrutura` e `soundness`) |
| `linhagem.tipo` ≠ `base` em `POST /v1/grafos` | `400` | `linhagem_nao_base` |
| Classe já tem grafo base | `409` | `classe_ja_registrada` |
| Bifurcar o que não é linhagem `base` | `400` | `base_invalida` |
| `id` da variante ausente ou vazio | `400` | `campo_obrigatorio_ausente` |
| `id` da variante já é uma linhagem | `409` | `id_ja_registrado` |
| `origem_proposta_id` não é inteiro positivo | `400` | `origem_proposta_id_invalido` |
| `origem_proposta_id` sem proposta correspondente | `400` | `origem_proposta_desconhecida` |
| Base sem `versao_corrente_id` (invariante defensivo) | `409` | `grafo_sem_versao_corrente` |
| Bifurcação que produz um snapshot já existente | `409` | `bifurcacao_sem_efeito` |
| `versao_alvo` inexistente ou de outro grafo | `400` | `versao_alvo_desconhecida` |
| Operação de tipo desconhecido, sem inversa ou malformada | `400` | `operacoes_invalidas` |
| Aplicar/reverter proposta em estado errado | `409` | `proposta_nao_pendente` / `proposta_nao_aplicada` |
| A base mudou debaixo da proposta | `409` | `proposta_desatualizada` |
| Operação não se aplica ao snapshot | `422` | `operacao_inaplicavel` |
| Resultado idêntico a uma versão existente | `422` | `versao_sem_efeito` |
| Reverter sem motivo | `400` | `motivo_obrigatorio` |
| `evidencia` ou `metrica_esperada` ausente; `execucao_id`/`depois` ausente ou não numérico | `400` | `campo_obrigatorio_ausente` |
| Resultado já gravado por uma execução anterior | `409` | `proposta_ja_avaliada` |
| `metrica_esperada` sem a forma `{nome, direcao, de, para}` | `422` | `metrica_esperada_invalida` |
| Nenhum trabalho da execução rodou sob `versao_aplicada_id` | `422` | `execucao_sem_evidencia` |
| Recurso inexistente | `404` | `grafo_desconhecido` / `grafo_versao_desconhecida` / `proposta_desconhecida` |

O corpo de erro sempre traz `erro` — código estável, legível por máquina — e,
quando há o que explicar, uma `mensagem` para gente. Em `grafo_invalido` vem
junto o relatório inteiro do §4 (`estrutura` e `soundness`), que é o que permite
apontar a regra e o alvo em vez de dizer só "inválido".

Implementação: [`routes/grafos.ts`](../../packages/core/src/routes/grafos.ts),
[`routes/propostas.ts`](../../packages/core/src/routes/propostas.ts),
[`dominio/hypothesis.ts`](../../packages/core/src/dominio/hypothesis.ts) (o
veredito, puro) e [`repositorios/`](../../packages/core/src/repositorios). Só
`src/db/` toca o driver do SQLite (D1); repositórios e rotas recebem o banco já
aberto.

---

## 7. O que esta camada ainda não faz

Cada item aqui é escopo declarado de outra ticket, não esquecimento:

- **Variantes** (D13) — **promover** o diff da variante para o base e
  **oferecer** melhoria do base às variantes. Criar já existe:
  `POST /v1/grafos/:id/fork` (§5); `POST /v1/grafos` continua recusando
  `linhagem.tipo: "variante"` com `400`, porque variante nasce de fork, não de
  registro. As duas pendentes dependem de um motor de diff semântico entre dois
  documentos completos (o par inverso de `applyOperations`), que ainda não
  existe.
- **Executar a inversa** de uma operação — aqui só a forma é validada (`t118`).
- **Registrar versão manual nova sobre linhagem existente**, fora do fluxo de
  proposta.
- **Reverter para versão arbitrária**, fora do par `versao_alvo` /
  `versao_aplicada_id` de uma proposta.
- **Aprovação/rejeição humana** como ação de API (`t111`).
- **Cálculo automático de `depois`** a partir da telemetria, e disparo do
  veredito "quando a execução termina": não existe motor de métricas nomeadas
  nem entidade/evento de execução finalizada na v1
  ([`routes/execucoes.ts`](../../packages/core/src/routes/execucoes.ts)).
  Fechar o experimento é sempre chamada explícita de API (§5).
- **Emissão de eventos** `grafo_versao.registrada/.aplicada/.revertida` — o
  `t102` traz a tabela `evento`.
- **Autenticação** (`t124`).
