# Grafo de fábrica 2 — bets assimétricas (tese de investimento)

> A segunda instância de validação da **D14**, escrita como grafo pronto para
> uso: triagem → coleta de fundamentos → análise de assimetria → red team →
> dimensionamento de risco → decisão (portão humano obrigatório, sempre) →
> registro e monitoramento.

**Estado: conteúdo, não formato.** Esta ticket (`t116`) não desenha formato
novo: aplica os dois já fechados — o documento de grafo
([`docs/spec/grafo.md`](../../docs/spec/grafo.md), `t96`) e o manifesto de skill
([`especificacoes/formatos/manifesto-skill.md`](../../especificacoes/formatos/manifesto-skill.md),
`t97`) — a uma classe de problema que não é software. É o par direto do
[grafo de fábrica 1](../desenvolvimento-de-software/README.md) (`t105`), e o
segundo consumidor que a regra dos dois consumidores pedia
(`docs/spec/grafo.md:172`) antes de o formato de aresta poder crescer.

| Arquivo | O que é |
|---|---|
| [`grafo.json`](./grafo.json) | O documento de grafo: sete nós, nove arestas, um `skill_ref` pinado por nó. |
| [`skills/triar-tese.json`](./skills/triar-tese.json) | `portao` — filtra a ideia antes de gastar pesquisa nela. |
| [`skills/coletar-fundamentos.json`](./skills/coletar-fundamentos.json) | `fazer` — reúne fundamentos em documento primário e separa fato, premissa e lacuna. |
| [`skills/analisar-assimetria.json`](./skills/analisar-assimetria.json) | `fazer` — piso do downside, alvo do upside, cenários presos a premissas. |
| [`skills/derrubar-tese.json`](./skills/derrubar-tese.json) | `portao` — red team: papel dedicado a matar a tese, com contra-evidência própria. |
| [`skills/dimensionar-risco.json`](./skills/dimensionar-risco.json) | `fazer` — tamanho de posição, perda máxima aceita e gatilho de saída. |
| [`skills/escalar-decisao.json`](./skills/escalar-decisao.json) | `portao` — monta o dossiê e escala; nunca decide alocação de capital. |
| [`skills/registrar-travessia.json`](./skills/registrar-travessia.json) | `fazer` — métricas de processo da travessia e plano de monitoramento. |

## A topologia

```
                        triagem
                           │
             ┌─aprofundar──┴──descartar──┐
             ▼                           │
      coleta-fundamentos                 │
             │ sempre                    │
             ▼                           │
      analise-assimetria                 │
             │ sempre                    │
             ▼                           │
         red-team ──────morta────────────┤
             │                           │
             │ sobrevive                 │
             ▼                           │
    dimensionamento-risco                │
             │ sempre                    │
             ▼                           │
         decisao ──aprovado / recusado───┤
                                         ▼
                          registro-monitoramento
```

`no_inicial: "triagem"`, `nos_finais: ["registro-monitoramento"]`.

| `id` | `papel` | `tipo_no` | skill pinada |
|---|---|---|---|
| `triagem` | `triador` | `portao` | `triar-tese` |
| `coleta-fundamentos` | `pesquisador` | `trabalho` | `coletar-fundamentos` |
| `analise-assimetria` | `analista` | `trabalho` | `analisar-assimetria` |
| `red-team` | `red-team` | `portao` | `derrubar-tese` |
| `dimensionamento-risco` | `gestor-de-risco` | `trabalho` | `dimensionar-risco` |
| `decisao` | `decisor` | `portao` | `escalar-decisao` |
| `registro-monitoramento` | `registrador` | `trabalho` | `registrar-travessia` |

| `de` | `para` | `condicao` | Quando |
|---|---|---|---|
| `triagem` | `coleta-fundamentos` | `aprofundar` | a ideia tem piso e gatilho |
| `triagem` | `registro-monitoramento` | `descartar` | não passou do primeiro filtro |
| `coleta-fundamentos` | `analise-assimetria` | `sempre` | saída única |
| `analise-assimetria` | `red-team` | `sempre` | saída única |
| `red-team` | `dimensionamento-risco` | `sobrevive` | a tese respondeu às objeções graves |
| `red-team` | `registro-monitoramento` | `morta` | objeção grave sem resposta |
| `dimensionamento-risco` | `decisao` | `sempre` | saída única |
| `decisao` | `registro-monitoramento` | `aprovado` | o fundador aprovou |
| `decisao` | `registro-monitoramento` | `recusado` | o fundador recusou |

**Um nó final, quatro formas de chegar nele.** Três terminam sem alocação
(descarte na triagem, morte no red team, recusa humana) e uma termina com
posição aberta (aprovação humana). Não existe um nó `arquivar` separado: é o
mesmo critério de colapso de estado que o
[grafo 1](../desenvolvimento-de-software/grafo.json) usou para as filas do
flowpilot, e é o que faz as **métricas de processo valerem por travessia** — a
descartada e a morta contam tanto quanto a aprovada, que é justamente o que D14
quer que o topógrafo aprenda.

O mapeamento entre o `resultado` do portão e o rótulo da aresta é fixo, e está
escrito nas `instrucoes` de cada portão:

| Portão | `passou` | `falhou` |
|---|---|---|
| `triagem` | `aprofundar` | `descartar` |
| `red-team` | `sobrevive` | `morta` |
| `decisao` | `aprovado` | `recusado` |

## Os dois nós que definem esta classe

**`red-team` é um portão que verifica com evidência própria — contra a tese.**
`entrada` recebe fundamentos e análise completos, e `saida` exige uma lista
`objecoes` (cada uma com gravidade e a resposta da tese, ou `null` quando não
houve resposta) mais uma lista `contra_evidencia_pesquisada` com fonte externa
ao material recebido. As `instrucoes` proíbem, com todas as letras, concluir
`passou` havendo objeção de gravidade alta sem resposta. Lista de objeções
vazia é recusada pelo contrato: red team que não achou nada não rodou.

**`decisao` nunca decide.** Este é o único nó do sistema em que escalar não é
um recurso para quando o agente não sabe — é **obrigatório por desenho**. Se
`entrada.perguntas_respondidas` não contém a resposta do fundador à pergunta de
alocação desta tese, a sessão encerra o turno com um bloco `input-request` e
**não devolve saída nenhuma**. Quando a resposta existe, `saida` exige
`decisao_humana` com `pergunta_id` e a transcrição literal da resposta — o
schema recusa um `resultado` sem ela. A regra é contrato, não recomendação:
nenhuma sessão deste grafo consegue alocar capital sozinha, nem por engano.

O teto de tamanho de posição segue o mesmo princípio: é um `maximum` no
`saida` de `dimensionar-risco`, não um check que alguém possa argumentar
contra.

## Como validar

```bash
# grafo + manifestos + pinos de hash, tudo de uma vez
node ../../scripts/validar-bundle-fabrica.mjs .

# checagem cruzada do formato dos manifestos, com um validador de terceiro
npx --yes ajv-cli@5 validate \
  -s ../../especificacoes/formatos/manifesto-skill.schema.json \
  -d './skills/*.json' --spec=draft2020
```

O primeiro comando confere as três coisas que fazem disto um bundle e não um
punhado de JSON no mesmo diretório: o grafo é sound pelas quatro regras do
`t96`, cada manifesto vale contra o schema do `t97`, e **cada pino fecha** — o
hash recalculado do conteúdo de cada manifesto bate com o que o `skill_ref` do
nó correspondente pina (D4).

Os testes de aceite deste bundle estão em
[`tests/grafo-fabrica-2.test.mjs`](../../tests/grafo-fabrica-2.test.mjs)
(`node --test`), com o fixture de travessia em
[`tests/fixtures/tese-exemplo-bets-assimetricas.json`](../../tests/fixtures/tese-exemplo-bets-assimetricas.json).

## Convenção de diretório: provisória

`grafos-de-fabrica/<classe>/` é convenção **provisória**, nomeada a partir da
string de `classe` do documento (D8) — mesma nota do bundle 1. O formato geral
de atlas/bundle multi-grafo é a `t120`; se ela decidir outro layout, mover este
diretório não custa nada, porque nada aqui depende do caminho.

## Divergências registradas

Cinco lugares onde este bundle se afasta do bundle 1 ou do que o formato
sugeriria. Ficam escritas porque divergência não registrada vira armadilha para
quem vier depois.

1. **Nenhum manifesto tem check determinístico.** No bundle 1, `make check` é o
   chão de fábrica: a suíte roda, passa ou falha, e o julgamento agêntico entra
   só onde comando nenhum resolve. Esta classe de problema não tem esse chão —
   não existe comando que responda "a tese tem piso?" ou "a contra-evidência é
   real?". Todos os sete manifestos são 100% agênticos, cada um com pelo menos
   um check de `evidencia_obrigatoria` não vazia. É a aplicação honesta do
   princípio 6 do README (densidade de verificação é o teto, não a
   inteligência): fabricar um check determinístico decorativo aqui daria uma
   sensação de rigor sem nenhum rigor. O que **pode** ser estrutural é
   estrutural — o teto de tamanho de posição é `maximum` de JSON Schema, não
   check.
2. **`coletar-fundamentos` abre rede irrestrita, sem `dominios`.** É o inverso
   do bundle 1, onde só o portão de teste abre rede e ainda assim restrita a
   loopback. Pesquisa de fundamentos varre fontes públicas variadas demais para
   uma allowlist fixa fazer sentido (documentos de regulador, releases,
   transcrições, contratos, dados de mercado, notícias), e a especificação do
   manifesto permite rede irrestrita para skill **nativa** — seria rejeitada na
   importação. Os outros seis manifestos ficam com `rede.permitido: false`, e
   `filesystem.escrita` é `[]` nos sete: nó nenhum deste grafo escreve no
   repositório do investidor.
3. **Escalar para humano não é aresta — e em `decisao` é obrigatório.** Os sete
   manifestos carregam o mesmo contrato de escalação do bundle 1 (o bloco
   `input-request`), e uma sessão que precisa do fundador pausa em vez de
   rotear: o trabalho bloqueia, a pergunta entra na fila, e ao ser respondida a
   sessão retoma e só então resolve (`docs/spec/escalacao-humana.md`, §4 e §5).
   `escalar_humano` existe no enum porque o formato de portão exige os três
   valores, e nenhuma sessão deste grafo o emite. A novidade em relação ao
   bundle 1 é o nó `decisao`: lá a escalação está *disponível*, aqui ela é
   *obrigatória por desenho* em um nó específico. Mecanismo idêntico
   (`perguntas_respondidas` no `entrada`, `input-request` no fim do turno);
   convenção nova sobre ele, não formato novo.
4. **Grafo e manifesto falam o mesmo enum de resultado.** No bundle 1 o
   `saida_schema` do nó `testar` usa `aprovado`/`retrabalho`/`escala` enquanto o
   manifesto usa `passou`/`falhou`/`escalar_humano` — divergência herdada do
   exemplo-mestre do `t96`. Aqui os dois lados nascem juntos, então o `resultado`
   é `passou`/`falhou`/`escalar_humano` nos dois, e o rótulo de domínio vive
   onde ele pertence: na `condicao` da aresta.
5. **A travessia é provada por contrato, não por execução ao vivo.** O critério
   original pedia "uma tese real atravessa até a decisão humana". Puxar a skill
   do `grafo_versao` registrado para dentro da sessão é escopo da `t109`
   (`packages/runner/src/dispatch/dispatch-claude-code.ts:62`), que não tem
   commit em `main`. Este bundle segue o precedente do bundle 1 — cujo critério
   de aceite também é o validador determinístico, e não "importa pela API" — e
   prova a travessia no nível que já é verificável hoje: um fixture de tese real
   em que a saída conforme de cada nó alimenta a entrada do próximo, contrato a
   contrato, até `decisao`, onde nenhuma aresta é seguida sem resposta humana
   registrada (`tests/grafo-fabrica-2.test.mjs`, AT11). Quando a `t109` existir,
   um teste de execução real pelo runner é mais forte que este e vale escrever.

## O formato de aresta não cresceu

`docs/spec/grafo.md:54` e `:172` marcam este grafo como o segundo consumidor
que poderia pressionar `condicao` a virar expressão booleana. Ele não pressiona:
os nove rótulos deste grafo cabem inteiros no vocabulário atual — rótulo de
resultado do nó de origem, ou `"sempre"`. Nenhuma transição aqui precisou de
"e", "ou" ou comparação. Sem evidência, o formato fica como está; a extensão
espera um terceiro grafo real que de fato peça.
