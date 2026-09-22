import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonical, sha256 } from '../plugins/deliver/skills/deliver/scripts/lib/state.mjs';
import { readStory } from '../plugins/deliver/skills/deliver/scripts/lib/story.mjs';

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

function legacyGitMetadata(root) {
  const gitDir = path.join(root, '.git');
  const fileHash = (file) => { try { return sha256(fs.readFileSync(file)); } catch { return sha256(''); } };
  const hooks = fs.readdirSync(path.join(gitDir, 'hooks')).sort()
    .map((name) => `${name}:${fileHash(path.join(gitDir, 'hooks', name))}`);
  return sha256(canonical({
    head: git(root, 'rev-parse', '--verify', 'HEAD') || 'UNBORN',
    ref: git(root, 'symbolic-ref', '-q', 'HEAD') || 'DETACHED',
    index: sha256(git(root, 'diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv')),
    index_flags: sha256(git(root, 'ls-files', '-s', '-v', '-z')),
    worktree_config: fileHash(path.join(gitDir, 'config.worktree')),
    common_config: fileHash(path.join(gitDir, 'config')),
    exclude: fileHash(path.join(gitDir, 'info', 'exclude')),
    hooks,
  }));
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

function fixture(t, { beforeStart } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-transition-')));
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
  write(root, '.gitignore', 'src/hidden.txt\n');
  git(root, 'add', '.gitignore', 'docs', 'src');
  git(root, 'commit', '-qm', 'Track pending project');
  assert.equal(pm('approve', '--approver', 'Ben').status, 0);
  git(root, 'add', 'docs/approval.json');
  git(root, 'commit', '-qm', 'Approve project');
  assert.equal(pm('claim', '--story', storyRel).status, 0);
  git(root, 'add', storyRel);
  git(root, 'commit', '-qm', 'Publish claim');
  git(root, 'checkout', '-qb', 'pm/S1-1-value');
  if (beforeStart) beforeStart({ root, git: (...args) => git(root, ...args), write: (rel, value) => write(root, rel, value) });
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

function addSubmodule(t, root) {
  const dependency = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-transition-dependency-')));
  t.after(() => fs.rmSync(dependency, { recursive: true, force: true }));
  git(dependency, 'init', '-q');
  git(dependency, 'config', 'user.name', 'Dependency Test');
  git(dependency, 'config', 'user.email', 'dependency@example.invalid');
  write(dependency, 'src/value.txt', 'dependency\n');
  git(dependency, 'add', '.');
  git(dependency, 'commit', '-qm', 'Dependency fixture');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', dependency, 'vendor/dependency');
  git(root, 'commit', '-am', 'Track dependency fixture');
  return path.join(root, 'vendor/dependency');
}

function transition(f, to, ...extra) {
  const result = f.pm('transition', '--run', f.runId, '--to', to, ...extra);
  assert.equal(result.status, 0, result.stdout);
  return result.json;
}

function prepareAndCommit(f, message, extraPaths = []) {
  const prepared = f.run('commit-prepare', '--run', f.runId);
  assert.equal(prepared.status, 0, prepared.stdout);
  assert.match(prepared.json.preparation.token, /^[0-9a-f-]{36}$/);
  git(f.root, 'add', '-A', '--', ...prepared.json.preparation.paths);
  for (const rel of extraPaths) git(f.root, 'add', '-f', '--', rel);
  git(f.root, 'commit', '-qm', message);
  return prepared.json.preparation;
}

function adopt(f, preparation) {
  const head = git(f.root, 'rev-parse', 'HEAD');
  return f.run('commit-adopt', '--run', f.runId, '--token', preparation.token, '--commit', head);
}

function evidence(f, { reviewStatus = 'PASS' } = {}) {
  const gate = f.run('gate', '--run', f.runId, '--name', 'stable', '--command', 'node -e "process.exit(0)"');
  assert.equal(gate.status, 0, gate.stdout);
  const checked = f.run('check', '--run', f.runId);
  assert.equal(checked.status, 0, checked.stdout);
  write(f.root, '.deliver/review.json', {
    status: reviewStatus,
    findings: reviewStatus === 'PASS' ? [] : [{ severity: 'major', message: 'Fixture finding.', resolved: false }],
  });
  const reviewed = f.run('review', '--run', f.runId, '--snapshot', checked.json.snapshot_hash,
    '--reviewer', 'reviewer', '--receipt', '.deliver/review.json');
  assert.equal(reviewed.status, 0, reviewed.stdout);
  if (reviewStatus === 'PASS') {
    write(f.root, '.deliver/verification.json', {
      criteria: [{ id: 'AC-1', status: 'PASS', evidence: 'The fixture snapshot contains the intended value.' }],
    });
    const verified = f.run('verify', '--run', f.runId, '--snapshot', checked.json.snapshot_hash,
      '--verifier', 'verifier', '--results', '.deliver/verification.json');
    assert.equal(verified.status, 0, verified.stdout);
  }
  return checked.json.snapshot_hash;
}

test('current lifecycle adopts intermediate commits, expires stale evidence and finishes on fresh C evidence', (t) => {
  const f = fixture(t);
  const originalState = JSON.parse(fs.readFileSync(f.runFile, 'utf8'));
  const originalBaseline = JSON.stringify(originalState.baseline);

  transition(f, 'building');
  const same = transition(f, 'building');
  assert.equal(same.noop, true);
  const buildingPreparation = prepareAndCommit(f, 'Adopt building state');
  assert.deepEqual(buildingPreparation.paths, [storyRel]);
  let adopted = adopt(f, buildingPreparation);
  assert.equal(adopted.status, 0, adopted.stdout);
  assert.equal(f.run('check', '--run', f.runId).status, 0);

  write(f.root, 'src/value.txt', 'after first build\n');
  transition(f, 'built');
  assert.notEqual(f.pm('transition', '--run', f.runId, '--to', 'claimed').status, 0);
  transition(f, 'in-review');
  const firstCandidate = prepareAndCommit(f, 'Adopt first candidate');
  adopted = adopt(f, firstCandidate);
  assert.equal(adopted.status, 0, adopted.stdout);
  evidence(f, { reviewStatus: 'FAIL' });

  const corrected = f.run('correct-course', '--run', f.runId, '--kind', 'fix', '--reason', 'Address fixture review finding');
  assert.equal(corrected.status, 0, corrected.stdout);
  let document = readStory(f.root, storyRel);
  let state = JSON.parse(fs.readFileSync(f.runFile, 'utf8'));
  assert.equal(document.execution.status, 'building');
  assert.equal(document.execution.rounds, 1);
  assert.equal(state.counters.fixes, 1);
  assert.deepEqual(state.gates, []);
  assert.equal(state.review, null);
  assert.equal(state.evidence_history.length, 1);
  assert.equal(state.evidence_history[0].reason, 'execution_transition');
  assert.equal(state.evidence_history[0].review.status, 'FAIL');

  write(f.root, 'src/value.txt', 'after fixed build\n');
  transition(f, 'built');
  transition(f, 'in-review');
  const staleSnapshot = evidence(f);
  assert.notEqual(f.run('finish', '--run', f.runId).status, 0, 'an uncommitted in-review transition is not candidate C');
  const finalPreparation = f.run('commit-prepare', '--run', f.runId);
  assert.equal(finalPreparation.status, 0, finalPreparation.stdout);
  assert.notEqual(f.run('finish', '--run', f.runId).status, 0, 'pending adoption must block finish');
  git(f.root, 'add', '-A', '--', ...finalPreparation.json.preparation.paths);
  git(f.root, 'commit', '-qm', 'Adopt final candidate C');
  adopted = adopt(f, finalPreparation.json.preparation);
  assert.equal(adopted.status, 0, adopted.stdout);
  state = JSON.parse(fs.readFileSync(f.runFile, 'utf8'));
  assert.deepEqual(state.gates, []);
  assert.equal(state.review, null);
  assert.equal(state.verification, null);
  assert.equal(JSON.stringify(state.baseline), originalBaseline);
  assert.equal(state.counters.fixes, 1);
  assert.equal(state.commit_adoption.history.length, 3);
  assert.equal(state.evidence_history.length, 2);
  assert.equal(state.evidence_history[1].reason, 'commit_adopted');
  assert.equal(state.evidence_history[1].review.status, 'PASS');
  assert.equal(state.evidence_history[1].verification.criteria[0].status, 'PASS');
  const current = f.run('check', '--run', f.runId);
  assert.equal(current.status, 0, current.stdout);
  assert.notEqual(current.json.snapshot_hash, staleSnapshot);
  assert.deepEqual(current.json.changed, ['src/value.txt']);
  assert.equal(current.json.coordinator_execution_changed, storyRel);
  assert.notEqual(f.run('finish', '--run', f.runId).status, 0, 'old evidence must stay expired');
  evidence(f);
  const finished = f.run('finish', '--run', f.runId);
  assert.equal(finished.status, 0, finished.stdout);
  document = readStory(f.root, storyRel);
  assert.equal(document.execution.status, 'in-review', 'T04 finish cannot claim merged project progress');
});

test('torn transition recovery publishes both records and refuses a changed story contract', (t) => {
  const f = fixture(t);
  transition(f, 'building');
  transition(f, 'built');
  transition(f, 'in-review');
  const storyFile = path.join(f.root, storyRel);
  const beforeStory = fs.readFileSync(storyFile, 'utf8');
  const beforeRun = fs.readFileSync(f.runFile, 'utf8');
  const fixed = f.run('correct-course', '--run', f.runId, '--kind', 'fix', '--reason', 'Recover this spent fix');
  assert.equal(fixed.status, 0, fixed.stdout);
  const afterStory = fs.readFileSync(storyFile, 'utf8');
  const afterRun = fs.readFileSync(f.runFile, 'utf8');
  const beforeDocument = readStory(f.root, storyRel);
  fs.writeFileSync(storyFile, beforeStory);
  fs.writeFileSync(f.runFile, beforeRun);
  write(f.root, '.deliver/transition-transaction.json', {
    kind: 'execution-transition-v1',
    contract_hash: beforeDocument.contractHash,
    owner: beforeDocument.execution.owner,
    branch: beforeDocument.execution.branch,
    writes: [
      { path: storyRel, before: beforeStory, after: afterStory },
      { path: `.deliver/runs/${f.runId}.json`, before: beforeRun, after: afterRun },
    ],
  });
  fs.writeFileSync(storyFile, afterStory);
  const recovered = f.pm('recover');
  assert.equal(recovered.status, 0, recovered.stdout);
  assert.equal(recovered.json.recovered, true);
  assert.equal(readStory(f.root, storyRel).execution.rounds, 1);
  assert.equal(JSON.parse(fs.readFileSync(f.runFile, 'utf8')).counters.fixes, 1);
  assert.equal(f.run('check', '--run', f.runId).status, 0);

  const retryBeforeStory = fs.readFileSync(storyFile, 'utf8');
  const retryBeforeRun = fs.readFileSync(f.runFile, 'utf8');
  const retried = f.run('correct-course', '--run', f.runId, '--kind', 'retry', '--reason', 'Synthetic retry');
  assert.equal(retried.status, 0, retried.stdout);
  const retryAfterStory = fs.readFileSync(storyFile, 'utf8');
  const retryAfterRun = fs.readFileSync(f.runFile, 'utf8');
  fs.writeFileSync(storyFile, retryBeforeStory);
  fs.writeFileSync(f.runFile, retryBeforeRun);
  const retryBeforeDocument = readStory(f.root, storyRel);
  const journalFile = path.join(f.root, '.deliver/transition-transaction.json');
  const validJournal = {
    kind: 'execution-transition-v1',
    contract_hash: retryBeforeDocument.contractHash,
    owner: retryBeforeDocument.execution.owner,
    branch: retryBeforeDocument.execution.branch,
    writes: [
      { path: storyRel, before: retryBeforeStory, after: retryAfterStory },
      { path: `.deliver/runs/${f.runId}.json`, before: retryBeforeRun, after: retryAfterRun },
    ],
  };
  const rejectWithoutMutation = (journal, expected) => {
    write(f.root, '.deliver/transition-transaction.json', journal);
    const rejected = f.pm('recover');
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.json.error, expected);
    assert.equal(fs.readFileSync(storyFile, 'utf8'), retryBeforeStory);
    assert.equal(fs.readFileSync(f.runFile, 'utf8'), retryBeforeRun);
    fs.unlinkSync(journalFile);
  };

  const changedCriterion = structuredClone(validJournal);
  changedCriterion.writes[0].after = retryAfterStory.replace(criterion, 'A crafted criterion must never be recovered.');
  rejectWithoutMutation(changedCriterion, /contract|exact legal result/);

  const changedContract = structuredClone(validJournal);
  changedContract.contract_hash = '0'.repeat(64);
  rejectWithoutMutation(changedContract, /contract, owner or branch/);

  const changedBinding = structuredClone(validJournal);
  const bindingState = JSON.parse(retryAfterRun);
  bindingState.pm_binding.branch = 'pm/crafted-binding';
  changedBinding.writes[1].after = `${JSON.stringify(bindingState, null, 2)}\n`;
  rejectWithoutMutation(changedBinding, /exact legal result/);

  const resetCounter = structuredClone(validJournal);
  const counterState = JSON.parse(retryAfterRun);
  counterState.counters.retries = 0;
  resetCounter.writes[1].after = `${JSON.stringify(counterState, null, 2)}\n`;
  rejectWithoutMutation(resetCounter, /exact legal result/);

  write(f.root, '.deliver/transition-transaction.json', validJournal);
  const thirdStory = retryBeforeStory.replace(criterion, 'Concurrent contract text must remain untouched.');
  fs.writeFileSync(storyFile, thirdStory);
  const conflict = f.pm('recover');
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.json.error, /preserve changed contracts/);
  assert.equal(fs.readFileSync(storyFile, 'utf8'), thirdStory);
  assert.equal(fs.readFileSync(f.runFile, 'utf8'), retryBeforeRun);
  fs.unlinkSync(journalFile);
});

test('unauthorized commits and prepared tree or protected metadata changes cannot be adopted', (t) => {
  const worker = fixture(t);
  write(worker.root, 'src/value.txt', 'worker committed\n');
  git(worker.root, 'add', 'src/value.txt');
  git(worker.root, 'commit', '-qm', 'Unauthorized worker commit');
  assert.notEqual(worker.run('check', '--run', worker.runId).status, 0);
  assert.notEqual(worker.run('commit-prepare', '--run', worker.runId).status, 0);

  const receipts = fixture(t);
  transition(receipts, 'building');
  write(receipts.root, 'src/value.txt', 'prepared\n');
  const prepared = receipts.run('commit-prepare', '--run', receipts.runId);
  assert.equal(prepared.status, 0, prepared.stdout);
  git(receipts.root, 'add', '-A', '--', ...prepared.json.preparation.paths);
  git(receipts.root, 'add', '-f', '--', `.deliver/runs/${receipts.runId}.json`);
  git(receipts.root, 'commit', '-qm', 'Try to hide a receipt in the code commit');
  const receiptAdoption = adopt(receipts, prepared.json.preparation);
  assert.notEqual(receiptAdoption.status, 0);
  assert.match(receiptAdoption.json.error, /tree or index differs/);

  const metadata = fixture(t);
  transition(metadata, 'building');
  write(metadata.root, 'src/value.txt', 'prepared\n');
  const metadataPreparation = metadata.run('commit-prepare', '--run', metadata.runId);
  assert.equal(metadataPreparation.status, 0, metadataPreparation.stdout);
  fs.appendFileSync(path.join(metadata.root, '.git/info/exclude'), '\ncoordinator-hidden\n');
  git(metadata.root, 'add', '-A', '--', ...metadataPreparation.json.preparation.paths);
  git(metadata.root, 'commit', '-qm', 'Commit with changed protected metadata');
  const metadataAdoption = adopt(metadata, metadataPreparation.json.preparation);
  assert.notEqual(metadataAdoption.status, 0);
  assert.match(metadataAdoption.json.error, /protected Git/);

  const ignored = fixture(t);
  transition(ignored, 'building');
  write(ignored.root, 'src/value.txt', 'visible change\n');
  write(ignored.root, 'src/hidden.txt', 'hidden source change\n');
  const ignoredPreparation = ignored.run('commit-prepare', '--run', ignored.runId);
  assert.notEqual(ignoredPreparation.status, 0);
  assert.match(ignoredPreparation.json.error, /leave audited source outside the commit/);

  const lineage = fixture(t);
  transition(lineage, 'building');
  write(lineage.root, 'src/value.txt', 'prepared lineage\n');
  const lineagePreparation = prepareAndCommit(lineage, 'Prepared child');
  git(lineage.root, 'commit', '--allow-empty', '-qm', 'Unexpected second child');
  const lineageAdoption = adopt(lineage, lineagePreparation);
  assert.notEqual(lineageAdoption.status, 0);
  assert.match(lineageAdoption.json.error, /one single-parent child/);

  const branch = fixture(t);
  transition(branch, 'building');
  write(branch.root, 'src/value.txt', 'prepared branch\n');
  const branchPreparation = prepareAndCommit(branch, 'Prepared on claimed branch');
  git(branch.root, 'checkout', '-qb', 'other-branch');
  const branchAdoption = adopt(branch, branchPreparation);
  assert.notEqual(branchAdoption.status, 0);
  assert.match(branchAdoption.json.error, /branch/);
});

test('current correct-course cannot bypass a missing shared story binding', (t) => {
  const f = fixture(t);
  const state = JSON.parse(fs.readFileSync(f.runFile, 'utf8'));
  state.pm_binding = null;
  fs.writeFileSync(f.runFile, `${JSON.stringify(state, null, 2)}\n`);
  const result = f.run('correct-course', '--run', f.runId, '--kind', 'fix', '--reason', 'Cannot spend this attempt');
  assert.notEqual(result.status, 0);
  assert.match(result.json.error, /current-bound run|shared story binding/);
  assert.equal(JSON.parse(fs.readFileSync(f.runFile, 'utf8')).counters.fixes, 0);
});

test('a pre-T04 current run bootstraps an anchor without replacing its legacy baseline', (t) => {
  const f = fixture(t);
  const state = JSON.parse(fs.readFileSync(f.runFile, 'utf8'));
  state.baseline.snapshot.git_meta = legacyGitMetadata(f.root);
  state.baseline.snapshot.hash = sha256(canonical({
    entries: state.baseline.snapshot.entries,
    git_meta: state.baseline.snapshot.git_meta,
  }));
  delete state.git_anchor;
  delete state.execution_audit;
  delete state.commit_adoption;
  fs.writeFileSync(f.runFile, `${JSON.stringify(state, null, 2)}\n`);
  const originalBaseline = JSON.stringify(state.baseline);

  transition(f, 'building');
  write(f.root, 'src/value.txt', 'legacy run change\n');
  const preparation = prepareAndCommit(f, 'Adopt legacy-baseline run');
  let migrated = JSON.parse(fs.readFileSync(f.runFile, 'utf8'));
  assert.equal(migrated.baseline_metadata_version, 'legacy-v1');
  assert.equal(JSON.stringify(migrated.baseline), originalBaseline);
  const adopted = adopt(f, preparation);
  assert.equal(adopted.status, 0, adopted.stdout);
  migrated = JSON.parse(fs.readFileSync(f.runFile, 'utf8'));
  assert.equal(JSON.stringify(migrated.baseline), originalBaseline);
  assert.equal(f.run('check', '--run', f.runId).status, 0);
});

test('legacy anchor bootstrap refuses an active hook whose mode was not recorded', (t) => {
  const f = fixture(t, {
    beforeStart: ({ root }) => {
      write(root, '.git/hooks/pre-commit', '#!/bin/sh\nexit 0\n');
      fs.chmodSync(path.join(root, '.git/hooks/pre-commit'), 0o755);
    },
  });
  const state = JSON.parse(fs.readFileSync(f.runFile, 'utf8'));
  state.baseline.snapshot.git_meta = legacyGitMetadata(f.root);
  state.baseline.snapshot.hash = sha256(canonical({
    entries: state.baseline.snapshot.entries,
    git_meta: state.baseline.snapshot.git_meta,
  }));
  delete state.git_anchor;
  delete state.execution_audit;
  delete state.commit_adoption;
  fs.writeFileSync(f.runFile, `${JSON.stringify(state, null, 2)}\n`);
  transition(f, 'building');
  const before = fs.readFileSync(f.runFile, 'utf8');
  const rejected = f.run('commit-prepare', '--run', f.runId);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.json.error, /legacy Git metadata cannot prove.*active hook/);
  assert.equal(fs.readFileSync(f.runFile, 'utf8'), before);
});

test('commit preparation preserves unstaged baseline dirt and rejects a staged baseline', (t) => {
  const unstaged = fixture(t, {
    beforeStart: ({ write: writeFixture }) => writeFixture('src/preexisting.txt', 'user work\n'),
  });
  const preexisting = fs.readFileSync(path.join(unstaged.root, 'src/preexisting.txt'), 'utf8');
  transition(unstaged, 'building');
  write(unstaged.root, 'src/value.txt', 'task work\n');
  const preparation = unstaged.run('commit-prepare', '--run', unstaged.runId);
  assert.equal(preparation.status, 0, preparation.stdout);
  assert.deepEqual(preparation.json.preparation.paths, [storyRel, 'src/value.txt']);
  assert.equal(git(unstaged.root, 'status', '--short', '--', 'src/preexisting.txt'), '?? src/preexisting.txt');
  git(unstaged.root, 'add', '-A', '--', ...preparation.json.preparation.paths);
  assert.equal(git(unstaged.root, 'diff', '--cached', '--name-only').includes('src/preexisting.txt'), false);
  git(unstaged.root, 'commit', '-qm', 'Commit task without baseline dirt');
  const adopted = adopt(unstaged, preparation.json.preparation);
  assert.equal(adopted.status, 0, adopted.stdout);
  assert.equal(fs.readFileSync(path.join(unstaged.root, 'src/preexisting.txt'), 'utf8'), preexisting);
  assert.equal(git(unstaged.root, 'status', '--short', '--', 'src/preexisting.txt'), '?? src/preexisting.txt');

  const staged = fixture(t, {
    beforeStart: ({ git: gitFixture, write: writeFixture }) => {
      writeFixture('src/prestaged.txt', 'staged user work\n');
      gitFixture('add', 'src/prestaged.txt');
    },
  });
  const head = git(staged.root, 'rev-parse', 'HEAD');
  const index = git(staged.root, 'diff', '--cached', '--binary');
  transition(staged, 'building');
  write(staged.root, 'src/value.txt', 'task work\n');
  const rejected = staged.run('commit-prepare', '--run', staged.runId);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.json.error, /clean index/);
  assert.equal(git(staged.root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(staged.root, 'diff', '--cached', '--binary'), index);
  assert.equal(JSON.parse(fs.readFileSync(staged.runFile, 'utf8')).commit_adoption.pending, null);
});

test('commit preparation cannot omit an already flagged changed source path', (t) => {
  const f = fixture(t, {
    beforeStart: ({ git: gitFixture }) => gitFixture('update-index', '--assume-unchanged', 'src/value.txt'),
  });
  transition(f, 'building');
  write(f.root, 'src/value.txt', 'hidden by assume-unchanged\n');
  const head = git(f.root, 'rev-parse', 'HEAD');
  const flags = git(f.root, 'ls-files', '-v', '--', 'src/value.txt');
  const rejected = f.run('commit-prepare', '--run', f.runId);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.json.error, /unsupported index flag/);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(f.root, 'ls-files', '-v', '--', 'src/value.txt'), flags);
  assert.equal(JSON.parse(fs.readFileSync(f.runFile, 'utf8')).commit_adoption.pending, null);
});

test('adoption rejects post-commit index flag drift without consuming its preparation', (t) => {
  const f = fixture(t);
  transition(f, 'building');
  write(f.root, 'src/value.txt', 'prepared source\n');
  const preparation = prepareAndCommit(f, 'Prepared before index flag drift');
  git(f.root, 'update-index', '--assume-unchanged', 'src/value.txt');
  const beforeRun = fs.readFileSync(f.runFile, 'utf8');
  const beforeFlags = git(f.root, 'ls-files', '-v', '--', 'src/value.txt');
  const rejected = adopt(f, preparation);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.json.error, /index flags/);
  assert.equal(fs.readFileSync(f.runFile, 'utf8'), beforeRun);
  assert.equal(git(f.root, 'ls-files', '-v', '--', 'src/value.txt'), beforeFlags);
  assert.equal(JSON.parse(fs.readFileSync(f.runFile, 'utf8')).commit_adoption.pending.token, preparation.token);
});

test('adoption binds effective hook mode without changing the hook or pending state', (t) => {
  const f = fixture(t, {
    beforeStart: ({ root }) => {
      write(root, '.git/hooks/pre-commit', '#!/bin/sh\nexit 0\n');
      fs.chmodSync(path.join(root, '.git/hooks/pre-commit'), 0o644);
    },
  });
  transition(f, 'building');
  write(f.root, 'src/value.txt', 'prepared source\n');
  const preparation = prepareAndCommit(f, 'Prepared before hook mode drift');
  const hook = path.join(f.root, '.git/hooks/pre-commit');
  fs.chmodSync(hook, 0o755);
  const beforeRun = fs.readFileSync(f.runFile, 'utf8');
  const rejected = adopt(f, preparation);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.json.error, /protected Git/);
  assert.equal(fs.readFileSync(f.runFile, 'utf8'), beforeRun);
  assert.equal(fs.statSync(hook).mode & 0o777, 0o755);
  assert.equal(JSON.parse(fs.readFileSync(f.runFile, 'utf8')).commit_adoption.pending.token, preparation.token);
});

test('recursive anchors reject nested Git metadata at check, prepare and adopt', (t) => {
  let moduleRoot;
  const f = fixture(t, { beforeStart: ({ root }) => { moduleRoot = addSubmodule(t, root); } });
  transition(f, 'building');
  write(f.root, 'src/value.txt', 'source with protected dependency\n');

  git(moduleRoot, 'config', 'deliver.fixture', 'changed');
  assert.notEqual(f.run('check', '--run', f.runId).status, 0);
  assert.notEqual(f.run('commit-prepare', '--run', f.runId).status, 0);
  git(moduleRoot, 'config', '--unset', 'deliver.fixture');

  const hooks = git(moduleRoot, 'rev-parse', '--git-path', 'hooks');
  fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\n');
  assert.notEqual(f.run('check', '--run', f.runId).status, 0);
  assert.notEqual(f.run('commit-prepare', '--run', f.runId).status, 0);
  fs.unlinkSync(path.join(hooks, 'pre-commit'));

  git(moduleRoot, 'update-index', '--assume-unchanged', 'src/value.txt');
  assert.notEqual(f.run('check', '--run', f.runId).status, 0);
  assert.notEqual(f.run('commit-prepare', '--run', f.runId).status, 0);
  git(moduleRoot, 'update-index', '--no-assume-unchanged', 'src/value.txt');

  const preparation = prepareAndCommit(f, 'Prepared with recursive anchor');
  git(moduleRoot, 'update-index', '--assume-unchanged', 'src/value.txt');
  const beforeRun = fs.readFileSync(f.runFile, 'utf8');
  const rejected = adopt(f, preparation);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.json.error, /protected Git/);
  assert.equal(fs.readFileSync(f.runFile, 'utf8'), beforeRun);
  assert.equal(JSON.parse(fs.readFileSync(f.runFile, 'utf8')).commit_adoption.pending.token, preparation.token);
});
