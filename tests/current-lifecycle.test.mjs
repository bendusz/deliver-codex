import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readStory } from '../plugins/deliver/skills/deliver/scripts/lib/story.mjs';
import { registerCorrectionProtectionTests } from './integration-correction.test.mjs';

const pmCli = fileURLToPath(new URL('../plugins/deliver/skills/deliver/scripts/pm.mjs', import.meta.url));
const runtime = fileURLToPath(new URL('../plugins/deliver/skills/deliver/scripts/deliver.mjs', import.meta.url));
const storyPath = 'docs/stories/S1-1-value.md';
const criterion = 'The value is changed by the bounded implementation.';

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}

function write(root, rel, value) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function story(builder = 'auto') {
  return [
    '# S1-1: Change value',
    `<!-- pm-meta: {"builder":"${builder}","touches":["src"]} -->`,
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

function project(t, { builder = 'auto' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-current-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Casey Example');
  git(root, 'config', 'user.email', 'casey@example.com');
  const call = (file, ...args) => {
    const result = spawnSync(process.execPath, [file, ...args], { cwd: root, encoding: 'utf8' });
    return { ...result, json: result.stdout ? JSON.parse(result.stdout) : null };
  };
  const pm = (...args) => call(pmCli, ...args);
  const run = (...args) => call(runtime, ...args);
  assert.equal(pm('init').status, 0);
  write(root, 'docs/plan.md', '# Plan\n\n## Delivery mode\n- Scale: standard\n- Checkpoint policy: story-level\n- Integration branch: main\n- Skeleton: none\n');
  write(root, storyPath, story(builder));
  write(root, 'src/value.txt', 'before\n');
  return { root, pm, run };
}

function approve(f) {
  f.gitDigest = git(f.root, 'hash-object', '--', 'docs/plan.md');
  git(f.root, 'add', 'docs', 'src');
  git(f.root, 'commit', '-qm', 'Track pending plan and story');
  const result = f.pm('approve', '--approver', 'Ben');
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.json.plan_digest, f.gitDigest);
  git(f.root, 'add', 'docs/approval.json');
  git(f.root, 'commit', '-qm', 'Approve shared plan');
}

function packet(root) {
  return write(root, '.deliver/task.json', {
    id: 'S1-1',
    objective: 'Change the fixture value.',
    acceptance: [{ id: 'AC-1', text: criterion }],
    read_paths: [storyPath],
    touches: ['src'],
    commands: {},
    specs: [],
  });
}

test('current lifecycle binds exact approval, claim, route, branch and spent counters', (t) => {
  const f = project(t);
  assert.equal(fs.existsSync(path.join(f.root, 'pm/pm-state.json')), false);
  const downgrade = f.pm('init', '--format', 'legacy');
  assert.notEqual(downgrade.status, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'pm/pm-state.json')), false);
  const pending = JSON.parse(fs.readFileSync(path.join(f.root, 'docs/approval.json'), 'utf8'));
  assert.equal(pending.status, 'pending');
  const beforeUntrackedApproval = fs.readFileSync(path.join(f.root, 'docs/approval.json'), 'utf8');
  const early = f.pm('approve', '--approver', 'Ben');
  assert.notEqual(early.status, 0);
  assert.equal(fs.readFileSync(path.join(f.root, 'docs/approval.json'), 'utf8'), beforeUntrackedApproval);

  approve(f);
  const claim = f.pm('claim', '--story', storyPath);
  assert.equal(claim.status, 0, claim.stdout);
  assert.equal(claim.json.branch, 'pm/S1-1-value');
  let claimedText = fs.readFileSync(path.join(f.root, storyPath), 'utf8');
  claimedText = claimedText.replace('"rounds":0,"retries":0', '"rounds":2,"retries":1');
  fs.writeFileSync(path.join(f.root, storyPath), claimedText);
  git(f.root, 'add', storyPath);
  git(f.root, 'commit', '-qm', 'Publish current story claim');

  const sourceBeforeResume = fs.readFileSync(path.join(f.root, 'src/value.txt'), 'utf8');
  fs.appendFileSync(path.join(f.root, 'src/value.txt'), 'dirty\n');
  const dirtyResume = f.pm('claim', '--story', storyPath);
  assert.notEqual(dirtyResume.status, 0);
  assert.match(dirtyResume.json.error, /clean integration checkout/);
  fs.writeFileSync(path.join(f.root, 'src/value.txt'), sourceBeforeResume);
  const resumed = f.pm('claim', '--story', storyPath);
  assert.equal(resumed.status, 0, resumed.stdout);
  assert.equal(resumed.json.resumed, true);
  assert.equal(resumed.json.rounds, 2);
  assert.equal(resumed.json.retries, 1);
  git(f.root, 'checkout', '-qb', 'pm/S1-1-value');
  const wrongCheckout = f.pm('claim', '--story', storyPath);
  assert.notEqual(wrongCheckout.status, 0);
  assert.match(wrongCheckout.json.error, /integration branch main/);
  packet(f.root);

  const initialized = f.run('init', '--mode', 'quick');
  assert.equal(initialized.status, 0, initialized.stdout);
  assert.equal(initialized.json.plan.path, path.join(f.root, 'docs/plan.md'));
  assert.equal(initialized.json.approval_current, true);
  const runId = initialized.json.run_id;
  const started = f.run('start', '--run', runId, '--task', '.deliver/task.json', '--builder', 'builder', '--story', storyPath);
  assert.equal(started.status, 0, started.stdout);
  assert.deepEqual(started.json.counters, { retries: 1, fixes: 2, corrections: 0 });
  const runState = JSON.parse(fs.readFileSync(path.join(f.root, '.deliver/runs', `${runId}.json`), 'utf8'));
  assert.equal(runState.pm_binding.format, 'current');
  assert.equal(runState.pm_binding.plan_digest, f.gitDigest);
  assert.equal(runState.pm_binding.contract_hash, readStory(f.root, storyPath).contractHash);
  assert.equal(runState.pm_binding.execution_hash, readStory(f.root, storyPath).executionHash);
  assert.equal(runState.pm_binding.actor, readStory(f.root, storyPath).execution.owner);
  assert.equal(runState.pm_binding.builder, 'codex-builder');
  assert.equal(runState.pm_binding.branch, 'pm/S1-1-value');
  assert.equal(runState.pm_binding.integration_branch, 'main');
  assert.equal(f.run('check', '--run', runId).status, 0);

  const runFile = path.join(f.root, '.deliver/runs', `${runId}.json`);
  const boundStateText = fs.readFileSync(runFile, 'utf8');
  fs.writeFileSync(runFile, `${JSON.stringify({ ...runState, pm_binding: null }, null, 2)}\n`);
  write(f.root, '.deliver/unbound-review.json', { status: 'PASS', findings: [] });
  write(f.root, '.deliver/unbound-verification.json', { criteria: [{ id: 'AC-1', status: 'PASS', evidence: 'Fixture evidence.' }] });
  const unboundSnapshot = '0'.repeat(64);
  for (const [command, args] of [
    ['check', []],
    ['gate', ['--name', 'must-not-run', '--command', 'node -e "process.exit(99)"']],
    ['review', ['--snapshot', unboundSnapshot, '--reviewer', 'reviewer', '--receipt', '.deliver/unbound-review.json']],
    ['verify', ['--snapshot', unboundSnapshot, '--verifier', 'verifier', '--results', '.deliver/unbound-verification.json']],
    ['finish', []],
  ]) {
    const denied = f.run(command, '--run', runId, ...args);
    assert.notEqual(denied.status, 0, command);
    assert.match(denied.json.error, /missing its shared story binding/, command);
  }
  assert.equal(JSON.parse(fs.readFileSync(runFile, 'utf8')).revision, runState.revision);
  fs.writeFileSync(runFile, boundStateText);

  const second = f.run('init', '--mode', 'quick');
  assert.equal(second.status, 0, second.stdout);
  const duplicate = f.run('start', '--run', second.json.run_id, '--task', '.deliver/task.json', '--builder', 'second', '--story', storyPath);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.json.error, /already has a current Codex run/);
  assert.equal(readStory(f.root, storyPath).execution.rounds, 2);
  assert.equal(readStory(f.root, storyPath).execution.retries, 1);

  const planBefore = fs.readFileSync(path.join(f.root, 'docs/plan.md'), 'utf8');
  fs.appendFileSync(path.join(f.root, 'docs/plan.md'), '\nchanged\n');
  assert.notEqual(f.run('check', '--run', runId).status, 0);
  fs.writeFileSync(path.join(f.root, 'docs/plan.md'), planBefore);

  const storyBefore = fs.readFileSync(path.join(f.root, storyPath), 'utf8');
  fs.writeFileSync(path.join(f.root, storyPath), storyBefore.replace('"builder":"codex-builder"', '"builder":"expert-builder"'));
  assert.notEqual(f.run('check', '--run', runId).status, 0);
  fs.writeFileSync(path.join(f.root, storyPath), storyBefore);

  git(f.root, 'checkout', 'main');
  assert.notEqual(f.run('check', '--run', runId).status, 0);
  git(f.root, 'checkout', 'pm/S1-1-value');

  const revoked = f.pm('revoke', '--reason', 'The shared plan needs revision.');
  assert.equal(revoked.status, 0, revoked.stdout);
  const marker = JSON.parse(fs.readFileSync(path.join(f.root, 'docs/approval.json'), 'utf8'));
  assert.equal(marker.status, 'revoked');
  assert.equal(marker.reason, 'The shared plan needs revision.');
  assert.equal(marker.plan_digest, f.gitDigest);
  assert.notEqual(f.run('check', '--run', runId).status, 0);
  const gate = f.run('gate', '--run', runId, '--name', 'must-not-run', '--command', 'node -e "process.exit(99)"');
  assert.notEqual(gate.status, 0);
  assert.match(gate.json.error, /approv/);
  write(f.root, '.deliver/review.json', { status: 'PASS', findings: [] });
  write(f.root, '.deliver/verification.json', { criteria: [{ id: 'AC-1', status: 'PASS', evidence: 'Fixture evidence.' }] });
  const staleSnapshot = '0'.repeat(64);
  for (const [command, args] of [
    ['review', ['--snapshot', staleSnapshot, '--reviewer', 'reviewer', '--receipt', '.deliver/review.json']],
    ['verify', ['--snapshot', staleSnapshot, '--verifier', 'verifier', '--results', '.deliver/verification.json']],
    ['finish', []],
  ]) {
    const denied = f.run(command, '--run', runId, ...args);
    assert.notEqual(denied.status, 0, command);
    assert.match(denied.json.error, /approv/, command);
  }
});

test('current claim refuses foreign work, explicit unavailable routes and hidden story refs without mutation', (t) => {
  const hidden = project(t);
  approve(hidden);
  git(hidden.root, 'branch', 'pm/S1-10-unrelated');
  const allowed = hidden.pm('claim', '--story', storyPath);
  assert.equal(allowed.status, 0, allowed.stdout, 'S1-10 must not collide with the S1-1 boundary');

  const conflict = project(t);
  approve(conflict);
  git(conflict.root, 'branch', 'pm/S1-1-hidden');
  const beforeConflict = fs.readFileSync(path.join(conflict.root, storyPath), 'utf8');
  const blocked = conflict.pm('claim', '--story', storyPath);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.json.error, /existing target branch or worktree/);
  assert.equal(fs.readFileSync(path.join(conflict.root, storyPath), 'utf8'), beforeConflict);
  git(conflict.root, 'branch', '-D', 'pm/S1-1-hidden');
  git(conflict.root, 'update-ref', 'refs/remotes/origin/pm/S1-1-remote', 'HEAD');
  const remoteBlocked = conflict.pm('claim', '--story', storyPath);
  assert.notEqual(remoteBlocked.status, 0);
  assert.match(remoteBlocked.json.error, /refs\/remotes\/origin\/pm\/S1-1-remote/);
  assert.equal(fs.readFileSync(path.join(conflict.root, storyPath), 'utf8'), beforeConflict);

  const expert = project(t, { builder: 'expert-builder' });
  approve(expert);
  const beforeExpert = fs.readFileSync(path.join(expert.root, storyPath), 'utf8');
  const unavailable = expert.pm('claim', '--story', storyPath);
  assert.notEqual(unavailable.status, 0);
  assert.match(unavailable.json.error, /unavailable expert-builder/);
  assert.equal(fs.readFileSync(path.join(expert.root, storyPath), 'utf8'), beforeExpert);

  const foreign = project(t);
  approve(foreign);
  const foreignText = `${fs.readFileSync(path.join(foreign.root, storyPath), 'utf8')}\n## Execution\n<!-- pm-exec: {"owner":"other-actor","builder":"codex-builder","branch":"pm/S1-1-value","status":"claimed","rounds":2,"retries":1,"updated":"2026-09-10 12:00"} -->\n`;
  fs.writeFileSync(path.join(foreign.root, storyPath), foreignText);
  const beforeForeign = fs.readFileSync(path.join(foreign.root, storyPath), 'utf8');
  const denied = foreign.pm('claim', '--story', storyPath);
  assert.notEqual(denied.status, 0);
  assert.match(denied.json.error, /another actor/);
  assert.equal(fs.readFileSync(path.join(foreign.root, storyPath), 'utf8'), beforeForeign);
});

test('current binding preserves every story spec and reserves same-actor parallel claims', (t) => {
  const specs = project(t);
  fs.writeFileSync(path.join(specs.root, storyPath), story().replace('Specs: none', 'Specs: specs/value.sdd'));
  write(specs.root, 'specs/value.sdd', 'Spec: Value\nOwns:\n  ../src/value.txt\n');
  approve(specs);
  git(specs.root, 'add', 'specs/value.sdd');
  git(specs.root, 'commit', '-qm', 'Track story contract');
  assert.equal(specs.pm('claim', '--story', storyPath).status, 0);
  git(specs.root, 'add', storyPath);
  git(specs.root, 'commit', '-qm', 'Publish spec-bound claim');
  git(specs.root, 'checkout', '-qb', 'pm/S1-1-value');
  packet(specs.root);
  const initialized = specs.run('init', '--mode', 'quick');
  const omitted = specs.run('start', '--run', initialized.json.run_id, '--task', '.deliver/task.json', '--builder', 'builder', '--story', storyPath);
  assert.notEqual(omitted.status, 0);
  assert.match(omitted.json.error, /preserve every current story spec/);

  const parallel = project(t);
  approve(parallel);
  const actor = parallel.pm('actor-id').json.actor;
  const second = `${story().replaceAll('S1-1', 'S1-2')}\n## Execution\n<!-- pm-exec: ${JSON.stringify({
    owner: actor, builder: 'codex-builder', branch: 'pm/S1-2-other', status: 'building', rounds: 1, retries: 0, updated: '2026-09-10 12:00',
  })} -->\n`;
  write(parallel.root, 'docs/stories/S1-2-other.md', second);
  const blocked = parallel.pm('claim', '--story', storyPath);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.json.error, /^PARALLEL_BATCH_REQUIRED:/);
  assert.equal(readStory(parallel.root, storyPath).execution, null);
});

test('current recovery applies exact before images and refuses concurrent edits', (t) => {
  const f = project(t);
  const approvalPath = path.join(f.root, 'docs/approval.json');
  const before = fs.readFileSync(approvalPath, 'utf8');
  const marker = JSON.parse(before);
  const after = `${JSON.stringify({ ...marker, status: 'revoked', reason: 'Recovered fixture.' }, null, 2)}\n`;
  write(f.root, '.deliver/current-pm-transaction.json', {
    format: 'current', writes: [{ path: 'docs/approval.json', before, after }],
  });
  assert.notEqual(f.pm('status').status, 0);
  fs.writeFileSync(approvalPath, `${before.trimEnd()} \n`);
  const conflict = f.pm('recover');
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.json.error, /transaction conflict/);
  assert.equal(fs.readFileSync(approvalPath, 'utf8'), `${before.trimEnd()} \n`);
  fs.writeFileSync(approvalPath, before);
  const recovered = f.pm('recover');
  assert.equal(recovered.status, 0, recovered.stdout);
  assert.equal(recovered.json.recovered, true);
  assert.equal(fs.readFileSync(approvalPath, 'utf8'), after);
  assert.equal(fs.existsSync(path.join(f.root, '.deliver/current-pm-transaction.json')), false);
});

registerCorrectionProtectionTests();
