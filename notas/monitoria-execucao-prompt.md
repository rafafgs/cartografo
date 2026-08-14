# Prompt da monitoria de execução (para nova sessão do Claude Code)

Estado em 2026-08-14: projeto cartografo semeado no flowpilot como projeto
id=3 (repo `~/cartografo`), 30 tickets (t96–t125) em duas ondas. Wizard no
passo discovery; controller desligado; t109 (PoC) bloqueado. Copiar o prompt
abaixo numa sessão nova.

---

Você vai armar e operar a monitoria de execução do projeto **cartografo** no
flowpilot. Contexto: o flowpilot vive em `~/flowpilot` (Flask, server :5000,
UI :5173, banco `~/flowpilot/instance/flowpilot.db`); o projeto cartografo é
o **id=3**, repo de trabalho `~/cartografo` (decisões do produto em
`DECISOES.md` D1–D17, princípios no `README.md`, notas em `notas/` — fonte
da verdade para responder dúvidas de agente).

O quadro tem duas ondas:

- **Onda 1 (a PoC)**: t96–t99 especificações (prioridade 2, podem andar em
  paralelo), t100–t108 construção (p3), t109 a PoC (alpha_test, já em
  to_develop porém **bloqueado de propósito**; só desbloquear quando
  t96–t108 estiverem done).
- **Onda 2 (pós-PoC, prioridade 4, liberar por rank)**: t110–t114 marco "o
  grafo aprende", t115 + t122 + t116–t118 marco "o mapa novo", t119–t120 +
  t123–t125 + t121 marco "abertura" (t121, preparação open source, é sempre
  o último). **Nenhum ticket da onda 2 é liberado antes de a PoC (t109) ser
  aceita pelo Rafael na régua da D16.**

Armação (uma vez):

1. Confirme o server de pé (`curl -s localhost:5000/api/version`, ou
   `make -C ~/flowpilot up` se caído) e a UI em :5173.
2. Complete o onboarding do projeto 3, que parou em **discovery**: rode a
   discovery real pela UI (gera o profile do repo para os agentes de
   refine), depois configure WIP e approvals espelhando o projeto vibe-game
   como default, e confirme com o Rafael antes de fechar approvals.
3. Habilite o controller do projeto 3 (toggle na UI ou
   `PATCH /api/projects/3 {"controller_enabled": true}`).
4. Libere trabalho na ordem (liberar = transição backlog→to_refine pela UI):
   primeiro **t96–t99 juntos**; depois **t100**; depois t101–t108 conforme
   dependências (t101/t102 após t100; t104 após t99; t105 após t96 e t97;
   t106/t107 após t102; t108 após t100). **t109 só desbloqueia com t96–t108
   done.**

Loop de monitoria (use `/loop 10m` ou se auto-agende):

- Leia quadro e perguntas SEMPRE em read-only:
  `sqlite3 -readonly ~/flowpilot/instance/flowpilot.db "SELECT id, state,
  awaiting_input, substr(title,1,60) FROM tickets WHERE project_id=3 ORDER
  BY rank;"` e `"SELECT id, ticket_id, stage, substr(question,1,120) FROM
  input_requests WHERE project_id=3 AND status='pending';"`.
- Pergunta de agente coberta pelas decisões do repo (D1–D17, README, notas):
  responda pela UI citando a decisão (ex.: "D15: versionamento no banco, não
  git"). Decisão de produto NOVA (não coberta): não responda, chame o
  Rafael.
- A cada ciclo, reporte só o que mudou: transições, sessões
  abertas/fechadas, perguntas respondidas ou escaladas, bloqueios.
- Libere o próximo ticket da cadeia quando o anterior chegar a done; máximo
  3 tickets ativos em paralelo no começo.

Guardrails: nunca escrever direto no banco (leituras `-readonly` ok; toda
mudança via UI ou API); não editar corpo de ticket sem perguntar; server ou
controller caiu, suba de novo e registre; agente propondo mudar decisão
registrada (D1–D17), escale sempre. Trabalhe de forma autônoma dentro dessas
regras e interrompa o Rafael apenas com exceções e com o resumo de cada
ciclo que tiver mudança.
