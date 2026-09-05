import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '../plugins/deliver/skills/deliver/scripts/deliver.mjs');
const ownedRoots = [];
function temporary(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  ownedRoots.push(root);
  return root;
}
after(() => { for (const root of ownedRoots) fs.rmSync(root, { recursive: true, force: true }); });

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

function fixture({ commands = {}, mode = 'quick' } = {}) {
  const root = temporary('deliver-runtime-');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Runtime Test']);
  git(root, ['config', 'user.email', 'runtime@example.invalid']);
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'plan.md'), '# Plan\n');
  fs.writeFileSync(path.join(root, 'src', 'value.txt'), 'before\n');
  const task = {
    id: 'T-1',
    objective: 'Change the value',
    acceptance: [{ id: 'AC-1', text: 'The value is changed' }],
    read_paths: ['src'],
    touches: ['src'],
    commands,
    specs: [],
  };
  fs.writeFileSync(path.join(root, 'task.json'), JSON.stringify(task));
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'initial']);
  const initialized = run(root, ['init', '--mode', mode, '--plan', 'docs/plan.md']);
  assert.equal(initialized.status, 0, initialized.stderr);
  return { root, runId: initialized.json.run_id };
}

function run(root, argv) {
  const result = spawnSync(process.execPath, [cli, ...argv], { cwd: root, encoding: 'utf8' });
  let json;
  try { json = JSON.parse(result.stdout.trim()); } catch { json = null; }
  return { status: result.status, json, stdout: result.stdout, stderr: result.stderr };
}

function writeJson(root, name, value) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function start(project, builder = 'builder') {
  return run(project.root, ['start', '--run', project.runId, '--task', 'task.json', '--builder', builder]);
}

function currentSnapshot(project) {
  const checked = run(project.root, ['check', '--run', project.runId]);
  assert.equal(checked.status, 0, checked.stdout);
  return checked.json.snapshot_hash;
}

test('init creates unique durable run identities and enforces revisions', () => {
  const project = fixture();
  const second = run(project.root, ['init', '--mode', 'quick', '--plan', 'docs/plan.md']);
  assert.equal(second.status, 0);
  assert.notEqual(second.json.run_id, project.runId);
  const approval = run(project.root, ['approve', '--run', project.runId, '--approver', 'owner', '--expected-revision', '9']);
  assert.equal(approval.status, 66);
  assert.match(approval.json.error, /revision conflict/);
});

test('quick mode can initialize without a plan', () => {
  const project = fixture();
  const initialized = run(project.root, ['init', '--mode', 'quick']);
  assert.equal(initialized.status, 0, initialized.stdout);
  assert.equal(initialized.json.plan.path, null);
  assert.equal(run(project.root, ['start', '--run', initialized.json.run_id, '--task', 'task.json', '--builder', 'builder']).status, 0);
});

test('init refuses a symlinked runtime directory', () => {
  const root = temporary('deliver-symlink-root-');
  const outside = temporary('deliver-symlink-target-');
  git(root, ['init', '-q']);
  fs.symlinkSync(outside, path.join(root, '.deliver'));
  const initialized = run(root, ['init', '--mode', 'quick']);
  assert.equal(initialized.status, 66);
  assert.match(initialized.json.error, /real directory/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('managed approval binds to plan content and plan edits invalidate it', () => {
  const project = fixture({ mode: 'managed' });
  assert.equal(start(project).status, 66);
  assert.equal(run(project.root, ['approve', '--run', project.runId, '--approver', 'owner']).status, 0);
  fs.appendFileSync(path.join(project.root, 'docs', 'plan.md'), 'changed\n');
  const status = run(project.root, ['status', '--run', project.runId]);
  assert.equal(status.json.approval_current, false);
  assert.equal(start(project).status, 66);
  assert.equal(run(project.root, ['approve', '--run', project.runId, '--approver', 'owner']).status, 0);
  assert.equal(start(project).status, 0);
});

test('scope is cumulative and catches deletes, renames, out-of-scope writes, and git metadata', () => {
  const project = fixture();
  assert.equal(start(project).status, 0);
  fs.renameSync(path.join(project.root, 'src', 'value.txt'), path.join(project.root, 'src', 'renamed.txt'));
  let checked = run(project.root, ['check', '--run', project.runId]);
  assert.equal(checked.status, 0);
  assert.deepEqual(checked.json.renames, [{ from: 'src/value.txt', to: 'src/renamed.txt' }]);
  fs.writeFileSync(path.join(project.root, 'outside.txt'), 'bad\n');
  checked = run(project.root, ['check', '--run', project.runId]);
  assert.equal(checked.status, 74);
  assert.deepEqual(checked.json.out_of_scope, ['outside.txt']);
  fs.unlinkSync(path.join(project.root, 'outside.txt'));
  git(project.root, ['config', 'deliver.runtime-test', 'changed']);
  checked = run(project.root, ['check', '--run', project.runId]);
  assert.equal(checked.status, 74);
  assert.equal(checked.json.git_metadata_changed, true);
});

test('a dirty baseline path stays protected even when touches includes its parent', () => {
  const project = fixture();
  fs.writeFileSync(path.join(project.root, 'src', 'user-work.txt'), 'user edit\n');
  assert.equal(start(project).status, 0);
  fs.writeFileSync(path.join(project.root, 'src', 'user-work.txt'), 'worker overwrite\n');
  const checked = run(project.root, ['check', '--run', project.runId]);
  assert.equal(checked.status, 74);
  assert.deepEqual(checked.json.preexisting_dirty_changed, ['src/user-work.txt']);
});

test('touches cannot escape through a symlink', () => {
  const project = fixture();
  const outside = temporary('deliver-outside-');
  fs.symlinkSync(outside, path.join(project.root, 'src', 'escape'));
  const task = JSON.parse(fs.readFileSync(path.join(project.root, 'task.json')));
  task.touches = ['src/escape'];
  writeJson(project.root, 'escape-task.json', task);
  const result = run(project.root, ['start', '--run', project.runId, '--task', 'escape-task.json', '--builder', 'builder']);
  assert.equal(result.status, 66);
  assert.match(result.json.error, /symlink/);
});

test('gate executes the exact requested command and becomes stale after mutation', () => {
  const project = fixture({ commands: { test: 'node -e "process.exit(0)"' } });
  assert.equal(start(project).status, 0);
  fs.writeFileSync(path.join(project.root, 'src', 'value.txt'), 'after\n');
  const gated = run(project.root, ['gate', '--run', project.runId, '--name', 'test', '--command', 'node -e "process.exit(0)"']);
  assert.equal(gated.status, 0, gated.stdout);
  assert.equal(gated.json.gate.provenance, 'deliver-runtime-executed-v1');
  assert.equal(gated.json.gate.status, 'PASS');
  assert.ok(fs.existsSync(path.join(project.root, gated.json.gate.log_path)));
  fs.writeFileSync(path.join(project.root, 'src', 'later.txt'), 'mutation\n');
  const receipt = writeJson(project.root, '.deliver/input/review.json', { status: 'PASS', findings: [] });
  const results = writeJson(project.root, '.deliver/input/verify.json', { criteria: [{ id: 'AC-1', status: 'PASS', evidence: 'inspected the changed file' }] });
  const snapshotHash = currentSnapshot(project);
  assert.equal(run(project.root, ['review', '--run', project.runId, '--snapshot', snapshotHash, '--reviewer', 'reviewer', '--receipt', receipt]).status, 0);
  assert.equal(run(project.root, ['verify', '--run', project.runId, '--snapshot', snapshotHash, '--verifier', 'verifier', '--results', results]).status, 0);
  const finished = run(project.root, ['finish', '--run', project.runId]);
  assert.equal(finished.status, 66);
  assert.match(finished.json.error, /required gate.*stale/);
});

test('governed finish needs distinct actors, current gates, review, and all PASS verification', () => {
  const command = 'node -e "process.exit(0)"';
  const project = fixture({ mode: 'governed', commands: { test: command } });
  assert.equal(run(project.root, ['approve', '--run', project.runId, '--approver', 'owner']).status, 0);
  assert.equal(start(project, 'builder').status, 0);
  fs.writeFileSync(path.join(project.root, 'src', 'value.txt'), 'after\n');
  assert.equal(run(project.root, ['gate', '--run', project.runId, '--name', 'test', '--command', command]).status, 0);
  const review = writeJson(project.root, '.deliver/input/review.json', { status: 'PASS', findings: [{ severity: 'minor', message: 'fixed', resolved: true }], summary: 'ready' });
  const verification = writeJson(project.root, '.deliver/input/verification.json', { criteria: [{ id: 'AC-1', status: 'PASS', evidence: 'value.txt contains after' }] });
  const snapshotHash = currentSnapshot(project);
  assert.equal(run(project.root, ['review', '--run', project.runId, '--snapshot', snapshotHash, '--reviewer', 'reviewer', '--receipt', review]).status, 0);
  const sameVerifier = run(project.root, ['verify', '--run', project.runId, '--snapshot', snapshotHash, '--verifier', 'reviewer', '--results', verification]);
  assert.equal(sameVerifier.status, 66);
  assert.equal(run(project.root, ['verify', '--run', project.runId, '--snapshot', snapshotHash, '--verifier', 'verifier', '--results', verification]).status, 0);
  const finished = run(project.root, ['finish', '--run', project.runId]);
  assert.equal(finished.status, 0, finished.stdout);
  assert.equal(finished.json.phase, 'finished');
});

test('finish rejects previously passing evidence after an ignored symlink input changes', () => {
  const command = 'node -e "require(\'assert\').equal(require(\'fs\').readFileSync(\'input.txt\',\'utf8\'),\'before\')"';
  const project = fixture({ commands: { input: command } });
  fs.writeFileSync(path.join(project.root, '.gitignore'), 'cache/\n');
  fs.mkdirSync(path.join(project.root, 'cache'));
  fs.writeFileSync(path.join(project.root, 'cache/input.txt'), 'before');
  fs.symlinkSync('cache/input.txt', path.join(project.root, 'input.txt'));
  const packet = JSON.parse(fs.readFileSync(path.join(project.root, 'task.json')));
  packet.read_paths.push('input.txt');
  writeJson(project.root, 'task.json', packet);
  assert.equal(start(project).status, 0);
  fs.writeFileSync(path.join(project.root, 'src/value.txt'), 'after');
  const gate = run(project.root, ['gate', '--run', project.runId, '--name', 'input', '--command', command]);
  assert.equal(gate.status, 0, gate.stdout);
  const hash = currentSnapshot(project);
  const review = writeJson(project.root, '.deliver/review.json', { status: 'PASS', findings: [] });
  const verify = writeJson(project.root, '.deliver/verify.json', { criteria: [{ id: 'AC-1', status: 'PASS', evidence: 'Fixture source and input checks passed' }] });
  assert.equal(run(project.root, ['review', '--run', project.runId, '--snapshot', hash, '--reviewer', 'reviewer', '--receipt', review]).status, 0);
  assert.equal(run(project.root, ['verify', '--run', project.runId, '--snapshot', hash, '--verifier', 'reviewer', '--results', verify]).status, 0);
  fs.writeFileSync(path.join(project.root, 'cache/input.txt'), 'after');
  const check = run(project.root, ['check', '--run', project.runId]);
  assert.notEqual(check.json.snapshot_hash, hash);
  assert.notEqual(run(project.root, ['finish', '--run', project.runId]).status, 0);
  assert.notEqual(spawnSync(command, { cwd: project.root, shell: true, stdio: 'pipe' }).status, 0);
});

test('unchanged work cannot finish and unresolved findings cannot claim PASS', () => {
  const project = fixture();
  assert.equal(start(project).status, 0);
  const badReview = writeJson(project.root, '.deliver/input/bad-review.json', { status: 'PASS', findings: [{ severity: 'major', message: 'still open' }] });
  const snapshotHash = currentSnapshot(project);
  const rejected = run(project.root, ['review', '--run', project.runId, '--snapshot', snapshotHash, '--reviewer', 'reviewer', '--receipt', badReview]);
  assert.equal(rejected.status, 66);
  assert.match(rejected.json.error, /unresolved/);
  const review = writeJson(project.root, '.deliver/input/review.json', { status: 'PASS', findings: [] });
  const verification = writeJson(project.root, '.deliver/input/verification.json', { criteria: [{ id: 'AC-1', status: 'PASS', evidence: 'checked' }] });
  assert.equal(run(project.root, ['review', '--run', project.runId, '--snapshot', snapshotHash, '--reviewer', 'reviewer', '--receipt', review]).status, 0);
  assert.equal(run(project.root, ['verify', '--run', project.runId, '--snapshot', snapshotHash, '--verifier', 'reviewer', '--results', verification]).status, 0);
  const finished = run(project.root, ['finish', '--run', project.runId]);
  assert.equal(finished.status, 66);
  assert.match(finished.json.error, /without a worktree change/);
});

test('retry and fix counters persist across correct-course operations', () => {
  const project = fixture();
  assert.equal(start(project).status, 0);
  assert.equal(run(project.root, ['correct-course', '--run', project.runId, '--kind', 'retry', '--reason', 'transient failure']).status, 0);
  const fixed = run(project.root, ['correct-course', '--run', project.runId, '--kind', 'fix', '--reason', 'review finding']);
  assert.equal(fixed.status, 0);
  assert.deepEqual(fixed.json.counters, { retries: 1, fixes: 1, corrections: 0 });
  assert.equal(run(project.root, ['correct-course', '--run', project.runId, '--kind', 'retry', '--reason', 'second attempt']).status, 0);
  const exhausted = run(project.root, ['correct-course', '--run', project.runId, '--kind', 'retry', '--reason', 'third attempt']);
  assert.equal(exhausted.status, 66);
  assert.match(exhausted.json.error, /limit of 2/);
});

test('gate logging remains usable after a fix round invalidates old receipts', () => {
  const command = 'node -e "process.exit(0)"';
  const project = fixture({ commands: { test: command } });
  assert.equal(start(project).status, 0);
  const first = run(project.root, ['gate', '--run', project.runId, '--name', 'test', '--command', command]);
  assert.equal(first.status, 0, first.stdout);
  assert.equal(run(project.root, ['correct-course', '--run', project.runId, '--kind', 'fix', '--reason', 'test another edge']).status, 0);
  const next = run(project.root, ['gate', '--run', project.runId, '--name', 'test', '--command', command]);
  assert.equal(next.status, 0, next.stdout);
  assert.notEqual(next.json.gate.log_path, first.json.gate.log_path);
});

test('a gate cannot certify a tree it mutated, or run in an undeclared cwd', () => {
  const project = fixture();
  assert.equal(start(project).status, 0);
  const wrongCwd = run(project.root, ['gate', '--run', project.runId, '--name', 'test', '--command', 'node -e "process.exit(0)"', '--cwd', 'src']);
  assert.equal(wrongCwd.status, 66);
  const command = 'node -e "require(\'fs\').writeFileSync(\'src/value.txt\',\'changed\')"';
  const mutated = run(project.root, ['gate', '--run', project.runId, '--name', 'test', '--command', command]);
  assert.equal(mutated.status, 1, mutated.stdout);
  assert.match(mutated.json.gate.error, /changed authoritative files/);
});

test('nested symlink aliases do not grant write authority', () => {
  const project = fixture();
  const outside = temporary('deliver-chain-outside-');
  fs.mkdirSync(path.join(project.root, 'other'));
  fs.symlinkSync(outside, path.join(project.root, 'other/escape'));
  fs.symlinkSync('../other', path.join(project.root, 'src/link'));
  const denied = start(project);
  assert.equal(denied.status, 66, denied.stdout);
  assert.match(denied.json.error, /symlink/);
});

test('ignored inputs in the task read scope participate in the snapshot', () => {
  const project = fixture();
  fs.writeFileSync(path.join(project.root, '.gitignore'), 'src/cache.json\n');
  fs.writeFileSync(path.join(project.root, 'src/cache.json'), '{"value":1}');
  git(project.root, ['add', '.gitignore']); git(project.root, ['commit', '-qm', 'Ignore test fixture']);
  assert.equal(start(project).status, 0);
  const before = currentSnapshot(project);
  fs.writeFileSync(path.join(project.root, 'src/cache.json'), '{"value":2}');
  const after = currentSnapshot(project);
  assert.notEqual(before, after);
});

test('corrupted empty verification criteria cannot be accepted from stored state', () => {
  const project = fixture();
  assert.equal(start(project).status, 0);
  fs.writeFileSync(path.join(project.root, 'src/value.txt'), 'changed');
  const hash = currentSnapshot(project);
  const receipt = writeJson(project.root, '.deliver/verification.json', { criteria: [{ id: 'AC-1', status: 'PASS', evidence: 'test fixture evidence' }] });
  assert.equal(run(project.root, ['verify', '--run', project.runId, '--snapshot', hash, '--verifier', 'verifier', '--results', receipt]).status, 0);
  const file = path.join(project.root, '.deliver/runs', `${project.runId}.json`);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.verification.criteria = [];
  fs.writeFileSync(file, JSON.stringify(state));
  const corrupt = run(project.root, ['status', '--run', project.runId]);
  assert.equal(corrupt.status, 66);
  assert.match(corrupt.json.error, /criteria do not match/);
});
