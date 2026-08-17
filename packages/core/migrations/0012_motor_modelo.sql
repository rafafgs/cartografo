-- 0012_motor_modelo — o catálogo de modelos que cada motor oferece (t166).
--
-- Motor é coisa do runner: o control plane nunca ouviu falar de um, e continua
-- não sabendo o que é um `claude-code`. O que esta tabela guarda é um RELATO —
-- um runner subiu, perguntou ao adapter dele quais modelos existem, e contou.
-- É a mesma postura de `POST /v1/runners`: quem sabe o que é verdade naquela
-- máquina é a máquina, e o server registra o que ela disse.
--
-- - `engine` é o nome que o adapter dá a si mesmo (`EngineAdapter.engineName`),
--   e não tem FK: não existe tabela de motores, porque motor não é entidade do
--   control plane. Um motor passa a existir aqui quando alguém relata um.
-- - `model_id` é o identificador que vai depois de `--model`/`-m`. Texto
--   livre, como `no.model` no schema de grafo, e pela mesma razão: um enum
--   fechado obrigaria a migração a cada modelo novo, e quem recusa um id
--   desconhecido é a CLI, na abertura da sessão.
-- - `label` é o nome legível, quando o adapter tem um. NULO é normal.
-- - `source` diz de onde a linha veio: `cli` (o adapter perguntou ao binário) ou
--   `catalog` (lista estática do adapter). É `CHECK`ada porque um terceiro valor
--   aqui não é dado novo, é erro de quem escreveu — e é isso que separa "o
--   engine confirmou" de "o adapter acredita". Hoje os dois adapters respondem
--   sempre `catalog`: nem `claude --help` nem `codex --help` expõem caminho de
--   consulta, e essa lacuna está escrita no doc em vez de maquiada.
-- - `updated_at` é quando o relato chegou. Sem ele não dá para dizer se um
--   catálogo é de agora ou de um runner que morreu semana passada.
--
-- **Relato substitui, nunca soma.** O índice único `(engine, model_id)` é o que
-- torna o upsert possível, e a rota apaga as linhas do motor antes de gravar as
-- novas: mesclar deixaria um modelo que o engine parou de oferecer vivo para
-- sempre, e o operador leria um cardápio que não existe mais.
--
-- Os dois VALORES de `source` já nasceram em inglês, por serem vocabulário da
-- interface do EngineAdapter, que é inglesa inteira e é quem os produz — o mesmo
-- raciocínio que a 0011 escreveu para `wall_clock` e `silence` de
-- `timeout_reason`.
--
-- Nenhuma migração abre transação própria: quem transaciona é src/db/migrate.ts.

CREATE TABLE engine_model (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  engine      TEXT NOT NULL,             -- nome que o adapter dá a si mesmo
  model_id    TEXT NOT NULL,             -- o que vai depois de --model / -m
  label       TEXT,                      -- NULO = o adapter não deu nome legível
  source      TEXT NOT NULL
                CHECK (source IN ('cli', 'catalog')),
  updated_at  TEXT NOT NULL
);

-- Um motor não oferece o mesmo modelo duas vezes. É também o que dá ao relato
-- uma chave estável para substituir por cima.
CREATE UNIQUE INDEX idx_engine_model_unique ON engine_model (engine, model_id);
