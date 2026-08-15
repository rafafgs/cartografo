/**
 * The D4 import gate, in three commands (t117, FR5–FR7).
 *
 * `scan-skill` → `propose-skill` → `register-skill`. Three commands and not one,
 * because there is a HUMAN in the middle and the shape of the tool should say
 * so: the first derives a draft from a local checkout, the second puts it in
 * front of a person and stops, and the third only runs after somebody answered.
 * A single `import-skill` command would have to either block on a person or
 * decide on its behalf, and D4 exists precisely to keep that decision a person's.
 *
 * What the derivation refuses to do is as important as what it does. It fills in
 * what a machine can read off the source with no judgement — the id, the
 * description, the body, the commands quoted inside fenced blocks — and leaves an
 * explicit placeholder everywhere a human has to decide: `entrada` and `saida`
 * are never guessed from prose ("onde a prosa não diz, o revisor decide... nunca
 * se infere em silêncio"), `permissoes` come in at the safe default and are only
 * ever widened by a recorded human decision, and `papel` is the `--role` flag
 * verbatim, because a "fazer" skill registered as a gate is a gate that checks
 * nothing.
 *
 * Nothing here fetches anything. The source is an already-cloned local checkout,
 * and that is a decision, not a missing feature: automating the fetch of
 * untrusted third-party content is itself part of the injection surface D4 exists
 * to close, so the clone stays a deliberate, out-of-band human step.
 *
 * Like the other subcommands, these are pure HTTP clients of the public API
 * (D1, D11): they open no database and have no privilege the screen does not
 * have. The manifest they write is the format's own vocabulary, in Portuguese —
 * D18 leaves data-format keys out of the rename, and the prose inside the draft
 * is what the reviewer reads.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { manifestHash } from '../domain/manifest.ts';
import { UsageError, requestJson } from './url.ts';

/** Options of `scan-skill`. */
export interface ScanSkillOptions {
  /** Path of the `SKILL.md` in an already-cloned local checkout. */
  source: string;
  /** Source repository, as it goes into `origem.repo`. */
  repo: string;
  /** Commit or tag — never a branch, which moves (D4). */
  ref: string;
  /** `fazer` or `portao`; always explicit, never inferred. */
  role: string;
  /** Who is importing, as it goes into `origem.importado_por`. */
  by: string;
  /** Base URL of the control plane (the id collision is checked against it). */
  url: string;
  /** Output file; defaults to `./<id>.manifest.json`. */
  output?: string;
}

/** Options of `propose-skill`. */
export interface ProposeSkillOptions {
  /** Manifest file, already completed by the human. */
  path: string;
  /** Base URL of the control plane. */
  url: string;
}

/** Options of `register-skill`. */
export interface RegisterSkillOptions {
  /** Job the import gate opened. */
  jobId: number;
  /** Base URL of the control plane. */
  url: string;
}

/** A check derived from a command quoted in the source body. */
interface DerivedCheck {
  id: string;
  tipo: string;
  descricao: string;
  comando: string;
}

/**
 * Command heads the derivation recognizes inside a fenced block.
 *
 * A closed list, and a short one: every entry here is a line that a machine can
 * turn into "exit 0 = passou" with no interpretation. `git commit`, `cd` or a
 * shell pipeline quoted in a tutorial are not checks, and inventing one out of
 * them would be exactly the silent inference the format forbids.
 */
const COMMAND_HEADS = ['make', 'npm', 'npx', 'pytest', 'go test', 'node'];

/** What only a human can write — never a guess (`manifesto-skill.md:244-245`). */
const SCHEMA_PLACEHOLDER = { $comment: 'revisor humano escreve o JSON Schema aqui' };

/** D4's safe default: read the workspace, write nothing, no network. */
const SAFE_PERMISSIONS = {
  filesystem: { leitura: ['**'], escrita: [] },
  rede: { permitido: false },
};

/** Version of a new import; the real source reference lives in `origem.ref` (D4). */
const IMPORT_VERSION = '0.1.0';

/** The node a skill import travels through, in the job that carries the gate. */
const IMPORT_NODE = 'importar-skill';

/** What the reviewer signs (`manifesto-skill.md`, "O que o revisor humano assina"). */
const REVIEW_CHECKLIST = `O que você assina ao aprovar (manifesto-skill.md, "O que o revisor humano assina"):

  1. que o \`papel\` está certo — skill de fazer registrada como portão vira um portão que não confere nada;
  2. que \`entrada\`/\`saida\` descrevem o que a skill de fato consome e produz;
  3. que existe pelo menos um check, e que todo check agêntico exige evidência própria;
  4. que as \`permissoes\` são o mínimo necessário;
  5. que as \`instrucoes\` revisadas não carregam instrução hostil — referência a arquivo residente no repo alvo, documento externo que a origem controla, pedido de credencial, exfiltração ou execução de conteúdo baixado.

Para APROVAR: responda com o manifesto final em JSON, com \`origem.revisado_por\` preenchido.
Para RECUSAR: responda com \`rejeitar: <motivo>\`.`;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One `label  value` line of the success output — same shape as import/export. */
function line(label: string, value: string): string {
  return `  ${label.padEnd(18)}${value}\n`;
}

/** Reads a file, turning an unreadable path into a message instead of a stack trace. */
function readText(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    throw new UsageError(`could not read "${filePath}"`);
  }
}

/**
 * Splits a `SKILL.md` into flat frontmatter and Markdown body.
 *
 * Hand-rolled and deliberately flat: the frontmatter of every skill this gate
 * targets (`~/flowpilot`, `~/bootstrap-core`) is `key: value` and nothing else,
 * and a YAML dependency in the control plane to read three lines would be a
 * parser — with its own history of surprises — added to the surface of the very
 * feature that exists to reduce it. A nested frontmatter simply does not parse
 * here, and that is a loud, reviewable failure rather than a silent misreading.
 *
 * @param text Whole file contents.
 * @returns Frontmatter keys and the body after the closing delimiter.
 */
export function splitFrontmatter(text: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new UsageError('the SKILL.md does not start with a --- frontmatter block');
  }

  const closing = lines.findIndex((current, index) => index > 0 && current.trim() === '---');
  if (closing === -1) throw new UsageError('the SKILL.md frontmatter block is never closed');

  const frontmatter: Record<string, string> = {};
  for (const current of lines.slice(1, closing)) {
    if (current.trim() === '') continue;
    const separator = current.indexOf(':');
    if (separator === -1) continue;
    const key = current.slice(0, separator).trim();
    const value = current
      .slice(separator + 1)
      .trim()
      .replace(/^["'](.*)["']$/, '$1');
    if (key !== '') frontmatter[key] = value;
  }

  return { frontmatter, body: lines.slice(closing + 1).join('\n').replace(/^\n+/, '') };
}

/** kebab-case of an arbitrary label; it is the manifest's `id` and has to match its pattern. */
export function kebabCase(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Every shell command quoted inside a fenced code block of the body.
 *
 * Only fenced blocks count. A command in running prose is being NAMED, not
 * prescribed ("run them (`make test`) and confirm the failures"), and promoting
 * it to a check would be reading intent into a sentence.
 *
 * @param body Markdown body of the source.
 * @returns One deterministic check per distinct recognized command, in order.
 */
export function deriveChecks(body: string): DerivedCheck[] {
  const commands: string[] = [];
  let insideFence = false;

  for (const current of body.split('\n')) {
    if (current.trim().startsWith('```')) {
      insideFence = !insideFence;
      continue;
    }
    if (!insideFence) continue;

    const command = current.trim();
    if (command === '' || command.startsWith('#')) continue;
    const recognized = COMMAND_HEADS.some(
      (head) => command === head || command.startsWith(`${head} `),
    );
    if (recognized && !commands.includes(command)) commands.push(command);
  }

  const used = new Set<string>();
  return commands.map((command) => {
    let id = kebabCase(command).slice(0, 60);
    if (id === '') id = 'comando';
    let candidate = id;
    for (let suffix = 2; used.has(candidate); suffix += 1) candidate = `${id}-${suffix}`;
    used.add(candidate);
    return {
      id: candidate,
      tipo: 'deterministico',
      descricao: `Comando citado em bloco de código do SKILL.md de origem: \`${command}\`. Confirmar que ainda é o comando certo antes de aprovar.`,
      comando: command,
    };
  });
}

/**
 * Runs `cartografo scan-skill` (FR5).
 *
 * @param options Source, provenance, role and destination.
 * @returns Process exit code.
 */
export async function runScanSkill(options: ScanSkillOptions): Promise<number> {
  if (options.role !== 'fazer' && options.role !== 'portao') {
    throw new UsageError('--role has to be fazer or portao (D4: never inferred, always confirmed)');
  }

  const source = path.resolve(options.source);
  const { frontmatter, body } = splitFrontmatter(readText(source));

  const name = frontmatter.name;
  if (name === undefined || name === '') {
    throw new UsageError(`"${source}" has no "name" in its frontmatter — there is no id to derive`);
  }
  const id = kebabCase(name);
  if (id === '') throw new UsageError(`the frontmatter name "${name}" does not yield a kebab-case id`);

  const registry = await requestJson(`${options.url}/v1/skills`);
  if (registry.status !== 200) {
    process.stderr.write(
      `cartografo: the control plane answered HTTP ${registry.status} while listing the registry\n`,
    );
    return 1;
  }
  const known = isObject(registry.body) && Array.isArray(registry.body.skills)
    ? registry.body.skills
    : [];
  if (known.some((skill) => isObject(skill) && skill.id === id)) {
    process.stderr.write(
      `cartografo: id "${id}" is already registered at ${options.url} — a collision is a human decision (D4): re-run with a source-prefixed name\n`,
    );
    return 1;
  }

  const checks = deriveChecks(body);
  const draft: Record<string, unknown> = {
    id,
    versao: IMPORT_VERSION,
    hash: '',
    papel: options.role,
    descricao: frontmatter.description ?? '',
    entrada: SCHEMA_PLACEHOLDER,
    saida: SCHEMA_PLACEHOLDER,
    pre_condicoes: [],
    checks,
    permissoes: SAFE_PERMISSIONS,
    instrucoes: body,
    // `revisado_por` is deliberately absent: nobody has reviewed this yet, and a
    // draft that claims a reviewer is a signature nobody gave.
    origem: {
      tipo: 'importada',
      repo: options.repo,
      ref: options.ref,
      importado_por: options.by,
      importado_em: new Date().toISOString().slice(0, 10),
    },
  };
  draft.hash = manifestHash(draft);

  const destination = path.resolve(options.output ?? `${id}.manifest.json`);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');

  process.stdout.write('skill draft written\n');
  process.stdout.write(line('id', id));
  process.stdout.write(line('papel', options.role));
  process.stdout.write(line('checks derived', String(checks.length)));
  process.stdout.write(line('file', destination));
  if (checks.length === 0) {
    process.stdout.write(
      '\nno check could be derived from the source: the registry refuses an imported skill\nwith no check at all (D4), so one has to be written by hand before proposing.\n',
    );
  }
  process.stdout.write('\nwhat only a human can write is still a placeholder:\n');
  process.stdout.write(line('entrada/saida', 'write the JSON Schema of what the skill consumes and produces'));
  process.stdout.write(line('instrucoes', 'review the body as an injection vector before approving'));
  process.stdout.write(line('hash', 'recompute it after editing — the pin covers the content fields'));
  process.stdout.write(`\nnext: cartografo propose-skill ${destination}\n`);
  return 0;
}

/**
 * Runs `cartografo propose-skill` (FR6).
 *
 * Creates the job and, on it, the approval that blocks it. Both through the
 * public API, and both with the machinery that already exists: human escalation
 * is a first-class entity, so the import gate becomes an item in the same inbox
 * as every other decision instead of a parallel approval mechanism nobody else
 * can see.
 *
 * @param options Manifest file and base URL.
 * @returns Process exit code.
 */
export async function runProposeSkill(options: ProposeSkillOptions): Promise<number> {
  const target = path.resolve(options.path);
  const text = readText(target);

  let manifest: unknown;
  try {
    manifest = JSON.parse(text) as unknown;
  } catch (error) {
    throw new UsageError(`"${target}" is not valid JSON — ${(error as Error).message}`);
  }
  if (!isObject(manifest)) throw new UsageError(`"${target}" is not a manifest object`);

  const id = typeof manifest.id === 'string' ? manifest.id : '(sem id)';
  const origin = isObject(manifest.origem) ? manifest.origem : {};
  const repo = typeof origin.repo === 'string' ? origin.repo : '(origem não declarada)';
  const ref = typeof origin.ref === 'string' ? origin.ref : '(ref não declarada)';

  const job = await requestJson(`${options.url}/v1/jobs`, {
    method: 'POST',
    body: { titulo: `importar skill: ${id} de ${repo}@${ref}`, no_entrada_id: IMPORT_NODE },
  });
  if (job.status !== 201 || !isObject(job.body) || typeof job.body.id !== 'number') {
    process.stderr.write(
      `cartografo: the control plane refused the import job (HTTP ${job.status})\n`,
    );
    return 1;
  }
  const jobId = job.body.id;

  const gate = await requestJson(`${options.url}/v1/input-requests`, {
    method: 'POST',
    body: {
      trabalho_id: jobId,
      tipo: 'aprovacao',
      pergunta: `Aprovar importação da skill ${id}?`,
      contexto: `${JSON.stringify(manifest, null, 2)}\n\n${REVIEW_CHECKLIST}`,
      // Never auto-approvable, in any circumstance: D4's gate is a person.
      auto_aprovavel: false,
    },
  });
  if (gate.status !== 201 || !isObject(gate.body) || typeof gate.body.id !== 'number') {
    process.stderr.write(
      `cartografo: the control plane refused the approval request (HTTP ${gate.status}); job ${jobId} was created and is not blocked\n`,
    );
    return 1;
  }

  process.stdout.write('skill import proposed\n');
  process.stdout.write(line('skill', id));
  process.stdout.write(line('job', String(jobId)));
  process.stdout.write(line('input request', String(gate.body.id)));
  process.stdout.write('\nthe job is blocked until somebody answers it in the inbox.\n');
  process.stdout.write(`next, once approved: cartografo register-skill --job ${jobId}\n`);
  return 0;
}

/**
 * Runs `cartografo register-skill` (FR7).
 *
 * Sends what the human answered, and nothing else — it does not re-derive, does
 * not repair and does not re-pin. If the registry refuses what was approved, the
 * refusal is printed verbatim: the registry is the gate of truth, and a CLI that
 * softened its answer would be re-approving on the human's behalf.
 *
 * @param options Job of the gate and base URL.
 * @returns Process exit code.
 */
export async function runRegisterSkill(options: RegisterSkillOptions): Promise<number> {
  const queue = await requestJson(
    `${options.url}/v1/input-requests?trabalho_id=${options.jobId}`,
  );
  if (queue.status !== 200 || !isObject(queue.body) || !Array.isArray(queue.body.perguntas)) {
    process.stderr.write(
      `cartografo: the control plane answered HTTP ${queue.status} for the gate of job ${options.jobId}\n`,
    );
    return 1;
  }

  // The last answered approval, and not the first: a gate reopened after a
  // rejection is the same job with a newer decision on it.
  const answered = queue.body.perguntas
    .filter(
      (item): item is Record<string, unknown> =>
        isObject(item) && item.tipo === 'aprovacao' && item.status === 'respondida',
    )
    .at(-1);

  if (answered === undefined) {
    process.stderr.write(
      `cartografo: no answered approval on job ${options.jobId} — the import gate is still waiting for a human\n`,
    );
    return 1;
  }

  const decision = typeof answered.resposta === 'string' ? answered.resposta.trim() : '';
  if (decision.toLowerCase().startsWith('rejeitar:')) {
    const why = decision.slice('rejeitar:'.length).trim();
    process.stderr.write(
      `cartografo: import refused by ${String(answered.respondido_por)} — ${why === '' ? '(no reason given)' : why}\n`,
    );
    process.stderr.write('cartografo: nothing was registered\n');
    return 1;
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(decision) as unknown;
  } catch (error) {
    process.stderr.write(
      `cartografo: the answer on input request ${String(answered.id)} is neither a "rejeitar:" nor a manifest in JSON — ${(error as Error).message}\n`,
    );
    return 1;
  }

  const registration = await requestJson(`${options.url}/v1/skills`, {
    method: 'POST',
    body: manifest,
  });
  const body = isObject(registration.body) ? registration.body : {};

  if (registration.status === 201) {
    process.stdout.write('skill registered\n');
    process.stdout.write(line('id', String(body.id)));
    process.stdout.write(line('versao', String(body.versao)));
    process.stdout.write(line('hash', String(body.hash)));
    process.stdout.write(line('registrado_em', String(body.registrado_em)));
    return 0;
  }

  if (registration.status >= 400 && registration.status < 500) {
    process.stderr.write(
      `cartografo: the registry refused the approved manifest (HTTP ${registration.status})\n`,
    );
    process.stderr.write(`  ${String(body.error ?? 'manifest_rejected')}\n`);
    for (const problem of Array.isArray(body.details) ? body.details : []) {
      process.stderr.write(`  ${String(problem)}\n`);
    }
    process.stderr.write('cartografo: nothing was registered\n');
    return 1;
  }

  process.stderr.write(
    `cartografo: the control plane answered HTTP ${registration.status} while registering the skill\n`,
  );
  return 1;
}
