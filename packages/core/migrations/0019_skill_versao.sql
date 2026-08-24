-- 0019_skill_versao — a skill vira linhagem, como o grafo (D22, D15).
--
-- Numerada 0019 provisoriamente: outras fichas correm em paralelo e
-- `src/db/migrate.ts` falha alto em número repetido, então renumerar no merge é
-- obrigatório, não cosmético — mesmo precedente registrado no cabeçalho da 0003,
-- da 0005 e da 0017 (que conta a terceira vez que isso aconteceu). Nenhuma ordem
-- de dependência: esta só mexe em `skill`.
--
-- A 0005 escreveu, no próprio cabeçalho, o que esta migração vem desfazer:
-- "Registro é create-only nesta ficha — um segundo POST no mesmo id é 409.
-- Reimportação, diff e histórico de versão de skill (o equivalente do par
-- graph/graph_version) ficam para quando existirem dois consumidores, pela regra
-- dos dois consumidores." Os dois consumidores apareceram — melhorar as
-- instruções de uma skill de fábrica e reimportar um bundle já registrado — e a
-- D22 registrou a decisão: "a skill has a stable id and versions (semver plus
-- a content hash)... a node stays pinned by hash (D4) and never resolves 'the
-- latest one'".
--
-- ## O que muda, e o que deliberadamente não muda
--
-- - a PRIMARY KEY passa de `id` para `(id, version)`. É a mudança inteira: uma
--   linhagem é o conjunto de linhas que compartilham `id`, do mesmo jeito que
--   `graph_version` é o conjunto de versões que compartilham `graph_id`;
-- - `deprecated_at` entra anulável, sem backfill. NULO = versão viva, e é a
--   verdade para toda linha anterior a esta migração: ninguém aposentou nada.
--   Primeira escrita vence, mesma postura de `registered_at` — aposentar duas
--   vezes não reescreve quando aconteceu;
-- - `hash` NÃO ganha restrição de unicidade, e a ausência é decisão. O hash de
--   conteúdo exclui `id` e `version` de propósito (`src/domain/manifest.ts`:
--   renomear uma skill não muda o que ela faz), então duas linhas de
--   (id, version) DIFERENTES podem legitimamente carregar o mesmo hash — uma
--   versão nova com conteúdo idêntico é inútil, mas não é ilegal, e policiar
--   isso é julgamento humano, não invariante de banco. O que o registro recusa é
--   o contrário: conteúdo DIFERENTE sob uma versão inalterada, e essa recusa
--   mora em `src/repositories/skill.ts`, onde dá para explicar por quê.
--
-- ## Por que a tabela é recriada
--
-- O SQLite não altera a PRIMARY KEY de uma tabela existente — só reconstruindo
-- (cria nova → copia → dropa velha → renomeia), o mesmo caminho que a 0010
-- abriu para trocar um CHECK. Aqui ele é mais curto do que lá por um motivo
-- concreto: ninguém referencia `skill`. Não há chave estrangeira apontando para
-- ela (o pino do nó vive DENTRO do snapshot de `graph_version`, como JSON, que é
-- exatamente o que faz a versão do grafo continuar legível depois de qualquer
-- coisa acontecer no registro), então não há o passo de guardar e restaurar
-- referências filhas que a 0010 precisou descobrir na marra. Nenhum índice cai
-- junto: a 0005 não criou nenhum.
--
-- A cópia não muda valor nenhum: cada linha já tem `id` e `version`, e a única
-- coluna nova nasce NULA.
--
-- Nenhuma migração abre transação própria: quem transaciona é src/db/migrate.ts.

CREATE TABLE skill_new (
  id             TEXT NOT NULL,
  version        TEXT NOT NULL,
  hash           TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('work', 'gate')),
  description    TEXT NOT NULL,
  input          TEXT NOT NULL,   -- JSON
  output         TEXT NOT NULL,   -- JSON
  preconditions  TEXT NOT NULL,   -- JSON array
  checks         TEXT NOT NULL,   -- JSON array
  permissions    TEXT NOT NULL,   -- JSON
  instructions   TEXT NOT NULL,
  source         TEXT NOT NULL,   -- JSON: {type, repo?, ref?, imported_by?, imported_at?, reviewed_by?}
  registered_at  TEXT NOT NULL,
  deprecated_at  TEXT,            -- NULO = versão viva; primeira escrita vence
  PRIMARY KEY (id, version)
);

INSERT INTO skill_new (id, version, hash, role, description, input, output, preconditions,
                       checks, permissions, instructions, source, registered_at, deprecated_at)
SELECT id, version, hash, role, description, input, output, preconditions,
       checks, permissions, instructions, source, registered_at, NULL
  FROM skill;

DROP TABLE skill;

ALTER TABLE skill_new RENAME TO skill;
