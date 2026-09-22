import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readStory } from '../plugins/deliver/skills/deliver/scripts/lib/story.mjs';
import { canonical, sha256 } from '../plugins/deliver/skills/deliver/scripts/lib/state.mjs';
import { inspectState as upstreamInspect, parseExec as upstreamExecution } from './fixtures/upstream-v0.25.1/hooks/lib.mjs';

const runtime = fileURLToPath(new URL('../plugins/deliver/skills/deliver/scripts/deliver.mjs', import.meta.url));
const pmCli = fileURLToPath(new URL('../plugins/deliver/skills/deliver/scripts/pm.mjs', import.meta.url));
const storyRel = 'docs/stories/S1-1-value.md';
const criterion = 'The integrated value is present.';

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}

function write(root, rel, value) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function call(root, file, ...args) {
  const result = spawnSync(process.execPath, [file, ...args], { cwd: root, encoding: 'utf8' });
  let json;
  try { json = JSON.parse(result.stdout); } catch { json = null; }
  return { ...result, json };
}

function callWithEnv(root, environment, file, ...args) {
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, ...environment },
  });
  let json;
  try { json = JSON.parse(result.stdout); } catch { json = null; }
  return { ...result, json };
}

function story(touches = ['src'], specs = []) {
  return [
    '# S1-1: Change value',
    `<!-- pm-meta: ${JSON.stringify({ builder: 'codex-builder', touches })} -->`,
    'Sprint: 1 · Priority: high · Covers: AC-001 · Depends on: none · Parallel-safe: yes',
    `Risk: low · Review lenses: code-integrity-reviewer · Specs: ${specs.length ? specs.join(', ') : 'none'}`,
    '',
    '## Goal',
    'Change the value.',
    '',
    '## Acceptance criteria (testable)',
    `- [ ] ${criterion}`,
    '',
    '## Verification',
    '- Run the declared test gate.',
    '',
  ].join('\n');
}

function finishedCandidate(t, {
  preexistingDirty = false, gateCommand = 'node -e "process.exit(0)"', withSubmodule = false, advanceSubmodule = false,
  sourceConcern = false, nestedSubmoduleScopes = false, deepSubmodule = false, bindSubmodule = true,
  ignoreSubmoduleStatus = false, initializeIntegrationSubmodule = true,
} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-integration-source-')));
  const integration = `${root}-integration`;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(integration, { recursive: true, force: true }));
  git(root, 'init', '-q', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Casey Example');
  git(root, 'config', 'user.email', 'casey@example.invalid');
  let dependency = null;
  let leafDependency = null;
  if (withSubmodule) {
    dependency = `${root}-dependency`;
    t.after(() => fs.rmSync(dependency, { recursive: true, force: true }));
    fs.mkdirSync(dependency);
    git(dependency, 'init', '-q', '--initial-branch=main');
    git(dependency, 'config', 'user.name', 'Dependency Author');
    git(dependency, 'config', 'user.email', 'dependency@example.invalid');
    write(dependency, 'value.txt', 'dependency v1\n');
    if (nestedSubmoduleScopes) {
      write(dependency, 'contract.sdd', 'Spec: Dependency contract\nPurpose:\n  Bind the nested integration fixture.\nOwns:\n  ./value.txt\n  ./nested/leaf/leaf.txt\n  ../../src\nMust:\n  Preserve the committed value.\nDone when:\n  The committed value is verified.\n');
      fs.symlinkSync('value.txt', path.join(dependency, 'value-link'));
    }
    if (deepSubmodule) {
      leafDependency = `${root}-leaf-dependency`;
      t.after(() => fs.rmSync(leafDependency, { recursive: true, force: true }));
      fs.mkdirSync(leafDependency);
      git(leafDependency, 'init', '-q', '--initial-branch=main');
      git(leafDependency, 'config', 'user.name', 'Leaf Author');
      git(leafDependency, 'config', 'user.email', 'leaf@example.invalid');
      write(leafDependency, 'leaf.txt', 'leaf v1\n');
      git(leafDependency, 'add', 'leaf.txt');
      git(leafDependency, 'commit', '-qm', 'Leaf v1');
      git(dependency, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', leafDependency, 'nested/leaf');
    }
    git(dependency, 'add', '-A');
    git(dependency, 'commit', '-qm', 'Dependency v1');
    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', dependency, 'vendor/dependency');
    if (deepSubmodule) git(root, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive', '-q');
    if (ignoreSubmoduleStatus) {
      git(root, 'config', '-f', '.gitmodules', 'submodule.vendor/dependency.ignore', 'all');
      git(root, 'add', '.gitmodules');
    }
  }
  const pm = (...args) => call(root, pmCli, ...args);
  const run = (...args) => call(root, runtime, ...args);
  assert.equal(pm('init').status, 0);
  write(root, 'docs/plan.md', '# Plan\n\n## Delivery mode\n- Scale: standard\n- Checkpoint policy: story-level\n- Integration branch: main\n- Skeleton: none\n');
  const touches = withSubmodule && bindSubmodule
    ? ['src', nestedSubmoduleScopes ? (deepSubmodule ? 'vendor/dependency/nested/leaf/leaf.txt' : 'vendor/dependency/value.txt') : 'vendor/dependency']
    : ['src'];
  const specs = withSubmodule && nestedSubmoduleScopes ? ['vendor/dependency/contract.sdd'] : [];
  const readPaths = [storyRel, ...(withSubmodule && nestedSubmoduleScopes
    ? ['vendor/dependency/value-link', 'vendor/dependency/missing.txt'] : [])];
  write(root, storyRel, story(touches, specs));
  write(root, 'src/value.txt', 'before\n');
  git(root, 'add', 'docs', 'src');
  git(root, 'commit', '-qm', 'Planned project');
  assert.equal(pm('approve', '--approver', 'Ben').status, 0);
  git(root, 'add', 'docs/approval.json');
  git(root, 'commit', '-qm', 'Approved project');
  assert.equal(pm('claim', '--story', storyRel).status, 0);
  git(root, 'add', storyRel);
  git(root, 'commit', '-qm', 'Claim story');
  git(root, 'checkout', '-qb', 'pm/S1-1-value');
  if (advanceSubmodule) {
    write(dependency, 'value.txt', 'dependency v2\n');
    git(dependency, 'add', 'value.txt');
    git(dependency, 'commit', '-qm', 'Dependency v2');
    const moduleRoot = path.join(root, 'vendor/dependency');
    git(moduleRoot, 'fetch', '-q', 'origin');
    git(moduleRoot, 'checkout', '-q', git(dependency, 'rev-parse', 'HEAD'));
    git(root, 'add', 'vendor/dependency');
    git(root, 'commit', '-qm', 'Advance story dependency');
  }
  if (preexistingDirty) write(root, 'src/preexisting.txt', 'uncommitted user bytes\n');
  write(root, '.deliver/task.json', {
    id: 'S1-1', objective: 'Change the value.', acceptance: [{ id: 'AC-1', text: criterion }],
    read_paths: readPaths, touches, commands: { test: gateCommand }, specs,
  });
  const initialized = run('init', '--mode', 'quick');
  assert.equal(initialized.status, 0, initialized.stdout);
  const runId = initialized.json.run_id;
  const started = run('start', '--run', runId, '--task', '.deliver/task.json', '--builder', 'builder', '--story', storyRel);
  assert.equal(started.status, 0, started.stdout);
  for (const status of ['building', 'built', 'in-review']) assert.equal(pm('transition', '--run', runId, '--to', status).status, 0);
  write(root, 'src/value.txt', 'integrated\n');
  const prepared = run('commit-prepare', '--run', runId);
  assert.equal(prepared.status, 0, prepared.stdout);
  git(root, 'add', '-A', '--', ...prepared.json.preparation.paths);
  git(root, 'commit', '-qm', 'Candidate C');
  const candidate = git(root, 'rev-parse', 'HEAD');
  assert.equal(run('commit-adopt', '--run', runId, '--token', prepared.json.preparation.token, '--commit', candidate).status, 0);
  const checked = run('check', '--run', runId);
  assert.equal(checked.status, 0, checked.stdout);
  assert.equal(run('gate', '--run', runId, '--name', 'test', '--command', gateCommand).status, 0);
  write(root, '.deliver/review.json', {
    status: 'PASS', findings: [], panel: { snapshot_hash: checked.json.snapshot_hash, members: [
      { lens: 'code-integrity-reviewer', reviewer: 'reviewer', verdict: sourceConcern ? 'CONCERNS' : 'PASS', snapshot_hash: checked.json.snapshot_hash,
        findings: sourceConcern ? [{ severity: 'minor', message: 'Keep the source C concern visible.', resolved: false }] : [] },
    ] },
  });
  assert.equal(run('review', '--run', runId, '--snapshot', checked.json.snapshot_hash, '--reviewer', 'reviewer', '--receipt', '.deliver/review.json').status, 0);
  write(root, '.deliver/verification.json', { criteria: [{ id: 'AC-1', status: 'PASS', evidence: 'The test gate passed at candidate C.' }] });
  const selfVerified = run('verify', '--run', runId, '--snapshot', checked.json.snapshot_hash, '--verifier', 'reviewer', '--results', '.deliver/verification.json');
  assert.notEqual(selfVerified.status, 0);
  assert.match(selfVerified.stdout, /verifier must differ from reviewer/i);
  assert.equal(run('verify', '--run', runId, '--snapshot', checked.json.snapshot_hash, '--verifier', 'verifier', '--results', '.deliver/verification.json').status, 0);
  assert.equal(run('finish', '--run', runId).status, 0);
  git(root, 'worktree', 'add', '-q', integration, 'main');
  if (withSubmodule && initializeIntegrationSubmodule) {
    git(integration, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive', '-q');
  }
  return { root, integration, dependency, leafDependency, runId, runFile: path.join(root, '.deliver/runs', `${runId}.json`), candidate };
}

function integrationCall(f, ...args) { return call(f.integration, pmCli, ...args); }

function mutateRecord(f, state, command, ...args) {
  const result = integrationCall(f, command, '--integration', state.file, '--expected-record', state.hash, ...args);
  assert.equal(result.status, 0, result.stdout);
  state.hash = result.json.hash;
  state.record = result.json.record;
  return result.json.result;
}

function finalizedIntegration(t, { verificationReport = false, freshEvidence = false } = {}) {
  const f = finishedCandidate(t);
  const args = ['integrate-prepare', '--run', f.runFile, ...(verificationReport ? ['--verification-report'] : [])];
  const prepared = integrationCall(f, ...args);
  assert.equal(prepared.status, 0, prepared.stdout);
  const state = { file: prepared.json.file, hash: prepared.json.hash, record: prepared.json.record };
  git(f.integration, 'merge', '--no-ff', '--no-edit', f.candidate);
  mutateRecord(f, state, 'integrate-adopt', '--token', state.record.integration.token, '--commit', git(f.integration, 'rev-parse', 'HEAD'));
  mutateRecord(f, state, 'integrate-gate', '--name', 'test');
  if (freshEvidence) {
    write(f.integration, '.deliver/integration-review.json', {
      status: 'PASS', findings: [], panel: { snapshot_hash: state.record.evidence.snapshot_hash, members: [{
        lens: 'code-integrity-reviewer', reviewer: 'historical-panel-reviewer', verdict: 'PASS',
        snapshot_hash: state.record.evidence.snapshot_hash, findings: [],
      }] },
    });
    mutateRecord(f, state, 'integrate-review', '--reviewer', 'historical-reviewer',
      '--receipt', '.deliver/integration-review.json');
    write(f.integration, '.deliver/integration-verification.json', {
      criteria: [{ id: 'AC-1', status: 'PASS', evidence: 'The declared gate passed against actual M.' }],
    });
    mutateRecord(f, state, 'integrate-verify', '--verifier', 'historical-verifier',
      '--results', '.deliver/integration-verification.json');
  }
  mutateRecord(f, state, 'integrate-finalize');
  return { f, state };
}

test('local C/M/P/E/H closure retains current identity, counters and upstream handoff state', (t) => {
  const f = finishedCandidate(t, { sourceConcern: true });
  const prepared = integrationCall(f, 'integrate-prepare', '--run', f.runFile, '--verification-report');
  assert.equal(prepared.status, 0, prepared.stdout);
  const state = { file: prepared.json.file, hash: prepared.json.hash, record: prepared.json.record };
  assert.equal(state.record.reporting, 'requested');
  assert.equal(readStory(f.root, storyRel).execution.status, 'in-review');
  const resumed = integrationCall(f, 'integrate-prepare', '--run', f.runFile, '--verification-report');
  assert.equal(resumed.status, 0, resumed.stdout);
  assert.equal(resumed.json.resumed, true);
  assert.equal(resumed.json.hash, state.hash);
  assert.equal(resumed.json.record.integration.token, state.record.integration.token);

  git(f.integration, 'merge', '--no-ff', '--no-edit', f.candidate);
  const merge = git(f.integration, 'rev-parse', 'HEAD');
  mutateRecord(f, state, 'integrate-adopt', '--token', state.record.integration.token, '--commit', merge);
  const gate = mutateRecord(f, state, 'integrate-gate', '--name', 'test');
  assert.equal(gate.status, 'PASS');
  write(f.integration, '.deliver/integration-review.json', {
    status: 'PASS', findings: [], panel: { snapshot_hash: state.record.evidence.snapshot_hash, members: [
      { lens: 'code-integrity-reviewer', reviewer: 'm-reviewer', verdict: 'CONCERNS', snapshot_hash: state.record.evidence.snapshot_hash,
        findings: [{ severity: 'minor', message: 'Retain this minor integration concern.', resolved: false }] },
    ] },
  });
  mutateRecord(f, state, 'integrate-review', '--reviewer', 'm-reviewer', '--receipt', '.deliver/integration-review.json');
  write(f.integration, '.deliver/integration-verification.json', {
    criteria: [{ id: 'AC-1', status: 'PASS', evidence: 'The declared gate passed against actual M.' }],
  });
  mutateRecord(f, state, 'integrate-verify', '--verifier', 'm-verifier', '--results', '.deliver/integration-verification.json');
  mutateRecord(f, state, 'integrate-finalize');

  const reportingContract = structuredClone(state.record);
  const droppedReporting = structuredClone(state.record);
  droppedReporting.reporting = 'skipped';
  droppedReporting.reporting_requested = false;
  write(f.integration, path.relative(f.integration, state.file), droppedReporting);
  const refusedDrop = integrationCall(f, 'close-prepare', '--integration', state.file,
    '--expected-record', sha256(canonical(droppedReporting)));
  assert.notEqual(refusedDrop.status, 0);
  assert.match(refusedDrop.stdout, /invalid local integration record/);
  write(f.integration, path.relative(f.integration, state.file), reportingContract);

  const report = mutateRecord(f, state, 'report-prepare');
  const validRecord = structuredClone(state.record);
  const tampered = structuredClone(state.record);
  tampered.report.pending.writes[0].after += 'Unproven claim.\n';
  tampered.report.pending.writes[0].hash = sha256(tampered.report.pending.writes[0].after);
  write(f.integration, path.relative(f.integration, state.file), tampered);
  const refusedResume = integrationCall(f, 'report-prepare', '--integration', state.file,
    '--expected-record', sha256(canonical(tampered)));
  assert.notEqual(refusedResume.status, 0);
  assert.match(refusedResume.stdout, /no longer matches finalized evidence/i);
  write(f.integration, path.relative(f.integration, state.file), validRecord);
  const checklist = report.writes.find((item) => item.path.includes('checklists')).path;
  fs.unlinkSync(path.join(f.integration, checklist));
  const recoveredReport = mutateRecord(f, state, 'report-prepare');
  assert.equal(recoveredReport.token, report.token);
  assert.equal(fs.existsSync(path.join(f.integration, checklist)), true);
  git(f.integration, 'add', '--', ...report.writes.map((item) => item.path));
  git(f.integration, 'commit', '-qm', 'Verification report P');
  mutateRecord(f, state, 'report-adopt', '--token', report.token, '--commit', git(f.integration, 'rev-parse', 'HEAD'));
  const reportText = fs.readFileSync(path.join(f.integration, `docs/verification/S1-1.md`), 'utf8');
  assert.match(reportText, new RegExp(`Candidate C: ${f.candidate}`));
  assert.match(reportText, new RegExp(`Integrated M: ${merge}`));
  assert.match(reportText, /Retain this minor integration concern/);
  assert.match(reportText, /Keep the source C concern visible/);
  assert.doesNotMatch(reportText, /Verification report P/);

  const adoptedReport = structuredClone(state.record);
  const bypassedReport = structuredClone(state.record);
  bypassedReport.report.commit = bypassedReport.integration.commit;
  write(f.integration, path.relative(f.integration, state.file), bypassedReport);
  const refusedBypass = integrationCall(f, 'close-prepare', '--integration', state.file,
    '--expected-record', sha256(canonical(bypassedReport)));
  assert.notEqual(refusedBypass.status, 0);
  assert.match(refusedBypass.stdout, /report adopted commit proof is invalid/i);
  write(f.integration, path.relative(f.integration, state.file), adoptedReport);

  const closure = mutateRecord(f, state, 'close-prepare');
  git(f.integration, 'add', '--', storyRel);
  git(f.integration, 'commit', '-qm', 'Story closure E');
  const closureCommit = git(f.integration, 'rev-parse', 'HEAD');
  mutateRecord(f, state, 'close-adopt', '--token', closure.token, '--commit', closureCommit);
  const mergedStory = readStory(f.integration, storyRel);
  assert.equal(mergedStory.execution.status, 'merged');
  assert.equal(mergedStory.execution.owner, readStory(f.root, storyRel).execution.owner);
  assert.equal(mergedStory.execution.rounds, 0);
  assert.match(mergedStory.text, new RegExp(merge));

  const adoptedClosure = structuredClone(state.record);
  const falseClosure = structuredClone(state.record);
  falseClosure.closure.proof.parent = falseClosure.integration.commit;
  write(f.integration, path.relative(f.integration, state.file), falseClosure);
  const refusedHandoff = integrationCall(f, 'handoff-prepare', '--integration', state.file,
    '--expected-record', sha256(canonical(falseClosure)), '--next', 'Start the next ready story.');
  assert.notEqual(refusedHandoff.status, 0);
  assert.match(refusedHandoff.stdout, /closure adopted commit proof is invalid/i);
  write(f.integration, path.relative(f.integration, state.file), adoptedClosure);

  const handoff = mutateRecord(f, state, 'handoff-prepare', '--next', 'Start the next ready story.');
  git(f.integration, 'add', '--', handoff.writes[0].path);
  git(f.integration, 'commit', '-qm', 'Handoff H');
  const handoffCommit = git(f.integration, 'rev-parse', 'HEAD');
  mutateRecord(f, state, 'handoff-adopt', '--token', handoff.token, '--commit', handoffCommit);
  const handoffText = fs.readFileSync(path.join(f.integration, handoff.writes[0].path), 'utf8');
  assert.match(handoffText, new RegExp(`BASE_COMMIT: ${closureCommit}`));
  assert.match(handoffText, /OPEN_FINDINGS:[\s\S]*Retain this minor integration concern/);
  assert.match(handoffText, /OPEN_FINDINGS:[\s\S]*Keep the source C concern visible/);
  assert.notEqual(handoffCommit, closureCommit);
  assert.equal(upstreamInspect(f.integration).handoff.current, true);
  assert.equal(upstreamExecution(fs.readFileSync(path.join(f.integration, storyRel), 'utf8')).status, 'merged');
});

test('merge adoption refuses altered M and finish alone leaves the claim active', (t) => {
  const f = finishedCandidate(t);
  assert.equal(readStory(f.root, storyRel).execution.status, 'in-review');
  const prepared = integrationCall(f, 'integrate-prepare', '--run', f.runFile);
  assert.equal(prepared.status, 0, prepared.stdout);
  write(f.integration, 'src/unreviewed.txt', 'extra\n');
  git(f.integration, 'add', 'src/unreviewed.txt');
  git(f.integration, 'commit', '-qm', 'Unexpected integration content');
  const rejected = integrationCall(f, 'integrate-adopt', '--integration', prepared.json.file,
    '--expected-record', prepared.json.hash, '--token', prepared.json.record.integration.token,
    '--commit', git(f.integration, 'rev-parse', 'HEAD'));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.json.error, /no-ff merge/);
  const record = JSON.parse(fs.readFileSync(prepared.json.file, 'utf8'));
  assert.equal(record.integration.status, 'prepared');
  assert.equal(readStory(f.root, storyRel).execution.status, 'in-review');
});

test('bound source-only dirt requires fresh M evidence without mutating C', (t) => {
  const f = finishedCandidate(t, { preexistingDirty: true });
  const prepared = integrationCall(f, 'integrate-prepare', '--run', f.runFile);
  assert.equal(prepared.status, 0, prepared.stdout);
  const state = { file: prepared.json.file, hash: prepared.json.hash, record: prepared.json.record };
  assert.equal(state.record.evidence.source_reusable, false);
  assert.deepEqual(state.record.evidence.reuse_mismatches, ['src/preexisting.txt']);
  git(f.integration, 'merge', '--no-ff', '--no-edit', f.candidate);
  mutateRecord(f, state, 'integrate-adopt', '--token', state.record.integration.token, '--commit', git(f.integration, 'rev-parse', 'HEAD'));
  mutateRecord(f, state, 'integrate-gate', '--name', 'test');
  const missingFresh = integrationCall(f, 'integrate-finalize', '--integration', state.file, '--expected-record', state.hash);
  assert.notEqual(missingFresh.status, 0);
  assert.match(missingFresh.stdout, /require fresh independent M review and verification/i);
  write(f.integration, '.deliver/integration-review.json', {
    status: 'PASS', findings: [], panel: { snapshot_hash: state.record.evidence.snapshot_hash, members: [
      { lens: 'code-integrity-reviewer', reviewer: 'fresh-reviewer', verdict: 'PASS', snapshot_hash: state.record.evidence.snapshot_hash, findings: [] },
    ] },
  });
  mutateRecord(f, state, 'integrate-review', '--reviewer', 'fresh-reviewer', '--receipt', '.deliver/integration-review.json');
  write(f.integration, '.deliver/integration-verification.json', {
    criteria: [{ id: 'AC-1', status: 'PASS', evidence: 'Fresh review and the declared gate verified actual M.' }],
  });
  mutateRecord(f, state, 'integrate-verify', '--verifier', 'fresh-verifier', '--results', '.deliver/integration-verification.json');
  mutateRecord(f, state, 'integrate-finalize');
  assert.equal(fs.readFileSync(path.join(f.root, 'src/preexisting.txt'), 'utf8'), 'uncommitted user bytes\n');
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.candidate);
  assert.equal(readStory(f.root, storyRel).execution.status, 'in-review');
});

test('conflicted I and C persist an honest no-M probe record', (t) => {
  const f = finishedCandidate(t);
  write(f.integration, 'src/value.txt', 'integration-side change\n');
  git(f.integration, 'add', 'src/value.txt');
  git(f.integration, 'commit', '-qm', 'Conflicting integration change');
  const base = git(f.integration, 'rev-parse', 'HEAD');
  const prepared = integrationCall(f, 'integrate-prepare', '--run', f.runFile);
  assert.equal(prepared.status, 0, prepared.stdout);
  assert.equal(prepared.json.record.integration.status, 'failed');
  assert.equal(prepared.json.record.integration.base, base);
  assert.equal(prepared.json.record.integration.commit, null);
  assert.equal(prepared.json.record.integration.manifest, null);
  assert.equal(prepared.json.record.integration.failure.integration, base);
  assert.equal(prepared.json.record.integration.failure.candidate, f.candidate);
  assert.deepEqual(prepared.json.record.integration.failure.argv.slice(-4), ['merge-tree', '--write-tree', base, f.candidate]);
  const log = path.join(f.integration, prepared.json.record.integration.failure.log_path);
  assert.equal(sha256(fs.readFileSync(log)), prepared.json.record.integration.failure.log_hash);
  assert.equal(git(f.integration, 'rev-parse', 'HEAD'), base);
});

test('clean bound I-to-M drift prepares fresh evidence instead of source correction', (t) => {
  const f = finishedCandidate(t);
  write(f.integration, 'src/integration-context.txt', 'already accepted on I\n');
  git(f.integration, 'add', 'src/integration-context.txt');
  git(f.integration, 'commit', '-qm', 'Add integration-side context');
  const prepared = integrationCall(f, 'integrate-prepare', '--run', f.runFile);
  assert.equal(prepared.status, 0, prepared.stdout);
  assert.equal(prepared.json.record.integration.status, 'prepared');
  assert.equal(prepared.json.record.evidence.source_reusable, false);
  assert.deepEqual(prepared.json.record.evidence.reuse_mismatches, ['src/integration-context.txt']);
  assert.notEqual(prepared.json.record.source.manifest.hash, prepared.json.record.integration.manifest.hash);
});

test('initialized scoped submodule advances at M while nested dirt, flags and metadata are rejected', (t) => {
  const f = finishedCandidate(t, { withSubmodule: true, advanceSubmodule: true });
  assert.equal(git(f.root, 'rev-parse', 'HEAD:vendor/dependency'), git(f.dependency, 'rev-parse', 'HEAD'), 'source C gitlink');
  const prepared = integrationCall(f, 'integrate-prepare', '--run', f.runFile);
  assert.equal(prepared.status, 0, prepared.stdout);
  assert.equal(prepared.json.record.integration.status, 'prepared');
  const state = { file: prepared.json.file, hash: prepared.json.hash, record: prepared.json.record };
  git(f.integration, 'merge', '--no-ff', '--no-edit', f.candidate);
  const merge = git(f.integration, 'rev-parse', 'HEAD');
  const moduleRoot = path.join(f.integration, 'vendor/dependency');
  git(moduleRoot, 'fetch', '-q', 'origin');
  git(moduleRoot, 'checkout', '-q', git(f.integration, 'rev-parse', 'HEAD:vendor/dependency'));
  assert.equal(git(moduleRoot, 'rev-parse', 'HEAD'), git(f.dependency, 'rev-parse', 'HEAD'));

  write(moduleRoot, 'value.txt', 'nested dirt\n');
  let refused = integrationCall(f, 'integrate-adopt', '--integration', state.file, '--expected-record', state.hash,
    '--token', state.record.integration.token, '--commit', merge);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout, /uncommitted project paths|submodule bytes differ/);
  git(moduleRoot, 'checkout', '--', 'value.txt');

  git(moduleRoot, 'update-index', '--assume-unchanged', 'value.txt');
  write(moduleRoot, 'value.txt', 'hidden nested dirt\n');
  refused = integrationCall(f, 'integrate-adopt', '--integration', state.file, '--expected-record', state.hash,
    '--token', state.record.integration.token, '--commit', merge);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout, /unsupported index flags|submodule bytes differ/);
  git(moduleRoot, 'update-index', '--no-assume-unchanged', 'value.txt');
  git(moduleRoot, 'checkout', '--', 'value.txt');

  const moduleGitDir = path.resolve(moduleRoot, git(moduleRoot, 'rev-parse', '--git-dir'));
  const moduleConfig = path.join(moduleGitDir, 'config');
  const originalConfig = fs.readFileSync(moduleConfig);
  git(moduleRoot, 'config', 'deliver.changed', 'yes');
  refused = integrationCall(f, 'integrate-adopt', '--integration', state.file, '--expected-record', state.hash,
    '--token', state.record.integration.token, '--commit', merge);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout, /protected Git metadata changed/);
  fs.writeFileSync(moduleConfig, originalConfig);

  mutateRecord(f, state, 'integrate-adopt', '--token', state.record.integration.token, '--commit', merge);
  assert.equal(state.record.integration.anchor.submodules['vendor/dependency'].head, git(f.dependency, 'rev-parse', 'HEAD'));
  mutateRecord(f, state, 'integrate-gate', '--name', 'test');
});

test('nested submodule touch, read, spec, missing and symlink scopes bind exact M bytes', (t) => {
  const f = finishedCandidate(t, { withSubmodule: true, advanceSubmodule: true, nestedSubmoduleScopes: true });
  const prepared = integrationCall(f, 'integrate-prepare', '--run', f.runFile);
  assert.equal(prepared.status, 0, prepared.stdout);
  const entries = prepared.json.record.integration.manifest.entries;
  assert.match(entries['vendor/dependency'], /^gitlink:[0-9a-f]+$/);
  assert.match(entries['vendor/dependency/value.txt'], /^file:644:[0-9a-f]{64}$/);
  assert.match(entries['vendor/dependency/contract.sdd'], /^file:644:[0-9a-f]{64}$/);
  assert.match(entries['vendor/dependency/value-link'], /^symlink:[0-9a-f]{64}$/);
  assert.equal(entries['vendor/dependency/missing.txt'], null);

  const state = { file: prepared.json.file, hash: prepared.json.hash, record: prepared.json.record };
  git(f.integration, 'merge', '--no-ff', '--no-edit', f.candidate);
  const moduleRoot = path.join(f.integration, 'vendor/dependency');
  git(moduleRoot, 'fetch', '-q', 'origin');
  git(moduleRoot, 'checkout', '-q', git(f.integration, 'rev-parse', 'HEAD:vendor/dependency'));
  mutateRecord(f, state, 'integrate-adopt', '--token', state.record.integration.token,
    '--commit', git(f.integration, 'rev-parse', 'HEAD'));
  mutateRecord(f, state, 'integrate-gate', '--name', 'test');
});

test('nested scopes recurse through more than one initialized gitlink', (t) => {
  const f = finishedCandidate(t, {
    withSubmodule: true, deepSubmodule: true, nestedSubmoduleScopes: true, advanceSubmodule: true,
  });
  const prepared = integrationCall(f, 'integrate-prepare', '--run', f.runFile);
  assert.equal(prepared.status, 0, prepared.stdout);
  const entries = prepared.json.record.integration.manifest.entries;
  assert.match(entries['vendor/dependency'], /^gitlink:[0-9a-f]+$/);
  assert.match(entries['vendor/dependency/nested/leaf'], /^gitlink:[0-9a-f]+$/);
  assert.match(entries['vendor/dependency/nested/leaf/leaf.txt'], /^file:644:[0-9a-f]{64}$/);

  const state = { file: prepared.json.file, hash: prepared.json.hash, record: prepared.json.record };
  git(f.integration, 'merge', '--no-ff', '--no-edit', f.candidate);
  const moduleRoot = path.join(f.integration, 'vendor/dependency');
  git(moduleRoot, 'fetch', '-q', 'origin');
  git(moduleRoot, 'checkout', '-q', git(f.integration, 'rev-parse', 'HEAD:vendor/dependency'));
  git(moduleRoot, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive', '-q');
  mutateRecord(f, state, 'integrate-adopt', '--token', state.record.integration.token,
    '--commit', git(f.integration, 'rev-parse', 'HEAD'));
  mutateRecord(f, state, 'integrate-gate', '--name', 'test');
});

test('unbound initialized submodule cannot hide a wrong clean HEAD from M proof', (t) => {
  const f = finishedCandidate(t, { withSubmodule: true, bindSubmodule: false, ignoreSubmoduleStatus: true });
  const prepared = integrationCall(f, 'integrate-prepare', '--run', f.runFile);
  assert.equal(prepared.status, 0, prepared.stdout);
  const state = { file: prepared.json.file, hash: prepared.json.hash, record: prepared.json.record };
  git(f.integration, 'merge', '--no-ff', '--no-edit', f.candidate);
  const merge = git(f.integration, 'rev-parse', 'HEAD');
  const expected = git(f.integration, 'rev-parse', 'HEAD:vendor/dependency');
  write(f.dependency, 'value.txt', 'unbound dependency v2\n');
  git(f.dependency, 'add', 'value.txt');
  git(f.dependency, 'commit', '-qm', 'Unbound dependency v2');
  const moduleRoot = path.join(f.integration, 'vendor/dependency');
  git(moduleRoot, 'fetch', '-q', 'origin');
  git(moduleRoot, 'checkout', '-q', git(f.dependency, 'rev-parse', 'HEAD'));
  assert.equal(git(f.integration, 'status', '--porcelain', '--untracked-files=no'), '', 'superproject status is suppressed');

  const refused = integrationCall(f, 'integrate-adopt', '--integration', state.file, '--expected-record', state.hash,
    '--token', state.record.integration.token, '--commit', merge);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout, /expected commit|tracked bytes differ|expected M/i);
  git(moduleRoot, 'checkout', '-q', expected);
  mutateRecord(f, state, 'integrate-adopt', '--token', state.record.integration.token, '--commit', merge);
  git(moduleRoot, 'checkout', '-q', git(f.dependency, 'rev-parse', 'HEAD'));
  const refusedGate = integrationCall(f, 'integrate-gate', '--integration', state.file,
    '--expected-record', state.hash, '--name', 'test');
  assert.notEqual(refusedGate.status, 0);
  assert.match(refusedGate.stdout, /expected commit|tracked bytes differ|expected M/i);
  git(moduleRoot, 'checkout', '-q', expected);
  mutateRecord(f, state, 'integrate-gate', '--name', 'test');
});

test('unrelated empty uninitialized submodule can prepare, adopt and gate', (t) => {
  const f = finishedCandidate(t, {
    withSubmodule: true, bindSubmodule: false, initializeIntegrationSubmodule: false,
  });
  const modulePath = path.join(f.integration, 'vendor/dependency');
  assert.equal(fs.lstatSync(modulePath).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(modulePath), []);
  const prepared = integrationCall(f, 'integrate-prepare', '--run', f.runFile);
  assert.equal(prepared.status, 0, prepared.stdout);
  assert.deepEqual(prepared.json.record.integration.base_checkout_proof.initialized, {});
  const state = { file: prepared.json.file, hash: prepared.json.hash, record: prepared.json.record };
  git(f.integration, 'merge', '--no-ff', '--no-edit', f.candidate);
  mutateRecord(f, state, 'integrate-adopt', '--token', state.record.integration.token,
    '--commit', git(f.integration, 'rev-parse', 'HEAD'));
  mutateRecord(f, state, 'integrate-gate', '--name', 'test');
});

test('uninitialized submodule rejects nonempty, symlinked and required nested checkout shapes', (t) => {
  const malformed = finishedCandidate(t, {
    withSubmodule: true, bindSubmodule: false, ignoreSubmoduleStatus: true, initializeIntegrationSubmodule: false,
  });
  const modulePath = path.join(malformed.integration, 'vendor/dependency');
  write(modulePath, 'unexpected.txt', 'not an initialized checkout\n');
  let refused = integrationCall(malformed, 'integrate-prepare', '--run', malformed.runFile);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout, /unexpected Git root|not initialized safely/i);
  fs.rmSync(modulePath, { recursive: true, force: true });
  fs.symlinkSync(malformed.root, modulePath);
  refused = integrationCall(malformed, 'integrate-prepare', '--run', malformed.runFile);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout, /not a real directory|escapes/i);

  const required = finishedCandidate(t, {
    withSubmodule: true, nestedSubmoduleScopes: true, initializeIntegrationSubmodule: false,
  });
  refused = integrationCall(required, 'integrate-prepare', '--run', required.runFile);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout, /required submodule checkout is uninitialized/i);
});

test('gate execution rejects hidden bytes, retains retries and requires exact logs', (t) => {
  const gateCommand = 'node -e "const fs=require(\'node:fs\'),cp=require(\'node:child_process\');if(fs.existsSync(\'.deliver/mutate-gate\')){cp.execFileSync(\'git\',[\'update-index\',\'--assume-unchanged\',\'src/value.txt\']);fs.writeFileSync(\'src/value.txt\',\'hidden drift\\n\')}"';
  const f = finishedCandidate(t, { gateCommand });
  const prepared = integrationCall(f, 'integrate-prepare', '--run', f.runFile);
  assert.equal(prepared.status, 0, prepared.stdout);
  const state = { file: prepared.json.file, hash: prepared.json.hash, record: prepared.json.record };
  git(f.integration, 'merge', '--no-ff', '--no-edit', f.candidate);
  mutateRecord(f, state, 'integrate-adopt', '--token', state.record.integration.token, '--commit', git(f.integration, 'rev-parse', 'HEAD'));

  git(f.integration, 'update-index', '--assume-unchanged', 'src/value.txt');
  write(f.integration, 'src/value.txt', 'hidden before gate\n');
  const hiddenBefore = integrationCall(f, 'integrate-gate', '--integration', state.file, '--expected-record', state.hash, '--name', 'test');
  assert.notEqual(hiddenBefore.status, 0);
  assert.match(hiddenBefore.stdout, /unsupported index flags|executable bytes differ/);
  git(f.integration, 'update-index', '--no-assume-unchanged', 'src/value.txt');
  git(f.integration, 'checkout', '--', 'src/value.txt');

  write(f.integration, '.deliver/mutate-gate', 'trigger\n');
  const failed = mutateRecord(f, state, 'integrate-gate', '--name', 'test');
  assert.equal(failed.status, 'FAIL');
  git(f.integration, 'update-index', '--no-assume-unchanged', 'src/value.txt');
  git(f.integration, 'checkout', '--', 'src/value.txt');
  fs.unlinkSync(path.join(f.integration, '.deliver/mutate-gate'));
  const passed = mutateRecord(f, state, 'integrate-gate', '--name', 'test');
  assert.equal(passed.status, 'PASS');
  assert.equal(state.record.evidence.gate_history.length, 1);
  assert.equal(state.record.evidence.gate_history[0].status, 'FAIL');

  const log = path.join(f.integration, state.record.evidence.gates[0].log_path);
  const exactLog = fs.readFileSync(log);
  fs.appendFileSync(log, 'altered');
  const altered = integrationCall(f, 'integrate-finalize', '--integration', state.file, '--expected-record', state.hash);
  assert.notEqual(altered.status, 0);
  assert.match(altered.stdout, /log bytes changed/);
  fs.writeFileSync(log, exactLog);
  mutateRecord(f, state, 'integrate-finalize');
  const finalizedReview = state.record.evidence.effective_review_identity;
  mutateRecord(f, state, 'integrate-gate', '--name', 'test');
  assert.equal(state.record.evidence.finalized, false);
  assert.equal(state.record.evidence.finalization_history.length, 1);
  assert.equal(state.record.evidence.finalization_history[0].review_identity, finalizedReview);
  mutateRecord(f, state, 'integrate-finalize');
});

test('integration records reject noncanonical paths before creating locks', (t) => {
  const f = finishedCandidate(t);
  const prepared = integrationCall(f, 'integrate-prepare', '--run', f.runFile);
  assert.equal(prepared.status, 0, prepared.stdout);
  const linked = path.join(f.integration, '.deliver', 'linked-integration.json');
  fs.symlinkSync(prepared.json.file, linked);
  const rejected = integrationCall(f, 'integrate-finalize', '--integration', linked, '--expected-record', prepared.json.hash);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stdout, /regular file/);
  assert.equal(fs.existsSync(`${linked}.lock`), false);
  const escaped = structuredClone(prepared.json.record);
  escaped.id = '../escaped';
  escaped.source.run_id = '../escaped';
  const escapedFile = path.join(f.integration, '.deliver', 'integrations', 'escaped.json');
  write(f.integration, path.relative(f.integration, escapedFile), escaped);
  const rejectedId = integrationCall(f, 'integrate-finalize', '--integration', escapedFile,
    '--expected-record', sha256(canonical(escaped)));
  assert.notEqual(rejectedId.status, 0);
  assert.match(rejectedId.stdout, /canonical run id/);
  assert.equal(fs.existsSync(`${escapedFile}.lock`), false);
});

test('frozen artifact evidence survives a new terminal and refuses every later evidence mutation', (t) => {
  const { f, state } = finalizedIntegration(t, { verificationReport: true });
  const finalizedHash = state.hash;
  const finalizedRevision = state.record.revision;
  const repeated = mutateRecord(f, state, 'integrate-finalize');
  assert.equal(repeated.finalization, state.record.evidence.finalization.identity);
  assert.equal(state.hash, finalizedHash);
  assert.equal(state.record.revision, finalizedRevision);

  const report = mutateRecord(f, state, 'report-prepare');
  const beforeBytes = fs.readFileSync(state.file);
  const logDirectory = path.join(f.integration, '.deliver', 'logs', `integration-${f.runId}`);
  const beforeLogs = fs.readdirSync(logDirectory).sort();
  for (const args of [
    ['integrate-gate', '--name', 'test'],
    ['integrate-review', '--reviewer', 'later-reviewer', '--receipt', '.deliver/review.json'],
    ['integrate-verify', '--verifier', 'later-verifier', '--results', '.deliver/verification.json'],
  ]) {
    const refused = integrationCall(f, args[0], '--integration', state.file, '--expected-record', state.hash, ...args.slice(1));
    assert.notEqual(refused.status, 0);
    assert.match(refused.stdout, /evidence is frozen/i);
    assert.deepEqual(fs.readFileSync(state.file), beforeBytes);
    assert.deepEqual(fs.readdirSync(logDirectory).sort(), beforeLogs);
  }

  git(f.integration, 'add', '--', ...report.writes.map((item) => item.path));
  git(f.integration, 'commit', '-qm', 'Verification report P');
  mutateRecord(f, state, 'report-adopt', '--token', report.token, '--commit', git(f.integration, 'rev-parse', 'HEAD'));
  const resumed = callWithEnv(f.integration, { TERM_SESSION_ID: 'different-terminal' }, pmCli,
    'close-prepare', '--integration', state.file, '--expected-record', state.hash);
  assert.equal(resumed.status, 0, resumed.stdout);
  assert.equal(resumed.json.result.finalization_identity, state.record.evidence.finalization.identity);
});

test('explicit reconciliation recovers retained post-P legacy provenance and rejects missing evidence unchanged', async (t) => {
  const { f, state } = finalizedIntegration(t, { verificationReport: true });
  const report = mutateRecord(f, state, 'report-prepare');
  git(f.integration, 'add', '--', ...report.writes.map((item) => item.path));
  git(f.integration, 'commit', '-qm', 'Verification report P');
  mutateRecord(f, state, 'report-adopt', '--token', report.token, '--commit', git(f.integration, 'rev-parse', 'HEAD'));

  const legacy = structuredClone(state.record);
  const frozen = legacy.evidence.finalization;
  const oldGate = legacy.evidence.gates[0];
  const replacement = { ...structuredClone(oldGate), finished_at: new Date(Date.parse(oldGate.finished_at) + 1000).toISOString() };
  delete replacement.identity;
  replacement.identity = sha256(canonical(replacement));
  legacy.evidence.gate_history.push(oldGate);
  legacy.evidence.gates = [replacement];
  legacy.evidence.finalization_history.push({
    at: new Date().toISOString(), reason: 'legacy post-P gate refresh', finalized_at: legacy.evidence.finalized_at,
    snapshot_hash: legacy.evidence.snapshot_hash, review_identity: frozen.review_identity,
    verification_identity: frozen.verification_identity, gates: frozen.gates.map((item) => item.identity),
  });
  legacy.evidence.finalized = false;
  legacy.evidence.finalized_at = null;
  legacy.evidence.effective_review_identity = null;
  legacy.evidence.effective_verification_identity = null;
  delete legacy.evidence.finalization;
  delete legacy.report.proof.finalization_identity;
  const sign = (receipt) => {
    const value = structuredClone(receipt);
    delete value.identity;
    value.identity = sha256(canonical(value));
    return value;
  };
  const archivedLogPath = `.deliver/logs/integration-${f.runId}/archived-failure.log`;
  const archivedLog = 'command: node -e "process.exit(1)"\nexit: 1\n';
  write(f.integration, archivedLogPath, archivedLog);
  legacy.evidence.gate_history.unshift(sign({
    ...structuredClone(oldGate), status: 'FAIL', exit_code: 1, error: 'earlier resolved gate failure',
    log_path: archivedLogPath, log_hash: sha256(archivedLog),
  }));
  const logDirectory = path.join(f.integration, '.deliver', 'logs', `integration-${f.runId}`);
  const capture = () => ({
    record: fs.readFileSync(state.file),
    logs: fs.readdirSync(logDirectory).sort().map((name) => [name, sha256(fs.readFileSync(path.join(logDirectory, name)))]),
    refs: git(f.integration, 'show-ref', '--head'),
    status: git(f.integration, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
    artifacts: legacy.report.proof.writes.map((item) => [item.path, sha256(fs.readFileSync(path.join(f.integration, item.path)))]),
  });
  const assertVeto = (label, change, pattern) => {
    const invalid = structuredClone(legacy);
    change(invalid);
    const invalidHash = sha256(canonical(invalid));
    write(f.integration, path.relative(f.integration, state.file), invalid);
    const beforeState = capture();
    const result = integrationCall(f, 'integrate-reconcile', '--integration', state.file, '--expected-record', invalidHash);
    assert.notEqual(result.status, 0, `${label}: command unexpectedly succeeded`);
    assert.match(result.stdout, pattern, label);
    assert.deepEqual(capture(), beforeState, `${label} changed durable record, logs, artifacts or refs`);
  };
  const activeReview = (value, { reviewer = 'current-reviewer', includeReviewer = true,
    panelReviewer = 'current-panel-reviewer', panelReviewers = [panelReviewer] } = {}) => sign({
    status: 'PASS', findings: [], ...(includeReviewer ? { reviewer } : {}),
    snapshot_hash: value.evidence.snapshot_hash, recorded_at: new Date(0).toISOString(),
    panel: { snapshot_hash: value.evidence.snapshot_hash, members: panelReviewers.map((member, index) => ({
      lens: index === 0 ? 'code-integrity-reviewer' : `additional-lens-${index}`, reviewer: member, verdict: 'PASS',
      snapshot_hash: value.evidence.snapshot_hash, findings: [],
    })) },
  });
  const activeVerification = (value, { verifier = 'current-verifier', includeVerifier = true } = {}) => sign({
    ...(includeVerifier ? { verifier } : {}), snapshot_hash: value.evidence.snapshot_hash,
    recorded_at: new Date(0).toISOString(),
    criteria: [{ id: 'AC-1', status: 'PASS', evidence: 'Current result.' }],
  });
  const setActivePass = (value, options = {}) => {
    value.evidence.review = activeReview(value, options);
    value.evidence.verification = activeVerification(value, options);
  };

  assertVeto('active failed gate', (value) => {
    value.evidence.gates[0] = sign({ ...value.evidence.gates[0], status: 'FAIL', exit_code: 1, error: 'current failure' });
  }, /fresh integration gate is missing or failed/);
  assertVeto('active gate with wrong snapshot binding', (value) => {
    value.evidence.gates[0] = sign({ ...value.evidence.gates[0], snapshot_hash: 'b'.repeat(64) });
  }, /fresh integration gate is missing or failed/);
  assertVeto('active gate with wrong M binding', (value) => {
    value.evidence.gates[0] = sign({ ...value.evidence.gates[0], integration_commit: value.integration.base });
  }, /fresh integration gate is missing or failed/);
  assertVeto('active gate with wrong command binding', (value) => {
    value.evidence.gates[0] = sign({ ...value.evidence.gates[0], command: 'node -e "process.exit(1)"' });
  }, /LEGACY_ACTIVE_EVIDENCE_MISSING/);
  assertVeto('missing active gate', (value) => { value.evidence.gates = []; }, /LEGACY_ACTIVE_EVIDENCE_MISSING/);
  assertVeto('duplicate active gate', (value) => { value.evidence.gates.push(structuredClone(value.evidence.gates[0])); }, /LEGACY_ACTIVE_EVIDENCE_MISSING/);
  assertVeto('stale active gate identity', (value) => { value.evidence.gates[0].identity = '0'.repeat(64); }, /receipt identity is invalid/);
  const malformedActorValues = [
    ['slash', 'invalid/reviewer'],
    ['array', []],
    ['object', {}],
    ['number', 7],
    ['null', null],
    ['overlong', 'r'.repeat(129)],
    ['trailing newline', 'current-reviewer\n'],
  ];
  const reviewerIdentityCases = [
    ['active builder self-review', { reviewer: legacy.source.builder }, /reviewer.*(?:differ|distinct).*builder/i],
    ['active missing reviewer identity', { includeReviewer: false }, /reviewer.*explicit|reviewer.*identity/i],
    ['active empty reviewer identity', { reviewer: '' }, /reviewer.*explicit|reviewer.*identity/i],
    ...malformedActorValues.map(([kind, reviewer]) => [
      `active malformed reviewer identity (${kind})`, { reviewer }, /reviewer.*explicit|reviewer.*identity/i,
    ]),
    ['active builder panel member', { panelReviewer: legacy.source.builder }, /panel.*(?:differ|distinct).*builder/i],
  ];
  for (const [label, options, pattern] of reviewerIdentityCases) {
    await t.test(label, () => assertVeto(label, (value) => setActivePass(value, options), pattern));
  }
  const verifierIdentityCases = [
    ['active missing verifier identity', { includeVerifier: false }, /verifier.*explicit|verifier.*identity/i],
    ['active empty verifier identity', { verifier: '' }, /verifier.*explicit|verifier.*identity/i],
    ...malformedActorValues.map(([kind, verifier]) => [
      `active malformed verifier identity (${kind})`, { verifier }, /verifier.*explicit|verifier.*identity/i,
    ]),
    ['active verifier equals builder', { verifier: legacy.source.builder }, /verifier.*(?:differ|distinct).*builder.*reviewer/i],
    ['active verifier equals top reviewer', { verifier: 'current-reviewer' }, /verifier.*(?:differ|distinct).*builder.*reviewer/i],
    ['active verifier equals panel reviewer', { verifier: 'current-panel-reviewer' }, /verifier.*(?:differ|distinct).*builder.*reviewer/i],
  ];
  for (const [label, options, pattern] of verifierIdentityCases) {
    await t.test(label, () => assertVeto(label, (value) => setActivePass(value, options), pattern));
  }
  assertVeto('active failed review', (value) => {
    value.evidence.review = sign({ status: 'FAIL', findings: [], reviewer: 'current-reviewer',
      snapshot_hash: value.evidence.snapshot_hash, recorded_at: new Date(0).toISOString() });
  }, /unresolved review findings/);
  assertVeto('active unresolved blocking review', (value) => {
    value.evidence.review = sign({ status: 'FAIL', reviewer: 'current-reviewer',
      snapshot_hash: value.evidence.snapshot_hash, recorded_at: new Date(0).toISOString(),
      findings: [{ severity: 'block', message: 'Current blocking finding.', resolved: false }] });
  }, /unresolved review findings/);
  assertVeto('missing active review pointer after history', (value) => {
    value.evidence.review_history.push(structuredClone(value.source.review));
  }, /current review pointer is absent/);
  for (const status of ['FAIL', 'UNKNOWN']) {
    assertVeto(`active ${status} verification`, (value) => {
      value.evidence.verification = sign({ verifier: 'current-verifier', snapshot_hash: value.evidence.snapshot_hash,
        recorded_at: new Date(0).toISOString(), criteria: [{ id: 'AC-1', status, evidence: 'Current result.' }] });
    }, /acceptance verification is incomplete/);
  }
  assertVeto('active incomplete verification', (value) => {
    value.evidence.verification = sign({ verifier: 'current-verifier', snapshot_hash: value.evidence.snapshot_hash,
      recorded_at: new Date(0).toISOString(), criteria: [] });
  }, /cover each acceptance id exactly once/);
  assertVeto('missing active verification pointer after history', (value) => {
    value.evidence.verification_history.push(structuredClone(value.source.verification));
  }, /current verification pointer is absent/);

  const currentPass = structuredClone(legacy);
  setActivePass(currentPass);
  const currentPassHash = sha256(canonical(currentPass));
  write(f.integration, path.relative(f.integration, state.file), currentPass);
  const currentRepaired = integrationCall(f, 'integrate-reconcile', '--integration', state.file,
    '--expected-record', currentPassHash);
  assert.equal(currentRepaired.status, 0, currentRepaired.stdout);
  assert.equal(currentRepaired.json.record.evidence.review.identity, currentPass.evidence.review.identity);
  assert.equal(currentRepaired.json.record.evidence.verification.identity, currentPass.evidence.verification.identity);
  assert.equal(currentRepaired.json.record.evidence.finalization.review_identity, frozen.review_identity);
  assert.equal(currentRepaired.json.record.evidence.finalization.verification_identity, frozen.verification_identity);

  for (const [label, options] of [
    ['top-level reviewer may also be a panel member', {
      reviewer: 'shared-current-reviewer', panelReviewer: 'shared-current-reviewer',
    }],
    ['one reviewer may cover multiple unique panel lenses', {
      panelReviewers: ['shared-panel-reviewer', 'shared-panel-reviewer'],
    }],
  ]) {
    const compatible = structuredClone(legacy);
    setActivePass(compatible, options);
    const compatibleHash = sha256(canonical(compatible));
    write(f.integration, path.relative(f.integration, state.file), compatible);
    const accepted = integrationCall(f, 'integrate-reconcile', '--integration', state.file,
      '--expected-record', compatibleHash);
    assert.equal(accepted.status, 0, `${label}: ${accepted.stdout}`);
  }

  const legacyHash = sha256(canonical(legacy));
  write(f.integration, path.relative(f.integration, state.file), legacy);

  const blocked = integrationCall(f, 'close-prepare', '--integration', state.file, '--expected-record', legacyHash);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stdout, /LEGACY_FINALIZATION_RECONCILE_REQUIRED/);
  const repaired = callWithEnv(f.integration, { TERM_SESSION_ID: 'different-terminal' }, pmCli,
    'integrate-reconcile', '--integration', state.file, '--expected-record', legacyHash);
  assert.equal(repaired.status, 0, repaired.stdout);
  assert.equal(repaired.json.record.evidence.finalization.identity, frozen.identity);
  assert.equal(repaired.json.record.report.proof.finalization_identity, frozen.identity);
  assert.equal(repaired.json.record.evidence.reconciliation_history[0].before_hash, legacyHash);
  assert.deepEqual(repaired.json.record.evidence.reconciliation_history[0].before, legacy);

  state.hash = repaired.json.hash;
  state.record = repaired.json.record;
  const continued = callWithEnv(f.integration, { TERM_SESSION_ID: 'another-terminal' }, pmCli,
    'close-prepare', '--integration', state.file, '--expected-record', state.hash);
  assert.equal(continued.status, 0, continued.stdout);

  const missing = structuredClone(legacy);
  missing.evidence.gate_history = [];
  const missingHash = sha256(canonical(missing));
  write(f.integration, path.relative(f.integration, state.file), missing);
  const before = fs.readFileSync(state.file);
  const refused = integrationCall(f, 'integrate-reconcile', '--integration', state.file, '--expected-record', missingHash);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout, /LEGACY_FINALIZATION_MISSING/);
  assert.deepEqual(fs.readFileSync(state.file), before);
});

test('explicit reconciliation validates selected historical receipt identities and keeps valid current replacements', async (t) => {
  const { f, state } = finalizedIntegration(t, { freshEvidence: true });
  const historicalReview = structuredClone(state.record.evidence.review);
  const historicalVerification = structuredClone(state.record.evidence.verification);
  const frozen = structuredClone(state.record.evidence.finalization);

  write(f.integration, '.deliver/integration-review-replacement.json', {
    status: 'PASS', findings: [], panel: { snapshot_hash: state.record.evidence.snapshot_hash, members: [{
      lens: 'code-integrity-reviewer', reviewer: 'current-panel-reviewer', verdict: 'PASS',
      snapshot_hash: state.record.evidence.snapshot_hash, findings: [],
    }] },
  });
  mutateRecord(f, state, 'integrate-review', '--reviewer', 'current-reviewer',
    '--receipt', '.deliver/integration-review-replacement.json');
  write(f.integration, '.deliver/integration-verification-replacement.json', {
    criteria: [{ id: 'AC-1', status: 'PASS', evidence: 'The replacement evidence covers actual M.' }],
  });
  mutateRecord(f, state, 'integrate-verify', '--verifier', 'current-verifier',
    '--results', '.deliver/integration-verification-replacement.json');

  const legacy = structuredClone(state.record);
  delete legacy.evidence.finalization;
  legacy.evidence.finalized = true;
  legacy.evidence.finalized_at = new Date(0).toISOString();
  legacy.evidence.effective_review_identity = '0'.repeat(64);
  legacy.evidence.effective_verification_identity = '0'.repeat(64);
  delete legacy.evidence.finalization_history[0].finalization;
  const sign = (receipt) => {
    const value = structuredClone(receipt);
    delete value.identity;
    value.identity = sha256(canonical(value));
    return value;
  };
  const capture = () => ({
    record: fs.readFileSync(state.file),
    logs: fs.readdirSync(path.join(f.integration, '.deliver', 'logs', `integration-${f.runId}`)).sort()
      .map((name) => [name, sha256(fs.readFileSync(path.join(f.integration, '.deliver', 'logs', `integration-${f.runId}`, name)))]),
    refs: git(f.integration, 'show-ref', '--head'),
    status: git(f.integration, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
  });
  const assertHistoricalVeto = (label, change, pattern) => {
    const invalid = structuredClone(legacy);
    change(invalid);
    const invalidHash = sha256(canonical(invalid));
    write(f.integration, path.relative(f.integration, state.file), invalid);
    const before = capture();
    const result = integrationCall(f, 'integrate-reconcile', '--integration', state.file,
      '--expected-record', invalidHash);
    assert.notEqual(result.status, 0, `${label}: command unexpectedly succeeded`);
    assert.match(result.stdout, pattern, label);
    assert.deepEqual(capture(), before, `${label} changed durable record, logs or refs`);
  };
  const replaceHistoricalReview = (value, change) => {
    const receipt = structuredClone(historicalReview);
    change(receipt);
    value.evidence.review_history[0] = sign(receipt);
    value.evidence.finalization_history[0].review_identity = value.evidence.review_history[0].identity;
  };
  const replaceHistoricalVerification = (value, change) => {
    const receipt = structuredClone(historicalVerification);
    change(receipt);
    value.evidence.verification_history[0] = sign(receipt);
    value.evidence.finalization_history[0].verification_identity = value.evidence.verification_history[0].identity;
  };
  const historicalCases = [
    ['selected historical builder self-review', (value) => replaceHistoricalReview(value,
      (receipt) => { receipt.reviewer = value.source.builder; })],
    ['selected historical missing reviewer', (value) => replaceHistoricalReview(value,
      (receipt) => { delete receipt.reviewer; })],
    ['selected historical malformed reviewer', (value) => replaceHistoricalReview(value,
      (receipt) => { receipt.reviewer = 'historical-reviewer\n'; })],
    ['selected historical builder panel member', (value) => replaceHistoricalReview(value,
      (receipt) => { receipt.panel.members[0].reviewer = value.source.builder; })],
    ['selected historical missing verifier', (value) => replaceHistoricalVerification(value,
      (receipt) => { delete receipt.verifier; })],
    ['selected historical malformed verifier', (value) => replaceHistoricalVerification(value,
      (receipt) => { receipt.verifier = 'historical-verifier\n'; })],
    ['selected historical verifier equals builder', (value) => replaceHistoricalVerification(value,
      (receipt) => { receipt.verifier = value.source.builder; })],
    ['selected historical verifier equals top reviewer', (value) => replaceHistoricalVerification(value,
      (receipt) => { receipt.verifier = historicalReview.reviewer; })],
    ['selected historical verifier equals panel reviewer', (value) => replaceHistoricalVerification(value,
      (receipt) => { receipt.verifier = historicalReview.panel.members[0].reviewer; })],
  ];
  for (const [label, change] of historicalCases) {
    await t.test(label, () => assertHistoricalVeto(label, change, /LEGACY_FINALIZATION_MISSING/));
  }

  const compatible = structuredClone(legacy);
  compatible.evidence.review_history.push(sign({
    ...historicalReview, reviewer: compatible.source.builder, recorded_at: new Date(1).toISOString(),
  }));
  const compatibleHash = sha256(canonical(compatible));
  write(f.integration, path.relative(f.integration, state.file), compatible);
  const repaired = integrationCall(f, 'integrate-reconcile', '--integration', state.file,
    '--expected-record', compatibleHash);
  assert.equal(repaired.status, 0, repaired.stdout);
  assert.equal(repaired.json.record.evidence.finalization.identity, frozen.identity);
  assert.equal(repaired.json.record.evidence.finalization.review_identity, historicalReview.identity);
  assert.equal(repaired.json.record.evidence.finalization.verification_identity, historicalVerification.identity);
  assert.equal(repaired.json.record.evidence.review.reviewer, 'current-reviewer');
  assert.equal(repaired.json.record.evidence.verification.verifier, 'current-verifier');
});

test('closure-only preparations freeze evidence and legacy repair fails closed on ambiguity', (t) => {
  const { f, state } = finalizedIntegration(t);
  const closure = mutateRecord(f, state, 'close-prepare');
  assert.equal(closure.finalization_identity, state.record.evidence.finalization.identity);
  const frozenBytes = fs.readFileSync(state.file);
  const frozenLogs = fs.readdirSync(path.join(f.integration, '.deliver', 'logs', `integration-${f.runId}`)).sort();
  const refusedGate = integrationCall(f, 'integrate-gate', '--integration', state.file,
    '--expected-record', state.hash, '--name', 'test');
  assert.notEqual(refusedGate.status, 0);
  assert.match(refusedGate.stdout, /evidence is frozen/i);
  assert.deepEqual(fs.readFileSync(state.file), frozenBytes);
  assert.deepEqual(fs.readdirSync(path.join(f.integration, '.deliver', 'logs', `integration-${f.runId}`)).sort(), frozenLogs);

  const legacy = structuredClone(state.record);
  const frozen = legacy.evidence.finalization;
  delete legacy.evidence.finalization;
  delete legacy.closure.pending.finalization_identity;
  const ambiguous = structuredClone(legacy);
  const alternativeGate = { ...structuredClone(ambiguous.evidence.gates[0]),
    finished_at: new Date(Date.parse(ambiguous.evidence.gates[0].finished_at) + 2000).toISOString() };
  delete alternativeGate.identity;
  alternativeGate.identity = sha256(canonical(alternativeGate));
  ambiguous.evidence.gate_history.push(alternativeGate);
  ambiguous.evidence.finalization_history.push({
    at: new Date().toISOString(), finalized_at: legacy.evidence.finalized_at,
    review_identity: frozen.review_identity, verification_identity: frozen.verification_identity,
    gates: [alternativeGate.identity], reason: 'ambiguous retained candidate',
  });
  const ambiguousHash = sha256(canonical(ambiguous));
  write(f.integration, path.relative(f.integration, state.file), ambiguous);
  const ambiguousBytes = fs.readFileSync(state.file);
  const refused = integrationCall(f, 'integrate-reconcile', '--integration', state.file, '--expected-record', ambiguousHash);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout, /LEGACY_FINALIZATION_AMBIGUOUS/);
  assert.deepEqual(fs.readFileSync(state.file), ambiguousBytes);

  const oversized = { ...structuredClone(legacy), retained_legacy_padding: 'x'.repeat(4_500_000) };
  const oversizedHash = sha256(canonical(oversized));
  write(f.integration, path.relative(f.integration, state.file), oversized);
  const oversizedBytes = fs.readFileSync(state.file);
  const refusedOversized = integrationCall(f, 'integrate-reconcile', '--integration', state.file,
    '--expected-record', oversizedHash);
  assert.notEqual(refusedOversized.status, 0);
  assert.match(refusedOversized.stdout, /LEGACY_FINALIZATION_TOO_LARGE/);
  assert.deepEqual(fs.readFileSync(state.file), oversizedBytes);

  const legacyHash = sha256(canonical(legacy));
  write(f.integration, path.relative(f.integration, state.file), legacy);
  const repaired = callWithEnv(f.integration, { TERM_SESSION_ID: 'new-terminal' }, pmCli,
    'integrate-reconcile', '--integration', state.file, '--expected-record', legacyHash);
  assert.equal(repaired.status, 0, repaired.stdout);
  assert.equal(repaired.json.record.evidence.finalization.identity, frozen.identity);
  assert.equal(repaired.json.record.closure.pending.finalization_identity, frozen.identity);
});
