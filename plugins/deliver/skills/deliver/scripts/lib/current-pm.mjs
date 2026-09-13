import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DeliverError, canonical, createRunState, internalDirectory, readRun, sha256, validateRunState } from './state.mjs';
import { inspectProjectState, readApprovalMarker, readPlanPolicy } from './project-state.mjs';
import { isValidGitBranchName, parseStory, readStory, replaceStoryExecution, storyTaskContract } from './story.mjs';
import { baselineDirtyPaths, captureGitAnchor, snapshot } from './scope.mjs';
import { captureContracts } from './contracts.mjs';

const APPROVAL = 'docs/approval.json';
const PLAN = 'docs/plan.md';
const JOURNAL = '.deliver/current-pm-transaction.json';
const TRANSITION_JOURNAL = '.deliver/transition-transaction.json';
const CORRECTION_JOURNAL = '.deliver/integration-correction-transaction.json';
const MAX_BYTES = 8 * 1024 * 1024;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message) => { throw new DeliverError(message, 66); };
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const stamp = () => new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, 16);

function safeText(value, label, max = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(`invalid ${label}`);
  return value;
}

function secretScan(text) {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{17,}\.eyJ[A-Za-z0-9_-]{10,}/.test(text)
    || /(?:api[_-]?key|secret|token|passw(?:or)?d|credential)["']?\s*[:=]\s*["'][A-Za-z0-9_/+=.-]{8,}["']/i.test(text)
    || /(?:api[_-]?key|secret|token|passw(?:or)?d|credential)\s*[:=]\s*[A-Za-z0-9_/+=.-]{8,}/i.test(text)) fail('secret-shaped content cannot be written to tracked project records');
}

function rootPath(root) {
  try {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('project root must be a real directory');
    return fs.realpathSync.native(root);
  } catch (error) {
    if (error instanceof DeliverError) throw error;
    fail(`cannot access project root: ${error.message}`);
  }
}

function safeRel(rel) {
  if (typeof rel !== 'string' || path.isAbsolute(rel) || /[\x00-\x1f\x7f]/.test(rel)) fail('unsafe current project path');
  const parts = rel.split(/[\\/]/);
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..')) fail('unsafe current project path');
  const normalized = parts.join('/');
  if (normalized !== APPROVAL && normalized !== JOURNAL && normalized !== CORRECTION_JOURNAL
    && !/^docs\/stories\/S\d+-\d+-[^/]+\.md$/.test(normalized)
    && !/^\.deliver\/runs\/[0-9a-f-]{36}\.json$/.test(normalized)) fail('current project write is outside the transaction contract');
  return normalized;
}

function checkedPath(root, rel, { createParents = false } = {}) {
  const realRoot = rootPath(root);
  const normalized = safeRel(rel);
  const parts = normalized.split('/');
  let cursor = realRoot;
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index]);
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) fail(`current project path is a symlink: ${normalized}`);
      if (index < parts.length - 1 && !stat.isDirectory()) fail(`current project parent is not a directory: ${normalized}`);
    } catch (error) {
      if (error instanceof DeliverError) throw error;
      if (error.code !== 'ENOENT') throw error;
      if (!createParents || index === parts.length - 1) break;
      fs.mkdirSync(cursor, { mode: 0o700 });
    }
  }
  return path.join(realRoot, ...parts);
}

function read(root, rel) {
  const file = checkedPath(root, rel);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) fail(`invalid current project file: ${rel}`);
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function parseJson(text, label) {
  let value;
  try { value = JSON.parse(text); } catch { fail(`invalid JSON in ${label}`); }
  if (!record(value)) fail(`${label} must contain a JSON object`);
  return value;
}

function atomic(root, rel, content) {
  const file = checkedPath(root, rel, { createParents: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temp, file); } finally { try { fs.unlinkSync(temp); } catch {} }
}

function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, windowsHide: true,
    }).replace(/(\r?\n)+$/, '');
  } catch (error) {
    fail(`Git cannot verify current project state: ${String(error.stderr || error.message).trim()}`);
  }
}

function tracked(root, rel) {
  try {
    execFileSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', rel], {
      stdio: ['ignore', 'ignore', 'ignore'], timeout: 10000, windowsHide: true,
    });
    return true;
  } catch { return false; }
}

function ignored(root, rel) {
  try {
    execFileSync('git', ['-C', root, 'check-ignore', '--no-index', '-q', '--', rel], {
      stdio: ['ignore', 'ignore', 'ignore'], timeout: 10000, windowsHide: true,
    });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    fail(`Git cannot check ignore rules for ${rel}`);
  }
}

function cksum(text) {
  const bytes = Buffer.from(text);
  let crc = 0;
  const add = (byte) => {
    crc = (crc ^ (byte << 24)) >>> 0;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0)) >>> 0;
  };
  for (const byte of bytes) add(byte);
  for (let size = bytes.length; size > 0; size = Math.floor(size / 256)) add(size & 255);
  return (~crc >>> 0).toString(16).padStart(8, '0');
}

export function currentActorId(root) {
  let identity = '';
  for (const key of ['user.email', 'user.name']) {
    try { identity = git(root, ['config', key]); } catch {}
    if (identity) break;
  }
  identity = identity.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  const slug = identity.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) fail('Git identity is required for current project claims');
  return `${slug}-${(cksum(identity) + cksum(`${identity}:pm-skill`)).slice(0, 12)}`;
}

function withLock(root, callback) {
  const dir = internalDirectory(root, []);
  const lock = path.join(dir, 'current-pm.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') fail('current project records are locked; inspect the owner before recovery');
    throw error;
  }
  fs.writeFileSync(fd, `${process.pid}\n`);
  try { return callback(); }
  finally { fs.closeSync(fd); try { fs.unlinkSync(lock); } catch {} }
}

function validateJournal(journal) {
  if (!record(journal) || journal.format !== 'current' || !Array.isArray(journal.writes) || journal.writes.length > 2) fail('invalid current project recovery journal');
  if (new Set(journal.writes.map((item) => item.path)).size !== journal.writes.length) fail('duplicate current project journal path');
  for (const item of journal.writes) {
    safeRel(item.path);
    if (item.path === JOURNAL || !(item.before === null || typeof item.before === 'string') || typeof item.after !== 'string') fail('unsafe current project recovery journal');
    secretScan(item.after);
  }
  return journal;
}

function applyJournal(root, journal) {
  validateJournal(journal);
  for (const item of journal.writes) {
    const current = read(root, item.path);
    if (current !== item.before && current !== item.after) fail(`current project transaction conflict at ${item.path}; preserve and reconcile both versions`);
  }
  for (const item of journal.writes) {
    if (read(root, item.path) === item.after) continue;
    atomic(root, item.path, item.after);
  }
}

export function assertCurrentPmReady(root) {
  if (read(root, JOURNAL) !== null) fail('interrupted current project transaction; run pm.mjs recover before continuing');
  for (const [rel, label] of [[TRANSITION_JOURNAL, 'Execution transition'], [CORRECTION_JOURNAL, 'integration correction']]) {
    let pending;
    try { pending = fs.lstatSync(path.join(rootPath(root), rel)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (pending) {
      if (!pending.isFile() || pending.isSymbolicLink()) fail(`invalid ${label} journal`);
      fail(`interrupted ${label}; run pm.mjs recover before continuing`);
    }
  }
}

function transact(root, makeWrites) {
  return withLock(root, () => {
    assertCurrentPmReady(root);
    const pending = new Map();
    const get = (rel) => {
      const normalized = safeRel(rel);
      if (normalized === JOURNAL) fail('journal cannot be a transaction target');
      if (!pending.has(normalized)) pending.set(normalized, { path: normalized, before: read(root, normalized) });
      return pending.get(normalized).before;
    };
    const set = (rel, content) => {
      const normalized = safeRel(rel);
      get(normalized);
      secretScan(content);
      pending.get(normalized).after = content;
    };
    const result = makeWrites(get, set);
    const writes = [...pending.values()].filter((item) => item.after !== undefined && item.after !== item.before);
    if (!writes.length) return result;
    for (const item of writes) if (ignored(root, item.path)) fail(`current project record is ignored by Git: ${item.path}`);
    for (const item of pending.values()) if (read(root, item.path) !== item.before) fail(`current project records changed concurrently: ${item.path}`);
    const journal = { format: 'current', writes };
    atomic(root, JOURNAL, json(journal));
    applyJournal(root, journal);
    fs.unlinkSync(checkedPath(root, JOURNAL));
    return result;
  });
}

export function recoverCurrentPm(root) {
  return withLock(root, () => {
    const raw = read(root, JOURNAL);
    if (raw === null) return { recovered: false };
    applyJournal(root, parseJson(raw, 'current project journal'));
    fs.unlinkSync(checkedPath(root, JOURNAL));
    return { recovered: true };
  });
}

export function initializeCurrentPm(root, name = path.basename(root)) {
  safeText(name, 'project name', 200);
  return transact(root, (get, set) => {
    const existing = get(APPROVAL);
    if (existing !== null) {
      readApprovalMarker(root);
      return { format: 'current', approval_path: APPROVAL, status: parseJson(existing, APPROVAL).status };
    }
    const marker = { status: 'pending', approver: null, approved_date: null, plan_digest: null, updated: stamp() };
    set(APPROVAL, json(marker));
    return { format: 'current', approval_path: APPROVAL, status: 'pending' };
  });
}

export function approveCurrentPm(root, approver) {
  safeText(approver, 'approver', 256);
  return transact(root, (get, set) => {
    const before = get(APPROVAL);
    if (before === null) fail('current project has no approval marker; run pm.mjs init first');
    const marker = readApprovalMarker(root);
    if (!tracked(root, APPROVAL) || !tracked(root, PLAN)) fail('approval requires tracked docs/approval.json and docs/plan.md files');
    readPlanPolicy(root);
    const plan = path.join(rootPath(root), 'docs', 'plan.md');
    const stat = fs.lstatSync(plan);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) fail('approval requires a regular docs/plan.md file');
    const digest = git(root, ['hash-object', '--', PLAN]);
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(digest)) fail('Git returned an invalid plan digest');
    const now = stamp();
    set(APPROVAL, json({ ...marker, status: 'approved', approver, approved_date: now, plan_digest: digest, updated: now }));
    return { format: 'current', status: 'approved', approver, plan_digest: digest };
  });
}

export function revokeCurrentPm(root, reason) {
  if (reason !== undefined) safeText(reason, 'revocation reason', 1000);
  return transact(root, (get, set) => {
    const before = get(APPROVAL);
    if (before === null) fail('current project has no approval marker');
    if (!tracked(root, APPROVAL)) fail('revocation requires tracked docs/approval.json');
    const marker = readApprovalMarker(root);
    const now = stamp();
    set(APPROVAL, json({ ...marker, status: 'revoked', updated: now, ...(reason === undefined ? {} : { reason }) }));
    return { format: 'current', status: 'revoked', ...(reason === undefined ? {} : { reason }) };
  });
}

function requireExecutable(root, actorId) {
  assertCurrentPmReady(root);
  const state = inspectProjectState(root, { actorId });
  if (!state || state.format !== 'current') fail('current project state is unavailable');
  if (!state.approval?.implementation_ready) fail('current project approval is not executable');
  if (!state.plan?.integrationBranch) fail('approved plan needs an Integration branch');
  if (state.unreadable.length || state.diagnostics.some((item) => ['STORIES_UNREADABLE', 'STORY_UNREADABLE'].includes(item.code))) {
    fail('current story inventory is unreadable; reconcile it before claiming or continuing');
  }
  return state;
}

function resolvedBuilder(builder) {
  if (builder === 'expert-builder') fail('story explicitly routes to unavailable expert-builder; obtain an approved routing change');
  if (builder === 'auto' || builder === 'codex-builder') return 'codex-builder';
  fail('story has an unsupported builder route');
}

function targetBranch(document) {
  return `pm/${path.basename(document.path, '.md')}`;
}

function storyRefConflict(root, storyId) {
  const prefix = `pm/${storyId}-`;
  const refs = git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']).split(/\r?\n/).filter(Boolean);
  const matchingRef = refs.find((ref) => {
    if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length).startsWith(prefix);
    if (!ref.startsWith('refs/remotes/')) return false;
    const remoteBranch = ref.slice('refs/remotes/'.length).split('/').slice(1).join('/');
    return remoteBranch.startsWith(prefix);
  });
  if (matchingRef) return matchingRef;
  const worktrees = git(root, ['worktree', 'list', '--porcelain']).split(/\r?\n/);
  return worktrees.find((line) => line.startsWith('branch refs/heads/')
    && line.slice('branch refs/heads/'.length).startsWith(prefix)) || null;
}

function requireCleanIntegrationCheckout(root, integrationBranch) {
  const branch = git(root, ['symbolic-ref', '--short', 'HEAD']);
  if (branch !== integrationBranch) fail(`claim preparation requires the plan integration branch ${integrationBranch}`);
  const dirty = git(root, ['status', '--porcelain=v1', '--untracked-files=all']).split(/\r?\n/)
    .filter((line) => line && !line.slice(3).startsWith('.deliver/'));
  if (dirty.length) fail('claim preparation requires a clean integration checkout');
}

export function claimCurrentPm(root, storyPath, plannedBranch) {
  const actor = currentActorId(root);
  assertCurrentPmReady(root);
  const first = readStory(root, storyPath);
  const builder = resolvedBuilder(first.meta.builder);
  const branch = plannedBranch || first.execution?.branch || targetBranch(first);
  if (!isValidGitBranchName(branch)) fail('claim branch is not a valid Git branch name');
  if (!branch.startsWith(`pm/${first.id}-`)) fail(`claim branch must begin with pm/${first.id}-`);
  if (first.execution?.status === 'merged') fail('merged stories cannot be claimed');
  if (first.execution && first.execution.owner !== actor) fail('story is already claimed by another actor');
  if (first.execution && (first.execution.builder !== builder || first.execution.branch !== branch)) {
    fail('existing claim route or branch differs; reconcile it without resetting counters');
  }
  const project = requireExecutable(root, actor);
  if (branch === project.plan.integrationBranch) fail('story claim branch must differ from the integration branch');
  if (first.execution) {
    requireCleanIntegrationCheckout(root, project.plan.integrationBranch);
    return {
      format: 'current', actor, story: first.id, story_path: first.path, builder, branch,
      contract_hash: first.contractHash, execution_hash: first.executionHash, resumed: true,
      rounds: first.execution.rounds, retries: first.execution.retries,
    };
  }
  for (const document of project.stories) {
    const active = document.execution && document.execution.status !== 'merged';
    if (!active || document.id === first.id) continue;
    if (document.execution.owner === actor) fail(`PARALLEL_BATCH_REQUIRED: actor already owns active story ${document.id}`);
    if (document.execution.branch === branch) fail(`claim branch is already owned by story ${document.id}`);
  }
  requireCleanIntegrationCheckout(root, project.plan.integrationBranch);
  const conflict = storyRefConflict(root, first.id);
  if (conflict) fail(`unclaimed story has an existing target branch or worktree: ${conflict}`);
  return transact(root, (get, set) => {
    const before = get(first.path);
    if (before === null) fail(`story is missing: ${first.path}`);
    const document = parseStory(before, first.path);
    if (document.contractHash !== first.contractHash || document.execution !== null) fail('story changed while its claim was being prepared');
    const transition = replaceStoryExecution(document, {
      owner: actor, builder, branch, status: 'claimed', rounds: 0, retries: 0, updated: stamp(),
    });
    set(first.path, transition.after);
    return {
      format: 'current', actor, story: document.id, story_path: document.path, builder, branch,
      contract_hash: transition.contractHash, execution_hash: transition.executionHash, resumed: false,
      rounds: 0, retries: 0,
    };
  });
}

function currentBranch(root) {
  const branch = git(root, ['symbolic-ref', '--short', 'HEAD']);
  if (!isValidGitBranchName(branch)) fail('check out a named valid story branch');
  return branch;
}

function packetMatchesStory(packet, document) {
  const contract = storyTaskContract(document);
  if (packet.id !== contract.id || canonical(packet.acceptance.map((item) => item.text)) !== canonical(contract.acceptanceText)) {
    fail('task must preserve the story ID and every acceptance criterion in order');
  }
  if (!packet.touches.every((touch) => contract.touches.some((scope) => touch === scope || touch.startsWith(`${scope}/`)))) {
    fail('task touches exceed the current story scope');
  }
  if (canonical(packet.specs) !== canonical(contract.specs)) fail('task must preserve every current story spec in order');
  return contract;
}

export function prepareCurrentBinding(state, packet, storyPath) {
  if (!storyPath) fail('current projects require start --story docs/stories/<story>.md');
  const actor = currentActorId(state.project_root);
  const project = requireExecutable(state.project_root, actor);
  const document = readStory(state.project_root, storyPath);
  packetMatchesStory(packet, document);
  const execution = document.execution;
  if (!execution || execution.owner !== actor || execution.builder !== 'codex-builder'
    || !['claimed', 'building'].includes(execution.status)) fail('an active current Codex story claim is required');
  if (execution.branch !== currentBranch(state.project_root)) fail('check out the claimed story branch before starting');
  for (const other of project.stories) {
    if (other.id !== document.id && other.execution?.status !== 'merged' && other.execution?.owner === actor) {
      fail(`PARALLEL_BATCH_REQUIRED: actor already owns active story ${other.id}`);
    }
  }
  const runs = internalDirectory(state.project_root, ['runs']);
  for (const name of fs.readdirSync(runs).filter((name) => /^[0-9a-f-]{36}\.json$/.test(name))) {
    if (name === `${state.run_id}.json`) continue;
    const other = readRun(path.join(runs, name)).state;
    const binding = other.pm_binding;
    if (binding?.format === 'current' && binding.story === document.id) {
      fail('story already has a current Codex run; resume it without resetting counters');
    }
  }
  state.counters.retries = Math.max(state.counters.retries, execution.retries);
  state.counters.fixes = Math.max(state.counters.fixes, execution.rounds);
  if (state.counters.retries > 2 || state.counters.fixes > 3) fail('persisted story retry budget is already exhausted');
  return {
    format: 'current', actor, story: document.id, story_path: document.path,
    contract_hash: document.contractHash, execution_hash: document.executionHash,
    plan_digest: project.approval.plan_digest, branch: execution.branch, builder: execution.builder,
    integration_branch: project.plan.integrationBranch,
  };
}

export function assertCurrentBinding(state, { allowBlocked = false } = {}) {
  const binding = state.pm_binding;
  if (!binding || binding.format !== 'current') fail('run has no current project binding');
  const actor = currentActorId(state.project_root);
  if (actor !== binding.actor) fail('current project actor identity changed');
  const project = requireExecutable(state.project_root, actor);
  if (project.approval.plan_digest !== binding.plan_digest || project.plan.integrationBranch !== binding.integration_branch) {
    fail('current project plan approval or integration branch changed');
  }
  const document = readStory(state.project_root, binding.story_path);
  const execution = document.execution;
  if (document.id !== binding.story || document.contractHash !== binding.contract_hash || document.executionHash !== binding.execution_hash) {
    fail('current story contract or execution claim changed; reconcile before continuing');
  }
  const allowedStatuses = allowBlocked
    ? ['claimed', 'building', 'built', 'in-review', 'blocked']
    : ['claimed', 'building', 'built', 'in-review'];
  if (!execution || execution.owner !== binding.actor || execution.builder !== binding.builder
    || execution.branch !== binding.branch || !allowedStatuses.includes(execution.status)) {
    fail('current story ownership, route, branch or status changed');
  }
  if (currentBranch(state.project_root) !== binding.branch) fail('checked-out branch differs from the current story claim');
  if (state.plan.path !== path.join(rootPath(state.project_root), 'docs', 'plan.md')) fail('runtime plan is not the approved shared plan');
  if (state.task) packetMatchesStory(state.task.packet, document);
  return binding;
}

function correctionUnknown(execution) {
  if (!execution) return {};
  const value = structuredClone(execution);
  for (const key of ['owner', 'builder', 'branch', 'status', 'rounds', 'retries', 'updated']) delete value[key];
  return value;
}

function correctionRunPath(runId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runId || '')) {
    fail('correction run id is invalid');
  }
  return `.deliver/runs/${runId}.json`;
}

export function buildIntegrationCorrectionPublication({
  correctionRoot, integrationRecord, preparedRecordHash, token, builder, capturedAt,
}) {
  const root = rootPath(correctionRoot);
  safeText(builder, 'correction builder', 128);
  if (!record(token) || !/^[0-9a-f-]{36}$/.test(token.id || '') || !/^[0-9a-f]{64}$/.test(token.identity || '')
    || !path.isAbsolute(integrationRecord || '') || !/^[0-9a-f]{64}$/.test(preparedRecordHash || '')
    || typeof capturedAt !== 'string' || Number.isNaN(Date.parse(capturedAt))) fail('invalid correction publication input');
  const before = readStory(root, token.story_path);
  if (before.id !== token.story || before.contractHash !== token.story_contract_hash
    || canonical(before.execution) !== canonical(token.actual_start_execution)) {
    fail('correction story no longer matches the recorded actual start state');
  }
  const sourceExecution = token.source_execution;
  if (!record(sourceExecution) || sourceExecution.owner !== token.actor || sourceExecution.builder !== token.execution_builder) {
    fail('correction source Execution lineage is invalid');
  }
  if (before.execution && (before.execution.owner !== sourceExecution.owner || before.execution.builder !== sourceExecution.builder
    || before.execution.status === 'merged' || canonical(correctionUnknown(before.execution)) !== canonical(correctionUnknown(sourceExecution)))) {
    fail('correction start has foreign, merged or conflicting Execution metadata');
  }
  const nextExecution = {
    ...structuredClone(sourceExecution),
    owner: token.actor,
    builder: token.execution_builder,
    branch: token.branch,
    status: 'building',
    rounds: token.counter_maxima.fixes + 1,
    retries: token.counter_maxima.retries,
    updated: capturedAt.replace('T', ' ').replace('Z', '').slice(0, 16),
  };
  const transition = replaceStoryExecution(before, nextExecution);
  const anchor = captureGitAnchor(root);
  const baselineSnapshot = snapshot(root, [...token.original_packet.touches, ...token.original_packet.read_paths,
    ...token.original_packet.specs, token.story_path]);
  const dirtyPaths = baselineDirtyPaths(root);
  if (dirtyPaths.length) fail(`correction checkout must be clean: ${dirtyPaths.join(', ')}`);
  const state = createRunState(root, token.mode, 'docs/plan.md', { fixedRunId: token.run_id, createdAt: capturedAt });
  if (state.plan.hash !== token.plan_hash) fail('correction approved plan bytes changed');
  state.approval = structuredClone(token.runtime_approval);
  state.task = { packet: structuredClone(token.original_packet), builder, started_at: capturedAt };
  state.baseline = { captured_at: capturedAt, snapshot: baselineSnapshot, dirty_paths: dirtyPaths, git_anchor: anchor };
  state.git_anchor = anchor;
  state.pm_binding = {
    format: 'current', actor: token.actor, story: token.story, story_path: token.story_path,
    contract_hash: token.story_contract_hash, execution_hash: transition.executionHash,
    plan_digest: token.plan_digest, branch: token.branch, builder: token.execution_builder,
    integration_branch: token.integration_branch,
  };
  state.contracts = captureContracts(root, token.original_packet);
  state.execution_audit = {
    story_path: token.story_path,
    contract_hash: token.story_contract_hash,
    original_entry: baselineSnapshot.entries[token.story_path] ?? null,
    current_entry: `file:${fs.lstatSync(path.join(root, token.story_path)).mode & 0o100 ? '755' : '644'}:${sha256(transition.after)}`,
    transitions: [],
  };
  state.commit_adoption = { pending: null, history: [] };
  state.counters = {
    retries: token.counter_maxima.retries,
    fixes: token.counter_maxima.fixes + 1,
    corrections: token.counter_maxima.corrections,
  };
  state.correction = {
    version: 'integration-correction-v1', token_id: token.id, token_identity: token.identity,
    basis: token.basis.kind, integration_record: integrationRecord,
    root_run_id: token.root_run_id, source_run_id: token.original_source_run,
    generation: token.generation, root_review_lineage: structuredClone(token.root_review_lineage),
    required_resolutions: structuredClone(token.root_review_lineage.required_resolutions),
  };
  state.phase = 'active';
  state.revision = 1;
  state.updated_at = capturedAt;
  state.events.push({ at: capturedAt, type: 'baseline_captured', snapshot_hash: baselineSnapshot.hash, dirty_paths: dirtyPaths });
  state.events.push({ at: capturedAt, type: 'integration_correction_start', token: token.id,
    basis: token.basis.kind, generation: token.generation, from: structuredClone(before.execution) });
  validateRunState(state);
  const descriptor = {
    kind: 'integration-correction-start-v1', token_id: token.id, token_identity: token.identity,
    integration_record: integrationRecord, prepared_record_hash: preparedRecordHash,
    correction_root: root, run_id: token.run_id, branch: token.branch, builder,
    writes: [
      { path: correctionRunPath(token.run_id), before: null, after: json(state) },
      { path: token.story_path, before: before.text, after: transition.after },
    ],
  };
  return { descriptor, descriptor_identity: sha256(canonical(descriptor)), state, transition, anchor, baseline: state.baseline };
}

export function readIntegrationCorrectionJournal(root) {
  root = rootPath(root);
  const raw = read(root, CORRECTION_JOURNAL);
  if (raw === null) return null;
  return parseJson(raw, 'integration correction journal');
}

export function integrationCorrectionJournalConflicts(root) {
  root = rootPath(root);
  return [CORRECTION_JOURNAL, JOURNAL, TRANSITION_JOURNAL].filter((rel) => {
    try { return fs.lstatSync(path.join(root, rel)).isFile(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  });
}

export function validateIntegrationCorrectionJournal(root, wrapper, expectedDescriptor, token) {
  root = rootPath(root);
  if (!record(wrapper) || !record(wrapper.descriptor) || typeof wrapper.descriptor_identity !== 'string'
    || !/^[0-9a-f]{64}$/.test(wrapper.expected_starting_record_hash || '')
    || wrapper.descriptor_identity !== sha256(canonical(wrapper.descriptor))
    || canonical(wrapper.descriptor) !== canonical(expectedDescriptor)) fail('integration correction journal descriptor is invalid');
  const descriptor = wrapper.descriptor;
  if (descriptor.kind !== 'integration-correction-start-v1' || descriptor.correction_root !== root
    || !Array.isArray(descriptor.writes) || descriptor.writes.length !== 2
    || descriptor.writes[0].path !== correctionRunPath(descriptor.run_id) || descriptor.writes[0].before !== null
    || descriptor.writes[1].path !== token?.story_path) fail('integration correction journal story target is invalid');
  const runState = parseJson(descriptor.writes[0].after, 'correction run after-image');
  validateRunState(runState);
  const beforeStory = parseStory(descriptor.writes[1].before, descriptor.writes[1].path);
  const afterStory = parseStory(descriptor.writes[1].after, descriptor.writes[1].path);
  if (!record(token) || token.id !== descriptor.token_id || token.identity !== descriptor.token_identity) {
    fail('integration correction journal token is invalid');
  }
  const legalStory = replaceStoryExecution(beforeStory, {
    ...structuredClone(token.source_execution), owner: token.actor, builder: token.execution_builder,
    branch: token.branch, status: 'building', rounds: token.counter_maxima.fixes + 1,
    retries: token.counter_maxima.retries,
    updated: runState.created_at.replace('T', ' ').replace('Z', '').slice(0, 16),
  });
  const originalEntry = runState.baseline?.snapshot?.entries?.[token.story_path];
  const originalMatch = /^file:(644|755):([0-9a-f]{64})$/.exec(originalEntry || '');
  const expectedCurrentEntry = originalMatch
    ? `file:${originalMatch[1]}:${sha256(descriptor.writes[1].after)}`
    : null;
  if (runState.run_id !== descriptor.run_id || runState.project_root !== root || runState.phase !== 'active'
    || beforeStory.id !== token.story || afterStory.id !== token.story
    || beforeStory.contractHash !== token.story_contract_hash || afterStory.contractHash !== token.story_contract_hash
    || canonical(beforeStory.execution) !== canonical(token.actual_start_execution)
    || !originalMatch || originalMatch[2] !== sha256(descriptor.writes[1].before)
    || legalStory.after !== descriptor.writes[1].after
    || afterStory.contractHash !== beforeStory.contractHash || runState.pm_binding?.execution_hash !== afterStory.executionHash
    || runState.correction?.token_id !== descriptor.token_id || runState.correction?.token_identity !== descriptor.token_identity
    || runState.task?.builder !== descriptor.builder || canonical(runState.task?.packet) !== canonical(token.original_packet)
    || runState.pm_binding?.branch !== descriptor.branch || runState.pm_binding?.actor !== token.actor
    || runState.pm_binding?.story !== token.story || runState.pm_binding?.story_path !== token.story_path
    || runState.pm_binding?.contract_hash !== token.story_contract_hash || runState.pm_binding?.plan_digest !== token.plan_digest
    || runState.git_anchor?.head !== token.basis.start_commit || runState.baseline?.snapshot?.hash === undefined
    || runState.execution_audit?.story_path !== token.story_path
    || runState.execution_audit?.contract_hash !== token.story_contract_hash
    || runState.execution_audit?.original_entry !== originalEntry
    || runState.execution_audit?.current_entry !== expectedCurrentEntry
    || runState.counters.fixes !== token.counter_maxima.fixes + 1
    || runState.counters.retries !== token.counter_maxima.retries
    || runState.counters.corrections !== token.counter_maxima.corrections
    || canonical(runState.events.find((item) => item.type === 'integration_correction_start')?.from)
      !== canonical(token.actual_start_execution)) {
    fail('integration correction journal after-images are not a legal bound pair');
  }
  return { descriptor, runState, beforeStory, afterStory };
}

export function writeIntegrationCorrectionJournal(root, wrapper, expectedDescriptor, token) {
  root = rootPath(root);
  const conflicts = integrationCorrectionJournalConflicts(root);
  if (conflicts.length) fail('integration correction transaction already exists or conflicts with another journal');
  validateIntegrationCorrectionJournal(root, wrapper, expectedDescriptor, token);
  atomic(root, CORRECTION_JOURNAL, json(wrapper));
}

export function applyIntegrationCorrectionJournal(root, wrapper, expectedDescriptor, token) {
  root = rootPath(root);
  validateIntegrationCorrectionJournal(root, wrapper, expectedDescriptor, token);
  for (const item of wrapper.descriptor.writes) {
    const current = read(root, item.path);
    if (current !== item.before && current !== item.after) fail(`integration correction transaction conflict at ${item.path}`);
  }
  for (const item of wrapper.descriptor.writes) if (read(root, item.path) !== item.after) atomic(root, item.path, item.after);
  return wrapper.descriptor.writes;
}

export function removeIntegrationCorrectionJournal(root) {
  root = rootPath(root);
  const file = checkedPath(root, CORRECTION_JOURNAL);
  try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
