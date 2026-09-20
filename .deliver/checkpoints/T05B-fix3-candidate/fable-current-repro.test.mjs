import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  parseStory, readStory, replaceStoryExecution,
} from 'file:///Users/ben/code/pm-skill-codex-worktrees/t05b-delivery/plugins/deliver/skills/deliver/scripts/lib/story.mjs';
import {
  canonical, remoteProviderAttemptIdentity, sha256, validateRemotePublicationRecord,
} from 'file:///Users/ben/code/pm-skill-codex-worktrees/t05b-delivery/plugins/deliver/skills/deliver/scripts/lib/state.mjs';

const integrationApi = await import('file:///Users/ben/code/pm-skill-codex-worktrees/t05b-delivery/plugins/deliver/skills/deliver/scripts/lib/integration.mjs');
const currentPmApi = await import('file:///Users/ben/code/pm-skill-codex-worktrees/t05b-delivery/plugins/deliver/skills/deliver/scripts/lib/current-pm.mjs');
const runtime = fileURLToPath(new URL('file:///Users/ben/code/pm-skill-codex-worktrees/t05b-delivery/plugins/deliver/skills/deliver/scripts/deliver.mjs', import.meta.url));
const pmCli = fileURLToPath(new URL('file:///Users/ben/code/pm-skill-codex-worktrees/t05b-delivery/plugins/deliver/skills/deliver/scripts/pm.mjs', import.meta.url));
const storyRel = 'docs/stories/S1-1-value.md';
const nextStoryRel = 'docs/stories/S1-2-next.md';
const thirdStoryRel = 'docs/stories/S1-3-later.md';
const criterion = 'The remotely integrated value is present.';
const gateCommand = 'node -e "process.exit(0)"';

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function hasCommit(root, oid) {
  return spawnSync('git', ['-C', root, 'cat-file', '-e', `${oid}^{commit}`], {
    stdio: 'ignore', encoding: 'utf8',
  }).status === 0;
}

function serverCommitWithFile(fixture, parent, rel, value, message) {
  const worktree = `${fixture.root}-provider-worktree-${Math.random().toString(16).slice(2)}`;
  try {
    git(fixture.remoteRoot, 'worktree', 'add', '-q', '--detach', worktree, parent);
    write(worktree, rel, value);
    git(worktree, 'add', '--', rel);
    git(worktree, 'commit', '-qm', message);
    return git(worktree, 'rev-parse', 'HEAD');
  } finally {
    try { git(fixture.remoteRoot, 'worktree', 'remove', '--force', worktree); } catch {}
    fs.rmSync(worktree, { recursive: true, force: true });
  }
}

function serverCommitMode(fixture, parent, rel, message) {
  const worktree = `${fixture.root}-provider-mode-${Math.random().toString(16).slice(2)}`;
  try {
    git(fixture.remoteRoot, 'worktree', 'add', '-q', '--detach', worktree, parent);
    git(worktree, 'update-index', '--chmod=+x', '--', rel);
    git(worktree, 'commit', '-qm', message);
    return git(worktree, 'rev-parse', 'HEAD');
  } finally {
    try { git(fixture.remoteRoot, 'worktree', 'remove', '--force', worktree); } catch {}
    fs.rmSync(worktree, { recursive: true, force: true });
  }
}

function serverMergeTree(fixture, base, head) {
  const worktree = `${fixture.root}-provider-merge-${Math.random().toString(16).slice(2)}`;
  try {
    git(fixture.remoteRoot, 'worktree', 'add', '-q', '--detach', worktree, base);
    git(worktree, 'merge', '--no-ff', '--no-commit', head);
    return git(worktree, 'write-tree');
  } finally {
    try { git(fixture.remoteRoot, 'worktree', 'remove', '--force', worktree); } catch {}
    fs.rmSync(worktree, { recursive: true, force: true });
  }
}

function serverTreeWithExtra(fixture, treeOid) {
  const blobFile = `${fixture.root}-provider-extra.txt`;
  fs.writeFileSync(blobFile, 'unproved wrapper path\n');
  const blob = git(fixture.remoteRoot, 'hash-object', '-w', blobFile);
  fs.rmSync(blobFile, { force: true });
  const entries = git(fixture.remoteRoot, 'ls-tree', treeOid);
  return execFileSync('git', ['-C', fixture.remoteRoot, 'mktree'], {
    input: `${entries}\n100644 blob ${blob}\tremote-wrapper-extra.txt\n`, encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function write(root, rel, value) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function call(root, file, ...args) {
  const result = spawnSync(process.execPath, [file, ...args], { cwd: root, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch {}
  return { ...result, json };
}

function story(id, title, acceptance) {
  return [
    `# ${id}: ${title}`,
    '<!-- pm-meta: {"builder":"codex-builder","touches":["src"]} -->',
    `Sprint: 1 · Priority: high · Covers: AC-${id.endsWith('1') ? '001' : '002'} · Depends on: none · Parallel-safe: yes`,
    'Risk: low · Review lenses: code-integrity-reviewer · Specs: none',
    '',
    '## Goal',
    title,
    '',
    '## Acceptance criteria (testable)',
    `- [ ] ${acceptance}`,
    '',
    '## Verification',
    '- Run the declared test gate.',
    '',
  ].join('\n');
}

function finishedRemoteCandidate(t, {
  scale = 'standard', verificationReport = true, prepareRecord = true, multiCommit = false,
  executableArtifacts = false,
} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-remote-source-')));
  const integration = `${root}-integration`;
  const remoteRoot = `${root}-remote.git`;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(integration, { recursive: true, force: true }));
  t.after(() => fs.rmSync(remoteRoot, { recursive: true, force: true }));
  git(root, 'init', '-q', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Casey Example');
  git(root, 'config', 'user.email', 'casey@example.invalid');
  execFileSync('git', ['init', '--bare', '-q', remoteRoot]);
  git(remoteRoot, 'config', 'user.name', 'Remote Provider');
  git(remoteRoot, 'config', 'user.email', 'provider@example.invalid');
  git(root, 'remote', 'add', 'origin', remoteRoot);
  const pm = (...args) => call(root, pmCli, ...args);
  const run = (...args) => call(root, runtime, ...args);
  assert.equal(pm('init').status, 0);
  write(root, 'docs/plan.md', `# Plan\n\n## Delivery mode\n- Scale: ${scale}\n- Checkpoint policy: story-level\n- Integration branch: main\n- Skeleton: none\n`);
  write(root, storyRel, story('S1-1', 'Change value', criterion));
  write(root, nextStoryRel, story('S1-2', 'Continue delivery', 'The next value remains independently claimable.'));
  write(root, thirdStoryRel, story('S1-3', 'Continue later', 'A later value remains independently claimable.'));
  write(root, 'src/value.txt', 'before\n');
  write(root, '.gitignore', '.codex/config.toml\n');
  git(root, 'add', 'docs', 'src', '.gitignore');
  git(root, 'commit', '-qm', 'Planned remote project');
  if (executableArtifacts) {
    const actor = pm('actor-id').json.actor;
    write(root, `docs/handoff/${actor}.md`,
      `# HANDOFF\n\nBASE_COMMIT: ${git(root, 'rev-parse', 'HEAD')}\n`);
    fs.chmodSync(path.join(root, 'docs/handoff', `${actor}.md`), 0o755);
    git(root, 'add', `docs/handoff/${actor}.md`);
    git(root, 'commit', '-qm', 'Track executable handoff contract');
  }
  assert.equal(pm('approve', '--approver', 'Ben').status, 0);
  git(root, 'add', 'docs/approval.json');
  git(root, 'commit', '-qm', 'Approve remote project');
  assert.equal(pm('claim', '--story', storyRel).status, 0);
  git(root, 'add', storyRel);
  git(root, 'commit', '-qm', 'Claim remote story');
  git(root, 'checkout', '-qb', 'pm/S1-1-value');
  if (multiCommit) {
    write(root, 'src/first-source-step.txt', 'first source step\n');
    git(root, 'add', 'src/first-source-step.txt');
    git(root, 'commit', '-qm', 'First source branch step');
  }
  write(root, '.deliver/task.json', {
    id: 'S1-1', objective: 'Change the value through the remote lifecycle.',
    acceptance: [{ id: 'AC-1', text: criterion }], read_paths: [storyRel], touches: ['src'],
    commands: { test: gateCommand }, specs: [],
  });
  const initialized = run('init', '--mode', 'quick');
  assert.equal(initialized.status, 0, initialized.stdout);
  const runId = initialized.json.run_id;
  const runFile = path.join(root, '.deliver/runs', `${runId}.json`);
  assert.equal(run('start', '--run', runId, '--task', '.deliver/task.json', '--builder', 'source-builder',
    '--story', storyRel).status, 0);
  for (const status of ['building', 'built', 'in-review']) {
    const transitioned = pm('transition', '--run', runId, '--to', status);
    assert.equal(transitioned.status, 0, transitioned.stdout);
  }
  write(root, 'src/value.txt', 'remote candidate\n');
  const commitPreparation = run('commit-prepare', '--run', runId);
  assert.equal(commitPreparation.status, 0, commitPreparation.stdout);
  git(root, 'add', '-A', '--', ...commitPreparation.json.preparation.paths);
  git(root, 'commit', '-qm', 'Candidate C');
  const candidate = git(root, 'rev-parse', 'HEAD');
  assert.equal(run('commit-adopt', '--run', runId, '--token', commitPreparation.json.preparation.token,
    '--commit', candidate).status, 0);
  const checked = run('check', '--run', runId);
  assert.equal(checked.status, 0, checked.stdout);
  assert.equal(run('gate', '--run', runId, '--name', 'test', '--command', gateCommand).status, 0);
  write(root, '.deliver/source-review.json', {
    status: 'PASS', findings: [], panel: { snapshot_hash: checked.json.snapshot_hash, members: [{
      lens: 'code-integrity-reviewer', reviewer: 'source-panel-reviewer', verdict: 'PASS',
      snapshot_hash: checked.json.snapshot_hash, findings: [],
    }] },
  });
  assert.equal(run('review', '--run', runId, '--snapshot', checked.json.snapshot_hash,
    '--reviewer', 'source-reviewer', '--receipt', '.deliver/source-review.json').status, 0);
  write(root, '.deliver/source-verification.json', {
    criteria: [{ id: 'AC-1', status: 'PASS', evidence: 'Source candidate passed its declared gate.' }],
  });
  assert.equal(run('verify', '--run', runId, '--snapshot', checked.json.snapshot_hash,
    '--verifier', 'source-verifier', '--results', '.deliver/source-verification.json').status, 0);
  assert.equal(run('finish', '--run', runId).status, 0);
  const sourceBytes = fs.readFileSync(runFile, 'utf8');
  const sourceCounters = structuredClone(JSON.parse(sourceBytes).counters);
  git(root, 'worktree', 'add', '-q', integration, 'main');
  git(root, 'push', '-q', 'origin', 'main:main');
  const prepared = prepareRecord ? integrationApi.prepareLocalIntegration(runFile, {
    integrationRoot: integration, verificationReport,
  }, integration) : null;
  return {
    root, integration, remoteRoot, runId, runFile, candidate, sourceBytes, sourceCounters,
    executableArtifacts,
    record: prepared ? { file: prepared.file, record: prepared.record, hash: prepared.hash } : null,
  };
}

function nextRemoteCandidate(t, prior, storyPath = nextStoryRel) {
  const { integration, remoteRoot } = prior.fixture;
  const claimed = call(integration, pmCli, 'claim', '--story', storyPath);
  assert.equal(claimed.status, 0, claimed.stdout);
  git(integration, 'add', storyPath);
  git(integration, 'commit', '-qm', 'Claim second remote story');
  git(integration, 'push', '-q', 'origin', 'main:main');
  const root = `${prior.fixture.root}-second-source`;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const branch = readStory(integration, storyPath).execution.branch;
  git(integration, 'worktree', 'add', '-q', '-b', branch, root, 'main');
  const pm = (...args) => call(root, pmCli, ...args);
  const run = (...args) => call(root, runtime, ...args);
  write(root, '.deliver/task.json', {
    id: 'S1-2', objective: 'Complete a second remote story.',
    acceptance: [{ id: 'AC-1', text: 'The next value remains independently claimable.' }],
    read_paths: [storyPath], touches: ['src'], commands: { test: gateCommand }, specs: [],
  });
  const initialized = run('init', '--mode', 'quick');
  assert.equal(initialized.status, 0, initialized.stdout);
  const runId = initialized.json.run_id;
  const runFile = path.join(root, '.deliver/runs', `${runId}.json`);
  const started = run('start', '--run', runId, '--task', '.deliver/task.json', '--builder', 'second-builder',
    '--story', storyPath);
  assert.equal(started.status, 0, started.stdout);
  for (const status of ['building', 'built', 'in-review']) {
    const transitioned = pm('transition', '--run', runId, '--to', status);
    assert.equal(transitioned.status, 0, transitioned.stdout);
  }
  write(root, 'src/second.txt', 'second remote candidate\n');
  const commitPreparation = run('commit-prepare', '--run', runId);
  assert.equal(commitPreparation.status, 0, commitPreparation.stdout);
  git(root, 'add', '-A', '--', ...commitPreparation.json.preparation.paths);
  git(root, 'commit', '-qm', 'Second candidate C');
  const candidate = git(root, 'rev-parse', 'HEAD');
  assert.equal(run('commit-adopt', '--run', runId, '--token', commitPreparation.json.preparation.token,
    '--commit', candidate).status, 0);
  const checked = run('check', '--run', runId);
  assert.equal(checked.status, 0, checked.stdout);
  assert.equal(run('gate', '--run', runId, '--name', 'test', '--command', gateCommand).status, 0);
  write(root, '.deliver/source-review.json', {
    status: 'PASS', findings: [], panel: { snapshot_hash: checked.json.snapshot_hash, members: [{
      lens: 'code-integrity-reviewer', reviewer: 'second-panel-reviewer', verdict: 'PASS',
      snapshot_hash: checked.json.snapshot_hash, findings: [],
    }] },
  });
  assert.equal(run('review', '--run', runId, '--snapshot', checked.json.snapshot_hash,
    '--reviewer', 'second-reviewer', '--receipt', '.deliver/source-review.json').status, 0);
  write(root, '.deliver/source-verification.json', {
    criteria: [{ id: 'AC-1', status: 'PASS', evidence: 'Second source candidate passed.' }],
  });
  assert.equal(run('verify', '--run', runId, '--snapshot', checked.json.snapshot_hash,
    '--verifier', 'second-verifier', '--results', '.deliver/source-verification.json').status, 0);
  assert.equal(run('finish', '--run', runId).status, 0);
  const sourceBytes = fs.readFileSync(runFile, 'utf8');
  const sourceCounters = structuredClone(JSON.parse(sourceBytes).counters);
  const prepared = integrationApi.prepareLocalIntegration(runFile, {
    integrationRoot: integration, verificationReport: true,
  }, integration);
  return {
    root, integration, remoteRoot, runId, runFile, candidate, sourceBytes, sourceCounters,
    record: { file: prepared.file, record: prepared.record, hash: prepared.hash },
  };
}

function wrapperState(wrapper) {
  return { file: wrapper.file, record: wrapper.record, hash: wrapper.hash };
}

function reidentify(value) {
  const body = structuredClone(value);
  delete body.identity;
  return { ...body, identity: sha256(canonical(body)) };
}

function freshProcessPublicationReconcile(t, fixture, {
  functionName, operation, file, hash, cwd, prNumber, mergeCommit,
}) {
  const child = `${fixture.root}-${operation}-fresh-reconcile.mjs`;
  t.after(() => fs.rmSync(child, { force: true }));
  const integrationUrl = new URL('file:///Users/ben/code/pm-skill-codex-worktrees/t05b-delivery/plugins/deliver/skills/deliver/scripts/lib/integration.mjs', import.meta.url).href;
  fs.writeFileSync(child, [
    "import { execFileSync } from 'node:child_process';",
    `import * as integration from ${JSON.stringify(integrationUrl)};`,
    'const [functionName, file, hash, cwd, prText, mergeCommit] = process.argv.slice(2);',
    'const prNumber = Number(prText); let reconcileCalls = 0; let fetchCalls = 0;',
    "const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();",
    "const repository = { host: 'github.example.test', owner: 'Example', name: 'Project', slug: 'github.example.test/Example/Project' };",
    'const provider = {',
    "  publish() { throw new Error('fresh reconcile must not publish'); },",
    "  merge() { throw new Error('fresh reconcile must not issue another merge'); },",
    "  inspect() { throw new Error('fresh reconcile must use merge reconciliation'); },",
    '  reconcileMerged(target, options) {',
    '    reconcileCalls += 1;',
    "    if (options.prNumber !== prNumber) throw new Error('fresh reconcile changed PR identity');",
    "    return { stage: 'postmerge', state: 'MERGED', expectedHead: target.expectedHead, repository,",
    "      pr: { number: prNumber, state: 'MERGED', isDraft: false, headRefName: target.storyBranch,",
    "        headRefOid: target.expectedHead, baseRefName: target.integrationBranch,",
    "        headRepositoryOwner: { login: 'Example' }, url: `https://github.example.test/Example/Project/pull/${prNumber}`,",
    '        mergeCommit: { oid: mergeCommit } }, mergeCommit, remoteBase: mergeCommit };',
    '  },',
    '};',
    'const fetchRemote = ({ root, remote, branch, proofRef, expectedRemoteOid }) => {',
    '  fetchCalls += 1;',
    "  git(root, 'fetch', '-q', '--no-tags', remote, `refs/heads/${branch}:${proofRef}`);",
    "  const oid = git(root, 'rev-parse', '--verify', proofRef);",
    "  if (oid !== expectedRemoteOid) throw new Error('fresh reconcile fetched unexpected remote object');",
    "  return { state: 'FETCHED', oid };",
    '};',
    'const value = integration[functionName](file, { expectedRecordHash: hash, prNumber, provider, fetchRemote }, cwd);',
    'process.stdout.write(JSON.stringify({ value, reconcileCalls, fetchCalls }));',
  ].join('\n'));
  const result = spawnSync(process.execPath, [child, functionName, file, hash, cwd,
    String(prNumber), mergeCommit], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function freshProcessArtifactResume(root, { functionName, file, hash, cwd, options = {} }) {
  const child = path.join(root, '.deliver', `${functionName}-fresh-resume-${Math.random().toString(16).slice(2)}.mjs`);
  const integrationUrl = new URL('file:///Users/ben/code/pm-skill-codex-worktrees/t05b-delivery/plugins/deliver/skills/deliver/scripts/lib/integration.mjs', import.meta.url).href;
  fs.writeFileSync(child, [
    `import * as integration from ${JSON.stringify(integrationUrl)};`,
    'const [functionName, file, hash, cwd, optionsText] = process.argv.slice(2);',
    'const options = JSON.parse(optionsText);',
    'const value = integration[functionName](file, { expectedRecordHash: hash, ...options }, cwd);',
    'process.stdout.write(JSON.stringify(value));',
  ].join('\n'));
  try {
    const result = spawnSync(process.execPath, [child, functionName, file, hash, cwd,
      JSON.stringify(options)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    fs.rmSync(child, { force: true });
  }
}

function refreshPreparedSupersession(attempt) {
  const transition = attempt.transitions[0];
  transition.supersession = reidentify(transition.supersession);
  attempt.transitions[0] = reidentify(transition);
  attempt.identity = remoteProviderAttemptIdentity(attempt);
}

function reidentifyAttemptTransitions(attempt) {
  let previous = null;
  attempt.transitions = attempt.transitions.map((transition) => {
    const next = reidentify({ ...transition, previous });
    previous = next.identity;
    return next;
  });
  attempt.identity = remoteProviderAttemptIdentity(attempt);
}

function expectedLatestProviderObservation(attempt) {
  const observation = structuredClone(attempt.input.remote_observation);
  const observed = attempt.transitions.at(-1);
  if (observed?.state !== 'observed') return observation;
  const result = observed.result;
  if (result.repository && typeof result.repository === 'object' && !Array.isArray(result.repository)) {
    observation.repository_identity = sha256(canonical(result.repository));
  }
  if (Number.isSafeInteger(result.pr?.number) && result.pr.number > 0) {
    observation.pr_number = result.pr.number;
  }
  if (typeof result.pr?.headRefName === 'string' && result.pr.headRefName) {
    observation.story_branch = result.pr.headRefName;
  }
  if (typeof result.pr?.baseRefName === 'string' && result.pr.baseRefName) {
    observation.integration_branch = result.pr.baseRefName;
  }
  if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(result.pr?.headRefOid || '')) {
    observation.observed_remote_head = result.pr.headRefOid;
  }
  if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(result.remoteBase || '')) {
    observation.observed_remote_base = result.remoteBase;
  }
  observation.result_identity = observed.result_identity;
  return observation;
}

function assertSupersessionTamperRejections(wrapper, selectSlot, invoke, providerWrites) {
  const pristine = fs.readFileSync(wrapper.file, 'utf8');
  const cases = [
    ['broken predecessor reciprocal link', ({ predecessor }) => {
      predecessor.superseded_by = null;
      predecessor.identity = remoteProviderAttemptIdentity(predecessor);
    }],
    ['broken successor reciprocal link', ({ successor }) => {
      successor.supersedes = null;
      successor.identity = remoteProviderAttemptIdentity(successor);
    }],
    ['rebound predecessor attempt identity', ({ successor }) => {
      successor.transitions[0].supersession.predecessor_attempt_identity = '0'.repeat(64);
      refreshPreparedSupersession(successor);
    }],
    ['rebound prior observation identity', ({ successor }) => {
      successor.transitions[0].supersession.prior_observation_identity = '0'.repeat(64);
      refreshPreparedSupersession(successor);
    }],
    ['rebound current observation identity', ({ successor }) => {
      successor.transitions[0].supersession.current_observation_identity = '1'.repeat(64);
      refreshPreparedSupersession(successor);
    }],
    ['rebound changed fields', ({ successor }) => {
      successor.transitions[0].supersession.changed_fields = [];
      refreshPreparedSupersession(successor);
    }],
    ['rebound predecessor effect history', ({ successor }) => {
      const proof = successor.transitions[0].supersession;
      proof.predecessor_effect = proof.predecessor_effect === null
        ? reidentify({ attempt_identity: '0'.repeat(64), result_identity: '1'.repeat(64), proof_identity: null })
        : reidentify({ ...proof.predecessor_effect, result_identity: '1'.repeat(64) });
      proof.predecessor_effect_identity = proof.predecessor_effect.identity;
      refreshPreparedSupersession(successor);
    }],
  ];
  for (const [label, mutate] of cases) {
    const record = JSON.parse(pristine);
    const slot = selectSlot(record);
    const predecessor = slot.attempts[0];
    const successor = slot.attempts[1];
    mutate({ slot, predecessor, successor });
    const bytes = `${JSON.stringify(record, null, 2)}\n`;
    fs.writeFileSync(wrapper.file, bytes);
    const writesBefore = providerWrites();
    assert.throws(() => invoke(sha256(canonical(record))),
      /invalid|supersess|reciprocal|observation|effect|binding|evidence/i, label);
    assert.equal(providerWrites(), writesBefore, `${label} refuses before a provider write`);
    assert.equal(fs.readFileSync(wrapper.file, 'utf8'), bytes, `${label} refusal leaves the record unchanged`);
    fs.writeFileSync(wrapper.file, pristine);
  }
}

function fixtureArtifact(root, rel) {
  const file = path.join(root, rel);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function restoreFixtureArtifact(root, rel, value) {
  const file = path.join(root, rel);
  if (value === null) fs.rmSync(file, { force: true });
  else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  }
}

function assertPendingResumeRejectsUnrelatedStatus({ root, wrapper, writes, resume }) {
  const recordBytes = fs.readFileSync(wrapper.file, 'utf8');
  const trackedRel = 'src/value.txt';
  const trackedFile = path.join(root, trackedRel);
  const trackedBytes = fs.readFileSync(trackedFile, 'utf8');
  const untrackedRel = 'src/unrelated-pending-resume.txt';
  const untrackedFile = path.join(root, untrackedRel);
  const cases = [
    ['unstaged', () => fs.writeFileSync(trackedFile, `${trackedBytes}unstaged unrelated bytes\n`), () => {
      fs.writeFileSync(trackedFile, trackedBytes);
    }],
    ['staged', () => {
      fs.writeFileSync(trackedFile, `${trackedBytes}staged unrelated bytes\n`);
      git(root, 'add', '--', trackedRel);
    }, () => {
      git(root, 'reset', '-q', 'HEAD', '--', trackedRel);
      fs.writeFileSync(trackedFile, trackedBytes);
    }],
    ['untracked', () => fs.writeFileSync(untrackedFile, 'untracked unrelated bytes\n'), () => {
      fs.rmSync(untrackedFile, { force: true });
    }],
  ];
  for (const [label, setup, cleanup] of cases) {
    for (const item of writes) restoreFixtureArtifact(root, item.path, item.before);
    setup();
    const statusBefore = git(root, 'status', '--porcelain=v1', '--untracked-files=all');
    const ownedBefore = writes.map((item) => fixtureArtifact(root, item.path));
    const unrelatedBefore = label === 'untracked' ? fs.readFileSync(untrackedFile, 'utf8')
      : fs.readFileSync(trackedFile, 'utf8');
    let refusal = null;
    try { resume(); } catch (error) { refusal = error; }
    const recordAfter = fs.readFileSync(wrapper.file, 'utf8');
    const statusAfter = git(root, 'status', '--porcelain=v1', '--untracked-files=all');
    const ownedAfter = writes.map((item) => fixtureArtifact(root, item.path));
    const unrelatedAfter = label === 'untracked' ? fs.readFileSync(untrackedFile, 'utf8')
      : fs.readFileSync(trackedFile, 'utf8');
    cleanup();
    for (const item of writes) restoreFixtureArtifact(root, item.path, item.after);
    assert(refusal, `${label} unrelated status must refuse pending-image recovery`);
    assert.match(refusal.message, /clean|status|unrelated|pending|checkout|changed|resume/i);
    assert.equal(recordAfter, recordBytes);
    assert.deepEqual(ownedAfter, ownedBefore, `${label} refusal preserves every owned pending path`);
    assert.equal(unrelatedAfter, unrelatedBefore, `${label} refusal preserves unrelated bytes`);
    assert.equal(statusAfter, statusBefore, `${label} refusal preserves exact Git status`);
  }
}

function assertGeneratedPendingTamperRejected({ root, wrapper, selectPending, resume, multipleWrites }) {
  const pristine = fs.readFileSync(wrapper.file, 'utf8');
  const pristineRecord = JSON.parse(pristine);
  const retained = selectPending(pristineRecord);
  const retainedWrites = multipleWrites ? retained.writes : [retained.write];
  const extraRel = 'src/unexpected-generated-resume.txt';
  for (const [label, mutate] of [
    ['generated after-image', (pending) => {
      const write = multipleWrites ? pending.writes[0] : pending.write;
      write.after = `${write.after}\nforged generated image\n`;
      write.hash = sha256(write.after);
    }],
    ['pending write shape', (pending) => {
      const extra = { path: extraRel, before: null, after: 'forged extra pending write\n' };
      extra.hash = sha256(extra.after);
      if (multipleWrites) pending.writes.push(extra);
      else pending.write = extra;
    }],
  ]) {
    const record = JSON.parse(pristine);
    mutate(selectPending(record));
    const bytes = `${JSON.stringify(record, null, 2)}\n`;
    fs.writeFileSync(wrapper.file, bytes);
    for (const item of retainedWrites) restoreFixtureArtifact(root, item.path, item.before);
    fs.rmSync(path.join(root, extraRel), { force: true });
    let refusal = null;
    try { resume(sha256(canonical(record))); } catch (error) { refusal = error; }
    const recordAfter = fs.readFileSync(wrapper.file, 'utf8');
    const ownedAfter = retainedWrites.map((item) => fixtureArtifact(root, item.path));
    const extraExists = fs.existsSync(path.join(root, extraRel));
    fs.writeFileSync(wrapper.file, pristine);
    fs.rmSync(path.join(root, extraRel), { force: true });
    for (const item of retainedWrites) restoreFixtureArtifact(root, item.path, item.after);
    assert(refusal, `${label} tampering must refuse retained pending recovery`);
    assert.match(refusal.message, /generated|image|pending|preparation|shape|write|invalid|differ|changed/i);
    assert.equal(recordAfter, bytes, `${label} refusal leaves the record unchanged`);
    assert.deepEqual(ownedAfter, retainedWrites.map((item) => item.before),
      `${label} refusal leaves owned paths at the exact before image`);
    assert.equal(extraExists, false, `${label} refusal does not create an unowned path`);
  }
}

function exerciseRemoteArtifactPendingResume({ root, wrapper, selectPending, resume, freshResume }) {
  const pending = selectPending(wrapper.record);
  const recordBytes = fs.readFileSync(wrapper.file, 'utf8');
  const resumedAfter = freshResume(wrapper.hash);
  assert.equal(resumedAfter.hash, wrapper.hash);
  assert.equal(resumedAfter.result.token, wrapper.result.token);
  assert.deepEqual(selectPending(resumedAfter.record), pending);
  assert.equal(fs.readFileSync(wrapper.file, 'utf8'), recordBytes);
  for (const item of pending.writes) restoreFixtureArtifact(root, item.path, item.before);
  const resumedBefore = freshResume(wrapper.hash);
  assert.equal(resumedBefore.hash, wrapper.hash);
  assert.equal(resumedBefore.result.token, wrapper.result.token);
  assert.deepEqual(selectPending(resumedBefore.record), pending);
  assert.equal(fs.readFileSync(wrapper.file, 'utf8'), recordBytes);
  for (const item of pending.writes) {
    assert.equal(fixtureArtifact(root, item.path), item.after);
  }
  assertPendingResumeRejectsUnrelatedStatus({ root, wrapper, writes: pending.writes,
    resume: () => resume(wrapper.hash) });
  assertGeneratedPendingTamperRejected({
    root, wrapper, selectPending, resume, multipleWrites: true,
  });
}

function assertAdoptedArtifactGeneration(record, field, retainedGeneration, root) {
  const proof = record.remote.closure.artifacts[field].proof;
  assert.deepEqual(proof.generation, retainedGeneration,
    `${field} proof retains the exact identified generation used by its pending image`);
  assert.equal(proof.generation.identity, retainedGeneration.identity);
  assert.equal(proof.generation.source_proof.identity, record.remote.source.proof.identity,
    `${field} generation remains bound to the source proof`);
  assert.equal(proof.generation.finalization.identity,
    record.remote.integration_evidence.finalization.identity,
    `${field} generation remains bound to remote-M finalization`);
  assert.equal(proof.generation.view.integration.commit,
    record.remote.integration_evidence.commit,
    `${field} generation view remains bound to frozen M`);
  if (typeof proof.generation.inputs.story_before === 'string') {
    const committed = execFileSync('git', ['-C', root, 'show',
      `${proof.parent}:${record.source.story_path}`], { encoding: 'utf8' });
    assert.equal(proof.generation.inputs.story_before, committed,
      `${field} generation story input is the independently committed parent image`);
    const story = parseStory(committed, record.source.story_path);
    assert.equal(story.contractHash, record.source.contract_hash);
    assert.equal(story.executionHash, record.source.execution_hash);
    assert.equal(story.execution.status, 'in-review');
  }
  const rebound = structuredClone(record);
  const reboundProof = rebound.remote.closure.artifacts[field].proof;
  reboundProof.generation.finalization.identity = '0'.repeat(64);
  reboundProof.generation = reidentify(reboundProof.generation);
  rebound.remote.closure.artifacts[field].proof = reidentify(reboundProof);
  assert.throws(() => validateRemotePublicationRecord(rebound),
    /generation|finalization|artifact|binding|remote publication evidence/i,
    `${field} proof refuses a coherently reidentified generation rebound away from finalization`);
}

function assertPendingStoryRebindingRejected({ root, wrapper, resume }) {
  const pristineRecordBytes = fs.readFileSync(wrapper.file, 'utf8');
  const forged = JSON.parse(pristineRecordBytes);
  const pending = forged.remote.closure.artifacts.closure.pending;
  const write = pending.writes[0];
  const originalStory = parseStory(pending.generation.inputs.story_before, write.path);
  const altered = replaceStoryExecution(originalStory, {
    rounds: originalStory.execution.rounds + 1,
  });
  const alteredStory = parseStory(altered.after, write.path);
  const closed = replaceStoryExecution(alteredStory, {
    status: 'merged', updated: pending.generation.inputs.closed_at,
  }, { note: `${pending.generation.inputs.closed_at} remotely integrated at ${forged.remote.integration_evidence.commit}` });
  pending.generation.inputs.story_before = altered.after;
  pending.generation.inputs.execution_hash = closed.executionHash;
  pending.generation = reidentify(pending.generation);
  write.after = closed.after;
  write.hash = sha256(write.after);
  pending.identity = reidentify(pending).identity;
  const forgedBytes = `${JSON.stringify(forged, null, 2)}\n`;
  fs.writeFileSync(wrapper.file, forgedBytes);
  fs.writeFileSync(path.join(root, ...write.path.split('/')), originalStory.text);
  const statusBefore = git(root, 'status', '--porcelain=v1', '--untracked-files=all');
  let refusal = null;
  try { resume(sha256(canonical(forged))); } catch (error) { refusal = error; }
  const recordAfter = fs.readFileSync(wrapper.file, 'utf8');
  const storyAfter = fs.readFileSync(path.join(root, ...write.path.split('/')), 'utf8');
  const statusAfter = git(root, 'status', '--porcelain=v1', '--untracked-files=all');
  fs.writeFileSync(wrapper.file, pristineRecordBytes);
  fs.writeFileSync(path.join(root, ...write.path.split('/')), originalStory.text);
  assert(refusal, 'reidentified pending story counters must refuse against the committed parent and source proof');
  assert.match(refusal.message, /generation|story|parent|source|execution|identity|binding|committed/i);
  assert.equal(recordAfter, forgedBytes);
  assert.equal(storyAfter, originalStory.text);
  assert.equal(statusAfter, statusBefore,
    'pending story rebind refusal leaves its exact checkout state unchanged');
}

function refreshFinalizedEvidence(record, { review = false, verification = false } = {}) {
  const evidence = record.remote.integration_evidence;
  if (review) evidence.review = reidentify(evidence.review);
  if (verification) evidence.verification = reidentify(evidence.verification);
  if (review) evidence.finalization.review = evidence.review.identity;
  if (verification) evidence.finalization.verification = evidence.verification.identity;
  evidence.finalization = reidentify(evidence.finalization);
}

function assertFinalReceiptTamperRejections(record) {
  assert.doesNotThrow(() => validateRemotePublicationRecord(record));
  const evidence = record.remote.integration_evidence;
  const requirements = evidence.finalization.review_requirements;
  assert(requirements, 'finalization retains identified review requirements from frozen M');
  const storyBytes = execFileSync('git', ['-C', evidence.root, 'show',
    `${evidence.commit}:${record.source.story_path}`]);
  const frozenStory = parseStory(storyBytes.toString('utf8'), record.source.story_path);
  assert.equal(requirements.version, 'remote-review-requirements-v1');
  assert.equal(requirements.commit, evidence.commit);
  assert.equal(requirements.story_path, record.source.story_path);
  assert.equal(requirements.story_before, storyBytes.toString('utf8'));
  assert.equal(requirements.story_hash, sha256(storyBytes));
  const manifestStory = evidence.manifest.entries[record.source.story_path];
  const manifestStoryMatch = /^file:(644|755):([0-9a-f]{64})$/.exec(manifestStory);
  assert(manifestStoryMatch, 'frozen M manifest retains the story file identity');
  assert.equal(requirements.story_mode, `100${manifestStoryMatch[1]}`);
  assert.equal(requirements.story_hash, manifestStoryMatch[2]);
  assert.equal(requirements.contract_hash, record.source.contract_hash);
  assert.equal(requirements.execution_hash, record.source.execution_hash);
  assert.equal(requirements.scale, record.plan.scale);
  assert.equal(requirements.reporting, record.reporting);
  assert.deepEqual(requirements.required_lenses,
    record.reporting === 'skipped' ? [] : [...new Set(frozenStory.reviewLenses)].sort());
  assert.equal(requirements.identity, reidentify(requirements).identity);
  const cases = [
    ['missing acceptance criterion', (next) => {
      next.remote.integration_evidence.verification.criteria = [];
      refreshFinalizedEvidence(next, { verification: true });
    }],
    ['invented acceptance criterion', (next) => {
      next.remote.integration_evidence.verification.criteria = [{
        id: 'AC-INVENTED', status: 'PASS', evidence: 'Invented criterion cannot replace AC-1.',
      }];
      refreshFinalizedEvidence(next, { verification: true });
    }],
    ['duplicate acceptance criterion', (next) => {
      next.remote.integration_evidence.verification.criteria.push(
        structuredClone(next.remote.integration_evidence.verification.criteria[0]));
      refreshFinalizedEvidence(next, { verification: true });
    }],
    ['reviewer equals source builder', (next) => {
      next.remote.integration_evidence.review.reviewer = next.source.builder;
      refreshFinalizedEvidence(next, { review: true });
    }],
    ['verifier equals source builder', (next) => {
      next.remote.integration_evidence.verification.verifier = next.source.builder;
      refreshFinalizedEvidence(next, { verification: true });
    }],
    ['verifier equals top-level reviewer', (next) => {
      next.remote.integration_evidence.verification.verifier = next.remote.integration_evidence.review.reviewer;
      refreshFinalizedEvidence(next, { verification: true });
    }],
    ['verifier equals panel reviewer', (next) => {
      next.remote.integration_evidence.verification.verifier =
        next.remote.integration_evidence.review.panel.members[0].reviewer;
      refreshFinalizedEvidence(next, { verification: true });
    }],
    ['duplicate panel lens', (next) => {
      const panel = next.remote.integration_evidence.review.panel;
      panel.members.push({ ...structuredClone(panel.members[0]), reviewer: 'duplicate-lens-reviewer' });
      refreshFinalizedEvidence(next, { review: true });
    }],
  ];
  for (const [label, mutate] of cases) {
    const forged = structuredClone(record);
    mutate(forged);
    const forgedBeforeValidation = canonical(forged);
    assert.throws(() => validateRemotePublicationRecord(forged),
      /acceptance|criteria|reviewer|verifier|panel|lens|independent|finalization|remote publication evidence/i,
      label);
    assert.equal(canonical(forged), forgedBeforeValidation,
      `${label} validation leaves the forged record unchanged`);
  }
}

function assertFinalReceiptPublicRefusals(wrapper, integration) {
  const pristineBytes = fs.readFileSync(wrapper.file, 'utf8');
  const pristineAdmission = currentPmApi.remoteAdmissionStatus(integration);
  assert.equal(pristineAdmission.state, 'REMOTE_PENDING',
    'a pristine finalized remote M is accepted before closure artifacts exist');
  assert.equal(fs.readFileSync(wrapper.file, 'utf8'), pristineBytes,
    'pristine finalized-M admission is read-only');
  const cases = [
    ['required review lens removed from an otherwise reidentified receipt', (record) => {
      record.remote.integration_evidence.review.panel.members = [];
      refreshFinalizedEvidence(record, { review: true });
    }],
    ['review requirements rebound away from the frozen M story', (record) => {
      const finalization = record.remote.integration_evidence.finalization;
      finalization.review_requirements.required_lenses = [];
      finalization.review_requirements = reidentify(finalization.review_requirements);
      record.remote.integration_evidence.finalization = reidentify(finalization);
    }],
  ];
  for (const [label, mutate] of cases) {
    const forged = JSON.parse(pristineBytes);
    mutate(forged);
    const forgedBytes = `${JSON.stringify(forged, null, 2)}\n`;
    fs.writeFileSync(wrapper.file, forgedBytes);
    const admission = currentPmApi.remoteAdmissionStatus(integration);
    assert.equal(admission.state, 'UNKNOWN', label);
    assert.equal(admission.blocking, true, label);
    assert.equal(fs.readFileSync(wrapper.file, 'utf8'), forgedBytes,
      `${label} admission leaves the forged record unchanged`);
    let refusal = null;
    try {
      integrationApi.prepareRemoteClosureCheckout(wrapper.file, {
        expectedRecordHash: sha256(canonical(forged)),
      }, integration);
    } catch (error) {
      refusal = error;
    }
    assert(refusal, `${label} must refuse public closure preparation`);
    assert.match(refusal.message, /review|lens|requirements|story|evidence|finalization|invalid|binding/i);
    assert.equal(fs.readFileSync(wrapper.file, 'utf8'), forgedBytes,
      `${label} closure refusal leaves the forged record unchanged`);
    fs.writeFileSync(wrapper.file, pristineBytes);
  }
  assert.equal(fs.readFileSync(wrapper.file, 'utf8'), pristineBytes,
    'receipt semantic mutations restore the pristine finalized-M record');
}

function providerFixture(fixture) {
  const repository = {
    host: 'github.example.test', owner: 'Example', name: 'Project',
    slug: 'github.example.test/Example/Project',
  };
  const calls = [];
  const state = {
    prNumber: 17, ready: true, merged: false, mergeCommit: null, remoteBase: null,
    publishState: 'PUBLISHED', readinessState: 'READY', mergeState: 'MERGED', reconcileState: null,
    publishedHead: null, rebaseExtra: false, rebaseUnauthorized: false, rebaseComposeBase: false,
    rebaseActualRange: false, rebaseExtraCommit: null, rebaseRevertCommit: null,
    advanceBeforeMerge: false, advancedBase: null,
    advancePath: 'src/concurrent.txt', advanceValue: 'preserve concurrent integration change\n',
    advanceModePath: null, racedTreeMode: 'combine',
    inspectHead: null, inspectRemoteBase: null,
    squashParent: null, squashComposeBase: false,
  };
  const publicPr = (target) => ({
    number: state.prNumber, state: state.merged ? 'MERGED' : 'OPEN', isDraft: false,
    headRefName: target.storyBranch, headRefOid: state.inspectHead || target.expectedHead,
    baseRefName: target.integrationBranch, headRepositoryOwner: { login: 'Example' },
    url: `https://github.example.test/Example/Project/pull/${state.prNumber}`,
    mergeCommit: state.mergeCommit ? { oid: state.mergeCommit } : null,
  });
  const result = (target, stage, providerState, extra = {}) => ({
    stage, state: providerState, expectedHead: target.expectedHead, repository,
    pr: publicPr(target), ...extra,
  });
  const provider = {
    publish(target, options) {
      calls.push({ method: 'publish', target: structuredClone(target), options: structuredClone(options) });
      if (state.publishState !== 'PUBLISHED') return result(target, 'publish', state.publishState);
      git(target.root, 'push', '-q', target.remote,
        `${target.expectedHead}:refs/heads/${target.storyBranch}`);
      if (state.publishedHead && state.publishedHead !== target.expectedHead) state.prNumber += 1;
      state.publishedHead = target.expectedHead;
      state.merged = false;
      state.mergeCommit = null;
      state.remoteBase = null;
      return result(target, 'publish', 'PUBLISHED');
    },
    inspect(target) {
      calls.push({ method: 'inspect', target: structuredClone(target) });
      return result(target, 'checks', state.readinessState, {
        ...(state.inspectRemoteBase ? { remoteBase: state.inspectRemoteBase } : {}),
        checks: state.readinessState === 'READY'
          ? [{ name: 'test', state: 'SUCCESS', bucket: 'pass', workflow: 'ci' }]
          : [{ name: 'test', state: 'PENDING', bucket: 'pending', workflow: 'ci' }],
      });
    },
    merge(target, options) {
      calls.push({ method: 'merge', target: structuredClone(target), options: structuredClone(options) });
      if (state.mergeState !== 'MERGED') return result(target, 'postmerge', state.mergeState);
      let base = git(fixture.remoteRoot, 'rev-parse', `refs/heads/${target.integrationBranch}`);
      if (state.advanceBeforeMerge) {
        const advanced = state.advanceModePath
          ? serverCommitMode(fixture, base, state.advanceModePath, 'Concurrent integration mode N')
          : serverCommitWithFile(fixture, base, state.advancePath,
            state.advanceValue, 'Concurrent integration N');
        git(fixture.remoteRoot, 'update-ref', `refs/heads/${target.integrationBranch}`, advanced, base);
        state.advancedBase = advanced;
        base = advanced;
        state.advanceBeforeMerge = false;
      }
      let mergeCommit;
      if (options.method === 'merge') {
        let mergeTree = state.advancedBase === base
          ? (state.racedTreeMode === 'head'
            ? git(fixture.remoteRoot, 'rev-parse', `${target.expectedHead}^{tree}`)
            : serverMergeTree(fixture, base, target.expectedHead))
          : git(fixture.remoteRoot, 'rev-parse', `${target.expectedHead}^{tree}`);
        if (state.racedTreeMode === 'extra') mergeTree = serverTreeWithExtra(fixture, mergeTree);
        mergeCommit = git(fixture.remoteRoot, 'commit-tree', mergeTree,
          '-p', base, '-p', target.expectedHead, '-m', `Remote merge ${target.storyBranch}`);
      } else if (options.method === 'squash') {
        const squashTree = state.squashComposeBase
          ? serverMergeTree(fixture, base, target.expectedHead)
          : git(fixture.remoteRoot, 'rev-parse', `${target.expectedHead}^{tree}`);
        mergeCommit = git(fixture.remoteRoot, 'commit-tree', squashTree,
          '-p', state.squashParent || base, '-m', `Remote squash ${target.storyBranch}`);
      } else {
        if (state.rebaseExtra) {
          let intermediateTree = git(fixture.remoteRoot, 'rev-parse', `${base}^{tree}`);
          if (state.rebaseUnauthorized) {
            const blobFile = `${fixture.root}-provider-unauthorized.txt`;
            fs.writeFileSync(blobFile, 'server-only unrelated change\n');
            const blob = git(fixture.remoteRoot, 'hash-object', '-w', blobFile);
            fs.rmSync(blobFile, { force: true });
            const entries = git(fixture.remoteRoot, 'ls-tree', `${base}^{tree}`);
            intermediateTree = execFileSync('git', ['-C', fixture.remoteRoot, 'mktree'], {
              input: `${entries}\n100644 blob ${blob}\tunauthorized.txt\n`, encoding: 'utf8',
              stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
          }
          const extra = git(fixture.remoteRoot, 'commit-tree', intermediateTree,
            '-p', base, '-m', 'Unrelated first-parent commit');
          state.rebaseExtraCommit = extra;
          let finalParent = extra;
          if (state.rebaseRevertCommit !== false && state.rebaseUnauthorized === 'reverted') {
            finalParent = git(fixture.remoteRoot, 'commit-tree', `${base}^{tree}`,
              '-p', extra, '-m', 'Revert unauthorized intermediate path');
            state.rebaseRevertCommit = finalParent;
          }
          mergeCommit = git(fixture.remoteRoot, 'commit-tree', `${target.expectedHead}^{tree}`,
            '-p', finalParent, '-m', `Remote rebase ${target.storyBranch}`);
        } else if (state.rebaseActualRange) {
          const rebaseRoot = `${fixture.root}-provider-rebase-${Math.random().toString(16).slice(2)}`;
          try {
            git(fixture.remoteRoot, 'worktree', 'add', '-q', '--detach', rebaseRoot, target.expectedHead);
            git(rebaseRoot, 'rebase', '--onto', base, fixture.record.record.integration.base, target.expectedHead);
            mergeCommit = git(rebaseRoot, 'rev-parse', 'HEAD');
          } finally {
            try { git(fixture.remoteRoot, 'worktree', 'remove', '--force', rebaseRoot); } catch {}
            fs.rmSync(rebaseRoot, { recursive: true, force: true });
          }
        } else {
          const rebasedTree = state.rebaseComposeBase
            ? serverMergeTree(fixture, base, target.expectedHead)
            : git(fixture.remoteRoot, 'rev-parse', `${target.expectedHead}^{tree}`);
          mergeCommit = git(fixture.remoteRoot, 'commit-tree', rebasedTree,
            '-p', base, '-m', `Remote rebase ${target.storyBranch}`);
        }
      }
      git(fixture.remoteRoot, 'update-ref', `refs/heads/${target.integrationBranch}`, mergeCommit, base);
      state.merged = true;
      state.mergeCommit = mergeCommit;
      state.remoteBase = mergeCommit;
      return result(target, 'postmerge', 'MERGED', { mergeCommit, remoteBase: mergeCommit });
    },
    reconcileMerged(target, options) {
      calls.push({ method: 'reconcileMerged', target: structuredClone(target), options: structuredClone(options) });
      if (state.reconcileState) return result(target, 'postmerge', state.reconcileState);
      if (!state.merged || !state.mergeCommit) return result(target, 'postmerge', 'MERGE_PENDING');
      const remoteBase = git(fixture.remoteRoot, 'rev-parse', `refs/heads/${target.integrationBranch}`);
      return result(target, 'postmerge', remoteBase === state.mergeCommit ? 'MERGED' : 'MERGED_BASE_ADVANCED', {
        mergeCommit: state.mergeCommit, remoteBase,
      });
    },
  };
  return { provider, state, calls, repository };
}

function reusableSourceFixture(t) {
  const fixture = finishedRemoteCandidate(t);
  const fake = providerFixture(fixture);
  const recordBytes = fs.readFileSync(fixture.record.file, 'utf8');
  const providerState = structuredClone(fake.state);
  const integrationBase = fixture.record.record.integration.base;
  const storyRef = `refs/heads/${fixture.record.record.source.branch}`;
  const sourceStatus = git(fixture.root, 'status', '--porcelain=v1', '--untracked-files=all');
  const integrationStatus = git(fixture.integration, 'status', '--porcelain=v1', '--untracked-files=all');
  const reset = () => {
    fs.writeFileSync(fixture.record.file, recordBytes);
    const remoteHead = git(fixture.remoteRoot, 'rev-parse', 'refs/heads/main');
    if (remoteHead !== integrationBase) {
      git(fixture.remoteRoot, 'update-ref', 'refs/heads/main', integrationBase, remoteHead);
    }
    git(fixture.remoteRoot, 'update-ref', '-d', storyRef);
    Object.assign(fake.state, structuredClone(providerState));
    fake.calls.length = 0;
    assert.equal(fs.readFileSync(fixture.record.file, 'utf8'), recordBytes,
      'shared fixture restores the exact initial integration record');
    assert.equal(fs.readFileSync(fixture.runFile, 'utf8'), fixture.sourceBytes,
      'shared fixture preserves the finished source record');
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.runFile, 'utf8')).counters,
      fixture.sourceCounters, 'shared fixture preserves source attempt counters');
    assert.equal(git(fixture.root, 'rev-parse', 'HEAD'), fixture.candidate,
      'shared fixture preserves source HEAD C');
    assert.equal(git(fixture.integration, 'rev-parse', 'HEAD'), integrationBase,
      'shared fixture preserves integration HEAD I');
    assert.equal(git(fixture.root, 'status', '--porcelain=v1', '--untracked-files=all'), sourceStatus,
      'shared fixture restores exact source checkout status');
    assert.equal(git(fixture.integration, 'status', '--porcelain=v1', '--untracked-files=all'), integrationStatus,
      'shared fixture restores exact integration checkout status');
    return { fixture, fake };
  };
  return { fixture, fake, reset };
}

function fetchFromFixture(fixture, calls) {
  return ({ root, remote, branch, proofRef, expectedRemoteOid }) => {
    calls.push({ root, remote, branch, proofRef, expectedRemoteOid });
    git(root, 'fetch', '-q', '--no-tags', remote, `refs/heads/${branch}:${proofRef}`);
    return { state: 'FETCHED', oid: git(root, 'rev-parse', proofRef) };
  };
}

function requireRemoteApi() {
  const names = [
    'publishRemoteSource', 'inspectRemoteSourceReadiness', 'mergeRemoteSource', 'reconcileRemoteSource',
    'prepareRemoteIntegrationEvidence', 'runRemoteIntegrationGate', 'recordRemoteIntegrationReview',
    'recordRemoteIntegrationVerification', 'finalizeRemoteIntegrationEvidence',
    'prepareRemoteClosureCheckout', 'adoptRemoteClosureCheckout',
    'prepareRemoteVerificationReport', 'adoptRemoteVerificationReport',
    'prepareRemoteStoryClosure', 'adoptRemoteStoryClosure', 'prepareRemoteHandoff', 'adoptRemoteHandoff',
    'publishRemoteClosure', 'reconcileRemoteClosure', 'prepareHandoffRepair', 'adoptHandoffRepair',
    'publishRemoteHandoffRepair', 'reconcileRemoteHandoffRepair', 'prepareRemoteCompletion',
    'adoptRemoteCompletion',
  ];
  for (const name of names) assert.equal(typeof integrationApi[name], 'function', `integration.mjs must export ${name}`);
  assert.equal(typeof currentPmApi.remoteAdmissionStatus, 'function', 'current-pm.mjs must export remoteAdmissionStatus');
}

function assertWrapper(wrapper, operation, state) {
  assert.equal(typeof wrapper.file, 'string');
  assert.equal(typeof wrapper.record, 'object');
  assert.match(wrapper.hash, /^[0-9a-f]{64}$/);
  assert.equal(wrapper.result.operation, operation);
  assert.equal(wrapper.result.state, state);
}

function finalizeRemoteCandidate(t, fixture) {
  const fake = providerFixture(fixture);
  const fetchCalls = [];
  let state = fixture.record;
  state = wrapperState(integrationApi.publishRemoteSource(state.file, {
    expectedRecordHash: state.hash, remote: 'origin', title: 'Publish S1-1', body: 'Source publication',
    provider: fake.provider,
  }, fixture.integration));
  state = wrapperState(integrationApi.mergeRemoteSource(state.file, {
    expectedRecordHash: state.hash, prNumber: fake.state.prNumber, method: 'merge',
    subject: 'Merge S1-1', body: '', provider: fake.provider,
  }, fixture.integration));
  if (fixture.executableArtifacts) {
    const sourceMerge = fake.state.mergeCommit;
    const advanced = serverCommitMode(fixture, sourceMerge, storyRel,
      'Preserve executable story mode at advanced remote M');
    git(fixture.remoteRoot, 'update-ref', 'refs/heads/main', advanced, sourceMerge);
    assert.equal(git(fixture.root, 'ls-tree', fixture.candidate, '--', storyRel).split(/\s+/)[0], '100644');
    assert.equal(git(fixture.remoteRoot, 'ls-tree', advanced, '--', storyRel).split(/\s+/)[0], '100755');
    assert.equal(git(fixture.remoteRoot, 'show', `${advanced}:${storyRel}`),
      git(fixture.root, 'show', `${fixture.candidate}:${storyRel}`));
  }
  const reconciled = integrationApi.reconcileRemoteSource(state.file, {
    expectedRecordHash: state.hash, prNumber: fake.state.prNumber, provider: fake.provider,
    fetchRemote: fetchFromFixture(fixture, fetchCalls),
  }, fixture.integration);
  assertWrapper(reconciled, 'source-reconcile', fixture.executableArtifacts
    ? 'SOURCE_BASE_ADVANCED' : 'LINEAGE_PROVEN');
  state = wrapperState(reconciled);
  const evidenceRoot = `${fixture.root}-final-evidence`;
  t.after(() => fs.rmSync(evidenceRoot, { recursive: true, force: true }));
  git(fixture.root, 'worktree', 'add', '-q', '-b', reconciled.result.evidence_branch,
    evidenceRoot, reconciled.result.verified_integration_commit);
  state = wrapperState(integrationApi.prepareRemoteIntegrationEvidence(state.file, {
    expectedRecordHash: state.hash, evidenceRoot,
  }, fixture.integration));
  state = wrapperState(integrationApi.runRemoteIntegrationGate(state.file, {
    expectedRecordHash: state.hash, name: 'test',
  }, fixture.integration));
  const snapshot = state.record.remote.integration_evidence.snapshot_hash;
  state = wrapperState(integrationApi.recordRemoteIntegrationReview(state.file, {
    expectedRecordHash: state.hash, reviewer: 'remote-reviewer', receipt: {
      status: 'PASS', findings: [], panel: { snapshot_hash: snapshot, members: [{
        lens: 'code-integrity-reviewer', reviewer: 'remote-panel-reviewer', verdict: 'PASS',
        snapshot_hash: snapshot, findings: [],
      }] },
    },
  }, fixture.integration));
  state = wrapperState(integrationApi.recordRemoteIntegrationVerification(state.file, {
    expectedRecordHash: state.hash, verifier: 'remote-verifier', results: {
      criteria: [{ id: 'AC-1', status: 'PASS', evidence: 'Fresh remote M passed.' }],
    },
  }, fixture.integration));
  const finalized = integrationApi.finalizeRemoteIntegrationEvidence(state.file, {
    expectedRecordHash: state.hash,
  }, fixture.integration);
  assertWrapper(finalized, 'remote-evidence-finalize', 'REMOTE_EVIDENCE_FINALIZED');
  return { fixture, fake, fetchCalls, state: wrapperState(finalized) };
}

function finalizedRemoteEvidence(t, options = {}) {
  return finalizeRemoteCandidate(t, finishedRemoteCandidate(t, options));
}

function commitPrepared(root, message, preparation) {
  git(root, 'add', '--', ...preparation.result.paths);
  git(root, 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}

function adoptedRemoteClosureArtifacts(t, flow) {
  const { fixture } = flow;
  let state = flow.state;
  const checkout = integrationApi.prepareRemoteClosureCheckout(state.file, {
    expectedRecordHash: state.hash,
  }, fixture.integration);
  assertWrapper(checkout, 'remote-closure-checkout-prepare', 'CLOSURE_CHECKOUT_PREPARED');
  state = wrapperState(checkout);
  const closureRoot = `${fixture.root}-closure-artifacts`;
  t.after(() => fs.rmSync(closureRoot, { recursive: true, force: true }));
  git(fixture.root, 'worktree', 'add', '-q', '-b', checkout.result.branch,
    closureRoot, checkout.result.start_commit);
  state = wrapperState(integrationApi.adoptRemoteClosureCheckout(state.file, {
    expectedRecordHash: state.hash, token: checkout.result.token, closureRoot,
  }, fixture.integration));
  const report = integrationApi.prepareRemoteVerificationReport(state.file, {
    expectedRecordHash: state.hash,
  }, fixture.integration);
  const p = commitPrepared(closureRoot, 'Remote verification report P', report);
  state = wrapperState(integrationApi.adoptRemoteVerificationReport(report.file, {
    expectedRecordHash: report.hash, token: report.result.token, commit: p,
  }, fixture.integration));
  const closure = integrationApi.prepareRemoteStoryClosure(state.file, {
    expectedRecordHash: state.hash,
  }, fixture.integration);
  const e = commitPrepared(closureRoot, 'Remote story closure E', closure);
  for (const preparedWrite of closure.record.remote.closure.artifacts.closure.pending.writes) {
    assert.equal(git(closureRoot, 'ls-tree', e, '--', preparedWrite.path).split(/\s+/)[0],
      preparedWrite.expected_mode, `E preserves the prepared ${preparedWrite.path} mode`);
  }
  state = wrapperState(integrationApi.adoptRemoteStoryClosure(closure.file, {
    expectedRecordHash: closure.hash, token: closure.result.token, commit: e,
  }, fixture.integration));
  const handoff = integrationApi.prepareRemoteHandoff(state.file, {
    expectedRecordHash: state.hash, next: 'Continue with S1-2.',
  }, fixture.integration);
  const h = commitPrepared(closureRoot, 'Remote handoff H', handoff);
  state = wrapperState(integrationApi.adoptRemoteHandoff(handoff.file, {
    expectedRecordHash: handoff.hash, token: handoff.result.token, commit: h,
  }, fixture.integration));
  return { ...flow, state, closureRoot, p, e, h };
}

function completeNormalRemoteFlow(t, initialFlow) {
  const flow = adoptedRemoteClosureArtifacts(t, initialFlow);
  const { fixture, fake } = flow;
  let state = wrapperState(integrationApi.publishRemoteClosure(flow.state.file, {
    expectedRecordHash: flow.state.hash, remote: 'origin', title: 'Complete remote story', body: '',
    provider: fake.provider,
  }, fixture.integration));
  state = wrapperState(integrationApi.publishRemoteClosure(state.file, {
    expectedRecordHash: state.hash, remote: 'origin', title: 'Complete remote story', body: '',
    provider: fake.provider,
  }, fixture.integration));
  const reconciled = integrationApi.reconcileRemoteClosure(state.file, {
    expectedRecordHash: state.hash, prNumber: fake.state.prNumber, provider: fake.provider,
    fetchRemote: fetchFromFixture(fixture, flow.fetchCalls),
  }, fixture.integration);
  assertWrapper(reconciled, 'closure-reconcile', 'REMOTE_CLOSURE_PROVEN');
  const prepared = integrationApi.prepareRemoteCompletion(reconciled.file, {
    expectedRecordHash: reconciled.hash,
  }, fixture.integration);
  git(fixture.integration, 'merge', '--ff-only', prepared.result.target);
  const completed = integrationApi.adoptRemoteCompletion(prepared.file, {
    expectedRecordHash: prepared.hash, token: prepared.result.token,
  }, fixture.integration);
  assertWrapper(completed, 'remote-completion-adopt', 'COMPLETE');
  return { ...flow, state: wrapperState(completed), completed };
}


test('Fable current-source reproduction: pending checks and queued merge durable-state failures', (t) => {
  const fixture = finishedRemoteCandidate(t);
  const fake = providerFixture(fixture);
  const published = integrationApi.publishRemoteSource(fixture.record.file, {
    expectedRecordHash: fixture.record.hash, remote:'origin',title:'Probe',body:'',provider:fake.provider,
  }, fixture.integration);
  const publishedBytes=fs.readFileSync(published.file,'utf8');
  const mergeArgs={prNumber:fake.state.prNumber,method:'merge',subject:'Probe merge',body:'',provider:fake.provider};
  fake.state.readinessState='CHECKS_PENDING';fake.state.mergeState='CHECKS_PENDING';
  let error=null;
  try { integrationApi.mergeRemoteSource(published.file,{...mergeArgs,expectedRecordHash:published.hash},fixture.integration); }
  catch (e) {error=e.message;}
  assert.match(error,/unresolved attempt has effect/);
  let current=integrationApi.readIntegrationRecord(published.file,fixture.integration);
  assert.equal(current.record.remote.source.merge.attempts.at(-1).transitions.at(-1).state,'executing');
  fake.state.readinessState='READY';fake.state.mergeState='MERGED';
  const priorWrites=fake.calls.filter(x=>x.method==='merge').length;
  const retry=integrationApi.mergeRemoteSource(current.file,{...mergeArgs,expectedRecordHash:current.hash},fixture.integration);
  assert.equal(retry.result.state,'PENDING');
  assert.equal(fake.calls.filter(x=>x.method==='merge').length,priorWrites);
  console.log(JSON.stringify({reproduced:'pending-check merge leaves executing and cannot resume when checks become ready',error,state:retry.result.state}));
  fs.writeFileSync(published.file,publishedBytes);
  fake.state.mergeState='MERGE_PENDING';
  const queued=integrationApi.mergeRemoteSource(published.file,{...mergeArgs,expectedRecordHash:published.hash},fixture.integration);
  assert.equal(queued.record.remote.source.merge.effect,null);
  assert.equal(queued.record.remote.source.merge.active_token,null);
  fake.state.mergeState='MERGED';
  fake.provider.merge({root:fixture.root,remote:'origin',storyBranch:fixture.record.record.source.branch,
    integrationBranch:'main',expectedHead:fixture.candidate},{method:'merge'});
  let queuedError=null;
  try {integrationApi.reconcileRemoteSource(queued.file,{expectedRecordHash:queued.hash,
    prNumber:fake.state.prNumber,provider:fake.provider,fetchRemote:fetchFromFixture(fixture,[])},fixture.integration);}
  catch(e){queuedError=e.message;}
  assert.match(queuedError,/source proof binding/);
  console.log(JSON.stringify({reproduced:'queued merge completed by provider cannot record source proof',error:queuedError}));
});
