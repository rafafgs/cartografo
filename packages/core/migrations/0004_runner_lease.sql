-- 0004_runner_lease — o par runner/lease da D5.
--
-- "Trabalho despachado carrega lease; runner morto expira e o trabalho volta à
-- fila. Registros idempotentes na API" (D5). runner é a identidade do processo
-- que executa; lease é o direito temporário de um runner sobre um trabalho, com
-- prazo próprio (expires_at) renovado por heartbeat.
--
-- O estado de lease mora no server porque só o control plane escreve no banco
-- (D1): o runner é cliente HTTP puro e nunca abre este arquivo. É isso que faz
-- o teto de concorrência valer para o projeto inteiro, e não por processo.
--
-- job_id fica SOLTO de propósito, sem FK. A razão original era ordem de
-- build (a tabela `job` é entrega do t102, que agora já aterrissou na
-- 0003), mas o corte segue valendo pelo motivo de desenho: esta rota trata
-- job_id como inteiro opaco e nunca lê a tabela `job`. Quem decide se
-- um trabalho é elegível é GET /v1/jobs, consultado pelo controller ANTES
-- de pedir a lease; esta tabela só guarda quem ficou com o quê, até quando.
-- Apertar a FK é aditivo e fica para a ficha que ligar os dois lados.
--
-- Os nomes de coluna copiam os schemas de evento já especificados em
-- specs/events/schemas/lease.*.schema.json (runner_id, job_id,
-- expires_at, reason), para que ligar a emissão de telemetria seja mapeamento
-- direto, não tradução. Esta migração NÃO cria a tabela de eventos: ela é do
-- t102 (0003).
--
-- Nenhuma migração abre transação própria: quem transaciona é src/db/migrate.ts.

CREATE TABLE runner (
  id            TEXT PRIMARY KEY,
  name          TEXT,
  registered_at TEXT NOT NULL
);

CREATE TABLE lease (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  runner_id         TEXT NOT NULL REFERENCES runner(id),
  job_id            INTEGER NOT NULL, -- solto de propósito: `job` é do t102
  project_id        INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'released', 'expired')),
  ttl_seconds       INTEGER NOT NULL,
  granted_at        TEXT NOT NULL,
  heartbeat_at      TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  released_at       TEXT,
  expiration_reason TEXT CHECK (expiration_reason IN ('heartbeat_lost', 'ttl_elapsed'))
);

-- Os três índices são os três caminhos de leitura quentes do despacho: contar
-- lease ativa do runner (runner_cap), contar do projeto (project_cap) e
-- descobrir se o trabalho já tem dono.
CREATE INDEX idx_lease_runner_status  ON lease (runner_id, status);
CREATE INDEX idx_lease_project_status ON lease (project_id, status);
CREATE INDEX idx_lease_job_status     ON lease (job_id, status);
