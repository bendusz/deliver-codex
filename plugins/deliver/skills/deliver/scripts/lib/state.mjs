import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const STATE_VERSION = 1;

export class DeliverError extends Error {
  constructor(message, code = 70, details = undefined) {
    super(message);
    this.name = 'DeliverError';
    this.code = code;
    this.details = details;
  }
}

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function readJsonFile(file, label = file) {
  let raw;
  try {
    if (fs.statSync(file).size > 8 * 1024 * 1024) throw new Error('file exceeds 8 MiB');
    raw = fs.readFileSync(file, 'utf8');
  }
  catch (error) { throw new DeliverError(`cannot read ${label}: ${error.message}`, 66); }
  try { return JSON.parse(raw); }
  catch (error) { throw new DeliverError(`invalid JSON in ${label}: ${error.message}`, 66); }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');

export function validateTaskPacket(packet) {
  if (!isObject(packet)) throw new DeliverError('task packet must be a JSON object', 66);
  const unknown = Object.keys(packet).filter((key) => !['id', 'objective', 'acceptance', 'read_paths', 'touches', 'commands', 'specs'].includes(key));
  if (unknown.length) throw new DeliverError(`unsupported task fields: ${unknown.join(', ')}`, 66);
  for (const key of ['id', 'objective']) {
    if (typeof packet[key] !== 'string' || packet[key].trim() === '') throw new DeliverError(`task packet ${key} must be a non-empty string`, 66);
  }
  if (!Array.isArray(packet.acceptance) || packet.acceptance.length === 0) {
    throw new DeliverError('task packet acceptance must be a non-empty array', 66);
  }
  const acceptance = packet.acceptance.map((item, index) => {
    if (!isObject(item) || typeof item.id !== 'string' || item.id.trim() === '' || typeof item.text !== 'string' || item.text.trim() === '') {
      throw new DeliverError(`task packet acceptance[${index}] must contain non-empty id and text strings`, 66);
    }
    return { id: item.id, text: item.text };
  });
  if (new Set(acceptance.map((item) => item.id)).size !== acceptance.length) throw new DeliverError('task packet acceptance ids must be unique', 66);
  if (!isStringArray(packet.read_paths) || !isStringArray(packet.touches)) {
    throw new DeliverError('task packet read_paths and touches must be string arrays', 66);
  }
  if (packet.touches.length === 0) throw new DeliverError('task packet touches must not be empty', 66);
  if (!isObject(packet.commands)) throw new DeliverError('task packet commands must be an object; use {} to record N/A', 66);
  const commands = Object.create(null);
  for (const [name, command] of Object.entries(packet.commands)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || typeof command !== 'string' || command.trim() === '') {
      throw new DeliverError('task packet command names and values must be non-empty safe strings', 66);
    }
    commands[name] = command;
  }
  if (packet.specs !== undefined && !isStringArray(packet.specs)) throw new DeliverError('task packet specs must be an array of strings', 66);
  return {
    id: packet.id,
    objective: packet.objective,
    acceptance,
    read_paths: [...packet.read_paths],
    touches: [...packet.touches],
    commands,
    specs: [...(packet.specs || [])],
  };
}

function validateState(state) {
  const fail = (message) => { throw new DeliverError(`invalid run state: ${message}`, 66); };
  if (!isObject(state)) fail('root must be an object');
  if (state.schema_version !== STATE_VERSION) fail(`schema_version must be ${STATE_VERSION}`);
  if (typeof state.run_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(state.run_id)) fail('bad run_id');
  if (!['quick', 'managed', 'governed'].includes(state.mode)) fail('bad mode');
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) fail('bad revision');
  if (typeof state.project_root !== 'string' || !path.isAbsolute(state.project_root)) fail('bad project_root');
  if (!isObject(state.plan) || (state.plan.path !== null && typeof state.plan.path !== 'string') || typeof state.plan.hash !== 'string') fail('bad plan');
  if (state.approval !== null && (!isObject(state.approval) || typeof state.approval.approver !== 'string' || typeof state.approval.plan_hash !== 'string')) fail('bad approval');
  if (!['initialized', 'starting', 'active', 'finished'].includes(state.phase)) fail('bad phase');
  if (!isObject(state.counters) || !['retries', 'fixes', 'corrections'].every((key) => Number.isSafeInteger(state.counters[key]) && state.counters[key] >= 0)) fail('bad counters');
  if (!Array.isArray(state.events) || !Array.isArray(state.gates) || !Array.isArray(state.checkpoints)) fail('bad collections');
  if (state.task !== null) {
    if (!isObject(state.task) || typeof state.task.builder !== 'string' || !isObject(state.task.packet)) fail('bad task');
    validateTaskPacket(state.task.packet);
  }
  if (state.baseline !== null) {
    if (!isObject(state.baseline) || !isObject(state.baseline.snapshot) || !isObject(state.baseline.snapshot.entries)
      || typeof state.baseline.snapshot.git_meta !== 'string' || typeof state.baseline.snapshot.hash !== 'string'
      || !isStringArray(state.baseline.dirty_paths)) fail('bad baseline');
    const expectedHash = sha256(canonical({ entries: state.baseline.snapshot.entries, git_meta: state.baseline.snapshot.git_meta }));
    if (state.baseline.snapshot.hash !== expectedHash) fail('baseline snapshot hash does not match its content');
  }
  for (const gate of state.gates) {
    if (!isObject(gate) || gate.provenance !== 'deliver-runtime-executed-v1' || typeof gate.name !== 'string'
      || typeof gate.command !== 'string' || !['PASS', 'FAIL'].includes(gate.status)
      || typeof gate.snapshot_hash !== 'string' || typeof gate.environment_hash !== 'string'
      || typeof gate.environment_additions_hash !== 'string') fail('bad gate receipt');
  }
  if (state.review !== null && (!isObject(state.review) || !['PASS', 'FAIL'].includes(state.review.status)
    || typeof state.review.builder !== 'string' || typeof state.review.reviewer !== 'string'
    || !Array.isArray(state.review.findings) || typeof state.review.snapshot_hash !== 'string')) fail('bad review');
  if (state.verification !== null && (!isObject(state.verification) || typeof state.verification.verifier !== 'string'
    || !Array.isArray(state.verification.criteria) || typeof state.verification.snapshot_hash !== 'string')) fail('bad verification');
  if (['active', 'finished'].includes(state.phase) && (!state.task || !state.baseline)) fail('active/finished run needs a task and baseline');
  if (state.task && state.review) {
    if (state.review.builder !== state.task.builder || state.review.reviewer === state.task.builder) fail('review identity violates separation');
    for (const finding of state.review.findings) {
      if (!isObject(finding) || !['block', 'major', 'minor'].includes(finding.severity)
        || typeof finding.message !== 'string' || !finding.message.trim() || typeof finding.resolved !== 'boolean') fail('bad review finding');
    }
  }
  if (state.task && state.verification) {
    const expected = state.task.packet.acceptance.map((criterion) => criterion.id).sort();
    const actual = state.verification.criteria.map((criterion) => {
      if (!isObject(criterion) || typeof criterion.id !== 'string' || !['PASS', 'FAIL', 'UNKNOWN'].includes(criterion.status)
        || typeof criterion.evidence !== 'string' || !criterion.evidence.trim()) fail('bad verification criterion');
      return criterion.id;
    }).sort();
    if (canonical(actual) !== canonical(expected)) fail('verification criteria do not match acceptance');
    if (state.verification.verifier === state.task.builder) fail('verification identity violates separation');
  }
  if (state.contracts !== undefined && state.contracts !== null) {
    if (!isObject(state.contracts) || !isObject(state.contracts.hashes) || !isStringArray(state.contracts.specs)
      || !isStringArray(state.contracts.editable_paths)) fail('bad frozen contracts');
    for (const [rel, hash] of Object.entries(state.contracts.hashes)) {
      if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || !/^[0-9a-f]{64}$/.test(hash)) fail('unsafe contract hash');
    }
  }
  return state;
}

export function currentPlanHash(state) {
  if (state.plan.path === null) return state.plan.hash;
  try { return sha256(fs.readFileSync(state.plan.path)); }
  catch { return null; }
}

export function approvalIsCurrent(state) {
  const hash = currentPlanHash(state);
  return state.approval !== null && hash !== null && state.approval.plan_hash === hash;
}

export function syncPlan(state) {
  const hash = currentPlanHash(state);
  if (hash === null) throw new DeliverError(`plan is missing or unreadable: ${state.plan.path}`, 66);
  if (hash !== state.plan.hash) {
    state.plan.hash = hash;
    state.approval = null;
    state.gates = [];
    state.review = null;
    state.verification = null;
    state.events.push({ at: new Date().toISOString(), type: 'plan_changed', plan_hash: hash });
  }
  return hash;
}

function checkedDirectory(dir, create) {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DeliverError(`runtime path must be a real directory: ${dir}`, 66);
  } catch (error) {
    if (error instanceof DeliverError) throw error;
    if (error.code !== 'ENOENT' || !create) throw new DeliverError(`runtime directory is unavailable: ${dir}`, 66);
    try { fs.mkdirSync(dir, { mode: 0o700 }); }
    catch (mkdirError) {
      if (mkdirError.code !== 'EEXIST') throw new DeliverError(`cannot create runtime directory: ${dir}`, 66);
    }
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DeliverError(`runtime path must be a real directory: ${dir}`, 66);
  }
  return dir;
}

export function internalDirectory(projectRoot, segments, create = true) {
  const root = fs.realpathSync(projectRoot);
  let cursor = checkedDirectory(path.join(root, '.deliver'), create);
  for (const segment of segments) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segment)) throw new DeliverError('unsafe runtime directory segment', 66);
    cursor = checkedDirectory(path.join(cursor, segment), create);
  }
  return cursor;
}

function runsDir(projectRoot, create = true) { return internalDirectory(projectRoot, ['runs'], create); }

function atomicWrite(file, value, exclusive = false) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  const tempFd = fs.openSync(temp, 'r');
  try { fs.fsyncSync(tempFd); } finally { fs.closeSync(tempFd); }
  try {
    if (exclusive && fs.existsSync(file)) throw new DeliverError(`run state already exists: ${file}`, 66);
    fs.renameSync(temp, file);
    let dirFd;
    try {
      dirFd = fs.openSync(path.dirname(file), 'r');
      fs.fsyncSync(dirFd);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
    } finally { if (dirFd !== undefined) fs.closeSync(dirFd); }
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

export function createRun(projectRoot, mode, planPath = null) {
  if (!['quick', 'managed', 'governed'].includes(mode)) throw new DeliverError('mode must be quick, managed, or governed', 64);
  const root = fs.realpathSync(projectRoot);
  if (!planPath && mode !== 'quick') throw new DeliverError('--plan is required in managed and governed modes', 64);
  const plan = planPath ? path.resolve(root, planPath) : null;
  let planHash = sha256('quick:no-plan');
  if (plan !== null) {
    try { planHash = sha256(fs.readFileSync(plan)); }
    catch (error) { throw new DeliverError(`cannot read plan: ${error.message}`, 66); }
  }
  const runId = randomUUID();
  const now = new Date().toISOString();
  const state = {
    schema_version: STATE_VERSION,
    run_id: runId,
    mode,
    revision: 0,
    project_root: root,
    created_at: now,
    updated_at: now,
    phase: 'initialized',
    plan: { path: plan, hash: planHash },
    approval: null,
    task: null,
    baseline: null,
    gates: [],
    review: null,
    verification: null,
    checkpoints: [],
    counters: { retries: 0, fixes: 0, corrections: 0 },
    events: [{ at: now, type: 'initialized', mode, plan_hash: planHash }],
  };
  const file = path.join(runsDir(root), `${runId}.json`);
  atomicWrite(file, state, true);
  return { state, file };
}

export function resolveRunPath(runArg, cwd = process.cwd()) {
  if (!runArg) throw new DeliverError('--run is required', 64);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runArg)) {
    let cursor = path.resolve(cwd);
    while (true) {
      const candidate = path.join(cursor, '.deliver', 'runs', `${runArg}.json`);
      if (fs.existsSync(candidate)) return candidate;
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    return path.join(cwd, '.deliver', 'runs', `${runArg}.json`);
  }
  return path.resolve(cwd, runArg);
}

export function readRun(runArg, cwd = process.cwd()) {
  const unresolvedFile = resolveRunPath(runArg, cwd);
  let file;
  let lexicalRoot;
  try {
    const runs = path.dirname(unresolvedFile);
    const deliver = path.dirname(runs);
    if (path.basename(runs) !== 'runs' || path.basename(deliver) !== '.deliver') throw new DeliverError('run state must be under .deliver/runs', 66);
    for (const dir of [deliver, runs]) {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DeliverError(`runtime path must be a real directory: ${dir}`, 66);
    }
    const stat = fs.lstatSync(unresolvedFile);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new DeliverError('run state must be a regular file, not a symlink', 66);
    lexicalRoot = fs.realpathSync(path.dirname(deliver));
    file = fs.realpathSync(unresolvedFile);
    const expected = path.join(lexicalRoot, '.deliver', 'runs', path.basename(unresolvedFile));
    if (file !== expected) throw new DeliverError('run state is outside the canonical project runs directory', 66);
  } catch (error) {
    if (error instanceof DeliverError) throw error;
    throw new DeliverError(`cannot read run state: ${error.message}`, 66);
  }
  const state = validateState(readJsonFile(file, 'run state'));
  let actualRoot;
  try { actualRoot = fs.realpathSync(state.project_root); } catch { throw new DeliverError('run project root no longer exists', 66); }
  if (actualRoot !== state.project_root || actualRoot !== lexicalRoot) throw new DeliverError('run project root identity changed', 66);
  if (path.basename(file) !== `${state.run_id}.json`) throw new DeliverError('run filename does not match run_id', 66);
  return { state, file };
}

function acquireLock(file) {
  const lock = `${file}.lock`;
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new DeliverError(`run is locked by another process: ${lock}`, 66);
    throw error;
  }
  fs.writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
  return () => { try { fs.closeSync(fd); } finally { try { fs.unlinkSync(lock); } catch {} } };
}

export function updateRun(runArg, expectedRevision, mutate, cwd = process.cwd()) {
  const file = readRun(runArg, cwd).file;
  const unlock = acquireLock(file);
  try {
    const { state } = readRun(file, cwd);
    if (expectedRevision !== undefined && state.revision !== expectedRevision) {
      throw new DeliverError(`revision conflict: expected ${expectedRevision}, found ${state.revision}`, 66);
    }
    const result = mutate(state);
    state.revision += 1;
    state.updated_at = new Date().toISOString();
    validateState(state);
    atomicWrite(file, state);
    return { state, file, result };
  } finally { unlock(); }
}
