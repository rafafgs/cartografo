-- 0008_webhook — o transporte *push* dos eventos para fora (t142).
--
-- Fecha o ponto de extensão nº 5: a `t123` entregou a metade *pull* (o stream
-- SSE, que exige conexão aberta) e esta entrega a metade *push*, para quem
-- prefere receber um POST assinado. As duas leem o MESMO log pela MESMA função
-- (`listEvents`), e nenhuma das duas encosta no caminho de escrita: o
-- `recordEvent` não sabe que este arquivo existe, e é isso que faz um assinante
-- lento ou morto ser problema só dele.
--
-- Duas tabelas, e a divisão entre elas é a de sempre: o que foi CONTRATADO e o
-- que ACONTECEU.
--
-- `assinatura_webhook` é o contrato:
--
-- - `segredo` é dado pelo chamador, não gerado pelo servidor. Não há fluxo de
--   revelação única para construir (a `0007` tem o dela, para credencial), e
--   quem assina normalmente já tem um segredo do lado dele. Ele entra em texto
--   claro porque a assinatura é HMAC: diferente da credencial da `0007`, que só
--   precisa ser COMPARADA (e por isso vira digest), esta chave precisa ser
--   REUSADA a cada entrega. Nenhuma rota lê esta coluna de volta.
-- - `tipos_filtro` é JSON e é anulável, e os dois estados são diferentes: NULO
--   é "todo tipo", `[]` nunca é gravado. A API valida os tipos contra o mesmo
--   catálogo do stream (`KNOWN_TYPES`) antes de gravar, então o que está aqui
--   já passou pela taxonomia.
-- - `evento_inicial_id` é o `MAX(evento.id)` no instante da criação, e é o que
--   impede replay histórico por acidente: assinatura nova recebe o que for
--   gravado DAQUI para frente, exatamente como o stream sem `Last-Event-ID`.
--   Zero quando o log está vazio.
-- - `desativada_em` é data, não flag — mesma razão do `revogada_em` da `0007`:
--   "quando deixou de valer" responde a uma pergunta de auditoria que um
--   booleano apaga. Nada é deletado (D15/D2), e é `desativada_em IS NULL` que
--   separa assinatura viva de assinatura morta.
--
-- `entrega_webhook` é o que aconteceu, uma linha por (assinatura, evento):
--
-- - o `UNIQUE (assinatura_id, evento_id)` é o que torna o fan-out idempotente:
--   ele roda com `INSERT OR IGNORE`, então reprocessar a mesma janela — depois
--   de uma queda, de um restart, de um tick que morreu no meio — não duplica
--   entrega nenhuma. O mesmo índice serve à pergunta do cursor
--   ("`MAX(evento_id)` desta assinatura"), que é de onde o fan-out retoma.
-- - o cursor NÃO é uma coluna mutável da assinatura: ele é derivado das
--   entregas já gravadas. Uma coluna a menos é um estado a menos para
--   discordar do que de fato foi enfileirado.
-- - `status` tem três valores e dois deles são terminais. `pendente` é a fila,
--   `entregue` é o 2xx que chegou, `esgotada` é a desistência — seja por ter
--   passado do último degrau do backoff, seja porque a assinatura foi
--   desativada com a entrega ainda em voo. A linha não é apagada em nenhum dos
--   casos: "tentei seis vezes e desisti" é fato de auditoria.
-- - `proxima_tentativa_em` é o relógio da fila, e nasce igual ao `criada_em`:
--   entrega recém-enfileirada está vencida agora. Cada falha empurra essa data
--   pelo degrau correspondente do backoff (10s, 1min, 5min, 30min, 2h).
--
-- Nomes de tabela e coluna seguem em português, como `evento`, `trabalho`,
-- `lease` e `credencial`: a D18 escopa a regra de inglês a identificadores de
-- código, e schema aqui é vocabulário de dado. O TypeScript em volta
-- (`createSubscription`, `signPayload`) é inglês, esse sim.
--
-- Nenhuma migração abre transação própria: quem transaciona é src/db/migrate.ts.

CREATE TABLE assinatura_webhook (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  projeto_id         INTEGER NOT NULL,
  url                TEXT NOT NULL,
  segredo            TEXT NOT NULL,          -- chave do HMAC, dada por quem assina
  tipos_filtro       TEXT,                   -- JSON com tipos da taxonomia; NULO = todo tipo
  evento_inicial_id  INTEGER NOT NULL,       -- MAX(evento.id) na criação (0 se o log está vazio)
  criada_em          TEXT NOT NULL,
  desativada_em      TEXT                    -- NULO = ativa, espelha credencial.revogada_em (0007)
);

-- O fan-out varre as assinaturas vivas a cada tick, e é por projeto que ele
-- pergunta.
CREATE INDEX idx_assinatura_webhook_ativa ON assinatura_webhook (desativada_em, projeto_id);

CREATE TABLE entrega_webhook (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  assinatura_id         INTEGER NOT NULL REFERENCES assinatura_webhook(id),
  evento_id             INTEGER NOT NULL REFERENCES evento(id),
  status                TEXT NOT NULL CHECK (status IN ('pendente','entregue','esgotada')),
  tentativas            INTEGER NOT NULL DEFAULT 0,
  proxima_tentativa_em  TEXT NOT NULL,
  criada_em             TEXT NOT NULL,
  entregue_em           TEXT,
  ultimo_erro           TEXT,
  UNIQUE (assinatura_id, evento_id)          -- fan-out idempotente e índice do cursor
);

-- A pergunta quente do tick: "o que está vencido agora?".
CREATE INDEX idx_entrega_webhook_pendente ON entrega_webhook (status, proxima_tentativa_em);
