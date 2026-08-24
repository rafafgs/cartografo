# O que caracteriza o aprendizado (2026-08-14)

Iteração com o Rafael sobre três perguntas: o que é "aprender" aqui, portões
são skills?, e onde os aprendizados ficam registrados.

## Portões são skills

Tudo que executa no sistema é skill com contrato; o que muda é o papel
(fazer, conferir, rotear). Nuance fixada: portão é **determinístico sempre
que possível** (rodar testes, validar schema, build) e **agêntico só onde há
julgamento** ("critérios de aceite atendidos?"). Contrato do portão: entrada
= artefato + critérios do ticket; saída = passou/falhou/escala, sempre com
evidência anexada. Portão agêntico verifica com evidência própria (roda o
resultado), não com o relato de quem fez.

## Definição de aprendizado

**Aprendizado = diff versionado em uma superfície aprendível, com evidência
do log, aprovado no portão humano.** Sem peso de modelo, sem adaptação em
voo. Quatro superfícies aprendíveis:

1. **Topologia** — nós, arestas, ordem (ex.: gargalo de 41 min de espera
   humana do t81 → proposta "concentrar perguntas de dependência no refine").
2. **Portões** — critérios apertados/afrouxados. Todo defeito que escapou
   vira verificação futura (os 6 tickets dos testers = 6 checks candidatos ao
   portão de develop). Provavelmente a superfície mais valiosa.
3. **Skills dos nós** — instruções emendadas (ex.: steering de copyright
   vira linha permanente na skill de refine).
4. **Políticas** — timeouts, concorrência, auto-resposta por classe de
   pergunta com base em precedente.

## Onde registra: três mecanismos, todos no banco

- **Livro de propostas.** O topógrafo (nó final de toda execução) emite
  propostas: artefato-alvo + versão, diff, evidência do log e **métrica que
  espera mover**. Proposta é hipótese; aprovação é experimento; a telemetria
  da rodada seguinte grava o resultado na proposta (confirmada / sem efeito /
  piorou → reverte). Aprendizado consolidado = hipótese confirmada. Proposta
  rejeitada fica como conhecimento negativo (não repropor).
- **Cadeias de versão.** Grafo, contrato, skill e política versionados; a
  cadeia de diffs com justificativas responde "por que o grafo é assim?" com
  um log, não com arqueologia.
- **Base de precedentes.** Perguntas respondidas viram precedente
  consultável: alimenta auto-resposta e dá contexto ao sintetizador para
  grafos de classes parecidas.

## Consequência estratégica

Como o aprendizado mora em artefatos versionados (não em pesos nem em
contexto de sessão), **ele sobrevive à troca de engine**. Frase-síntese: o
sistema fica mais inteligente sem nenhum modelo ficar mais inteligente.
