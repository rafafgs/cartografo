# O que é o cartografo (explicação simples)

> **Documento vivo (D18).** Este arquivo explica o produto em linguagem
> simples, sem jargão, para quem chegou agora. Toda entrega que mudar o
> comportamento visível do produto atualiza este arquivo na mesma entrega.
> O que já roda hoje está no "Como rodar" do `README.md`; o que ainda está
> em construção no quadro atual está marcado aqui com *(em construção)*.

## Em uma frase

Um servidor local e aberto onde você declara problemas, ganha mapas de
processo com portões de verificação, agentes de IA executam o trabalho sob
governança enquanto você atende exceções, e cada mapa melhora de versão em
versão com base no próprio histórico.

## O que você consegue fazer

**Instalar e subir em um comando.** `npx cartografo` cria o banco local e
sobe o servidor; `npx cartografo-tela` abre a interface. Tudo na sua
máquina; tudo que a tela mostra vem de uma API pública que qualquer
ferramenta pode consumir.

**Começar com mapas prontos.** Grafos de fábrica vêm na caixa: o de
desenvolvimento de software e o de teses de investimento *(em construção)*.
Importa com um comando e já tem processo governado.

**Declarar um problema novo e ganhar um mapa** *(em construção)*. Você
descreve o problema; o sintetizador propõe um mapa usando as skills
registradas; você edita; o sistema valida formalmente; o mapa entra
registrado e versionado.

**O trabalho entra e atravessa sozinho.** Você faz um pedido; o intake
propõe a quebra em tickets *(em construção)* e você confirma. Os tickets
atravessam o mapa: agentes de CLI executam cada etapa com instruções e
contratos vindos do banco, portões verificam cada passagem com evidência, e
decisão que não é de máquina chega na tela e espera você.

**Enxergar tudo.** O quadro mostra onde cada trabalho está; cada ticket tem
linha do tempo (agente trabalhando, esperando você, fila); cada pergunta tem
contexto para responder sem abrir o repo; o histórico permite reconstruir
qualquer execução.

**O mapa melhora sozinho, com a sua mão no portão** *(em construção)*. Ao
fim de cada rodada, avaliadores leem o histórico e depositam propostas na
sua caixa de entrada, cada uma com o diff, a evidência e a métrica que
espera mover. Você aprova, nasce a versão nova; a rodada seguinte mede se a
hipótese se confirmou. Respostas repetidas viram precedente e, se você
aprovar, auto-resposta. Projetos que divergem ganham variante própria do
mapa; o que a variante aprende pode ser promovido ao mapa-base.

**Compartilhar o que aprendeu** *(em construção)*. Qualquer mapa exporta
como arquivo com skills e contratos dentro, com hash de integridade;
importa em outro cartografo e produz exatamente a mesma versão.

## O que ele deliberadamente não é

Não é SaaS nem multiusuário; a evolução nunca aplica nada sem aprovação
humana; e ele só serve para trabalho onde dá para escrever o contrato de
cada etapa. Onde não existe verificação possível, o mapa seria decorativo,
e preferimos dizer isso na embalagem.

## Vocabulário mínimo

- **Mapa (grafo)**: o desenho do processo de um tipo de problema; etapas
  (nós), caminhos (arestas) e verificações (portões). Versionado como
  commits.
- **Ticket (viajante)**: uma unidade de trabalho atravessando o mapa.
- **Skill**: as instruções e o contrato de uma etapa (o que entra, o que
  sai, como se verifica).
- **Portão**: a verificação entre etapas; determinístico quando dá
  (comando), com julgamento quando precisa (agente com evidência).
- **Proposta**: uma mudança sugerida no mapa, com evidência e métrica;
  hipótese que você aprova ou rejeita.
- **Topógrafo**: o avaliador que lê o histórico e escreve propostas.
