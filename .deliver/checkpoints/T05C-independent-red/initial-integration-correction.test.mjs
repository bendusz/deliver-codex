import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonical, sha256 } from '../plugins/deliver/skills/deliver/scripts/lib/state.mjs';
import { readStory, replaceStoryExecution } from '../plugins/deliver/skills/deliver/scripts/lib/story.mjs';

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

function buildFinishedSource(t, { fixes = 1, retries = 1, corrections = 2 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-correction-source-')));
  const integration = `${root}-integration`;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(integration, { recursive: true, force: true }));
  git(root, 'init', '-q', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Casey Example');
  git(root, 'config', 'user.email', 'casey@example.invalid');
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
  return {
    root, integration, runId, runFile, packet, candidate, sourceState, inherited,
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

function installOlderIntegrationExecution(fixture, { rounds = 2, retries = 2 } = {}) {
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
  });
  fs.writeFileSync(path.join(fixture.integration, storyRel), replacement.after);
}

function makeActualNoM(t, { before = 'unclaimed', ...options } = {}) {
  const fixture = buildFinishedSource(t, options);
  write(fixture.integration, 'src/value.txt', 'integration-side conflict\n');
  if (before === 'older') installOlderIntegrationExecution(fixture);
  else fs.writeFileSync(path.join(fixture.integration, storyRel), story());
  git(fixture.integration, 'add', 'src/value.txt', storyRel);
  git(fixture.integration, 'commit', '-qm', 'Integration I conflicts with candidate C');
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

function addCorrectionWorktree(t, fixture, prepared) {
  const correctionRoot = `${fixture.root}-correction-${prepared.result.run_id}`;
  t.after(() => fs.rmSync(correctionRoot, { recursive: true, force: true }));
  git(fixture.integration, 'worktree', 'add', '-q', correctionRoot, prepared.result.branch);
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
      assert.equal(token.actual_start_execution, beforeKind === 'unclaimed' ? null : readStory(fixture.integration, storyRel).execution);
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
      assert.equal(correctionRun.baseline.git_anchor.head, fixture.startCommit, 'operational baseline begins at actual I or M');
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

  await t.test('second attached checkout', () => {
    const fixture = makeActualNoM(t);
    const prepared = correctionPrepare(fixture);
    const correctionRoot = addCorrectionWorktree(t, fixture, prepared);
    const duplicate = `${correctionRoot}-duplicate`;
    t.after(() => fs.rmSync(duplicate, { recursive: true, force: true }));
    git(fixture.integration, 'worktree', 'add', '--detach', '-q', duplicate, prepared.result.start_commit);
    const recordBefore = fs.readFileSync(fixture.recordFile, 'utf8');
    assert.throws(() => correctionStart(fixture, prepared, correctionRoot), /sole|worktree|duplicate|attached/i);
    assert.equal(fs.readFileSync(fixture.recordFile, 'utf8'), recordBefore);
  });
});

function interruptedStart(t, boundary) {
  const fixture = makeActualNoM(t, { before: 'older' });
  const prepared = correctionPrepare(fixture);
  const correctionRoot = addCorrectionWorktree(t, fixture, prepared);
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
  return { fixture, prepared, correctionRoot, journal, runFile, storyFile };
}

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
