/**
 * Validação do documento de grafo dentro do control plane (t101, FR2).
 *
 * Porte tipado de `scripts/validar-grafo.mjs` (t96). O script é o validador de
 * referência do repositório, mas fica fora da árvore publicável do pacote
 * (`files` em `package.json`): o core não pode importá-lo sem levar junto uma
 * dependência que o `npm pack` não empacota. Por isso as duas funções vivem
 * aqui — e por isso `test/dominio-grafo.test.ts` roda os mesmos fixtures nos
 * dois validadores e exige relatórios idênticos (AT1). Qualquer mudança de
 * regra tem que acontecer nos dois lugares, ou o teste de paridade cai.
 *
 * Duas checagens, deliberadamente separadas:
 *
 * - `validarEstrutura` — forma e integridade referencial;
 * - `validarSoundness` — as quatro regras formais de workflow net.
 *
 * Nenhuma das duas lança exceção em documento malformado: quem chama precisa do
 * relatório inteiro do que está errado, não do primeiro erro. É isso que a API
 * devolve no 422.
 */

/** Nomes das quatro regras de soundness, na ordem em que rodam. */
export const REGRAS = Object.freeze({
  ALCANCAVEL: 'alcançável',
  TERMINA: 'termina',
  ARESTA_COM_CONDICAO: 'aresta_com_condicao',
  NO_COM_CONTRATO: 'no_com_contrato',
});

/**
 * Nó do documento, já validado.
 *
 * A gaveta aberta (`[chave: string]`) é intencional: o formato do grafo ainda
 * não congelou (regra dos dois consumidores), e o snapshot precisa atravessar o
 * banco sem perder chave que este pacote ainda não conhece.
 */
export interface NoGrafo {
  id: string;
  papel: string;
  tipo_no: string;
  descricao?: string;
  skill_ref: unknown;
  contrato: unknown;
  [chave: string]: unknown;
}

/** Aresta do documento, já validada. */
export interface ArestaGrafo {
  de: string;
  para: string;
  condicao: string;
  descricao?: string;
  [chave: string]: unknown;
}

/** Documento de grafo (o mesmo formato de `schema/grafo.schema.json`). */
export interface DocumentoGrafo {
  classe: string;
  linhagem: { tipo: string; base_classe?: string; origem_proposta_id?: string };
  metadata: Record<string, unknown>;
  nos: NoGrafo[];
  arestas: ArestaGrafo[];
  no_inicial: string;
  nos_finais: string[];
  [chave: string]: unknown;
}

/** Um problema de forma ou de integridade referencial. */
export interface ErroDeEstrutura {
  codigo: string;
  mensagem: string;
  alvo: unknown;
}

/** Uma regra de soundness quebrada, com o alvo que a quebrou. */
export interface ViolacaoDeSoundness {
  regra: string;
  alvo: unknown;
}

export interface RelatorioDeEstrutura {
  valido: boolean;
  erros: ErroDeEstrutura[];
}

export interface RelatorioDeSoundness {
  valido: boolean;
  violacoes: ViolacaoDeSoundness[];
}

/** Relatório combinado — é o corpo do 422 das rotas de grafo e de proposta. */
export interface RelatorioDeGrafo {
  valido: boolean;
  estrutura: RelatorioDeEstrutura;
  soundness: RelatorioDeSoundness;
}

type Registro = Record<string, unknown>;

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

function ehObjeto(valor: unknown): valor is Registro {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function ehTextoPreenchido(valor: unknown): valor is string {
  return typeof valor === 'string' && valor.trim() !== '';
}

/**
 * Confere forma e integridade referencial do documento.
 *
 * @param doc Documento de grafo já parseado (não confiável).
 * @returns Relatório com todos os problemas encontrados.
 */
export function validarEstrutura(doc: unknown): RelatorioDeEstrutura {
  const erros: ErroDeEstrutura[] = [];
  const anotar = (codigo: string, mensagem: string, alvo: unknown = null): void => {
    erros.push({ codigo, mensagem, alvo });
  };

  if (!ehObjeto(doc)) {
    anotar('documento_invalido', 'documento de grafo precisa ser um objeto JSON');
    return { valido: false, erros };
  }

  for (const campo of CAMPOS_OBRIGATORIOS_DOC) {
    if (doc[campo] === undefined || doc[campo] === null) {
      anotar(
        'campo_obrigatorio_ausente',
        `campo obrigatório ausente no documento: "${campo}"`,
        campo,
      );
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

  const nos: unknown[] = Array.isArray(doc.nos) ? doc.nos : [];
  const idsConhecidos = new Set<string>();
  const idsJaReportados = new Set<string>();

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

  const arestas: unknown[] = Array.isArray(doc.arestas) ? doc.arestas : [];
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
    anotar(
      'no_inicial_inexistente',
      `no_inicial referencia um nó que não existe: "${doc.no_inicial}"`,
      doc.no_inicial,
    );
  }

  const finais: unknown[] = Array.isArray(doc.nos_finais) ? doc.nos_finais : [];
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
 * @param doc Documento de grafo já parseado (não confiável).
 * @returns Relatório com todas as violações encontradas.
 */
export function validarSoundness(doc: unknown): RelatorioDeSoundness {
  const violacoes: ViolacaoDeSoundness[] = [];
  const documento = ehObjeto(doc) ? doc : {};
  const nos = Array.isArray(documento.nos) ? documento.nos.filter(ehObjeto) : [];
  const arestas = Array.isArray(documento.arestas) ? documento.arestas.filter(ehObjeto) : [];
  const ids = nos.map((no) => no.id).filter(ehTextoPreenchido);
  const conhecidos = new Set(ids);

  // Só arestas entre nós existentes entram na topologia; ponta solta é problema
  // de estrutura, e contá-la aqui inventaria alcançabilidade que não existe.
  const saidas = new Map<string, string[]>(ids.map((id) => [id, []]));
  const entradas = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const aresta of arestas) {
    const de = aresta.de;
    const para = aresta.para;
    if (!ehTextoPreenchido(de) || !ehTextoPreenchido(para)) continue;
    if (!conhecidos.has(de) || !conhecidos.has(para)) continue;
    saidas.get(de)?.push(para);
    entradas.get(para)?.push(de);
  }

  // 1. alcançável — todo nó é atingível a partir de no_inicial.
  const inicial = documento.no_inicial;
  const alcancados = percorrer(
    ehTextoPreenchido(inicial) && conhecidos.has(inicial) ? [inicial] : [],
    (id) => saidas.get(id) ?? [],
  );
  for (const id of ids) {
    if (!alcancados.has(id)) violacoes.push({ regra: REGRAS.ALCANCAVEL, alvo: id });
  }

  // 2. termina — de todo nó existe caminho até algum nó final. Calculado de trás
  // para frente: quem chega ao fim é quem alcança um final andando nas arestas
  // invertidas. Nó preso em ciclo sem saída simplesmente nunca é atingido.
  const declaradosFinais: unknown[] = Array.isArray(documento.nos_finais)
    ? documento.nos_finais
    : [];
  const finais = declaradosFinais.filter(
    (id): id is string => ehTextoPreenchido(id) && conhecidos.has(id),
  );
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

/**
 * Roda as duas validações e devolve o relatório combinado.
 *
 * @param doc Documento de grafo já parseado.
 * @returns Relatório de estrutura e de soundness, com o veredito conjunto.
 */
export function validarGrafo(doc: unknown): RelatorioDeGrafo {
  const estrutura = validarEstrutura(doc);
  const soundness = validarSoundness(doc);
  return { valido: estrutura.valido && soundness.valido, estrutura, soundness };
}

/** Busca em largura a partir de várias sementes; devolve o conjunto visitado. */
function percorrer(sementes: string[], vizinhos: (id: string) => string[]): Set<string> {
  const visitados = new Set(sementes);
  const fila = [...sementes];
  while (fila.length > 0) {
    const atual = fila.shift();
    if (atual === undefined) break;
    for (const vizinho of vizinhos(atual)) {
      if (visitados.has(vizinho)) continue;
      visitados.add(vizinho);
      fila.push(vizinho);
    }
  }
  return visitados;
}

function temSkillRef(no: Registro): boolean {
  const ref = no.skill_ref;
  return (
    ehObjeto(ref) &&
    ehTextoPreenchido(ref.id) &&
    ehTextoPreenchido(ref.versao) &&
    ehTextoPreenchido(ref.hash)
  );
}

function temContrato(no: Registro): boolean {
  const contrato = no.contrato;
  return (
    ehObjeto(contrato) &&
    ehObjeto(contrato.entrada_schema) &&
    ehObjeto(contrato.saida_schema) &&
    Array.isArray(contrato.verificacoes) &&
    contrato.verificacoes.length > 0
  );
}
