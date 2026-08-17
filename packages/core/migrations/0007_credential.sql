-- 0007_credential — a credencial que a API exige em toda rota de negócio.
--
-- Fecha o buraco que o repositório carrega desde a D1/D11: as rotas nasceram
-- sem autenticação de propósito (era decisão desta ficha, não daquelas), e o
-- control plane é o único escritor do sistema. A partir daqui, `/v1/*` sem
-- credencial válida é negado; `/health` segue aberto, porque quem o consulta é
-- um supervisor que precisa saber se o processo vive ANTES de qualquer
-- credencial existir.
--
-- O que a tabela guarda — e o que ela deliberadamente NÃO guarda:
--
-- - `hash` é o digest SHA-256 do token cru, em hex, e é a única forma dele que
--   toca o disco. O valor cru é devolvido uma vez, no ato da emissão, e depois
--   não existe mais em lugar nenhum: quem levar o arquivo do banco embora não
--   leva nada que autentique. Não há KDF lento aqui (bcrypt/scrypt) porque o
--   token é segredo gerado com 32 bytes de entropia, não senha escolhida por
--   gente — força bruta sobre ele não é o risco.
-- - `owner_type` já aceita `runner` embora nada nesta ficha emita credencial de
--   runner. Declarar o valor agora custa uma linha; descobrir depois que falta
--   custa uma segunda migração nesta mesma tabela. O pareamento de runner (e a
--   revogação) é a ficha seguinte, dependente desta.
-- - `runner_id` é anulável e só faz sentido quando `owner_type = 'runner'`: uma
--   credencial de operador não pertence a máquina nenhuma.
-- - `revoked_at` é data, não flag: "quando deixou de valer" responde a uma
--   pergunta de auditoria que um booleano apaga. Nada é deletado (D15/D2), e é
--   `revoked_at IS NULL` que separa credencial viva de credencial morta.
--
-- `owner_type` e não `type`: é uma das três linhas QUALIFICADAS da §4.2 do
-- glossário, porque `tipo` queria dizer três coisas em três tabelas e aqui
-- quer dizer de quem é a credencial.
--
-- Nenhuma migração abre transação própria: quem transaciona é src/db/migrate.ts.

CREATE TABLE credential (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type  TEXT NOT NULL CHECK (owner_type IN ('user', 'runner')),
  runner_id   TEXT REFERENCES runner(id), -- só para owner_type = 'runner'
  hash        TEXT NOT NULL UNIQUE,       -- SHA-256 hex do token cru, nunca o token
  created_at  TEXT NOT NULL,
  revoked_at  TEXT
);

-- O caminho de leitura quente é um só, e é por requisição: achar a credencial
-- viva a partir do hash apresentado. O UNIQUE de `hash` já o indexa; este aqui
-- serve à outra pergunta, a da partida — "já existe credencial de operador?".
CREATE INDEX idx_credential_type ON credential (owner_type, revoked_at);
