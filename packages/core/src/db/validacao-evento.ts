/**
 * Validação do envelope de evento e do payload de cada tipo (t102, FR3).
 *
 * Espelha em TypeScript os schemas de `especificacoes/eventos/schemas/`. A
 * duplicação é deliberada e está registrada na ficha: carregar aqueles `.json`
 * em runtime acoplaria `packages/core` a um caminho fora do pacote e traria um
 * validador genérico para a superfície de dependências do control plane, para
 * validar dez formatos que cabem numa tabela. Se a regra duplicada virar dor de
 * manutenção, adotar `ajv` é decisão de outra ficha — e este arquivo é o único
 * lugar que muda.
 *
 * Nenhum evento entra no log sem passar por aqui: é a versão "no contrato, no
 * registro" da D9 aplicada à telemetria. E a validação acontece ANTES de
 * qualquer escrita, para que uma requisição inválida não deixe rastro nenhum —
 * nem linha de projeção, nem evento.
 */

/** Sujeitos possíveis de um evento (`envelope.schema.json`). */
export type TipoEntidade = 'trabalho' | 'sessao' | 'pergunta' | 'lease' | 'grafo_versao';

/** Quem causou o evento. Paridade com o `ActorType` do flowpilot. */
export type TipoAtor = 'usuario' | 'agente' | 'sistema';

/** O sujeito do evento — a chave de join da telemetria com o resto do banco. */
export interface Entidade {
  tipo: TipoEntidade;
  /** Inteiro para trabalho/sessao/pergunta/lease; string (hash) para grafo_versao (D15). */
  id: number | string;
}

/** Quem causou o evento. */
export interface Ator {
  tipo: TipoAtor;
  ref: string;
}

/**
 * Evento pronto para gravar — o envelope inteiro MENOS o `id`.
 *
 * O `id` é a ordem do log e a única ordenação total que existe; quem o atribui
 * é o servidor, e por isso ele nunca aparece na entrada.
 */
export interface EventoParaGravar {
  tipo: string;
  projeto_id: number;
  execucao_id: number | null;
  entidade: Entidade;
  ator: Ator;
  ocorrido_em: string;
  dados: Record<string, unknown>;
}

/** Evento como ele existe no log, já com o id do servidor. */
export interface Evento extends EventoParaGravar {
  id: number;
}

/** Resultado da validação: ou o evento normalizado, ou a lista inteira de erros. */
export type ResultadoValidacao =
  | { valido: true; evento: EventoParaGravar }
  | { valido: false; erros: string[] };

/** Falha de validação de evento. As rotas a traduzem em 400. */
export class ErroDeValidacao extends Error {
  /** Todos os problemas encontrados, não só o primeiro. */
  readonly erros: string[];

  constructor(erros: string[]) {
    super(`evento inválido: ${erros.join('; ')}`);
    this.name = 'ErroDeValidacao';
    this.erros = erros;
  }
}

const TIPOS_ENTIDADE: readonly TipoEntidade[] = [
  'trabalho',
  'sessao',
  'pergunta',
  'lease',
  'grafo_versao',
];

const TIPOS_ATOR: readonly TipoAtor[] = ['usuario', 'agente', 'sistema'];

const CAMPOS_ENVELOPE = [
  'tipo',
  'projeto_id',
  'execucao_id',
  'entidade',
  'ator',
  'ocorrido_em',
  'dados',
] as const;

/** Como um campo de `dados` é verificado. */
interface RegraCampo {
  /** Forma esperada do valor. */
  forma: 'string' | 'inteiro' | 'booleano' | 'lista-de-strings' | 'uso';
  /** Ausente/null é aceito? */
  obrigatorio: boolean;
  /** Conjunto fechado de valores, quando o schema declara `enum`. */
  valores?: readonly string[];
  /** Piso, para inteiros não negativos (`timeout_seconds`, tokens). */
  minimo?: number;
  /** Mínimo de itens, para listas (`campos_alterados` tem `minItems: 1`). */
  minimoItens?: number;
  /** A lista precisa ter itens únicos? */
  unicos?: boolean;
}

/** O contrato de um tipo de evento: de quem ele fala e o que carrega. */
interface RegraTipo {
  entidade: TipoEntidade;
  campos: Record<string, RegraCampo>;
}

const obrigatorio = (forma: RegraCampo['forma'], extra: Partial<RegraCampo> = {}): RegraCampo => ({
  forma,
  obrigatorio: true,
  ...extra,
});

const opcional = (forma: RegraCampo['forma'], extra: Partial<RegraCampo> = {}): RegraCampo => ({
  forma,
  obrigatorio: false,
  ...extra,
});

/**
 * Os 9 tipos desta ficha, na ordem da taxonomia.
 *
 * Os outros 6 do catálogo ficam para quem é dono deles: `lease.*` é de t103
 * (runner e controller) e `grafo_versao.*` é de t101 — cada um entra aqui junto
 * com o código que os emite, nunca antes.
 */
const REGRAS: Record<string, RegraTipo> = {
  'trabalho.criado': {
    entidade: 'trabalho',
    campos: {
      titulo: obrigatorio('string'),
      no_entrada_id: obrigatorio('string'),
    },
  },
  'trabalho.transicao': {
    entidade: 'trabalho',
    campos: {
      de_no_id: opcional('string'),
      para_no_id: obrigatorio('string'),
    },
  },
  'trabalho.bloqueado': {
    entidade: 'trabalho',
    campos: { motivo: obrigatorio('string') },
  },
  'trabalho.desbloqueado': {
    entidade: 'trabalho',
    campos: {},
  },
  'trabalho.emendado': {
    entidade: 'trabalho',
    campos: {
      campos_alterados: obrigatorio('lista-de-strings', { minimoItens: 1, unicos: true }),
    },
  },
  'sessao.aberta': {
    entidade: 'sessao',
    campos: {
      trabalho_id: opcional('inteiro'),
      no_id: opcional('string'),
      engine: obrigatorio('string'),
      engine_session_ref: opcional('string'),
      working_dir: obrigatorio('string'),
      prompt: obrigatorio('string'),
      timeout_seconds: opcional('inteiro', { minimo: 0 }),
    },
  },
  'sessao.finalizada': {
    entidade: 'sessao',
    campos: {
      status: obrigatorio('string', {
        valores: [
          'concluida',
          'falhou',
          'travada',
          'tempo_esgotado',
          'pausada_cota',
          'retomada_falhou',
        ],
      }),
      exit_code: opcional('inteiro'),
      uso: opcional('uso'),
    },
  },
  'pergunta.criada': {
    entidade: 'pergunta',
    campos: {
      trabalho_id: obrigatorio('inteiro'),
      sessao_id: opcional('inteiro'),
      tipo: obrigatorio('string', { valores: ['pergunta', 'aprovacao'] }),
      pergunta: obrigatorio('string'),
      contexto: opcional('string'),
      opcoes: opcional('lista-de-strings'),
      recomendacao: opcional('string'),
      resposta_padrao: opcional('string'),
      auto_aprovavel: obrigatorio('booleano'),
    },
  },
  'pergunta.respondida': {
    entidade: 'pergunta',
    campos: {
      resposta: obrigatorio('string'),
      respondido_por: obrigatorio('string'),
    },
  },
  'pergunta.auto_resolvida': {
    entidade: 'pergunta',
    campos: {
      resposta: obrigatorio('string'),
      baseada_em: obrigatorio('string', {
        valores: ['recomendacao', 'resposta_padrao', 'precedente'],
      }),
    },
  },
};

/** Os tipos de evento que o control plane sabe gravar hoje. */
export const TIPOS_CONHECIDOS: readonly string[] = Object.freeze(Object.keys(REGRAS));

/** Campos de `uso`, todos obrigatórios quando `uso` não é null. */
const CAMPOS_USO = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
] as const;

const ehObjeto = (valor: unknown): valor is Record<string, unknown> =>
  typeof valor === 'object' && valor !== null && !Array.isArray(valor);

const ehInteiro = (valor: unknown): valor is number =>
  typeof valor === 'number' && Number.isInteger(valor);

const ausente = (valor: unknown): boolean => valor === undefined || valor === null;

/** Valida `dados.uso` (objeto de tokens ou null). */
function validarUso(caminho: string, valor: unknown, erros: string[]): void {
  if (!ehObjeto(valor)) {
    erros.push(`${caminho} precisa ser um objeto de totais de tokens ou null`);
    return;
  }
  for (const campo of CAMPOS_USO) {
    const total = valor[campo];
    if (!ehInteiro(total) || total < 0) {
      erros.push(`${caminho}.${campo} precisa ser um inteiro >= 0`);
    }
  }
  for (const chave of Object.keys(valor)) {
    if (!CAMPOS_USO.includes(chave as (typeof CAMPOS_USO)[number])) {
      erros.push(`${caminho}.${chave} não existe no contrato de uso`);
    }
  }
}

/** Valida um campo de `dados` contra a regra dele. */
function validarCampo(caminho: string, regra: RegraCampo, valor: unknown, erros: string[]): void {
  switch (regra.forma) {
    case 'string':
      if (typeof valor !== 'string' || valor.length === 0) {
        erros.push(`${caminho} precisa ser uma string não vazia`);
        return;
      }
      if (regra.valores !== undefined && !regra.valores.includes(valor)) {
        erros.push(`${caminho} precisa ser um de: ${regra.valores.join(', ')}`);
      }
      return;

    case 'inteiro':
      if (!ehInteiro(valor)) {
        erros.push(`${caminho} precisa ser um inteiro`);
        return;
      }
      if (regra.minimo !== undefined && valor < regra.minimo) {
        erros.push(`${caminho} precisa ser >= ${regra.minimo}`);
      }
      return;

    case 'booleano':
      if (typeof valor !== 'boolean') erros.push(`${caminho} precisa ser true ou false`);
      return;

    case 'lista-de-strings': {
      if (!Array.isArray(valor) || valor.some((item) => typeof item !== 'string')) {
        erros.push(`${caminho} precisa ser uma lista de strings`);
        return;
      }
      if (regra.minimoItens !== undefined && valor.length < regra.minimoItens) {
        erros.push(`${caminho} precisa ter pelo menos ${regra.minimoItens} item(ns)`);
      }
      if (regra.unicos === true && new Set(valor).size !== valor.length) {
        erros.push(`${caminho} não pode repetir itens`);
      }
      return;
    }

    case 'uso':
      validarUso(caminho, valor, erros);
      return;
  }
}

/**
 * Valida `dados` contra a regra do tipo e devolve a versão normalizada.
 *
 * Normalizar significa: todo campo declarado pelo tipo aparece no payload
 * gravado, com `null` explícito quando o cliente não mandou. Um log em que
 * "campo ausente" e "campo null" são a mesma coisa é um log que se compara com
 * `deepEqual` sem cerimônia.
 */
function validarDados(
  tipo: string,
  regra: RegraTipo,
  dados: Record<string, unknown>,
  erros: string[],
): Record<string, unknown> {
  const normalizado: Record<string, unknown> = {};

  for (const [nome, regraCampo] of Object.entries(regra.campos)) {
    const valor = dados[nome];
    if (ausente(valor)) {
      if (regraCampo.obrigatorio) erros.push(`dados.${nome} é obrigatório`);
      else normalizado[nome] = null;
      continue;
    }
    validarCampo(`dados.${nome}`, regraCampo, valor, erros);
    normalizado[nome] = valor;
  }

  for (const chave of Object.keys(dados)) {
    if (!(chave in regra.campos) && !ausente(dados[chave])) {
      erros.push(`dados.${chave} não existe no contrato de "${tipo}"`);
    }
  }

  return normalizado;
}

/** Valida `entidade` contra o envelope e contra o tipo do evento. */
function validarEntidade(valor: unknown, esperado: TipoEntidade | null, erros: string[]): void {
  if (!ehObjeto(valor)) {
    erros.push('entidade precisa ser um objeto {tipo, id}');
    return;
  }
  const tipo = valor.tipo;
  if (typeof tipo !== 'string' || !TIPOS_ENTIDADE.includes(tipo as TipoEntidade)) {
    erros.push(`entidade.tipo precisa ser um de: ${TIPOS_ENTIDADE.join(', ')}`);
  } else if (esperado !== null && tipo !== esperado) {
    erros.push(`entidade.tipo precisa ser "${esperado}" para este tipo de evento`);
  }

  // grafo_versao é o único cujo id é hash de snapshot (D15); os outros são
  // inteiros das próprias tabelas.
  const id = valor.id;
  if (tipo === 'grafo_versao') {
    if (typeof id !== 'string' || id.length === 0) {
      erros.push('entidade.id de grafo_versao precisa ser o hash do snapshot (string)');
    }
  } else if (!ehInteiro(id) || id < 1) {
    erros.push('entidade.id precisa ser um inteiro >= 1');
  }

  for (const chave of Object.keys(valor)) {
    if (chave !== 'tipo' && chave !== 'id') erros.push(`entidade.${chave} não existe no envelope`);
  }
}

/** Valida `ator` contra o envelope. */
function validarAtor(valor: unknown, erros: string[]): void {
  if (!ehObjeto(valor)) {
    erros.push('ator precisa ser um objeto {tipo, ref}');
    return;
  }
  if (typeof valor.tipo !== 'string' || !TIPOS_ATOR.includes(valor.tipo as TipoAtor)) {
    erros.push(`ator.tipo precisa ser um de: ${TIPOS_ATOR.join(', ')}`);
  }
  if (typeof valor.ref !== 'string' || valor.ref.length === 0) {
    erros.push('ator.ref precisa ser uma string não vazia');
  }
  for (const chave of Object.keys(valor)) {
    if (chave !== 'tipo' && chave !== 'ref') erros.push(`ator.${chave} não existe no envelope`);
  }
}

/**
 * Valida um evento inteiro antes de ele existir no log.
 *
 * @param entrada Candidato a evento, ainda sem `id`.
 * @returns O evento normalizado, ou TODOS os erros encontrados — nunca só o
 *   primeiro: quem monta um envelope errado costuma errar em mais de um campo,
 *   e devolver um de cada vez transforma a correção em tentativa e erro.
 */
export function validarEvento(entrada: unknown): ResultadoValidacao {
  const erros: string[] = [];

  if (!ehObjeto(entrada)) {
    return { valido: false, erros: ['evento precisa ser um objeto'] };
  }

  if ('id' in entrada) {
    erros.push('id não pode vir na entrada: é o servidor que o atribui (envelope, FR1)');
  }
  for (const chave of Object.keys(entrada)) {
    if (chave !== 'id' && !CAMPOS_ENVELOPE.includes(chave as (typeof CAMPOS_ENVELOPE)[number])) {
      erros.push(`${chave} não existe no envelope`);
    }
  }

  const tipo = entrada.tipo;
  const regra = typeof tipo === 'string' ? REGRAS[tipo] : undefined;
  if (typeof tipo !== 'string' || regra === undefined) {
    erros.push(
      `tipo desconhecido: ${JSON.stringify(tipo)} (conhecidos: ${TIPOS_CONHECIDOS.join(', ')})`,
    );
  }

  if (!ehInteiro(entrada.projeto_id)) erros.push('projeto_id precisa ser um inteiro');

  if (!ausente(entrada.execucao_id) && !ehInteiro(entrada.execucao_id)) {
    erros.push('execucao_id precisa ser um inteiro ou null');
  }

  validarEntidade(entrada.entidade, regra?.entidade ?? null, erros);
  validarAtor(entrada.ator, erros);

  const ocorridoEm = entrada.ocorrido_em;
  if (typeof ocorridoEm !== 'string' || Number.isNaN(Date.parse(ocorridoEm))) {
    erros.push('ocorrido_em precisa ser um instante ISO 8601');
  }

  if (!ehObjeto(entrada.dados)) {
    erros.push('dados precisa ser um objeto');
  }

  let dados: Record<string, unknown> = {};
  if (regra !== undefined && ehObjeto(entrada.dados)) {
    dados = validarDados(tipo as string, regra, entrada.dados, erros);
  }

  if (erros.length > 0) return { valido: false, erros };

  return {
    valido: true,
    evento: {
      tipo: tipo as string,
      projeto_id: entrada.projeto_id as number,
      execucao_id: ausente(entrada.execucao_id) ? null : (entrada.execucao_id as number),
      entidade: entrada.entidade as unknown as Entidade,
      ator: entrada.ator as unknown as Ator,
      ocorrido_em: ocorridoEm as string,
      dados,
    },
  };
}

/**
 * Valida SÓ o payload de um tipo, sem o envelope em volta.
 *
 * Existe porque na criação de uma entidade o `entidade.id` do envelope só nasce
 * depois do insert da projeção, e o 400 de "campo obrigatório faltando" (FR3)
 * tem que acontecer ANTES de qualquer escrita. Quem cria chama isto primeiro e
 * `registrarEvento` depois — que revalida o envelope inteiro, já com o id.
 *
 * @param tipo Tipo do evento.
 * @param dados Payload cru.
 * @returns Payload normalizado (opcionais ausentes viram `null`).
 * @throws {ErroDeValidacao} Quando o payload não fecha com o contrato do tipo.
 */
export function exigirDadosValidos(
  tipo: string,
  dados: Record<string, unknown>,
): Record<string, unknown> {
  const regra = REGRAS[tipo];
  if (regra === undefined) throw new ErroDeValidacao([`tipo desconhecido: ${JSON.stringify(tipo)}`]);

  const erros: string[] = [];
  const normalizado = validarDados(tipo, regra, dados, erros);
  if (erros.length > 0) throw new ErroDeValidacao(erros);
  return normalizado;
}

/**
 * Como `validarEvento`, mas estoura em vez de devolver o resultado.
 *
 * @param entrada Candidato a evento.
 * @returns O evento normalizado.
 * @throws {ErroDeValidacao} Quando algo não fecha com o contrato.
 */
export function exigirEventoValido(entrada: unknown): EventoParaGravar {
  const resultado = validarEvento(entrada);
  if (!resultado.valido) throw new ErroDeValidacao(resultado.erros);
  return resultado.evento;
}
