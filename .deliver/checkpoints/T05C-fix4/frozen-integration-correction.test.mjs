import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonical, sha256 } from '../plugins/deliver/skills/deliver/scripts/lib/state.mjs';
import { readStory, replaceStoryExecution } from '../plugins/deliver/skills/deliver/scripts/lib/story.mjs';
import { captureGitAnchor, snapshot } from '../plugins/deliver/skills/deliver/scripts/lib/scope.mjs';

const integrationApi = await import('../plugins/deliver/skills/deliver/scripts/lib/integration.mjs');

const runtime = fileURLToPath(new URL('../plugins/deliver/skills/deliver/scripts/deliver.mjs', import.meta.url));
const pmCli = fileURLToPath(new URL('../plugins/deliver/skills/deliver/scripts/pm.mjs', import.meta.url));
const storyRel = 'docs/stories/S1-1-value.md';
const criterion = 'The corrected value preserves the complete approved behavior.';
const gateCommand = "node -e \"process.exit(require('node:fs').existsSync('.deliver/fail-integration') ? 1 : 0)\"";

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function write(root, rel, value) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function call(root, file, ...args) {
  const result = spawnSync(process.execPath, [file, ...args], { cwd: root, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch {}
  return { ...result, json };
}

function requireFunction(name) {
  assert.equal(
    typeof integrationApi[name],
    'function',
    `integration.mjs must export the T05C public function ${name}`,
  );
  return integrationApi[name];
}

function story() {
  return [
    '# S1-1: Correct value',
    '<!-- pm-meta: {"builder":"codex-builder","touches":["src"]} -->',
    'Sprint: 1 · Priority: high · Covers: AC-001 · Depends on: none · Parallel-safe: yes',
    'Risk: low · Review lenses: code-integrity-reviewer · Specs: none',
    '',
    '## Goal',
    'Preserve the whole approved value behavior through correction.',
    '',
    '## Acceptance criteria (testable)',
    `- [ ] ${criterion}`,
    '',
    '## Verification',
    '- Run the declared test gate and independently review the complete task.',
    '',
  ].join('\n');
}

function setRunCounters(runFile, counters) {
  const state = readJson(runFile);
  state.counters = { ...state.counters, ...counters };
  fs.writeFileSync(runFile, `${JSON.stringify(state, null, 2)}\n`);
}

function buildFinishedSource(t, {
  fixes = 1, retries = 1, corrections = 2,
  protectCodexConfig = false, enableWorktreeConfig = false, withSubmodule = false,
  relativeHooks = false,
} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-correction-source-')));
  const integration = `${root}-integration`;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(integration, { recursive: true, force: true }));
  git(root, 'init', '-q', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Casey Example');
  git(root, 'config', 'user.email', 'casey@example.invalid');
  git(root, 'config', 'core.filemode', 'true');
  if (protectCodexConfig) fs.appendFileSync(path.join(root, '.git/info/exclude'), '\n.codex/\n');
  if (enableWorktreeConfig) git(root, 'config', 'extensions.worktreeConfig', 'true');
  if (relativeHooks) {
    git(root, 'config', 'core.hooksPath', '.githooks');
    const hook = write(root, '.githooks/pre-commit', '#!/bin/sh\nexit 0\n');
    fs.chmodSync(hook, 0o644);
    git(root, 'add', '.githooks/pre-commit');
  }
  let dependency = null;
  let dependencyA = null;
  let dependencyB = null;
  if (withSubmodule) {
    dependency = `${root}-dependency`;
    t.after(() => fs.rmSync(dependency, { recursive: true, force: true }));
    fs.mkdirSync(dependency);
    git(dependency, 'init', '-q', '--initial-branch=main');
    git(dependency, 'config', 'user.name', 'Dependency Author');
    git(dependency, 'config', 'user.email', 'dependency@example.invalid');
    write(dependency, 'value.txt', 'dependency A\n');
    git(dependency, 'add', 'value.txt');
    git(dependency, 'commit', '-qm', 'Dependency A');
    dependencyA = git(dependency, 'rev-parse', 'HEAD');
    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', dependency, 'vendor/dependency');
    git(root, 'config', '-f', '.gitmodules', 'submodule.vendor/dependency.ignore', 'all');
    git(root, 'add', '.gitmodules', 'vendor/dependency');
    write(dependency, 'value.txt', 'dependency B\n');
    git(dependency, 'add', 'value.txt');
    git(dependency, 'commit', '-qm', 'Dependency B');
    dependencyB = git(dependency, 'rev-parse', 'HEAD');
  }
  const pm = (...args) => call(root, pmCli, ...args);
  const run = (...args) => call(root, runtime, ...args);

  assert.equal(pm('init').status, 0);
  write(root, 'docs/plan.md', '# Plan\n\n## Delivery mode\n- Scale: standard\n- Checkpoint policy: story-level\n- Integration branch: main\n- Skeleton: none\n');
  write(root, storyRel, story());
  write(root, 'src/value.txt', 'base value\n');
  git(root, 'add', 'docs', 'src');
  git(root, 'commit', '-qm', 'Approved task inputs');
  assert.equal(pm('approve', '--approver', 'Ben').status, 0);
  git(root, 'add', 'docs/approval.json');
  git(root, 'commit', '-qm', 'Approve plan');
  assert.equal(pm('claim', '--story', storyRel).status, 0);
  const claimed = readStory(root, storyRel);
  fs.writeFileSync(path.join(root, storyRel), replaceStoryExecution(claimed, {
    retained_unknown: 'older-I-value',
  }).after);
  git(root, 'add', storyRel);
  git(root, 'commit', '-qm', 'Claim source story');
  git(root, 'checkout', '-qb', 'pm/S1-1-value');

  const packet = {
    id: 'S1-1',
    objective: 'Preserve the whole approved value behavior through correction.',
    acceptance: [{ id: 'AC-1', text: criterion }],
    read_paths: ['docs/plan.md', storyRel],
    touches: ['src'],
    commands: { test: gateCommand },
    specs: [],
  };
  write(root, '.deliver/task.json', packet);
  const initialized = run('init', '--mode', 'managed');
  assert.equal(initialized.status, 0, initialized.stdout);
  const runId = initialized.json.run_id;
  const runFile = path.join(root, '.deliver/runs', `${runId}.json`);
  const started = run('start', '--run', runId, '--task', '.deliver/task.json', '--builder', 'source-builder', '--story', storyRel);
  assert.equal(started.status, 0, started.stdout);
  setRunCounters(runFile, { fixes, retries, corrections });
  for (const status of ['building', 'built', 'in-review']) {
    const transitioned = pm('transition', '--run', runId, '--to', status);
    assert.equal(transitioned.status, 0, transitioned.stdout);
  }

  write(root, 'src/value.txt', 'candidate value\n');
  const commitPreparation = run('commit-prepare', '--run', runId);
  assert.equal(commitPreparation.status, 0, commitPreparation.stdout);
  git(root, 'add', '-A', '--', ...commitPreparation.json.preparation.paths);
  git(root, 'commit', '-qm', 'Candidate C');
  const candidate = git(root, 'rev-parse', 'HEAD');
  assert.equal(run('commit-adopt', '--run', runId, '--token', commitPreparation.json.preparation.token, '--commit', candidate).status, 0);
  const checked = run('check', '--run', runId);
  assert.equal(checked.status, 0, checked.stdout);
  assert.equal(run('gate', '--run', runId, '--name', 'test', '--command', gateCommand).status, 0);

  const inherited = [
    { severity: 'minor', message: 'Preserve the duplicate edge case.', path: 'src/value.txt', resolved: false },
    { severity: 'minor', message: 'Preserve the duplicate edge case.', path: 'src/value.txt', resolved: false },
    { severity: 'minor', message: 'Keep the plan-visible behavior.', path: 'docs/plan.md', resolved: false },
  ];
  write(root, '.deliver/source-review.json', {
    status: 'PASS', findings: [], panel: {
      snapshot_hash: checked.json.snapshot_hash,
      members: [{
        lens: 'code-integrity-reviewer', reviewer: 'source-panel-reviewer', verdict: 'CONCERNS',
        snapshot_hash: checked.json.snapshot_hash, findings: inherited,
      }],
    },
  });
  assert.equal(run('review', '--run', runId, '--snapshot', checked.json.snapshot_hash,
    '--reviewer', 'source-reviewer', '--receipt', '.deliver/source-review.json').status, 0);
  write(root, '.deliver/source-verification.json', {
    criteria: [{ id: 'AC-1', status: 'PASS', evidence: 'Candidate C passed the declared source gate.' }],
  });
  assert.equal(run('verify', '--run', runId, '--snapshot', checked.json.snapshot_hash,
    '--verifier', 'source-verifier', '--results', '.deliver/source-verification.json').status, 0);
  assert.equal(run('finish', '--run', runId).status, 0);
  const sourceState = readJson(runFile);
  assert.equal(sourceState.phase, 'finished');
  assert.deepEqual(sourceState.task.packet, packet);

  git(root, 'worktree', 'add', '-q', integration, 'main');
  if (withSubmodule) {
    git(integration, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q');
    assert.equal(git(path.join(integration, 'vendor/dependency'), 'rev-parse', 'HEAD'), dependencyA);
  }
  return {
    root, integration, runId, runFile, packet, candidate, sourceState, inherited,
    dependency, dependencyA, dependencyB,
    pm: (...args) => call(integration, pmCli, ...args),
  };
}

function makeActualFailedM(t, options = {}) {
  const fixture = buildFinishedSource(t, options);
  const prepared = fixture.pm('integrate-prepare', '--run', fixture.runFile);
  assert.equal(prepared.status, 0, prepared.stdout);
  git(fixture.integration, 'merge', '--no-ff', '--no-edit', fixture.candidate);
  const merge = git(fixture.integration, 'rev-parse', 'HEAD');
  const adopted = fixture.pm('integrate-adopt', '--integration', prepared.json.file,
    '--expected-record', prepared.json.hash, '--token', prepared.json.record.integration.token, '--commit', merge);
  assert.equal(adopted.status, 0, adopted.stdout);
  write(fixture.integration, '.deliver/fail-integration', 'make the declared integration gate fail\n');
  const failed = fixture.pm('integrate-gate', '--integration', prepared.json.file,
    '--expected-record', adopted.json.hash, '--name', 'test');
  assert.equal(failed.status, 0, failed.stdout);
  assert.equal(failed.json.result.status, 'FAIL');
  const gate = failed.json.record.evidence.gates.find((item) => item.name === 'test');
  assert.equal(gate.status, 'FAIL');
  assert.equal(sha256(fs.readFileSync(path.join(fixture.integration, gate.log_path))), gate.log_hash);
  fs.unlinkSync(path.join(fixture.integration, '.deliver/fail-integration'));
  return {
    ...fixture, recordFile: failed.json.file, record: failed.json.record, recordHash: failed.json.hash,
    startCommit: merge, basis: 'failed-integration',
  };
}

function makeAdoptedM(t, options = {}) {
  const fixture = buildFinishedSource(t, options);
  const prepared = fixture.pm('integrate-prepare', '--run', fixture.runFile);
  assert.equal(prepared.status, 0, prepared.stdout);
  git(fixture.integration, 'merge', '--no-ff', '--no-edit', fixture.candidate);
  const merge = git(fixture.integration, 'rev-parse', 'HEAD');
  const adopted = fixture.pm('integrate-adopt', '--integration', prepared.json.file,
    '--expected-record', prepared.json.hash, '--token', prepared.json.record.integration.token, '--commit', merge);
  assert.equal(adopted.status, 0, adopted.stdout);
  const gated = fixture.pm('integrate-gate', '--integration', prepared.json.file,
    '--expected-record', adopted.json.hash, '--name', 'test');
  assert.equal(gated.status, 0, gated.stdout);
  assert.equal(gated.json.result.status, 'PASS');
  return {
    ...fixture, recordFile: gated.json.file, record: gated.json.record, recordHash: gated.json.hash,
    startCommit: merge, basis: 'failed-integration',
  };
}

function writeRecord(fixture, record) {
  fs.writeFileSync(fixture.recordFile, `${JSON.stringify(record, null, 2)}\n`);
  fixture.record = record;
  fixture.recordHash = sha256(canonical(record));
}

function restoreRecordBytes(fixture, bytes) {
  fs.writeFileSync(fixture.recordFile, bytes);
  fixture.record = JSON.parse(bytes);
  fixture.recordHash = sha256(canonical(fixture.record));
}

function fixtureIntegrity(fixture) {
  const referenced = new Set();
  const collect = (value, key = '') => {
    if (typeof value === 'string' && key.endsWith('_path') && value.startsWith('.deliver/')) {
      const file = path.join(fixture.integration, value);
      if (fs.existsSync(file) && fs.lstatSync(file).isFile()) referenced.add(value);
      return;
    }
    if (Array.isArray(value)) for (const item of value) collect(item);
    else if (value && typeof value === 'object') {
      for (const [nestedKey, nestedValue] of Object.entries(value)) collect(nestedValue, nestedKey);
    }
  };
  collect(fixture.record);
  return {
    source_run: sha256(fs.readFileSync(fixture.runFile)),
    source_story: sha256(fs.readFileSync(path.join(fixture.root, storyRel))),
    integration_story: sha256(fs.readFileSync(path.join(fixture.integration, storyRel))),
    record: sha256(fs.readFileSync(fixture.recordFile)),
    refs: git(fixture.integration, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'),
    evidence: Object.fromEntries([...referenced].sort().map((rel) => [
      rel, sha256(fs.readFileSync(path.join(fixture.integration, rel))),
    ])),
  };
}

function reidentify(receipt) {
  const next = structuredClone(receipt);
  delete next.identity;
  next.identity = sha256(canonical(next));
  return next;
}

function recordFailedIntegrationReview(fixture, finding = {
  severity: 'major', message: 'Actual M needs correction.', path: 'src/value.txt', resolved: false,
}) {
  write(fixture.integration, '.deliver/failed-integration-review.json', {
    status: 'FAIL', findings: [], panel: {
      snapshot_hash: fixture.record.evidence.snapshot_hash,
      members: [{
        lens: 'code-integrity-reviewer', reviewer: 'm-panel-reviewer', verdict: 'FAIL',
        snapshot_hash: fixture.record.evidence.snapshot_hash, findings: [finding],
      }],
    },
  });
  const reviewed = fixture.pm('integrate-review', '--integration', fixture.recordFile,
    '--expected-record', fixture.recordHash, '--reviewer', 'm-reviewer',
    '--receipt', '.deliver/failed-integration-review.json');
  assert.equal(reviewed.status, 0, reviewed.stdout);
  fixture.record = reviewed.json.record;
  fixture.recordHash = reviewed.json.hash;
  return fixture;
}

function recordFailedIntegrationVerification(fixture, status = 'FAIL') {
  write(fixture.integration, '.deliver/failed-integration-verification.json', {
    criteria: [{ id: 'AC-1', status, evidence: `Actual M criterion is ${status}.` }],
  });
  const verified = fixture.pm('integrate-verify', '--integration', fixture.recordFile,
    '--expected-record', fixture.recordHash, '--verifier', 'm-verifier',
    '--results', '.deliver/failed-integration-verification.json');
  assert.equal(verified.status, 0, verified.stdout);
  fixture.record = verified.json.record;
  fixture.recordHash = verified.json.hash;
  return fixture;
}

function installOlderIntegrationExecution(fixture, { rounds = 2, retries = 2, ...overrides } = {}) {
  const document = readStory(fixture.integration, storyRel);
  const sourceExecution = readStory(fixture.root, storyRel).execution;
  const replacement = replaceStoryExecution(document, {
    owner: sourceExecution.owner,
    builder: sourceExecution.builder,
    branch: 'pm/S1-1-older',
    status: 'built',
    rounds,
    retries,
    updated: '2026-09-10 12:00',
    retained_unknown: 'older-I-value',
    ...overrides,
  });
  fs.writeFileSync(path.join(fixture.integration, storyRel), replacement.after);
}

function makeActualNoM(t, {
  before = 'unclaimed', executionOverrides = {},
  basisProtectedConfig = null, basisWorktreeConfig = null, ...options
} = {}) {
  const fixture = buildFinishedSource(t, options);
  write(fixture.integration, 'src/value.txt', 'integration-side conflict\n');
  if (before === 'older') installOlderIntegrationExecution(fixture, executionOverrides);
  else fs.writeFileSync(path.join(fixture.integration, storyRel), story());
  git(fixture.integration, 'add', 'src/value.txt', storyRel);
  git(fixture.integration, 'commit', '-qm', 'Integration I conflicts with candidate C');
  if (basisProtectedConfig !== null) write(fixture.integration, '.codex/config.toml', basisProtectedConfig);
  if (basisWorktreeConfig !== null) {
    git(fixture.integration, 'config', '--worktree', 'deliver.protectedProbe', basisWorktreeConfig);
  }
  const integrationCommit = git(fixture.integration, 'rev-parse', 'HEAD');
  const prepared = fixture.pm('integrate-prepare', '--run', fixture.runFile);
  assert.equal(prepared.status, 0, prepared.stdout);
  assert.equal(prepared.json.record.integration.status, 'failed');
  assert.equal(prepared.json.record.integration.commit, null);
  assert.equal(prepared.json.record.integration.failure.integration, integrationCommit);
  assert.equal(prepared.json.record.integration.failure.candidate, fixture.candidate);
  assert.notEqual(prepared.json.record.integration.failure.status, 0);
  assert.deepEqual(prepared.json.record.integration.failure.argv.slice(-4), [
    'merge-tree', '--write-tree', integrationCommit, fixture.candidate,
  ]);
  const log = path.join(fixture.integration, prepared.json.record.integration.failure.log_path);
  assert.equal(sha256(fs.readFileSync(log)), prepared.json.record.integration.failure.log_hash);
  return {
    ...fixture, recordFile: prepared.json.file, record: prepared.json.record, recordHash: prepared.json.hash,
    startCommit: integrationCommit, basis: 'composition-conflict-no-m', before,
  };
}

function correctionPrepare(fixture) {
  const prepare = requireFunction('prepareIntegrationCorrection');
  return prepare(fixture.runFile, {
    integrationRecord: fixture.recordFile,
    expectedRecordHash: fixture.recordHash,
  }, fixture.integration);
}

function addCorrectionWorktree(t, fixture, prepared, { submoduleMode = 'shared-worktree' } = {}) {
  const correctionRoot = `${fixture.root}-correction-${prepared.result.run_id}`;
  t.after(() => fs.rmSync(correctionRoot, { recursive: true, force: true }));
  git(fixture.integration, 'worktree', 'add', '-q', '-b', prepared.result.branch,
    correctionRoot, prepared.result.start_commit);
  if (fixture.dependency) {
    const moduleRoot = path.join(correctionRoot, 'vendor/dependency');
    if (submoduleMode === 'fresh-clone') {
      git(correctionRoot, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q');
    } else {
      assert.equal(submoduleMode, 'shared-worktree');
      fs.rmSync(moduleRoot, { recursive: true, force: true });
      const basisModule = path.join(fixture.integration, 'vendor/dependency');
      git(basisModule, 'worktree', 'add', '--detach', '-q', moduleRoot, fixture.dependencyA);
    }
    assert.equal(git(moduleRoot, 'rev-parse', 'HEAD'), fixture.dependencyA);
  }
  assert.equal(git(correctionRoot, 'rev-parse', 'HEAD'), prepared.result.start_commit);
  assert.equal(git(correctionRoot, 'symbolic-ref', '--short', 'HEAD'), prepared.result.branch);
  return correctionRoot;
}

function correctionStart(fixture, prepared, correctionRoot, expectedRecordHash = prepared.hash) {
  const start = requireFunction('startIntegrationCorrection');
  return start(fixture.recordFile, {
    expectedRecordHash,
    token: prepared.result.token,
    builder: 'correction-builder',
    correctionRoot,
  }, correctionRoot);
}

function immutableBefore(fixture) {
  return {
    sourceRun: fs.readFileSync(fixture.runFile, 'utf8'),
    sourceStory: fs.readFileSync(path.join(fixture.root, storyRel), 'utf8'),
    record: fs.readFileSync(fixture.recordFile, 'utf8'),
    refs: git(fixture.integration, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'),
  };
}

function assertImmutableBefore(fixture, before) {
  assert.equal(fs.readFileSync(fixture.runFile, 'utf8'), before.sourceRun);
  assert.equal(fs.readFileSync(path.join(fixture.root, storyRel), 'utf8'), before.sourceStory);
  assert.equal(fs.readFileSync(fixture.recordFile, 'utf8'), before.record);
  assert.equal(git(fixture.integration, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'), before.refs);
}

function advanceCorrectionToReview(fixture, prepared, correctionRoot) {
  const runId = prepared.result.run_id;
  const pm = (...args) => call(correctionRoot, pmCli, ...args);
  const run = (...args) => call(correctionRoot, runtime, ...args);
  write(correctionRoot, 'src/value.txt', 'corrected candidate value\n');
  for (const status of ['built', 'in-review']) {
    const transitioned = pm('transition', '--run', runId, '--to', status);
    assert.equal(transitioned.status, 0, transitioned.stdout);
  }
  const commitPreparation = run('commit-prepare', '--run', runId);
  assert.equal(commitPreparation.status, 0, commitPreparation.stdout);
  git(correctionRoot, 'add', '-A', '--', ...commitPreparation.json.preparation.paths);
  git(correctionRoot, 'commit', '-qm', 'Correct complete original task');
  assert.equal(run('commit-adopt', '--run', runId, '--token', commitPreparation.json.preparation.token,
    '--commit', git(correctionRoot, 'rev-parse', 'HEAD')).status, 0);
  const checked = run('check', '--run', runId);
  assert.equal(checked.status, 0, checked.stdout);
  assert.equal(run('gate', '--run', runId, '--name', 'test', '--command', gateCommand).status, 0);
  return { run, runId, runFile: path.join(correctionRoot, '.deliver/runs', `${runId}.json`), snapshot: checked.json.snapshot_hash };
}

function correctionReview(snapshot, findings) {
  const unresolved = findings.some((finding) => !finding.resolved);
  return {
    status: 'PASS', findings: [], panel: {
      snapshot_hash: snapshot,
      members: [{
        lens: 'code-integrity-reviewer', reviewer: 'correction-panel-reviewer',
        verdict: unresolved ? 'CONCERNS' : 'PASS', snapshot_hash: snapshot, findings,
      }],
    },
  };
}

function finishFirstCorrection(t) {
  const fixture = makeActualNoM(t);
  const prepared = correctionPrepare(fixture);
  const correctionRoot = addCorrectionWorktree(t, fixture, prepared);
  correctionStart(fixture, prepared, correctionRoot);
  const active = advanceCorrectionToReview(fixture, prepared, correctionRoot);
  const resolved = fixture.inherited.map((finding) => ({ ...finding, resolved: true }));
  write(correctionRoot, '.deliver/correction-review.json', correctionReview(active.snapshot, resolved));
  assert.equal(active.run('review', '--run', active.runId, '--snapshot', active.snapshot,
    '--reviewer', 'correction-reviewer', '--receipt', '.deliver/correction-review.json').status, 0);
  write(correctionRoot, '.deliver/correction-verification.json', {
    criteria: [{ id: 'AC-1', status: 'PASS', evidence: 'Fresh generation-one correction evidence.' }],
  });
  assert.equal(active.run('verify', '--run', active.runId, '--snapshot', active.snapshot,
    '--verifier', 'correction-verifier', '--results', '.deliver/correction-verification.json').status, 0);
  assert.equal(active.run('finish', '--run', active.runId).status, 0);
  return { fixture, prepared, correctionRoot, runFile: active.runFile, candidate: git(correctionRoot, 'rev-parse', 'HEAD') };
}

function failNextIntegration(first) {
  const prepared = first.fixture.pm('integrate-prepare', '--run', first.runFile);
  assert.equal(prepared.status, 0, prepared.stdout);
  git(first.fixture.integration, 'merge', '--no-ff', '--no-edit', first.candidate);
  const merge = git(first.fixture.integration, 'rev-parse', 'HEAD');
  const adopted = first.fixture.pm('integrate-adopt', '--integration', prepared.json.file,
    '--expected-record', prepared.json.hash, '--token', prepared.json.record.integration.token, '--commit', merge);
  assert.equal(adopted.status, 0, adopted.stdout);
  write(first.fixture.integration, '.deliver/fail-integration', 'fail the generation-two integration gate\n');
  const failed = first.fixture.pm('integrate-gate', '--integration', prepared.json.file,
    '--expected-record', adopted.json.hash, '--name', 'test');
  assert.equal(failed.status, 0, failed.stdout);
  assert.equal(failed.json.result.status, 'FAIL');
  fs.unlinkSync(path.join(first.fixture.integration, '.deliver/fail-integration'));
  return {
    ...first.fixture, runFile: first.runFile, recordFile: failed.json.file,
    record: failed.json.record, recordHash: failed.json.hash, startCommit: merge,
  };
}

function interruptedStart(t, boundary, {
  protectedConfig = null, worktreeConfig = null,
} = {}) {
  const fixture = makeActualNoM(t, {
    before: 'older',
    protectCodexConfig: protectedConfig !== null,
    enableWorktreeConfig: worktreeConfig !== null,
    basisProtectedConfig: protectedConfig,
    basisWorktreeConfig: worktreeConfig,
  });
  const prepared = correctionPrepare(fixture);
  const correctionRoot = addCorrectionWorktree(t, fixture, prepared);
  const protectedConfigFile = protectedConfig === null
    ? null
    : write(correctionRoot, '.codex/config.toml', protectedConfig);
  if (protectedConfigFile) {
    assert.equal(git(correctionRoot, 'check-ignore', '--', '.codex/config.toml'), '.codex/config.toml');
  }
  if (worktreeConfig !== null) {
    git(correctionRoot, 'config', '--worktree', 'deliver.protectedProbe', worktreeConfig);
  }
  const journal = path.join(correctionRoot, '.deliver/integration-correction-transaction.json');
  const runFile = path.join(correctionRoot, '.deliver/runs', `${prepared.result.run_id}.json`);
  const storyFile = path.join(correctionRoot, storyRel);
  const originalRename = fs.renameSync;
  let interrupted = false;
  fs.renameSync = function interceptRename(source, destination) {
    const result = originalRename.call(this, source, destination);
    const target = path.resolve(String(destination));
    let hit = false;
    if (boundary === 'journal') hit = target === journal;
    if (boundary === 'run') hit = target === runFile;
    if (boundary === 'story') hit = target === storyFile && readStory(correctionRoot, storyRel).execution?.status === 'building';
    if (['starting-record', 'started-record'].includes(boundary) && target === fixture.recordFile) {
      hit = readJson(fixture.recordFile).correction?.status === boundary.replace('-record', '');
    }
    if (hit && !interrupted) {
      interrupted = true;
      throw new Error(`simulated interruption after ${boundary}`);
    }
    return result;
  };
  try {
    assert.throws(() => correctionStart(fixture, prepared, correctionRoot), new RegExp(`simulated interruption after ${boundary}`));
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(interrupted, true, `start must publish observable ${boundary} boundary`);
  return { fixture, prepared, correctionRoot, journal, runFile, storyFile, protectedConfigFile };
}

function registerCorrectionCoreTests() {
test('correction preparation binds only an actual failed M and keeps the immutable approved lineage', (t) => {
  const fixture = makeActualFailedM(t);
  const before = immutableBefore(fixture);
  const prepared = correctionPrepare(fixture);

  assert.equal(prepared.result.basis, 'failed-integration');
  assert.equal(prepared.result.start_commit, fixture.startCommit);
  assert.match(prepared.result.token, /^[0-9a-f-]{36}$/);
  assert.match(prepared.result.run_id, /^[0-9a-f-]{36}$/);
  assert.match(prepared.result.branch, /^pm\/S1-1-integration-fix-1$/);
  assert.equal(prepared.record.correction.status, 'prepared');
  assert.equal(prepared.record.correction.token.id, prepared.result.token);
  assert.match(prepared.record.correction.token.identity, /^[0-9a-f]{64}$/);
  assert.equal(prepared.record.correction.token.basis.kind, 'failed-integration');
  assert.equal(prepared.record.correction.token.basis.start_commit, fixture.startCommit);
  assert.equal(prepared.record.correction.token.basis.integration_commit, fixture.startCommit);
  assert.deepEqual(prepared.record.correction.token.original_packet, fixture.packet);
  assert.equal(prepared.record.correction.token.original_source_run, fixture.runId);
  assert.equal(prepared.record.correction.token.original_source_commit, fixture.candidate);
  assert.equal(prepared.record.correction.token.story_contract_hash, fixture.sourceState.pm_binding.contract_hash);
  assert.equal(prepared.record.correction.token.plan_digest, fixture.sourceState.pm_binding.plan_digest);
  assert.equal(prepared.record.correction.token.root_review_lineage.required_resolutions.length, 3);
  assert.deepEqual(
    prepared.record.correction.token.root_review_lineage.required_resolutions.map(({ severity, message, path }) => ({ severity, message, path })),
    fixture.inherited.map(({ severity, message, path }) => ({ severity, message, path })),
  );
  assert.deepEqual(readJson(fixture.runFile), fixture.sourceState, 'finished source run remains byte-for-byte semantic history');
  assert.equal(fs.readFileSync(path.join(fixture.root, storyRel), 'utf8'), before.sourceStory);

  const token = canonical(prepared.record.correction.token);
  assert.throws(() => correctionPrepare({ ...fixture, recordHash: fixture.recordHash }), /stale|hash|correction|pending|prepared/i);
  const current = readJson(fixture.recordFile);
  assert.equal(canonical(current.correction.token), token, 'a second preparation cannot allocate or rewrite the token');
});

test('correction preparation binds a real no-M conflict for both nullable and older I before-images', async (t) => {
  for (const beforeKind of ['unclaimed', 'older']) {
    await t.test(beforeKind, () => {
      const fixture = makeActualNoM(t, { before: beforeKind });
      const prepared = correctionPrepare(fixture);
      const token = prepared.record.correction.token;
      assert.equal(prepared.result.basis, 'composition-conflict-no-m');
      assert.equal(prepared.result.start_commit, fixture.startCommit);
      assert.equal(token.basis.kind, 'composition-conflict-no-m');
      assert.equal(token.basis.start_commit, fixture.startCommit);
      assert.equal(Object.hasOwn(token.basis, 'integration_commit'), false, 'no-M is not represented by a null M field');
      assert.equal(token.basis.integration_ref, 'main');
      assert.equal(token.basis.integration_tip, fixture.startCommit);
      assert.deepEqual(token.basis.probe.argv.slice(-4), ['merge-tree', '--write-tree', fixture.startCommit, fixture.candidate]);
      assert.notEqual(token.basis.probe.exit, 0);
      assert.match(token.basis.probe.output_hash, /^[0-9a-f]{64}$/);
      assert.deepEqual(token.actual_start_execution, beforeKind === 'unclaimed' ? null : readStory(fixture.integration, storyRel).execution);
      assert.equal(token.counter_maxima.fixes, beforeKind === 'older' ? 2 : 1);
      assert.equal(token.counter_maxima.retries, beforeKind === 'older' ? 2 : 1);
      assert.equal(token.counter_maxima.corrections, 2);
    });
  }
});

test('preparation rejects invented failure, contract drift and exhausted MAX before correction mutation', async (t) => {
  await t.test('invented failure', () => {
    const fixture = buildFinishedSource(t);
    const prepared = fixture.pm('integrate-prepare', '--run', fixture.runFile);
    assert.equal(prepared.status, 0, prepared.stdout);
    assert.equal(prepared.json.record.integration.status, 'prepared');
    const before = immutableBefore({ ...fixture, recordFile: prepared.json.file });
    const prepare = requireFunction('prepareIntegrationCorrection');
    assert.throws(() => prepare(fixture.runFile, {
      integrationRecord: prepared.json.file, expectedRecordHash: prepared.json.hash,
    }, fixture.integration), /failed|failure|qualif|correction/i);
    assertImmutableBefore({ ...fixture, recordFile: prepared.json.file }, before);
  });

  await t.test('changed story contract', () => {
    const fixture = makeActualNoM(t);
    const recordBefore = fs.readFileSync(fixture.recordFile, 'utf8');
    fs.writeFileSync(path.join(fixture.root, storyRel),
      fs.readFileSync(path.join(fixture.root, storyRel), 'utf8').replace(criterion, `${criterion} Changed.`));
    const prepare = requireFunction('prepareIntegrationCorrection');
    assert.throws(() => prepare(fixture.runFile, {
      integrationRecord: fixture.recordFile, expectedRecordHash: fixture.recordHash,
    }, fixture.integration), /contract|story|scope|source|changed|drift/i);
    assert.equal(fs.readFileSync(fixture.recordFile, 'utf8'), recordBefore);
    assert.equal(git(fixture.integration, 'branch', '--list', 'pm/S1-1-integration-fix-*'), '');
  });

  await t.test('exhausted fixes', () => {
    const fixture = makeActualFailedM(t, { fixes: 3 });
    const before = immutableBefore(fixture);
    const prepare = requireFunction('prepareIntegrationCorrection');
    assert.throws(() => prepare(fixture.runFile, {
      integrationRecord: fixture.recordFile, expectedRecordHash: fixture.recordHash,
    }, fixture.integration), /fix|attempt|exhaust|limit|3/i);
    assertImmutableBefore(fixture, before);
  });
});

test('failed-M qualification accepts current review or verification failure and rejects invalid authority or UNKNOWN alone', async (t) => {
  await t.test('current review FAIL qualifies and retains its actor and finding origin', () => {
    const fixture = recordFailedIntegrationReview(makeAdoptedM(t));
    const prepared = correctionPrepare(fixture);
    assert.equal(prepared.result.basis, 'failed-integration');
    const required = prepared.record.correction.token.root_review_lineage.required_resolutions;
    assert.equal(required.length, 4);
    assert.equal(required.at(-1).severity, 'major');
    assert.equal(required.at(-1).message, 'Actual M needs correction.');
    assert.match(required.at(-1).receipt_identity, /^[0-9a-f]{64}$/);
    assert.equal(Number.isSafeInteger(required.at(-1).ordinal), true);
  });

  await t.test('current verification FAIL qualifies', () => {
    const fixture = recordFailedIntegrationVerification(makeAdoptedM(t));
    const prepared = correctionPrepare(fixture);
    assert.equal(prepared.result.basis, 'failed-integration');
    assert.equal(prepared.record.correction.token.basis.integration_commit, fixture.startCommit);
  });

  await t.test('UNKNOWN-only verification does not qualify', () => {
    const fixture = recordFailedIntegrationVerification(makeAdoptedM(t), 'UNKNOWN');
    const before = immutableBefore(fixture);
    const prepare = requireFunction('prepareIntegrationCorrection');
    assert.throws(() => prepare(fixture.runFile, {
      integrationRecord: fixture.recordFile, expectedRecordHash: fixture.recordHash,
    }, fixture.integration), /UNKNOWN|qualif|failure|failed/i);
    assertImmutableBefore(fixture, before);
  });

  const reviewFixture = recordFailedIntegrationReview(makeAdoptedM(t));
  const reviewRecordBytes = fs.readFileSync(reviewFixture.recordFile, 'utf8');
  const reviewIntegrity = fixtureIntegrity(reviewFixture);
  for (const [label, mutate, expected] of [
    ['invalid reviewer identity', (record) => { record.evidence.review.reviewer = 'not valid'; },
      /actor|reviewer|builder|identity|invalid|differ/i],
    ['reviewer equals builder', (record) => { record.evidence.review.reviewer = record.source.builder; },
      /actor|reviewer|builder|identity|invalid|differ/i],
    ['panel reviewer equals builder', (record) => { record.evidence.review.panel.members[0].reviewer = record.source.builder; },
      /actor|reviewer|builder|identity|invalid|differ/i],
    ['stale review snapshot cannot qualify', (record) => {
      record.evidence.review.snapshot_hash = '0'.repeat(64);
      record.evidence.review.panel.snapshot_hash = '0'.repeat(64);
      for (const member of record.evidence.review.panel.members) member.snapshot_hash = '0'.repeat(64);
    }, /snapshot|stale|review|identity|current/i],
  ]) {
    await t.test(label, () => {
      const changed = structuredClone(reviewFixture.record);
      mutate(changed);
      changed.evidence.review = reidentify(changed.evidence.review);
      writeRecord(reviewFixture, changed);
      const before = immutableBefore(reviewFixture);
      const prepare = requireFunction('prepareIntegrationCorrection');
      try {
        assert.throws(() => prepare(reviewFixture.runFile, {
          integrationRecord: reviewFixture.recordFile, expectedRecordHash: reviewFixture.recordHash,
        }, reviewFixture.integration), expected);
        assertImmutableBefore(reviewFixture, before);
      } finally {
        restoreRecordBytes(reviewFixture, reviewRecordBytes);
        assert.deepEqual(fixtureIntegrity(reviewFixture), reviewIntegrity,
          `${label} must restore the shared failed-review fixture exactly`);
      }
    });
  }

  const verificationFixture = recordFailedIntegrationVerification(makeAdoptedM(t));
  const verificationRecordBytes = fs.readFileSync(verificationFixture.recordFile, 'utf8');
  const verificationIntegrity = fixtureIntegrity(verificationFixture);
  for (const [label, mutate, expected] of [
    ['verifier equals builder', (record) => { record.evidence.verification.verifier = 'source-builder'; },
      /actor|verifier|builder|reviewer|identity|invalid|differ/i],
    ['verifier equals reviewer', (record) => { record.evidence.verification.verifier = 'source-reviewer'; },
      /actor|verifier|builder|reviewer|identity|invalid|differ/i],
    ['verifier equals panel member', (record) => { record.evidence.verification.verifier = 'source-panel-reviewer'; },
      /actor|verifier|builder|reviewer|identity|invalid|differ/i],
    ['invalid verifier identity', (record) => { record.evidence.verification.verifier = 'not valid'; },
      /actor|verifier|builder|reviewer|identity|invalid|differ/i],
    ['malformed FAIL criteria cannot qualify', (record) => {
      record.evidence.verification.criteria[0].id = 'AC-not-in-the-task';
    }, /criterion|criteria|verification|acceptance|invalid/i],
  ]) {
    await t.test(label, () => {
      const changed = structuredClone(verificationFixture.record);
      mutate(changed);
      changed.evidence.verification = reidentify(changed.evidence.verification);
      writeRecord(verificationFixture, changed);
      const before = immutableBefore(verificationFixture);
      const prepare = requireFunction('prepareIntegrationCorrection');
      try {
        assert.throws(() => prepare(verificationFixture.runFile, {
          integrationRecord: verificationFixture.recordFile, expectedRecordHash: verificationFixture.recordHash,
        }, verificationFixture.integration), expected);
        assertImmutableBefore(verificationFixture, before);
      } finally {
        restoreRecordBytes(verificationFixture, verificationRecordBytes);
        assert.deepEqual(fixtureIntegrity(verificationFixture), verificationIntegrity,
          `${label} must restore the shared failed-verification fixture exactly`);
      }
    });
  }

  await t.test('superseded review FAIL does not qualify', () => {
    const fixture = recordFailedIntegrationReview(makeAdoptedM(t));
    write(fixture.integration, '.deliver/passing-integration-review.json', {
      status: 'PASS', findings: [], panel: {
        snapshot_hash: fixture.record.evidence.snapshot_hash,
        members: [{ lens: 'code-integrity-reviewer', reviewer: 'new-panel-reviewer', verdict: 'PASS',
          snapshot_hash: fixture.record.evidence.snapshot_hash, findings: [] }],
      },
    });
    const passed = fixture.pm('integrate-review', '--integration', fixture.recordFile,
      '--expected-record', fixture.recordHash, '--reviewer', 'new-reviewer',
      '--receipt', '.deliver/passing-integration-review.json');
    assert.equal(passed.status, 0, passed.stdout);
    fixture.record = passed.json.record;
    fixture.recordHash = passed.json.hash;
    assert.equal(fixture.record.evidence.review.status, 'PASS');
    assert.equal(fixture.record.evidence.review_history.at(-1).status, 'FAIL');
    const before = immutableBefore(fixture);
    const prepare = requireFunction('prepareIntegrationCorrection');
    assert.throws(() => prepare(fixture.runFile, {
      integrationRecord: fixture.recordFile, expectedRecordHash: fixture.recordHash,
    }, fixture.integration), /current|superseded|qualif|failure|failed/i);
    assertImmutableBefore(fixture, before);
  });
});

test('correction start publishes the exact legal run/story pair and requires fresh complete evidence', async (t) => {
  for (const basis of ['failed-integration', 'composition-conflict-no-m']) {
    await t.test(basis, () => {
      const fixture = basis === 'failed-integration' ? makeActualFailedM(t) : makeActualNoM(t, { before: 'older' });
      const prepared = correctionPrepare(fixture);
      const preparedToken = canonical(prepared.record.correction.token);
      const correctionRoot = addCorrectionWorktree(t, fixture, prepared);
      const actualBefore = readStory(correctionRoot, storyRel).execution;
      const summary = correctionStart(fixture, prepared, correctionRoot);

      assert.equal(summary.run_id, prepared.result.run_id);
      assert.equal(summary.phase, 'active');
      assert.equal(Number.isSafeInteger(summary.revision), true);
      const startedRecord = readJson(fixture.recordFile);
      assert.equal(startedRecord.correction.status, 'started');
      assert.equal(canonical(startedRecord.correction.token), preparedToken);
      const correctionRunFile = path.join(correctionRoot, '.deliver/runs', `${prepared.result.run_id}.json`);
      const correctionRun = readJson(correctionRunFile);
      const correctionStory = readStory(correctionRoot, storyRel);
      assert.equal(correctionRun.phase, 'active');
      assert.equal(correctionRun.run_id, prepared.result.run_id);
      assert.equal(correctionRun.project_root, fs.realpathSync(correctionRoot));
      assert.deepEqual(correctionRun.task.packet, fixture.packet, 'correction gets the exact full original packet');
      assert.equal(correctionRun.task.builder, 'correction-builder');
      assert.equal(correctionRun.git_anchor.head, fixture.startCommit, 'operational Git anchor begins at actual I or M');
      assert.equal(correctionRun.pm_binding.branch, prepared.result.branch);
      assert.equal(correctionStory.execution.branch, prepared.result.branch);
      assert.equal(correctionStory.execution.status, 'building');
      assert.equal(correctionStory.execution.owner, fixture.sourceState.pm_binding.actor);
      assert.equal(correctionStory.execution.builder, fixture.sourceState.pm_binding.builder);
      assert.equal(correctionStory.execution.rounds, basis === 'composition-conflict-no-m' ? 3 : 2);
      assert.equal(correctionStory.execution.retries, basis === 'composition-conflict-no-m' ? 2 : 1);
      assert.deepEqual(correctionRun.counters, {
        retries: basis === 'composition-conflict-no-m' ? 2 : 1,
        fixes: basis === 'composition-conflict-no-m' ? 3 : 2,
        corrections: 2,
      });
      assert.equal(correctionRun.correction.token_identity, prepared.record.correction.token.identity);
      assert.equal(correctionRun.correction.basis, basis);
      assert.deepEqual(correctionRun.correction.root_review_lineage.required_resolutions,
        prepared.record.correction.token.root_review_lineage.required_resolutions);
      const startAudit = correctionRun.events.find((event) => event.type === 'integration_correction_start');
      assert.ok(startAudit, 'correction run retains a typed start audit');
      assert.deepEqual(startAudit.from, actualBefore, 'start audit records the actual nullable or older before-image');

      write(correctionRoot, 'src/value.txt', 'corrected candidate value\n');
      const pm = (...args) => call(correctionRoot, pmCli, ...args);
      const run = (...args) => call(correctionRoot, runtime, ...args);
      for (const status of ['built', 'in-review']) {
        const transitioned = pm('transition', '--run', prepared.result.run_id, '--to', status);
        assert.equal(transitioned.status, 0, transitioned.stdout);
      }
      const commitPreparation = run('commit-prepare', '--run', prepared.result.run_id);
      assert.equal(commitPreparation.status, 0, commitPreparation.stdout);
      git(correctionRoot, 'add', '-A', '--', ...commitPreparation.json.preparation.paths);
      git(correctionRoot, 'commit', '-qm', 'Correct complete original task');
      const correctedCandidate = git(correctionRoot, 'rev-parse', 'HEAD');
      assert.equal(run('commit-adopt', '--run', prepared.result.run_id, '--token', commitPreparation.json.preparation.token,
        '--commit', correctedCandidate).status, 0);
      const checked = run('check', '--run', prepared.result.run_id);
      assert.equal(checked.status, 0, checked.stdout);
      assert.equal(run('gate', '--run', prepared.result.run_id, '--name', 'test', '--command', gateCommand).status, 0);

      const resolved = fixture.inherited.map((finding) => ({ ...finding, resolved: true }));
      write(correctionRoot, '.deliver/correction-review.json', {
        status: 'PASS', findings: [], panel: {
          snapshot_hash: checked.json.snapshot_hash,
          members: [{ lens: 'code-integrity-reviewer', reviewer: 'correction-panel-reviewer', verdict: 'PASS',
            snapshot_hash: checked.json.snapshot_hash, findings: resolved }],
        },
      });
      const reviewed = run('review', '--run', prepared.result.run_id, '--snapshot', checked.json.snapshot_hash,
        '--reviewer', 'correction-reviewer', '--receipt', '.deliver/correction-review.json');
      assert.equal(reviewed.status, 0, reviewed.stdout);
      write(correctionRoot, '.deliver/correction-verification.json', {
        criteria: [{ id: 'AC-1', status: 'PASS', evidence: 'Fresh correction gate and full-task review passed.' }],
      });
      for (const forbidden of ['correction-builder', 'correction-reviewer', 'correction-panel-reviewer']) {
        const refused = run('verify', '--run', prepared.result.run_id, '--snapshot', checked.json.snapshot_hash,
          '--verifier', forbidden, '--results', '.deliver/correction-verification.json');
        assert.notEqual(refused.status, 0, `verifier ${forbidden} must remain separate`);
      }
      const verified = run('verify', '--run', prepared.result.run_id, '--snapshot', checked.json.snapshot_hash,
        '--verifier', 'correction-verifier', '--results', '.deliver/correction-verification.json');
      assert.equal(verified.status, 0, verified.stdout);
      assert.equal(run('finish', '--run', prepared.result.run_id).status, 0);
      assert.equal(readJson(correctionRunFile).phase, 'finished');
      assert.equal(readJson(fixture.runFile).phase, 'finished', 'original C remains finished');
    });
  }
});

test('fresh correction review must resolve the inherited finding multiset exactly', (t) => {
  const fixture = makeActualNoM(t);
  const prepared = correctionPrepare(fixture);
  const correctionRoot = addCorrectionWorktree(t, fixture, prepared);
  correctionStart(fixture, prepared, correctionRoot);
  const active = advanceCorrectionToReview(fixture, prepared, correctionRoot);
  const resolved = fixture.inherited.map((finding) => ({ ...finding, resolved: true }));
  const variants = [
    ['omitted duplicate', [resolved[0], resolved[2]]],
    ['extra duplicate', [resolved[0], resolved[0], resolved[1], resolved[2]]],
    ['wrong path', resolved.map((finding, index) => index === 2 ? { ...finding, path: 'src/value.txt' } : finding)],
    ['open inherited minor', resolved.map((finding, index) => index === 2 ? { ...finding, resolved: false } : finding)],
  ];
  for (const [label, findings] of variants) {
    write(correctionRoot, '.deliver/correction-review.json', correctionReview(active.snapshot, findings));
    const before = fs.readFileSync(active.runFile, 'utf8');
    const refused = active.run('review', '--run', active.runId, '--snapshot', active.snapshot,
      '--reviewer', 'correction-reviewer', '--receipt', '.deliver/correction-review.json');
    assert.notEqual(refused.status, 0, label);
    assert.match(refused.stdout, /inherited|required|resolution|finding|multiplicity|path/i, label);
    assert.equal(fs.readFileSync(active.runFile, 'utf8'), before, `${label} must not publish a review`);
  }
  write(correctionRoot, '.deliver/correction-review.json', correctionReview(active.snapshot, resolved));
  const accepted = active.run('review', '--run', active.runId, '--snapshot', active.snapshot,
    '--reviewer', 'correction-reviewer', '--receipt', '.deliver/correction-review.json');
  assert.equal(accepted.status, 0, accepted.stdout);
});

test('a genuine prior correction remains in root lineage and cannot hide MAX attempts behind a new generation', (t) => {
  const first = finishFirstCorrection(t);
  const next = failNextIntegration(first);
  const prepared = correctionPrepare(next);
  assert.equal(prepared.result.branch, 'pm/S1-1-integration-fix-2');
  assert.equal(prepared.record.correction.token.generation, 2);
  assert.equal(prepared.record.correction.token.original_root_run, first.fixture.runId);
  assert.equal(prepared.record.correction.token.original_source_run, first.prepared.result.run_id);
  assert.equal(prepared.record.correction.token.counter_maxima.fixes, 2);
  assert.equal(prepared.record.correction.token.counter_maxima.retries, 1);
  assert.equal(prepared.record.correction.token.counter_maxima.corrections, 2);
  const sources = prepared.record.correction.token.counter_sources;
  assert.equal(Array.isArray(sources), true);
  assert.equal(sources.some((source) => source.run_id === first.fixture.runId), true);
  assert.equal(sources.some((source) => source.run_id === first.prepared.result.run_id), true);
  assert.equal(sources.every((source) => /^[0-9a-f]{64}$/.test(source.identity)), true);
  assert.deepEqual(sources, [...sources].sort((left, right) => canonical(left).localeCompare(canonical(right))),
    'counter sources have one deterministic sorted order');

  const correctionRoot = addCorrectionWorktree(t, next, prepared);
  const ancestor = readJson(first.runFile);
  ancestor.counters.fixes = 3;
  fs.writeFileSync(first.runFile, `${JSON.stringify(ancestor, null, 2)}\n`);
  const recordBefore = fs.readFileSync(next.recordFile, 'utf8');
  const storyBefore = fs.readFileSync(path.join(correctionRoot, storyRel), 'utf8');
  assert.throws(() => correctionStart(next, prepared, correctionRoot), /counter|source|identity|changed|fix|exhaust|3/i);
  assert.equal(fs.readFileSync(next.recordFile, 'utf8'), recordBefore);
  assert.equal(fs.readFileSync(path.join(correctionRoot, storyRel), 'utf8'), storyBefore);
  assert.equal(fs.existsSync(path.join(correctionRoot, '.deliver/runs', `${prepared.result.run_id}.json`)), false);
});

test('correction start rejects dirty, moved and duplicate checkouts without consuming its token', async (t) => {
  await t.test('dirty exact branch', () => {
    const fixture = makeActualNoM(t);
    const prepared = correctionPrepare(fixture);
    const correctionRoot = addCorrectionWorktree(t, fixture, prepared);
    write(correctionRoot, 'src/untracked.txt', 'dirty\n');
    const recordBefore = fs.readFileSync(fixture.recordFile, 'utf8');
    assert.throws(() => correctionStart(fixture, prepared, correctionRoot), /clean|uncommitted|untracked/i);
    assert.equal(fs.readFileSync(fixture.recordFile, 'utf8'), recordBefore);
    assert.equal(fs.existsSync(path.join(correctionRoot, '.deliver/runs', `${prepared.result.run_id}.json`)), false);
  });

  await t.test('moved branch', () => {
    const fixture = makeActualFailedM(t);
    const prepared = correctionPrepare(fixture);
    const correctionRoot = addCorrectionWorktree(t, fixture, prepared);
    write(correctionRoot, 'unrelated.txt', 'moved\n');
    git(correctionRoot, 'add', 'unrelated.txt');
    git(correctionRoot, 'commit', '-qm', 'Move correction branch');
    const recordBefore = fs.readFileSync(fixture.recordFile, 'utf8');
    assert.throws(() => correctionStart(fixture, prepared, correctionRoot), /exact|commit|branch|ref|start/i);
    assert.equal(fs.readFileSync(fixture.recordFile, 'utf8'), recordBefore);
  });

  await t.test('second checkout attached to the same correction ref', () => {
    const fixture = makeActualNoM(t);
    const prepared = correctionPrepare(fixture);
    const correctionRoot = addCorrectionWorktree(t, fixture, prepared);
    const duplicate = `${correctionRoot}-duplicate`;
    t.after(() => fs.rmSync(duplicate, { recursive: true, force: true }));
    git(fixture.integration, 'worktree', 'add', '--detach', '-q', duplicate, prepared.result.start_commit);
    git(duplicate, 'symbolic-ref', 'HEAD', `refs/heads/${prepared.result.branch}`);
    const attached = git(fixture.integration, 'worktree', 'list', '--porcelain')
      .split(/\r?\n/).filter((line) => line === `branch refs/heads/${prepared.result.branch}`);
    assert.equal(attached.length, 2, 'fixture attaches the exact unique correction ref twice');
    const recordBefore = fs.readFileSync(fixture.recordFile, 'utf8');
    assert.throws(() => correctionStart(fixture, prepared, correctionRoot), /sole|worktree|duplicate|attached/i);
    assert.equal(fs.readFileSync(fixture.recordFile, 'utf8'), recordBefore);
  });

  await t.test('unrelated active same-story branch and worktree', () => {
    const fixture = makeActualNoM(t);
    const prepared = correctionPrepare(fixture);
    const correctionRoot = addCorrectionWorktree(t, fixture, prepared);
    const duplicate = `${correctionRoot}-same-story`;
    t.after(() => fs.rmSync(duplicate, { recursive: true, force: true }));
    git(fixture.integration, 'worktree', 'add', '-qb', 'pm/S1-1-unrelated', duplicate, prepared.result.start_commit);
    const document = readStory(duplicate, storyRel);
    const sourceExecution = readStory(fixture.root, storyRel).execution;
    fs.writeFileSync(path.join(duplicate, storyRel), replaceStoryExecution(document, {
      ...sourceExecution, branch: 'pm/S1-1-unrelated', status: 'building', updated: '2026-09-10 13:00',
    }).after);
    git(duplicate, 'add', storyRel);
    git(duplicate, 'commit', '-qm', 'Actual duplicate same-story work');
    const recordBefore = fs.readFileSync(fixture.recordFile, 'utf8');
    const storyBefore = fs.readFileSync(path.join(correctionRoot, storyRel), 'utf8');
    assert.throws(() => correctionStart(fixture, prepared, correctionRoot), /same.story|duplicate|active|unrelated/i);
    assert.equal(fs.readFileSync(fixture.recordFile, 'utf8'), recordBefore);
    assert.equal(fs.readFileSync(path.join(correctionRoot, storyRel), 'utf8'), storyBefore);
  });

  await t.test('same-owner active other-story worktree', () => {
    const fixture = makeActualNoM(t);
    const prepared = correctionPrepare(fixture);
    const correctionRoot = addCorrectionWorktree(t, fixture, prepared);
    const other = `${correctionRoot}-other-story`;
    t.after(() => fs.rmSync(other, { recursive: true, force: true }));
    git(fixture.integration, 'worktree', 'add', '-qb', 'pm/S1-2-other', other, prepared.result.start_commit);
    const sourceExecution = readStory(fixture.root, storyRel).execution;
    const otherStory = story().replaceAll('S1-1', 'S1-2').replace('Correct value', 'Other active work');
    write(other, 'docs/stories/S1-2-other.md', `${otherStory}\n## Execution\n<!-- pm-exec: ${JSON.stringify({
      owner: sourceExecution.owner, builder: sourceExecution.builder, branch: 'pm/S1-2-other',
      status: 'building', rounds: 0, retries: 0, updated: '2026-09-10 13:00',
    })} -->\n`);
    git(other, 'add', 'docs/stories/S1-2-other.md');
    git(other, 'commit', '-qm', 'Actual same-owner other-story work');
    const recordBefore = fs.readFileSync(fixture.recordFile, 'utf8');
    assert.throws(() => correctionStart(fixture, prepared, correctionRoot), /^PARALLEL_BATCH_REQUIRED:|parallel|other.story|same.owner/i);
    assert.equal(fs.readFileSync(fixture.recordFile, 'utf8'), recordBefore);
  });
});

test('correction preparation rejects foreign, merged and conflicting no-M I Execution states', async (t) => {
  const sourceOwner = 'casey-example-invalid-990545ea8d20';
  for (const [label, executionOverrides] of [
    ['foreign owner', { owner: 'foreign-actor' }],
    ['merged state', { status: 'merged' }],
    ['conflicting unknown metadata', { retained_unknown: 'different-I-value' }],
  ]) {
    await t.test(label, () => {
      const fixture = makeActualNoM(t, { before: 'older', executionOverrides });
      if (label === 'foreign owner') assert.notEqual(readStory(fixture.integration, storyRel).execution.owner, sourceOwner);
      const before = immutableBefore(fixture);
      const prepare = requireFunction('prepareIntegrationCorrection');
      assert.throws(() => prepare(fixture.runFile, {
        integrationRecord: fixture.recordFile, expectedRecordHash: fixture.recordHash,
      }, fixture.integration), /foreign|merged|owner|unknown|conflict|Execution|state/i);
      assertImmutableBefore(fixture, before);
    });
  }
});

test('correction start revalidates approval, plan and no-M probe identities before publication', async (t) => {
  const fixture = makeActualNoM(t);
  const prepared = correctionPrepare(fixture);
  const correctionRoot = addCorrectionWorktree(t, fixture, prepared);
  const stableIntegrity = fixtureIntegrity(fixture);
  for (const [label, file, suffix, expected] of [
    ['approval drift', path.join(fixture.root, 'docs/approval.json'), ' ', /approval|changed|drift|source/i],
    ['plan drift', path.join(fixture.root, 'docs/plan.md'), '\nchanged\n', /plan|approval|changed|drift|source/i],
    ['probe log drift', path.join(fixture.integration, fixture.record.integration.failure.log_path), 'changed',
      /probe|log|hash|changed|drift/i],
  ]) {
    await t.test(label, () => {
      const original = fs.readFileSync(file);
      fs.appendFileSync(file, suffix);
      const recordBefore = fs.readFileSync(fixture.recordFile, 'utf8');
      const storyBefore = fs.readFileSync(path.join(correctionRoot, storyRel), 'utf8');
      try {
        assert.throws(() => correctionStart(fixture, prepared, correctionRoot), expected);
        assert.equal(fs.readFileSync(fixture.recordFile, 'utf8'), recordBefore);
        assert.equal(fs.readFileSync(path.join(correctionRoot, storyRel), 'utf8'), storyBefore);
        assert.equal(fs.existsSync(path.join(correctionRoot, '.deliver/runs', `${prepared.result.run_id}.json`)), false);
      } finally {
        fs.writeFileSync(file, original);
        assert.equal(fs.readFileSync(file).equals(original), true, `${label} must restore exact bytes`);
        assert.deepEqual(fixtureIntegrity(fixture), stableIntegrity,
          `${label} must restore the shared no-M fixture exactly`);
      }
    });
  }
});

test('dedicated correction journal recovers every torn run/story publication and rejects tampering', async (t) => {
  const recover = requireFunction('recoverIntegrationCorrectionStart');
  for (const boundary of ['starting-record', 'journal', 'run', 'story', 'started-record']) {
    await t.test(`recover after ${boundary}`, () => {
      const torn = interruptedStart(t, boundary);
      const live = readJson(torn.fixture.recordFile);
      if (boundary === 'starting-record') {
        assert.equal(fs.existsSync(torn.journal), false);
        const retried = correctionStart(torn.fixture, torn.prepared, torn.correctionRoot, torn.prepared.hash);
        assert.equal(retried.run_id, torn.prepared.result.run_id);
      } else {
        if (boundary !== 'started-record') assert.equal(fs.existsSync(torn.journal), true);
        const result = recover(torn.correctionRoot);
        assert.equal(result.recovered, true);
      }
      const completed = readJson(torn.fixture.recordFile);
      assert.equal(completed.correction.status, 'started');
      assert.equal(completed.correction.token.identity, torn.prepared.record.correction.token.identity);
      assert.equal(readJson(torn.runFile).run_id, torn.prepared.result.run_id);
      assert.equal(readStory(torn.correctionRoot, storyRel).execution.status, 'building');
      assert.equal(fs.existsSync(torn.journal), false);
      if (live.correction.status === 'starting') {
        assert.equal(Object.hasOwn(live.correction, 'expected_starting_record_hash'), false,
          'starting record must not store or hash itself');
      }
    });
  }

  await t.test('semantic journal tampering and coexistence refuse unchanged', () => {
    const torn = interruptedStart(t, 'journal');
    const wrapper = readJson(torn.journal);
    assert.equal(wrapper.descriptor.kind, 'integration-correction-start-v1');
    assert.equal(wrapper.descriptor.token_id, torn.prepared.result.token);
    assert.equal(wrapper.descriptor.run_id, torn.prepared.result.run_id);
    assert.equal(wrapper.descriptor.branch, torn.prepared.result.branch);
    assert.deepEqual(wrapper.descriptor.writes.map((item) => item.path), [
      `.deliver/runs/${torn.prepared.result.run_id}.json`, storyRel,
    ]);
    assert.equal(wrapper.descriptor_identity, sha256(canonical(wrapper.descriptor)));
    assert.match(wrapper.expected_starting_record_hash, /^[0-9a-f]{64}$/);
    assert.equal(wrapper.descriptor.writes[0].before, null);
    const exactStoryBefore = readStory(torn.correctionRoot, storyRel).text;
    assert.equal(wrapper.descriptor.writes[1].before, exactStoryBefore);

    const changed = structuredClone(wrapper);
    changed.descriptor.writes[1].after = changed.descriptor.writes[1].after.replace('"status":"building"', '"status":"built"');
    changed.descriptor_identity = sha256(canonical(changed.descriptor));
    fs.writeFileSync(torn.journal, `${JSON.stringify(changed, null, 2)}\n`);
    const before = {
      record: fs.readFileSync(torn.fixture.recordFile, 'utf8'),
      run: fs.existsSync(torn.runFile) ? fs.readFileSync(torn.runFile, 'utf8') : null,
      story: fs.readFileSync(torn.storyFile, 'utf8'),
      journal: fs.readFileSync(torn.journal, 'utf8'),
    };
    assert.throws(() => recover(torn.correctionRoot), /journal|descriptor|legal|after|identity|token/i);
    assert.equal(fs.readFileSync(torn.fixture.recordFile, 'utf8'), before.record);
    assert.equal(fs.existsSync(torn.runFile) ? fs.readFileSync(torn.runFile, 'utf8') : null, before.run);
    assert.equal(fs.readFileSync(torn.storyFile, 'utf8'), before.story);
    assert.equal(fs.readFileSync(torn.journal, 'utf8'), before.journal);

    fs.writeFileSync(torn.journal, `${JSON.stringify(wrapper, null, 2)}\n`);
    write(torn.correctionRoot, '.deliver/current-pm-transaction.json', { format: 'current', writes: [] });
    const coexistingBefore = fs.readFileSync(torn.journal, 'utf8');
    assert.throws(() => recover(torn.correctionRoot), /more than one|journal|transaction/i);
    assert.equal(fs.readFileSync(torn.journal, 'utf8'), coexistingBefore);
  });
});

test('recovery rejects a fully rehashed but semantically illegal correction pair and third-state files unchanged', async (t) => {
  const recover = requireFunction('recoverIntegrationCorrectionStart');
  await t.test('self-consistent outer hashes cannot legalize a built story after-image', () => {
    const torn = interruptedStart(t, 'journal');
    const wrapper = readJson(torn.journal);
    const live = readJson(torn.fixture.recordFile);
    const changed = structuredClone(wrapper);
    const storyWrite = changed.descriptor.writes[1];
    storyWrite.after = storyWrite.after.replace('"status":"building"', '"status":"built"');
    changed.descriptor_identity = sha256(canonical(changed.descriptor));
    live.correction.starting.descriptor_identity = changed.descriptor_identity;
    live.correction.starting.reconstruction.descriptor = structuredClone(changed.descriptor);
    changed.expected_starting_record_hash = sha256(canonical(live));
    fs.writeFileSync(torn.fixture.recordFile, `${JSON.stringify(live, null, 2)}\n`);
    fs.writeFileSync(torn.journal, `${JSON.stringify(changed, null, 2)}\n`);
    const before = {
      record: fs.readFileSync(torn.fixture.recordFile, 'utf8'),
      journal: fs.readFileSync(torn.journal, 'utf8'),
      story: fs.readFileSync(torn.storyFile, 'utf8'),
    };
    assert.throws(() => recover(torn.correctionRoot), /legal|Execution|transition|descriptor|reconstruct|after/i);
    assert.equal(fs.readFileSync(torn.fixture.recordFile, 'utf8'), before.record);
    assert.equal(fs.readFileSync(torn.journal, 'utf8'), before.journal);
    assert.equal(fs.readFileSync(torn.storyFile, 'utf8'), before.story);
  });

  for (const boundary of ['journal', 'run', 'story']) {
    await t.test(`third states after ${boundary} preserve every byte`, () => {
      const torn = interruptedStart(t, boundary);
      fs.mkdirSync(path.dirname(torn.runFile), { recursive: true });
      fs.writeFileSync(torn.runFile, '{"third":"run-state"}\n');
      fs.writeFileSync(torn.storyFile, `${fs.readFileSync(torn.storyFile, 'utf8')}\nthird story state\n`);
      const before = {
        record: fs.readFileSync(torn.fixture.recordFile, 'utf8'),
        journal: fs.readFileSync(torn.journal, 'utf8'),
        run: fs.readFileSync(torn.runFile, 'utf8'),
        story: fs.readFileSync(torn.storyFile, 'utf8'),
      };
      assert.throws(() => recover(torn.correctionRoot), /conflict|third|before|after|journal|state/i);
      assert.equal(fs.readFileSync(torn.fixture.recordFile, 'utf8'), before.record);
      assert.equal(fs.readFileSync(torn.journal, 'utf8'), before.journal);
      assert.equal(fs.readFileSync(torn.runFile, 'utf8'), before.run);
      assert.equal(fs.readFileSync(torn.storyFile, 'utf8'), before.story);
    });
  }
});

test('correction recovery revalidates the exact start ref and token story target before any journal write', async (t) => {
  const recover = requireFunction('recoverIntegrationCorrectionStart');

  await t.test('clean advanced correction ref refuses the old-I journal unchanged', () => {
    const torn = interruptedStart(t, 'journal');
    write(torn.correctionRoot, 'unrelated-after-journal.txt', 'moved after journal\n');
    git(torn.correctionRoot, 'add', 'unrelated-after-journal.txt');
    git(torn.correctionRoot, 'commit', '-qm', 'Move correction ref after journal');
    const moved = git(torn.correctionRoot, 'rev-parse', 'HEAD');
    assert.notEqual(moved, torn.prepared.result.start_commit);
    assert.equal(
      git(torn.correctionRoot, 'status', '--porcelain=v1', '--untracked-files=all'),
      '?? .deliver/integration-correction-transaction.json',
    );
    const before = {
      record: fs.readFileSync(torn.fixture.recordFile, 'utf8'),
      journal: fs.readFileSync(torn.journal, 'utf8'),
      story: fs.readFileSync(torn.storyFile, 'utf8'),
      head: moved,
    };
    assert.throws(() => recover(torn.correctionRoot), /branch|ref|HEAD|commit|start|anchor|moved/i);
    assert.equal(fs.readFileSync(torn.fixture.recordFile, 'utf8'), before.record);
    assert.equal(fs.readFileSync(torn.journal, 'utf8'), before.journal);
    assert.equal(fs.readFileSync(torn.storyFile, 'utf8'), before.story);
    assert.equal(git(torn.correctionRoot, 'rev-parse', 'HEAD'), before.head);
    assert.equal(fs.existsSync(torn.runFile), false);
  });

  await t.test('fully rehashed descriptor cannot redirect the typed story write', () => {
    const torn = interruptedStart(t, 'journal');
    const wrapper = readJson(torn.journal);
    const live = readJson(torn.fixture.recordFile);
    const originalPath = wrapper.descriptor.writes[1].path;
    const shadowPath = 'docs/stories/S1-1-shadow.md';
    write(torn.correctionRoot, shadowPath, wrapper.descriptor.writes[1].before);
    wrapper.descriptor.writes[1].path = shadowPath;
    wrapper.descriptor_identity = sha256(canonical(wrapper.descriptor));
    live.correction.starting.descriptor_identity = wrapper.descriptor_identity;
    live.correction.starting.reconstruction.descriptor = structuredClone(wrapper.descriptor);
    wrapper.expected_starting_record_hash = sha256(canonical(live));
    fs.writeFileSync(torn.fixture.recordFile, `${JSON.stringify(live, null, 2)}\n`);
    fs.writeFileSync(torn.journal, `${JSON.stringify(wrapper, null, 2)}\n`);
    const before = {
      record: fs.readFileSync(torn.fixture.recordFile, 'utf8'),
      journal: fs.readFileSync(torn.journal, 'utf8'),
      original: fs.readFileSync(path.join(torn.correctionRoot, originalPath), 'utf8'),
      shadow: fs.readFileSync(path.join(torn.correctionRoot, shadowPath), 'utf8'),
    };
    assert.throws(() => recover(torn.correctionRoot), /story|path|target|token|descriptor|write/i);
    assert.equal(fs.readFileSync(torn.fixture.recordFile, 'utf8'), before.record);
    assert.equal(fs.readFileSync(torn.journal, 'utf8'), before.journal);
    assert.equal(fs.readFileSync(path.join(torn.correctionRoot, originalPath), 'utf8'), before.original);
    assert.equal(fs.readFileSync(path.join(torn.correctionRoot, shadowPath), 'utf8'), before.shadow);
    assert.equal(fs.existsSync(torn.runFile), false);
  });
});

test('unrelated Git histories are a generic merge error, not a no-M composition conflict', (t) => {
  const fixture = buildFinishedSource(t);
  const plan = fs.readFileSync(path.join(fixture.integration, 'docs/plan.md'), 'utf8');
  const approval = fs.readFileSync(path.join(fixture.integration, 'docs/approval.json'), 'utf8');
  git(fixture.integration, 'checkout', '--orphan', 'replacement-main');
  git(fixture.integration, 'rm', '-rf', '.');
  write(fixture.integration, 'docs/plan.md', plan);
  write(fixture.integration, 'docs/approval.json', approval);
  write(fixture.integration, storyRel, story());
  write(fixture.integration, 'src/value.txt', 'unrelated integration root\n');
  git(fixture.integration, 'add', 'docs', 'src');
  git(fixture.integration, 'commit', '-qm', 'Unrelated integration history');
  git(fixture.integration, 'branch', '-D', 'main');
  git(fixture.integration, 'branch', '-m', 'main');

  const integrationCommit = git(fixture.integration, 'rev-parse', 'HEAD');
  const preparedL = fixture.pm('integrate-prepare', '--run', fixture.runFile);
  assert.equal(preparedL.status, 0, preparedL.stdout);
  assert.equal(preparedL.json.record.integration.status, 'failed');
  assert.equal(preparedL.json.record.integration.failure.status, 128);
  const log = fs.readFileSync(path.join(fixture.integration,
    preparedL.json.record.integration.failure.log_path), 'utf8');
  assert.match(log, /fatal: refusing to merge unrelated histories/i);
  const repeated = spawnSync('git', ['-C', fixture.integration, 'merge-tree', '--write-tree',
    integrationCommit, fixture.candidate], { encoding: 'utf8' });
  assert.equal(repeated.status, 128);
  assert.match(repeated.stderr, /fatal: refusing to merge unrelated histories/i);

  const correctionFixture = {
    ...fixture, recordFile: preparedL.json.file, record: preparedL.json.record, recordHash: preparedL.json.hash,
  };
  const before = immutableBefore(correctionFixture);
  const prepare = requireFunction('prepareIntegrationCorrection');
  assert.throws(() => prepare(fixture.runFile, {
    integrationRecord: preparedL.json.file, expectedRecordHash: preparedL.json.hash,
  }, fixture.integration), /composition|conflict|unrelated|generic|merge.tree|probe/i);
  assertImmutableBefore(correctionFixture, before);
  assert.equal(readJson(preparedL.json.file).correction ?? null, null);
});

}

let correctionProtectionTestsRegistered = false;

export function registerCorrectionProtectionTests() {
  if (correctionProtectionTestsRegistered) {
    throw new Error('correction protection tests are already registered in this process');
  }
  correctionProtectionTestsRegistered = true;

test('correction first start rejects protected checkout drift from the prepared basis', (t) => {
  const basisConfig = 'approval_policy = "never"\n';
  const fixture = makeActualNoM(t, {
    protectCodexConfig: true,
    basisProtectedConfig: basisConfig,
  });
  const prepared = correctionPrepare(fixture);
  const correctionRoot = addCorrectionWorktree(t, fixture, prepared);
  const protectedConfigFile = write(correctionRoot, '.codex/config.toml', 'approval_policy = "on-request"\n');
  assert.equal(git(correctionRoot, 'check-ignore', '--', '.codex/config.toml'), '.codex/config.toml');
  assert.equal(
    fixture.record.integration.base_checkout_proof.protected_ignored['.codex/config.toml'],
    `file:644:${sha256(basisConfig)}`,
  );
  assert.equal(git(correctionRoot, 'status', '--porcelain=v1', '--untracked-files=all'), '');
  const before = {
    record: fs.readFileSync(fixture.recordFile, 'utf8'),
    story: fs.readFileSync(path.join(correctionRoot, storyRel), 'utf8'),
    config: fs.readFileSync(protectedConfigFile, 'utf8'),
  };
  assert.throws(
    () => correctionStart(fixture, prepared, correctionRoot),
    /protected|metadata|checkout|anchor|changed/i,
  );
  assert.equal(fs.readFileSync(fixture.recordFile, 'utf8'), before.record);
  assert.equal(fs.readFileSync(path.join(correctionRoot, storyRel), 'utf8'), before.story);
  assert.equal(fs.readFileSync(protectedConfigFile, 'utf8'), before.config);
  assert.equal(fs.existsSync(path.join(correctionRoot, '.deliver/runs', `${prepared.result.run_id}.json`)), false);
  assert.equal(fs.existsSync(path.join(correctionRoot, '.deliver/integration-correction-transaction.json')), false);
});

test('correction resume rejects protected checkout drift after publication', async (t) => {
  const recover = requireFunction('recoverIntegrationCorrectionStart');
  const readOrNull = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const initialConfig = 'approval_policy = "never"\n';
  const expectedStatus = {
    'starting-record': '',
    journal: '?? .deliver/integration-correction-transaction.json',
  };

  for (const boundary of ['starting-record', 'journal', 'run', 'story', 'started-record']) {
    await t.test(boundary, () => {
      const torn = interruptedStart(t, boundary, { protectedConfig: initialConfig });
      const active = readJson(torn.fixture.recordFile);
      const descriptor = active.correction.starting.reconstruction.descriptor;
      const generatedRun = JSON.parse(descriptor.writes[0].after);
      const retained = generatedRun.baseline.snapshot;
      assert.equal(retained.entries['.codex/config.toml'], `file:644:${sha256(initialConfig)}`);
      assert.equal(active.correction.starting.reconstruction.baseline_hash, retained.hash);
      assert.equal(
        active.correction.starting.reconstruction.anchor_hash,
        sha256(canonical(generatedRun.git_anchor)),
      );
      fs.appendFileSync(torn.protectedConfigFile, 'model_reasoning_effort = "low"\n');
      const token = active.correction.token;
      const liveSnapshot = snapshot(torn.correctionRoot, [
        ...token.original_packet.touches,
        ...token.original_packet.read_paths,
        ...token.original_packet.specs,
        token.story_path,
      ]);
      assert.notEqual(liveSnapshot.hash, retained.hash);
      assert.notEqual(
        liveSnapshot.entries['.codex/config.toml'],
        retained.entries['.codex/config.toml'],
      );
      assert.equal(
        git(torn.correctionRoot, 'status', '--porcelain=v1', '--untracked-files=all'),
        ['story', 'started-record'].includes(boundary)
          ? ` M ${storyRel}\n?? .deliver/integration-correction-transaction.json\n?? .deliver/runs/${torn.prepared.result.run_id}.json`
          : boundary === 'run'
            ? `?? .deliver/integration-correction-transaction.json\n?? .deliver/runs/${torn.prepared.result.run_id}.json`
            : expectedStatus[boundary],
      );
      const before = {
        record: fs.readFileSync(torn.fixture.recordFile, 'utf8'),
        journal: readOrNull(torn.journal),
        run: readOrNull(torn.runFile),
        story: fs.readFileSync(torn.storyFile, 'utf8'),
        config: fs.readFileSync(torn.protectedConfigFile, 'utf8'),
      };
      const resume = boundary === 'starting-record'
        ? () => correctionStart(torn.fixture, torn.prepared, torn.correctionRoot, torn.prepared.hash)
        : () => recover(torn.correctionRoot);
      assert.throws(
        resume,
        boundary === 'starting-record'
          ? /reconstruct|protected|metadata|checkout|anchor|changed/i
          : /protected|metadata|checkout|anchor|changed/i,
      );
      assert.equal(fs.readFileSync(torn.fixture.recordFile, 'utf8'), before.record);
      assert.equal(readOrNull(torn.journal), before.journal);
      assert.equal(readOrNull(torn.runFile), before.run);
      assert.equal(fs.readFileSync(torn.storyFile, 'utf8'), before.story);
      assert.equal(fs.readFileSync(torn.protectedConfigFile, 'utf8'), before.config);
    });
  }
});

test('correction recovery rejects worktree config drift after journal publication', (t) => {
  const recover = requireFunction('recoverIntegrationCorrectionStart');
  const torn = interruptedStart(t, 'journal', { worktreeConfig: 'before' });
  const active = readJson(torn.fixture.recordFile);
  const descriptor = active.correction.starting.reconstruction.descriptor;
  const generatedRun = JSON.parse(descriptor.writes[0].after);
  assert.equal(captureGitAnchor(torn.correctionRoot).protected_hash, generatedRun.git_anchor.protected_hash);
  git(torn.correctionRoot, 'config', '--worktree', 'deliver.protectedProbe', 'after');
  const liveAnchor = captureGitAnchor(torn.correctionRoot);
  assert.equal(liveAnchor.head, generatedRun.git_anchor.head);
  assert.notEqual(liveAnchor.protected_hash, generatedRun.git_anchor.protected_hash);
  assert.equal(
    git(torn.correctionRoot, 'status', '--porcelain=v1', '--untracked-files=all'),
    '?? .deliver/integration-correction-transaction.json',
  );
  const before = {
    record: fs.readFileSync(torn.fixture.recordFile, 'utf8'),
    journal: fs.readFileSync(torn.journal, 'utf8'),
    story: fs.readFileSync(torn.storyFile, 'utf8'),
  };
  assert.throws(() => recover(torn.correctionRoot), /protected|metadata|checkout|anchor|changed/i);
  assert.equal(fs.readFileSync(torn.fixture.recordFile, 'utf8'), before.record);
  assert.equal(fs.readFileSync(torn.journal, 'utf8'), before.journal);
  assert.equal(fs.readFileSync(torn.storyFile, 'utf8'), before.story);
  assert.equal(fs.existsSync(torn.runFile), false);
});
test('correction initialized submodule controls accept exact basis checkouts', async (t) => {
  for (const [label, submoduleMode] of [
    ['standard submodule update clone', 'fresh-clone'],
    ['shared protected Git worktree', 'shared-worktree'],
  ]) {
    await t.test(label, () => {
      const fixture = makeActualNoM(t, { withSubmodule: true });
      const prepared = correctionPrepare(fixture);
      const correctionRoot = addCorrectionWorktree(t, fixture, prepared, { submoduleMode });
      const moduleRoot = path.join(correctionRoot, 'vendor/dependency');
      const proof = fixture.record.integration.base_checkout_proof;
      assert.equal(proof.entries['vendor/dependency'], `gitlink:${fixture.dependencyA}`);
      assert.equal(git(moduleRoot, 'rev-parse', 'HEAD'), fixture.dependencyA);
      assert.equal(git(correctionRoot, 'status', '--porcelain=v1', '--untracked-files=all'), '');
      const started = correctionStart(fixture, prepared, correctionRoot);
      assert.equal(started.run_id, prepared.result.run_id);
      assert.equal(started.phase, 'active');
      assert.equal(readJson(fixture.recordFile).correction.status, 'started');
    });
  }
});

test('correction first start accepts a relocated checkout with the same relative hook contract', (t) => {
  const fixture = makeActualNoM(t, { relativeHooks: true });
  const prepared = correctionPrepare(fixture);
  const correctionRoot = addCorrectionWorktree(t, fixture, prepared);
  const basisHook = path.join(fixture.integration, '.githooks/pre-commit');
  const correctionHook = path.join(correctionRoot, '.githooks/pre-commit');
  assert.equal(git(fixture.integration, 'config', '--get', 'core.hooksPath'), '.githooks');
  assert.equal(git(correctionRoot, 'config', '--get', 'core.hooksPath'), '.githooks');
  assert.equal(fs.readFileSync(correctionHook, 'utf8'), fs.readFileSync(basisHook, 'utf8'));
  assert.equal(fs.lstatSync(correctionHook).mode & 0o777, fs.lstatSync(basisHook).mode & 0o777);
  assert.equal(fs.lstatSync(correctionHook).mode & 0o111, 0, 'fixture hook remains non-executable');
  assert.notEqual(
    captureGitAnchor(correctionRoot).protected_hash,
    fixture.record.integration.base_checkout_proof.protected_hash,
    'current protected hash exposes only the relocated absolute effective hook path',
  );
  assert.equal(git(correctionRoot, 'status', '--porcelain=v1', '--untracked-files=all'), '');
  const started = correctionStart(fixture, prepared, correctionRoot);
  assert.equal(started.run_id, prepared.result.run_id);
  assert.equal(started.phase, 'active');
  assert.equal(readJson(fixture.recordFile).correction.status, 'started');
});

test('correction first start rejects hidden initialized submodule drift unchanged', async (t) => {
  for (const [label, mutate, prove] of [
    ['nested HEAD', (fixture, moduleRoot) => {
      git(moduleRoot, 'checkout', '-q', fixture.dependencyB);
    }, (fixture, moduleRoot) => {
      assert.equal(git(moduleRoot, 'rev-parse', 'HEAD'), fixture.dependencyB);
      assert.notEqual(fixture.dependencyB, fixture.dependencyA);
    }],
    ['nested tracked bytes', (_fixture, moduleRoot) => {
      write(moduleRoot, 'value.txt', 'hidden correction-only bytes\n');
    }, (_fixture, moduleRoot) => {
      assert.equal(fs.readFileSync(path.join(moduleRoot, 'value.txt'), 'utf8'), 'hidden correction-only bytes\n');
      assert.notEqual(git(moduleRoot, 'status', '--porcelain=v1', '--untracked-files=all'), '');
    }],
    ['nested skip-worktree flag', (_fixture, moduleRoot) => {
      git(moduleRoot, 'update-index', '--skip-worktree', 'value.txt');
    }, (_fixture, moduleRoot) => {
      assert.match(git(moduleRoot, 'ls-files', '-v', '--', 'value.txt'), /^S /);
    }],
  ]) {
    await t.test(label, () => {
      const fixture = makeActualNoM(t, { withSubmodule: true });
      const prepared = correctionPrepare(fixture);
      const correctionRoot = addCorrectionWorktree(t, fixture, prepared, { submoduleMode: 'shared-worktree' });
      const moduleRoot = path.join(correctionRoot, 'vendor/dependency');
      const proof = fixture.record.integration.base_checkout_proof;
      const nestedProof = proof.initialized['vendor/dependency'];
      const cleanAnchor = captureGitAnchor(correctionRoot).submodules['vendor/dependency'];
      assert.equal(cleanAnchor.head, fixture.dependencyA);
      assert.equal(cleanAnchor.tree, nestedProof.tree);
      assert.equal(cleanAnchor.protected_hash, nestedProof.protected_hash);
      assert.deepEqual(nestedProof.protected_ignored, {});
      mutate(fixture, moduleRoot);
      prove(fixture, moduleRoot);
      const liveAnchor = captureGitAnchor(correctionRoot).submodules['vendor/dependency'];
      assert.equal(liveAnchor.protected_hash, nestedProof.protected_hash,
        'fixture changes nested checkout state without changing protected metadata');
      assert.equal(git(correctionRoot, 'status', '--porcelain=v1', '--untracked-files=all'), '',
        'submodule ignore=all keeps the superproject operationally clean');
      const before = {
        record: fs.readFileSync(fixture.recordFile, 'utf8'),
        story: fs.readFileSync(path.join(correctionRoot, storyRel), 'utf8'),
        nested_head: git(moduleRoot, 'rev-parse', 'HEAD'),
        nested_status: git(moduleRoot, 'status', '--porcelain=v1', '--untracked-files=all'),
        nested_flags: git(moduleRoot, 'ls-files', '-v', '-z'),
      };
      assert.throws(
        () => correctionStart(fixture, prepared, correctionRoot),
        /submodule|checkout|protected|metadata|anchor|tracked|index|flag|changed/i,
      );
      assert.equal(fs.readFileSync(fixture.recordFile, 'utf8'), before.record);
      assert.equal(fs.readFileSync(path.join(correctionRoot, storyRel), 'utf8'), before.story);
      assert.equal(git(moduleRoot, 'rev-parse', 'HEAD'), before.nested_head);
      assert.equal(git(moduleRoot, 'status', '--porcelain=v1', '--untracked-files=all'), before.nested_status);
      assert.equal(git(moduleRoot, 'ls-files', '-v', '-z'), before.nested_flags);
      assert.equal(fs.existsSync(path.join(correctionRoot, '.deliver/runs', `${prepared.result.run_id}.json`)), false);
      assert.equal(fs.existsSync(path.join(correctionRoot, '.deliver/integration-correction-transaction.json')), false);
    });
  }
});

test('correction recovery rejects executable mode drift on the exact story after-image', async (t) => {
  const recover = requireFunction('recoverIntegrationCorrectionStart');
  for (const boundary of ['story', 'started-record']) {
    await t.test(boundary, () => {
      const torn = interruptedStart(t, boundary);
      const active = readJson(torn.fixture.recordFile);
      const descriptor = active.correction.starting.reconstruction.descriptor;
      const generatedRun = JSON.parse(descriptor.writes[0].after);
      assert.equal(fs.readFileSync(torn.storyFile, 'utf8'), descriptor.writes[1].after,
        'fixture starts from the exact legal story after-image');
      assert.equal(git(torn.correctionRoot, 'config', '--bool', 'core.filemode'), 'true');
      const publishedMode = fs.lstatSync(torn.storyFile).mode & 0o777;
      assert.equal(publishedMode & 0o111, 0);
      fs.chmodSync(torn.storyFile, 0o755);
      assert.equal(fs.lstatSync(torn.storyFile).mode & 0o777, 0o755);
      assert.equal(fs.readFileSync(torn.storyFile, 'utf8'), descriptor.writes[1].after,
        'chmod changes only the exact after-image mode');
      const live = snapshot(torn.correctionRoot, [
        ...active.correction.token.original_packet.touches,
        ...active.correction.token.original_packet.read_paths,
        ...active.correction.token.original_packet.specs,
        active.correction.token.story_path,
      ]);
      assert.match(generatedRun.baseline.snapshot.entries[storyRel], /^file:644:/);
      assert.match(live.entries[storyRel], /^file:755:/);
      assert.equal(
        git(torn.correctionRoot, 'status', '--porcelain=v1', '--untracked-files=all'),
        ` M ${storyRel}\n?? .deliver/integration-correction-transaction.json\n?? .deliver/runs/${torn.prepared.result.run_id}.json`,
      );
      const before = {
        record: fs.readFileSync(torn.fixture.recordFile, 'utf8'),
        journal: fs.readFileSync(torn.journal, 'utf8'),
        run: fs.readFileSync(torn.runFile, 'utf8'),
        story: fs.readFileSync(torn.storyFile, 'utf8'),
        mode: fs.lstatSync(torn.storyFile).mode & 0o777,
      };
      let recoveryError = null;
      let recoveryResult = null;
      try { recoveryResult = recover(torn.correctionRoot); }
      catch (error) { recoveryError = error; }
      if (!recoveryError) {
        assert.equal(recoveryResult.recovered, true);
        assert.equal(fs.lstatSync(torn.storyFile).mode & 0o777, before.mode,
          'current successful recovery leaves the executable mode in place');
        assert.fail(`recovery accepted story mode ${publishedMode.toString(8)} -> ${before.mode.toString(8)} at ${boundary}`);
      }
      assert.match(String(recoveryError), /mode|story|checkout|baseline|changed/i);
      assert.equal(fs.readFileSync(torn.fixture.recordFile, 'utf8'), before.record);
      assert.equal(fs.readFileSync(torn.journal, 'utf8'), before.journal);
      assert.equal(fs.readFileSync(torn.runFile, 'utf8'), before.run);
      assert.equal(fs.readFileSync(torn.storyFile, 'utf8'), before.story);
      assert.equal(fs.lstatSync(torn.storyFile).mode & 0o777, before.mode);
    });
  }
});

test('correction recovery rejects incomplete started publications unchanged', async (t) => {
  const recover = requireFunction('recoverIntegrationCorrectionStart');
  await t.test('exact started after-images control', () => {
    const torn = interruptedStart(t, 'started-record');
    assert.equal(fs.existsSync(torn.journal), true, 'started fixture retains its exact journal');
    const active = readJson(torn.fixture.recordFile);
    const descriptor = active.correction.starting.reconstruction.descriptor;
    assert.equal(fs.readFileSync(torn.runFile, 'utf8'), descriptor.writes[0].after);
    assert.equal(fs.readFileSync(torn.storyFile, 'utf8'), descriptor.writes[1].after);
    const recovered = recover(torn.correctionRoot);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.run_id, torn.prepared.result.run_id);
    assert.equal(fs.existsSync(torn.journal), false);
    assert.equal(fs.readFileSync(torn.runFile, 'utf8'), descriptor.writes[0].after);
    assert.equal(fs.readFileSync(torn.storyFile, 'utf8'), descriptor.writes[1].after);
  });
  for (const [label, mutate] of [
    ['missing published run', (torn) => fs.unlinkSync(torn.runFile)],
    ['story restored to exact before-image', (torn, descriptor) => {
      fs.writeFileSync(torn.storyFile, descriptor.writes[1].before);
      fs.chmodSync(torn.storyFile, 0o644);
    }],
  ]) {
    await t.test(label, () => {
      const torn = interruptedStart(t, 'started-record');
      assert.equal(fs.existsSync(torn.journal), true, 'started fixture retains its exact journal');
      const active = readJson(torn.fixture.recordFile);
      const descriptor = active.correction.starting.reconstruction.descriptor;
      assert.equal(active.correction.status, 'started');
      assert.equal(fs.readFileSync(torn.runFile, 'utf8'), descriptor.writes[0].after);
      assert.equal(fs.readFileSync(torn.storyFile, 'utf8'), descriptor.writes[1].after);
      mutate(torn, descriptor);
      const before = {
        record: fs.readFileSync(torn.fixture.recordFile, 'utf8'),
        journal: fs.readFileSync(torn.journal, 'utf8'),
        run: fs.existsSync(torn.runFile) ? fs.readFileSync(torn.runFile, 'utf8') : null,
        story: fs.readFileSync(torn.storyFile, 'utf8'),
        storyMode: fs.lstatSync(torn.storyFile).mode & 0o777,
      };
      let recoveryError = null;
      let recoveryResult = null;
      try { recoveryResult = recover(torn.correctionRoot); }
      catch (error) { recoveryError = error; }
      if (!recoveryError) {
        assert.fail(`recovery accepted incomplete started publication ${label}: ${JSON.stringify({
          recovered: recoveryResult?.recovered,
          journal_exists: fs.existsSync(torn.journal),
          run_exists: fs.existsSync(torn.runFile),
          story_is_after: fs.readFileSync(torn.storyFile, 'utf8') === descriptor.writes[1].after,
        })}`);
      }
      assert.match(String(recoveryError), /started|publication|run|story|after.image|journal|missing|changed/i);
      assert.equal(fs.readFileSync(torn.fixture.recordFile, 'utf8'), before.record);
      assert.equal(fs.readFileSync(torn.journal, 'utf8'), before.journal);
      assert.equal(fs.existsSync(torn.runFile), before.run !== null);
      if (before.run !== null) assert.equal(fs.readFileSync(torn.runFile, 'utf8'), before.run);
      assert.equal(fs.readFileSync(torn.storyFile, 'utf8'), before.story);
      assert.equal(fs.lstatSync(torn.storyFile).mode & 0o777, before.storyMode);
    });
  }
});

test('correction recovery binds started publication hashes to the journal after-images unchanged', async (t) => {
  const recover = requireFunction('recoverIntegrationCorrectionStart');
  for (const field of ['run_hash', 'story_hash']) {
    await t.test(field, () => {
      const torn = interruptedStart(t, 'started-record');
      assert.equal(fs.existsSync(torn.journal), true, 'started fixture retains its exact journal');
      const active = readJson(torn.fixture.recordFile);
      const descriptor = active.correction.starting.reconstruction.descriptor;
      assert.equal(active.correction.status, 'started');
      assert.equal(active.correction.started.run_hash, sha256(descriptor.writes[0].after));
      assert.equal(active.correction.started.story_hash, sha256(descriptor.writes[1].after));
      active.correction.started[field] = sha256(`valid-format drift for ${field}`);
      fs.writeFileSync(torn.fixture.recordFile, `${JSON.stringify(active, null, 2)}\n`);
      const before = {
        record: fs.readFileSync(torn.fixture.recordFile, 'utf8'),
        journal: fs.readFileSync(torn.journal, 'utf8'),
        run: fs.readFileSync(torn.runFile, 'utf8'),
        story: fs.readFileSync(torn.storyFile, 'utf8'),
        storyMode: fs.lstatSync(torn.storyFile).mode & 0o777,
      };
      let recoveryError = null;
      let recoveryResult = null;
      try { recoveryResult = recover(torn.correctionRoot); }
      catch (error) { recoveryError = error; }
      if (!recoveryError) {
        assert.fail(`recovery accepted ${field} unrelated to its after-image: ${JSON.stringify({
          recovered: recoveryResult?.recovered,
          journal_exists: fs.existsSync(torn.journal),
        })}`);
      }
      assert.match(String(recoveryError), /started|publication|run.hash|story.hash|after.image|journal|changed/i);
      assert.equal(fs.readFileSync(torn.fixture.recordFile, 'utf8'), before.record);
      assert.equal(fs.readFileSync(torn.journal, 'utf8'), before.journal);
      assert.equal(fs.readFileSync(torn.runFile, 'utf8'), before.run);
      assert.equal(fs.readFileSync(torn.storyFile, 'utf8'), before.story);
      assert.equal(fs.lstatSync(torn.storyFile).mode & 0o777, before.storyMode);
    });
  }
});

}

const invokedTestFile = process.argv[1] ? fs.realpathSync.native(process.argv[1]) : null;
if (invokedTestFile && invokedTestFile === fs.realpathSync.native(fileURLToPath(import.meta.url))) {
  registerCorrectionCoreTests();
}
