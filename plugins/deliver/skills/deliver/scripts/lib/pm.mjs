// Shared project records follow upstream Deliver 0.22.0. Execution receipts stay
// in .deliver; they never replace pm/ as the source of project progress.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DeliverError, canonical, sha256, internalDirectory, readRun } from './state.mjs';
import { detectProjectFormat } from './project-state.mjs';
import { assertCurrentBinding, prepareCurrentBinding } from './current-pm.mjs';

const record = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const fail = (message) => { throw new DeliverError(message, 66); };
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const stamp = () => new Date().toISOString().replace('T', ' ').replace('Z', '');
const safeText = (value, label, max = 1000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(`invalid ${label}`);
  return value;
};
function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }).replace(/(\r?\n)+$/, '');
}

// Same POSIX cksum and historical salt as upstream hooks/lib.mjs. Keep actor
// identity stable across hosts, including ASCII-only case folding.
function cksum(text) {
  const bytes = Buffer.from(text);
  let crc = 0;
  function add(byte) {
    crc = (crc ^ (byte << 24)) >>> 0;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0)) >>> 0;
  }
  for (const byte of bytes) add(byte);
  for (let size = bytes.length; size > 0; size = Math.floor(size / 256)) add(size & 255);
  return (~crc >>> 0).toString(16).padStart(8, '0');
}
export function pmActorId(root) {
  let identity = '';
  for (const key of ['user.email', 'user.name']) {
    try { identity = git(root, ['config', key]); } catch {}
    if (identity) break;
  }
  identity = identity.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const slug = identity.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) fail('Git identity is required for shared PM state');
  return `${slug}-${(cksum(identity) + cksum(`${identity}:pm-skill`)).slice(0, 12)}`;
}

function checkedPath(root, rel) {
  if (typeof rel !== 'string' || path.isAbsolute(rel) || rel.split(/[\\/]/).some((part) => !part || part === '..' || part === '.') || /[\x00-\x1f\x7f]/.test(rel)) fail('unsafe shared-state path');
  let cursor = root;
  for (const part of rel.split('/')) {
    cursor = path.join(cursor, part);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) fail(`shared-state path is a symlink: ${rel}`); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
  return path.join(root, rel);
}
function read(root, rel) {
  const file = checkedPath(root, rel);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) fail(`invalid shared-state file: ${rel}`);
    return fs.readFileSync(file, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function parse(text, label) {
  try { const value = JSON.parse(text); if (record(value)) return value; } catch {}
  fail(`invalid ${label}`);
}
function secretScan(text) {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{17,}\.eyJ[A-Za-z0-9_-]{10,}/.test(text)
    || /(?:api[_-]?key|secret|token|passw(?:or)?d|credential)["']?\s*[:=]\s*["'][A-Za-z0-9_/+=.-]{8,}["']/i.test(text)
    || /(?:api[_-]?key|secret|token|passw(?:or)?d|credential)\s*[:=]\s*[A-Za-z0-9_/+=.-]{8,}/i.test(text)) fail('secret-shaped content cannot be written to tracked PM records');
}
function project(value) {
  if (!record(value) || typeof value.project !== 'string' || typeof value.signed_off !== 'boolean'
    || !record(value.assignments) || typeof value.integration_branch !== 'string'
    || typeof value.phase !== 'string' || typeof value.scale !== 'string') fail('unsupported pm/pm-state.json schema; reconcile with upstream first');
  for (const [story, owner] of Object.entries(value.assignments)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(story) || typeof owner !== 'string' || !owner) fail('invalid PM assignment');
  }
  return value;
}
function actor(value, id) {
  if (!record(value) || value.actor !== id || !Array.isArray(value.parallel_batch)
    || !Object.hasOwn(value, 'current_story') || typeof value.next !== 'string') fail('unsupported actor state; reconcile with upstream first');
  if (value.current_story_status !== null && !['building', 'built', 'in-review', 'merged', 'blocked'].includes(value.current_story_status)) fail('unsupported actor story status');
  if (value.current_story !== null && (typeof value.current_story !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.current_story))) fail('invalid actor story ID');
  if (value.current_story_verification_status !== null && !['pending', 'PASS', 'FAIL', 'UNKNOWN'].includes(value.current_story_verification_status)) fail('unsupported actor verification status');
  if (value.resolved_builder !== null && !['expert-builder', 'codex-builder'].includes(value.resolved_builder)) fail('unsupported persisted builder route');
  for (const key of ['current_story_rounds', 'current_story_retries']) if (value[key] !== null && (!Number.isSafeInteger(value[key]) || value[key] < 0)) fail('invalid actor retry counters');
  return value;
}
function newActor(id, now) {
  return { actor: id, current_story: null, current_story_status: null, current_story_verification_status: null,
    current_story_rounds: null, current_story_retries: null, branch: null, resolved_builder: null,
    parallel_batch: [], next: 'Choose the next ready story.', handoff_written: null, updated: now };
}
function assertNoTransaction(root) {
  if (read(root, '.deliver/pm-transaction.json') !== null) fail('interrupted PM transaction; run pm.mjs recover before continuing');
}
export function readPm(root) {
  assertNoTransaction(root);
  const raw = read(root, 'pm/pm-state.json');
  if (raw === null) return null;
  const id = pmActorId(root);
  const actorPath = `pm/actors/${id}.json`;
  const actorRaw = read(root, actorPath);
  return { core: project(parse(raw, 'PM state')), actor: actorRaw === null ? null : actor(parse(actorRaw, 'actor state'), id), actorId: id, actorPath };
}

function atomic(root, rel, content) {
  const file = checkedPath(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  checkedPath(root, rel);
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temp, file); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function withLock(root, callback) {
  const dir = internalDirectory(root, []);
  const lock = path.join(dir, 'pm.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') fail('PM records are locked; inspect the owner before recovery');
    throw error;
  }
  fs.writeFileSync(fd, `${process.pid}\n`);
  try { return callback(); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
function applyJournal(root, journal) {
  const id = pmActorId(root);
  const allowed = new Set(['pm/pm-state.json', 'pm/log.md', `pm/actors/${id}.json`, `pm/actors/${id}.HANDOFF.md`]);
  if (!record(journal) || journal.actor !== id || !Array.isArray(journal.writes) || journal.writes.length > 4) fail('invalid PM recovery journal');
  if (new Set(journal.writes.map((item) => item.path)).size !== journal.writes.length) fail('duplicate PM journal path');
  for (const item of journal.writes) {
    if (!allowed.has(item.path) || !(item.before === null || typeof item.before === 'string') || typeof item.after !== 'string') fail('unsafe PM recovery journal');
    secretScan(item.after);
    const current = read(root, item.path);
    if (current !== item.before && current !== item.after) fail(`PM transaction conflict at ${item.path}; preserve and reconcile both versions`);
  }
  for (const item of journal.writes) {
    if (read(root, item.path) === item.after) continue;
    if (read(root, item.path) !== item.before) fail(`PM transaction conflict at ${item.path}`);
    atomic(root, item.path, item.after);
  }
}
function transact(root, makeWrites) {
  return withLock(root, () => {
    assertNoTransaction(root);
    const pending = new Map();
    const get = (rel) => {
      if (!pending.has(rel)) pending.set(rel, { path: rel, before: read(root, rel) });
      return pending.get(rel).before;
    };
    const set = (rel, content) => { get(rel); secretScan(content); pending.get(rel).after = content; };
    const result = makeWrites(get, set);
    const writes = [...pending.values()].filter((item) => item.after !== undefined && item.after !== item.before);
    if (!writes.length) return result;
    for (const item of writes) {
      try { git(root, ['check-ignore', '--no-index', '-q', '--', item.path]); }
      catch (error) { if (error.status === 1) continue; throw error; }
      fail(`shared PM record is ignored by Git: ${item.path}`);
    }
    for (const item of pending.values()) if (read(root, item.path) !== item.before) fail(`PM records changed concurrently: ${item.path}`);
    const journal = { actor: pmActorId(root), writes };
    atomic(root, '.deliver/pm-transaction.json', json(journal));
    applyJournal(root, journal);
    fs.unlinkSync(checkedPath(root, '.deliver/pm-transaction.json'));
    return result;
  });
}
export function recoverPm(root) {
  return withLock(root, () => {
    const raw = read(root, '.deliver/pm-transaction.json');
    if (raw === null) return { recovered: false };
    applyJournal(root, parse(raw, 'PM journal'));
    fs.unlinkSync(checkedPath(root, '.deliver/pm-transaction.json'));
    return { recovered: true };
  });
}
function appendLog(get, set, id, message, now) {
  const previous = get('pm/log.md') || '';
  set('pm/log.md', `${previous}${previous && !previous.endsWith('\n') ? '\n' : ''}- ${now} ${id}: ${message}\n`);
}
export function initializePm(root, name = path.basename(root)) {
  safeText(name, 'project name', 200);
  return transact(root, (get, set) => {
    const id = pmActorId(root), now = stamp();
    const existing = get('pm/pm-state.json');
    if (existing !== null) project(parse(existing, 'PM state'));
    else {
      const branch = git(root, ['symbolic-ref', '--short', 'HEAD']);
      set('pm/pm-state.json', json({ project: name, spec: null, constitution: null, scale: 'standard', phase: 'discovery',
        signed_off: false, approver: null, approved_date: null, integration_branch: branch,
        current_sprint: null, total_sprints: null, last_analysis_status: null, assignments: {}, updated: now }));
    }
    const actorPath = `pm/actors/${id}.json`;
    const existingActor = get(actorPath);
    if (existingActor !== null) actor(parse(existingActor, 'actor state'), id);
    else set(actorPath, json(newActor(id, now)));
    if (existing === null || existingActor === null) appendLog(get, set, id, 'Initialized shared Deliver project/actor records; no approval or story completion implied.', now);
    return { actor: id, state_path: 'pm/pm-state.json' };
  });
}
export function approvePm(root, approver) {
  safeText(approver, 'approver', 128);
  return transact(root, (get, set) => {
    const core = project(parse(get('pm/pm-state.json'), 'PM state'));
    const now = stamp();
    core.signed_off = true; core.approver = approver; core.approved_date = now; core.updated = now;
    set('pm/pm-state.json', json(core));
    appendLog(get, set, pmActorId(root), `Recorded explicit project sign-off by ${approver}. Runtime plan approval remains content-bound.`, now);
    return { signed_off: true };
  });
}
export function readStory(root, rel) {
  if (typeof rel !== 'string' || !rel.startsWith('docs/stories/') || !rel.endsWith('.md')) fail('story must be an explicit docs/stories/*.md path');
  const text = read(root, rel);
  if (text === null) fail(`story is missing: ${rel}`);
  const id = /^# ([A-Za-z0-9][A-Za-z0-9._-]*):/m.exec(text)?.[1];
  const metadata = /<!--\s*pm-meta:\s*(\{[^\n]+\})\s*-->/.exec(text)?.[1];
  if (!id || ['__proto__', 'constructor', 'prototype'].includes(id) || !metadata) fail('story needs its upstream ID heading and pm-meta');
  const meta = parse(metadata, 'story pm-meta');
  if (!['auto', 'codex-builder', 'expert-builder'].includes(meta.builder) || !Array.isArray(meta.touches) || !meta.touches.length) fail('unsupported story pm-meta');
  for (const scope of meta.touches) {
    checkedPath(root, scope);
    if (/[*?\[\]{}]/.test(scope) || scope === 'pm' || scope.startsWith('pm/') || scope.startsWith('.deliver') || scope.startsWith('.git')) fail('invalid story write scope');
  }
  const section = /^## Acceptance criteria[^\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(text)?.[1];
  const criteria = [...(section || '').matchAll(/^- \[[ xX]\] (.+)$/gm)].map((item) => item[1].trim());
  if (!criteria.length) fail('story needs explicit acceptance checkboxes');
  return { id, path: rel, hash: sha256(text), meta, criteria };
}
export function claimPm(root, storyPath, plannedBranch) {
  const story = readStory(root, storyPath);
  if (story.meta.builder === 'expert-builder') fail('story explicitly routes to the original expert-builder; obtain an approved routing change before using Codex');
  return transact(root, (get, set) => {
    const id = pmActorId(root), now = stamp();
    const core = project(parse(get('pm/pm-state.json'), 'PM state'));
    const actorPath = `pm/actors/${id}.json`;
    const mine = actor(parse(get(actorPath), 'actor state'), id);
    if (!core.signed_off) fail('shared project sign-off is required before claiming implementation');
    if (mine.parallel_batch.length) fail('finish or reconcile the existing parallel batch before switching hosts');
    if (mine.current_story && mine.current_story_status !== 'merged') fail('mid-story host takeover is unsupported; resume the owning host or finish its handoff');
    if (Object.values(core.assignments).includes(id)) fail('actor still has an active or stale claim');
    if (Object.hasOwn(core.assignments, story.id)) fail('story is already claimed');
    // Another actor file can reveal a stale claim even if assignments was cleared.
    for (const name of fs.readdirSync(checkedPath(root, 'pm/actors'))) {
      if (!name.endsWith('.json') || name === `${id}.json`) continue;
      const other = parse(read(root, `pm/actors/${name}`), 'other actor');
      if (other.current_story === story.id && other.current_story_status !== 'merged') fail('another actor still records this story as active');
    }
    const branch = plannedBranch || git(root, ['symbolic-ref', '--short', 'HEAD']);
    git(root, ['check-ref-format', '--branch', branch]);
    core.assignments[story.id] = id; core.phase = 'implementation'; core.updated = now;
    Object.assign(mine, { current_story: story.id, current_story_status: 'building', current_story_verification_status: 'UNKNOWN',
      current_story_rounds: 0, current_story_retries: 0, branch, resolved_builder: 'codex-builder',
      next: `Codex owns ${story.id}. Resume its .deliver run; do not switch hosts mid-story. Story: ${storyPath}`, handoff_written: null, updated: now });
    set('pm/pm-state.json', json(core)); set(actorPath, json(mine));
    appendLog(get, set, id, `Claimed ${story.id} for native Codex execution. Shared route: codex-builder.`, now);
    return { actor: id, story: story.id, claim_visibility: 'local until explicitly committed/pushed' };
  });
}
function prepareLegacyBinding(state, packet, storyPath) {
  const pm = readPm(state.project_root);
  if (!pm) return null;
  if (!storyPath) fail('PM-managed projects require start --story docs/stories/<story>.md');
  const story = readStory(state.project_root, storyPath);
  if (!pm.core.signed_off || !pm.actor || pm.actor.parallel_batch.length
    || pm.core.assignments[story.id] !== pm.actorId || pm.actor.current_story !== story.id
    || pm.actor.current_story_status !== 'building' || pm.actor.resolved_builder !== 'codex-builder') fail('a current Codex story claim and shared sign-off are required');
  if (packet.id !== story.id || canonical(packet.acceptance.map((criterion) => criterion.text)) !== canonical(story.criteria)) fail('task must preserve the story ID and every acceptance criterion in order');
  if (!packet.touches.every((touch) => story.meta.touches.some((scope) => touch === scope || touch.startsWith(`${scope}/`)))) fail('task touches exceed the shared story scope');
  if (pm.actor.branch !== git(state.project_root, ['symbolic-ref', '--short', 'HEAD'])) fail('check out the claimed story branch before starting');
  const runs = internalDirectory(state.project_root, ['runs']);
  for (const name of fs.readdirSync(runs).filter((name) => /^[0-9a-f-]{36}\.json$/.test(name))) {
    if (name === `${state.run_id}.json`) continue;
    const other = readRun(path.join(runs, name)).state;
    if (other.pm_binding?.actor === pm.actorId && other.pm_binding.story === story.id) fail('story already has a Codex run; resume it without resetting counters');
  }
  state.counters.retries = pm.actor.current_story_retries ?? 0;
  state.counters.fixes = pm.actor.current_story_rounds ?? 0;
  if (state.counters.retries > 2 || state.counters.fixes > 3) fail('persisted story retry budget is already exhausted');
  return { format: 'legacy', actor: pm.actorId, story: story.id, story_path: story.path, story_hash: story.hash,
    integration_branch: pm.core.integration_branch, actor_path: pm.actorPath };
}
function assertLegacyBinding(state) {
  if (!state.pm_binding) return;
  const binding = state.pm_binding, pm = readPm(state.project_root);
  if (!pm || pm.actorId !== binding.actor || !pm.core.signed_off || !pm.actor
    || pm.core.assignments[binding.story] !== binding.actor || pm.actor.current_story !== binding.story
    || pm.core.integration_branch !== binding.integration_branch || pm.actor.resolved_builder !== 'codex-builder') fail('shared PM identity, approval or story ownership changed');
  if (readStory(state.project_root, binding.story_path).hash !== binding.story_hash) fail('shared story changed; reconcile and reapprove before continuing');
}

export function preparePmBinding(state, packet, storyPath) {
  const format = detectProjectFormat(state.project_root);
  if (format === 'current') return prepareCurrentBinding(state, packet, storyPath);
  if (format === 'legacy') return prepareLegacyBinding(state, packet, storyPath);
  return null;
}

export function assertPmBinding(state, options = {}) {
  if (!state.pm_binding) {
    if (detectProjectFormat(state.project_root) === 'current') fail('current project run is missing its shared story binding');
    return;
  }
  if (state.pm_binding.format === 'current') return assertCurrentBinding(state, options);
  return assertLegacyBinding(state);
}

export function completePm(root, runArg, commit, next, snapshotReader) {
  safeText(next, 'next action');
  if (!/^[0-9a-f]{40,64}$/.test(commit || '')) fail('completion requires a full integration commit SHA');
  const state = readRun(runArg, root).state;
  if (state.project_root !== root || state.phase !== 'finished' || !state.pm_binding || !state.completion_snapshot) fail('completion needs a finished, PM-bound run with a retained verified snapshot');
  if (state.pm_binding.format === 'current') fail('current story completion is handled by the current integration workflow');
  const b = state.pm_binding;
  assertPmBinding(state);
  if (state.review?.status !== 'PASS' || !state.verification?.criteria.every((item) => item.status === 'PASS')) fail('independent verification is required');
  if (git(root, ['symbolic-ref', '--short', 'HEAD']) !== b.integration_branch || git(root, ['rev-parse', 'HEAD']) !== commit) fail('check out the actual integration commit before recording merged progress');
  // Only read Git state. The caller owns every commit, merge and push.
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.split('\n').some((line) => line && !line.slice(3).startsWith('.deliver/'))) fail('commit/reconcile work before recording merged progress');
  if (typeof snapshotReader !== 'function') fail('PM snapshot reader is unavailable');
  const current = snapshotReader(root, [...state.task.packet.touches, ...state.task.packet.read_paths, ...state.task.packet.specs]);
  if (canonical(current.entries) !== canonical(state.completion_snapshot.entries)) fail('integration content differs from the verified tree; obtain fresh integration verification');
  return transact(root, (get, set) => {
    const core = project(parse(get('pm/pm-state.json'), 'PM state'));
    const mine = actor(parse(get(b.actor_path), 'actor state'), b.actor);
    if (core.assignments[b.story] !== b.actor || mine.current_story !== b.story) fail('story ownership changed before completion');
    const now = stamp();
    delete core.assignments[b.story]; core.updated = now;
    Object.assign(mine, { current_story_status: 'merged', current_story_verification_status: 'PASS',
      current_story_rounds: state.counters.fixes, current_story_retries: state.counters.retries,
      branch: b.integration_branch, resolved_builder: null, next, handoff_written: now, updated: now });
    set('pm/pm-state.json', json(core)); set(b.actor_path, json(mine));
    const handoff = `# HANDOFF ${now}\n\nOBJECTIVE: ${b.story} completed\nPOSITION: story ${b.story} · status merged · verification PASS\nBRANCH: ${b.integration_branch}\nCOMMIT: ${commit}\nREAD_FIRST: pm/pm-state.json, ${b.actor_path}, ${b.story_path}\nDONE_THIS_RUN:\n- Verified and integrated ${b.story}. Native review and acceptance passed.\n- Fix rounds: ${state.counters.fixes}; retries: ${state.counters.retries}.\nNEXT:\n1. ${next}\n\nCodex receipts remain under .deliver/runs/${state.run_id}.json. They are historical evidence, not project progress. Rerun checks for future changes.\n`;
    set(`pm/actors/${b.actor}.HANDOFF.md`, handoff);
    appendLog(get, set, b.actor, `Merged ${b.story} at ${commit}; verification PASS; rounds ${state.counters.fixes}, retries ${state.counters.retries}. Next: ${next}`, now);
    return { story: b.story, status: 'merged', commit, handoff: `pm/actors/${b.actor}.HANDOFF.md`, next };
  });
}
