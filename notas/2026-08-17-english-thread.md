# O fio também fala inglês, do banco ao papel (D20, t213)

**Quando:** 16–17/08/2026 · **Decisão:** [D20](../DECISIONS.md) ·
**Guarda-chuva:** t213, dividido em sete filhos por superfície ·
**Dado migrado:** nenhum, de propósito.

A D18 já tinha levado o CÓDIGO para o inglês. O que sobrou em português foi o
que viaja: as chaves do JSON, os nomes de evento, as operações de proposta, as
tabelas e colunas do banco, as rotas da tela, as flags de CLI e o relatório de
validação. A D20 decidiu migrar isso também, **antes de o repositório abrir**
(D7) — porque um projeto público com dois vocabulários ensina os dois — e antes
das fichas que mexeriam nessas superfícies, para não fazer o trabalho duas
vezes.

Esta nota fecha a série.

## O que virou, e quem levou

| Superfície | O que mudou | Ficha |
|---|---|---|
| Glossário | O mapa único, `docs/spec/glossario-wire.md`: uma linha por termo, com o arquivo onde ele mora hoje | t213 |
| API e erros | Campos e parâmetros de query do JSON, os dois envelopes de erro convergidos, códigos de recusa | t226 |
| Eventos | Nomes de tipo, chaves de envelope, tipos de entidade e de ator, chaves de `data`, e os schemas de `especificacoes/eventos/schemas/` renomeados junto | t227 |
| Operações de proposta | `add_node`, `remove_edge`, `change_node_field` e as chaves que elas carregam | t228 |
| Banco (nomes) | Tabelas, colunas e índices | t229 |
| Rotas, flags e relatório | Rotas da tela (`/board`, `/input-requests`…), `--class`/`--out`, e as chaves do relatório de validação nas DUAS implementações | t230 |
| Banco (valores) | Os VALORES guardados nas colunas — `status`, `entity_type`, `role`… — e, junto, as dezoito migrações reescritas | t235 |
| Especificações (banco) | As citações de esquema das especificações, conferidas contra um banco de verdade | t236, t237 |
| Especificações (fio) e portão | As citações de evento, rota e flag; os links de schema quebrados; e o portão que impede a volta | t231 |

## O que ficou de fora, sabendo

- **A prosa.** `DECISIONS.md`, `notas/`, `docs/` e as mensagens de commit
  continuam em português (D18). A D20 mudou o que VIAJA, não o que se lê.
- **O `avaliar` do `topografo-custo`** e as opções `--tier-*` dele: a t230 os
  deixou de fora por decisão própria, e nenhuma ficha desta série os reabriu.
- **`grafos-de-fabrica/` como nome de diretório** e `<classe>` como marcador de
  caminho no `atlas-bundle.md`: a D20 nunca declarou nome de diretório do
  repositório como superfície de fio.
- **Quatro colunas de `job` e de `session`** que a §4.2 do glossário não
  registra (`corpo`, `criterios_de_aceite`, `transcricao_truncada`,
  `transcricao_tamanho_original`). Fechar o buraco é acrescentar linha lá, e é
  trabalho de ficha própria.

## Não existe migração de renomeação, e isso é a decisão

O log é append-only e uma proposta guardada é o registro do que alguém propôs:
renomear um tipo de evento gravado seria reescrever histórico, e uma linha
antiga não passaria pelo `CHECK` novo de qualquer forma. Como não há dado de
produção, a D20 respondeu **recriando** o banco de desenvolvimento em vez de
migrá-lo.

Por isso a t235 não empilhou uma décima-nona migração que renomeasse: ela
reescreveu `0001`–`0018` no lugar, e o esquema **nasce em inglês**. Um banco
anterior à t235 não é atualizado por elas — não há o que rodar. O passo de
atualização é uma linha, e está no `README.md`:

```bash
rm -rf .cartografo/
npx cartografo
```

## O portão que impede a volta

Cada superfície ganhou o seu, e nenhum deles declara vocabulário: todos leem o
glossário em tempo de execução, de modo que uma linha acrescentada lá vira
termo conferido na execução seguinte.

- `packages/core/test/no-portuguese-wire.test.ts` (e as portas dele em
  `runner`, `tela` e `topografo-custo`) — as rotas, as flags, o relatório e o
  JSON de `/v1`.
- `event-validation.test.ts` e `domain-operations.test.ts` — o catálogo de
  eventos e os nomes de operação, que recusam também as grafias antigas.
- `no-portuguese-database.test.ts` e `migrate.test.ts` — o esquema e as
  consultas.
- `spec-database-citations.test.ts` — as citações de esquema das
  especificações, resolvidas contra um banco que as migrações realmente
  constroem.
- `glossario-wire-docs.test.ts` (t231) — as citações de evento, de rota e de
  flag das especificações, e os links para `especificacoes/eventos/schemas/`.

O último é o único que lê Markdown, e a regra dele é estreita de propósito: só
o que está **dentro de crase ou de bloco cercado** é lido. A prosa em volta é
portuguesa por decisão, e um portão que não soubesse distinguir "a pergunta que
bloqueia o trabalho" de uma citação teria de ser desligado para ser usável.

## O que a série ensinou

**Glossário primeiro não foi burocracia.** Sem ele, seis fichas teriam
inventado cinco inglêses para o mesmo termo — e o repositório abriria com dois
vocabulários em vez de um. O glossário reusa o nome que o código já expunha
sempre que existia um (`/v1/jobs` fez `trabalho` virar `job`, e não `task`),
que é como uma tradução deixa de ser opinião.

**Um documento que descreve o próprio estado erra sozinho.** A linha da §5 do
glossário disse `pendente` por um dia inteiro depois de a t230 aterrissar
verde. Quem lê a tabela para saber "onde já virou" era desinformado por ela.

**Portão de código não vê papel.** Cinco filhos deixaram o código impecável e
as especificações citando `pergunta.criada` — com links para arquivos de schema
que já não existiam. Um leitor só descobria clicando. Superfície sem portão
apodrece, e documentação é superfície.

**O que sobrou é o que ninguém varre.** As chaves do JSON da API (§1), o
envelope do evento (§2.2) e as chaves de `data` (§2.4) não têm portão de
citação em documento: são palavras portuguesas comuns (`nome`, `motivo`,
`campo`, `origem`) cujo custo em falso positivo, na prosa, pagaria mal o que
encontrasse. Existe drift ali — `intake.md` ainda diz que os erros daquela
camada falam português, e o `topografo-cost.md` diz o mesmo das chaves do
corpo dele. É trabalho de ficha própria, com o tipo de mascaramento que o
`no-portuguese-wire.test.ts` construiu para código-fonte.
