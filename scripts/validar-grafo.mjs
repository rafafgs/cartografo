/**
 * Validador de referência do documento de grafo (t96).
 *
 * Duas checagens, deliberadamente separadas:
 *
 * - `validarEstrutura(doc)` — integridade de forma e de referência: chaves
 *   obrigatórias presentes, ids de nó únicos, toda aresta e todo id em
 *   `no_inicial`/`nos_finais` apontando para nó existente.
 * - `validarSoundness(doc)` — as quatro regras formais de workflow net (van der
 *   Aalst) que o portão de validação de grafo aplica: alcançável, termina,
 *   aresta_com_condicao, no_com_contrato.
 *
 * As duas rodam independentes e nenhuma lança exceção em documento malformado:
 * o sintetizador (D10) monta grafo em memória e precisa de um relatório de
 * tudo que está errado, não do primeiro erro.
 *
 * Zero dependências: só módulos nativos do Node. Validação de FORMA completa
 * contra `schema/grafo.schema.json` (via ajv ou equivalente) entra com o
 * scaffold TypeScript do control plane — aqui o validador cobre o necessário
 * para provar os fixtures.
 *
 * Uso como CLI: `node scripts/validar-grafo.mjs schema/exemplos/*.json`
 */

import { readFileSync } from 'node:fs';

/** Nomes das quatro regras de soundness, na ordem em que rodam. */
export const REGRAS = Object.freeze({
  ALCANCAVEL: 'alcançável',
  TERMINA: 'termina',
  ARESTA_COM_CONDICAO: 'aresta_com_condicao',
  NO_COM_CONTRATO: 'no_com_contrato',
});

const CAMPOS_OBRIGATORIOS_DOC = [
  'classe',
  'linhagem',
  'metadata',
  'nos',
  'arestas',
  'no_inicial',
  'nos_finais',
];
const CAMPOS_OBRIGATORIOS_NO = ['id', 'papel', 'tipo_no', 'skill_ref', 'contrato'];
const CAMPOS_OBRIGATORIOS_ARESTA = ['de', 'para', 'condicao'];

const ehObjeto = (valor) => typeof valor === 'object' && valor !== null && !Array.isArray(valor);
const ehTextoPreenchido = (valor) => typeof valor === 'string' && valor.trim() !== '';

/**
 * Confere forma e integridade referencial do documento.
 *
 * @param {unknown} doc Documento de grafo já parseado.
 * @returns {{valido: boolean, erros: Array<{codigo: string, mensagem: string, alvo: unknown}>}}
 */
export function validarEstrutura(doc) {
  const erros = [];
  const anotar = (codigo, mensagem, alvo = null) => erros.push({ codigo, mensagem, alvo });

  if (!ehObjeto(doc)) {
    anotar('documento_invalido', 'documento de grafo precisa ser um objeto JSON');
    return { valido: false, erros };
  }

  for (const campo of CAMPOS_OBRIGATORIOS_DOC) {
    if (doc[campo] === undefined || doc[campo] === null) {
      anotar('campo_obrigatorio_ausente', `campo obrigatório ausente no documento: "${campo}"`, campo);
    }
  }

  if (doc.nos !== undefined && !Array.isArray(doc.nos)) {
    anotar('campo_invalido', '"nos" precisa ser uma lista', 'nos');
  }
  if (doc.arestas !== undefined && !Array.isArray(doc.arestas)) {
    anotar('campo_invalido', '"arestas" precisa ser uma lista', 'arestas');
  }
  if (doc.nos_finais !== undefined && !Array.isArray(doc.nos_finais)) {
    anotar('campo_invalido', '"nos_finais" precisa ser uma lista', 'nos_finais');
  }

  const nos = Array.isArray(doc.nos) ? doc.nos : [];
  const idsConhecidos = new Set();
  const idsJaReportados = new Set();

  nos.forEach((no, indice) => {
    if (!ehObjeto(no)) {
      anotar('no_invalido', `o nó na posição ${indice} precisa ser um objeto`, indice);
      return;
    }
    for (const campo of CAMPOS_OBRIGATORIOS_NO) {
      if (no[campo] === undefined || no[campo] === null) {
        anotar(
          'campo_obrigatorio_ausente',
          `campo obrigatório ausente no nó "${no.id ?? `#${indice}`}": "${campo}"`,
          no.id ?? indice,
        );
      }
    }
    if (!ehTextoPreenchido(no.id)) return;
    if (idsConhecidos.has(no.id)) {
      if (!idsJaReportados.has(no.id)) {
        anotar('id_no_duplicado', `id de nó repetido no documento: "${no.id}"`, no.id);
        idsJaReportados.add(no.id);
      }
      return;
    }
    idsConhecidos.add(no.id);
  });

  const arestas = Array.isArray(doc.arestas) ? doc.arestas : [];
  arestas.forEach((aresta, indice) => {
    if (!ehObjeto(aresta)) {
      anotar('aresta_invalida', `a aresta na posição ${indice} precisa ser um objeto`, indice);
      return;
    }
    for (const campo of CAMPOS_OBRIGATORIOS_ARESTA) {
      if (aresta[campo] === undefined || aresta[campo] === null) {
        anotar(
          'campo_obrigatorio_ausente',
          `campo obrigatório ausente na aresta #${indice}: "${campo}"`,
          { de: aresta.de ?? null, para: aresta.para ?? null },
        );
      }
    }
    for (const ponta of ['de', 'para']) {
      const alvo = aresta[ponta];
      if (ehTextoPreenchido(alvo) && !idsConhecidos.has(alvo)) {
        anotar(
          'aresta_no_inexistente',
          `a aresta #${indice} referencia em "${ponta}" um nó que não existe: "${alvo}"`,
          { de: aresta.de ?? null, para: aresta.para ?? null },
        );
      }
    }
  });

  if (ehTextoPreenchido(doc.no_inicial) && !idsConhecidos.has(doc.no_inicial)) {
    anotar('no_inicial_inexistente', `no_inicial referencia um nó que não existe: "${doc.no_inicial}"`, doc.no_inicial);
  }

  const finais = Array.isArray(doc.nos_finais) ? doc.nos_finais : [];
  if (Array.isArray(doc.nos_finais) && finais.length === 0) {
    anotar('campo_invalido', '"nos_finais" precisa listar pelo menos um nó', 'nos_finais');
  }
  for (const final of finais) {
    if (ehTextoPreenchido(final) && !idsConhecidos.has(final)) {
      anotar('no_final_inexistente', `nos_finais referencia um nó que não existe: "${final}"`, final);
    }
  }

  return { valido: erros.length === 0, erros };
}

/**
 * Roda as quatro regras de soundness, nesta ordem: alcançável, termina,
 * aresta_com_condicao, no_com_contrato.
 *
 * @param {unknown} doc Documento de grafo já parseado.
 * @returns {{valido: boolean, violacoes: Array<{regra: string, alvo: unknown}>}}
 */
export function validarSoundness(doc) {
  const violacoes = [];
  const nos = ehObjeto(doc) && Array.isArray(doc.nos) ? doc.nos.filter(ehObjeto) : [];
  const arestas = ehObjeto(doc) && Array.isArray(doc.arestas) ? doc.arestas.filter(ehObjeto) : [];
  const ids = nos.map((no) => no.id).filter(ehTextoPreenchido);
  const conhecidos = new Set(ids);

  // Só arestas entre nós existentes entram na topologia; ponta solta é problema
  // de estrutura, e contá-la aqui inventaria alcançabilidade que não existe.
  const saidas = new Map(ids.map((id) => [id, []]));
  const entradas = new Map(ids.map((id) => [id, []]));
  for (const aresta of arestas) {
    if (!conhecidos.has(aresta.de) || !conhecidos.has(aresta.para)) continue;
    saidas.get(aresta.de).push(aresta.para);
    entradas.get(aresta.para).push(aresta.de);
  }

  // 1. alcançável — todo nó é atingível a partir de no_inicial.
  const alcancados = percorrer(
    conhecidos.has(doc?.no_inicial) ? [doc.no_inicial] : [],
    (id) => saidas.get(id) ?? [],
  );
  for (const id of ids) {
    if (!alcancados.has(id)) violacoes.push({ regra: REGRAS.ALCANCAVEL, alvo: id });
  }

  // 2. termina — de todo nó existe caminho até algum nó final. Calculado de trás
  // para frente: quem chega ao fim é quem alcança um final andando nas arestas
  // invertidas. Nó preso em ciclo sem saída simplesmente nunca é atingido.
  const finais = (Array.isArray(doc?.nos_finais) ? doc.nos_finais : []).filter((id) => conhecidos.has(id));
  const chegamAoFim = percorrer(finais, (id) => entradas.get(id) ?? []);
  for (const id of ids) {
    if (!chegamAoFim.has(id)) violacoes.push({ regra: REGRAS.TERMINA, alvo: id });
  }

  // 3. aresta_com_condicao — nenhuma transição sem rótulo.
  for (const aresta of arestas) {
    if (!ehTextoPreenchido(aresta.condicao)) {
      violacoes.push({
        regra: REGRAS.ARESTA_COM_CONDICAO,
        alvo: { de: aresta.de ?? null, para: aresta.para ?? null },
      });
    }
  }

  // 4. no_com_contrato — vale para portão igual, que é nó como outro qualquer.
  for (const no of nos) {
    if (!temSkillRef(no) || !temContrato(no)) {
      violacoes.push({ regra: REGRAS.NO_COM_CONTRATO, alvo: no.id ?? null });
    }
  }

  return { valido: violacoes.length === 0, violacoes };
}

/** Busca em largura a partir de várias sementes; devolve o conjunto visitado. */
function percorrer(sementes, vizinhos) {
  const visitados = new Set(sementes);
  const fila = [...sementes];
  while (fila.length > 0) {
    for (const vizinho of vizinhos(fila.shift())) {
      if (visitados.has(vizinho)) continue;
      visitados.add(vizinho);
      fila.push(vizinho);
    }
  }
  return visitados;
}

function temSkillRef(no) {
  const ref = no.skill_ref;
  return ehObjeto(ref) && ehTextoPreenchido(ref.id) && ehTextoPreenchido(ref.versao) && ehTextoPreenchido(ref.hash);
}

function temContrato(no) {
  const contrato = no.contrato;
  return (
    ehObjeto(contrato) &&
    ehObjeto(contrato.entrada_schema) &&
    ehObjeto(contrato.saida_schema) &&
    Array.isArray(contrato.verificacoes) &&
    contrato.verificacoes.length > 0
  );
}

/**
 * Lê e parseia um documento de grafo do disco.
 *
 * @param {string} caminho Caminho do arquivo JSON.
 * @returns {unknown} Documento parseado.
 */
export function carregarGrafo(caminho) {
  return JSON.parse(readFileSync(caminho, 'utf8'));
}

/** Roda as duas validações e devolve o relatório combinado. */
export function validarGrafo(doc) {
  const estrutura = validarEstrutura(doc);
  const soundness = validarSoundness(doc);
  return { valido: estrutura.valido && soundness.valido, estrutura, soundness };
}

function principal(caminhos) {
  if (caminhos.length === 0) {
    console.error('uso: node scripts/validar-grafo.mjs <grafo.json> [...]');
    return 2;
  }
  let houveFalha = false;
  for (const caminho of caminhos) {
    let relatorio;
    try {
      relatorio = validarGrafo(carregarGrafo(caminho));
    } catch (erro) {
      console.error(`✖ ${caminho}: não deu para ler o documento — ${erro.message}`);
      houveFalha = true;
      continue;
    }
    if (relatorio.valido) {
      console.log(`✔ ${caminho}`);
      continue;
    }
    houveFalha = true;
    console.error(`✖ ${caminho}`);
    for (const erro of relatorio.estrutura.erros) {
      console.error(`  estrutura  ${erro.codigo}: ${erro.mensagem}`);
    }
    for (const violacao of relatorio.soundness.violacoes) {
      console.error(`  soundness  ${violacao.regra}: ${JSON.stringify(violacao.alvo)}`);
    }
  }
  return houveFalha ? 1 : 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = principal(process.argv.slice(2));
}
