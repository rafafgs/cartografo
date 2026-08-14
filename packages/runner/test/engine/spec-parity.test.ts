/**
 * Paridade de especificação: `types.ts` não pode divergir do documento.
 *
 * A especificação do EngineAdapter está declaradamente **não congelada**
 * (`docs/formatos/engine-adapter.md:1-9`) — a regra dos dois consumidores
 * exige dois adapters implementados antes de travar o formato. Enquanto ela se
 * move, o risco real não é o código contradizer o documento de forma barulhenta:
 * é ele divergir em silêncio e só aparecer no dia da segunda CLI (t119).
 *
 * Este teste é o portão contra isso. Ele lê os blocos ```typescript``` da seção
 * "Interface TypeScript" do documento, extrai todo símbolo exportado e exige do
 * módulo o MESMO conjunto — nem a menos (o documento manda) nem a mais (o
 * módulo não inventa contrato).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DOC = fileURLToPath(new URL('../../../../docs/formatos/engine-adapter.md', import.meta.url));
const TIPOS = fileURLToPath(new URL('../../src/engine/types.ts', import.meta.url));

const SECAO = '## Interface TypeScript';

/** Símbolos que só existem em tempo de compilação — não dá para checar em runtime. */
const ESPECIES_APAGADAS = new Set(['type', 'interface']);

const PADRAO_DE_EXPORT =
  /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(type|interface|class|const|let|var|function|enum)\s+([A-Za-z_$][\w$]*)/gm;

/** Corpo de uma seção `## <título>` até o próximo heading de mesmo nível. */
function corpoDaSecao(markdown: string, titulo: string): string {
  const linhas = markdown.split('\n');
  const inicio = linhas.indexOf(titulo);
  assert.notEqual(inicio, -1, `seção "${titulo}" não encontrada em ${DOC}`);
  const resto = linhas.slice(inicio + 1);
  const fim = resto.findIndex((linha) => linha.startsWith('## '));
  return (fim === -1 ? resto : resto.slice(0, fim)).join('\n');
}

/** Concatena o conteúdo de todo bloco cercado ```typescript``` de um trecho. */
function blocosTypescript(trecho: string): string {
  const blocos: string[] = [];
  const padrao = /^```typescript\n([\s\S]*?)^```$/gm;
  let casamento: RegExpExecArray | null;
  while ((casamento = padrao.exec(trecho)) !== null) blocos.push(casamento[1] ?? '');
  return blocos.join('\n');
}

/** `nome -> espécie` de cada símbolo exportado num fonte TypeScript. */
function exportsDe(fonte: string): Map<string, string> {
  const encontrados = new Map<string, string>();
  PADRAO_DE_EXPORT.lastIndex = 0;
  let casamento: RegExpExecArray | null;
  while ((casamento = PADRAO_DE_EXPORT.exec(fonte)) !== null) {
    const [, especie, nome] = casamento;
    if (especie && nome) encontrados.set(nome, especie);
  }
  return encontrados;
}

const doDocumento = exportsDe(blocosTypescript(corpoDaSecao(readFileSync(DOC, 'utf8'), SECAO)));

test('a extração do documento achou a interface (guarda contra regex quebrada)', () => {
  assert.ok(
    doDocumento.size >= 10,
    `só ${doDocumento.size} símbolo(s) extraído(s) de "${SECAO}" — a extração quebrou`,
  );
  for (const ancora of ['SessionSpec', 'SessionListener', 'EngineAdapter', 'UnknownSessionError']) {
    assert.ok(doDocumento.has(ancora), `âncora "${ancora}" não veio do documento`);
  }
});

test('types.ts exporta exatamente os símbolos do documento — nem a menos, nem a mais', () => {
  const doModulo = exportsDe(readFileSync(TIPOS, 'utf8'));

  const esperados = [...doDocumento.keys()].sort();
  const declarados = [...doModulo.keys()].sort();

  const faltando = esperados.filter((nome) => !doModulo.has(nome));
  const sobrando = declarados.filter((nome) => !doDocumento.has(nome));

  assert.deepEqual(
    { faltando, sobrando },
    { faltando: [], sobrando: [] },
    'types.ts divergiu de docs/formatos/engine-adapter.md § Interface TypeScript',
  );
  assert.deepEqual(declarados, esperados);

  for (const [nome, especie] of doDocumento) {
    assert.equal(doModulo.get(nome), especie, `"${nome}" mudou de espécie em relação ao documento`);
  }
});

test('os símbolos de valor do documento existem de verdade em runtime', async () => {
  const modulo: Record<string, unknown> = await import('../../src/engine/types.ts');

  for (const [nome, especie] of doDocumento) {
    if (ESPECIES_APAGADAS.has(especie)) continue;
    assert.ok(
      Object.hasOwn(modulo, nome),
      `"${nome}" está declarado mas não é exportado em runtime por types.ts`,
    );
  }
});
