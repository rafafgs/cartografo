# O que é o cartografo (explicação simples)

> **Documento vivo (D19).** Este arquivo explica o produto em linguagem
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

**Editar o mapa você mesmo.** Não é só aprovar o que o avaliador propõe: na
tela dá para acrescentar uma etapa, remover outra, mudar quem faz o quê e como
aquilo se verifica, e ligar ou cortar os caminhos entre as etapas. O que você
salva não vira mapa direto — vira uma proposta, que passa pela mesma
verificação formal de sempre e só entra se o mapa resultante ainda se sustentar
(toda etapa alcançável, toda travessia com fim, todo caminho rotulado, toda
etapa com contrato). Quando não se sustenta, a tela diz qual etapa ou qual
caminho quebrou qual regra, e nada é gravado. Trocar a identidade de uma etapa
que já existe não dá: para isso, remova e recrie.

**O trabalho entra e atravessa sozinho.** Você faz um pedido; o intake
propõe a quebra em tickets e você confirma. Os tickets
atravessam o mapa: agentes de CLI executam cada etapa com instruções e
contratos vindos do banco, portões verificam cada passagem com evidência, e
decisão que não é de máquina chega na tela e espera você. Cada mapa decide quais
campos os tickets dele carregam — uma tese de investimento pede fonte da
premissa, downside e upside, que um ticket de software não teria onde guardar —
e um campo declarado como obrigatório em certa etapa trava a saída dela até
alguém preencher.

**Escolher o motor e o modelo etapa por etapa.** Cada etapa do mapa pode dizer
em qual agente de CLI ela roda e com qual modelo — o nó que escreve usa o
modelo grande, o portão que confere usa um menor e mais barato. Quem não diz
nada roda no default, e trocar essa escolha é uma proposta como qualquer
outra: vira versão nova do mapa, com evidência e com volta. Os modelos que cada
motor oferece aparecem na API, com a informação de onde a lista veio.

**Trabalho pequeno roda em modelo barato, sem você escolher nada.** Na hora de
propor a quebra, o intake também diz de cada ticket se ele é pequeno — rename,
typo, mexida só em documentação — ou trabalho de verdade. A classificação sai
de graça: é a mesma sessão que já estava lendo o pedido. Daí em diante o ticket
pequeno atravessa o mapa inteiro num modelo mais barato, sem ninguém escolher
modelo ticket a ticket, e uma rodada com tickets de tamanhos misturados sai mais
barata do que uma que trata todos igual. Ticket que ninguém classificou roda
como sempre rodou, e a etapa que fixou o próprio modelo continua mandando nele.
A classificação muda quanto o ticket custa, nunca por onde ele passa: o caminho
no mapa é o mesmo.

**Decidir, etapa por etapa, quando você quer ser chamado.** Cada etapa do
mapa diz o quanto insiste em falar com você: sempre (chama antes de fechar,
mesmo achando que sabe), quando travar (o padrão), ou nunca — e aí travar
não vira pergunta na sua fila, vira o trabalho parado com o motivo escrito,
para etapas que rodam sem ninguém do outro lado. A etapa também pode nomear
quem deveria ser chamado, para quando existirem papéis. Mudar isso é uma
proposta como qualquer outra: nasce versão nova do mapa, e dá para voltar
atrás. E o relatório da rodada mostra quantas perguntas cada etapa fez.

**Fazer o mapa avisar sozinho quando algo acontece.** Uma etapa do mapa pode
dizer "quando um ticket entrar aqui, avise este endereço" ou "quando ele travar
aqui, chame aquele" — e o aviso sai assinado, com retentativa, para o serviço
que você indicar. O aviso mora dentro do mapa, e não numa configuração à parte:
ele viaja junto quando você exporta o mapa, muda por proposta como qualquer
outra parte dele e volta atrás junto com a versão que o introduziu. A chave que
assina o aviso é a única coisa que não mora ali: ela é registrada à parte, e o
mapa guarda só o nome dela — mapa é coisa que se publica, e segredo escrito num
mapa é segredo de quem lê o mapa. Se o destino não responder, o ticket não
trava — ele segue o caminho dele, e a falha do aviso vira um registro que você
consegue ver.

**Enxergar tudo.** O quadro mostra onde cada trabalho está; cada ticket tem
linha do tempo (agente trabalhando, esperando você, fila); cada pergunta tem
contexto para responder sem abrir o repo; o histórico permite reconstruir
qualquer execução.

**Construir por cima, sem ler o código.** Tudo que a tela faz passa por uma API
pública — e essa API se descreve sozinha: o servidor publica o documento
`/openapi.json` e uma página navegável em `/docs`, gerados das rotas que ele
realmente registra. Não é um documento escrito à mão que envelhece: rota nova
aparece ali no mesmo instante em que passa a existir. Quem quiser integrar
outra ferramenta aponta um cliente para o documento e já sabe o que existe. As
chamadas do fluxo básico — registrar um mapa, criar um ticket, responder uma
pergunta — já trazem o formato de entrada e saída escrito; as demais aparecem
listadas e ganham contrato aos poucos. O documento e a página não pedem
credencial, porque um esquema não é dado; tudo que é dado continua atrás do
token.

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
