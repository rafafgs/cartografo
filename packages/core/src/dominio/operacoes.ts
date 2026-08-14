/**
 * Vocabulário de operações semânticas sobre o documento de grafo (t101, FR4).
 *
 * D15: uma proposta é um diff SEMÂNTICO — lista de operações tipadas, cada uma
 * carregando a própria inversa — e não um diff de linha. É o que torna possível
 * julgar uma proposta ("acrescenta um portão de red team antes de implantar")
 * em vez de ler um patch, e o que dá caminho de volta a qualquer mudança.
 *
 * Cinco operações, o mínimo que prova o ciclo aplicar/soundness/reverter dos
 * critérios de aceite. NÃO é o vocabulário final do topógrafo: crescer é
 * aditivo, e a regra dos dois consumidores diz para esperar o t110 pressionar
 * com um caso real antes de congelar.
 *
 * Duas fronteiras deliberadas:
 *
 * - **Validar é estrutural.** `validarOperacao` confere chaves, tipos e a
 *   compatibilidade da inversa. Ela NÃO impede a operação de produzir um grafo
 *   quebrado: quem reprova isso é o portão de soundness, depois de aplicar
 *   (FR8). Uma aresta com `condicao: ""` é operação bem formada e grafo não
 *   sound — os dois julgamentos são de camadas diferentes.
 * - **Executar a inversa fica fora desta ticket** (promoção/oferta entre
 *   variante e base, t118). Aqui a inversa só precisa existir e casar com a
 *   operação; ninguém a aplica ainda.
 */

import type { ArestaGrafo, DocumentoGrafo, NoGrafo } from './grafo.ts';

/** Campos de nó que `alterar_campo_no` pode trocar. */
export const CAMPOS_ALTERAVEIS = Object.freeze(['papel', 'descricao', 'skill_ref', 'contrato']);

/** Um campo trocável por `alterar_campo_no`. */
export type CampoAlteravel = 'papel' | 'descricao' | 'skill_ref' | 'contrato';

/** Ponta a ponta de uma aresta — o que identifica a aresta na remoção. */
export interface ReferenciaDeAresta {
  de: string;
  para: string;
}

export interface InversaAdicionarNo {
  tipo: 'adicionar_no';
  no: NoGrafo;
}

export interface InversaRemoverNo {
  tipo: 'remover_no';
  no_id: string;
}

export interface InversaAdicionarAresta {
  tipo: 'adicionar_aresta';
  aresta: ArestaGrafo;
}

export interface InversaRemoverAresta {
  tipo: 'remover_aresta';
  aresta: ReferenciaDeAresta;
}

export interface InversaAlterarCampoNo {
  tipo: 'alterar_campo_no';
  no_id: string;
  campo: CampoAlteravel;
  de: unknown;
  para: unknown;
}

export interface OperacaoAdicionarNo {
  tipo: 'adicionar_no';
  no: NoGrafo;
  inversa: InversaRemoverNo;
}

export interface OperacaoRemoverNo {
  tipo: 'remover_no';
  no_id: string;
  inversa: InversaAdicionarNo;
}

export interface OperacaoAdicionarAresta {
  tipo: 'adicionar_aresta';
  aresta: ArestaGrafo;
  inversa: InversaRemoverAresta;
}

export interface OperacaoRemoverAresta {
  tipo: 'remover_aresta';
  aresta: ReferenciaDeAresta;
  inversa: InversaAdicionarAresta;
}

export interface OperacaoAlterarCampoNo {
  tipo: 'alterar_campo_no';
  no_id: string;
  campo: CampoAlteravel;
  /** Valor anterior. Documental: é o que monta a inversa, não uma trava. */
  de: unknown;
  para: unknown;
  inversa: InversaAlterarCampoNo;
}

/** Uma operação semântica com sua inversa. */
export type Operacao =
  | OperacaoAdicionarNo
  | OperacaoRemoverNo
  | OperacaoAdicionarAresta
  | OperacaoRemoverAresta
  | OperacaoAlterarCampoNo;

/** Os cinco tipos, na ordem em que a especificação os apresenta. */
export const TIPOS_DE_OPERACAO = Object.freeze([
  'adicionar_no',
  'remover_no',
  'adicionar_aresta',
  'remover_aresta',
  'alterar_campo_no',
]);

/** Qual tipo desfaz qual. `alterar_campo_no` é a própria inversa (de/para trocados). */
const INVERSA_ESPERADA: Record<string, string> = {
  adicionar_no: 'remover_no',
  remover_no: 'adicionar_no',
  adicionar_aresta: 'remover_aresta',
  remover_aresta: 'adicionar_aresta',
  alterar_campo_no: 'alterar_campo_no',
};

/** Um problema de forma na operação. */
export interface ErroDeOperacao {
  codigo: string;
  mensagem: string;
}

export interface RelatorioDeOperacao {
  valido: boolean;
  erros: ErroDeOperacao[];
}

/** Falha ao APLICAR uma operação bem formada a um snapshot que não a comporta. */
export class ErroDeAplicacao extends Error {
  readonly codigo: string;
  readonly alvo: unknown;

  constructor(codigo: string, mensagem: string, alvo: unknown = null) {
    super(mensagem);
    this.name = 'ErroDeAplicacao';
    this.codigo = codigo;
    this.alvo = alvo;
  }
}

type Registro = Record<string, unknown>;

function ehObjeto(valor: unknown): valor is Registro {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function ehTextoPreenchido(valor: unknown): valor is string {
  return typeof valor === 'string' && valor.trim() !== '';
}

/**
 * Confere a forma de uma operação e da inversa que ela carrega.
 *
 * @param operacao Operação já parseada (não confiável: vem do corpo HTTP ou da
 *   coluna `proposta.operacoes`).
 * @returns Relatório com todos os problemas de forma encontrados.
 */
export function validarOperacao(operacao: unknown): RelatorioDeOperacao {
  const erros: ErroDeOperacao[] = [];
  const anotar = (codigo: string, mensagem: string): void => {
    erros.push({ codigo, mensagem });
  };

  if (!ehObjeto(operacao)) {
    anotar('operacao_invalida', 'operação precisa ser um objeto JSON');
    return { valido: false, erros };
  }

  const tipo = operacao.tipo;
  if (typeof tipo !== 'string' || !TIPOS_DE_OPERACAO.includes(tipo)) {
    anotar(
      'tipo_desconhecido',
      `tipo de operação desconhecido: ${JSON.stringify(tipo)} (conhecidos: ${TIPOS_DE_OPERACAO.join(', ')})`,
    );
    return { valido: false, erros };
  }

  conferirCorpo(tipo, operacao, 'operação', anotar);

  const inversa = operacao.inversa;
  if (inversa === undefined || inversa === null) {
    anotar('inversa_ausente', `operação "${tipo}" precisa declarar a própria inversa (D15)`);
    return { valido: erros.length === 0, erros };
  }
  if (!ehObjeto(inversa)) {
    anotar('inversa_invalida', 'a inversa precisa ser um objeto JSON');
    return { valido: false, erros };
  }
  if (inversa.tipo !== INVERSA_ESPERADA[tipo]) {
    anotar(
      'inversa_incompativel',
      `a inversa de "${tipo}" precisa ser do tipo "${INVERSA_ESPERADA[tipo]}", veio ${JSON.stringify(inversa.tipo)}`,
    );
    return { valido: false, erros };
  }

  conferirCorpo(INVERSA_ESPERADA[tipo], inversa, 'inversa', anotar);
  conferirAlvoDaInversa(tipo, operacao, inversa, anotar);

  return { valido: erros.length === 0, erros };
}

type Anotador = (codigo: string, mensagem: string) => void;

/** Chaves e tipos que cada tipo de operação exige de si mesmo. */
function conferirCorpo(tipo: string, corpo: Registro, papel: string, anotar: Anotador): void {
  const exigirNoId = (): void => {
    if (!ehTextoPreenchido(corpo.no_id)) {
      anotar('campo_invalido', `${papel} "${tipo}": "no_id" precisa ser um id de nó preenchido`);
    }
  };
  const exigirNo = (): void => {
    if (!ehObjeto(corpo.no) || !ehTextoPreenchido(corpo.no.id)) {
      anotar('campo_invalido', `${papel} "${tipo}": "no" precisa ser um objeto com "id"`);
    }
  };
  const exigirPontas = (): void => {
    const aresta = corpo.aresta;
    if (!ehObjeto(aresta) || !ehTextoPreenchido(aresta.de) || !ehTextoPreenchido(aresta.para)) {
      anotar('campo_invalido', `${papel} "${tipo}": "aresta" precisa ter "de" e "para"`);
      return;
    }
    // `condicao` só é exigida em aresta que ENTRA no documento. Exigi-la como
    // string (mesmo vazia) e não como texto preenchido é o que deixa o rótulo
    // faltando chegar até o portão de soundness, onde ele é reprovado com o
    // nome da regra em vez de virar um 400 genérico.
    if (tipo === 'adicionar_aresta' && typeof aresta.condicao !== 'string') {
      anotar('campo_invalido', `${papel} "${tipo}": "aresta.condicao" precisa ser uma string`);
    }
  };

  switch (tipo) {
    case 'adicionar_no':
      exigirNo();
      break;
    case 'remover_no':
      exigirNoId();
      break;
    case 'adicionar_aresta':
    case 'remover_aresta':
      exigirPontas();
      break;
    case 'alterar_campo_no':
      exigirNoId();
      if (typeof corpo.campo !== 'string' || !CAMPOS_ALTERAVEIS.includes(corpo.campo)) {
        anotar(
          'campo_nao_alteravel',
          `${papel} "alterar_campo_no": "campo" precisa ser um de ${CAMPOS_ALTERAVEIS.join(', ')} — trocar id ou tipo_no é operação própria, não troca de campo`,
        );
      }
      for (const chave of ['de', 'para']) {
        if (!Object.hasOwn(corpo, chave)) {
          anotar('campo_obrigatorio_ausente', `${papel} "alterar_campo_no": falta "${chave}"`);
        }
      }
      break;
    default:
      break;
  }
}

/** A inversa precisa desfazer O MESMO alvo — inversa de outro nó não é inversa. */
function conferirAlvoDaInversa(
  tipo: string,
  operacao: Registro,
  inversa: Registro,
  anotar: Anotador,
): void {
  const incompativel = (detalhe: string): void => {
    anotar('inversa_incompativel', `a inversa de "${tipo}" ${detalhe}`);
  };

  const pontas = (valor: unknown): string =>
    ehObjeto(valor) ? `${String(valor.de)}→${String(valor.para)}` : 'inválida';

  switch (tipo) {
    case 'adicionar_no': {
      const id = ehObjeto(operacao.no) ? operacao.no.id : undefined;
      if (inversa.no_id !== id) incompativel(`precisa remover o nó "${String(id)}"`);
      break;
    }
    case 'remover_no': {
      const id = ehObjeto(inversa.no) ? inversa.no.id : undefined;
      if (id !== operacao.no_id) incompativel(`precisa readicionar o nó "${String(operacao.no_id)}"`);
      break;
    }
    case 'adicionar_aresta':
    case 'remover_aresta': {
      if (pontas(operacao.aresta) !== pontas(inversa.aresta)) {
        incompativel(`precisa apontar para a mesma aresta (${pontas(operacao.aresta)})`);
      }
      break;
    }
    case 'alterar_campo_no': {
      if (inversa.no_id !== operacao.no_id || inversa.campo !== operacao.campo) {
        incompativel(
          `precisa alterar o mesmo campo do mesmo nó ("${String(operacao.no_id)}"."${String(operacao.campo)}")`,
        );
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Aplica a lista de operações, em ordem, sobre uma cópia profunda do documento.
 *
 * Nunca muta o documento de entrada: o snapshot da versão-alvo continua sendo o
 * que está no banco, aconteça o que acontecer com o resultado.
 *
 * Alvo que não existe estoura `ErroDeAplicacao` em vez de virar no-op silencioso
 * — uma proposta que remove um nó já removido está falando de outra versão do
 * grafo, e transformar isso em "aplicou, nada mudou" gravaria uma versão nova
 * mentindo sobre o que aconteceu. Id de nó é a identidade do documento (por ele
 * apontam arestas, telemetria e propostas), então adicionar um id que já existe
 * também é erro de aplicação; aresta repetida não é — duas transições iguais são
 * redundância, não colisão de identidade, e quem reclama disso é o portão.
 *
 * @param documento Snapshot da versão-alvo, já validado.
 * @param operacoes Operações da proposta, em ordem.
 * @returns Documento novo, ainda NÃO validado — validar é do chamador (FR8).
 * @throws {ErroDeAplicacao} Operação malformada ou inaplicável a este snapshot.
 */
export function aplicarOperacoes(
  documento: DocumentoGrafo,
  operacoes: readonly Operacao[],
): DocumentoGrafo {
  const resultado = structuredClone(documento) as DocumentoGrafo;
  resultado.nos = Array.isArray(resultado.nos) ? resultado.nos : [];
  resultado.arestas = Array.isArray(resultado.arestas) ? resultado.arestas : [];

  operacoes.forEach((operacao, indice) => {
    const relatorio = validarOperacao(operacao);
    if (!relatorio.valido) {
      throw new ErroDeAplicacao(
        'operacao_invalida',
        `operação #${indice} está malformada: ${relatorio.erros.map((erro) => erro.mensagem).join('; ')}`,
        indice,
      );
    }

    switch (operacao.tipo) {
      case 'adicionar_no': {
        if (resultado.nos.some((no) => no.id === operacao.no.id)) {
          throw new ErroDeAplicacao(
            'no_duplicado',
            `o nó "${operacao.no.id}" já existe no snapshot`,
            operacao.no.id,
          );
        }
        resultado.nos.push(structuredClone(operacao.no));
        break;
      }
      case 'remover_no': {
        const posicao = resultado.nos.findIndex((no) => no.id === operacao.no_id);
        if (posicao === -1) {
          throw new ErroDeAplicacao(
            'no_inexistente',
            `o nó "${operacao.no_id}" não existe no snapshot`,
            operacao.no_id,
          );
        }
        resultado.nos.splice(posicao, 1);
        break;
      }
      case 'adicionar_aresta': {
        resultado.arestas.push(structuredClone(operacao.aresta));
        break;
      }
      case 'remover_aresta': {
        const posicao = resultado.arestas.findIndex(
          (aresta) => aresta.de === operacao.aresta.de && aresta.para === operacao.aresta.para,
        );
        if (posicao === -1) {
          throw new ErroDeAplicacao(
            'aresta_inexistente',
            `a aresta "${operacao.aresta.de}"→"${operacao.aresta.para}" não existe no snapshot`,
            { de: operacao.aresta.de, para: operacao.aresta.para },
          );
        }
        resultado.arestas.splice(posicao, 1);
        break;
      }
      case 'alterar_campo_no': {
        const no = resultado.nos.find((candidato) => candidato.id === operacao.no_id);
        if (no === undefined) {
          throw new ErroDeAplicacao(
            'no_inexistente',
            `o nó "${operacao.no_id}" não existe no snapshot`,
            operacao.no_id,
          );
        }
        (no as Registro)[operacao.campo] = structuredClone(operacao.para);
        break;
      }
    }
  });

  return resultado;
}
