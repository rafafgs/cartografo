# O ciclo de aprendizado, fechado uma vez inteiro (t165)

**Quando:** 15/08/2026 · **Grafo:** `desenvolvimento-de-software` ·
**Banco:** persistente, `.cartografo/cartografo.db` do checkout da ficha ·
**Engine:** `claude` real (2.1.233), 11 sessões, nenhuma simulada.

O princípio 5 do README — propor, passar por portão, aplicar, medir, fechar — é
o produto. Até esta ficha ele nunca tinha dado uma volta completa: a `t110`
propunha, a `t111` desenhava a inbox contra rotas que não existiam, a `t112`
sabia fechar um experimento que ninguém tinha aberto. Esta nota registra a
primeira volta inteira, com número em cada passo.

## A volta

| Passo | O que rodou | Resultado |
|---|---|---|
| Rodada 1 | `npm run traverse` sobre os 5 nós, execução **1651** | 5 sessões `concluida`, 15 eventos, `trabalho` com `grafo_versao_id` |
| Proposta | `npm run surveyor -- 1651` | proposta **1**, `pendente`, gargalo `refinar`, evidência citando os eventos 2 e 3 |
| Portão | tela: **Aprovar** | `pendente` → `aprovada` |
| Aplicação | tela: **Aplicar** | versão `sha256:666feb7b…`, `versao_pai` = `sha256:5e506c31…`, ponteiro movido |
| Rodada 2 | `npm run traverse` na versão nova, execução **1653** | 5 sessões `concluida`, 16 eventos |
| Fecho | `npm run close-outcome -- 1 1653` | `{"veredito":"piorou","antes":29112,"depois":31273}` |
| Reversão | tela: **Reverter** com motivo | ponteiro de volta, versão abandonada **ainda listada**, `resultado` intacto |
| Rejeição | `surveyor -- 1653` → proposta **2** → tela: **Rejeitar** | `motivo_rejeicao` gravado, `resultado` continua `null` |

A tarefa das duas rodadas foi a mesma e real: especificar, implementar, testar e
"implantar" um utilitário Node que conta datas por dia da semana. Os dois
`parecer.md` saíram `aprovado`, com `node --test` verde de verdade.

## O que a volta ensinou, e que nenhum teste tinha como ensinar

**A hipótese piorou, e isso é o sistema funcionando.** O topógrafo apostou que
encurtar a descrição do nó `refinar` derrubaria `tempo_agente_ms:refinar` de
29112 para 23290. Mediu 31273 na rodada seguinte — subiu. O veredito saiu do
control plane, de dois números que qualquer pessoa refaz a partir do log, e foi
ele que justificou a reversão. Uma volta que confirmasse a hipótese na primeira
tentativa teria provado menos: o valor do ciclo é medir, não acertar.

**Uma rodada só não é uma medição.** `de` e `depois` aqui são de UMA travessia
cada. A variação natural entre duas sessões do mesmo nó é da ordem de segundos
(31s contra 29s), e nada neste ciclo separa "a mudança piorou" de "a sessão
demorou mais dessa vez". O veredito é honesto quanto ao que compara; quem for
usá-lo para decidir precisa de mais de uma travessia por versão, e isso não
existe.

**`Controller.tick()` pega o primeiro trabalho LIBERADO, não o seu.** Num banco
descartável, como o das spikes, existe só um trabalho e a distinção some. Neste,
a rodada 2 abriu cinco sessões reais no trabalho da rodada 1 — que continuava
parado, desbloqueado, no último nó — e o log inteiro caiu na execução errada, no
nó errado. Não há sinal de servidor para filtrar: `concluido` fica verdadeiro
no instante em que o trabalho CHEGA num nó final, antes da sessão daquele nó
rodar, então filtrar por ele pularia o último nó de toda travessia. Encerrar
trabalho de vez é da `t109`. Por ora o driver se recusa a começar com trabalho
liberado alheio na fila e bloqueia o próprio ao terminar.

**Reconstruir tabela no SQLite com quem aponta para ela.** `PRAGMA
defer_foreign_keys` — o remédio óbvio para o DELETE implícito do `DROP TABLE` —
não resolve: o contador de violações adiadas sobe no drop e o `RENAME` não o
abaixa. Um banco com uma única proposta aplicada não migrava. A `0010` guarda as
referências filhas, zera antes do drop e restaura depois do rename.
