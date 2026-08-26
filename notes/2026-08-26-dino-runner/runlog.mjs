#!/usr/bin/env node
// Operator's tooling for the run log. Subcommands:
//   sync            fetch events newer than the last one seen → pending buffer
//   note "<text>"   an operator annotation → pending buffer (tagged [operator])
//   flush           when safe, append pending to the repo file and commit
//   status          what is buffered and whether a flush would be safe
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';

const SP = '<scratchpad>';
const REPO = '<operator-home>/dino-runner';
const FILE = 'docs/runs/2026-08-26-dino-runner-through-cartografo.md';
const BASE = 'http://127.0.0.1:4317';
const TOKEN = readFileSync(join(SP, 'cartografo.token'), 'utf8').trim();
const STATE = join(SP, 'runlog.state.json');
const PENDING = join(SP, 'runlog.pending');
const HEADER = join(SP, 'runlog.header.md');
const UNSAFE_NODES = new Set(['develop', 'integrate']);

const api = async (path) => {
  const res = await fetch(BASE + path, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
};
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { lastEventId: 0 };
const save = () => writeFileSync(STATE, JSON.stringify(state));
const pending = () => (existsSync(PENDING) ? readFileSync(PENDING, 'utf8') : '');
const push = (line) => appendFileSync(PENDING, line + '\n');
const clock = (iso) => iso.slice(11, 19) + 'Z';
const usage = (u) => (u ? `${u.output_tokens} out · cache ${u.cache_creation_input_tokens ?? 0} w / ${u.cache_read_input_tokens ?? 0} r` : 'no usage');
const short = (s, n = 160) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').slice(0, n) : '');

function summary(session) {
  const o = session?.output;
  if (!o || typeof o !== 'object') return '';
  switch (session.node_id) {
    case 'refine': {
      const spec = typeof o.specification === 'string' ? o.specification : '';
      const criteria = (spec.match(/^- \*\*?[A-Z]\d+/gm) || spec.match(/\bA\d+\./g) || []).length;
      return `specification ${spec.length} chars${criteria ? `, ~${criteria} criteria` : ''}${o.model_tier ? `, tier ${o.model_tier}` : ''}${o.note ? ` — ${short(o.note, 140)}` : ''}`;
    }
    case 'develop': {
      const gates = o.gates && typeof o.gates === 'object' ? Object.values(o.gates) : [];
      const passed = gates.filter((g) => g === 'passed').length;
      return `branch \`${o.branch}\`, commits ${(o.commits || []).map((c) => `\`${c}\``).join(', ')}, gates ${passed}/${gates.length} passed${o.note ? ` — ${short(o.note, 140)}` : ''}`;
    }
    case 'integrate':
      return `merge commit \`${o.merge_commit ?? '?'}\`${o.note ? ` — ${short(o.note, 140)}` : ''}`;
    case 'test': {
      const verdicts = Array.isArray(o.verdicts) ? o.verdicts : [];
      const counts = {};
      for (const v of verdicts) counts[v.verdict] = (counts[v.verdict] || 0) + 1;
      const bugs = Array.isArray(o.bugs) ? o.bugs.length : 0;
      return `outcome **${o.outcome ?? '?'}**, verdicts ${JSON.stringify(counts)}, ${bugs} bug(s)${o.note ? ` — ${short(o.note, 140)}` : ''}`;
    }
    case 'deploy':
      return `verdict **${o.verdict ?? '?'}**${o.release ? `, release \`${o.release}\`` : ''}${o.deployed_at ? `, deployed_at ${o.deployed_at}` : ''}${o.note ? ` — ${short(o.note, 120)}` : ''}`;
    default:
      return o.note ? short(o.note, 140) : '';
  }
}

function render(e, sessionsById) {
  const t = clock(e.occurred_at);
  const d = e.data || {};
  const id = e.entity?.id ?? e.entity_id ?? '';
  switch (e.type) {
    case 'job.created':
      return `- ${t} — **job ${id} created** via the API, execution ${e.execution_id}, entry \`${d.entry_node_id}\`: "${d.title}". \`[operator]\``;
    case 'session.opened':
      return `- ${t} — session ${id} opened on \`${d.node_id}\` (job ${d.job_id}, engine ${d.engine}, worktree \`${basename(d.working_dir || '')}\`). \`[cartografo]\``;
    case 'session.finished': {
      const s = sessionsById.get(Number(id));
      const extra = summary(s);
      const why = [d.timeout_reason ? `timeout ${d.timeout_reason}` : '', d.failure_kind ? d.failure_kind : ''].filter(Boolean).join(', ');
      return `- ${t} — session ${id} on \`${s?.node_id ?? '?'}\` finished **${d.status}** (exit ${d.exit_code}${why ? `, ${why}` : ''}) — ${usage(d.usage)}${extra ? ` — ${extra}` : ''}. \`[cartografo]\``;
    }
    case 'job.transitioned':
      return `- ${t} — job ${id} moved \`${d.from_node_id ?? '(entry)'}\` → \`${d.to_node_id}\`: the report passed the node's checks. \`[cartografo]\``;
    case 'job.blocked':
      return `- ${t} — **job ${id} blocked**: ${short(d.reason ?? d.block_reason ?? JSON.stringify(d), 200)}. \`[cartografo]\``;
    case 'job.unblocked':
      return `- ${t} — job ${id} unblocked by the control plane once its question was answered. \`[cartografo]\``;
    case 'job.completed':
      return `- ${t} — **job ${id} completed** at its final node. \`[cartografo]\``;
    case 'execution.finished':
      return `- ${t} — **execution ${e.execution_id} finished**. \`[cartografo]\``;
    default:
      if (e.type.startsWith('input_request.') || e.type.startsWith('input-request.')) {
        const answered = /answer/.test(e.type);
        const who = d.answered_by ? ` by ${d.answered_by}` : '';
        return `- ${t} — **${e.type}**${who} (input-request ${id}${d.job_id ? `, job ${d.job_id}` : ''}): ${short(d.question ?? d.answer ?? JSON.stringify(d), 220)}. \`[human gate]\`${answered ? '' : ' — waiting on a person'}`;
      }
      return `- ${t} — ${e.type}${d && Object.keys(d).length ? `: ${short(JSON.stringify(d), 160)}` : ''}. \`[cartografo]\``;
  }
}

async function sync() {
  const executions = (await api('/v1/executions')).executions || [];
  const sessions = (await api('/v1/sessions')).sessions || [];
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const events = [];
  for (const ex of executions) {
    const exId = ex.id ?? ex.execution_id; const list = (await api(`/v1/executions/${exId}/events`)).events || [];
    for (const e of list) if (e.id > state.lastEventId) events.push(e);
  }
  events.sort((a, b) => a.id - b.id);
  for (const e of events) {
    push(render(e, byId));
    state.lastEventId = e.id;
  }
  save();
  console.log(`sync: ${events.length} new event(s) buffered (last id ${state.lastEventId})`);
}

async function safety() {
  const jobs = (await api('/v1/jobs')).jobs || [];
  const sessions = (await api('/v1/sessions')).sessions || [];
  const busyJobs = jobs.filter((j) => !j.completed && UNSAFE_NODES.has(j.current_node_id)).map((j) => `job ${j.id} on ${j.current_node_id}`);
  const busySessions = sessions.filter((s) => s.status === 'open' && UNSAFE_NODES.has(s.node_id)).map((s) => `session ${s.id} open on ${s.node_id}`);
  const dirty = execFileSync('git', ['-C', REPO, 'status', '--porcelain'], { encoding: 'utf8' })
    .split('\n').filter(Boolean).filter((l) => !l.endsWith(FILE));
  return { safe: busyJobs.length === 0 && busySessions.length === 0 && dirty.length === 0, busyJobs, busySessions, dirty };
}

async function flush() {
  if (existsSync(join(SP, 'runlog.paused'))) { console.log(`flush: PAUSED by the operator (${pending().split('\n').filter(Boolean).length} line(s) buffered)`); return; }
  const buffered = pending();
  if (!buffered) { console.log('flush: nothing buffered'); return; }
  const s = await safety();
  if (!s.safe) {
    console.log(`flush: NOT safe (${[...s.busyJobs, ...s.busySessions, ...s.dirty.map((d) => `dirty: ${d}`)].join('; ')}); ${buffered.split('\n').filter(Boolean).length} line(s) stay buffered`);
    return;
  }
  const target = join(REPO, FILE);
  mkdirSync(dirname(target), { recursive: true });
  if (!existsSync(target)) writeFileSync(target, readFileSync(HEADER, 'utf8'));
  appendFileSync(target, buffered);
  const n = buffered.split('\n').filter(Boolean).length;
  execFileSync('git', ['-C', REPO, 'add', FILE]);
  execFileSync('git', ['-C', REPO, '-c', 'user.name=cartografo operator (Claude)', '-c', 'user.email=noreply@anthropic.com', 'commit', '-q', '-m', `docs(run): ${n} event(s) from the cartografo log`]);
  rmSync(PENDING, { force: true });
  const hash = execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  console.log(`flush: ${n} line(s) committed as ${hash}`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'sync') await sync();
else if (cmd === 'note') { const now = new Date().toISOString(); push(`- ${clock(now)} — ${rest.join(' ')} \`[operator]\``); console.log('note buffered'); }
else if (cmd === 'flush') await flush();
else if (cmd === 'status') { const s = await safety(); console.log(JSON.stringify({ lastEventId: state.lastEventId, buffered: pending().split('\n').filter(Boolean).length, ...s })); }
else { console.error('usage: runlog.mjs sync | note "<text>" | flush | status'); process.exit(2); }
