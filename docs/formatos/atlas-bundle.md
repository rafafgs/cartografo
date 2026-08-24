# Atlas e bundle — especificação v0

> **Status:** v0 exercitada ponta a ponta contra os dois grafos de fábrica,
> **não congelada**. A regra dos dois consumidores
> (`notas/2026-08-14-extensao-e-qualidade.md:57-63`) exige dois consumidores
> reais antes de travar um formato, e hoje existe **um** atlas: o espelho deste
> próprio repositório. Enquanto o segundo não existir, o que está escrito aqui
> é convenção com portão automatizado, não contrato congelado.
>
> **Portões deste documento:**
> [`scripts/publish-atlas-bundle.test.mjs`](../../scripts/publish-atlas-bundle.test.mjs)
> (o passo de publicação: recusa, cópia, idempotência, atlas multi-classe) e
> [`packages/core/test/cli-atlas-publish.test.ts`](../../packages/core/test/cli-atlas-publish.test.ts)
> (a volta inteira: publicar → commitar → clonar → importar, com o mesmo
> `graph_version.id` e o mesmo pino por skill). Julgamento arquitetural é portão
> humano.

## Por que este documento existe

[`docs/spec/graph.md`](../spec/graph.md) §7 termina exatamente onde este
começa: "um grafo, um arquivo, autocontido". O documento de grafo já é o bundle
mínimo exportável — mas um grafo sozinho não roda, porque cada nó pina uma
skill por versão e por hash (D4), e o pino só fecha se o manifesto viajar
junto. O que falta especificar é o empacotamento de **vários grafos, cada um
com seus manifestos**, atravessando a borda para um repositório que não é este.

Esse empacotamento tem nome no projeto: a D14 chama a biblioteca de fábrica de
"semente do atlas compartilhável", e a nota de extensão
(`notas/2026-08-14-extensao-e-qualidade.md:50-56`) trata o atlas como o efeito
de rede do produto — a comunidade contribui **mapas**, não só código. O atlas é
a forma de arquivo desse compartilhamento.

## O layout

Um atlas é um diretório — na prática, um checkout git — com **um
subdiretório por classe de problema**:

```
atlas/
  desenvolvimento-de-software/
    grafo.json
    skills/
      desenvolver-ticket.json
      implantar-release.json
      integrar-branch.json
      refinar-ticket.json
      testar-alpha.json
  bets-assimetricas/
    grafo.json
    skills/
      analisar-assimetria.json
      ...
```

Três regras, e nada além delas:

1. **O nome do diretório é a `classe`** do documento de grafo, tal como está
   escrita no arquivo. Classe é a identidade do mapa (D8) e a raiz de
   versionamento; o diretório não acrescenta identidade nenhuma, só reflete a
   que já existe.
2. **Cada subdiretório é um bundle**, na forma que
   [`docs/spec/graph.md`](../spec/graph.md) e
   [`especificacoes/formatos/manifesto-skill.md`](../../especificacoes/formatos/manifesto-skill.md)
   já definem: um `grafo.json` e um `skills/` com um manifesto por arquivo,
   cujo nome é o `id` da skill.
3. **Não existe arquivo de índice, catálogo ou manifesto de atlas.** O
   diretório é o índice. Um índice seria um segundo lugar onde a verdade mora,
   e ele ficaria desatualizado exatamente quando importa — na contribuição de
   terceiro, que é o caso de uso inteiro do atlas.

É por isso que `grafos-de-fabrica/<classe>/` neste repositório e
`<atlas>/<classe>/` num checkout do atlas são **a mesma coisa**, e entradas
intercambiáveis do mesmo comando:

```sh
cartografo import grafos-de-fabrica/desenvolvimento-de-software   # daqui
cartografo import ../atlas/desenvolvimento-de-software            # do atlas
```

Um atlas pode carregar arquivos que não são bundle — `README.md`, licença,
workflow de CI. O importador nunca os lê; o publicador nunca os toca.

## Integridade: dois hashes que já existem

Este formato **não introduz hash novo**. A verificação ponta a ponta é feita
com os dois mecanismos que o sistema já tem, e é justamente por isso que ela é
verificável sem confiar em quem publicou:

| O quê | Onde mora | O que ele prova |
|---|---|---|
| `graph_version.id` | calculado no control plane, hash canônico do documento inteiro (`docs/spec/entities-versioning.md` §2) | que o mapa que entrou é byte a byte o mesmo que saiu — reimportar tem que reproduzir o mesmo id |
| `skill_ref.hash` de cada nó | dentro do `grafo.json`, pinando o conteúdo do manifesto (D4) | que o manifesto ao lado é o manifesto que o autor do grafo revisou |
| `hash` de cada manifesto | dentro do próprio `skills/*.json` | que o manifesto não foi editado sem passar pelo pino |

O procedimento do hash de manifesto é o da especificação do formato: `sha256`
do JSON canônico de `{instrucoes, entrada, saida, checks, permissoes}`. Mexeu
numa linha de `instrucoes`, afrouxou um check ou abriu uma permissão, o hash
muda, o pino do nó para de fechar e o bundle para de validar — que é
exatamente a mudança que a D4 quer trazer de volta ao portão humano.

A checagem acontece em três lugares independentes, e as duas primeiras rodam
**antes de qualquer rede**:

- [`scripts/validate-factory-bundle.mjs`](../../scripts/validate-factory-bundle.mjs)
  — o validador de referência, sem servidor nenhum, no `npm test`. É ele que o
  passo de publicação usa, e é o critério de aceite do bundle como artefato de
  repositório;
- `cartografo import` — refaz as três checagens localmente e aborta sem mandar
  nada ao control plane se alguma falhar. A checagem de manifesto aqui cobre o
  subconjunto de regras de schema de que o pino depende, não o schema inteiro:
  `especificacoes/` está fora da árvore publicável do pacote, e conformidade
  completa continua sendo trabalho do validador de referência;
- o registro de skills do control plane — recalcula o hash por conta própria e
  recusa manifesto adulterado, porque quem verifica não pode acreditar no
  autorrelato de quem publicou.

**A volta que fecha a prova.** Publicar os dois grafos de fábrica num
repositório git, commitar, clonar num diretório limpo e importar o clone
produz o **mesmo `graph_version.id`** e o **mesmo hash por skill** que importar
`grafos-de-fabrica/<classe>/` direto daqui. É o que
[`packages/core/test/cli-atlas-publish.test.ts`](../../packages/core/test/cli-atlas-publish.test.ts)
roda a cada `npm test`; se a travessia mudasse um byte, o hash mudaria junto e
o teste ficaria vermelho.

## Publicar

```sh
node scripts/publish-atlas-bundle.mjs <bundle-dir> <atlas-dir>
```

O que o comando faz, na ordem:

1. **Valida o bundle inteiro** com o `validateBundle` do validador de
   referência — o mesmo código do `npm test`, importado e não reimplementado.
2. **Recusa inteiro.** Bundle que não valida sai com código não-zero e escreve
   **zero arquivo** no atlas. Meio mapa publicado com um pino quebrado é pior
   que mapa nenhum: quem importa não tem como saber que aquilo está pela
   metade.
3. **Copia** `grafo.json` e tudo que está sob `skills/` para
   `<atlas-dir>/<classe>/`, criando o diretório se preciso.
4. **Revalida a cópia** no destino. O que sai deste script é um bundle que
   valida a partir do novo lugar, ou o script falha.

Três propriedades que valem contrato:

- **Idempotente.** Republicar bundle inalterado reescreve os mesmos bytes.
- **Aditivo entre classes.** Publicar duas classes no mesmo atlas deixa os dois
  subdiretórios intactos; nenhuma classe enxerga ou apaga a outra.
- **Espelho dentro da classe.** Um `skills/*.json` que o bundle não carrega
  mais é removido do destino, e o arquivo removido é nomeado na saída. Sem
  isso, uma skill renomeada deixaria o manifesto velho no atlas para o próximo
  `cartografo import` registrar — o único caso em que copiar por cima
  silenciosamente cria conteúdo que ninguém escreveu. Nada fora de
  `<atlas-dir>/<classe>/` é tocado.

**O comando não chama `git`.** Commitar e empurrar o checkout populado é
trabalho de quem chamou — CI ou uma pessoa. Isso é a D15 aplicada ao pé da
letra: git entra nas bordas, como formato de intercâmbio, e nunca vira
dependência de nada aqui dentro. O script é operação de sistema de arquivos
pura, sem rede e sem repositório.

Pela mesma razão publicar **não é** subcomando do `cartografo`: todo subcomando
da CLI é cliente HTTP do control plane (D1, D11), e este passo não fala com API
nenhuma. Ele fica em `scripts/`, ao lado dos outros validadores.

## Importar

```sh
cartografo import <atlas>/<classe>
```

O importador lê `<classe>/grafo.json`, e — se existir um `skills/` irmão —
verifica o bundle inteiro **antes** de qualquer requisição; depois registra os
manifestos (`POST /v1/skills`, cada um revalidado pelo servidor) e só então
manda o grafo (`POST /v1/graphs`). Manifesto que o registro recusa aborta a
importação, e o grafo não sobe.

## A fronteira D4 que este documento não atravessa

O caminho acima registra os manifestos do bundle **automaticamente**, e isso é
deliberado para o conteúdo que este repositório escreveu: bundle de fábrica é
conteúdo in-repo, revisado em code review, e pedir a um humano que reaprove
cinco manifestos que ele já aprovou no merge não compra segurança nenhuma —
compra registro vazio e grafo cujos nós pinam capacidade que o sintetizador não
encontra.

**Isso não vale para bundle de terceiro.** A D4 existe contra exatamente esse
caso: instrução de skill que ninguém aqui escreveu é vetor de prompt injection,
e o portão dela é `cartografo scan-skill` → `propose-skill` → `register-skill`,
com assinatura humana no meio. Um atlas comunitário é, por definição, conteúdo
externo.

O que está construído hoje, e o que não está:

| Origem do bundle | Caminho | Estado |
|---|---|---|
| Deste repositório (grafos de fábrica), espelhado num atlas próprio | `cartografo import` registra os manifestos direto | **construído** e coberto pelos testes acima |
| De um contribuidor externo | tem que passar pelo portão de aprovação humana da D4 | **não construído** — lacuna nomeada, não silenciosa |

A ticket que fecha a segunda linha fica para quando existir um segundo
contribuidor real de atlas — a mesma regra dos dois consumidores que mantém
este documento em v0. Até lá, importar bundle de terceiro pelo caminho rápido é
uso fora de especificação: a verificação de hash prova que o conteúdo **não
mudou desde que foi publicado**, e não que ele é confiável.

## Fora de escopo (v0)

- **Assinatura criptográfica** de bundle ou do atlas. Os hashes acima provam
  integridade na travessia; provar *autoria* é outro problema, e ele só começa
  a valer a pena quando o atlas tiver contribuidor que não seja este repo.
- **Índice, catálogo ou manifesto de atlas** — ver a regra 3 do layout.
- **`cartografo export` em modo bundle completo** (`grafo.json` + `skills/`)
  para grafos que só existem no banco (variantes, classes não-fábrica). Hoje
  `export` escreve o documento de grafo, que é o bundle mínimo; os dois mapas
  de fábrica já existem como arquivos.
- **Repositório público de atlas.** A D7 mantém este repo privado até
  funcionar; a prova da volta usa um repositório git local como dublê.
- **Versão do formato dentro do arquivo.** O documento de grafo já carrega a
  sua em `metadata.versao_schema`, e o atlas não tem arquivo próprio onde pôr
  uma — nem vai ter, enquanto a regra 3 do layout valer.
