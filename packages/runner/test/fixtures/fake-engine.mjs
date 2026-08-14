#!/usr/bin/env node
/**
 * Fake engine — a CLI controlável que o kit de conformidade roda no lugar de
 * um engine de verdade.
 *
 * Existe porque o kit precisa ser determinístico e rodar sem CLI instalada nem
 * autenticada: "a costura é a construção do comando; trocar o binário pelo
 * fake engine é o que mantém a suíte determinística"
 * (`docs/formatos/engine-adapter.md:363-366`).
 *
 * Todo o controle vem do AMBIENTE, nunca de argv. Isso é deliberado: argv é o
 * canal que o adapter usa para entregar `instructions`/`prompt`, e o caso C2 se
 * verifica pelo que o processo recebeu ali. Um fake engine configurado por
 * flags disputaria esse canal com o que está sendo medido. O ambiente chega
 * pelo `envOverrides` do `SessionSpec`, que a interface já define como
 * "adições opacas ao ambiente do processo do engine" — ou seja, o kit
 * configura o fake sem saber nada do adapter sob teste.
 *
 * Variáveis reconhecidas:
 *
 * - `FAKE_ENGINE_RECORD`      caminho do sidecar JSON com tudo que o processo
 *                             recebeu (argv, env, cwd, stdin, arquivos do
 *                             workdir, pid próprio e do neto).
 * - `FAKE_ENGINE_LINES`       JSON `[{stream:"stdout"|"stderr",text:string}]`,
 *                             emitidas em ordem.
 * - `FAKE_ENGINE_EXIT_CODE`   código de saída (default 0).
 * - `FAKE_ENGINE_DELAY_MS`    espera antes de sair.
 * - `FAKE_ENGINE_HANG`        "1" = nunca termina sozinho (C3).
 * - `FAKE_ENGINE_IGNORE_SIGTERM` "1" = instala handler que ignora SIGTERM (C4).
 * - `FAKE_ENGINE_SPAWN_CHILD` "1" = deixa um neto vivo que também ignora
 *                             SIGTERM (C4, "o filho que sobrevive ao pai").
 * - `FAKE_ENGINE_VERSION`     resposta de `--version` (sonda do verifyCli).
 *
 * `--version` é tratado ANTES de qualquer outra coisa e sem ler stdin: é a
 * sonda que "não gasta quota" da interface, e ela não abre sessão.
 *
 * Nenhum caminho deste script chama `process.exit()` depois de escrever: em
 * POSIX o stdout de um pipe é assíncrono, e sair na hora trunca as linhas que
 * o caso C6 confere uma a uma. O jeito certo é `process.exitCode` e deixar o
 * loop de eventos drenar sozinho.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const TAMANHO_MAXIMO_DE_ARQUIVO = 64 * 1024;

/**
 * Lê stdin até EOF.
 *
 * É aqui que a invariante 6 (`stdin` fechado ou redirecionado para
 * `/dev/null`) se paga sozinha: com stdin em `/dev/null` o EOF chega na hora;
 * com um pipe que o adapter abriu e nunca fecha, este `await` nunca resolve, o
 * sidecar nunca é escrito e o caso do kit estoura o prazo com mensagem
 * explícita. Nenhuma asserção extra precisa existir para o adapter que trava.
 */
function lerStdin() {
  return new Promise((resolve) => {
    let dados = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (pedaco) => {
      dados += pedaco;
    });
    process.stdin.on('end', () => resolve(dados));
    process.stdin.on('error', () => resolve(dados));
  });
}

/** Arquivos de primeiro nível do workdir, com conteúdo — o caminho "arquivo efêmero" do C2. */
function arquivosDoWorkdir() {
  const encontrados = {};
  let entradas;
  try {
    entradas = readdirSync(process.cwd(), { withFileTypes: true });
  } catch {
    return encontrados;
  }
  for (const entrada of entradas) {
    if (!entrada.isFile()) continue;
    const caminho = path.join(process.cwd(), entrada.name);
    try {
      encontrados[entrada.name] =
        statSync(caminho).size > TAMANHO_MAXIMO_DE_ARQUIVO
          ? '<grande demais para o sidecar>'
          : readFileSync(caminho, 'utf8');
    } catch {
      encontrados[entrada.name] = '<ilegível>';
    }
  }
  return encontrados;
}

function analisarLinhas(bruto) {
  if (!bruto) return [];
  try {
    const analisado = JSON.parse(bruto);
    return Array.isArray(analisado) ? analisado : [];
  } catch {
    return [];
  }
}

async function principal() {
  const env = process.env;
  const argv = process.argv.slice(2);

  if (argv.includes('--version')) {
    process.stdout.write(`${env.FAKE_ENGINE_VERSION ?? '9.9.9 (Fake Engine)'}\n`);
    return;
  }

  const stdin = await lerStdin();

  // O neto sobe ANTES do sidecar para que seu pid fique registrado mesmo se o
  // adapter matar o pai imediatamente.
  let pidDoNeto = null;
  if (env.FAKE_ENGINE_SPAWN_CHILD === '1') {
    const neto = spawn(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
      { stdio: 'ignore' },
    );
    neto.unref();
    pidDoNeto = neto.pid ?? null;
  }

  if (env.FAKE_ENGINE_RECORD) {
    writeFileSync(
      env.FAKE_ENGINE_RECORD,
      JSON.stringify(
        {
          pid: process.pid,
          pidDoNeto,
          argv,
          env: { ...env },
          cwd: process.cwd(),
          stdin,
          arquivos: arquivosDoWorkdir(),
        },
        null,
        2,
      ),
    );
  }

  if (env.FAKE_ENGINE_IGNORE_SIGTERM === '1') {
    process.on('SIGTERM', () => {});
    process.on('SIGINT', () => {});
  }

  for (const linha of analisarLinhas(env.FAKE_ENGINE_LINES)) {
    const fluxo = linha.stream === 'stderr' ? process.stderr : process.stdout;
    fluxo.write(`${linha.text}\n`);
  }

  process.exitCode = Number(env.FAKE_ENGINE_EXIT_CODE ?? 0);

  if (env.FAKE_ENGINE_HANG === '1') {
    setInterval(() => {}, 1000);
    return;
  }

  const espera = Number(env.FAKE_ENGINE_DELAY_MS ?? 0);
  if (espera > 0) await new Promise((resolve) => setTimeout(resolve, espera));
}

await principal();
