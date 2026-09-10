import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  archiveEvidence,
  canonical,
  DeliverError,
  internalDirectory,
  readRun,
  sha256,
  updateRun,
  validateRunState,
} from './state.mjs';
import { assertPmBinding } from './pm.mjs';
import { parseStory, readStory, replaceStoryExecution } from './story.mjs';
import { captureGitAnchor, inspectScope, legacyAnchorUpgradeSafe, snapshot } from './scope.mjs';

const JOURNAL = '.deliver/transition-transaction.json';
const ACTIVE_STATUSES = new Set(['claimed', 'building', 'built', 'in-review', 'blocked']);
const COMMITTABLE_STATUSES = new Set(['claimed', 'building', 'built', 'in-review']);
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const fail = (message, code = 66) => { throw new DeliverError(message, code); };
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const now = () => new Date().toISOString();
const stamp = () => now().replace('T', ' ').replace('Z', '').slice(0, 16);
const covers = (scope, rel) => rel === scope || rel.startsWith(`${scope}/`);

function git(root, args, { env = {} } = {}) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
      windowsHide: true, env: { ...process.env, ...env },
    }).replace(/(\r?\n)+$/, '');
  } catch (error) {
    fail(`Git cannot complete coordinator transition: ${String(error.stderr || error.message).trim()}`);
  }
}

function gitSucceeds(root, args) {
  try {
    execFileSync('git', ['-C', root, ...args], { stdio: 'ignore', timeout: 10000, windowsHide: true });
    return true;
  } catch { return false; }
}

function rootPath(root) {
  const real = fs.realpathSync(root);
  const stat = fs.lstatSync(real);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('project root must be a real directory');
  return real;
}

function safeRel(rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || /[\x00-\x1f\x7f]/.test(rel)) fail('unsafe transition path');
  const parts = rel.split(/[\\/]/);
  if (parts.some((part) => !part || part === '.' || part === '..')) fail('unsafe transition path');
  const normalized = parts.join('/');
  if (normalized === JOURNAL || /^docs\/stories\/S\d+-\d+-[^/]+\.md$/.test(normalized)
    || /^\.deliver\/runs\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/.test(normalized)) return normalized;
  fail('transition path is outside the journal contract');
}

function checkedPath(root, rel) {
  const realRoot = rootPath(root);
  const normalized = safeRel(rel);
  let cursor = realRoot;
  for (const part of normalized.split('/')) {
    cursor = path.join(cursor, part);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) fail(`transition path is a symlink: ${normalized}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return path.join(realRoot, ...normalized.split('/'));
}

function readText(root, rel) {
  const file = checkedPath(root, rel);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) fail(`invalid transition file: ${rel}`);
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function atomic(root, rel, content) {
  const file = checkedPath(root, rel);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let mode = 0o600;
  try { mode = fs.lstatSync(file).mode & 0o777; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const fd = fs.openSync(temp, 'wx', mode);
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    fs.renameSync(temp, file);
    let directory;
    try {
      directory = fs.openSync(path.dirname(file), 'r');
      fs.fsyncSync(directory);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
    } finally { if (directory !== undefined) fs.closeSync(directory); }
  }
  finally { try { fs.unlinkSync(temp); } catch {} }
}

function removeJournal(root) {
  const file = checkedPath(root, JOURNAL);
  fs.unlinkSync(file);
  let directory;
  try {
    directory = fs.openSync(path.dirname(file), 'r');
    fs.fsyncSync(directory);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  } finally { if (directory !== undefined) fs.closeSync(directory); }
}

function transitionLocks(root, runFile, callback) {
  const dir = internalDirectory(root, []);
  const locks = [path.join(dir, 'transition.lock'), `${runFile}.lock`];
  const fds = [];
  try {
    for (const lock of locks) {
      try { fds.push([fs.openSync(lock, 'wx', 0o600), lock]); }
      catch (error) {
        if (error.code === 'EEXIST') fail(`transition is locked by another process: ${lock}`);
        throw error;
      }
    }
    for (const [fd] of fds) fs.writeFileSync(fd, `${process.pid} ${now()}\n`);
    return callback();
  } finally {
    for (const [fd, lock] of fds.reverse()) {
      try { fs.closeSync(fd); } finally { try { fs.unlinkSync(lock); } catch {} }
    }
  }
}

function validateJournalShape(journal) {
  if (!journal || typeof journal !== 'object' || Array.isArray(journal) || journal.kind !== 'execution-transition-v1'
    || canonical(Object.keys(journal).sort()) !== canonical(['branch', 'contract_hash', 'kind', 'owner', 'writes'])
    || typeof journal.contract_hash !== 'string' || typeof journal.owner !== 'string' || typeof journal.branch !== 'string'
    || !Array.isArray(journal.writes) || journal.writes.length !== 2) fail('invalid Execution transition journal');
  const paths = journal.writes.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || canonical(Object.keys(item).sort()) !== canonical(['after', 'before', 'path'])) fail('invalid Execution transition write');
    const normalized = safeRel(item.path);
    if (normalized !== item.path) fail('transition journal paths must use canonical separators');
    return normalized;
  });
  if (new Set(paths).size !== paths.length || !paths.some((item) => item.startsWith('docs/stories/'))
    || !paths.some((item) => item.startsWith('.deliver/runs/'))) fail('invalid Execution transition journal paths');
  for (const item of journal.writes) {
    if (typeof item.before !== 'string' || typeof item.after !== 'string') fail('invalid Execution transition before/after image');
  }
  return journal;
}

function applyJournal(root, journal) {
  validateTransitionJournal(root, journal);
  for (const item of journal.writes) {
    const current = readText(root, item.path);
    if (current !== item.before && current !== item.after) {
      fail(`Execution transition conflict at ${item.path}; preserve changed contracts and reconcile maximum spent counters`);
    }
  }
  for (const item of journal.writes) {
    if (readText(root, item.path) !== item.after) atomic(root, item.path, item.after);
  }
}

export function recoverExecutionTransition(root) {
  root = rootPath(root);
  const raw = readText(root, JOURNAL);
  if (raw === null) return { recovered: false };
  let journal;
  try { journal = JSON.parse(raw); } catch { fail('invalid JSON in Execution transition journal'); }
  const runRel = validateJournalShape(journal).writes.find((item) => item.path.startsWith('.deliver/runs/')).path;
  return transitionLocks(root, checkedPath(root, runRel), () => {
    applyJournal(root, journal);
    removeJournal(root);
    return { recovered: true, run: runRel };
  });
}

function transitionRule(from, to, attempt, reason) {
  if (!ACTIVE_STATUSES.has(from)) fail(`Execution status ${from} cannot transition before integration reconciliation`);
  if (!ACTIVE_STATUSES.has(to)) fail('T05 integration is the only operation allowed to record merged');
  if (from === to && attempt === undefined) return { noop: true };
  if (to === 'blocked') {
    if (attempt !== undefined) fail('blocked transition cannot spend a fix or retry attempt');
    if (!reason) fail('blocked transition requires --reason');
    return { noop: false };
  }
  if (attempt !== undefined) {
    if (to !== 'building' || !['fix', 'retry'].includes(attempt)) fail('fix/retry transitions must return Execution to building');
    return { noop: false };
  }
  const forward = from === 'claimed' && to === 'building'
    || from === 'building' && to === 'built'
    || from === 'built' && to === 'in-review';
  if (!forward) fail(`illegal Execution transition ${from} -> ${to}`);
  return { noop: false };
}

function storyMode(state, document) {
  const expectedEntry = state.execution_audit?.current_entry
    ?? state.baseline?.snapshot?.entries?.[document.path];
  const match = /^file:(644|755):[0-9a-f]{64}$/.exec(expectedEntry || '');
  if (!match) fail('run baseline cannot prove the story file mode');
  const actualEntry = `file:${match[1]}:${sha256(document.text)}`;
  if (actualEntry !== expectedEntry) fail('run audit does not match the before-story image');
  return match[1];
}

function buildExecutionTransition(state, document, {
  to, attempt, reason, transitionAt, evidenceAt, updatedAt,
}) {
  const binding = state.pm_binding;
  const execution = document.execution;
  if (state.phase !== 'active' || binding?.format !== 'current' || !execution
    || binding.story !== document.id || binding.story_path !== document.path
    || binding.contract_hash !== document.contractHash || binding.execution_hash !== document.executionHash
    || binding.actor !== execution.owner || binding.builder !== execution.builder || binding.branch !== execution.branch) {
    fail('before story and run binding do not describe the same active Execution');
  }
  if (typeof transitionAt !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(transitionAt)
    || typeof updatedAt !== 'string' || Number.isNaN(Date.parse(updatedAt))) fail('invalid recorded transition timestamps');
  if (reason !== undefined && (typeof reason !== 'string' || !reason.trim() || reason.length > 1000
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(reason))) fail('invalid recorded transition reason');
  const rule = transitionRule(execution.status, to, attempt, reason);
  const maxRetries = Math.max(execution.retries, state.counters.retries);
  const maxFixes = Math.max(execution.rounds, state.counters.fixes);
  if (rule.noop && maxRetries === execution.retries && maxFixes === execution.rounds) {
    return { noop: true, state, execution, document };
  }
  let retries = maxRetries;
  let rounds = maxFixes;
  if (attempt === 'retry') {
    if (retries >= 2) fail('retry limit of 2 has been reached');
    retries += 1;
  }
  if (attempt === 'fix') {
    if (rounds >= 3) fail('fix limit of 3 has been reached');
    rounds += 1;
  }
  const mode = storyMode(state, document);
  const transition = replaceStoryExecution(document, {
    status: to, retries, rounds, updated: transitionAt,
  }, { note: reason ? `${transitionAt} ${attempt || to}: ${reason}` : undefined });
  const next = structuredClone(state);
  next.pm_binding.execution_hash = transition.executionHash;
  next.counters.retries = retries;
  next.counters.fixes = rounds;
  const hasEvidence = next.gates.length > 0 || next.review !== null || next.verification !== null;
  if (hasEvidence && (typeof evidenceAt !== 'string' || Number.isNaN(Date.parse(evidenceAt)))) {
    fail('invalid recorded evidence archive timestamp');
  }
  archiveEvidence(next, 'execution_transition', {
    story: document.id,
    from: execution.status,
    to,
    attempt: attempt ?? null,
    transition_reason: reason ?? null,
  }, evidenceAt || updatedAt);
  const beforeEntry = `file:${mode}:${sha256(transition.before)}`;
  const afterEntry = `file:${mode}:${sha256(transition.after)}`;
  const receipt = {
    from: execution.status,
    to,
    attempt: attempt ?? null,
    reason: reason ?? null,
    before_hash: document.executionHash,
    after_hash: transition.executionHash,
    at: transitionAt,
  };
  if (next.execution_audit) {
    if (next.execution_audit.story_path !== document.path || next.execution_audit.contract_hash !== document.contractHash
      || next.execution_audit.current_entry !== beforeEntry) fail('existing Execution audit does not match the current story');
    next.execution_audit.current_entry = afterEntry;
    next.execution_audit.transitions.push(receipt);
  } else {
    next.execution_audit = {
      story_path: document.path,
      contract_hash: document.contractHash,
      original_entry: next.baseline.snapshot.entries[document.path] ?? null,
      current_entry: afterEntry,
      transitions: [receipt],
    };
  }
  next.events.push({ at: transitionAt, type: 'execution_transition', story: document.id, ...receipt });
  next.revision += 1;
  next.updated_at = updatedAt;
  validateRunState(next);
  return { noop: false, state: next, execution: transition.document.execution, document: transition.document, transition, receipt };
}

function parseRunImage(text, label) {
  let state;
  try { state = JSON.parse(text); } catch { fail(`invalid JSON in ${label}`); }
  return validateRunState(state);
}

function validateTransitionJournal(root, journal) {
  validateJournalShape(journal);
  const storyWrite = journal.writes.find((item) => item.path.startsWith('docs/stories/'));
  const runWrite = journal.writes.find((item) => item.path.startsWith('.deliver/runs/'));
  let beforeDocument;
  let afterDocument;
  try {
    beforeDocument = parseStory(storyWrite.before, storyWrite.path);
    afterDocument = parseStory(storyWrite.after, storyWrite.path);
  } catch (error) { fail(`invalid story image in Execution transition journal: ${error.message}`); }
  const beforeState = parseRunImage(runWrite.before, 'before-run transition image');
  const afterState = parseRunImage(runWrite.after, 'after-run transition image');
  if (beforeState.project_root !== root || afterState.project_root !== root
    || runWrite.path !== `.deliver/runs/${beforeState.run_id}.json`
    || beforeState.run_id !== afterState.run_id) fail('transition journal run identity or root changed');
  const beforeExecution = beforeDocument.execution;
  if (!beforeExecution || journal.contract_hash !== beforeDocument.contractHash
    || afterDocument.contractHash !== beforeDocument.contractHash
    || journal.owner !== beforeExecution.owner || journal.branch !== beforeExecution.branch) {
    fail('transition journal contract, owner or branch does not match its before-story image');
  }
  const receipt = afterState.execution_audit?.transitions?.at(-1);
  if (!receipt) fail('transition journal after-run image has no transition receipt');
  const hadEvidence = beforeState.gates.length > 0 || beforeState.review !== null || beforeState.verification !== null;
  const evidenceAt = hadEvidence
    ? afterState.evidence_history?.[beforeState.evidence_history?.length || 0]?.at
    : afterState.updated_at;
  const generated = buildExecutionTransition(beforeState, beforeDocument, {
    to: receipt.to,
    attempt: receipt.attempt ?? undefined,
    reason: receipt.reason ?? undefined,
    transitionAt: receipt.at,
    evidenceAt,
    updatedAt: afterState.updated_at,
  });
  if (generated.noop || generated.transition.after !== storyWrite.after || json(generated.state) !== runWrite.after) {
    fail('transition journal after images are not the exact legal result of its before images');
  }
  return { storyWrite, runWrite, beforeState, afterState, beforeDocument, afterDocument };
}

export function transitionCurrentExecution(runArg, { to, attempt, reason, expectedRevision } = {}, cwd = process.cwd()) {
  if (typeof to !== 'string') fail('--to is required', 64);
  if (attempt !== undefined && !['fix', 'retry'].includes(attempt)) fail('--attempt must be fix or retry', 64);
  if (reason !== undefined && (typeof reason !== 'string' || !reason.trim() || reason.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(reason))) {
    fail('--reason must be printable and at most 1000 characters', 64);
  }
  const initial = readRun(runArg, cwd);
  const root = initial.state.project_root;
  const runRel = `.deliver/runs/${initial.state.run_id}.json`;
  return transitionLocks(root, initial.file, () => {
    if (readText(root, JOURNAL) !== null) fail('interrupted Execution transition; run pm.mjs recover before continuing');
    const loaded = readRun(initial.file, root);
    const state = loaded.state;
    if (expectedRevision !== undefined && state.revision !== expectedRevision) fail(`revision conflict: expected ${expectedRevision}, found ${state.revision}`);
    if (state.phase !== 'active' || state.pm_binding?.format !== 'current') fail('Execution transitions require an active current-bound run');
    assertPmBinding(state, { allowBlocked: true });
    const document = readStory(root, state.pm_binding.story_path);
    const execution = document.execution;
    const built = buildExecutionTransition(state, document, {
      to,
      attempt,
      reason,
      transitionAt: stamp(),
      evidenceAt: now(),
      updatedAt: now(),
    });
    if (built.noop) return { state, file: loaded.file, execution, noop: true };
    const { state: next, transition } = built;
    const runBefore = readText(root, runRel);
    const runAfter = json(next);
    const journal = {
      kind: 'execution-transition-v1',
      contract_hash: document.contractHash,
      owner: execution.owner,
      branch: execution.branch,
      writes: [
        { path: document.path, before: transition.before, after: transition.after },
        { path: runRel, before: runBefore, after: runAfter },
      ],
    };
    atomic(root, JOURNAL, json(journal));
    applyJournal(root, journal);
    removeJournal(root);
    return { state: next, file: loaded.file, execution: transition.document.execution, noop: false };
  });
}

function statusPaths(root) {
  const records = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0').filter(Boolean);
  const paths = [];
  for (let index = 0; index < records.length; index++) {
    const item = records[index];
    if (item.length < 4) continue;
    const status = item.slice(0, 2);
    paths.push(item.slice(3));
    if ((status[0] === 'R' || status[0] === 'C') && records[index + 1]) paths.push(records[++index]);
  }
  return [...new Set(paths.filter((item) => !item.startsWith('.deliver/')))].sort();
}

function indexFlags(root, env = {}) {
  return git(root, ['ls-files', '-v', '-z'], { env });
}

function indexFlagRecords(root) {
  const records = new Map();
  for (const record of indexFlags(root).split('\0').filter(Boolean)) {
    if (record.length < 3 || record[1] !== ' ') fail('cannot parse Git index flags');
    records.set(record.slice(2), record[0]);
  }
  return records;
}

function gitlinkPaths(root) {
  return git(root, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean).flatMap((record) => {
    const match = /^160000 [0-9a-f]+ [0-3]\t(.+)$/.exec(record);
    return match ? [match[1]] : [];
  });
}

function anchorProtectionHash(anchor) {
  return sha256(canonical({
    protected_hash: anchor.protected_hash,
    submodules: anchor.submodules || {},
  }));
}

function expectedIndex(root, parent, paths) {
  const dir = internalDirectory(root, ['tmp']);
  const index = path.join(dir, `commit-index-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    const records = indexFlagRecords(root);
    for (const rel of paths) {
      const tag = records.get(rel);
      if (tag !== undefined && tag !== 'H') {
        fail(`commit preparation rejects unsupported index flag ${tag} on intended path: ${rel}`, 74);
      }
    }
    git(root, ['read-tree', parent], { env });
    for (const [rel, tag] of records) {
      const upper = tag.toUpperCase();
      if (upper === 'S') git(root, ['update-index', '--skip-worktree', '--', rel], { env });
      if (tag !== upper) git(root, ['update-index', '--assume-unchanged', '--', rel], { env });
    }
    git(root, ['add', '-A', '--', ...paths], { env });
    return {
      tree: git(root, ['write-tree'], { env }),
      index_flags: sha256(indexFlags(root, env)),
    };
  } finally { try { fs.unlinkSync(index); } catch {} }
}

function treeFingerprint(root, tree, rel) {
  const record = git(root, ['ls-tree', '-z', tree, '--', rel]).split('\0').filter(Boolean)
    .find((item) => item.endsWith(`\t${rel}`));
  if (!record) return null;
  const match = /^(100644|100755|120000) blob ([0-9a-f]+)\t/.exec(record);
  if (!match) fail(`prepared tree contains unsupported entry for audited path: ${rel}`, 74);
  let content;
  try {
    content = execFileSync('git', ['-C', root, 'cat-file', 'blob', match[2]], {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, windowsHide: true,
    });
  } catch (error) {
    fail(`Git cannot read prepared tree entry ${rel}: ${String(error.stderr || error.message).trim()}`);
  }
  if (match[1] === '120000') return `symlink:${sha256(content)}`;
  return `file:${match[1] === '100755' ? '755' : '644'}:${sha256(content)}`;
}

function assertTreeCoverage(root, tree, paths, entries) {
  for (const rel of paths) {
    if (treeFingerprint(root, tree, rel) !== (entries[rel] ?? null)) {
      fail(`prepared tree does not contain the audited worktree entry: ${rel}`, 74);
    }
  }
}

export function prepareCommitAdoption(runArg, expectedRevision, cwd = process.cwd()) {
  const loaded = readRun(runArg, cwd);
  return updateRun(loaded.file, expectedRevision, (state) => {
    if (state.phase !== 'active' || state.pm_binding?.format !== 'current') fail('commit preparation requires an active current-bound run');
    if (state.commit_adoption?.pending) fail('a commit adoption is already pending');
    assertPmBinding(state);
    if (!COMMITTABLE_STATUSES.has(readStory(state.project_root, state.pm_binding.story_path).execution.status)) {
      fail('current Execution status cannot be committed by T04');
    }
    if (!gitSucceeds(state.project_root, ['diff', '--cached', '--quiet', '--'])) fail('commit preparation requires a clean index');
    const checked = inspectScope(state);
    if (!checked.report.ok) fail('commit preparation requires a passing cumulative scope check', 74);
    const anchor = captureGitAnchor(state.project_root);
    if (!state.git_anchor) {
      if (checked.report.git_metadata_compatibility !== 'legacy-v1') fail('current run has no compatible audited Git anchor');
      if (!legacyAnchorUpgradeSafe(state.project_root)) {
        fail('legacy Git metadata cannot prove the mode or target of an active hook; remove it or start a fresh run', 74);
      }
      state.git_anchor = anchor;
      state.baseline_metadata_version = 'legacy-v1';
      state.events.push({ at: now(), type: 'git_anchor_bootstrapped', head: anchor.head, ref: anchor.ref });
    } else if (canonical(anchor) !== canonical(state.git_anchor)) {
      if (!['flat-v1', 'protected-v1'].includes(checked.report.git_anchor_compatibility)) {
        fail('current Git state differs from the audited anchor');
      }
      state.git_anchor = anchor;
      state.events.push({ at: now(), type: 'git_anchor_upgraded', head: anchor.head, ref: anchor.ref });
    }
    const dirty = statusPaths(state.project_root);
    const storyPath = state.pm_binding.story_path;
    const changed = new Set(checked.report.changed);
    const ignoredChanged = git(state.project_root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])
      .split('\0').filter((rel) => changed.has(rel)
        && state.task.packet.touches.some((scope) => covers(scope, rel)));
    if (ignoredChanged.length) {
      fail(`commit preparation cannot leave audited source outside the commit: ${ignoredChanged.sort().join(', ')}`, 74);
    }
    const nestedChanges = [...changed].filter((rel) => gitlinkPaths(state.project_root)
      .some((module) => rel.startsWith(`${module}/`)));
    if (nestedChanges.length) {
      fail(`commit preparation cannot represent initialized submodule worktree changes: ${nestedChanges.sort().join(', ')}`, 74);
    }
    const intended = [...new Set([
      ...[...changed].filter((rel) => state.task.packet.touches.some((scope) => covers(scope, rel))),
      ...(state.execution_audit?.story_path === storyPath ? [storyPath] : []),
    ])].sort();
    for (const rel of dirty) {
      if (intended.includes(rel)) continue;
      if (state.baseline.dirty_paths.some((original) => covers(original, rel) || covers(rel, original))) continue;
      fail(`commit preparation found an unaudited dirty path: ${rel}`, 74);
    }
    if (!intended.length) fail('commit preparation found no audited changes to commit');
    const expected = expectedIndex(state.project_root, anchor.head, intended);
    assertTreeCoverage(state.project_root, expected.tree, intended, checked.current.entries);
    const pending = {
      token: randomUUID(),
      parent: anchor.head,
      ref: anchor.ref,
      expected_tree: expected.tree,
      expected_index_flags: expected.index_flags,
      content_hash: sha256(canonical(checked.current.entries)),
      protected_hash: anchorProtectionHash(anchor),
      paths: intended,
      prepared_at: now(),
    };
    state.commit_adoption = { pending, history: [...(state.commit_adoption?.history || [])] };
    state.events.push({ at: now(), type: 'commit_prepared', token: pending.token, parent: pending.parent, paths: pending.paths });
    return pending;
  });
}

export function adoptPreparedCommit(runArg, { token, commit, expectedRevision } = {}, cwd = process.cwd()) {
  if (typeof token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token)) {
    fail('--token must be the commit preparation token', 64);
  }
  if (typeof commit !== 'string' || !OID.test(commit)) fail('--commit must be a full Git object ID', 64);
  const loaded = readRun(runArg, cwd);
  return updateRun(loaded.file, expectedRevision, (state) => {
    const pending = state.commit_adoption?.pending;
    if (!pending || pending.token !== token) fail('commit preparation token is missing or stale');
    assertPmBinding(state);
    const root = state.project_root;
    const head = git(root, ['rev-parse', '--verify', 'HEAD']);
    if (head !== commit) fail('supplied commit is not the current HEAD');
    const lineage = git(root, ['rev-list', '--parents', '-n', '1', head]).split(/\s+/);
    if (lineage.length !== 2 || lineage[1] !== pending.parent) fail('adopted commit must be one single-parent child of the prepared HEAD');
    const anchor = captureGitAnchor(root);
    if (anchor.ref !== pending.ref) fail('adopted commit is on a different branch');
    if (anchor.tree !== pending.expected_tree || anchor.index_tree !== pending.expected_tree
      || !gitSucceeds(root, ['diff', '--cached', '--quiet', '--'])) fail('adopted commit tree or index differs from the prepared tree');
    if (anchor.index_flags !== pending.expected_index_flags) fail('Git index flags changed after commit preparation');
    if (anchorProtectionHash(anchor) !== pending.protected_hash) fail('protected Git config, hooks, index flags or submodule metadata changed during commit');
    const checked = inspectScope(state, { allowPendingAdoption: true, ignoreGitAnchor: true });
    if (!checked.report.ok || sha256(canonical(checked.current.entries)) !== pending.content_hash) {
      fail('worktree content differs from the prepared audited snapshot', 74);
    }
    const executionStatus = readStory(root, state.pm_binding.story_path).execution.status;
    if (!COMMITTABLE_STATUSES.has(executionStatus)) fail('current Execution status cannot be adopted by T04');
    const receipt = {
      token,
      parent: pending.parent,
      commit: head,
      tree: anchor.tree,
      ref: anchor.ref,
      paths: [...pending.paths],
      execution_status: executionStatus,
      execution_hash: state.pm_binding.execution_hash,
      adopted_at: now(),
    };
    state.git_anchor = anchor;
    state.commit_adoption.pending = null;
    state.commit_adoption.history.push(receipt);
    archiveEvidence(state, 'commit_adopted', { commit: head, parent: pending.parent, paths: [...pending.paths] });
    state.events.push({ at: now(), type: 'commit_adopted', commit: head, parent: pending.parent, paths: pending.paths });
    return receipt;
  });
}

export function assertFinalCandidate(state) {
  if (state.pm_binding?.format !== 'current') return;
  assertPmBinding(state);
  if (state.commit_adoption?.pending) fail('commit adoption is pending; commit or reconcile it before finishing');
  const execution = readStory(state.project_root, state.pm_binding.story_path).execution;
  const latest = state.commit_adoption?.history?.at(-1);
  if (execution.status !== 'in-review' || !state.git_anchor || !latest
    || latest.commit !== state.git_anchor.head || latest.execution_status !== 'in-review'
    || latest.execution_hash !== state.pm_binding.execution_hash) {
    fail('current finish requires an adopted in-review candidate commit');
  }
}
