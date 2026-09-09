import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  inspectState,
  parseExec,
  pmActorId,
} from './fixtures/upstream-v0.25.1/hooks/lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtureRoot = path.join(root, 'tests/fixtures/upstream-v0.25.1');
const reader = path.join(fixtureRoot, 'hooks/lib.mjs');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const oldFixtureHashes = {
  'NOTICE.md': 'f43d5a7ad780077f17700936b7f7bc348567edac78d4c3be0e8de790ececace5',
  'hooks/lib.mjs': '1f9a8ff3a3f4eb300851fcbac7569509050f738a4dd56d22be2e6459f8242339',
  'hooks/session-context.mjs': '820c41410e07ef11f65ad3888971d8c862a7946a9133a2a49479c1b4b1d47c6d',
  'templates/actor-state.json.template': 'ae6ae65ca6d3edb00228726b78884e920416dc854f5d0a77a723e8f30ea46d64',
  'templates/pm-state.json.template': '9bdf7ee6b341cf31b94c73ed9cbdade42293db737d6e600d17de791a086d8aa3',
};

function write(repo, rel, text) {
  const file = path.join(repo, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function repository(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-upstream-contract-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'Casey Example');
  git(repo, 'config', 'user.email', 'casey@example.com');
  return repo;
}

test('0.25.1 reader and artifact templates match the pinned upstream bytes', () => {
  const provenance = json(path.join(fixtureRoot, 'provenance.json'));
  assert.equal(provenance.version, '0.25.1');
  assert.equal(provenance.commit, '3aa3f3a0a6baed15e9a8a99ef15405b79efd37aa');
  assert.deepEqual(provenance.reader_dependencies.sort(), [
    'node:child_process',
    'node:fs',
    'node:path',
    'node:url',
  ]);
  assert.equal(provenance.files.length, 23);

  const copied = [];
  for (const entry of provenance.files) {
    assert.match(entry.source, /^plugins\/deliver\/(?:hooks\/lib\.mjs|templates\/[^/]+)$/);
    assert.match(entry.fixture, /^(?:hooks\/lib\.mjs|templates\/[^/]+)$/);
    const file = path.join(fixtureRoot, ...entry.fixture.split('/'));
    assert.equal(sha256(file), entry.sha256, `${entry.fixture} changed from its pinned source`);
    copied.push(entry.fixture);
  }

  const actual = ['hooks', 'templates'].flatMap((dir) =>
    fs.readdirSync(path.join(fixtureRoot, dir)).map((name) => `${dir}/${name}`));
  assert.deepEqual(copied.sort(), actual.sort());
});

test('the unchanged upstream reader derives current project state in a disposable Git repository', (t) => {
  const repo = repository(t);
  const plan = '# Reader fixture plan\n\n## Delivery mode\n- Scale: standard\n- Checkpoint policy: story-level\n- Integration branch: main\n- Skeleton: none\n';
  write(repo, 'docs/plan.md', plan);
  const digest = git(repo, 'hash-object', 'docs/plan.md').trim();
  write(repo, 'docs/approval.json', `${JSON.stringify({
    status: 'approved',
    approver: 'Ben',
    approved_date: '2026-09-09',
    plan_digest: digest,
    updated: '2026-09-09 12:00',
  }, null, 2)}\n`);
  write(repo, 'docs/stories/S1-1-reader.md', [
    '# S1-1: Exercise the pinned reader',
    '<!-- pm-meta: {"builder":"codex-builder","touches":["src/"]} -->',
    '',
    '## Acceptance criteria (testable)',
    '- [ ] AC-001: Reader reports the active claim.',
    '',
    '## Execution',
    '<!-- pm-exec: {"owner":"casey-example-com-589b8fa8ab93","builder":"codex-builder","branch":"pm/S1-1-reader","status":"building","rounds":1,"retries":0,"updated":"2026-09-09 12:00"} -->',
    '',
  ].join('\n'));
  write(repo, 'docs/stories/S1-2-other.md', [
    '# S1-2: Another claim',
    '',
    '## Execution',
    '<!-- pm-exec: {"owner":"other-actor","builder":"codex-builder","branch":"pm/S1-2-other","status":"claimed","rounds":0,"retries":0,"updated":"2026-09-09 12:01"} -->',
    '',
  ].join('\n'));
  git(repo, 'add', 'docs');
  git(repo, 'commit', '-qm', 'Create reader fixture');
  git(repo, 'checkout', '-qb', 'pm/S1-1-reader');

  assert.equal(pmActorId(repo), 'casey-example-com-589b8fa8ab93');
  const state = inspectState(repo);
  assert.equal(state.phase, 'implementation');
  assert.equal(state.next_reference, 'references/implementation-loop.md');
  assert.equal(state.approval.plan_changed, false);
  assert.equal(state.story.id, 'S1-1');
  assert.deepEqual(state.story.exec, {
    owner: 'casey-example-com-589b8fa8ab93',
    builder: 'codex-builder',
    branch: 'pm/S1-1-reader',
    status: 'building',
    rounds: 1,
    retries: 0,
    updated: '2026-09-09 12:00',
  });
  assert.deepEqual(state.unmerged, ['S1-1', 'S1-2']);
  assert.deepEqual(state.claims, [{
    id: 'S1-2',
    owner: 'other-actor',
    status: 'claimed',
    branch: 'pm/S1-2-other',
  }]);
  assert.equal(state.uncommitted, 0);

  const cli = spawnSync(process.execPath, [reader, 'state', repo], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: path.dirname(repo) },
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), state);
  assert.equal(parseExec('<!-- pm-exec: {"status":"merged","rounds":2} -->').status, 'merged');
});

test('the original 0.22.0 fixtures remain byte-for-byte unchanged', () => {
  const oldRoot = path.join(root, 'tests/fixtures/upstream-v0.22.0');
  for (const [rel, expected] of Object.entries(oldFixtureHashes)) {
    assert.equal(sha256(path.join(oldRoot, ...rel.split('/'))), expected, `${rel} changed`);
  }
});

test('the parity contract maps every approved task and capability to checks', () => {
  const contract = json(path.join(root, 'docs/parity-contract.json'));
  const expectedTasks = Array.from({ length: 15 }, (_, i) => `T${String(i).padStart(2, '0')}`);
  assert.deepEqual(contract.tasks.map((task) => task.id), expectedTasks);

  const taskIds = new Set(expectedTasks);
  const capabilityIds = new Set(contract.capabilities.map((capability) => capability.id));
  assert.equal(capabilityIds.size, contract.capabilities.length);
  const tasksUsed = new Set();

  for (const capability of contract.capabilities) {
    assert.ok(capability.tasks.length > 0, `${capability.id} has no task`);
    assert.ok(capability.checks.length > 0, `${capability.id} has no check`);
    for (const task of capability.tasks) {
      assert.ok(taskIds.has(task), `${capability.id} names unknown ${task}`);
      tasksUsed.add(task);
    }
  }
  assert.deepEqual([...tasksUsed].sort(), expectedTasks);

  for (const task of contract.tasks) {
    assert.ok(task.capabilities.length > 0, `${task.id} has no capability`);
    assert.ok(task.expected_evidence.length > 0, `${task.id} has no expected evidence`);
    for (const capability of task.capabilities) {
      assert.ok(capabilityIds.has(capability), `${task.id} names unknown ${capability}`);
      assert.ok(contract.capabilities.find((item) => item.id === capability).tasks.includes(task.id));
    }
  }

  for (const difference of contract.deliberate_differences) {
    assert.ok(difference.tasks.length > 0, `${difference.id} has no owning task`);
    assert.ok(difference.tasks.every((task) => taskIds.has(task)), `${difference.id} names an unknown task`);
  }
  assert.deepEqual(contract.shared_contract.approval.statuses, ['pending', 'approved', 'revoked']);
  assert.deepEqual(contract.shared_contract.story.execution_statuses, ['claimed', 'building', 'built', 'in-review', 'blocked', 'merged']);
  assert.equal(contract.shared_contract.identity.salt, ':pm-skill');
});
