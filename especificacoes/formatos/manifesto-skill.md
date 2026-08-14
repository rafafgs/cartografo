# Manifesto de skill — especificação

> Formato-produto do cartografo. O manifesto é o que faz uma capacidade (skill
> de fazer ou de portão) entrar no registro. Sem manifesto válido, não entra
> (D4).

## Como validar

Os artefatos desta especificação são verificáveis hoje, sem scaffold de
projeto, com o `ajv-cli` via `npx`. Da raiz do repositório:

```bash
# 1. o schema é um JSON Schema válido (draft 2020-12)
npx --yes ajv-cli@5 compile -s especificacoes/formatos/manifesto-skill.schema.json --spec=draft2020

# 2. o exemplo de skill "fazer" valida contra o schema
npx --yes ajv-cli@5 validate -s especificacoes/formatos/manifesto-skill.schema.json \
  -d especificacoes/formatos/exemplos/manifesto-skill.develop.json --spec=draft2020

# 3. o exemplo de skill "portão" valida contra o schema
npx --yes ajv-cli@5 validate -s especificacoes/formatos/manifesto-skill.schema.json \
  -d especificacoes/formatos/exemplos/manifesto-skill.verificacao-develop.json --spec=draft2020

# 4. o fixture negativo é REJEITADO (exit != 0 é o resultado esperado aqui)
npx --yes ajv-cli@5 validate -s especificacoes/formatos/manifesto-skill.schema.json \
  -d especificacoes/formatos/exemplos/manifesto-skill.invalido.fixture.json --spec=draft2020
```

Os três primeiros saem com exit 0; o quarto sai com exit diferente de 0 — é o
que prova que o schema não é permissivo demais.
