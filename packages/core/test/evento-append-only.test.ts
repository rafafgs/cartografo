/**
 * Portão da regra append-only do log (t102, AT16).
 *
 * A taxonomia é explícita: "a única operação sobre o log é inserir", e a
 * garantia tem que ser de CÓDIGO, não de convenção — paridade com o
 * `TicketEventRepository` do flowpilot, que expõe `create` e leituras e mais
 * nada, com um teste que varre o fonte atrás de update/delete contra a tabela
 * (`especificacoes/eventos/taxonomia.md:88-92`).
 *
 * Duas regras aqui:
 *
 * 1. `src/db/eventos.ts` exporta EXATAMENTE três funções em tempo de execução;
 * 2. nenhum outro módulo de `src/` escreve SQL de update/delete contra `evento`.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ARTEFATOS_T102, RAIZ_PACOTE, carregarEventos, exigirArtefatos } from './apoio.ts';

const DIR_FONTE = path.join(RAIZ_PACOTE, 'src');

/** O módulo dono do log — o único isento da varredura. */
const DONO_DO_LOG = path.join(RAIZ_PACOTE, ARTEFATOS_T102.eventos);

/** `UPDATE evento` / `DELETE FROM evento`, em qualquer caixa e espaçamento. */
const ESCRITA_DESTRUTIVA = /\b(?:update|delete\s+from)\s+evento\b/i;

/** Lista recursivamente os `.ts` sob um diretório. */
function listarFontes(dir: string): string[] {
  const encontrados: string[] = [];
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const caminho = path.join(dir, entrada.name);
    if (entrada.isDirectory()) {
      encontrados.push(...listarFontes(caminho));
    } else if (entrada.isFile() && caminho.endsWith('.ts')) {
      encontrados.push(caminho);
    }
  }
  return encontrados.sort();
}

/**
 * Remove comentários antes da varredura.
 *
 * Um comentário que MENCIONA a regra não é uma violação dela — e sem isto o
 * portão puniria justamente quem documenta o motivo de não fazer aquilo.
 */
function semComentarios(codigo: string): string {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

test('AT16 — src/db/eventos.ts expõe só insert e leituras', async () => {
  exigirArtefatos(ARTEFATOS_T102.eventos);
  const modulo = await carregarEventos();

  assert.deepEqual(
    Object.keys(modulo).sort(),
    ['buscarEventosPorEntidade', 'listarEventos', 'registrarEvento'],
    'nenhuma função de update/delete pode existir no dono do log',
  );
  for (const nome of ['registrarEvento', 'listarEventos', 'buscarEventosPorEntidade'] as const) {
    assert.equal(typeof modulo[nome], 'function', `${nome} precisa ser função`);
  }
});

test('AT16 — nenhum módulo de src/ escreve UPDATE/DELETE contra a tabela evento', () => {
  exigirArtefatos(ARTEFATOS_T102.eventos);

  const violacoes: string[] = [];
  for (const arquivo of listarFontes(DIR_FONTE)) {
    if (arquivo === DONO_DO_LOG) continue;
    const codigo = semComentarios(readFileSync(arquivo, 'utf8'));
    if (ESCRITA_DESTRUTIVA.test(codigo)) {
      violacoes.push(path.relative(RAIZ_PACOTE, arquivo));
    }
  }

  assert.deepEqual(
    violacoes,
    [],
    'um fato registrado errado é corrigido por outro fato, nunca por sobrescrita',
  );
});

test('AT16 — o portão pega de verdade uma escrita destrutiva', () => {
  // Sem esta prova o teste acima poderia estar passando por engano — um regex
  // que nunca casa com nada é indistinguível de um código limpo.
  assert.ok(ESCRITA_DESTRUTIVA.test("db.prepare('UPDATE evento SET dados = ? WHERE id = ?')"));
  assert.ok(ESCRITA_DESTRUTIVA.test('db.exec("delete from evento")'));
  assert.ok(ESCRITA_DESTRUTIVA.test("db.exec('DELETE   FROM   evento WHERE id = 1')"));
  assert.ok(!ESCRITA_DESTRUTIVA.test("db.prepare('UPDATE trabalho SET no_atual = ?')"));
  assert.ok(!ESCRITA_DESTRUTIVA.test("db.prepare('INSERT INTO evento (tipo) VALUES (?)')"));
  assert.ok(!ESCRITA_DESTRUTIVA.test(semComentarios('// nunca fazer UPDATE evento aqui')));
});
