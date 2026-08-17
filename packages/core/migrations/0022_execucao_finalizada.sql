-- 0022_execucao_finalizada — a execução vira sujeito de evento (D21, t245).
--
-- Nasceu 0021 provisoriamente e foi renumerada para 0022 no merge, exatamente
-- pelo motivo que o cabeçalho provisório antecipava: a t246 chegou primeiro na
-- main com `0021_proposta_dedupe_key.sql` e `src/db/migrate.ts` falha alto em
-- número repetido — mesmo precedente registrado no cabeçalho da 0003, da 0005,
-- da 0017 e da 0019. Nenhuma ordem de dependência entre as duas: aquela adiciona
-- coluna e índice em `proposal`, esta só mexe no CHECK de `event`, então rodar
-- depois não muda nada do que ela faz.
--
-- ## O que muda, e o que não muda
--
-- Uma coisa só: `event.entity_type` passa a admitir `'execution'`, ao lado dos
-- cinco que a 0003 escreveu (e que a t235 reescreveu para o inglês do
-- envelope). Nenhuma coluna nasce, nenhuma coluna sai, nenhum valor é
-- reescrito na cópia.
--
-- O que deliberadamente NÃO acontece aqui é a tabela `execution`. A 0003 disse,
-- no próprio cabeçalho, que "não existe tabela 'execução'... a taxonomia nunca
-- listou execução como `entity.type` válido", e a metade da frase que a D21
-- amenda é só a segunda: a rodada ganha um FATO que só o control plane afirma
-- (D1) — `execution.finished` —, e um fato precisa de sujeito. Continua não
-- havendo linha para ler: `execution_id` segue um agrupador INTEGER opaco, e o
-- `finished_at` que a API publica é derivado deste evento em tempo de leitura
-- (`src/repositories/job.ts`), nunca uma coluna.
--
-- ## Por que a tabela inteira é reconstruída
--
-- O SQLite não tem `ALTER TABLE ... ALTER CONSTRAINT`: um CHECK só muda
-- recriando a tabela (cria nova → copia → dropa velha → renomeia), o caminho que
-- a 0010 abriu e a 0019 repetiu. Aqui ele é o curto, como na 0019 e pelo mesmo
-- motivo concreto: ninguém referencia `event`. Não há chave estrangeira
-- apontando para ela — o log é a fonte, e quem o cruza com o resto do banco faz
-- isso por `entity_type`/`entity_id`, que são TEXT soltos de propósito (um log
-- só para seis entidades, e uma delas tem hash por id) —, então não existe o
-- passo de guardar e restaurar referências filhas que a 0010 precisou descobrir
-- na marra.
--
-- Os três índices caem junto com a tabela e por isso são recriados iguais. O
-- `AUTOINCREMENT` é preservado e os ids são copiados explicitamente, o que
-- importa mais aqui do que em qualquer outra migração deste repositório: o `id`
-- do evento É a ordem do log e a única ordenação total que existe
-- (`especificacoes/eventos/taxonomia.md`), e um replay depois desta migração tem
-- que reconstruir exatamente o mesmo estado de antes dela. Copiar é append-only
-- honesto: nenhuma linha conta uma história diferente no fim.
--
-- Nenhuma migração abre transação própria: quem transaciona é src/db/migrate.ts.

CREATE TABLE event_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  project_id  INTEGER NOT NULL,
  execution_id INTEGER,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('job','session','input_request','lease','graph_version','execution')),
  entity_id   TEXT NOT NULL,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('user','agent','system')),
  actor_ref   TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  data        TEXT NOT NULL
);

INSERT INTO event_new (id, type, project_id, execution_id, entity_type, entity_id,
                       actor_type, actor_ref, occurred_at, data)
SELECT id, type, project_id, execution_id, entity_type, entity_id,
       actor_type, actor_ref, occurred_at, data
  FROM event;

DROP TABLE event;

ALTER TABLE event_new RENAME TO event;

CREATE INDEX idx_event_entity     ON event (entity_type, entity_id);
CREATE INDEX idx_event_execution  ON event (execution_id);
CREATE INDEX idx_event_project    ON event (project_id);
