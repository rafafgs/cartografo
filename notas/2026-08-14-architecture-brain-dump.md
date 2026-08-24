# Arquitetura — brain dump (2026-08-14)

Brain dump do Rafael, organizado na conversa. Nada aqui é decisão fechada,
exceto onde confirma princípio já registrado no README.

## Herdado do flowpilot

- **Telemetria como cidadã de primeira classe.** O trio de tabelas do
  flowpilot (`ticket_events` append-only, `agent_sessions`, `input_requests`
  com `answer_source` user/auto) provou valor; levar o formato.
- **Independência de LLM via abstração do CLI.** O campo `engine` vira
  interface: EngineAdapter (abrir sessão com prompt/workdir/skills/timeout,
  acompanhar output, colher exit). Claude Code é o primeiro adapter, não uma
  dependência.
- **Escalação para humano como entidade** (input_requests), não como caso
  especial.
- **Injeção de skill por sessão.** As instruções do nó saem do banco e são
  injetadas na sessão pelo runner (flag/stdin/arquivo efêmero do engine).
  Nenhuma dependência de CLAUDE.md nem de arquivos md residentes no repo
  alvo; o contrato vive no banco e é renderizado por engine.

## Topologia

- **Control plane (server Node).** Roda em qualquer máquina; primeira
  execução instala o banco embarcado (SQLite). Guarda telemetria, estrutura
  dos grafos, projetos e demais entidades. Expõe API para estados atuais,
  grafos registrados, execuções, sessões — tudo que uma tela de configuração
  e observabilidade precisa. **Só o server escreve no banco** (single
  writer); todo mundo mais fala API.
- **Runner (mesmo processo ou separado).** Quem dispara workflows e abre
  sessões de CLI, registrando tudo no server remoto em que está registrado.
  Deploy em qualquer lugar que tenha acesso ao CLI do engine; runner é
  stateless, cliente da API.
- **Controller (dentro do runner).** Avalia um diretório (modo local) ou
  consulta a API (modo distribuído) para pegar trabalhos liberados.
  Controle máximo de sessões: teto de concorrência por runner e por projeto.
  WIP limit não é preocupação agora.

## Entidades mínimas do banco

projeto → grafo (versionado) → nós (com skill/contrato) e arestas (com
condição) → execução → ticket/trabalho → sessão → evento → input_request →
proposta de melhoria (aponta para versão do grafo, tem diff e status:
proposta / aprovada / aplicada / revertida).

## Fluxos

1. **Registrar grafo:** usuário descreve o problema; um agente estrutura o
   grafo e o registra no banco como grafo dentro de um projeto (passa pelo
   portão de validação do README, princípio 1).
2. **Skills:** usuário pode escanear repos conhecidos de skills e buscar as
   melhores para a tarefa; skill importada ganha contrato antes de entrar no
   registro (ver tensões).
3. **Intake e quebra:** mecanismo de quebra de trabalho e definição do
   caminho no grafo. Distinguir dois atos: sintetizar topologia (design da
   classe de problema) e quebrar trabalho em viajantes (por execução). A
   quebra produz tickets, não nós — caminho congelado durante a execução
   (princípio 2).
4. **Execução:** controller libera, runner despacha sessões com skill
   injetada, telemetria flui para o server.
5. **Otimização:** toda execução termina com um passo de avaliação que
   propõe melhorias; a proposta fica registrada e só aplica quando um
   usuário quiser (princípio 5, escada de segurança — confirmado no dump).

## Decisões implícitas no dump (a confirmar)

- Server é dono do banco; runner nunca toca SQLite direto.
- Grafo versionado desde o dia 1 (a entidade proposta-de-melhoria exige).
- Skill do nó vem do banco, renderizada por engine (não do repo alvo).
- Runner registrado no server (pareamento explícito), não descoberta mágica.

## Tensões e abertos

- **Supply chain de skills.** Escanear repos públicos e injetar em sessão é
  vetor de ataque (prompt injection empacotada). Registro precisa de pin de
  versão/hash e portão de revisão na importação: skill é artefato com
  contrato, validado antes de usar — mesma filosofia do grafo.
- **Contrato de skill importada.** SKILL.md público raramente declara
  entrada/saída/verificação; a importação precisa de um passo que derive e
  registre o contrato, senão o princípio 3 quebra silenciosamente.
- **Runner distribuído.** Com N runners, precisa de lease com heartbeat
  (trabalho de runner morto volta para a fila) e idempotência nos registros.
- **SQLite no control plane.** Aguenta single-writer de boa; se um dia o
  server escalar horizontalmente, o banco embarcado vira a primeira coisa a
  trocar. Aceitável: é exatamente o tipo de decisão que o log de execuções
  vai justificar trocar, ou não.
- **MVP na ordem certa (condição de partida do README).** Control plane +
  um EngineAdapter + UM grafo fixo portado do flowpilot, antes do
  sintetizador. O sintetizador é a última peça, não a primeira.
