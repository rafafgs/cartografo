/**
 * `cartografo status` — o que o control plane sabe hoje (t108, FR5).
 *
 * O campo mais importante deste relatório é o que ele NÃO afirma:
 * `trabalhos` e `perguntas_pendentes` saem como `null`, nunca `0`. As tabelas
 * `sessão` e `input_request` ainda não existem (`migrations/0001_init.sql`,
 * `docs/spec/entidades-versionamento.md` §7), e um `0` ali diria "não há fila"
 * quando a resposta honesta é "isto ainda não é rastreado" — que é justamente
 * a diferença que faria alguém confiar num painel vazio. O campo aparece, com
 * o valor certo, e vira número quando as entidades existirem.
 *
 * `--json` imprime uma linha só, com as chaves em ordem fixa: é saída de
 * máquina, e o teste de aceite a compara byte a byte, pelo mesmo motivo que
 * `health.test.ts` pina o corpo de `/health`.
 */

import { ErroDeRede, mensagemDeServidorFora, pedirJson } from './url.ts';

/** Uma classe registrada, na visão de `status`. */
export interface ProjetoNoStatus {
  classe: string;
  versao_corrente_id: string | null;
}

/**
 * O relatório inteiro. A ordem das chaves é parte do contrato do `--json`.
 *
 * `projetos: null` significa "não deu para consultar" (servidor fora), que é
 * diferente de `[]`, "nenhuma classe registrada".
 */
export interface RelatorioDeStatus {
  server: 'ok' | 'erro' | 'indisponível';
  projetos: ProjetoNoStatus[] | null;
  trabalhos: null;
  perguntas_pendentes: null;
}

/** Opções de `status`. */
export interface OpcoesDeStatus {
  /** URL base do control plane. */
  url: string;
  /** Imprime o relatório como um objeto JSON único. */
  json?: boolean;
}

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

/**
 * Monta o relatório consultando `/health` e `/v1/classes`.
 *
 * Servidor fora do ar não é exceção aqui: é um estado que o relatório sabe
 * dizer. Por isso `ErroDeRede` é capturado em vez de propagado — quem roda
 * `status` está justamente perguntando se o servidor responde.
 *
 * @param url URL base do control plane.
 * @returns O relatório e o sub-status do banco, quando houver.
 */
export async function coletarStatus(
  url: string,
): Promise<{ relatorio: RelatorioDeStatus; db: string | null }> {
  let server: RelatorioDeStatus['server'];
  let db: string | null;

  try {
    const saude = await pedirJson(`${url}/health`);
    const corpo = ehObjeto(saude.corpo) ? saude.corpo : {};
    db = typeof corpo.db === 'string' ? corpo.db : null;
    server = saude.status === 200 && corpo.status === 'ok' ? 'ok' : 'erro';
  } catch (erro) {
    if (!(erro instanceof ErroDeRede)) throw erro;
    return {
      relatorio: { server: 'indisponível', projetos: null, trabalhos: null, perguntas_pendentes: null },
      db: null,
    };
  }

  let projetos: ProjetoNoStatus[] | null = null;
  try {
    const classes = await pedirJson(`${url}/v1/classes`);
    const corpo = ehObjeto(classes.corpo) ? classes.corpo : {};
    if (classes.status === 200 && Array.isArray(corpo.classes)) {
      projetos = corpo.classes.filter(ehObjeto).map((entrada) => ({
        classe: String(entrada.classe),
        versao_corrente_id:
          typeof entrada.versao_corrente_id === 'string' ? entrada.versao_corrente_id : null,
      }));
    }
  } catch (erro) {
    if (!(erro instanceof ErroDeRede)) throw erro;
  }

  return { relatorio: { server, projetos, trabalhos: null, perguntas_pendentes: null }, db };
}

/** Formata o relatório para leitura humana. */
function comoTabela(relatorio: RelatorioDeStatus, db: string | null, url: string): string {
  const linhas: string[] = [];

  const detalheDoServidor =
    relatorio.server === 'indisponível' ? ` (${url})` : db === null ? '' : ` (db: ${db})`;
  linhas.push(`server: ${relatorio.server}${detalheDoServidor}`);

  if (relatorio.projetos === null) {
    linhas.push('projetos: não consultado');
  } else {
    linhas.push(`projetos: ${relatorio.projetos.length}`);
    for (const projeto of relatorio.projetos) {
      linhas.push(`  - ${projeto.classe}  ${projeto.versao_corrente_id ?? 'sem versão corrente'}`);
    }
  }

  linhas.push('trabalhos: não rastreado ainda');
  linhas.push('perguntas_pendentes: não rastreado ainda');
  linhas.push('');
  linhas.push(
    '(trabalhos e perguntas pendentes não são zero: as entidades sessão/input_request entram em ticket seguinte)',
  );

  return `${linhas.join('\n')}\n`;
}

/**
 * Roda `cartografo status`.
 *
 * @param opcoes URL base e formato de saída.
 * @returns Código de saída: 0 só quando o control plane responde saudável.
 */
export async function executarStatus(opcoes: OpcoesDeStatus): Promise<number> {
  const { relatorio, db } = await coletarStatus(opcoes.url);

  if (opcoes.json === true) {
    process.stdout.write(`${JSON.stringify(relatorio)}\n`);
  } else {
    process.stdout.write(comoTabela(relatorio, db, opcoes.url));
  }

  if (relatorio.server === 'indisponível') {
    process.stderr.write(`${mensagemDeServidorFora(opcoes.url)}\n`);
  }

  return relatorio.server === 'ok' ? 0 : 1;
}
