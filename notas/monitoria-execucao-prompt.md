# Prompt da monitoria de execução (para nova sessão do Claude Code)

Estado em 2026-08-14: projeto cartografo semeado no flowpilot como projeto
id=3 (repo `~/cartografo`), tickets t96–t109 criados. Wizard no passo
discovery; controller desligado; t109 (PoC) bloqueado até t96–t108
concluírem. Copiar o prompt abaixo numa sessão nova.

---

Você vai armar e operar a monitoria de execução do projeto **cartografo** no
flowpilot. Contexto: o flowpilot vive em `~/flowpilot` (Flask, server :5000,
UI :5173, banco `~/flowpilot/instance/flowpilot.db`); o projeto cartografo é
o **id=3**, repo de trabalho `~/cartografo` (decisões do produto em
`DECISOES.md`, princípios no `README.md`, notas em `notas/` — é a fonte da
verdade para responder dúvidas de agente). O backlog tem duas ondas:
**onda 1 (a PoC)** — t96–t99 especificações (prioridade 2), t100–t108
construção (p3), t109 a PoC (alpha_test, já em to_develop porém **bloqueado
de propósito**; só desbloquear quando t96–t108 estiverem done). **Onda 2
(pós-PoC, prioridade 4, ranks 15–26)** — t110–t121: marcos "o grafo
aprende" (t110–t114), "o mapa novo" (t115–t118) e "abertura" (t119–t121).
**Nenhum ticket da onda 2 é liberado antes de a PoC (t109) ser aceita pelo
Rafael na régua da D16**; depois disso, liberar por rank, marco a marco.

Passos de armação (uma vez):

1. Confirme o server de pé (`curl -s localhost:5000/api/version` ou
   `make -C ~/flowpilot up` se caído) e a UI em :5173.
2. Complete o onboarding do projeto 3, que parou em **discovery**: rode a
   discovery real pela UI (gera o profile do repo para os agentes de
   refine), depois configure WIP e approvals espelhando o projeto vibe-game
   como default, e me confirme antes de fechar o passo de approvals.
3. Habilite o controller do projeto 3 (toggle na UI ou
   `PATCH /api/projects/3 {"controller_enabled": true}`).
4. Libere trabalho na ordem: primeiro **t96–t99 juntos** (especificações,
   podem andar em paralelo); depois **t100**; depois t101–t108 conforme
   dependências (t101/t102 após t100; t104 após t99; t105 após t96 e t97;
   t106/t107 após t102; t108 após t100). Liberar = transição
   backlog→to_refine pela UI. **t109 só desbloqueia com tudo done.**

Loop de monitoria (use `/loop 10m` ou se auto-agende):

- Leia o quadro e as perguntas pendentes SEMPRE com leitura read-only:
  `sqlite3 -readonly ~/flowpilot/instance/flowpilot.db "SELECT id, state,
  awaiting_input, substr(title,1,60) FROM tickets WHERE project_id=3 ORDER
  BY rank;"` e `"SELECT id, ticket_id, stage, substr(question,1,120) FROM
  input_requests WHERE project_id=3 AND status='pending';"`.
- Pergunta de agente que for esclarecimento factual coberto pelas decisões
  do repo (`~/cartografo/DECISOES.md` D1–D17, README, notas): responda pela
  UI citando a decisão (ex.: "D15 define versionamento no banco, não git").
  Qualquer decisão de produto NOVA (não coberta pelas D's): não responda,
  me chame.
- A cada ciclo, reporte só o que mudou: transições, sessões
  abertas/fechadas, perguntas respondidas ou escaladas, bloqueios.
- Libere o próximo ticket da ordem quando o anterior da cadeia chegar a
  done; mantenha no máximo 3 tickets ativos em paralelo no começo.

Guardrails: nunca escrever direto no banco (leituras `-readonly` ok; toda
mudança via UI ou API); não editar corpo de ticket sem me perguntar; se o
server ou o controller caírem, subir de novo e registrar; se um agente
propuser mudar uma decisão registrada, escalar sempre. Trabalhe de forma
autônoma dentro dessas regras e me interrompa apenas com exceções e com o
resumo de cada ciclo com mudança.
