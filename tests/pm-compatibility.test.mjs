import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { pmActorId as originalActorId } from './fixtures/upstream-v0.22.0/hooks/lib.mjs';
import { pmActorId, readStory } from '../plugins/deliver/skills/deliver/scripts/lib/pm.mjs';

const runtime = fileURLToPath(new URL('../plugins/deliver/skills/deliver/scripts/deliver.mjs', import.meta.url));
const bridge = fileURLToPath(new URL('../plugins/deliver/skills/deliver/scripts/pm.mjs', import.meta.url));
const originalHook = fileURLToPath(new URL('./fixtures/upstream-v0.22.0/hooks/session-context.mjs', import.meta.url));
const template = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/upstream-v0.22.0/templates/${name}.json.template`, import.meta.url)));
const storyPath = 'docs/stories/S1-1-value.md';
const criterion = 'The value is after.';
const command = 'node -e "require(\'assert\').equal(require(\'fs\').readFileSync(\'src/value.txt\',\'utf8\'),\'after\')"';

function fixture(t, { upstream = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-pm-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trimEnd();
  const write = (rel, value) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  };
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
  const call = (file, ...args) => {
    const result = spawnSync(process.execPath, [file, ...args], { cwd: root, encoding: 'utf8' });
    return { ...result, json: JSON.parse(result.stdout) };
  };
  const pm = (...args) => call(bridge, ...args);
  const run = (...args) => call(runtime, ...args);
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Interop Test'); git('config', 'user.email', 'Interop@Test.Example');
  const id = originalActorId(root), actorPath = `pm/actors/${id}.json`;
  write('src/value.txt', 'before');
  write('docs/plan.md', '# Approved plan\nChange the value.\n');
  write(storyPath, `# S1-1: Change value\n<!-- pm-meta: {"builder":"auto","touches":["src"]} -->\n\n## Goal\nChange the value.\n\n## Acceptance criteria (testable)\n- [ ] ${criterion}\n\n## Verification\n- Prove done with: \`${command}\`\n`);
  if (upstream) {
    write('pm/pm-state.json', { ...template('pm-state'), project: 'Original project', phase: 'implementation', signed_off: true,
      approver: 'User', approved_date: '2026-09-01 12:00', current_sprint: 1, total_sprints: 2,
      assignments: {}, updated: '2026-09-01 12:00', extension: { preserve: true } });
    write(actorPath, { ...template('actor-state'), actor: id, current_story: 'S0-1', current_story_status: 'merged',
      current_story_verification_status: 'PASS', current_story_rounds: 2, current_story_retries: 1,
      next: 'Start S1-1.', updated: '2026-09-01 12:00', extension: 'preserve actor extension' });
    write('pm/log.md', '- 2026-09-01 12:00 original: Completed S0-1.\n');
  }
  git('add', '.'); git('commit', '-qm', 'Original framework boundary');
  const start = () => {
    const claimed = pm('claim', '--story', storyPath, '--branch', 'pm/S1-1-value');
    assert.equal(claimed.status, 0, claimed.stdout);
    git('add', 'pm'); git('commit', '-qm', 'Claim S1-1');
    git('checkout', '-qb', 'pm/S1-1-value');
    const initialized = run('init', '--mode', 'managed', '--plan', 'docs/plan.md');
    assert.equal(initialized.status, 0, initialized.stdout);
    const runId = initialized.json.run_id;
    assert.equal(run('approve', '--run', runId, '--approver', 'User').status, 0);
    write('.deliver/task.json', { id: 'S1-1', objective: 'Change value', acceptance: [{ id: 'AC-1', text: criterion }], touches: ['src'], read_paths: ['src'], commands: { test: command }, specs: [] });
    const started = run('start', '--run', runId, '--task', '.deliver/task.json', '--builder', 'native-builder', '--story', storyPath);
    assert.equal(started.status, 0, started.stdout);
    return runId;
  };
  const finish = (runId) => {
    write('src/value.txt', 'after');
    assert.equal(run('gate', '--run', runId, '--name', 'test', '--command', command).status, 0);
    const hash = run('check', '--run', runId).json.snapshot_hash;
    write('.deliver/review.json', { status: 'PASS', findings: [] });
    write('.deliver/verification.json', { criteria: [{ id: 'AC-1', status: 'PASS', evidence: 'Real Node gate checked src/value.txt equals after.' }] });
    assert.equal(run('review', '--run', runId, '--snapshot', hash, '--reviewer', 'peer', '--receipt', '.deliver/review.json').status, 0);
    assert.equal(run('verify', '--run', runId, '--snapshot', hash, '--verifier', 'peer', '--results', '.deliver/verification.json').status, 0);
    const finished = run('finish', '--run', runId);
    assert.equal(finished.status, 0, finished.stdout);
  };
  return { root, id, actorPath, git, write, read, pm, run, start, finish };
}

test('actor identity matches the unchanged upstream algorithm', (t) => {
  const f = fixture(t);
  for (const identity of ['Interop@Test.Example', 'User+Tag@example.com', ' ÉXAMPLE@Example.org ', '名字@example.org']) {
    f.git('config', 'user.email', identity);
    assert.equal(pmActorId(f.root), originalActorId(f.root));
  }
  f.git('config', '--unset', 'user.email');
  assert.equal(pmActorId(f.root), originalActorId(f.root));
});

test('original -> Codex -> original round trip preserves schemas, claims, counters and handoff', (t) => {
  const f = fixture(t);
  const originalStory = fs.readFileSync(path.join(f.root, storyPath), 'utf8');
  const runId = f.start();
  assert.equal(f.run('correct-course', '--run', runId, '--kind', 'fix', '--reason', 'Fixture review round').status, 0);
  f.finish(runId);
  assert.equal(f.read(f.actorPath).current_story_status, 'building', 'runtime finish must not claim a merge');
  const tooEarly = f.pm('complete', '--run', runId, '--commit', f.git('rev-parse', 'HEAD'), '--next', 'Start S1-2.');
  assert.notEqual(tooEarly.status, 0);
  f.git('add', 'src/value.txt'); f.git('commit', '-qm', 'Implement S1-1');
  f.git('checkout', 'main'); f.git('merge', '--no-ff', 'pm/S1-1-value', '-m', 'Merge S1-1');
  const commit = f.git('rev-parse', 'HEAD');
  const completed = f.pm('complete', '--run', runId, '--commit', commit, '--next', 'Start S1-2 after checking its dependencies.');
  assert.equal(completed.status, 0, completed.stdout);
  const core = f.read('pm/pm-state.json'), mine = f.read(f.actorPath);
  assert.deepEqual(core.assignments, {});
  assert.deepEqual(core.extension, { preserve: true });
  assert.equal(core.current_sprint, 1, 'do not advance a sprint without checking other stories');
  assert.equal(mine.current_story_status, 'merged');
  assert.equal(mine.current_story_verification_status, 'PASS');
  assert.equal(mine.current_story_rounds, 1);
  assert.equal(mine.resolved_builder, null);
  assert.equal(mine.extension, 'preserve actor extension');
  assert.equal(mine.handoff_written, mine.updated);
  assert.equal(fs.readFileSync(path.join(f.root, storyPath), 'utf8'), originalStory);
  const hook = spawnSync(process.execPath, [originalHook], { cwd: f.root, input: JSON.stringify({ cwd: f.root }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: f.root } });
  assert.equal(hook.status, 0, hook.stderr);
  assert.match(hook.stdout, /status=merged/);
  assert.match(hook.stdout, /Start S1-2/);
  assert.match(hook.stdout, /current.*HANDOFF.md briefing/);
  assert.doesNotMatch(hook.stdout, /STALE|unknown-actor|migrate/);
  // Simulate the unchanged original taking the next story using its documented
  // fields. Codex status reads these edits directly, not a cached projection.
  core.assignments['S1-2'] = f.id;
  f.write('pm/pm-state.json', core);
  f.write(f.actorPath, { ...mine, current_story: 'S1-2', current_story_status: 'building', resolved_builder: 'expert-builder', next: 'Continue S1-2 in Claude.' });
  const resumed = f.pm('status');
  assert.equal(resumed.json.actor.current_story, 'S1-2');
  assert.equal(resumed.json.actor.resolved_builder, 'expert-builder');
  assert.notEqual(f.pm('claim', '--story', storyPath).status, 0);
});

test('explicit legacy initialization uses the upstream templates without implying sign-off', (t) => {
  const f = fixture(t, { upstream: false });
  assert.equal(f.pm('init', '--name', 'New shared project', '--format', 'legacy').status, 0);
  assert.deepEqual(Object.keys(f.read('pm/pm-state.json')).sort(), Object.keys(template('pm-state')).sort());
  assert.deepEqual(Object.keys(f.read(f.actorPath)).sort(), Object.keys(template('actor-state')).sort());
  assert.equal(f.read('pm/pm-state.json').signed_off, false);
  assert.notEqual(f.pm('claim', '--story', storyPath).status, 0);
  assert.equal(f.pm('approve', '--approver', 'User').status, 0);
  assert.equal(f.pm('claim', '--story', storyPath).status, 0);
  const before = fs.readFileSync(path.join(f.root, f.actorPath), 'utf8');
  assert.equal(f.pm('init').status, 0);
  assert.equal(fs.readFileSync(path.join(f.root, f.actorPath), 'utf8'), before);
});

test('shared PM records cannot be initialized under Git ignore rules', (t) => {
  const f = fixture(t, { upstream: false });
  f.write('.gitignore', 'pm/\n');
  const result = f.pm('init', '--format', 'legacy');
  assert.notEqual(result.status, 0);
  assert.match(result.json.error, /ignored by Git/);
  assert.equal(fs.existsSync(path.join(f.root, 'pm/pm-state.json')), false);
});

test('PM approval refuses secret-shaped text without changing tracked records', (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.root, 'pm/pm-state.json'), 'utf8');
  const result = f.pm('approve', '--approver', 'password=syntheticfixture');
  assert.notEqual(result.status, 0);
  assert.match(result.json.error, /secret-shaped/);
  assert.equal(fs.readFileSync(path.join(f.root, 'pm/pm-state.json'), 'utf8'), before);
});

test('claims reject another actor, active original work, parallel batches and explicit Claude routing', (t) => {
  const f = fixture(t);
  const core = f.read('pm/pm-state.json');
  f.write('pm/pm-state.json', { ...core, assignments: { 'S1-1': 'teammate' } });
  assert.notEqual(f.pm('claim', '--story', storyPath).status, 0);
  f.write('pm/pm-state.json', core);
  const mine = f.read(f.actorPath);
  f.write(f.actorPath, { ...mine, current_story_status: 'building', current_story_rounds: 3 });
  assert.notEqual(f.pm('claim', '--story', storyPath).status, 0);
  assert.equal(f.read(f.actorPath).current_story_rounds, 3);
  f.write(f.actorPath, { ...mine, parallel_batch: [{ story: 'S1-2' }] });
  assert.notEqual(f.pm('claim', '--story', storyPath).status, 0);
  f.write(f.actorPath, mine);
  f.write(storyPath, fs.readFileSync(path.join(f.root, storyPath), 'utf8').replace('"auto"', '"expert-builder"'));
  assert.notEqual(f.pm('claim', '--story', storyPath).status, 0);
});

test('PM binding blocks altered story criteria, lost ownership and duplicate execution runs', (t) => {
  const f = fixture(t);
  const runId = f.start();
  const core = f.read('pm/pm-state.json');
  f.write('pm/pm-state.json', { ...core, signed_off: false });
  assert.notEqual(f.run('check', '--run', runId).status, 0);
  f.write('pm/pm-state.json', core);
  const text = fs.readFileSync(path.join(f.root, storyPath), 'utf8');
  f.write(storyPath, text.replace(criterion, 'A weaker criterion.'));
  assert.notEqual(f.run('check', '--run', runId).status, 0);
  f.write(storyPath, text);
  const duplicate = f.run('init', '--mode', 'quick').json.run_id;
  assert.notEqual(f.run('start', '--run', duplicate, '--task', '.deliver/task.json', '--builder', 'builder', '--story', storyPath).status, 0);
  assert.equal(readStory(f.root, storyPath).criteria[0], criterion);
});

test('changed integration content cannot be exported as the verified story', (t) => {
  const f = fixture(t);
  const runId = f.start(); f.finish(runId);
  f.write('src/value.txt', 'unverified');
  f.git('add', 'src/value.txt'); f.git('commit', '-qm', 'Different content');
  f.git('checkout', 'main'); f.git('merge', '--no-ff', 'pm/S1-1-value', '-m', 'Merge different content');
  const result = f.pm('complete', '--run', runId, '--commit', f.git('rev-parse', 'HEAD'), '--next', 'Continue.');
  assert.notEqual(result.status, 0);
  assert.match(result.json.error, /differs from the verified tree/);
  assert.equal(f.read(f.actorPath).current_story_status, 'building');
});

test('PM symlinks and unsafe journal recovery are refused without overwriting user changes', (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.root, f.actorPath), 'utf8');
  const after = `${before}\n`;
  f.write('.deliver/pm-transaction.json', { actor: f.id, writes: [{ path: f.actorPath, before, after }] });
  assert.notEqual(f.pm('status').status, 0);
  assert.equal(f.pm('recover').status, 0);
  assert.equal(fs.readFileSync(path.join(f.root, f.actorPath), 'utf8'), after);
  f.write('.deliver/pm-transaction.json', { actor: f.id, writes: [{ path: f.actorPath, before, after: `${after}\n` }] });
  f.write(f.actorPath, { ...f.read(f.actorPath), next: 'Concurrent original edit.' });
  assert.notEqual(f.pm('recover').status, 0);
  assert.equal(f.read(f.actorPath).next, 'Concurrent original edit.');
  fs.unlinkSync(path.join(f.root, '.deliver/pm-transaction.json'));
  fs.renameSync(path.join(f.root, 'pm/pm-state.json'), path.join(f.root, 'pm/core-real.json'));
  fs.symlinkSync('core-real.json', path.join(f.root, 'pm/pm-state.json'));
  assert.notEqual(f.pm('status').status, 0);
});
