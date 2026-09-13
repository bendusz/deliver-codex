import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const runtime = fileURLToPath(new URL('../plugins/deliver/skills/deliver/scripts/deliver.mjs', import.meta.url));
const pmCli = fileURLToPath(new URL('../plugins/deliver/skills/deliver/scripts/pm.mjs', import.meta.url));
const storyRel = 'docs/stories/S1-1-value.md';
const criterion = 'The value records the completed implementation.';

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}

function write(root, rel, value) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function story() {
  return [
    '# S1-1: Change value',
    '<!-- pm-meta: {"builder":"codex-builder","touches":["src"]} -->',
    'Sprint: 1 · Priority: high · Covers: AC-001 · Depends on: none · Parallel-safe: yes',
    'Risk: low · Review lenses: code-integrity-reviewer · Specs: none',
    '',
    '## Goal',
    'Change the fixture value.',
    '',
    '## Acceptance criteria (testable)',
    `- [ ] ${criterion}`,
    '',
    '## Verification',
    '- Prove done with: `node --test`',
    '',
  ].join('\n');
}

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-cancellation-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Casey Example');
  git(root, 'config', 'user.email', 'casey@example.com');
  const call = (file, ...args) => {
    const result = spawnSync(process.execPath, [file, ...args], { cwd: root, encoding: 'utf8' });
    let json = null;
    try { json = JSON.parse(result.stdout); } catch {}
    return { ...result, json };
  };
  const pm = (...args) => call(pmCli, ...args);
  const run = (...args) => call(runtime, ...args);
  assert.equal(pm('init').status, 0);
  write(root, 'docs/plan.md', '# Plan\n\n## Delivery mode\n- Scale: standard\n- Checkpoint policy: story-level\n- Integration branch: main\n- Skeleton: none\n');
  write(root, storyRel, story());
  write(root, 'src/value.txt', 'before\n');
  write(root, 'outside.txt', 'outside baseline\n');
  git(root, 'add', 'docs', 'src', 'outside.txt');
  git(root, 'commit', '-qm', 'Track pending project');
  assert.equal(pm('approve', '--approver', 'Ben').status, 0);
  git(root, 'add', 'docs/approval.json');
  git(root, 'commit', '-qm', 'Approve project');
  assert.equal(pm('claim', '--story', storyRel).status, 0);
  git(root, 'add', storyRel);
  git(root, 'commit', '-qm', 'Publish claim');
  git(root, 'checkout', '-qb', 'pm/S1-1-value');
  write(root, '.deliver/task.json', {
    id: 'S1-1',
    objective: 'Change the fixture value.',
    acceptance: [{ id: 'AC-1', text: criterion }],
    read_paths: [storyRel],
    touches: ['src'],
    commands: {},
    specs: [],
  });
  const initialized = run('init', '--mode', 'quick');
  assert.equal(initialized.status, 0, initialized.stdout);
  const runId = initialized.json.run_id;
  const started = run('start', '--run', runId, '--task', '.deliver/task.json', '--builder', 'builder', '--story', storyRel);
  assert.equal(started.status, 0, started.stdout);
  return { root, run, pm, runId, runFile: path.join(root, '.deliver/runs', `${runId}.json`) };
}

function readState(f) {
  return JSON.parse(fs.readFileSync(f.runFile, 'utf8'));
}

function transition(f, to, ...extra) {
  const result = f.pm('transition', '--run', f.runId, '--to', to, ...extra);
  assert.equal(result.status, 0, result.stdout);
  return result;
}

function prepare(f) {
  const result = f.run('commit-prepare', '--run', f.runId);
  assert.equal(result.status, 0, result.stdout);
  return result.json.preparation;
}

function cancel(f, pending, revision, reason = 'Discard stale preparation after recovery') {
  return f.run('commit-cancel', '--run', f.runId, '--token', pending.token,
    '--expected-revision', String(revision), '--reason', reason);
}

function adopt(f, pending) {
  const head = git(f.root, 'rev-parse', 'HEAD');
  return f.run('commit-adopt', '--run', f.runId, '--token', pending.token, '--commit', head);
}

function recordEvidence(f) {
  const checked = f.run('check', '--run', f.runId);
  assert.equal(checked.status, 0, checked.stdout);
  write(f.root, '.deliver/review.json', { status: 'PASS', findings: [] });
  write(f.root, '.deliver/verification.json', {
    criteria: [{ id: 'AC-1', status: 'PASS', evidence: 'The committed fixture contains the intended value.' }],
  });
  assert.equal(f.run('review', '--run', f.runId, '--snapshot', checked.json.snapshot_hash,
    '--reviewer', 'reviewer', '--receipt', '.deliver/review.json').status, 0);
  assert.equal(f.run('verify', '--run', f.runId, '--snapshot', checked.json.snapshot_hash,
    '--verifier', 'verifier', '--results', '.deliver/verification.json').status, 0);
}

function restorePreviouslyLegalCorrection(f, pending) {
  const state = readState(f);
  state.commit_adoption.pending = null;
  fs.writeFileSync(f.runFile, `${JSON.stringify(state, null, 2)}\n`);
  const corrected = f.run('correct-course', '--run', f.runId, '--kind', 'fix', '--reason', 'Previously accepted correction');
  assert.equal(corrected.status, 0, corrected.stdout);
  const correctedState = readState(f);
  correctedState.commit_adoption.pending = pending;
  fs.writeFileSync(f.runFile, `${JSON.stringify(correctedState, null, 2)}\n`);
  return correctedState;
}

test('fresh-process cancellation archives a formerly legal stale preparation and permits full adoption', (t) => {
  const f = fixture(t);
  transition(f, 'building');
  write(f.root, 'src/value.txt', 'source prepared before correction\n');
  const pending = prepare(f);
  const baseline = JSON.stringify(readState(f).baseline);
  const correctedState = restorePreviouslyLegalCorrection(f, pending);
  assert.equal(correctedState.counters.fixes, 1);
  const resumed = f.run('status', '--run', f.runId);
  assert.equal(resumed.status, 0, resumed.stdout);
  assert.equal(resumed.json.commit_preparation.token, pending.token);
  assert.equal(resumed.json.commit_preparation.parent, pending.parent);
  assert.equal(resumed.json.commit_preparation.ref, pending.ref);
  assert.match(resumed.json.commit_preparation.cancellation_command,
    new RegExp(`commit-cancel --run ${f.runId} --token ${pending.token} --expected-revision ${correctedState.revision}`));

  const cancelled = cancel(f, pending, correctedState.revision);
  assert.equal(cancelled.status, 0, cancelled.stdout);
  assert.deepEqual(cancelled.json.cancellation.preparation, pending);
  assert.equal(cancelled.json.cancellation.reason, 'Discard stale preparation after recovery');
  let state = readState(f);
  assert.equal(state.commit_adoption.pending, null);
  assert.deepEqual(state.commit_adoption.history, []);
  assert.equal(state.commit_adoption.cancellations.length, 1);
  assert.equal(state.counters.fixes, 1);
  assert.equal(state.counters.retries, 0);
  assert.equal(JSON.stringify(state.baseline), baseline);
  assert.deepEqual(state.gates, []);
  assert.equal(state.review, null);
  assert.equal(state.verification, null);

  transition(f, 'built');
  transition(f, 'in-review');
  const candidate = prepare(f);
  git(f.root, 'add', '-A', '--', ...candidate.paths);
  git(f.root, 'commit', '-qm', 'Adopt reconciled candidate');
  const adopted = adopt(f, candidate);
  assert.equal(adopted.status, 0, adopted.stdout);
  state = readState(f);
  assert.equal(state.commit_adoption.cancellations.length, 1);
  assert.equal(state.commit_adoption.history.length, 1);
  assert.equal(state.commit_adoption.history[0].commit, git(f.root, 'rev-parse', 'HEAD'));
  recordEvidence(f);
  assert.equal(f.run('finish', '--run', f.runId).status, 0);
});

test('pending preparation blocks transitions and correction before writes or attempt spending', (t) => {
  const f = fixture(t);
  transition(f, 'building');
  write(f.root, 'src/value.txt', 'pending source\n');
  const pending = prepare(f);
  const beforeRun = fs.readFileSync(f.runFile, 'utf8');
  const beforeStory = fs.readFileSync(path.join(f.root, storyRel), 'utf8');
  const revision = readState(f).revision;
  const expectedCommand = `commit-cancel --run ${f.runId} --token ${pending.token} --expected-revision ${revision}`;

  const noop = f.pm('transition', '--run', f.runId, '--to', 'building');
  assert.equal(noop.status, 0, noop.stdout);
  assert.equal(noop.json.noop, true);
  assert.equal(fs.readFileSync(f.runFile, 'utf8'), beforeRun);
  assert.equal(fs.readFileSync(path.join(f.root, storyRel), 'utf8'), beforeStory);

  for (const result of [
    f.pm('transition', '--run', f.runId, '--to', 'built'),
    f.run('correct-course', '--run', f.runId, '--kind', 'fix', '--reason', 'Must cancel first'),
    f.run('correct-course', '--run', f.runId, '--kind', 'plan', '--reason', 'Must cancel first', '--plan', 'docs/plan.md'),
  ]) {
    assert.notEqual(result.status, 0);
    assert.match(result.json.error, new RegExp(expectedCommand));
    assert.equal(fs.readFileSync(f.runFile, 'utf8'), beforeRun);
    assert.equal(fs.readFileSync(path.join(f.root, storyRel), 'utf8'), beforeStory);
  }
  assert.deepEqual(readState(f).counters, { retries: 0, fixes: 0, corrections: 0 });
});

test('cancellation requires exact token, revision and bounded reason without mutation', (t) => {
  const f = fixture(t);
  transition(f, 'building');
  write(f.root, 'src/value.txt', 'pending source\n');
  const pending = prepare(f);
  const revision = readState(f).revision;
  const before = fs.readFileSync(f.runFile, 'utf8');
  for (const result of [
    cancel(f, { ...pending, token: randomUUID() }, revision),
    cancel(f, pending, revision - 1),
    f.run('commit-cancel', '--run', f.runId, '--token', pending.token, '--reason', 'Missing revision'),
    f.run('commit-cancel', '--run', f.runId, '--token', pending.token, '--expected-revision', String(revision), '--reason', '\u0001'),
  ]) {
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(f.runFile, 'utf8'), before);
  }
});

test('cancellation refuses a moved HEAD and reports both prepared and current commits', (t) => {
  const f = fixture(t);
  transition(f, 'building');
  write(f.root, 'src/value.txt', 'pending source\n');
  const pending = prepare(f);
  git(f.root, 'commit', '--allow-empty', '-qm', 'Unexpected child commit');
  const head = git(f.root, 'rev-parse', 'HEAD');
  const before = fs.readFileSync(f.runFile, 'utf8');
  const rejected = cancel(f, pending, readState(f).revision);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.json.error, new RegExp(pending.parent));
  assert.match(rejected.json.error, new RegExp(head));
  assert.equal(fs.readFileSync(f.runFile, 'utf8'), before);
});

test('cancellation refuses a moved ref, staged index, protected metadata, and cumulative scope drift', async (t) => {
  await t.test('moved ref', (t) => {
    const f = fixture(t);
    transition(f, 'building');
    write(f.root, 'src/value.txt', 'pending source\n');
    const pending = prepare(f);
    git(f.root, 'checkout', '-qb', 'other-branch');
    const before = fs.readFileSync(f.runFile, 'utf8');
    const rejected = cancel(f, pending, readState(f).revision);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.json.error, /branch|ref/);
    assert.equal(fs.readFileSync(f.runFile, 'utf8'), before);
  });

  await t.test('staged index', (t) => {
    const f = fixture(t);
    transition(f, 'building');
    write(f.root, 'src/value.txt', 'pending source\n');
    const pending = prepare(f);
    git(f.root, 'add', 'src/value.txt');
    const before = fs.readFileSync(f.runFile, 'utf8');
    const rejected = cancel(f, pending, readState(f).revision);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.json.error, /clean index/);
    assert.equal(fs.readFileSync(f.runFile, 'utf8'), before);
  });

  await t.test('protected metadata', (t) => {
    const f = fixture(t);
    transition(f, 'building');
    write(f.root, 'src/value.txt', 'pending source\n');
    const pending = prepare(f);
    fs.appendFileSync(path.join(f.root, '.git/info/exclude'), '\nchanged-after-prepare\n');
    const before = fs.readFileSync(f.runFile, 'utf8');
    const rejected = cancel(f, pending, readState(f).revision);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.json.error, /protected Git/);
    assert.equal(fs.readFileSync(f.runFile, 'utf8'), before);
  });

  await t.test('out-of-scope source', (t) => {
    const f = fixture(t);
    transition(f, 'building');
    write(f.root, 'src/value.txt', 'pending source\n');
    const pending = prepare(f);
    write(f.root, 'outside.txt', 'unauthorized change\n');
    const before = fs.readFileSync(f.runFile, 'utf8');
    const rejected = cancel(f, pending, readState(f).revision);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.json.error, /cumulative scope/);
    assert.equal(fs.readFileSync(f.runFile, 'utf8'), before);
  });
});
