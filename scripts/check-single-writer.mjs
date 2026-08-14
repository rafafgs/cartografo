/**
 * Portão estático da D1 — "só o server escreve no banco" (t100, FR6/FR7).
 *
 * Três regras, verificadas por leitura do código-fonte, sem rodar nada:
 *
 * - `driver_fora_do_dono` — o driver do SQLite só pode ser importado por
 *   módulos sob `packages/core/src/db/`. Esse diretório É o dono do banco;
 *   todo o resto do core recebe um handle já aberto.
 * - `db_privado_importado` — `packages/core/src/db/**` é privado do pacote
 *   core. Ninguém de fora (a começar pela tela, D11) alcança esses módulos.
 * - `driver_declarado_fora_do_core` — nenhum `package.json` fora de
 *   `packages/core` declara o driver como dependência. Um pacote que não pode
 *   importar o driver também não tem por que instalá-lo.
 *
 * Mesmo padrão de `scripts/validar-grafo.mjs`: função exportada + CLI, zero
 * dependências, nenhum erro fatal em arquivo malformado — o relatório sai
 * inteiro, não no primeiro problema.
 *
 * Uso como CLI: `node scripts/check-single-writer.mjs [raiz...]`
 * (sem argumento, varre a raiz do repositório).
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Pacotes de driver de SQLite que o portão reconhece. */
export const DRIVERS_SQLITE = Object.freeze([
  'better-sqlite3',
  'sqlite3',
  'node:sqlite',
  'libsql',
  '@libsql/client',
]);

/** Pacote que é dono do banco (D1). */
export const PACOTE_DONO_DO_BANCO = 'packages/core';

/** Diretório, dentro do pacote dono, que pode tocar o driver. */
export const PREFIXO_DONO_DO_BANCO = 'packages/core/src/db';

/**
 * Sufixo do caminho do dono, usado para reconhecer um alcance ao banco privado
 * mesmo quando a varredura começa fora da raiz do repo (ex.: varrer só
 * `packages/tela/`, em que o alvo do import cai fora da árvore varrida).
 */
export const SEGMENTO_DONO_DO_BANCO = 'core/src/db';

/** Extensões de código que o portão lê. */
export const EXTENSOES = Object.freeze([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
]);

/** Diretórios que a varredura nunca entra. */
const DIRETORIOS_IGNORADOS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.cartografo',
]);

const CAMPOS_DE_DEPENDENCIA = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/** Padrões que capturam um especificador de módulo em posição de import. */
const PADROES_DE_IMPORT = [
  /\bfrom\s*['"]([^'"\n]+)['"]/g, // import ... from 'x' | export ... from 'x'
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g, // import('x')
  /\bimport\s+['"]([^'"\n]+)['"]/g, // import 'x'
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g, // require('x')
];

const RAIZ_REPO = path.resolve(import.meta.dirname, '..');

const paraPosix = (caminho) => caminho.split(path.sep).join('/');

const estaSob = (relativo, prefixo) => relativo === prefixo || relativo.startsWith(`${prefixo}/`);

/**
 * Extrai os especificadores de módulo importados por um arquivo.
 *
 * Leitura textual, sem parser: o objetivo é um portão pequeno e sem
 * dependência, e um especificador só existe em posição sintática fixa. Uma
 * ocorrência solta do nome do driver em string ou comentário NÃO conta.
 *
 * @param codigo Conteúdo do arquivo.
 * @returns Especificadores encontrados, sem repetição.
 */
export function extrairImports(codigo) {
  const achados = new Set();
  for (const padrao of PADROES_DE_IMPORT) {
    padrao.lastIndex = 0;
    let casamento;
    while ((casamento = padrao.exec(codigo)) !== null) {
      achados.add(casamento[1]);
    }
  }
  return [...achados];
}

/** Lista recursivamente os arquivos relevantes sob `raiz` (caminhos absolutos). */
function listarArquivos(raiz) {
  const encontrados = [];
  const pilha = [raiz];

  while (pilha.length > 0) {
    const atual = pilha.pop();
    let entradas;
    try {
      entradas = readdirSync(atual, { withFileTypes: true });
    } catch {
      continue; // diretório ilegível não derruba o portão
    }

    for (const entrada of entradas) {
      const caminho = path.join(atual, entrada.name);
      if (entrada.isDirectory()) {
        if (!DIRETORIOS_IGNORADOS.has(entrada.name)) pilha.push(caminho);
        continue;
      }
      if (!entrada.isFile()) continue;
      if (entrada.name === 'package.json' || EXTENSOES.includes(path.extname(entrada.name))) {
        encontrados.push(caminho);
      }
    }
  }

  return encontrados.sort();
}

/** Resolve um especificador relativo; devolve `null` para bare specifier. */
function resolverRelativo(arquivo, especificador) {
  if (!especificador.startsWith('.')) return null;
  return path.resolve(path.dirname(arquivo), especificador);
}

/** Um import alcança o banco privado? */
function alcancaOBancoPrivado(arquivo, especificador, raiz) {
  const resolvido = resolverRelativo(arquivo, especificador);
  const alvo = resolvido === null ? especificador : paraPosix(path.relative(raiz, resolvido));
  const posix = paraPosix(alvo);
  return posix.includes(`${SEGMENTO_DONO_DO_BANCO}/`) || posix.endsWith(SEGMENTO_DONO_DO_BANCO);
}

function verificarPackageJson(relativo, conteudo, anotar) {
  let manifesto;
  try {
    manifesto = JSON.parse(conteudo);
  } catch {
    return; // JSON quebrado é problema de outro portão
  }
  if (relativo === `${PACOTE_DONO_DO_BANCO}/package.json`) return;

  for (const campo of CAMPOS_DE_DEPENDENCIA) {
    const declaradas = Object.keys(manifesto?.[campo] ?? {});
    for (const driver of DRIVERS_SQLITE) {
      if (!declaradas.includes(driver)) continue;
      anotar(
        'driver_declarado_fora_do_core',
        `"${relativo}" declara o driver "${driver}" em ${campo}; só ${PACOTE_DONO_DO_BANCO} pode (D1)`,
        driver,
        relativo,
      );
    }
  }
}

/**
 * Roda as três regras sobre uma árvore de arquivos.
 *
 * @param raiz Diretório a varrer. Default: a raiz do repositório.
 * @returns `{valido, violacoes}`; cada violação traz `codigo`, `arquivo`
 *   (relativo à raiz varrida), `mensagem` e `alvo`.
 */
export function verificar(raiz = RAIZ_REPO) {
  const raizAbsoluta = path.resolve(raiz);
  const violacoes = [];
  const anotar = (codigo, mensagem, alvo, arquivo) =>
    violacoes.push({ codigo, arquivo, mensagem, alvo });

  for (const arquivo of listarArquivos(raizAbsoluta)) {
    const relativo = paraPosix(path.relative(raizAbsoluta, arquivo));

    let conteudo;
    try {
      conteudo = readFileSync(arquivo, 'utf8');
    } catch {
      continue;
    }

    if (path.basename(arquivo) === 'package.json') {
      verificarPackageJson(relativo, conteudo, anotar);
      continue;
    }

    const podeUsarODriver = estaSob(relativo, PREFIXO_DONO_DO_BANCO);
    const ehDoPacoteDono = estaSob(relativo, PACOTE_DONO_DO_BANCO);

    for (const especificador of extrairImports(conteudo)) {
      if (DRIVERS_SQLITE.includes(especificador) && !podeUsarODriver) {
        anotar(
          'driver_fora_do_dono',
          `"${relativo}" importa o driver "${especificador}"; só ${PREFIXO_DONO_DO_BANCO}/ pode (D1)`,
          especificador,
          relativo,
        );
      }
      if (!ehDoPacoteDono && alcancaOBancoPrivado(arquivo, especificador, raizAbsoluta)) {
        anotar(
          'db_privado_importado',
          `"${relativo}" importa "${especificador}", que é módulo privado de ${PACOTE_DONO_DO_BANCO} (D1/D11)`,
          especificador,
          relativo,
        );
      }
    }
  }

  return { valido: violacoes.length === 0, violacoes };
}

function principal(raizes) {
  const alvos = raizes.length > 0 ? raizes : [RAIZ_REPO];
  let houveFalha = false;

  for (const raiz of alvos) {
    const relatorio = verificar(raiz);
    if (relatorio.valido) {
      console.log(`✔ ${raiz}`);
      continue;
    }
    houveFalha = true;
    console.error(`✖ ${raiz}`);
    for (const violacao of relatorio.violacoes) {
      console.error(`  ${violacao.codigo}: ${violacao.mensagem}`);
    }
  }

  return houveFalha ? 1 : 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = principal(process.argv.slice(2));
}
