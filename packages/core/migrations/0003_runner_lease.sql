-- 0003_runner_lease — o par runner/lease da D5.
--
-- "Trabalho despachado carrega lease; runner morto expira e o trabalho volta à
-- fila. Registros idempotentes na API" (D5). runner é a identidade do processo
-- que executa; lease é o direito temporário de um runner sobre um trabalho, com
-- prazo próprio (expira_em) renovado por heartbeat.
--
-- O estado de lease mora no server porque só o control plane escreve no banco
-- (D1): o runner é cliente HTTP puro e nunca abre este arquivo. É isso que faz
-- o teto de concorrência valer para o projeto inteiro, e não por processo.
--
-- trabalho_id fica SOLTO de propósito, sem FK: a tabela `trabalho` é entrega do
-- t102, e acoplar as duas fichas por schema forçaria uma ordem de build que
-- nenhuma das duas precisa. Mesma escolha que o t102 já fez para
-- grafo_versao_id. Quem decide se um trabalho é elegível é GET /v1/trabalhos,
-- consultado pelo controller ANTES de pedir a lease; esta tabela só guarda quem
-- ficou com o quê, até quando.
--
-- Os nomes de coluna copiam os schemas de evento já especificados em
-- especificacoes/eventos/schemas/lease.concedida.schema.json e
-- lease.expirada.schema.json (runner_id, trabalho_id, expira_em, motivo), para
-- que ligar a emissão de telemetria quando o t102 aterrissar seja mapeamento
-- direto, não tradução. Esta migração NÃO cria a tabela de eventos: ela é do
-- t102.
--
-- Nenhuma migração abre transação própria: quem transaciona é src/db/migrate.ts.

CREATE TABLE runner (
  id            TEXT PRIMARY KEY,
  nome          TEXT,
  registrado_em TEXT NOT NULL
);

CREATE TABLE lease (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  runner_id        TEXT NOT NULL REFERENCES runner(id),
  trabalho_id      INTEGER NOT NULL, -- solto de propósito: `trabalho` é do t102
  projeto_id       INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'ativa'
                     CHECK (status IN ('ativa', 'liberada', 'expirada')),
  ttl_segundos     INTEGER NOT NULL,
  concedida_em     TEXT NOT NULL,
  heartbeat_em     TEXT NOT NULL,
  expira_em        TEXT NOT NULL,
  liberada_em      TEXT,
  motivo_expiracao TEXT CHECK (motivo_expiracao IN ('heartbeat_perdido', 'expirou'))
);

-- Os três índices são os três caminhos de leitura quentes do despacho: contar
-- lease ativa do runner (teto_runner), contar do projeto (teto_projeto) e
-- descobrir se o trabalho já tem dono.
CREATE INDEX idx_lease_runner_status   ON lease (runner_id, status);
CREATE INDEX idx_lease_projeto_status  ON lease (projeto_id, status);
CREATE INDEX idx_lease_trabalho_status ON lease (trabalho_id, status);
