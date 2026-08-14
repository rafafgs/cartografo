/**
 * Prova manual: uma sessão de verdade, com a CLI `claude` real.
 *
 * NÃO é teste de CI e não deve virar um. A suíte roda contra o fake engine
 * justamente para não depender de binário instalado, autenticação nem rede
 * (`docs/formatos/engine-adapter.md:363-366`); esta prova é o portão manual do
 * outro lado — o que o kit não pode provar porque não tem CLI de verdade.
 * Mesma divisão do `make spike` do flowpilot: evidência anexada à ficha, não
 * gate automático.
 *
 * O que ela demonstra, ponta a ponta:
 *
 * 1. `verifyCli()` acha a CLI real e reporta a versão.
 * 2. Uma sessão roda num repositório git descartável, com `instructions` vindo
 *    do manifesto de skill "fazer" já existente
 *    (`especificacoes/formatos/exemplos/manifesto-skill.develop.json`). É o
 *    stand-in mais próximo de "skill vinda do banco" disponível hoje: o banco
 *    é t101/t102 e ainda não existe.
 * 3. A sessão de fato TRABALHOU — o arquivo que o prompt pediu está no
 *    workdir. Sem isso, "saiu com 0" não prova nada.
 * 4. Os callbacks do listener são projetados em `sessao.aberta` e
 *    `sessao.finalizada` conformes à taxonomia (t98) e validados com ajv
 *    contra os schemas de verdade.
 *
 * O JSONL é artefato local de evidência, não tabela: o adapter não escreve em
 * banco (D1 — o listener é a única saída, e quem chamou decide o que persistir).
 *
 * Uso: npm run spike --workspace @cartografo/runner
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import AjvModule from 'ajv/dist/2020.js';
import formatsModule from 'ajv-formats';

import { ClaudeCodeAdapter } from '../src/engine/claude-code-adapter.ts';

const Ajv2020 = AjvModule.default ?? AjvModule;
const addFormats = formatsModule.default ?? formatsModule;

const RAIZ = fileURLToPath(new URL('../../../', import.meta.url));
const DIR_SCHEMAS = join(RAIZ, 'especificacoes/eventos/schemas');
const MANIFESTO = join(RAIZ, 'especificacoes/formatos/exemplos/manifesto-skill.develop.json');

const ARQUIVO_PEDIDO = 'PROVA-T104.md';
const FRASE = 'sessao real do EngineAdapter do Claude Code';
const TIMEOUT_SEGUNDOS = 300;

/**
 * `SessionStatus` (vocabulário da interface) -> `status` da taxonomia de
 * eventos (t98). São dois vocabulários de propósito: o da interface é o mínimo
 * que toda CLI headless expressa, o da taxonomia descreve o desfecho do
 * trabalho.
 *
 * `cancelled` cai em `travada` por falta de coisa melhor — a taxonomia não tem
 * "cancelada". A descrição de `travada` é "uma parada nossa", que serve, mas o
 * casamento não é exato e vale registrar antes que o runner (t103) tenha de
 * decidir isso sozinho.
 */
const STATUS_DA_TAXONOMIA = {
  completed: 'concluida',
  failed: 'falhou',
  timed_out: 'tempo_esgotado',
  cancelled: 'travada',
};

const registrar = (mensagem) => console.log(`[spike] ${mensagem}`);

function morrer(mensagem) {
  console.error(`\n[spike] FALHOU: ${mensagem}\n`);
  process.exit(1);
}

/** Repositório git descartável — o `workingDir` da sessão. */
function criarRepoDescartavel() {
  const raiz = mkdtempSync(join(tmpdir(), 'cartografo-spike-'));
  const repo = join(raiz, 'repo');
  mkdirSync(repo);
  const git = (...argumentos) =>
    execFileSync('git', argumentos, { cwd: repo, stdio: 'pipe', encoding: 'utf8' });

  git('init', '--quiet');
  git('config', 'user.email', 'spike@cartografo.local');
  git('config', 'user.name', 'Spike t104');
  writeFileSync(join(repo, 'README.md'), '# Repo descartável da prova manual da t104\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'inicial');
  return { raiz, repo };
}

function montarValidador() {
  // `allowUnionTypes` porque a taxonomia usa união de tipo de propósito:
  // `entidade.id` é inteiro para trabalho/sessao/pergunta/lease e string para
  // grafo_versao, cujo id é o hash do snapshot (D15). É decisão do t98, não
  // desleixo de schema — e alterar schema de outra ficha está fora de escopo.
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
  addFormats(ajv);
  for (const nome of ['envelope', 'sessao.aberta', 'sessao.finalizada']) {
    ajv.addSchema(JSON.parse(readFileSync(join(DIR_SCHEMAS, `${nome}.schema.json`), 'utf8')));
  }
  return (tipo, evento) => {
    const valido = ajv.validate(`${tipo}.schema.json`, evento);
    if (!valido) {
      morrer(`evento ${tipo} não valida contra o schema:\n${ajv.errorsText(ajv.errors, { separator: '\n' })}`);
    }
    registrar(`evento ${tipo} valida contra o schema da taxonomia`);
  };
}

/** Envelope comum. `id` é local: num sistema de verdade quem numera é o server. */
function envelope(id, tipo, dados) {
  return {
    id,
    tipo,
    projeto_id: 3,
    execucao_id: null,
    entidade: { tipo: 'sessao', id: 1 },
    ator: { tipo: 'sistema', ref: 'runner/spike-t104' },
    ocorrido_em: new Date().toISOString(),
    dados,
  };
}

async function principal() {
  const adapter = new ClaudeCodeAdapter();

  const sonda = await adapter.verifyCli();
  registrar(`verifyCli: ${JSON.stringify(sonda)}`);
  if (!sonda.available) morrer('a CLI `claude` não respondeu a --version — instale antes de rodar a prova');
  if (!sonda.authenticated) {
    registrar('AVISO: authenticated=false. É melhor esforço, não garantia; seguindo assim mesmo.');
  }

  const manifesto = JSON.parse(readFileSync(MANIFESTO, 'utf8'));
  const instrucoes = manifesto.instrucoes;
  if (typeof instrucoes !== 'string' || instrucoes.length === 0) {
    morrer(`o manifesto ${MANIFESTO} não tem o campo "instrucoes"`);
  }
  registrar(`instructions: ${instrucoes.length} caracteres do manifesto de skill "${manifesto.id}"`);

  const { raiz, repo } = criarRepoDescartavel();
  registrar(`workingDir: ${repo}`);

  const prompt =
    `Crie no diretório atual um arquivo chamado ${ARQUIVO_PEDIDO} contendo exatamente ` +
    `uma linha com o texto: ${FRASE}\n` +
    'Não faça mais nada além disso, e não commite.';

  const spec = {
    workingDir: repo,
    instructions: instrucoes,
    prompt,
    timeoutSeconds: TIMEOUT_SEGUNDOS,
  };

  const transcript = [];
  let engineRef = null;
  let desfecho = null;
  let resolverFim;
  const fim = new Promise((resolve) => {
    resolverFim = resolve;
  });

  const inicio = Date.now();
  const handle = await adapter.startSession(spec, {
    onOutput(linha) {
      transcript.push(linha);
      process.stdout.write(`  | ${linha}\n`);
    },
    onEngineRef(ref) {
      engineRef = ref;
      registrar(`onEngineRef: ${ref}`);
    },
    onFinished(status, exitCode) {
      desfecho = { status, exitCode };
      resolverFim();
    },
  });
  registrar(`handle local do adapter: ${handle}`);
  registrar(`getStatus logo após o start: ${await adapter.getStatus(handle)}`);

  await fim;
  const duracao = ((Date.now() - inicio) / 1000).toFixed(1);
  registrar(`onFinished: ${JSON.stringify(desfecho)} em ${duracao}s`);
  registrar(`getStatus depois do fim: ${await adapter.getStatus(handle)}`);

  const validar = montarValidador();

  // `sessao.aberta` sai com o ref que a sessão já revelou: o quadro de init é o
  // primeiro do stream, então na prática ele é conhecido bem antes do fim.
  const aberta = envelope(1, 'sessao.aberta', {
    engine: adapter.engineName,
    engine_session_ref: engineRef,
    working_dir: repo,
    prompt,
    timeout_seconds: TIMEOUT_SEGUNDOS,
    trabalho_id: null,
    no_id: null,
  });
  validar('sessao.aberta', aberta);

  const finalizada = envelope(2, 'sessao.finalizada', {
    status: STATUS_DA_TAXONOMIA[desfecho.status],
    exit_code: desfecho.exitCode,
    // A interface v0 não reporta uso de tokens (fora de escopo), e null aqui é
    // "o engine não reportou nada" — nunca colapsar em zero.
    uso: null,
  });
  validar('sessao.finalizada', finalizada);

  const jsonl = join(raiz, 'eventos.jsonl');
  writeFileSync(jsonl, `${JSON.stringify(aberta)}\n${JSON.stringify(finalizada)}\n`);
  writeFileSync(join(raiz, 'transcript.txt'), `${transcript.join('\n')}\n`);

  // As provas duras, na ordem em que importam.
  if (desfecho.status !== 'completed') morrer(`a sessão terminou como "${desfecho.status}"`);
  if (desfecho.exitCode !== 0) morrer(`exit code ${desfecho.exitCode}`);
  if (transcript.length === 0) morrer('nenhuma linha chegou ao onOutput');
  if (engineRef === null) morrer('onEngineRef nunca disparou — nenhum session_id foi reconhecido no stream');

  const produzido = join(repo, ARQUIVO_PEDIDO);
  if (!existsSync(produzido)) morrer(`a sessão não criou ${ARQUIVO_PEDIDO} — saiu com 0 sem ter trabalhado`);
  const conteudo = readFileSync(produzido, 'utf8');
  if (!conteudo.includes(FRASE)) morrer(`${ARQUIVO_PEDIDO} existe mas não tem a frase pedida:\n${conteudo}`);

  console.log('\n===== evidência =====');
  console.log(`CLI:            ${sonda.version}`);
  console.log(`engineName:     ${adapter.engineName}`);
  console.log(`engineRef:      ${engineRef}`);
  console.log(`desfecho:       ${desfecho.status} / exit ${desfecho.exitCode} / ${duracao}s`);
  console.log(`linhas:         ${transcript.length}`);
  console.log(`${ARQUIVO_PEDIDO}: ${JSON.stringify(conteudo.trim())}`);
  console.log(`eventos:        ${jsonl}`);
  console.log(`transcript:     ${join(raiz, 'transcript.txt')}`);
  console.log(`workdir:        ${repo}`);
  console.log('=====================\n');
  registrar('prova manual OK');
}

await principal();
