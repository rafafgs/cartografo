/**
 * Validador de bundle de fábrica (t105).
 *
 * Um bundle é um diretório com um `grafo.json` e um diretório `skills/` de
 * manifestos. Este módulo confere as três coisas que fazem dele um bundle
 * íntegro, e não só um punhado de JSON no mesmo lugar:
 *
 * 1. **O grafo é válido e sound** — delegado a `scripts/validar-grafo.mjs`
 *    (t96), que é quem tem as quatro regras de workflow net.
 * 2. **Cada manifesto vale contra o schema do formato** — o schema do t97,
 *    `especificacoes/formatos/manifesto-skill.schema.json`.
 * 3. **Cada pino fecha** — para todo nó do grafo existe um manifesto com o
 *    mesmo `id` e a mesma `versao`, e o hash recalculado do conteúdo bate com
 *    o que o `skill_ref` do nó pina (D4). É esta terceira checagem que impede
 *    a troca silenciosa do conteúdo de uma skill por baixo de um grafo já
 *    validado — e é o substituto verificável do "importa pela API" enquanto o
 *    control plane não existe (D6).
 *
 * Zero dependências: só módulos nativos do Node. O validador de JSON Schema
 * embutido cobre deliberadamente só o subconjunto de palavras-chave que o
 * schema do manifesto usa (`$ref` local, `type`, `enum`, `const`, `required`,
 * `properties`, `additionalProperties`, `items`, `pattern`, `minLength`,
 * `minItems`, `minimum`, `allOf`/`anyOf`/`oneOf`/`not`, `if`/`then`/`else`) —
 * validação completa por ajv entra com o scaffold TypeScript do control plane.
 * Até lá, a checagem cruzada é o `ajv-cli` da definição de pronto do t97.
 *
 * Uso como CLI: `node scripts/validar-bundle-fabrica.mjs <dir-do-bundle>`
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { validarGrafo } from './validar-grafo.mjs';

const RAIZ = path.resolve(import.meta.dirname, '..');

/** O schema do formato de manifesto (t97). É a definição normativa. */
export const CAMINHO_SCHEMA_MANIFESTO = path.join(
  RAIZ,
  'especificacoes',
  'formatos',
  'manifesto-skill.schema.json',
);

const ehObjeto = (valor) => typeof valor === 'object' && valor !== null && !Array.isArray(valor);

let schemaManifesto = null;

/** Lê o schema do manifesto uma vez por processo. */
function lerSchemaManifesto() {
  schemaManifesto ??= JSON.parse(readFileSync(CAMINHO_SCHEMA_MANIFESTO, 'utf8'));
  return schemaManifesto;
}

// --------------------------------------------------------------------------
// Validação contra JSON Schema (subconjunto — ver cabeçalho)
// --------------------------------------------------------------------------

function resolverRef(ref, raiz) {
  if (!ref.startsWith('#/')) throw new Error(`$ref não local não é suportado: ${ref}`);
  let alvo = raiz;
  for (const parte of ref.slice(2).split('/')) {
    alvo = alvo?.[parte.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  if (alvo === undefined) throw new Error(`$ref não resolve: ${ref}`);
  return alvo;
}

function tipoBate(valor, tipo) {
  switch (tipo) {
    case 'object':
      return ehObjeto(valor);
    case 'array':
      return Array.isArray(valor);
    case 'string':
      return typeof valor === 'string';
    case 'integer':
      return Number.isInteger(valor);
    case 'number':
      return typeof valor === 'number';
    case 'boolean':
      return typeof valor === 'boolean';
    case 'null':
      return valor === null;
    default:
      throw new Error(`tipo desconhecido no schema: ${tipo}`);
  }
}

/**
 * Valida uma instância contra um schema, devolvendo TODOS os erros.
 *
 * @param {unknown} instancia Documento a validar.
 * @param {object} schema Schema (ou subschema) a aplicar.
 * @param {object} [raiz] Raiz para resolver `$ref`; o próprio schema por padrão.
 * @param {string} [caminho] Caminho JSON pointer da instância, para a mensagem.
 * @returns {Array<{caminho: string, mensagem: string}>}
 */
export function validarContraSchema(instancia, schema, raiz = schema, caminho = '') {
  const erros = [];
  const anotar = (mensagem, onde = caminho) => erros.push({ caminho: onde || '/', mensagem });

  if (schema === true || schema === undefined) return erros;
  if (schema === false) {
    anotar('nenhum valor é aceito aqui');
    return erros;
  }
  if (schema.$ref !== undefined) {
    return validarContraSchema(instancia, resolverRef(schema.$ref, raiz), raiz, caminho);
  }

  if (schema.type !== undefined) {
    const tipos = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!tipos.some((tipo) => tipoBate(instancia, tipo))) {
      anotar(`tipo esperado ${tipos.join(' ou ')}, veio ${Array.isArray(instancia) ? 'array' : typeof instancia}`);
      return erros; // Sem o tipo certo, as demais palavras-chave só ecoariam.
    }
  }

  if (schema.const !== undefined && JSON.stringify(instancia) !== JSON.stringify(schema.const)) {
    anotar(`valor precisa ser ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(instancia))) {
    anotar(`valor fora do enum ${JSON.stringify(schema.enum)}`);
  }

  if (typeof instancia === 'string') {
    if (schema.minLength !== undefined && instancia.length < schema.minLength) {
      anotar(`string precisa ter pelo menos ${schema.minLength} caractere(s)`);
    }
    if (schema.maxLength !== undefined && instancia.length > schema.maxLength) {
      anotar(`string precisa ter no máximo ${schema.maxLength} caractere(s)`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(instancia)) {
      anotar(`string não casa com o pattern ${schema.pattern}`);
    }
  }

  if (typeof instancia === 'number') {
    if (schema.minimum !== undefined && instancia < schema.minimum) {
      anotar(`número precisa ser >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && instancia > schema.maximum) {
      anotar(`número precisa ser <= ${schema.maximum}`);
    }
  }

  if (Array.isArray(instancia)) {
    if (schema.minItems !== undefined && instancia.length < schema.minItems) {
      anotar(`lista precisa ter pelo menos ${schema.minItems} item(ns)`);
    }
    if (schema.maxItems !== undefined && instancia.length > schema.maxItems) {
      anotar(`lista precisa ter no máximo ${schema.maxItems} item(ns)`);
    }
    if (schema.uniqueItems === true) {
      const vistos = new Set(instancia.map((item) => JSON.stringify(item)));
      if (vistos.size !== instancia.length) anotar('lista precisa ter itens únicos');
    }
    if (schema.items !== undefined) {
      instancia.forEach((item, indice) => {
        erros.push(...validarContraSchema(item, schema.items, raiz, `${caminho}/${indice}`));
      });
    }
  }

  if (ehObjeto(instancia)) {
    for (const campo of schema.required ?? []) {
      if (!Object.hasOwn(instancia, campo)) anotar(`campo obrigatório ausente: "${campo}"`);
    }
    const declaradas = Object.keys(schema.properties ?? {});
    for (const [chave, valor] of Object.entries(instancia)) {
      if (declaradas.includes(chave)) {
        erros.push(...validarContraSchema(valor, schema.properties[chave], raiz, `${caminho}/${chave}`));
        continue;
      }
      if (schema.additionalProperties === false) {
        anotar(`campo não declarado pelo schema: "${chave}"`, `${caminho}/${chave}`);
      } else if (ehObjeto(schema.additionalProperties)) {
        erros.push(
          ...validarContraSchema(valor, schema.additionalProperties, raiz, `${caminho}/${chave}`),
        );
      }
    }
  }

  for (const sub of schema.allOf ?? []) {
    erros.push(...validarContraSchema(instancia, sub, raiz, caminho));
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((sub) => validarContraSchema(instancia, sub, raiz, caminho).length === 0)) {
    anotar('nenhuma alternativa de anyOf foi satisfeita');
  }
  if (Array.isArray(schema.oneOf)) {
    const quantas = schema.oneOf.filter((sub) => validarContraSchema(instancia, sub, raiz, caminho).length === 0).length;
    if (quantas !== 1) anotar(`oneOf precisa casar com exatamente uma alternativa, casou com ${quantas}`);
  }
  if (schema.not !== undefined && validarContraSchema(instancia, schema.not, raiz, caminho).length === 0) {
    anotar('a instância casa com um schema que deveria excluir');
  }
  if (schema.if !== undefined) {
    const ramo = validarContraSchema(instancia, schema.if, raiz, caminho).length === 0
      ? schema.then
      : schema.else;
    if (ramo !== undefined) erros.push(...validarContraSchema(instancia, ramo, raiz, caminho));
  }

  return erros;
}

/**
 * Valida um manifesto de skill contra o schema do formato (t97).
 *
 * @param {unknown} manifesto Manifesto já parseado.
 * @returns {{valido: boolean, erros: Array<{caminho: string, mensagem: string}>}}
 */
export function validarManifesto(manifesto) {
  const erros = validarContraSchema(manifesto, lerSchemaManifesto());
  return { valido: erros.length === 0, erros };
}

// --------------------------------------------------------------------------
// Hash canônico (D4)
// --------------------------------------------------------------------------

/** Ordena chaves recursivamente — a parte da RFC 8785 que este formato usa. */
function canonicalizar(valor) {
  if (Array.isArray(valor)) return valor.map(canonicalizar);
  if (ehObjeto(valor)) {
    return Object.keys(valor)
      .sort()
      .reduce((acc, chave) => {
        acc[chave] = canonicalizar(valor[chave]);
        return acc;
      }, {});
  }
  return valor;
}

/**
 * Hash de conteúdo do manifesto, pelo procedimento de
 * `especificacoes/formatos/manifesto-skill.md`: sha256 do JSON canônico de
 * `{instrucoes, entrada, saida, checks, permissoes}`.
 *
 * O que fica de fora (`id`, `versao`, `descricao`, `origem`) é metadado de
 * catálogo: renomear a skill não invalida o pin, mudar uma linha das
 * instruções ou afrouxar um check invalida.
 *
 * @param {object} manifesto Manifesto já parseado.
 * @returns {string} `sha256:` seguido de 64 hex.
 */
export function calcularHashDoManifesto(manifesto) {
  const subconjunto = {
    instrucoes: manifesto.instrucoes,
    entrada: manifesto.entrada,
    saida: manifesto.saida,
    checks: manifesto.checks,
    permissoes: manifesto.permissoes,
  };
  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalizar(subconjunto)), 'utf8')
    .digest('hex');
  return `sha256:${digest}`;
}

// --------------------------------------------------------------------------
// Validação do bundle
// --------------------------------------------------------------------------

function lerJson(caminho) {
  return JSON.parse(readFileSync(caminho, 'utf8'));
}

/**
 * Valida um bundle de fábrica inteiro: grafo, manifestos e pinos.
 *
 * Nunca lança em bundle malformado — devolve relatório, como o validador de
 * grafo do t96: quem chama precisa da lista inteira do que está errado, não do
 * primeiro erro.
 *
 * @param {string} caminhoDoBundle Diretório com `grafo.json` e `skills/`.
 * @returns {{valido: boolean, bundle: string, erros: Array<{codigo: string, mensagem: string}>,
 *            grafo: object|null, manifestos: Array<object>, pinos: Array<object>}}
 */
export function validarBundle(caminhoDoBundle) {
  const bundle = path.resolve(caminhoDoBundle);
  const relatorio = { valido: false, bundle, erros: [], grafo: null, manifestos: [], pinos: [] };
  const anotar = (codigo, mensagem) => relatorio.erros.push({ codigo, mensagem });

  let doc = null;
  const caminhoGrafo = path.join(bundle, 'grafo.json');
  try {
    doc = lerJson(caminhoGrafo);
  } catch (erro) {
    anotar('grafo_ilegivel', `não deu para ler grafo.json — ${erro.message}`);
  }

  if (doc !== null) {
    relatorio.grafo = validarGrafo(doc);
  }

  const dirSkills = path.join(bundle, 'skills');
  let arquivos = [];
  try {
    arquivos = readdirSync(dirSkills)
      .filter((nome) => nome.endsWith('.json') && statSync(path.join(dirSkills, nome)).isFile())
      .sort();
  } catch (erro) {
    anotar('skills_ilegivel', `não deu para listar skills/ — ${erro.message}`);
  }
  if (arquivos.length === 0 && relatorio.erros.length === 0) {
    anotar('skills_vazio', 'skills/ não tem nenhum manifesto');
  }

  const porId = new Map();
  for (const arquivo of arquivos) {
    const entrada = { arquivo, id: null, versao: null, valido: false, erros: [] };
    relatorio.manifestos.push(entrada);
    let manifesto;
    try {
      manifesto = lerJson(path.join(dirSkills, arquivo));
    } catch (erro) {
      entrada.erros.push({ caminho: '/', mensagem: `não é JSON válido — ${erro.message}` });
      continue;
    }
    const { valido, erros } = validarManifesto(manifesto);
    entrada.id = manifesto?.id ?? null;
    entrada.versao = manifesto?.versao ?? null;
    entrada.valido = valido;
    entrada.erros = erros;

    if (typeof manifesto?.id === 'string') {
      if (porId.has(manifesto.id)) {
        entrada.erros.push({ caminho: '/id', mensagem: `id repetido no bundle: "${manifesto.id}"` });
        entrada.valido = false;
      } else {
        porId.set(manifesto.id, { manifesto, arquivo });
      }
    }
    if (typeof manifesto?.id === 'string' && manifesto.id !== path.basename(arquivo, '.json')) {
      entrada.erros.push({
        caminho: '/id',
        mensagem: `o id "${manifesto.id}" precisa ser o nome do arquivo sem extensão`,
      });
      entrada.valido = false;
    }
  }

  const pinados = new Set();
  for (const no of Array.isArray(doc?.nos) ? doc.nos : []) {
    const ref = ehObjeto(no?.skill_ref) ? no.skill_ref : {};
    const pino = { no: no?.id ?? null, skill: ref.id ?? null, arquivo: null, ok: true, problemas: [] };
    relatorio.pinos.push(pino);
    const reprovar = (mensagem) => {
      pino.ok = false;
      pino.problemas.push(mensagem);
    };

    const achado = typeof ref.id === 'string' ? porId.get(ref.id) : undefined;
    if (!achado) {
      reprovar(`nenhum manifesto em skills/ com id "${ref.id}"`);
      continue;
    }
    pinados.add(ref.id);
    pino.arquivo = achado.arquivo;

    if (achado.manifesto.versao !== ref.versao) {
      reprovar(`versão pinada ${ref.versao}, manifesto ${achado.manifesto.versao}`);
    }
    const recalculado = calcularHashDoManifesto(achado.manifesto);
    if (recalculado !== ref.hash) {
      reprovar(`hash pinado ${ref.hash}, conteúdo do manifesto ${recalculado}`);
    }
    if (achado.manifesto.hash !== recalculado) {
      reprovar(
        `o manifesto declara hash ${achado.manifesto.hash}, mas o conteúdo dele é ${recalculado}`,
      );
    }
  }

  for (const [id, { arquivo }] of porId) {
    if (!pinados.has(id)) {
      anotar('manifesto_orfao', `${arquivo}: nenhum nó do grafo pina a skill "${id}"`);
    }
  }

  relatorio.valido =
    relatorio.erros.length === 0 &&
    relatorio.grafo?.valido === true &&
    relatorio.manifestos.every((m) => m.valido) &&
    relatorio.pinos.every((p) => p.ok) &&
    relatorio.pinos.length > 0;

  return relatorio;
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

function principal(argumentos) {
  if (argumentos.length !== 1) {
    console.error('uso: node scripts/validar-bundle-fabrica.mjs <dir-do-bundle>');
    return 2;
  }
  const [alvo] = argumentos;
  const relatorio = validarBundle(alvo);
  const rotulo = path.relative(RAIZ, relatorio.bundle) || relatorio.bundle;

  if (relatorio.valido) {
    console.log(
      `✔ ${rotulo} — grafo sound, ${relatorio.manifestos.length} manifesto(s) válido(s), ${relatorio.pinos.length} pino(s) conferido(s)`,
    );
    return 0;
  }

  console.error(`✖ ${rotulo}`);
  for (const erro of relatorio.erros) {
    console.error(`  bundle     ${erro.codigo}: ${erro.mensagem}`);
  }
  for (const erro of relatorio.grafo?.estrutura.erros ?? []) {
    console.error(`  grafo      estrutura ${erro.codigo}: ${erro.mensagem}`);
  }
  for (const violacao of relatorio.grafo?.soundness.violacoes ?? []) {
    console.error(`  grafo      soundness ${violacao.regra}: ${JSON.stringify(violacao.alvo)}`);
  }
  for (const manifesto of relatorio.manifestos) {
    for (const erro of manifesto.erros) {
      console.error(`  manifesto  ${manifesto.arquivo} ${erro.caminho}: ${erro.mensagem}`);
    }
  }
  for (const pino of relatorio.pinos) {
    for (const problema of pino.problemas) {
      console.error(`  pino       nó "${pino.no}" → skill "${pino.skill}": ${problema}`);
    }
  }
  return 1;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = principal(process.argv.slice(2));
}
