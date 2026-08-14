/**
 * `cartografo export <classe>` — o dado volta a ser arquivo (t108, FR3/FR4).
 *
 * Grava o `snapshot` da versão CORRENTE da classe, sem envelope: o que sai é
 * exatamente o formato que `import` aceita de volta. Isso não é conveniência de
 * formatação — é o que faz o round-trip ter significado. Como
 * `grafo_versao.id` é o hash canônico do documento inteiro
 * (`docs/spec/entidades-versionamento.md` §2), reimportar o arquivo exportado
 * em outro control plane tem que produzir o MESMO id; qualquer campo que este
 * comando acrescentasse, removesse ou reescrevesse apareceria como hash
 * diferente do outro lado.
 *
 * Só a versão corrente sai. Navegar histórico (`--versao`) é o mesmo corte que
 * `docs/spec/entidades-versionamento.md` §7 já declara fora de escopo.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ErroDeUso, pedirJson } from './url.ts';

/** Opções de `export`. */
export interface OpcoesDeExport {
  /** Classe da linhagem a exportar. */
  classe: string;
  /** URL base do control plane. */
  url: string;
  /** Arquivo de saída; default `./<classe>.grafo.json`. */
  saida?: string;
}

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

/** Uma linha de `rótulo  valor` da saída de sucesso. */
function linha(rotulo: string, valor: string): string {
  return `  ${rotulo.padEnd(18)}${valor}\n`;
}

/**
 * Roda `cartografo export`.
 *
 * @param opcoes Classe, URL base e arquivo de saída.
 * @returns Código de saída do processo.
 */
export async function executarExport(opcoes: OpcoesDeExport): Promise<number> {
  if (opcoes.classe.trim() === '') throw new ErroDeUso('export precisa de uma classe');

  const daLinhagem = await pedirJson(`${opcoes.url}/v1/grafos/${encodeURIComponent(opcoes.classe)}`);
  if (daLinhagem.status === 404) {
    process.stderr.write(
      `cartografo: grafo_desconhecido — nenhuma classe "${opcoes.classe}" registrada em ${opcoes.url}\n`,
    );
    return 1;
  }
  if (daLinhagem.status !== 200) {
    process.stderr.write(
      `cartografo: o control plane respondeu HTTP ${daLinhagem.status} ao buscar a classe "${opcoes.classe}"\n`,
    );
    return 1;
  }

  const corpoLinhagem = ehObjeto(daLinhagem.corpo) ? daLinhagem.corpo : {};
  const grafo = ehObjeto(corpoLinhagem.grafo) ? corpoLinhagem.grafo : {};
  const versaoId = grafo.versao_corrente_id;
  if (typeof versaoId !== 'string' || versaoId === '') {
    process.stderr.write(
      `cartografo: a classe "${opcoes.classe}" não tem versão corrente para exportar\n`,
    );
    return 1;
  }

  const daVersao = await pedirJson(`${opcoes.url}/v1/grafo-versoes/${encodeURIComponent(versaoId)}`);
  if (daVersao.status !== 200) {
    process.stderr.write(
      `cartografo: grafo_versao_desconhecida — o control plane respondeu HTTP ${daVersao.status} para ${versaoId}\n`,
    );
    return 1;
  }

  const corpoVersao = ehObjeto(daVersao.corpo) ? daVersao.corpo : {};
  const versao = ehObjeto(corpoVersao.grafo_versao) ? corpoVersao.grafo_versao : {};
  const snapshot = versao.snapshot;
  if (snapshot === undefined) {
    process.stderr.write(`cartografo: a versão ${versaoId} voltou sem snapshot\n`);
    return 1;
  }

  const destino = path.resolve(opcoes.saida ?? `${opcoes.classe}.grafo.json`);
  mkdirSync(path.dirname(destino), { recursive: true });
  writeFileSync(destino, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

  process.stdout.write('grafo exportado\n');
  process.stdout.write(linha('classe', opcoes.classe));
  process.stdout.write(linha('grafo_versao.id', versaoId));
  process.stdout.write(linha('arquivo', destino));
  return 0;
}
