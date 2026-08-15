# DECISOES — cartografo

Registro incremental; fonte da verdade das decisões do projeto. Cada decisão
tem data e pode ser revertida por outra decisão registrada.

## D1 (2026-08-14) — Só o server escreve no banco

O control plane é dono do SQLite; runner é cliente stateless da API e nunca
toca o banco direto. É o que mantém o banco embarcado viável (single writer)
e o runner deployável em qualquer lugar.

## D2 (2026-08-14) — Grafo versionado desde o dia 1

A entidade "proposta de melhoria" aponta para uma versão de grafo e carrega
um diff. Sem versionamento desde o início, a evolução entre rodadas não tem
onde se apoiar; não é aparafusável depois.

## D3 (2026-08-14) — Sintetizar topologia e quebrar trabalho são nós separados

Dois atos distintos no meta-processo: sintetizar a topologia (uma vez por
classe de problema, no design) e quebrar o trabalho em viajantes (a cada
execução, no intake). A quebra produz tickets, não nós; o caminho fica
congelado durante a execução (princípio 2 do README).

## D4 (2026-08-14) — Importação de skill passa por portão

Skill de repo externo é vetor de prompt injection. Registro com pin por
versão/hash, revisão na importação, e um passo que deriva e registra o
contrato (entrada, saída, verificação) quando o SKILL.md de origem não
declara. Skill sem contrato não entra no registro.

## D5 (2026-08-14) — Runner distribuído usa lease com heartbeat

Trabalho despachado carrega lease; runner morto expira e o trabalho volta à
fila. Registros idempotentes na API.

## D6 (2026-08-14) — Ordem do MVP

Control plane + um EngineAdapter + um grafo fixo portado do flowpilot,
rodando ponta a ponta com telemetria, antes de qualquer sintetizador. O
sintetizador é a última peça, não a primeira.

## D7 (2026-08-14) — Estratégia de publicação

Repo privado até funcionar. Validar em 2–3 domínios diferentes (condição de
partida do README). Depois de pronto: repo vira público junto com artigo na
newsletter, como alavanca de crescimento de subscribers; o README público
carrega convite para seguir e acompanhar agentsmaestro.dev.

## D8 (2026-08-14) — Classe de problema é nomeada pelo usuário (MVP)

Quem nomeia a classe é o usuário, na declaração do problema; o sintetizador
apenas sugere classe existente quando reconhecer semelhança ("isso parece a
classe tal, quer usar o mapa dela?"). Identidade da classe = raiz de
versionamento do grafo e unidade de agregação da telemetria.

## D9 (2026-08-14) — Formato do contrato

Entrada e saída em JSON Schema; verificação como lista de checks tipados,
cada check sendo ou um comando determinístico (rodar teste, validar schema)
ou uma instrução agêntica com evidência obrigatória. O contrato é a espinha
comum de skill, portão e validação formal do grafo.

## D10 (2026-08-14) — Sintetizador é copiloto no MVP

Propõe o grafo, o usuário edita e é o portão de validação inteiro.
Automatizar por partes depois, começando pelos checks formais de soundness.

## D11 (2026-08-14) — Tela: observabilidade + inbox de propostas primeiro

Configuração via arquivos e CLI no começo; tela de edição depois. Condição
do Rafael: arquitetada para estender e alterar fácil — garantida por
API-first (a tela é cliente da API pública, sem privilégios, em pacote
separado do core headless).

## D12 (2026-08-14) — Licença Apache-2.0

Proteção explícita de patente, padrão de infraestrutura aberta. Nome público
("cartografo" ou outro) validado contra colisões e domínio antes do anúncio.

## D13 (2026-08-14) — Linhagem de grafos: base da classe + variantes por projeto

Cada classe de problema tem um grafo-base; um projeto pode ter uma variante,
que é fork do base com diff e linhagem registrados (semântica de branch). O
aprendizado flui nos dois sentidos, sempre com portão: diff de variante que
supera o base vira proposta de promoção para o base; melhoria no base é
oferecida às variantes, nunca forçada. O próprio fork nasce de proposta do
topógrafo com evidência de divergência sistemática na telemetria, não de
decisão a priori.

## D14 (2026-08-14) — Duas instâncias de validação, com grafos de fábrica

Duas instâncias, e está bom (amenda o "2–3 domínios" de D7 e do README):

1. **Desenvolvimento de software** — o grafo do flowpilot portado.
2. **Bets assimétricas (tese de investimento)** — triagem → coleta de
   fundamentos → análise de assimetria (downside limitado, upside grande) →
   red team (papel dedicado a derrubar a tese) → dimensionamento de risco →
   decisão (portão humano obrigatório, sempre) → registro e monitoramento.
   O topógrafo aprende sobre métricas de processo (red team rodou? premissas
   com fonte? erro de estimativa caindo?); P&L é validação lenta de longo
   prazo, nunca métrica de rodada — em mercado, resultado não valida
   processo.

Requisito de produto derivado: o sistema entrega **grafos pré-determinados
prontos para uso** (biblioteca de fábrica com esses dois mapas; é a semente
do atlas compartilhável).

## D15 (2026-08-14) — Versionamento de grafos: no banco, com as ideias do git

Versionamos como o git pensa, sem o git instalado no núcleo. Entidades:
grafo (linhagem: classe, variante, ponteiro para versão corrente),
grafo_versao (id = hash do snapshot, parent, snapshot JSON completo, origem)
e proposta (versão-alvo, operações semânticas tipadas + inversas, evidência,
métrica esperada, status, resultado). Aplicar proposta = aplicar ops →
validar soundness no resultado → gravar versão nova → mover ponteiro;
rollback = mover ponteiro de volta; nada se apaga (append-only). Motivos:
topógrafo cruza versão×telemetria por join; propostas exigem diff semântico
(não diff de linha); fonte de verdade única (D1). Git entra nas bordas:
qualquer versão exporta como bundle em arquivos (atlas, backup, espelho em
repo do usuário; futura superfície de aprovação via PR, sem dependência do
core).

## D16 (2026-08-14) — Critério de aceite e fronteira da PoC

A PoC está aceita quando um projeto de software real atravessa o grafo
portado de ponta a ponta com: grafo vivendo como dado no banco (não como
código), sessões despachadas pelo EngineAdapter do Claude Code, perguntas
humanas fluindo pela API, telemetria completa consultável e tela mínima de
observabilidade. Sintetizador e topógrafo ficam explicitamente fora da PoC
(marcos seguintes, ordem da D6). A PoC prova paridade com o flowpilot sobre
a arquitetura nova; superar o flowpilot é o marco seguinte (primeira
proposta do topógrafo com evidência).

## D17 (2026-08-14) — Relação com o flowpilot e stack

O porte é reimplementação: o flowpilot (Python) é referência de
comportamento e fonte do grafo de fábrica 1, sem dependência de código;
migração/substituição do flowpilot é decisão futura, fora de escopo. Stack
cravado: TypeScript, API REST/JSON, SQLite (D1), tela como pacote separado
(D11).

## D18 (2026-08-14) — Idioma do código: inglês

Todo código do produto é em inglês: identificadores, nomes de arquivo e de
pacote, comentários, docstrings, nomes de teste, caminhos de rota da API e
mensagens de commit daqui em diante. Motivo: D12 (Apache-2.0) e a preparação
open source fazem do código a superfície pública do projeto, e a audiência é
global. O vocabulário de protocolo já era inglês (status de sessão etc.) e
permanece. Os documentos do repo (DECISOES.md, README, notas/) seguem em
português até decisão própria na preparação open source. O código escrito
antes desta decisão é regularizado por um ticket de refactor dedicado.
Fica de fora, como decisão separada ainda não tomada: as CHAVES dos formatos
de dados em português (manifesto de skill, bundle de grafo) — mudar chave de
formato é mudar especificação (t96–t99), não estilo de código.

**Emenda (2026-08-15, Rafael):** a decisão separada foi tomada. As chaves dos
formatos de dados, os manifestos de skill (instruções, nomes de arquivo), o
conteúdo dos bundles de fábrica e o restante da superfície do produto
(subcomandos de CLI, nomes de entidade na API) também convergem para o
inglês; tickets e especificações produzidos no quadro, idem. Mudar chave de
formato é mudança de especificação: o ticket dedicado emenda t96–t99 e
regulariza os bundles. Permanecem em português: o nome-marca cartografo, os
documentos internos do repo (DECISOES.md, notas/) e
docs/o-que-e-o-cartografo.md (a versão EN nasce na preparação open source,
t121).

## D19 (2026-08-15) — Documentação funcional viva

`docs/o-que-e-o-cartografo.md` explica o produto em linguagem simples e é
documento vivo: toda entrega que mudar comportamento visível do produto
atualiza o arquivo na mesma entrega (vale como critério de aceite implícito
desses tickets). Marcações *(em construção)* saem conforme as features
chegam.
