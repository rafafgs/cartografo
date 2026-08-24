-- 0005_skill — o registro de capacidades (D4, D9).
--
-- Numerada 0005 provisoriamente: outras fichas da onda 2 correm em paralelo e
-- `src/db/migrate.ts` falha alto em número repetido, então renumerar no merge é
-- obrigatório, não cosmético — mesmo precedente já registrado no cabeçalho da
-- 0003.
--
-- "A skill with no contract does not enter the registry" (D9) vira aqui uma
-- tabela cujas colunas SÃO os doze campos obrigatórios do manifesto
-- (`especificacoes/formatos/skill-manifest.schema.json`), mais o carimbo de
-- quando a skill entrou. Nada de blob genérico: o que o sintetizador consulta é
-- `description` e `role`, o que o runner pina é `id`+`version`+`hash`, e uma
-- coluna por campo é o que deixa essas três leituras serem consulta e não
-- desserialização.
--
-- `id` é a PRIMARY KEY, e é TEXT porque a identidade da skill é o kebab-case do
-- manifesto, não um autoincremento: é por esse nome que o grafo pina o nó
-- (`skill_ref.id`). Registro é create-only nesta ficha — um segundo POST no
-- mesmo id é 409. Reimportação, diff e histórico de versão de skill (o
-- equivalente do par graph/graph_version) ficam para quando existirem dois
-- consumidores, pela regra dos dois consumidores.
--
-- Os campos estruturados (`input`, `output`, `preconditions`, `checks`,
-- `permissions`, `source`) moram como JSON em TEXT, do mesmo jeito que
-- `graph_version.snapshot` e `input_request.options`: são documentos do
-- formato, e fatiá-los em tabelas seria travar em schema de banco uma
-- especificação que ainda é produto versionado (t97).
--
-- O `CHECK` de `role` é o único enum que o banco impõe: é o campo que decide se
-- o nó produz ou confere, e uma skill de trabalho registrada como portão vira um
-- portão que não confere nada. Os dois valores são os do `node_type` do
-- documento de grafo (`work`, `gate`) — o glossário reusa o nome que o formato
-- já publica em vez de inventar um segundo. O resto da validação (hash
-- conferindo com o conteúdo, pelo menos um check na importação, rede irrestrita
-- recusada, `resultado` na saída de portão) mora em
-- `src/repositories/skill.ts`: são regras sobre o conteúdo do JSON, e SQLite não
-- é onde se explica por que uma delas falhou.
--
-- Nenhuma migração abre transação própria: quem transaciona é src/db/migrate.ts.

CREATE TABLE skill (
  id             TEXT PRIMARY KEY,
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
  source         TEXT NOT NULL,   -- JSON: {tipo, repo?, ref?, importado_por?, importado_em?, revisado_por?}
  registered_at  TEXT NOT NULL
);
