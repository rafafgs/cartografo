/**
 * `cartografo import <caminho>` — o grafo vira dado (t108, FR2).
 *
 * Duas formas de entrada, de propósito:
 *
 * - **arquivo** — o documento de grafo direto, sem cerimônia. É o que sai de
 *   `export`, e é o que faz o round-trip fechar.
 * - **diretório de bundle** — lê `<dir>/grafo.json` e, se houver um `skills/`
 *   irmão, confere o bundle ANTES de tocar a rede. Bundle com pino quebrado não
 *   chega a virar requisição: a skill pinada é vetor de injeção (D4), e um
 *   grafo cujo `skill_ref` não fecha com o manifesto ao lado é exatamente o
 *   caso que o pino existe para pegar.
 *
 * Nada de `skills/` é persistido: não existe endpoint de registro de skill
 * (ver o README do bundle de fábrica, seção "Convenção de diretório"). A
 * checagem local é o que dá para garantir hoje, e é melhor que nada — mas não
 * substitui o registro, que é ticket futura.
 *
 * **Limite declarado da checagem de manifesto.** As três checagens são as de
 * `scripts/validar-bundle-fabrica.mjs` — grafo sound, manifesto conferido,
 * pino fechando —, mas a segunda cobre aqui o subconjunto de regras do schema
 * que o pino depende (campos obrigatórios, forma de `id`/`versao`/`hash`,
 * `papel` no enum, e o hash recalculado batendo com o declarado), não o schema
 * inteiro. O motivo é o mesmo que fez `dominio/grafo.ts` portar as regras de
 * grafo em vez de carregar `schema/grafo.schema.json`: `especificacoes/` está
 * fora da árvore publicável do pacote (`files` do `package.json`), e o core não
 * pode depender em runtime de um arquivo que o `npm pack` não leva junto. A
 * conformidade completa contra
 * `especificacoes/formatos/manifesto-skill.schema.json` continua sendo do
 * validador de referência, que é quem guarda o bundle no repositório.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { validarGrafo } from '../dominio/grafo.ts';
import { canonicalizar, PREFIXO_HASH } from '../dominio/hash.ts';
import { ErroDeUso, pedirJson } from './url.ts';

/** Campos que todo manifesto declara (`required` do schema do t97). */
const CAMPOS_DO_MANIFESTO = [
  'id',
  'versao',
  'hash',
  'papel',
  'descricao',
  'entrada',
  'saida',
  'pre_condicoes',
  'checks',
  'permissoes',
  'instrucoes',
  'origem',
];

const PADRAO_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PADRAO_VERSAO = /^\d+\.\d+\.\d+$/;
const PADRAO_HASH = /^sha256:[a-f0-9]{64}$/;
const PAPEIS = ['fazer', 'portao'];

/** Um problema achado na conferência local, já com o escopo que o produziu. */
export interface ProblemaDeBundle {
  escopo: 'bundle' | 'grafo' | 'manifesto' | 'pino';
  mensagem: string;
}

/** Opções de `import`. */
export interface OpcoesDeImport {
  /** Arquivo de grafo ou diretório de bundle. */
  caminho: string;
  /** URL base do control plane. */
  url: string;
}

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function lerJson(caminho: string): unknown {
  let texto: string;
  try {
    texto = readFileSync(caminho, 'utf8');
  } catch {
    throw new ErroDeUso(`não deu para ler "${caminho}"`);
  }
  try {
    return JSON.parse(texto) as unknown;
  } catch (erro) {
    throw new ErroDeUso(`"${caminho}" não é JSON válido — ${(erro as Error).message}`);
  }
}

/**
 * Hash de conteúdo de um manifesto de skill, pelo procedimento de
 * `especificacoes/formatos/manifesto-skill.md`: sha256 do JSON canônico de
 * `{instrucoes, entrada, saida, checks, permissoes}`.
 *
 * Cobre só esse subconjunto — e não o manifesto inteiro, como faz o hash de
 * versão de grafo — porque metadado de catálogo (`id`, `versao`, `descricao`,
 * `origem`) não pode invalidar um pino: renomear a skill não muda o que ela faz.
 *
 * @param manifesto Manifesto já parseado.
 * @returns `sha256:` seguido de 64 hex.
 */
export function hashDoManifesto(manifesto: Record<string, unknown>): string {
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
  return `${PREFIXO_HASH}${digest}`;
}

/** Confere um manifesto isolado; devolve as mensagens do que estiver errado. */
function conferirManifesto(manifesto: unknown, arquivo: string): string[] {
  const problemas: string[] = [];
  if (!ehObjeto(manifesto)) return [`${arquivo}: o manifesto precisa ser um objeto JSON`];

  for (const campo of CAMPOS_DO_MANIFESTO) {
    if (manifesto[campo] === undefined) problemas.push(`${arquivo}: campo obrigatório ausente: "${campo}"`);
  }

  const id = manifesto.id;
  if (typeof id !== 'string' || !PADRAO_ID.test(id)) {
    problemas.push(`${arquivo}: "id" precisa ser kebab-case (${PADRAO_ID.source})`);
  } else if (id !== path.basename(arquivo, '.json')) {
    problemas.push(`${arquivo}: o id "${id}" precisa ser o nome do arquivo sem extensão`);
  }
  if (typeof manifesto.versao !== 'string' || !PADRAO_VERSAO.test(manifesto.versao)) {
    problemas.push(`${arquivo}: "versao" precisa ser semver (x.y.z)`);
  }
  if (typeof manifesto.papel !== 'string' || !PAPEIS.includes(manifesto.papel)) {
    problemas.push(`${arquivo}: "papel" precisa ser ${PAPEIS.join(" ou ")}`);
  }

  const declarado = manifesto.hash;
  if (typeof declarado !== 'string' || !PADRAO_HASH.test(declarado)) {
    problemas.push(`${arquivo}: "hash" precisa ter a forma sha256:<64 hex>`);
    return problemas;
  }
  const recalculado = hashDoManifesto(manifesto);
  if (recalculado !== declarado) {
    problemas.push(
      `${arquivo}: o manifesto declara hash ${declarado}, mas o conteúdo dele é ${recalculado} — manifesto adulterado não roda (D4)`,
    );
  }
  return problemas;
}

/**
 * Confere o bundle inteiro: grafo, manifestos e pinos.
 *
 * Nunca lança em bundle malformado — devolve a lista inteira do que está
 * errado, como o validador de referência: quem está consertando um bundle
 * precisa de todos os problemas, não do primeiro.
 *
 * @param diretorio Diretório do bundle (com `grafo.json` e `skills/`).
 * @param documento Documento de grafo já lido de `<diretorio>/grafo.json`.
 * @returns Problemas encontrados; vazio quando o bundle fecha.
 */
export function verificarBundle(diretorio: string, documento: unknown): ProblemaDeBundle[] {
  const problemas: ProblemaDeBundle[] = [];

  // 1. o grafo é válido e sound.
  const relatorio = validarGrafo(documento);
  for (const erro of relatorio.estrutura.erros) {
    problemas.push({ escopo: 'grafo', mensagem: `estrutura ${erro.codigo}: ${erro.mensagem}` });
  }
  for (const violacao of relatorio.soundness.violacoes) {
    problemas.push({
      escopo: 'grafo',
      mensagem: `soundness ${violacao.regra}: ${JSON.stringify(violacao.alvo)}`,
    });
  }

  // 2. cada manifesto se sustenta.
  const dirSkills = path.join(diretorio, 'skills');
  let arquivos: string[];
  try {
    arquivos = readdirSync(dirSkills)
      .filter((nome) => nome.endsWith('.json'))
      .sort();
  } catch {
    problemas.push({ escopo: 'bundle', mensagem: `não deu para listar ${dirSkills}` });
    return problemas;
  }

  const porId = new Map<string, Record<string, unknown>>();
  for (const arquivo of arquivos) {
    let manifesto: unknown;
    try {
      manifesto = lerJson(path.join(dirSkills, arquivo));
    } catch (erro) {
      problemas.push({ escopo: 'manifesto', mensagem: (erro as Error).message });
      continue;
    }
    for (const mensagem of conferirManifesto(manifesto, arquivo)) {
      problemas.push({ escopo: 'manifesto', mensagem });
    }
    if (ehObjeto(manifesto) && typeof manifesto.id === 'string') {
      if (porId.has(manifesto.id)) {
        problemas.push({ escopo: 'manifesto', mensagem: `${arquivo}: id repetido no bundle: "${manifesto.id}"` });
      } else {
        porId.set(manifesto.id, manifesto);
      }
    }
  }

  // 3. cada pino fecha: id, versão e hash do nó batem com o manifesto ao lado.
  const nos = ehObjeto(documento) && Array.isArray(documento.nos) ? documento.nos : [];
  for (const no of nos) {
    if (!ehObjeto(no)) continue;
    const ref = ehObjeto(no.skill_ref) ? no.skill_ref : {};
    const rotulo = `nó "${String(no.id)}" → skill "${String(ref.id)}"`;
    const manifesto = typeof ref.id === 'string' ? porId.get(ref.id) : undefined;
    if (manifesto === undefined) {
      problemas.push({ escopo: 'pino', mensagem: `${rotulo}: nenhum manifesto em skills/ com esse id` });
      continue;
    }
    if (manifesto.versao !== ref.versao) {
      problemas.push({
        escopo: 'pino',
        mensagem: `${rotulo}: versão pinada ${String(ref.versao)}, manifesto ${String(manifesto.versao)}`,
      });
    }
    const recalculado = hashDoManifesto(manifesto);
    if (recalculado !== ref.hash) {
      problemas.push({
        escopo: 'pino',
        mensagem: `${rotulo}: hash pinado ${String(ref.hash)}, conteúdo do manifesto ${recalculado}`,
      });
    }
  }

  return problemas;
}

/** Uma linha de `rótulo  valor` da saída de sucesso. */
function linha(rotulo: string, valor: string): string {
  return `  ${rotulo.padEnd(18)}${valor}\n`;
}

/**
 * Roda `cartografo import`.
 *
 * @param opcoes Caminho de entrada e URL base do control plane.
 * @returns Código de saída do processo.
 */
export async function executarImport(opcoes: OpcoesDeImport): Promise<number> {
  const alvo = path.resolve(opcoes.caminho);

  let ehDiretorio: boolean;
  try {
    ehDiretorio = statSync(alvo).isDirectory();
  } catch {
    throw new ErroDeUso(`caminho não encontrado: "${opcoes.caminho}"`);
  }

  const caminhoGrafo = ehDiretorio ? path.join(alvo, 'grafo.json') : alvo;
  const documento = lerJson(caminhoGrafo);

  let temSkills = false;
  if (ehDiretorio) {
    try {
      temSkills = statSync(path.join(alvo, 'skills')).isDirectory();
    } catch {
      temSkills = false;
    }
  }

  if (temSkills) {
    const problemas = verificarBundle(alvo, documento);
    if (problemas.length > 0) {
      process.stderr.write(`cartografo: bundle inválido — ${alvo}\n`);
      for (const problema of problemas) {
        process.stderr.write(`  ${problema.escopo.padEnd(10)} ${problema.mensagem}\n`);
      }
      process.stderr.write('cartografo: nada foi enviado ao control plane\n');
      return 1;
    }
  }

  const resposta = await pedirJson(`${opcoes.url}/v1/grafos`, { metodo: 'POST', corpo: documento });
  const corpo = ehObjeto(resposta.corpo) ? resposta.corpo : {};

  if (resposta.status === 201) {
    const grafo = ehObjeto(corpo.grafo) ? corpo.grafo : {};
    const versao = ehObjeto(corpo.grafo_versao) ? corpo.grafo_versao : {};
    process.stdout.write('grafo importado\n');
    process.stdout.write(linha('classe', String(grafo.classe)));
    process.stdout.write(linha('grafo.id', String(grafo.id)));
    process.stdout.write(linha('grafo_versao.id', String(versao.id)));
    return 0;
  }

  if (resposta.status === 409) {
    process.stderr.write(`cartografo: classe_ja_registrada — ${String(corpo.mensagem)}\n`);
    return 1;
  }

  if (resposta.status === 422) {
    process.stderr.write(`cartografo: grafo_invalido — ${caminhoGrafo}\n`);
    const estrutura = ehObjeto(corpo.estrutura) ? corpo.estrutura : {};
    const soundness = ehObjeto(corpo.soundness) ? corpo.soundness : {};
    for (const erro of Array.isArray(estrutura.erros) ? estrutura.erros : []) {
      const item = ehObjeto(erro) ? erro : {};
      process.stderr.write(`  estrutura  ${String(item.codigo)}: ${String(item.mensagem)}\n`);
    }
    for (const violacao of Array.isArray(soundness.violacoes) ? soundness.violacoes : []) {
      const item = ehObjeto(violacao) ? violacao : {};
      process.stderr.write(`  soundness  ${String(item.regra)}: ${JSON.stringify(item.alvo)}\n`);
    }
    return 1;
  }

  process.stderr.write(
    `cartografo: o control plane recusou o grafo (HTTP ${resposta.status})${
      typeof corpo.erro === 'string' ? ` — ${corpo.erro}` : ''
    }${typeof corpo.mensagem === 'string' ? `: ${corpo.mensagem}` : ''}\n`,
  );
  return 1;
}
