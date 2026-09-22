import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { readStory } from '../plugins/deliver/skills/deliver/scripts/lib/story.mjs';
import { canonical, sha256 } from '../plugins/deliver/skills/deliver/scripts/lib/state.mjs';

const integrationApi = await import('../plugins/deliver/skills/deliver/scripts/lib/integration.mjs');
const currentPmApi = await import('../plugins/deliver/skills/deliver/scripts/lib/current-pm.mjs');
const runtime = fileURLToPath(new URL('../plugins/deliver/skills/deliver/scripts/deliver.mjs', import.meta.url));
const pmCli = fileURLToPath(new URL('../plugins/deliver/skills/deliver/scripts/pm.mjs', import.meta.url));
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
    squashParent: null,
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
        mergeCommit = git(fixture.remoteRoot, 'commit-tree', `${target.expectedHead}^{tree}`,
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
  const reconciled = integrationApi.reconcileRemoteSource(state.file, {
    expectedRecordHash: state.hash, prNumber: fake.state.prNumber, provider: fake.provider,
    fetchRemote: fetchFromFixture(fixture, fetchCalls),
  }, fixture.integration);
  assertWrapper(reconciled, 'source-reconcile', 'LINEAGE_PROVEN');
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

function finalizedRemoteEvidence(t) {
  return finalizeRemoteCandidate(t, finishedRemoteCandidate(t));
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

test('native remote lifecycle exports every settled operation and drives durable source publication with real Git proof', async (t) => {
  requireRemoteApi();

  await t.test('tiny and small reject requested verification reporting before record creation', () => {
    for (const scale of ['tiny', 'small']) {
      const fixture = finishedRemoteCandidate(t, { scale, verificationReport: false, prepareRecord: false });
      const integrations = path.join(fixture.integration, '.deliver/integrations');
      assert.throws(() => integrationApi.prepareLocalIntegration(fixture.runFile, {
        integrationRoot: fixture.integration, verificationReport: true,
      }, fixture.integration), /report|verification|tiny|small|scale|unsupported/i);
      assert.equal(fs.existsSync(integrations), false, `${scale} refusal must precede record creation`);
    }
  });

  await t.test('source publish, readiness and merge retain exact attempts without touching source history', () => {
    const fixture = finishedRemoteCandidate(t);
    const fake = providerFixture(fixture);
    let state = fixture.record;
    const published = integrationApi.publishRemoteSource(state.file, {
      expectedRecordHash: state.hash, remote: 'origin', title: 'Publish S1-1', body: 'Exact source body',
      createDraft: false, markReady: false, provider: fake.provider,
    }, fixture.integration);
    assertWrapper(published, 'source-publish', 'PUBLISHED');
    assert.equal(published.result.provider_state, 'PUBLISHED');
    state = wrapperState(published);
    assert.equal(state.record.remote.version, 'remote-publication-v1');
    const attempt = state.record.remote.source.publication.attempts[0];
    assert.equal(attempt.version, 'remote-provider-attempt-v1');
    assert.deepEqual(attempt.transitions.map((item) => item.state), ['prepared', 'executing', 'observed']);
    assert.equal(attempt.input.target.remote, 'origin');
    assert.equal(attempt.input.target.expectedHead, fixture.candidate);
    assert.match(attempt.input_identity, /^[0-9a-f]{64}$/);
    assert.match(attempt.identity, /^[0-9a-f]{64}$/);

    fake.state.readinessState = 'CHECKS_PENDING';
    const beforePending = fs.readFileSync(state.file, 'utf8');
    const pending = integrationApi.inspectRemoteSourceReadiness(state.file, {
      expectedRecordHash: state.hash, provider: fake.provider,
    }, fixture.integration);
    assertWrapper(pending, 'source-readiness', 'PENDING');
    assert.equal(pending.result.provider_state, 'CHECKS_PENDING');
    assert.equal(fs.readFileSync(state.file, 'utf8'), beforePending, 'pending readiness is read-only');
    fake.state.readinessState = 'READY';
    const ready = integrationApi.inspectRemoteSourceReadiness(state.file, {
      expectedRecordHash: state.hash, provider: fake.provider,
    }, fixture.integration);
    assertWrapper(ready, 'source-readiness', 'READY');
    assert.equal(fs.readFileSync(state.file, 'utf8'), beforePending, 'ready inspection is read-only');

    assert.throws(() => integrationApi.publishRemoteSource(state.file, {
      expectedRecordHash: state.hash, remote: 'upstream', title: 'Wrong destination', body: '',
      provider: { publish() { assert.fail('mismatched retained destination reached provider'); } },
    }, fixture.integration), /remote|retained|differ|identity/i);
    assert.equal(fs.readFileSync(state.file, 'utf8'), beforePending);

    const merged = integrationApi.mergeRemoteSource(state.file, {
      expectedRecordHash: state.hash, prNumber: 17, method: 'merge',
      subject: 'Merge S1-1', body: 'Merge exact source head', provider: fake.provider,
    }, fixture.integration);
    assertWrapper(merged, 'source-merge', 'SOURCE_MERGED');
    assert.equal(merged.result.provider_state, 'MERGED');
    assert.match(merged.result.merge_commit, /^[0-9a-f]{40,64}$/);
    state = wrapperState(merged);
    assert.equal(state.record.remote.source.merge.attempts.length, 1);
    assert.deepEqual(state.record.remote.source.merge.attempts[0].transitions.map((item) => item.state),
      ['prepared', 'executing', 'observed']);
    assert.equal(fs.readFileSync(fixture.runFile, 'utf8'), fixture.sourceBytes);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.runFile, 'utf8')).counters, fixture.sourceCounters);
    assert.equal(git(fixture.root, 'rev-parse', 'HEAD'), fixture.candidate);
  });

  await t.test('source reconciliation binds the fetch destination and records fresh M evidence in its own checkout', () => {
    const fixture = finishedRemoteCandidate(t);
    const fake = providerFixture(fixture);
    const fetchCalls = [];
    let state = fixture.record;
    state = wrapperState(integrationApi.publishRemoteSource(state.file, {
      expectedRecordHash: state.hash, remote: 'origin', title: 'Publish S1-1', body: 'Source publication',
      provider: fake.provider,
    }, fixture.integration));
    state = wrapperState(integrationApi.mergeRemoteSource(state.file, {
      expectedRecordHash: state.hash, prNumber: 17, method: 'merge', subject: 'Merge S1-1', body: '',
      provider: fake.provider,
    }, fixture.integration));

    const commonDir = path.resolve(fixture.root, git(fixture.root, 'rev-parse', '--git-common-dir'));
    const configFile = path.join(commonDir, 'config');
    const exactConfig = fs.readFileSync(configFile);
    git(fixture.root, 'config', 'remote.origin.pushurl', `${fixture.remoteRoot}-different`);
    const providerCallsBeforeMismatch = fake.calls.length;
    assert.throws(() => integrationApi.reconcileRemoteSource(state.file, {
      expectedRecordHash: state.hash, prNumber: 17, provider: fake.provider,
      fetchRemote: fetchFromFixture(fixture, fetchCalls),
    }, fixture.integration), /fetch|push|destination|remote|identity|differ/i);
    assert.equal(fake.calls.length, providerCallsBeforeMismatch, 'destination mismatch must refuse before provider lookup');
    assert.equal(fetchCalls.length, 0, 'destination mismatch must refuse before fetch');
    fs.writeFileSync(configFile, exactConfig);

    const reconciled = integrationApi.reconcileRemoteSource(state.file, {
      expectedRecordHash: state.hash, prNumber: 17, provider: fake.provider,
      fetchRemote: fetchFromFixture(fixture, fetchCalls),
    }, fixture.integration);
    assertWrapper(reconciled, 'source-reconcile', 'LINEAGE_PROVEN');
    assert.equal(reconciled.result.provider_state, 'MERGED');
    assert.equal(reconciled.result.source_merge_commit, fake.state.mergeCommit);
    assert.equal(reconciled.result.verified_integration_commit, fake.state.mergeCommit);
    assert.match(reconciled.result.proof_ref, /^refs\/deliver\/remote-evidence\//);
    assert.match(reconciled.result.evidence_branch, /^pm\/S1-1-remote-evidence-/);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].remote, 'origin');
    assert.equal(fetchCalls[0].expectedRemoteOid, fake.state.mergeCommit);
    assert.equal(git(fixture.root, 'rev-parse', reconciled.result.proof_ref), fake.state.mergeCommit);
    assert.equal(fs.readFileSync(configFile).equals(exactConfig), true, 'proof fetch must not rewrite shared Git config');
    state = wrapperState(reconciled);

    const evidenceRoot = `${fixture.root}-remote-evidence`;
    t.after(() => fs.rmSync(evidenceRoot, { recursive: true, force: true }));
    git(fixture.root, 'worktree', 'add', '-q', '-b', reconciled.result.evidence_branch,
      evidenceRoot, reconciled.result.verified_integration_commit);
    const evidencePrepared = integrationApi.prepareRemoteIntegrationEvidence(state.file, {
      expectedRecordHash: state.hash, evidenceRoot,
    }, fixture.integration);
    assertWrapper(evidencePrepared, 'remote-evidence-prepare', 'REMOTE_EVIDENCE_PREPARED');
    assert.equal(evidencePrepared.result.root, fs.realpathSync.native(evidenceRoot));
    assert.equal(evidencePrepared.result.commit, fake.state.mergeCommit);
    assert.notEqual(evidencePrepared.result.root, fixture.integration);
    assert.equal(evidencePrepared.record.destination.root, fixture.integration,
      'canonical destination I remains fixed until completion adoption');
    const evidenceBytes = fs.readFileSync(evidencePrepared.file, 'utf8');
    const repeatedEvidence = integrationApi.prepareRemoteIntegrationEvidence(evidencePrepared.file, {
      expectedRecordHash: evidencePrepared.hash, evidenceRoot,
    }, fixture.integration);
    assert.equal(repeatedEvidence.hash, evidencePrepared.hash,
      'interrupted evidence preparation resumes its retained checkout and snapshot');
    assert.equal(repeatedEvidence.result.snapshot_hash, evidencePrepared.result.snapshot_hash);
    assert.equal(fs.readFileSync(evidencePrepared.file, 'utf8'), evidenceBytes);
    state = wrapperState(evidencePrepared);

    const gated = integrationApi.runRemoteIntegrationGate(state.file, {
      expectedRecordHash: state.hash, name: 'test',
    }, fixture.integration);
    assertWrapper(gated, 'remote-evidence-gate', 'PASSED');
    assert.equal(gated.result.receipt.integration_commit, fake.state.mergeCommit);
    state = wrapperState(gated);
    const snapshot = state.record.remote.integration_evidence.snapshot_hash;
    const reviewReceipt = {
      status: 'PASS', findings: [], panel: { snapshot_hash: snapshot, members: [{
        lens: 'code-integrity-reviewer', reviewer: 'remote-panel-reviewer', verdict: 'PASS',
        snapshot_hash: snapshot, findings: [],
      }] },
    };
    assert.throws(() => integrationApi.recordRemoteIntegrationReview(state.file, {
      expectedRecordHash: state.hash, reviewer: 'source-builder', receipt: reviewReceipt,
    }, fixture.integration), /reviewer|builder|differ|independent/i);
    const reviewed = integrationApi.recordRemoteIntegrationReview(state.file, {
      expectedRecordHash: state.hash, reviewer: 'remote-reviewer', receipt: reviewReceipt,
    }, fixture.integration);
    assertWrapper(reviewed, 'remote-evidence-review', 'RECORDED');
    state = wrapperState(reviewed);
    const verificationResults = {
      criteria: [{ id: 'AC-1', status: 'PASS', evidence: 'Fresh remote M gate and review passed.' }],
    };
    assert.throws(() => integrationApi.recordRemoteIntegrationVerification(state.file, {
      expectedRecordHash: state.hash, verifier: 'remote-reviewer', results: verificationResults,
    }, fixture.integration), /verifier|reviewer|independent|differ/i);
    const verified = integrationApi.recordRemoteIntegrationVerification(state.file, {
      expectedRecordHash: state.hash, verifier: 'remote-verifier', results: verificationResults,
    }, fixture.integration);
    assertWrapper(verified, 'remote-evidence-verification', 'RECORDED');
    state = wrapperState(verified);
    const finalized = integrationApi.finalizeRemoteIntegrationEvidence(state.file, {
      expectedRecordHash: state.hash,
    }, fixture.integration);
    assertWrapper(finalized, 'remote-evidence-finalize', 'REMOTE_EVIDENCE_FINALIZED');
    assert.equal(finalized.record.remote.integration_evidence.finalized, true);
    assert.equal(finalized.record.integration.commit, null, 'remote M must not overwrite immutable local integration proof');
    assert.equal(fs.readFileSync(fixture.runFile, 'utf8'), fixture.sourceBytes);

    const admission = currentPmApi.remoteAdmissionStatus(fixture.integration);
    assert.equal(admission.state, 'REMOTE_PENDING');
    assert.equal(admission.blocking, true);
    assert.equal(admission.integration_record, finalized.file);
    const status = call(fixture.integration, pmCli, 'status');
    assert.equal(status.status, 0, status.stdout);
    assert.equal(status.json.remote.state, 'REMOTE_PENDING');
    const claim = call(fixture.integration, pmCli, 'claim', '--story', nextStoryRel);
    assert.notEqual(claim.status, 0);
    assert.match(claim.stdout, /remote|pending|integration|reconcile/i);
  });

  await t.test('normal R closes remotely, requires local fast-forward, then releases a fresh-process claim', () => {
    const flow = finalizedRemoteEvidence(t);
    const { fixture, fake } = flow;
    let state = flow.state;
    const finalizedBytes = fs.readFileSync(state.file, 'utf8');
    const finalizationRefusals = [];
    for (const [label, mutate] of [
      ['malformed finalization identity', (record) => { record.remote.integration_evidence.finalization.identity = '0'.repeat(64); }],
      ['rebound finalization snapshot', (record) => {
        const evidence = record.remote.integration_evidence;
        evidence.finalization.snapshot_hash = '1'.repeat(64);
        evidence.finalization = reidentify(evidence.finalization);
      }],
      ['finalization omits retained gate identity', (record) => {
        const evidence = record.remote.integration_evidence;
        evidence.finalization.gates = [];
        evidence.finalization = reidentify(evidence.finalization);
      }],
      ['finalization omits retained review evidence', (record) => {
        const evidence = record.remote.integration_evidence;
        evidence.review = null;
        evidence.finalization.review = null;
        evidence.finalization = reidentify(evidence.finalization);
      }],
    ]) {
      const forged = JSON.parse(finalizedBytes);
      mutate(forged);
      fs.writeFileSync(state.file, `${JSON.stringify(forged, null, 2)}\n`);
      const forgedHash = sha256(canonical(forged));
      let refused = false;
      try {
        integrationApi.prepareRemoteClosureCheckout(state.file, {
          expectedRecordHash: forgedHash,
        }, fixture.integration);
      } catch (error) {
        refused = /finalization|evidence|identity|snapshot|gate|review|invalid|binding/i.test(error.message);
      }
      finalizationRefusals.push([label, refused]);
      fs.writeFileSync(state.file, finalizedBytes);
    }
    const checkout = integrationApi.prepareRemoteClosureCheckout(state.file, {
      expectedRecordHash: state.hash,
    }, fixture.integration);
    assertWrapper(checkout, 'remote-closure-checkout-prepare', 'CLOSURE_CHECKOUT_PREPARED');
    state = wrapperState(checkout);
    const closureRoot = `${fixture.root}-closure`;
    t.after(() => fs.rmSync(closureRoot, { recursive: true, force: true }));
    git(fixture.root, 'worktree', 'add', '-q', '-b', checkout.result.branch,
      closureRoot, checkout.result.start_commit);
    const adoptedCheckout = integrationApi.adoptRemoteClosureCheckout(state.file, {
      expectedRecordHash: state.hash, token: checkout.result.token, closureRoot,
    }, fixture.integration);
    assertWrapper(adoptedCheckout, 'remote-closure-checkout-adopt', 'CLOSURE_CHECKOUT_READY');
    state = wrapperState(adoptedCheckout);

    const report = integrationApi.prepareRemoteVerificationReport(state.file, {
      expectedRecordHash: state.hash,
    }, fixture.integration);
    assertWrapper(report, 'remote-report-prepare', 'PREPARED');
    const p = commitPrepared(closureRoot, 'Remote verification report P', report);
    state = wrapperState(integrationApi.adoptRemoteVerificationReport(report.file, {
      expectedRecordHash: report.hash, token: report.result.token, commit: p,
    }, fixture.integration));
    assert.equal(state.record.remote.closure.artifacts.report.commit, p);

    const beforePrematureHandoff = fs.readFileSync(state.file, 'utf8');
    const handoffFile = path.join(closureRoot, ...state.record.handoff.path.split('/'));
    const handoffBefore = fs.existsSync(handoffFile) ? fs.readFileSync(handoffFile, 'utf8') : null;
    let prematureHandoffRefused = false;
    try {
      integrationApi.prepareRemoteHandoff(state.file, {
        expectedRecordHash: state.hash, next: 'This must wait for E.',
      }, fixture.integration);
    } catch (error) {
      prematureHandoffRefused = /closure|story|adopted|E|required|handoff/i.test(error.message);
    }
    if (!prematureHandoffRefused) {
      fs.writeFileSync(state.file, beforePrematureHandoff);
      if (handoffBefore === null) fs.rmSync(handoffFile, { force: true });
      else fs.writeFileSync(handoffFile, handoffBefore);
    }
    assert.equal(fs.readFileSync(state.file, 'utf8'), beforePrematureHandoff);
    assert.equal(fs.existsSync(handoffFile) ? fs.readFileSync(handoffFile, 'utf8') : null, handoffBefore);

    const closure = integrationApi.prepareRemoteStoryClosure(state.file, {
      expectedRecordHash: state.hash,
    }, fixture.integration);
    assertWrapper(closure, 'remote-closure-prepare', 'PREPARED');
    const e = commitPrepared(closureRoot, 'Remote story closure E', closure);
    state = wrapperState(integrationApi.adoptRemoteStoryClosure(closure.file, {
      expectedRecordHash: closure.hash, token: closure.result.token, commit: e,
    }, fixture.integration));
    assert.equal(state.record.remote.closure.artifacts.closure.commit, e);

    const handoff = integrationApi.prepareRemoteHandoff(state.file, {
      expectedRecordHash: state.hash, next: 'Continue with S1-2.',
    }, fixture.integration);
    assertWrapper(handoff, 'remote-handoff-prepare', 'PREPARED');
    const h = commitPrepared(closureRoot, 'Remote handoff H', handoff);
    state = wrapperState(integrationApi.adoptRemoteHandoff(handoff.file, {
      expectedRecordHash: handoff.hash, token: handoff.result.token, commit: h,
    }, fixture.integration));
    assert.equal(state.record.remote.closure.artifacts.handoff.commit, h);

    let closurePublishWrites = 0;
    let closureMergeWrites = 0;
    let provePublishAbsent = true;
    const interruptedClosureProvider = {
      ...fake.provider,
      publish(target, options) {
        closurePublishWrites += 1;
        if (closurePublishWrites === 1) throw new Error('lost closure publish invocation before effect');
        return fake.provider.publish(target, options);
      },
      inspect(target) {
        if (provePublishAbsent) return { state: 'PR_ABSENT', expectedHead: target.expectedHead };
        return fake.provider.inspect(target);
      },
      merge(target, options) {
        closureMergeWrites += 1;
        fake.provider.merge(target, options);
        throw new Error('lost closure merge response after exact effect');
      },
    };
    const closureOptions = {
      remote: 'origin', title: 'Close S1-1', body: 'Publish exact P/E/H', provider: interruptedClosureProvider,
    };
    const unknownPublish = integrationApi.publishRemoteClosure(state.file, {
      expectedRecordHash: state.hash, ...closureOptions,
    }, fixture.integration);
    assertWrapper(unknownPublish, 'closure-publish', 'PROVIDER_UNKNOWN');
    const unknownPublishBytes = fs.readFileSync(unknownPublish.file, 'utf8');
    const child = `${fixture.root}-closure-publish-reconcile.mjs`;
    t.after(() => fs.rmSync(child, { force: true }));
    const integrationUrl = new URL('../plugins/deliver/skills/deliver/scripts/lib/integration.mjs', import.meta.url).href;
    fs.writeFileSync(child, [
      `import { publishRemoteClosure } from ${JSON.stringify(integrationUrl)};`,
      'const [file, hash, cwd] = process.argv.slice(2);',
      "const provider = { inspect(target) { return { state: 'PR_ABSENT', expectedHead: target.expectedHead }; },",
      "  publish() { throw new Error('fresh process must not replay closure publish'); } };",
      "const value = publishRemoteClosure(file, { expectedRecordHash: hash, remote: 'origin', title: 'Close S1-1', body: 'Publish exact P/E/H', provider }, cwd);",
      'process.stdout.write(JSON.stringify(value.result));',
    ].join('\n'));
    const freshClosure = spawnSync(process.execPath, [child, unknownPublish.file, unknownPublish.hash,
      fixture.integration], { encoding: 'utf8' });
    assert.equal(freshClosure.status, 0, freshClosure.stderr);
    assert.equal(JSON.parse(freshClosure.stdout).state, 'PROVIDER_UNKNOWN');
    assert.equal(fs.readFileSync(unknownPublish.file, 'utf8'), unknownPublishBytes);
    const published = integrationApi.publishRemoteClosure(unknownPublish.file, {
      expectedRecordHash: unknownPublish.hash, ...closureOptions,
    }, fixture.integration);
    assertWrapper(published, 'closure-publish', 'PUBLISHED');
    assert.equal(closurePublishWrites, 2);
    assert.equal(published.record.remote.closure.publication.publish.attempts.length, 1);
    assert.equal(published.record.remote.closure.publication.publish.attempts[0].token,
      unknownPublish.result.attempt_token);
    state = wrapperState(published);
    provePublishAbsent = false;
    const unknownMerge = integrationApi.publishRemoteClosure(state.file, {
      expectedRecordHash: state.hash, ...closureOptions,
    }, fixture.integration);
    assertWrapper(unknownMerge, 'closure-merge', 'PROVIDER_UNKNOWN');
    const merged = integrationApi.publishRemoteClosure(unknownMerge.file, {
      expectedRecordHash: unknownMerge.hash, ...closureOptions,
    }, fixture.integration);
    assertWrapper(merged, 'closure-merge', 'MERGED');
    assert.equal(closureMergeWrites, 1);
    assert.equal(merged.result.reconciled, true);
    assert.equal(merged.record.remote.closure.publication.merge.attempts.length, 1);
    assert.equal(merged.record.remote.closure.publication.merge.attempts[0].token,
      unknownMerge.result.attempt_token);
    state = wrapperState(merged);
    assert.equal(hasCommit(fixture.root, fake.state.mergeCommit), false,
      'server-generated R is absent locally before the injected fetch');
    const reconciled = integrationApi.reconcileRemoteClosure(state.file, {
      expectedRecordHash: state.hash, prNumber: fake.state.prNumber, provider: fake.provider,
      fetchRemote: fetchFromFixture(fixture, flow.fetchCalls),
    }, fixture.integration);
    assertWrapper(reconciled, 'closure-reconcile', 'REMOTE_CLOSURE_PROVEN');
    assert.equal(reconciled.result.closure_commit, fake.state.mergeCommit);
    assert.equal(hasCommit(fixture.root, fake.state.mergeCommit), true);
    state = wrapperState(reconciled);

    const prepared = integrationApi.prepareRemoteCompletion(state.file, {
      expectedRecordHash: state.hash,
    }, fixture.integration);
    assertWrapper(prepared, 'remote-completion-prepare', 'LOCAL_ADOPTION_PENDING');
    const completionBytes = fs.readFileSync(prepared.file, 'utf8');
    const repeatedBefore = integrationApi.prepareRemoteCompletion(prepared.file, {
      expectedRecordHash: prepared.hash,
    }, fixture.integration);
    assert.equal(repeatedBefore.hash, prepared.hash);
    assert.equal(repeatedBefore.result.token, prepared.result.token,
      'completion preparation preserves its token before fast-forward');
    assert.equal(fs.readFileSync(prepared.file, 'utf8'), completionBytes);
    assert.equal(currentPmApi.remoteAdmissionStatus(fixture.integration).state, 'LOCAL_ADOPTION_PENDING');
    const blocked = call(fixture.integration, pmCli, 'claim', '--story', nextStoryRel);
    assert.notEqual(blocked.status, 0, 'next claim stays blocked before canonical fast-forward adoption');
    git(fixture.integration, 'merge', '--ff-only', prepared.result.target);
    const repeatedAfter = integrationApi.prepareRemoteCompletion(prepared.file, {
      expectedRecordHash: prepared.hash,
    }, fixture.integration);
    assert.equal(repeatedAfter.hash, prepared.hash);
    assert.equal(repeatedAfter.result.token, prepared.result.token,
      'completion preparation preserves its token after an interrupted fast-forward');
    assert.equal(fs.readFileSync(prepared.file, 'utf8'), completionBytes);
    const commonDir = path.resolve(fixture.integration,
      git(fixture.integration, 'rev-parse', '--git-common-dir'));
    const configFile = path.join(commonDir, 'config');
    const configBytes = fs.readFileSync(configFile);
    git(fixture.integration, 'config', 'core.hooksPath', '.changed-hooks');
    assert.throws(() => integrationApi.adoptRemoteCompletion(prepared.file, {
      expectedRecordHash: prepared.hash, token: prepared.result.token,
    }, fixture.integration), /protected|anchor|config|checkout|changed|drift/i);
    assert.equal(fs.readFileSync(prepared.file, 'utf8'), completionBytes);
    fs.writeFileSync(configFile, configBytes);
    const completed = integrationApi.adoptRemoteCompletion(prepared.file, {
      expectedRecordHash: prepared.hash, token: prepared.result.token,
    }, fixture.integration);
    assertWrapper(completed, 'remote-completion-adopt', 'COMPLETE');
    assert.equal(readStory(fixture.integration, storyRel).execution.status, 'merged');
    assert.equal(fs.readFileSync(fixture.runFile, 'utf8'), fixture.sourceBytes);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.runFile, 'utf8')).counters, fixture.sourceCounters);
    assert.equal(currentPmApi.remoteAdmissionStatus(fixture.integration).state, 'COMPLETE');
    const status = call(fixture.integration, pmCli, 'status');
    assert.equal(status.status, 0, status.stdout);
    assert.equal(status.json.remote.state, 'COMPLETE');
    const completedBytes = fs.readFileSync(completed.file, 'utf8');
    for (const [label, mutate] of [
      ['missing source proof chain', (record) => {
        record.remote.source.publication = null;
        record.remote.source.merge = null;
        record.remote.source.proof = null;
      }],
      ['missing finalized integration evidence', (record) => { record.remote.integration_evidence = null; }],
      ['missing closure and repair proof', (record) => {
        record.remote.closure = null;
        record.remote.handoff_repair = { publication_retry: 0, attempts: [], proof: null };
      }],
      ['completion target rebound away from terminal proof', (record) => {
        record.remote.completion.target = record.remote.completion.previous_head;
        record.remote.completion.commit = record.remote.completion.previous_head;
      }],
    ]) {
      const incomplete = JSON.parse(completedBytes);
      mutate(incomplete);
      fs.writeFileSync(completed.file, `${JSON.stringify(incomplete, null, 2)}\n`);
      const incompleteAdmission = currentPmApi.remoteAdmissionStatus(fixture.integration);
      assert.equal(incompleteAdmission.state, 'UNKNOWN', label);
      assert.equal(incompleteAdmission.blocking, true, label);
      fs.writeFileSync(completed.file, completedBytes);
    }
    const malformedProof = JSON.parse(completedBytes);
    malformedProof.remote.completion.commit = '0'.repeat(40);
    fs.writeFileSync(completed.file, `${JSON.stringify(malformedProof, null, 2)}\n`);
    const malformedAdmission = currentPmApi.remoteAdmissionStatus(fixture.integration);
    assert.equal(malformedAdmission.state, 'UNKNOWN');
    assert.equal(malformedAdmission.blocking, true);
    fs.writeFileSync(completed.file, completedBytes);
    const copiedRecord = path.join(path.dirname(completed.file), '22222222-2222-4222-8222-222222222222.json');
    fs.writeFileSync(copiedRecord, completedBytes);
    const copiedAdmission = currentPmApi.remoteAdmissionStatus(fixture.integration);
    assert.equal(copiedAdmission.state, 'UNKNOWN');
    assert.equal(copiedAdmission.blocking, true);
    fs.rmSync(copiedRecord);
    assert.equal(currentPmApi.remoteAdmissionStatus(fixture.integration).state, 'COMPLETE');
    const claim = call(fixture.integration, pmCli, 'claim', '--story', nextStoryRel);
    assert.equal(claim.status, 0, claim.stdout);
    assert.equal(prematureHandoffRefused, true,
      'remote handoff preparation refuses unchanged until story closure E is adopted');
    for (const [label, refused] of finalizationRefusals) {
      assert.equal(refused, true, `${label} must refuse before closure allocation`);
    }
  });
});

test('successful provider effects are idempotent and do not allocate another write attempt', (t) => {
  requireRemoteApi();
  const fixture = finishedRemoteCandidate(t);
  const fake = providerFixture(fixture);
  const publishOptions = {
    remote: 'origin', title: 'Publish S1-1 once', body: 'Stable publication body', provider: fake.provider,
  };
  const published = integrationApi.publishRemoteSource(fixture.record.file, {
    expectedRecordHash: fixture.record.hash, ...publishOptions,
  }, fixture.integration);
  const publishBytes = fs.readFileSync(published.file, 'utf8');
  const publishCalls = fake.calls.filter((item) => item.method === 'publish').length;
  const repeatedPublish = integrationApi.publishRemoteSource(published.file, {
    expectedRecordHash: published.hash, ...publishOptions,
  }, fixture.integration);
  const publishIdempotent = repeatedPublish.hash === published.hash
    && fs.readFileSync(published.file, 'utf8') === publishBytes
    && fake.calls.filter((item) => item.method === 'publish').length === publishCalls
    && repeatedPublish.record.remote.source.publication.attempts.length === 1;

  const merged = integrationApi.mergeRemoteSource(repeatedPublish.file, {
    expectedRecordHash: repeatedPublish.hash, prNumber: fake.state.prNumber, method: 'merge',
    subject: 'Merge S1-1 once', body: 'Stable merge body', provider: fake.provider,
  }, fixture.integration);
  const mergeBytes = fs.readFileSync(merged.file, 'utf8');
  const mergeCalls = fake.calls.filter((item) => item.method === 'merge').length;
  const advancedAfterMerge = serverCommitWithFile(fixture, fake.state.mergeCommit,
    'src/post-merge-advance.txt', 'advance after proved merge\n', 'Advance after source merge proof');
  git(fixture.remoteRoot, 'update-ref', 'refs/heads/main', advancedAfterMerge, fake.state.mergeCommit);
  const repeatedMerge = integrationApi.mergeRemoteSource(merged.file, {
    expectedRecordHash: merged.hash, prNumber: fake.state.prNumber, method: 'merge',
    subject: 'Merge S1-1 once', body: 'Stable merge body', provider: fake.provider,
  }, fixture.integration);
  const mergeIdempotent = repeatedMerge.hash === merged.hash
    && fs.readFileSync(merged.file, 'utf8') === mergeBytes
    && fake.calls.filter((item) => item.method === 'merge').length === mergeCalls
    && repeatedMerge.record.remote.source.merge.attempts.length === 1;
  assert.equal(publishIdempotent, true, 'proven publication replay must reuse its exact effect without a provider write');
  assert.equal(mergeIdempotent, true, 'proven merge replay must reuse its exact effect without a provider write');
  assert.notEqual(repeatedMerge.result.state, 'PROVIDER_SUPERSEDED',
    'a successful merge effect remains immutable after later remote-base movement');
});

test('proved premerge head or base drift supersedes reciprocally before one successor provider write', async (t) => {
  await t.test('published source head drift prepares one linked successor and executes it on the next call', () => {
    const fixture = finishedRemoteCandidate(t);
    const fake = providerFixture(fixture);
    git(fixture.root, 'push', '-q', 'origin',
      `${fixture.candidate}:refs/heads/${fixture.record.record.source.branch}`);
    const changedHead = serverCommitWithFile(fixture, fixture.candidate, 'src/provider-head.txt',
      'provider-side head drift\n', 'Changed provider head D');
    git(fixture.remoteRoot, 'update-ref', `refs/heads/${fixture.record.record.source.branch}`,
      changedHead, fixture.candidate);
    let writes = 0;
    const provider = {
      ...fake.provider,
      publish(target) {
        writes += 1;
        return { state: 'PUBLISHED', expectedHead: target.expectedHead, repository: fake.repository };
      },
    };
    const options = { remote: 'origin', title: 'Supersede changed head', body: '', provider };
    const published = integrationApi.publishRemoteSource(fixture.record.file, {
      expectedRecordHash: fixture.record.hash, ...options,
    }, fixture.integration);
    assertWrapper(published, 'source-publish', 'PUBLISHED');
    const oldEffect = structuredClone(published.record.remote.source.publication.effect);
    let changedIntentRefused = false;
    try {
      integrationApi.publishRemoteSource(published.file, {
        expectedRecordHash: published.hash, remote: 'origin', title: 'Changed title is new intent', body: '', provider,
      }, fixture.integration);
    } catch (error) {
      changedIntentRefused = /input|intent|title|differ|retained/i.test(error.message);
    }
    assert.equal(writes, 1);
    fake.state.inspectHead = changedHead;
    const beforeWrites = writes;
    assert.throws(() => integrationApi.publishRemoteSource(published.file, {
      expectedRecordHash: fixture.record.hash, ...options,
    }, fixture.integration), /hash|stale/i);
    assert.equal(writes, beforeWrites, 'stale predecessor refuses before provider observation or write');
    const superseded = integrationApi.publishRemoteSource(published.file, {
      expectedRecordHash: published.hash, ...options,
    }, fixture.integration);
    assertWrapper(superseded, 'source-publish', 'PROVIDER_SUPERSEDED');
    assert.equal(writes, beforeWrites, 'supersession is read-only at the provider');
    assert.equal(superseded.record.remote.source.publication.attempts.length, 2);
    const [oldAttempt, successor] = superseded.record.remote.source.publication.attempts;
    assert.equal(oldAttempt.superseded_by, successor.token);
    assert.equal(successor.supersedes, oldAttempt.token);
    assert.equal(successor.transitions.at(-1).state, 'prepared');
    assert.equal(successor.retry, 0);
    assert.deepEqual(superseded.record.remote.source.publication.effect, oldEffect,
      'the prior proven effect remains retained while its successor is only prepared');
    const priorEffectStillBound = superseded.record.remote.source.publication.attempts
      .some((item) => item.identity === oldEffect.attempt_identity);
    const successorProofBytes = canonical(successor);
    const successorBindsPredecessor = successorProofBytes.includes(oldAttempt.token)
      && successorProofBytes.includes(oldEffect.identity);
    const supersededOldIdentity = superseded.record.remote.source.publication.attempts[0].identity;
    const executed = integrationApi.publishRemoteSource(superseded.file, {
      expectedRecordHash: superseded.hash, ...options,
    }, fixture.integration);
    assertWrapper(executed, 'source-publish', 'PUBLISHED');
    assert.equal(writes, beforeWrites + 1);
    assert.equal(executed.record.remote.source.publication.attempts.length, 2,
      'the prepared successor token is executed without repeated supersession');
    assert.equal(executed.record.remote.source.publication.attempts[1].token, successor.token);
    assert.equal(executed.record.remote.source.publication.attempts[0].identity, supersededOldIdentity);
    assert.equal(executed.record.remote.source.publication.effect.attempt_identity,
      executed.record.remote.source.publication.attempts[1].identity);
    assert.equal(changedIntentRefused, true, 'a desired title/body change is not supersession or idempotent replay');
    assert.equal(priorEffectStillBound, true,
      'the retained predecessor effect must still identify one immutable retained attempt');
    assert.equal(successorBindsPredecessor, true,
      'the successor proof retains both predecessor attempt and predecessor effect identities');
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.runFile, 'utf8')).counters, fixture.sourceCounters);
  });

  await t.test('pending merge base drift prepares one linked successor and executes it on the next call', () => {
    const fixture = finishedRemoteCandidate(t);
    const fake = providerFixture(fixture);
    let state = wrapperState(integrationApi.publishRemoteSource(fixture.record.file, {
      expectedRecordHash: fixture.record.hash, remote: 'origin', title: 'Publish before base drift', body: '',
      provider: fake.provider,
    }, fixture.integration));
    fake.state.mergeState = 'MERGE_PENDING';
    const mergeOptions = {
      prNumber: fake.state.prNumber, method: 'merge', subject: 'Merge after base drift', body: '', provider: fake.provider,
    };
    const pending = integrationApi.mergeRemoteSource(state.file, {
      expectedRecordHash: state.hash, ...mergeOptions,
    }, fixture.integration);
    assertWrapper(pending, 'source-merge', 'PENDING');
    const base = git(fixture.remoteRoot, 'rev-parse', 'refs/heads/main');
    const changedBase = serverCommitWithFile(fixture, base, 'src/provider-base.txt',
      'provider-side base drift\n', 'Changed provider base N');
    git(fixture.remoteRoot, 'update-ref', 'refs/heads/main', changedBase, base);
    fake.state.inspectRemoteBase = changedBase;
    const writesBefore = fake.calls.filter((item) => item.method === 'merge').length;
    const superseded = integrationApi.mergeRemoteSource(pending.file, {
      expectedRecordHash: pending.hash, ...mergeOptions,
    }, fixture.integration);
    assertWrapper(superseded, 'source-merge', 'PROVIDER_SUPERSEDED');
    assert.equal(fake.calls.filter((item) => item.method === 'merge').length, writesBefore);
    const attempts = superseded.record.remote.source.merge.attempts;
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].superseded_by, attempts[1].token);
    assert.equal(attempts[1].supersedes, attempts[0].token);
    assert.equal(attempts[1].retry, 0);
    fake.state.mergeState = 'MERGED';
    const merged = integrationApi.mergeRemoteSource(superseded.file, {
      expectedRecordHash: superseded.hash, ...mergeOptions,
    }, fixture.integration);
    assertWrapper(merged, 'source-merge', 'SOURCE_MERGED');
    assert.equal(fake.calls.filter((item) => item.method === 'merge').length, writesBefore + 1);
    assert.equal(merged.record.remote.source.merge.attempts.length, 2);
    assert.equal(merged.record.remote.source.merge.attempts[1].token, attempts[1].token);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.runFile, 'utf8')).counters, fixture.sourceCounters);
  });

  await t.test('unknown, absent, failed and unproved mismatch observations never supersede or trigger a second write', () => {
    const fixture = finishedRemoteCandidate(t);
    const initialBytes = fs.readFileSync(fixture.record.file, 'utf8');
    for (const providerState of ['UNKNOWN', 'PR_ABSENT', 'PUSH_REJECTED', 'HEAD_MISMATCH']) {
      fs.writeFileSync(fixture.record.file, initialBytes);
      let writes = 0;
      const provider = {
        publish(target) {
          writes += 1;
          return {
            state: providerState, expectedHead: target.expectedHead,
            ...(providerState === 'HEAD_MISMATCH' ? {
              repository: { host: 'github.example.test', owner: 'Example', name: 'Project',
                slug: 'github.example.test/Example/Project' },
              pr: { number: 17, state: 'OPEN', isDraft: false, headRefName: target.storyBranch,
                headRefOid: '1'.repeat(40), baseRefName: target.integrationBranch,
                headRepositoryOwner: { login: 'Example' },
                url: 'https://github.example.test/Example/Project/pull/17', mergeCommit: null },
            } : {}),
          };
        },
        inspect(target) { return { state: 'UNKNOWN', expectedHead: target.expectedHead }; },
      };
      const options = { remote: 'origin', title: `No supersession ${providerState}`, body: '', provider };
      const first = integrationApi.publishRemoteSource(fixture.record.file, {
        expectedRecordHash: fixture.record.hash, ...options,
      }, fixture.integration);
      const repeated = integrationApi.publishRemoteSource(first.file, {
        expectedRecordHash: first.hash, ...options,
      }, fixture.integration);
      assert.notEqual(repeated.result.state, 'PROVIDER_SUPERSEDED');
      assert.equal(writes, 1);
      assert.equal(repeated.record.remote.source.publication.attempts.length, 1);
      assert.equal(repeated.hash, first.hash);
    }
    fs.writeFileSync(fixture.record.file, initialBytes);
  });
});

test('advanced remote M with changed task-scope bytes receives fresh evidence instead of reusing source receipts', (t) => {
  requireRemoteApi();
  const fixture = finishedRemoteCandidate(t);
  const fake = providerFixture(fixture);
  const fetchCalls = [];
  let state = wrapperState(integrationApi.publishRemoteSource(fixture.record.file, {
    expectedRecordHash: fixture.record.hash, remote: 'origin', title: 'Publish for advanced M', body: '',
    provider: fake.provider,
  }, fixture.integration));
  state = wrapperState(integrationApi.mergeRemoteSource(state.file, {
    expectedRecordHash: state.hash, prNumber: fake.state.prNumber, method: 'merge',
    subject: 'Merge before integration advances', body: '', provider: fake.provider,
  }, fixture.integration));
  const sourceMerge = fake.state.mergeCommit;
  const advanced = serverCommitWithFile(fixture, sourceMerge, 'src/value.txt',
    'remote integration reviewed adjustment\n', 'Advance integration task bytes');
  git(fixture.remoteRoot, 'update-ref', 'refs/heads/main', advanced, sourceMerge);
  assert.equal(hasCommit(fixture.root, advanced), false);
  const reconciled = integrationApi.reconcileRemoteSource(state.file, {
    expectedRecordHash: state.hash, prNumber: fake.state.prNumber, provider: fake.provider,
    fetchRemote: fetchFromFixture(fixture, fetchCalls),
  }, fixture.integration);
  assertWrapper(reconciled, 'source-reconcile', 'SOURCE_BASE_ADVANCED');
  assert.equal(reconciled.result.source_merge_commit, sourceMerge);
  assert.equal(reconciled.result.verified_integration_commit, advanced);
  state = wrapperState(reconciled);
  const evidenceRoot = `${fixture.root}-advanced-evidence`;
  t.after(() => fs.rmSync(evidenceRoot, { recursive: true, force: true }));
  git(fixture.root, 'worktree', 'add', '-q', '-b', reconciled.result.evidence_branch, evidenceRoot, advanced);
  const prepared = integrationApi.prepareRemoteIntegrationEvidence(state.file, {
    expectedRecordHash: state.hash, evidenceRoot,
  }, fixture.integration);
  assertWrapper(prepared, 'remote-evidence-prepare', 'REMOTE_EVIDENCE_PREPARED');
  assert.equal(prepared.record.remote.integration_evidence.source_reusable, false);
  assert.notEqual(prepared.record.remote.integration_evidence.manifest.hash,
    prepared.record.integration.manifest.hash);
  state = wrapperState(prepared);
  state = wrapperState(integrationApi.runRemoteIntegrationGate(state.file, {
    expectedRecordHash: state.hash, name: 'test',
  }, fixture.integration));
  const snapshot = state.record.remote.integration_evidence.snapshot_hash;
  state = wrapperState(integrationApi.recordRemoteIntegrationReview(state.file, {
    expectedRecordHash: state.hash, reviewer: 'advanced-reviewer', receipt: {
      status: 'PASS', findings: [], panel: { snapshot_hash: snapshot, members: [{
        lens: 'code-integrity-reviewer', reviewer: 'advanced-panel-reviewer', verdict: 'PASS',
        snapshot_hash: snapshot, findings: [],
      }] },
    },
  }, fixture.integration));
  state = wrapperState(integrationApi.recordRemoteIntegrationVerification(state.file, {
    expectedRecordHash: state.hash, verifier: 'advanced-verifier', results: {
      criteria: [{ id: 'AC-1', status: 'PASS', evidence: 'Advanced M bytes reviewed and verified.' }],
    },
  }, fixture.integration));
  const finalized = integrationApi.finalizeRemoteIntegrationEvidence(state.file, {
    expectedRecordHash: state.hash,
  }, fixture.integration);
  assertWrapper(finalized, 'remote-evidence-finalize', 'REMOTE_EVIDENCE_FINALIZED');
  assert.equal(finalized.record.remote.integration_evidence.commit, advanced);
  assert.equal(finalized.record.remote.integration_evidence.review.snapshot_hash, snapshot);
  assert.equal(finalized.record.remote.integration_evidence.verification.snapshot_hash, snapshot);
  assert.equal(fs.readFileSync(fixture.runFile, 'utf8'), fixture.sourceBytes);
});

test('rebase reconciliation permits empty server commits but rejects reverted unauthorized intermediate paths', async (t) => {
  requireRemoteApi();
  const sharedFixture = finishedRemoteCandidate(t);
  const sharedFake = providerFixture(sharedFixture);
  const sharedRecordBytes = fs.readFileSync(sharedFixture.record.file, 'utf8');
  const sharedBase = sharedFixture.record.record.integration.base;
  const resetShared = () => {
    fs.writeFileSync(sharedFixture.record.file, sharedRecordBytes);
    const remoteHead = git(sharedFixture.remoteRoot, 'rev-parse', 'refs/heads/main');
    git(sharedFixture.remoteRoot, 'update-ref', 'refs/heads/main', sharedBase, remoteHead);
    Object.assign(sharedFake.state, {
      prNumber: 17, merged: false, mergeCommit: null, remoteBase: null, publishedHead: null,
      rebaseExtra: true, rebaseUnauthorized: false, rebaseActualRange: false,
      rebaseExtraCommit: null, rebaseRevertCommit: null,
    });
    return { fixture: sharedFixture, fake: sharedFake };
  };
  const exercise = (fixture, fake) => {
    let state = wrapperState(integrationApi.publishRemoteSource(fixture.record.file, {
      expectedRecordHash: fixture.record.hash, remote: 'origin', title: 'Publish rebase candidate', body: '',
      provider: fake.provider,
    }, fixture.integration));
    state = wrapperState(integrationApi.mergeRemoteSource(state.file, {
      expectedRecordHash: state.hash, prNumber: fake.state.prNumber, method: 'rebase',
      subject: 'Rebase S1-1', body: '', provider: fake.provider,
    }, fixture.integration));
    assert.equal(hasCommit(fixture.root, fake.state.mergeCommit), false,
      'server-generated rebase result is absent before the proof fetch');
    assert.equal(hasCommit(fixture.root, fake.state.rebaseExtraCommit), false);
    return state;
  };
  await t.test('empty intermediate server commit remains within the bounded source delta', () => {
    const { fixture, fake } = resetShared();
    const state = exercise(fixture, fake);
    const reconciled = integrationApi.reconcileRemoteSource(state.file, {
      expectedRecordHash: state.hash, prNumber: fake.state.prNumber, provider: fake.provider,
      fetchRemote: fetchFromFixture(fixture, []),
    }, fixture.integration);
    assertWrapper(reconciled, 'source-reconcile', 'LINEAGE_PROVEN');
    assert.equal(git(fixture.root, 'rev-list', '--count',
      `${state.record.integration.base}..${fake.state.mergeCommit}`), '2');
  });
  await t.test('unauthorized intermediate path cannot be hidden by reverting to the exact final tree', () => {
    const { fixture, fake } = resetShared();
    fake.state.rebaseUnauthorized = true;
    const state = exercise(fixture, fake);
    const before = fs.readFileSync(state.file, 'utf8');
    assert.throws(() => integrationApi.reconcileRemoteSource(state.file, {
      expectedRecordHash: state.hash, prNumber: fake.state.prNumber, provider: fake.provider,
      fetchRemote: fetchFromFixture(fixture, []),
    }, fixture.integration), /rebase|lineage|bounded|composition|first-parent|unauthorized|path/i);
    assert.equal(fs.readFileSync(state.file, 'utf8'), before,
      'unauthorized intermediate-path refusal leaves the record unchanged');
    assert.equal(git(fixture.root, 'diff-tree', '--no-commit-id', '--name-only', '-r',
      `${state.record.integration.base}`, fake.state.rebaseExtraCommit), 'unauthorized.txt');
    assert.equal(git(fixture.root, 'rev-parse', `${fake.state.mergeCommit}^{tree}`),
      state.record.integration.expected_tree);
  });
  await t.test('an earlier unauthorized edge remains visible after a separate revert and exact final source edge', () => {
    const { fixture, fake } = resetShared();
    fake.state.rebaseUnauthorized = 'reverted';
    const state = exercise(fixture, fake);
    const before = fs.readFileSync(state.file, 'utf8');
    assert.throws(() => integrationApi.reconcileRemoteSource(state.file, {
      expectedRecordHash: state.hash, prNumber: fake.state.prNumber, provider: fake.provider,
      fetchRemote: fetchFromFixture(fixture, []),
    }, fixture.integration), /rebase|lineage|bounded|composition|first-parent|unauthorized|path/i);
    assert.equal(fs.readFileSync(state.file, 'utf8'), before);
    assert.equal(git(fixture.root, 'diff-tree', '--no-commit-id', '--name-only', '-r',
      state.record.integration.base, fake.state.rebaseExtraCommit), 'unauthorized.txt');
    assert.equal(git(fixture.root, 'diff-tree', '--no-commit-id', '--name-only', '-r',
      fake.state.rebaseExtraCommit, fake.state.rebaseRevertCommit), 'unauthorized.txt');
    assert.equal(git(fixture.root, 'rev-list', '--count',
      `${state.record.integration.base}..${fake.state.mergeCommit}`), '3');
    assert.equal(git(fixture.root, 'rev-parse', `${fake.state.mergeCommit}^{tree}`),
      state.record.integration.expected_tree);
  });
  await t.test('a legitimate multi-commit source rebase proves the whole first-parent range', () => {
    const fixture = finishedRemoteCandidate(t, { multiCommit: true });
    const fake = providerFixture(fixture);
    const advancedBase = serverCommitWithFile(fixture, fixture.record.record.integration.base,
      'src/integration-before-multi-rebase.txt', 'independent integration advance\n',
      'Advance integration before multi-commit rebase');
    git(fixture.remoteRoot, 'update-ref', 'refs/heads/main', advancedBase,
      fixture.record.record.integration.base);
    fake.state.rebaseActualRange = true;
    const state = exercise(fixture, fake);
    const reconciled = integrationApi.reconcileRemoteSource(state.file, {
      expectedRecordHash: state.hash, prNumber: fake.state.prNumber, provider: fake.provider,
      fetchRemote: fetchFromFixture(fixture, []),
    }, fixture.integration);
    assertWrapper(reconciled, 'source-reconcile', 'LINEAGE_PROVEN');
    assert.equal(git(fixture.root, 'rev-list', '--count',
      `${state.record.integration.base}..${fixture.candidate}`), '2');
    assert.equal(git(fixture.root, 'rev-list', '--count',
      `${advancedBase}..${fake.state.mergeCommit}`), '2');
    assert.equal(git(fixture.root, 'show',
      `${fake.state.mergeCommit}:src/integration-before-multi-rebase.txt`),
    'independent integration advance');
    assert.equal(git(fixture.root, 'show', `${fake.state.mergeCommit}:src/first-source-step.txt`),
      'first source step');
  });
});

test('squash reconciliation accepts an exact direct child and rejects a hidden predecessor unchanged', async (t) => {
  const sharedFixture = finishedRemoteCandidate(t);
  const sharedFake = providerFixture(sharedFixture);
  const sharedRecordBytes = fs.readFileSync(sharedFixture.record.file, 'utf8');
  const sharedBase = sharedFixture.record.record.integration.base;
  const resetShared = () => {
    fs.writeFileSync(sharedFixture.record.file, sharedRecordBytes);
    const remoteHead = git(sharedFixture.remoteRoot, 'rev-parse', 'refs/heads/main');
    git(sharedFixture.remoteRoot, 'update-ref', 'refs/heads/main', sharedBase, remoteHead);
    Object.assign(sharedFake.state, {
      prNumber: 17, merged: false, mergeCommit: null, remoteBase: null, publishedHead: null, squashParent: null,
    });
    return { fixture: sharedFixture, fake: sharedFake };
  };
  const exercise = (fixture, fake) => {
    let state = wrapperState(integrationApi.publishRemoteSource(fixture.record.file, {
      expectedRecordHash: fixture.record.hash, remote: 'origin', title: 'Publish squash candidate', body: '',
      provider: fake.provider,
    }, fixture.integration));
    state = wrapperState(integrationApi.mergeRemoteSource(state.file, {
      expectedRecordHash: state.hash, prNumber: fake.state.prNumber, method: 'squash',
      subject: 'Squash S1-1', body: '', provider: fake.provider,
    }, fixture.integration));
    assert.equal(hasCommit(fixture.root, fake.state.mergeCommit), false);
    return state;
  };
  await t.test('exact server squash is fetched and proved', () => {
    const { fixture, fake } = resetShared();
    const state = exercise(fixture, fake);
    const reconciled = integrationApi.reconcileRemoteSource(state.file, {
      expectedRecordHash: state.hash, prNumber: fake.state.prNumber, provider: fake.provider,
      fetchRemote: fetchFromFixture(fixture, []),
    }, fixture.integration);
    assertWrapper(reconciled, 'source-reconcile', 'LINEAGE_PROVEN');
    assert.deepEqual(git(fixture.root, 'rev-list', '--parents', '-n', '1', fake.state.mergeCommit)
      .split(' ').slice(1), [state.record.integration.base]);
  });
  await t.test('extra squash predecessor is not hidden by an exact final tree', () => {
    const { fixture, fake } = resetShared();
    const base = fixture.record.record.integration.base;
    fake.state.squashParent = git(fixture.remoteRoot, 'commit-tree', `${base}^{tree}`,
      '-p', base, '-m', 'Hidden squash predecessor');
    const state = exercise(fixture, fake);
    const before = fs.readFileSync(state.file, 'utf8');
    assert.throws(() => integrationApi.reconcileRemoteSource(state.file, {
      expectedRecordHash: state.hash, prNumber: fake.state.prNumber, provider: fake.provider,
      fetchRemote: fetchFromFixture(fixture, []),
    }, fixture.integration), /squash|direct child|base|lineage/i);
    assert.equal(fs.readFileSync(state.file, 'utf8'), before);
    assert.equal(git(fixture.root, 'rev-parse', `${fake.state.mergeCommit}^{tree}`),
      state.record.integration.expected_tree);
  });
});

test('rebase onto an independently advanced integration base preserves unrelated integration bytes', (t) => {
  requireRemoteApi();
  const fixture = finishedRemoteCandidate(t);
  const fake = providerFixture(fixture);
  let state = wrapperState(integrationApi.publishRemoteSource(fixture.record.file, {
    expectedRecordHash: fixture.record.hash, remote: 'origin', title: 'Publish for advanced rebase', body: '',
    provider: fake.provider,
  }, fixture.integration));
  const i = git(fixture.remoteRoot, 'rev-parse', 'refs/heads/main');
  const advancedBase = serverCommitWithFile(fixture, i, 'src/integration-only.txt',
    'independent integration bytes\n', 'Independent integration advance');
  git(fixture.remoteRoot, 'update-ref', 'refs/heads/main', advancedBase, i);
  fake.state.rebaseComposeBase = true;
  state = wrapperState(integrationApi.mergeRemoteSource(state.file, {
    expectedRecordHash: state.hash, prNumber: fake.state.prNumber, method: 'rebase',
    subject: 'Rebase over independent integration', body: '', provider: fake.provider,
  }, fixture.integration));
  const rebased = fake.state.mergeCommit;
  assert.deepEqual(git(fixture.remoteRoot, 'rev-list', '--parents', '-n', '1', rebased).split(' ').slice(1),
    [advancedBase]);
  assert.equal(git(fixture.remoteRoot, 'show', `${rebased}:src/integration-only.txt`),
    'independent integration bytes');
  assert.equal(git(fixture.remoteRoot, 'show', `${rebased}:src/value.txt`), 'remote candidate');
  const reconciled = integrationApi.reconcileRemoteSource(state.file, {
    expectedRecordHash: state.hash, prNumber: fake.state.prNumber, provider: fake.provider,
    fetchRemote: fetchFromFixture(fixture, []),
  }, fixture.integration);
  assertWrapper(reconciled, 'source-reconcile', 'LINEAGE_PROVEN');
  assert.equal(reconciled.result.source_merge_commit, rebased);
  assert.equal(reconciled.result.verified_integration_commit, rebased);
  assert.equal(fs.readFileSync(fixture.runFile, 'utf8'), fixture.sourceBytes);
});

test('provider interruption preserves one attempt across concurrency, fresh-process ambiguity, absence replay and merge adoption', async (t) => {
  await t.test('an executing publication rejects a concurrent provider write', () => {
    const fixture = finishedRemoteCandidate(t);
    const fake = providerFixture(fixture);
    let nested;
    const provider = {
      ...fake.provider,
      publish(target, options) {
        const current = JSON.parse(fs.readFileSync(fixture.record.file, 'utf8'));
        const currentHash = sha256(canonical(current));
        nested = integrationApi.publishRemoteSource(fixture.record.file, {
          expectedRecordHash: currentHash, remote: 'origin', title: 'Concurrent publish', body: 'One effect',
          provider: {
            inspect(currentTarget) { return { state: 'PR_ABSENT', expectedHead: currentTarget.expectedHead }; },
            publish() { assert.fail('concurrent call reached a second provider write'); },
          },
        }, fixture.integration);
        return fake.provider.publish(target, options);
      },
    };
    const published = integrationApi.publishRemoteSource(fixture.record.file, {
      expectedRecordHash: fixture.record.hash, remote: 'origin', title: 'Concurrent publish', body: 'One effect', provider,
    }, fixture.integration);
    assertWrapper(published, 'source-publish', 'PUBLISHED');
    assertWrapper(nested, 'source-publish', 'PROVIDER_EXECUTING');
    assert.equal(nested.result.attempt_token, published.result.attempt_token);
    assert.equal(published.record.remote.source.publication.attempts.length, 1);
    assert.equal(fake.calls.filter((item) => item.method === 'publish').length, 1);
  });

  await t.test('fresh process keeps an ended executing attempt unknown, then same-process exact absence replays its token', () => {
    const fixture = finishedRemoteCandidate(t);
    const fake = providerFixture(fixture);
    let publishCalls = 0;
    const title = 'Interrupted publish';
    const body = 'Recover only after exact absence.';
    const interruptedProvider = {
      ...fake.provider,
      publish(target, options) {
        publishCalls += 1;
        if (publishCalls === 1) throw new Error('simulated provider transport loss before effect');
        return fake.provider.publish(target, options);
      },
      inspect(target) {
        return { state: 'PR_ABSENT', expectedHead: target.expectedHead };
      },
    };
    const interrupted = integrationApi.publishRemoteSource(fixture.record.file, {
      expectedRecordHash: fixture.record.hash, remote: 'origin', title, body, provider: interruptedProvider,
    }, fixture.integration);
    assertWrapper(interrupted, 'source-publish', 'PROVIDER_UNKNOWN');
    const attempt = interrupted.record.remote.source.publication.attempts[0];
    assert.equal(attempt.transitions.at(-1).state, 'executing');
    const beforeFresh = fs.readFileSync(interrupted.file, 'utf8');

    const child = `${fixture.root}-fresh-reconcile.mjs`;
    t.after(() => fs.rmSync(child, { force: true }));
    const integrationUrl = new URL('../plugins/deliver/skills/deliver/scripts/lib/integration.mjs', import.meta.url).href;
    fs.writeFileSync(child, [
      `import { publishRemoteSource } from ${JSON.stringify(integrationUrl)};`,
      'const [file, hash, cwd, title, body] = process.argv.slice(2);',
      "const provider = { inspect(target) { return { state: 'PR_ABSENT', expectedHead: target.expectedHead }; },",
      "  publish() { throw new Error('fresh process must not replay'); } };",
      "const value = publishRemoteSource(file, { expectedRecordHash: hash, remote: 'origin', title, body, provider }, cwd);",
      'process.stdout.write(JSON.stringify(value.result));',
    ].join('\n'));
    const fresh = spawnSync(process.execPath, [child, interrupted.file, interrupted.hash,
      fixture.integration, title, body], { encoding: 'utf8' });
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.equal(JSON.parse(fresh.stdout).state, 'PROVIDER_UNKNOWN');
    assert.equal(fs.readFileSync(interrupted.file, 'utf8'), beforeFresh,
      'fresh-process ambiguity remains read-only');

    const replayed = integrationApi.publishRemoteSource(interrupted.file, {
      expectedRecordHash: interrupted.hash, remote: 'origin', title, body, provider: interruptedProvider,
    }, fixture.integration);
    assertWrapper(replayed, 'source-publish', 'PUBLISHED');
    assert.equal(publishCalls, 2);
    assert.equal(replayed.record.remote.source.publication.attempts.length, 1);
    assert.equal(replayed.record.remote.source.publication.attempts[0].token, attempt.token);
    assert.deepEqual(replayed.record.remote.source.publication.attempts[0].transitions.map((item) => item.state),
      ['prepared', 'executing', 'prepared', 'executing', 'observed']);
    assert.equal(replayed.record.remote.source.publication.attempts[0].transitions[2].replay.version,
      'remote-provider-replay-proof-v1');
  });

  await t.test('server merge completed before transport loss is reconciled onto the same attempt without replay', () => {
    const fixture = finishedRemoteCandidate(t);
    const fake = providerFixture(fixture);
    let state = wrapperState(integrationApi.publishRemoteSource(fixture.record.file, {
      expectedRecordHash: fixture.record.hash, remote: 'origin', title: 'Publish before merge loss', body: '',
      provider: fake.provider,
    }, fixture.integration));
    let mergeWrites = 0;
    const provider = {
      ...fake.provider,
      merge(target, options) {
        mergeWrites += 1;
        fake.provider.merge(target, options);
        throw new Error('simulated response loss after server merge');
      },
    };
    const unknown = integrationApi.mergeRemoteSource(state.file, {
      expectedRecordHash: state.hash, prNumber: fake.state.prNumber, method: 'merge',
      subject: 'Merge with lost response', body: '', provider,
    }, fixture.integration);
    assertWrapper(unknown, 'source-merge', 'PROVIDER_UNKNOWN');
    assert.equal(hasCommit(fixture.root, fake.state.mergeCommit), false);
    const recovered = integrationApi.mergeRemoteSource(unknown.file, {
      expectedRecordHash: unknown.hash, prNumber: fake.state.prNumber, method: 'merge',
      subject: 'Merge with lost response', body: '', provider,
    }, fixture.integration);
    assertWrapper(recovered, 'source-merge', 'SOURCE_MERGED');
    assert.equal(recovered.result.reconciled, true);
    assert.equal(mergeWrites, 1);
    assert.equal(recovered.record.remote.source.merge.attempts.length, 1);
    assert.equal(recovered.record.remote.source.merge.attempts[0].token, unknown.result.attempt_token);
    assert.deepEqual(recovered.record.remote.source.merge.attempts[0].transitions.map((item) => item.state),
      ['prepared', 'executing', 'observed']);
  });

  await t.test('queued merge observation cannot replay an ended merge invocation', () => {
    const fixture = finishedRemoteCandidate(t);
    const fake = providerFixture(fixture);
    let state = wrapperState(integrationApi.publishRemoteSource(fixture.record.file, {
      expectedRecordHash: fixture.record.hash, remote: 'origin', title: 'Publish before queued merge', body: '',
      provider: fake.provider,
    }, fixture.integration));
    let mergeWrites = 0;
    const provider = {
      ...fake.provider,
      merge() {
        mergeWrites += 1;
        throw new Error('simulated lost merge invocation');
      },
      reconcileMerged(target) {
        return { state: 'MERGE_PENDING', expectedHead: target.expectedHead };
      },
    };
    const unknown = integrationApi.mergeRemoteSource(state.file, {
      expectedRecordHash: state.hash, prNumber: fake.state.prNumber, method: 'merge',
      subject: 'Queue merge once', body: '', provider,
    }, fixture.integration);
    assertWrapper(unknown, 'source-merge', 'PROVIDER_UNKNOWN');
    const executingBytes = fs.readFileSync(unknown.file, 'utf8');
    const pending = integrationApi.mergeRemoteSource(unknown.file, {
      expectedRecordHash: unknown.hash, prNumber: fake.state.prNumber, method: 'merge',
      subject: 'Queue merge once', body: '', provider,
    }, fixture.integration);
    assert.equal(mergeWrites, 1, 'queued/open merge proof does not authorize another provider write');
    assertWrapper(pending, 'source-merge', 'PENDING');
    assert.equal(pending.result.provider_state, 'MERGE_PENDING');
    assert.equal(pending.hash, unknown.hash);
    assert.equal(fs.readFileSync(unknown.file, 'utf8'), executingBytes);
    assert.equal(pending.record.remote.source.merge.attempts.length, 1);
    assert.equal(pending.record.remote.source.merge.attempts[0].transitions.at(-1).state, 'executing');
  });
});

test('raced closure preserves concurrent integration bytes and repairs only the handoff through H2 and S', (t) => {
  requireRemoteApi();
  const flow = adoptedRemoteClosureArtifacts(t, finalizedRemoteEvidence(t));
  const { fixture, fake, closureRoot, h } = flow;
  let state = flow.state;
  const published = integrationApi.publishRemoteClosure(state.file, {
    expectedRecordHash: state.hash, remote: 'origin', title: 'Close raced S1-1', body: 'Preserve concurrent N',
    provider: fake.provider,
  }, fixture.integration);
  assertWrapper(published, 'closure-publish', 'PUBLISHED');
  state = wrapperState(published);
  fake.state.advanceBeforeMerge = true;
  const merged = integrationApi.publishRemoteClosure(state.file, {
    expectedRecordHash: state.hash, remote: 'origin', title: 'Close raced S1-1', body: 'Preserve concurrent N',
    provider: fake.provider,
  }, fixture.integration);
  assertWrapper(merged, 'closure-merge', 'MERGED');
  const r = fake.state.mergeCommit;
  const n = fake.state.advancedBase;
  assert.deepEqual(git(fixture.remoteRoot, 'rev-list', '--parents', '-n', '1', r).split(' ').slice(1), [n, h]);
  assert.equal(git(fixture.remoteRoot, 'show', `${r}:src/concurrent.txt`), 'preserve concurrent integration change');
  state = wrapperState(merged);
  const stale = integrationApi.reconcileRemoteClosure(state.file, {
    expectedRecordHash: state.hash, prNumber: fake.state.prNumber, provider: fake.provider,
    fetchRemote: fetchFromFixture(fixture, flow.fetchCalls),
  }, fixture.integration);
  assertWrapper(stale, 'closure-reconcile', 'HANDOFF_STALE');
  assert.equal(stale.result.closure_commit, r);
  assert.equal(stale.result.terminal_commit, r);
  state = wrapperState(stale);

  const repairRoot = `${fixture.root}-handoff-repair`;
  t.after(() => fs.rmSync(repairRoot, { recursive: true, force: true }));
  git(fixture.root, 'worktree', 'add', '-q', '-b', `pm/S1-1-handoff-repair-${Date.now()}`, repairRoot, r);
  write(repairRoot, '.codex/config.toml', 'model = "retained"\n');
  const repair = integrationApi.prepareHandoffRepair(state.file, {
    expectedRecordHash: state.hash, integrationRoot: repairRoot,
  }, fixture.integration);
  assertWrapper(repair, 'remote-handoff-repair-prepare', 'PREPARED');
  const repairPreparedBytes = fs.readFileSync(repair.file, 'utf8');
  const repairAttempt = repair.record.remote.handoff_repair.attempts.at(-1);
  const repairHandoff = path.join(repairRoot, ...repair.result.path.split('/'));
  let exactAfterResumed = false;
  try {
    const resumed = integrationApi.prepareHandoffRepair(repair.file, {
      expectedRecordHash: repair.hash, integrationRoot: repairRoot,
    }, fixture.integration);
    exactAfterResumed = resumed.hash === repair.hash && resumed.result.token === repair.result.token;
  } catch {}
  assert.equal(fs.readFileSync(repair.file, 'utf8'), repairPreparedBytes);
  fs.writeFileSync(repairHandoff, repairAttempt.write.before);
  let exactBeforeResumed = false;
  try {
    const resumed = integrationApi.prepareHandoffRepair(repair.file, {
      expectedRecordHash: repair.hash, integrationRoot: repairRoot,
    }, fixture.integration);
    exactBeforeResumed = resumed.hash === repair.hash && resumed.result.token === repair.result.token
      && fs.readFileSync(repairHandoff, 'utf8') === repairAttempt.write.after;
  } catch {}
  fs.writeFileSync(repairHandoff, 'partial handoff write\n');
  assert.throws(() => integrationApi.prepareHandoffRepair(repair.file, {
    expectedRecordHash: repair.hash, integrationRoot: repairRoot,
  }, fixture.integration), /partial|before|after|image|differ|prepared|resume/i);
  assert.equal(fs.readFileSync(repair.file, 'utf8'), repairPreparedBytes);
  assert.equal(fs.readFileSync(repairHandoff, 'utf8'), 'partial handoff write\n');
  fs.writeFileSync(repairHandoff, repairAttempt.write.after);
  git(repairRoot, 'add', '--', repair.result.path);
  git(repairRoot, 'commit', '-qm', 'Fresh remote handoff H2');
  const h2 = git(repairRoot, 'rev-parse', 'HEAD');
  const repairRecordBytes = fs.readFileSync(repair.file, 'utf8');
  const commonDir = path.resolve(repairRoot, git(repairRoot, 'rev-parse', '--git-common-dir'));
  const configFile = path.join(commonDir, 'config');
  const configBytes = fs.readFileSync(configFile);
  const ignoredFile = path.join(repairRoot, '.codex/config.toml');
  fs.writeFileSync(ignoredFile, 'model = "drifted"\n');
  let ignoredProtectedRefused = false;
  try {
    integrationApi.adoptHandoffRepair(repair.file, {
      expectedRecordHash: repair.hash, token: repair.result.token, commit: h2,
    }, fixture.integration);
  } catch (error) {
    ignoredProtectedRefused = /protected|ignored|checkout|changed|drift/i.test(error.message);
  }
  if (!ignoredProtectedRefused) fs.writeFileSync(repair.file, repairRecordBytes);
  fs.writeFileSync(ignoredFile, 'model = "retained"\n');
  git(repairRoot, 'config', 'core.hooksPath', '.repair-hooks-drift');
  assert.throws(() => integrationApi.adoptHandoffRepair(repair.file, {
    expectedRecordHash: repair.hash, token: repair.result.token, commit: h2,
  }, fixture.integration), /protected|anchor|config|checkout|changed|drift/i);
  assert.equal(fs.readFileSync(repair.file, 'utf8'), repairRecordBytes);
  fs.writeFileSync(configFile, configBytes);
  const adopted = integrationApi.adoptHandoffRepair(repair.file, {
    expectedRecordHash: repair.hash, token: repair.result.token, commit: h2,
  }, fixture.integration);
  assertWrapper(adopted, 'remote-handoff-repair-adopt', 'ADOPTED');
  assert.equal(git(repairRoot, 'diff-tree', '--no-commit-id', '--name-only', '-r', r, h2),
    state.record.handoff.path);
  assert.match(git(repairRoot, 'show', `${h2}:${state.record.handoff.path}`), new RegExp(`BASE_COMMIT: ${r}`));
  state = wrapperState(adopted);

  let repairPublishWrites = 0;
  let repairMergeWrites = 0;
  const interruptedRepairProvider = {
    ...fake.provider,
    publish(target, options) {
      repairPublishWrites += 1;
      if (repairPublishWrites === 1) throw new Error('lost repair publish invocation before effect');
      return fake.provider.publish(target, options);
    },
    merge(target, options) {
      repairMergeWrites += 1;
      fake.provider.merge(target, options);
      throw new Error('lost repair merge response after effect');
    },
  };
  const repairOptions = {
    remote: 'origin', title: 'Repair stale handoff', body: 'Publish H2', provider: interruptedRepairProvider,
  };
  const unknownRepairPublish = integrationApi.publishRemoteHandoffRepair(state.file, {
    expectedRecordHash: state.hash, ...repairOptions,
  }, fixture.integration);
  assertWrapper(unknownRepairPublish, 'handoff-repair-publish', 'PROVIDER_UNKNOWN');
  const unknownRepairBytes = fs.readFileSync(unknownRepairPublish.file, 'utf8');
  const repairChild = `${fixture.root}-repair-publish-reconcile.mjs`;
  t.after(() => fs.rmSync(repairChild, { force: true }));
  const integrationUrl = new URL('../plugins/deliver/skills/deliver/scripts/lib/integration.mjs', import.meta.url).href;
  fs.writeFileSync(repairChild, [
    `import { publishRemoteHandoffRepair } from ${JSON.stringify(integrationUrl)};`,
    'const [file, hash, cwd] = process.argv.slice(2);',
    "const provider = { inspect(target) { return { state: 'PR_ABSENT', expectedHead: target.expectedHead }; },",
    "  publish() { throw new Error('fresh process must not replay repair publish'); } };",
    "const value = publishRemoteHandoffRepair(file, { expectedRecordHash: hash, remote: 'origin', title: 'Repair stale handoff', body: 'Publish H2', provider }, cwd);",
    'process.stdout.write(JSON.stringify(value.result));',
  ].join('\n'));
  const freshRepair = spawnSync(process.execPath, [repairChild, unknownRepairPublish.file,
    unknownRepairPublish.hash, fixture.integration], { encoding: 'utf8' });
  assert.equal(freshRepair.status, 0, freshRepair.stderr);
  assert.equal(JSON.parse(freshRepair.stdout).state, 'PROVIDER_UNKNOWN');
  assert.equal(fs.readFileSync(unknownRepairPublish.file, 'utf8'), unknownRepairBytes);
  const repairPublished = integrationApi.publishRemoteHandoffRepair(unknownRepairPublish.file, {
    expectedRecordHash: unknownRepairPublish.hash, ...repairOptions,
  }, fixture.integration);
  assertWrapper(repairPublished, 'handoff-repair-publish', 'PUBLISHED');
  assert.equal(repairPublishWrites, 2);
  assert.equal(repairPublished.record.remote.handoff_repair.attempts.at(-1).publication.publish.attempts.length, 1);
  state = wrapperState(repairPublished);
  const unknownRepairMerge = integrationApi.publishRemoteHandoffRepair(state.file, {
    expectedRecordHash: state.hash, ...repairOptions,
  }, fixture.integration);
  assertWrapper(unknownRepairMerge, 'handoff-repair-merge', 'PROVIDER_UNKNOWN');
  const repairMerged = integrationApi.publishRemoteHandoffRepair(unknownRepairMerge.file, {
    expectedRecordHash: unknownRepairMerge.hash, ...repairOptions,
  }, fixture.integration);
  assertWrapper(repairMerged, 'handoff-repair-merge', 'MERGED');
  assert.equal(repairMergeWrites, 1);
  assert.equal(repairMerged.result.reconciled, true);
  assert.equal(repairMerged.record.remote.handoff_repair.attempts.at(-1).publication.merge.attempts.length, 1);
  const s = fake.state.mergeCommit;
  assert.deepEqual(git(fixture.remoteRoot, 'rev-list', '--parents', '-n', '1', s).split(' ').slice(1), [r, h2]);
  state = wrapperState(repairMerged);
  const repaired = integrationApi.reconcileRemoteHandoffRepair(state.file, {
    expectedRecordHash: state.hash, prNumber: fake.state.prNumber, provider: fake.provider,
    fetchRemote: fetchFromFixture(fixture, flow.fetchCalls),
  }, fixture.integration);
  assertWrapper(repaired, 'handoff-repair-reconcile', 'HANDOFF_REPAIRED');
  assert.equal(repaired.result.terminal_commit, s);
  assert.equal(git(fixture.root, 'show', `${s}:src/concurrent.txt`), 'preserve concurrent integration change');
  state = wrapperState(repaired);

  const completion = integrationApi.prepareRemoteCompletion(state.file, {
    expectedRecordHash: state.hash,
  }, fixture.integration);
  assertWrapper(completion, 'remote-completion-prepare', 'LOCAL_ADOPTION_PENDING');
  git(fixture.integration, 'merge', '--ff-only', completion.result.target);
  const complete = integrationApi.adoptRemoteCompletion(completion.file, {
    expectedRecordHash: completion.hash, token: completion.result.token,
  }, fixture.integration);
  assertWrapper(complete, 'remote-completion-adopt', 'COMPLETE');
  assert.equal(git(fixture.integration, 'show', 'HEAD:src/concurrent.txt'), 'preserve concurrent integration change');
  assert.equal(readStory(fixture.integration, storyRel).execution.status, 'merged');
  assert.equal(fs.readFileSync(fixture.runFile, 'utf8'), fixture.sourceBytes);
  assert.equal(git(closureRoot, 'rev-parse', 'HEAD'), h, 'provisional closure checkout remains immutable at H');
  assert.equal(exactAfterResumed, true, 'exact H2 after-image resumes with the retained preparation token');
  assert.equal(exactBeforeResumed, true, 'exact H2 before-image reapplies the retained after-image and token');
  assert.equal(ignoredProtectedRefused, true,
    'worktree-local ignored protected metadata drift refuses H2 adoption');
});

test('raced closure reconciliation rejects overwritten closure paths and unproved wrapper paths unchanged', async (t) => {
  const shared = adoptedRemoteClosureArtifacts(t, finalizedRemoteEvidence(t));
  const sharedRecordBytes = fs.readFileSync(shared.state.file, 'utf8');
  const sharedRemoteBase = shared.state.record.remote.integration_evidence.commit;
  const invalidRace = (mode, configure) => {
    const flow = shared;
    const { fixture, fake } = flow;
    fs.writeFileSync(flow.state.file, sharedRecordBytes);
    const currentRemoteBase = git(fixture.remoteRoot, 'rev-parse', 'refs/heads/main');
    git(fixture.remoteRoot, 'update-ref', 'refs/heads/main', sharedRemoteBase, currentRemoteBase);
    Object.assign(fake.state, {
      prNumber: 17, merged: false, mergeCommit: null, remoteBase: null,
      publishedHead: fixture.candidate, advancedBase: null, advanceBeforeMerge: false,
      advancePath: 'src/concurrent.txt', advanceValue: 'preserve concurrent integration change\n',
      advanceModePath: null, racedTreeMode: mode,
    });
    let state = wrapperState(integrationApi.publishRemoteClosure(flow.state.file, {
      expectedRecordHash: flow.state.hash, remote: 'origin', title: 'Invalid raced closure', body: 'Must refuse',
      provider: fake.provider,
    }, fixture.integration));
    fake.state.advanceBeforeMerge = true;
    configure?.(fake, flow);
    state = wrapperState(integrationApi.publishRemoteClosure(state.file, {
      expectedRecordHash: state.hash, remote: 'origin', title: 'Invalid raced closure', body: 'Must refuse',
      provider: fake.provider,
    }, fixture.integration));
    const before = fs.readFileSync(state.file, 'utf8');
    assert.throws(() => integrationApi.reconcileRemoteClosure(state.file, {
      expectedRecordHash: state.hash, prNumber: fake.state.prNumber, provider: fake.provider,
      fetchRemote: fetchFromFixture(fixture, flow.fetchCalls),
    }, fixture.integration), /closure|wrapper|path|tree|preimage|concurrent|lineage|exact/i);
    assert.equal(fs.readFileSync(state.file, 'utf8'), before);
    assert.deepEqual(git(fixture.remoteRoot, 'rev-list', '--parents', '-n', '1', fake.state.mergeCommit)
      .split(' ').slice(1), [fake.state.advancedBase, flow.h]);
    return { flow, mergeCommit: fake.state.mergeCommit };
  };

  await t.test('selecting H over a concurrently changed story path is not a valid raced merge', () => {
    const result = invalidRace('head', (fake, flow) => {
      fake.state.advancePath = storyRel;
      fake.state.advanceValue = `${git(flow.fixture.remoteRoot, 'show', `${flow.state.record.remote.integration_evidence.commit}:${storyRel}`)}\nConcurrent story edit\n`;
    });
    assert.equal(git(result.flow.fixture.remoteRoot, 'rev-parse', `${result.mergeCommit}^{tree}`),
      git(result.flow.fixture.remoteRoot, 'rev-parse', `${result.flow.h}^{tree}`));
  });

  await t.test('a wrapper-introduced path absent from both N and H is not accepted', () => {
    const result = invalidRace('extra');
    assert.equal(git(result.flow.fixture.remoteRoot, 'show', `${result.mergeCommit}:remote-wrapper-extra.txt`),
      'unproved wrapper path');
  });

  await t.test('identical closure bytes with a concurrent executable-mode change cannot be overwritten by H', () => {
    const result = invalidRace('head', (fake) => {
      fake.state.advanceModePath = storyRel;
    });
    const { fixture } = result.flow;
    const nEntry = git(fixture.remoteRoot, 'ls-tree', result.flow.fake.state.advancedBase, '--', storyRel)
      .split(/\s+/);
    const hEntry = git(fixture.remoteRoot, 'ls-tree', result.flow.h, '--', storyRel).split(/\s+/);
    const rEntry = git(fixture.remoteRoot, 'ls-tree', result.mergeCommit, '--', storyRel).split(/\s+/);
    assert.equal(nEntry[0], '100755');
    assert.equal(hEntry[0], '100644');
    assert.equal(nEntry[2], hEntry[2], 'the concurrent mode change retains identical blob bytes');
    assert.equal(rEntry[0], '100644', 'the invalid wrapper selected H mode over N');
  });
});

test('handoff repair permits retries zero through two and exhausts only after a third proved base race', (t) => {
  requireRemoteApi();
  const flow = adoptedRemoteClosureArtifacts(t, finalizedRemoteEvidence(t));
  const { fixture, fake } = flow;
  let state = wrapperState(integrationApi.publishRemoteClosure(flow.state.file, {
    expectedRecordHash: flow.state.hash, remote: 'origin', title: 'Closure before repair races', body: '',
    provider: fake.provider,
  }, fixture.integration));
  fake.state.advanceBeforeMerge = true;
  state = wrapperState(integrationApi.publishRemoteClosure(state.file, {
    expectedRecordHash: state.hash, remote: 'origin', title: 'Closure before repair races', body: '',
    provider: fake.provider,
  }, fixture.integration));
  let reconciled = integrationApi.reconcileRemoteClosure(state.file, {
    expectedRecordHash: state.hash, prNumber: fake.state.prNumber, provider: fake.provider,
    fetchRemote: fetchFromFixture(fixture, flow.fetchCalls),
  }, fixture.integration);
  assertWrapper(reconciled, 'closure-reconcile', 'HANDOFF_STALE');
  state = wrapperState(reconciled);
  let parent = reconciled.result.terminal_commit;

  for (let retry = 0; retry <= 2; retry++) {
    const repairRoot = `${fixture.root}-repair-retry-${retry}`;
    t.after(() => fs.rmSync(repairRoot, { recursive: true, force: true }));
    git(fixture.root, 'worktree', 'add', '-q', '-b', `pm/S1-1-repair-${retry}-${Date.now()}`, repairRoot, parent);
    const prepared = integrationApi.prepareHandoffRepair(state.file, {
      expectedRecordHash: state.hash, integrationRoot: repairRoot,
    }, fixture.integration);
    assertWrapper(prepared, 'remote-handoff-repair-prepare', 'PREPARED');
    const attempt = prepared.record.remote.handoff_repair.attempts.at(-1);
    assert.equal(attempt.retry, retry);
    assert.equal(attempt.parent, parent);
    git(repairRoot, 'add', '--', prepared.result.path);
    git(repairRoot, 'commit', '-qm', `Repair H2 retry ${retry}`);
    const h2 = git(repairRoot, 'rev-parse', 'HEAD');
    state = wrapperState(integrationApi.adoptHandoffRepair(prepared.file, {
      expectedRecordHash: prepared.hash, token: prepared.result.token, commit: h2,
    }, fixture.integration));
    state = wrapperState(integrationApi.publishRemoteHandoffRepair(state.file, {
      expectedRecordHash: state.hash, remote: 'origin', title: `Repair retry ${retry}`, body: '',
      provider: fake.provider,
    }, fixture.integration));
    state = wrapperState(integrationApi.publishRemoteHandoffRepair(state.file, {
      expectedRecordHash: state.hash, remote: 'origin', title: `Repair retry ${retry}`, body: '',
      provider: fake.provider,
    }, fixture.integration));
    const wrapper = fake.state.mergeCommit;
    const racedTip = serverCommitWithFile(fixture, wrapper, `src/repair-race-${retry}.txt`,
      `repair race ${retry}\n`, `Advance after repair ${retry}`);
    git(fixture.remoteRoot, 'update-ref', 'refs/heads/main', racedTip, wrapper);
    const before = fs.readFileSync(state.file, 'utf8');
    reconciled = integrationApi.reconcileRemoteHandoffRepair(state.file, {
      expectedRecordHash: state.hash, prNumber: fake.state.prNumber, provider: fake.provider,
      fetchRemote: fetchFromFixture(fixture, flow.fetchCalls),
    }, fixture.integration);
    assertWrapper(reconciled, 'handoff-repair-reconcile', retry < 2 ? 'HANDOFF_BASE_RACE' : 'EXHAUSTED');
    if (retry < 2) {
      assert.notEqual(reconciled.hash, state.hash);
      assert.equal(reconciled.record.remote.handoff_repair.publication_retry, retry + 1);
      const polledAgain = integrationApi.reconcileRemoteHandoffRepair(reconciled.file, {
        expectedRecordHash: reconciled.hash, prNumber: fake.state.prNumber, provider: fake.provider,
        fetchRemote: fetchFromFixture(fixture, flow.fetchCalls),
      }, fixture.integration);
      assert.equal(polledAgain.hash, reconciled.hash, 'repeated race poll does not spend another retry');
      assert.equal(polledAgain.record.remote.handoff_repair.publication_retry, retry + 1);
      state = wrapperState(reconciled);
      parent = racedTip;
    } else {
      assert.equal(reconciled.record.remote.handoff_repair.publication_retry, 2,
        'exhaustion retains the two authorized replacement retries');
      assert.equal(reconciled.record.remote.handoff_repair.attempts.length, 3);
      assert.equal(fs.readFileSync(state.file, 'utf8') === before || reconciled.hash !== state.hash, true);
    }
  }
});

test('remote CLI rejects unsafe flags and unbounded or indirect body files before provider dispatch', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-remote-cli-bounds-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Casey Example');
  git(root, 'config', 'user.email', 'casey@example.invalid');
  assert.equal(call(root, pmCli, 'init').status, 0);
  write(root, 'body.txt', 'bounded body\n');
  fs.symlinkSync('body.txt', path.join(root, 'body-link.txt'));
  fs.writeFileSync(path.join(root, 'body-large.txt'), Buffer.alloc(1024 * 1024 + 1, 0x61));
  const base = ['remote-source-publish', '--integration', 'missing.json', '--expected-record', '0'.repeat(64),
    '--remote', 'origin', '--title', 'Bounded CLI'];
  for (const bodyFile of ['body-link.txt', 'body-large.txt']) {
    const refused = call(root, pmCli, ...base, '--body-file', bodyFile);
    assert.equal(refused.status, 64);
    assert.match(refused.stdout, /body-file|bounded regular file/i);
  }
  for (const flag of ['--force', '--admin', '--auto', '--delete-branch']) {
    const refused = call(root, pmCli, ...base, '--body-file', 'body.txt', flag);
    assert.equal(refused.status, 64);
    assert.match(refused.stdout, /unknown|option/i);
  }
});

test('completion refuses a divergent local branch, dirty fast-forward and stale token without changing its record', (t) => {
  const flow = adoptedRemoteClosureArtifacts(t, finalizedRemoteEvidence(t));
  const { fixture, fake } = flow;
  let state = wrapperState(integrationApi.publishRemoteClosure(flow.state.file, {
    expectedRecordHash: flow.state.hash, remote: 'origin', title: 'Close for adoption negatives', body: '',
    provider: fake.provider,
  }, fixture.integration));
  state = wrapperState(integrationApi.publishRemoteClosure(state.file, {
    expectedRecordHash: state.hash, remote: 'origin', title: 'Close for adoption negatives', body: '',
    provider: fake.provider,
  }, fixture.integration));
  state = wrapperState(integrationApi.reconcileRemoteClosure(state.file, {
    expectedRecordHash: state.hash, prNumber: fake.state.prNumber, provider: fake.provider,
    fetchRemote: fetchFromFixture(fixture, flow.fetchCalls),
  }, fixture.integration));
  const i = git(fixture.integration, 'rev-parse', 'HEAD');
  write(fixture.integration, 'src/local-divergence.txt', 'local divergent commit\n');
  git(fixture.integration, 'add', 'src/local-divergence.txt');
  git(fixture.integration, 'commit', '-qm', 'Divergent local integration');
  const beforeNonFastForward = fs.readFileSync(state.file, 'utf8');
  assert.throws(() => integrationApi.prepareRemoteCompletion(state.file, {
    expectedRecordHash: state.hash,
  }, fixture.integration), /fast-forward|ancestor|completion target/i);
  assert.equal(fs.readFileSync(state.file, 'utf8'), beforeNonFastForward);
  git(fixture.integration, 'reset', '--hard', i);

  const prepared = integrationApi.prepareRemoteCompletion(state.file, {
    expectedRecordHash: state.hash,
  }, fixture.integration);
  assertWrapper(prepared, 'remote-completion-prepare', 'LOCAL_ADOPTION_PENDING');
  git(fixture.integration, 'merge', '--ff-only', prepared.result.target);
  write(fixture.integration, 'src/value.txt', 'dirty after fast-forward\n');
  const preparedBytes = fs.readFileSync(prepared.file, 'utf8');
  assert.throws(() => integrationApi.adoptRemoteCompletion(prepared.file, {
    expectedRecordHash: prepared.hash, token: prepared.result.token,
  }, fixture.integration), /clean|dirty|checkout|worktree/i);
  assert.equal(fs.readFileSync(prepared.file, 'utf8'), preparedBytes);
  git(fixture.integration, 'checkout', '--', 'src/value.txt');
  assert.throws(() => integrationApi.adoptRemoteCompletion(prepared.file, {
    expectedRecordHash: prepared.hash, token: '00000000-0000-4000-8000-000000000000',
  }, fixture.integration), /token/i);
  assert.equal(fs.readFileSync(prepared.file, 'utf8'), preparedBytes);
  const completed = integrationApi.adoptRemoteCompletion(prepared.file, {
    expectedRecordHash: prepared.hash, token: prepared.result.token,
  }, fixture.integration);
  assertWrapper(completed, 'remote-completion-adopt', 'COMPLETE');
});

test('fresh process resumes retained remote-M evidence through gate, review, verification and finalization', (t) => {
  const fixture = finishedRemoteCandidate(t);
  const fake = providerFixture(fixture);
  let state = wrapperState(integrationApi.publishRemoteSource(fixture.record.file, {
    expectedRecordHash: fixture.record.hash, remote: 'origin', title: 'Publish before evidence resume', body: '',
    provider: fake.provider,
  }, fixture.integration));
  state = wrapperState(integrationApi.mergeRemoteSource(state.file, {
    expectedRecordHash: state.hash, prNumber: fake.state.prNumber, method: 'merge',
    subject: 'Merge before evidence resume', body: '', provider: fake.provider,
  }, fixture.integration));
  const reconciled = integrationApi.reconcileRemoteSource(state.file, {
    expectedRecordHash: state.hash, prNumber: fake.state.prNumber, provider: fake.provider,
    fetchRemote: fetchFromFixture(fixture, []),
  }, fixture.integration);
  state = wrapperState(reconciled);
  const evidenceRoot = `${fixture.root}-fresh-process-evidence`;
  t.after(() => fs.rmSync(evidenceRoot, { recursive: true, force: true }));
  git(fixture.root, 'worktree', 'add', '-q', '-b', reconciled.result.evidence_branch,
    evidenceRoot, reconciled.result.verified_integration_commit);
  const prepared = integrationApi.prepareRemoteIntegrationEvidence(state.file, {
    expectedRecordHash: state.hash, evidenceRoot,
  }, fixture.integration);
  const snapshot = prepared.result.snapshot_hash;
  const child = `${fixture.root}-evidence-resume.mjs`;
  t.after(() => fs.rmSync(child, { force: true }));
  const integrationUrl = new URL('../plugins/deliver/skills/deliver/scripts/lib/integration.mjs', import.meta.url).href;
  fs.writeFileSync(child, [
    `import * as api from ${JSON.stringify(integrationUrl)};`,
    "let [file, hash, cwd, snapshot] = process.argv.slice(2);",
    "let value = api.runRemoteIntegrationGate(file, { expectedRecordHash: hash, name: 'test' }, cwd);",
    "({ file, hash } = value);",
    "value = api.recordRemoteIntegrationReview(file, { expectedRecordHash: hash, reviewer: 'fresh-reviewer', receipt: { status: 'PASS', findings: [], panel: { snapshot_hash: snapshot, members: [{ lens: 'code-integrity-reviewer', reviewer: 'fresh-panel-reviewer', verdict: 'PASS', snapshot_hash: snapshot, findings: [] }] } } }, cwd);",
    "({ file, hash } = value);",
    "value = api.recordRemoteIntegrationVerification(file, { expectedRecordHash: hash, verifier: 'fresh-verifier', results: { criteria: [{ id: 'AC-1', status: 'PASS', evidence: 'Fresh process evidence passed.' }] } }, cwd);",
    "({ file, hash } = value);",
    "value = api.finalizeRemoteIntegrationEvidence(file, { expectedRecordHash: hash }, cwd);",
    "process.stdout.write(JSON.stringify({ file: value.file, hash: value.hash, result: value.result, record: value.record }));",
  ].join('\n'));
  const resumed = spawnSync(process.execPath, [child, prepared.file, prepared.hash,
    fixture.integration, snapshot], { encoding: 'utf8' });
  assert.equal(resumed.status, 0, resumed.stderr);
  const value = JSON.parse(resumed.stdout);
  assert.equal(value.result.operation, 'remote-evidence-finalize');
  assert.equal(value.result.state, 'REMOTE_EVIDENCE_FINALIZED');
  assert.equal(value.record.remote.integration_evidence.commit, reconciled.result.verified_integration_commit);
  assert.equal(value.record.remote.integration_evidence.snapshot_hash, snapshot);
  assert.equal(value.record.integration.commit, null);
  assert.equal(git(fixture.integration, 'rev-parse', 'HEAD'), fixture.record.record.integration.base);
  assert.equal(fs.readFileSync(fixture.runFile, 'utf8'), fixture.sourceBytes);
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.runFile, 'utf8')).counters, fixture.sourceCounters);
});

test('multiple legitimate completed remote records remain history and permit the next story', (t) => {
  const first = completeNormalRemoteFlow(t, finalizedRemoteEvidence(t));
  assert.equal(currentPmApi.remoteAdmissionStatus(first.fixture.integration).state, 'COMPLETE');
  const secondFixture = nextRemoteCandidate(t, first);
  const second = completeNormalRemoteFlow(t, finalizeRemoteCandidate(t, secondFixture));
  assert.equal(readStory(second.fixture.integration, storyRel).execution.status, 'merged');
  assert.equal(readStory(second.fixture.integration, nextStoryRel).execution.status, 'merged');
  const integrations = fs.readdirSync(path.join(second.fixture.integration, '.deliver/integrations'))
    .filter((name) => name.endsWith('.json'));
  assert.equal(integrations.length, 2, 'both completed remote records remain durable history');
  const admission = currentPmApi.remoteAdmissionStatus(second.fixture.integration);
  assert.equal(admission.state, 'COMPLETE');
  assert.equal(admission.blocking, false);
  assert.equal(admission.integration_record, second.completed.file);
  assert.equal(admission.diagnostics.some((item) => /ambiguous|multiple/i.test(`${item.code} ${item.message}`)), false);
  const claimed = call(second.fixture.integration, pmCli, 'claim', '--story', thirdStoryRel);
  assert.equal(claimed.status, 0, claimed.stdout);
});
