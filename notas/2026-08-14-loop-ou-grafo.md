# É graph engineering ou loop engineering? (2026-08-14)

Objeção levantada pelo Rafael na iteração da ideia; é também a objeção número
um esperada quando o projeto for público. Registrada aqui com a resposta.

## A objeção

O ciclo de evolução do cartografo (sintetizar → executar → avaliar → propor →
aplicar → repetir) tem forma de loop. Isso não faz do projeto loop
engineering com passos extras?

## A resposta

**A camada de execução é graph engineering sem ambiguidade**: topologia
congelada, papéis distintos, portões condicionais, estado explícito, ciclos e
saídas. Os loops que existem ali (re-despacho, re-teste) são ciclos do grafo,
critério 4, não regressão.

**O cheiro de loop vem da camada de evolução, e a diferença está no que o
ciclo carrega.** No loop engineering, o loop carrega *tentativas*: itera em
voo até uma condição de passagem, cada iteração é descartável, e quando uma
passa as anteriores viram lixo; o que melhora é o artefato daquela rodada, e
o processo seguinte começa do zero. No cartografo, o ciclo carrega *versões*:
roda entre execuções (não dentro de uma), cada volta produz um grafo v(n+1)
com diff contra v(n), justificado por telemetria real de v(n); nada se
descarta, tudo é auditável e reversível; quem decide "melhor" é um humano num
portão, não uma condição computada; e o que melhora é o processo das próximas
execuções. Loop carrega tentativas; cartografo carrega versões.

**O argumento estrutural**: o meta-processo passa no teste dos quatro
critérios. Papéis distintos (sintetizador, validador, topógrafo, humano);
aresta condicional (o portão de validação pode reprovar o grafo sintetizado);
estado explícito (grafos versionados no banco); ciclos e saídas (proposta
rejeitada volta, aprovada aplica, rollback existe). O meta-processo é ele
mesmo um grafo fixo pequeno cujos viajantes são grafos. O "loop" percebido é
a aresta de ciclo desse meta-grafo. É grafo até o fundo; a recursão fecha.

**Nome teórico da distinção**: single-loop learning corrige a ação dentro das
regras (portões durante a execução; é o que o loop engineering automatiza);
double-loop learning revisa as próprias regras (o topógrafo propondo mudança
de topologia). O cartografo é double-loop sobre o grafo — a retrospectiva de
um time, automatizada, com o rigor de versionamento que retrospectiva humana
não tem.

## Os dois modos de degeneração (e as decisões que os bloqueiam)

1. **Regenerar a topologia por execução até dar certo** (padrão
   AgentConductor: regenera o YAML até sucesso ou estourar budget) — trata o
   grafo como rascunho de iteração. Bloqueado pelo princípio 2 e pela D2:
   congelado durante, versionado entre.
2. **Propostas auto-aplicadas otimizando métrica única** (compile loop estilo
   DSPy) — reduz o grafo a vetor de parâmetros. Bloqueado pelo princípio 5:
   o humano define "melhor" antes de qualquer auto-aplicação.

Se qualquer dessas duas barreiras cair, o projeto vira loop engineering de
verdade — e perde tanto a governança quanto o diferencial.
