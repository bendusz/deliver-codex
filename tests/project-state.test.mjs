import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectState as upstreamInspect } from './fixtures/upstream-v0.25.1/hooks/lib.mjs';
import {
  detectProjectFormat,
  inspectProjectState,
  readApprovalMarker,
  readPlanPolicy,
} from '../plugins/deliver/skills/deliver/scripts/lib/project-state.mjs';

const pmCli = fileURLToPath(new URL('../plugins/deliver/skills/deliver/scripts/pm.mjs', import.meta.url));
const actor = 'casey-example-com-589b8fa8ab93';

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}

function project(t, { identity = true } = {}) {
  const container = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-project-state-')));
  const root = path.join(container, 'repo');
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(container, { recursive: true, force: true }));
  git(root, 'init', '-q', '--initial-branch=main');
  if (identity) {
    git(root, 'config', 'user.name', 'Casey Example');
    git(root, 'config', 'user.email', 'casey@example.com');
  }
  return { root, container };
}

function write(root, rel, value) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function story(id, { status, owner = actor, branch = `pm/${id}-work`, sprint = Number(id.match(/^S(\d+)-/)[1]) }) {
  return [
    `# ${id}: Project-state fixture`,
    '<!-- pm-meta: {"builder":"codex-builder","touches":["src"]} -->',
    `Sprint: ${sprint} · Priority: high · Covers: AC-001 · Depends on: none · Parallel-safe: yes`,
    'Risk: low · Review lenses: code-integrity-reviewer · Specs: none',
    '',
    '## Goal',
    'Exercise the inspector.',
    '',
    '## Acceptance criteria (testable)',
    '- [ ] Inspector state is derived from repository artifacts.',
    '',
    '## Verification',
    '- Prove done with: `node --test`',
    '',
    '## Execution',
    `<!-- pm-exec: ${JSON.stringify({ owner, builder: 'codex-builder', branch, status, rounds: 1, retries: 0, updated: '2026-09-10 10:00' })} -->`,
    '',
  ].join('\n');
}

function approve(root, plan, extra = {}) {
  write(root, 'docs/plan.md', plan);
  const digest = git(root, 'hash-object', 'docs/plan.md');
  write(root, 'docs/approval.json', {
    status: 'approved',
    approver: 'Ben',
    approved_date: '2026-09-10',
    plan_digest: digest,
    updated: '2026-09-10 10:00',
    ...extra,
  });
  return digest;
}

const sharedFields = [
  'managed', 'legacy', 'phase', 'next_reference', 'actor', 'branch', 'story', 'unmerged',
  'unreadable', 'claims', 'sprints_without_retro', 'worktrees', 'uncommitted', 'handoff', 'wiki_entries',
];

test('inspectProjectState matches the pinned upstream reader for a current project', (t) => {
  const { root, container } = project(t);
  const plan = '# Plan\n\n## Delivery mode\n- Scale: standard\n- Checkpoint policy: story-level\n- Integration branch: main\n- Skeleton: none\n';
  approve(root, plan);
  write(root, 'docs/stories/S1-1-done.md', story('S1-1', { status: 'merged', branch: 'pm/S1-1-done' }));
  write(root, 'docs/stories/S1-2-done.md', story('S1-2', { status: 'merged', branch: 'pm/S1-2-done' }));
  write(root, 'docs/stories/S2-1-work.md', story('S2-1', { status: 'building', branch: 'pm/S2-1-work' }));
  write(root, 'docs/stories/S2-2-other.md', story('S2-2', { status: 'claimed', owner: 'other-actor', branch: 'pm/S2-2-other' }));
  write(root, 'docs/wiki/index.md', '- first\n- second\n');
  git(root, 'add', 'docs');
  git(root, 'commit', '-qm', 'Create current project');
  const base = git(root, 'rev-parse', 'HEAD');
  write(root, `docs/handoff/${actor}.md`, `# HANDOFF\n\nBASE_COMMIT: ${base}\n`);
  git(root, 'add', 'docs/handoff');
  git(root, 'commit', '-qm', 'Record handoff');
  git(root, 'checkout', '-qb', 'pm/S2-1-work');
  git(root, 'worktree', 'add', '-q', '-b', 'pm/S2-2-other', path.join(container, 'other-worktree'), 'main');

  const upstream = upstreamInspect(root);
  const actual = inspectProjectState(root);
  for (const field of sharedFields) assert.deepEqual(actual[field], upstream[field], field);
  assert.deepEqual({
    status: actual.approval.status,
    approver: actual.approval.approver,
    approved_date: actual.approval.approved_date,
    plan_digest: actual.approval.plan_digest,
    plan_changed: actual.approval.plan_changed,
  }, upstream.approval);
  assert.equal(actual.format, 'current');
  assert.equal(actual.current_sprint, 1, 'the oldest missing retrospective takes precedence');
  assert.equal(actual.plan.scale, 'standard');
  assert.equal(actual.plan.checkpointPolicy, 'story-level');
  assert.equal(actual.approval.implementation_ready, true);
  assert.equal(actual.stories.length, 4);
  assert.deepEqual(actual.diagnostics, []);
});

test('approval phase follows upstream while implementation readiness fails closed', (t) => {
  const { root } = project(t);
  const plan = '# Plan\n\n## Delivery mode\n- Scale: tiny\n';
  const digest = approve(root, plan);
  let state = inspectProjectState(root);
  assert.equal(state.phase, 'decomposition');
  assert.equal(state.approval.implementation_ready, false, 'untracked approval cannot authorize execution');
  assert.equal(state.approval.marker_tracked, false);
  assert.equal(state.approval.plan_tracked, false);

  git(root, 'add', 'docs');
  git(root, 'commit', '-qm', 'Approve plan');
  state = inspectProjectState(root);
  assert.equal(state.approval.implementation_ready, true);
  assert.equal(state.approval.plan_digest, digest);

  write(root, 'docs/plan.md', `${plan}\nchanged\n`);
  state = inspectProjectState(root);
  assert.equal(state.phase, 'planning');
  assert.equal(state.approval.plan_changed, true);
  assert.equal(state.approval.implementation_ready, false);

  write(root, 'docs/plan.md', plan);
  write(root, 'docs/approval.json', { status: 'approved', approver: 'Ben', plan_digest: null });
  state = inspectProjectState(root);
  assert.equal(state.phase, 'decomposition', 'derived upstream phase remains separate from the stricter execution gate');
  assert.equal(state.approval.implementation_ready, false);
  assert.ok(state.diagnostics.some((item) => item.code === 'APPROVAL_NOT_EXECUTABLE' && item.status === 'MISSING'));
});

test('non-executable approval cannot accompany a completed phase', (t) => {
  const missingPlan = project(t);
  write(missingPlan.root, 'docs/approval.json', { status: 'approved', approver: 'Ben', plan_digest: null });
  write(missingPlan.root, 'docs/stories/S1-1-done.md', story('S1-1', { status: 'merged' }));
  write(missingPlan.root, 'docs/retros/sprint-1.md', '# Sprint 1 retrospective\n');
  git(missingPlan.root, 'add', 'docs');
  git(missingPlan.root, 'commit', '-qm', 'Track incomplete approval');
  let state = inspectProjectState(missingPlan.root);
  assert.equal(state.approval.implementation_ready, false);
  assert.equal(state.phase, 'planning');

  const untracked = project(t);
  write(untracked.root, 'README.md', '# seed\n');
  git(untracked.root, 'add', 'README.md');
  git(untracked.root, 'commit', '-qm', 'Seed repository');
  approve(untracked.root, '# Plan\n\n## Delivery mode\n- Scale: tiny\n');
  write(untracked.root, 'docs/stories/S1-1-done.md', story('S1-1', { status: 'merged' }));
  state = inspectProjectState(untracked.root);
  assert.equal(state.approval.marker_tracked, false);
  assert.equal(state.approval.plan_tracked, false);
  assert.equal(state.approval.implementation_ready, false);
  assert.equal(state.phase, 'planning');
});

test('format detection keeps standalone plans separate and recognizes deleted current markers', (t) => {
  const { root } = project(t);
  write(root, 'docs/plan.md', '# Standalone Managed plan\n');
  assert.equal(detectProjectFormat(root), 'none');
  assert.equal(inspectProjectState(root), null);

  write(root, 'pm/pm-state.json', '{}\n');
  assert.equal(detectProjectFormat(root), 'legacy');
  fs.rmSync(path.join(root, 'pm'), { recursive: true });

  approve(root, '# Shared plan\n');
  git(root, 'add', 'docs');
  git(root, 'commit', '-qm', 'Track current project');
  fs.unlinkSync(path.join(root, 'docs/approval.json'));
  assert.equal(detectProjectFormat(root), 'current');
  const state = inspectProjectState(root, { actorId: null });
  assert.equal(state.phase, 'planning');
  assert.ok(state.diagnostics.some((item) => item.code === 'APPROVAL_MISSING'));
});

test('malformed, symlink, FIFO, and unreadable story artifacts never report completion', (t) => {
  const { root } = project(t);
  const plan = '# Plan\n\n## Delivery mode\n- Scale: tiny\n';
  approve(root, plan);
  write(root, 'docs/stories/S1-1-good.md', story('S1-1', { status: 'merged' }));
  write(root, 'docs/stories/S1-2-bad.md', story('S1-2', { status: 'merged' }).replace('"rounds":1', '"rounds":-1'));
  git(root, 'add', 'docs');
  git(root, 'commit', '-qm', 'Track malformed project');

  let state = inspectProjectState(root, { actorId: null });
  assert.equal(state.phase, 'implementation');
  assert.deepEqual(state.unreadable, ['S1-2']);
  assert.deepEqual(state.unmerged, ['S1-2']);
  assert.ok(state.diagnostics.some((item) => item.code === 'STORY_UNREADABLE'));

  fs.unlinkSync(path.join(root, 'docs/approval.json'));
  fs.symlinkSync('plan.md', path.join(root, 'docs/approval.json'));
  assert.throws(() => readApprovalMarker(root), /symlink/);
  state = inspectProjectState(root, { actorId: null });
  assert.notEqual(state.phase, 'done');
  assert.ok(state.diagnostics.some((item) => item.code === 'APPROVAL_UNREADABLE'));

  fs.unlinkSync(path.join(root, 'docs/approval.json'));
  if (process.platform !== 'win32') {
    execFileSync('mkfifo', [path.join(root, 'docs/approval.json')]);
    assert.throws(() => readApprovalMarker(root), /regular file/);
    state = inspectProjectState(root, { actorId: null });
    assert.notEqual(state.phase, 'done');
  }
});

test('missing identity and missing Git objects produce bounded read-only diagnostics', (t) => {
  const { root } = project(t, { identity: false });
  write(root, 'docs/approval.json', { status: 'approved', approver: 'Ben', plan_digest: null });
  fs.rmSync(path.join(root, '.git'), { recursive: true });
  const before = fs.readFileSync(path.join(root, 'docs/approval.json'), 'utf8');
  const state = inspectProjectState(root, { actorId: null });
  assert.equal(state.actor, null);
  assert.equal(state.handoff, null);
  assert.notEqual(state.phase, 'done');
  assert.equal(fs.readFileSync(path.join(root, 'docs/approval.json'), 'utf8'), before);
  assert.ok(state.diagnostics.some((item) => item.code.startsWith('GIT_') && item.status === 'UNKNOWN'));
});

test('plan policy rejects malformed fields and reads the current policy names', (t) => {
  const { root } = project(t);
  write(root, 'docs/plan.md', '# Plan\n- Scale: regulated\n- Checkpoint policy: autonomous\n- Integration branch: release/current\n- Skeleton: specdd\n');
  assert.deepEqual(readPlanPolicy(root), {
    path: 'docs/plan.md',
    scale: 'regulated',
    checkpointPolicy: 'autonomous',
    integrationBranch: 'release/current',
    skeleton: 'specdd',
  });
  write(root, 'docs/plan.md', '# Plan\n- Scale: enormous\n');
  assert.throws(() => readPlanPolicy(root), /Scale/);
  for (const branch of ['foo//bar', 'foo.', 'foo.lock', 'foo@{bar', '@', '-foo', '.hidden', 'foo/.hidden']) {
    write(root, 'docs/plan.md', `# Plan\n- Integration branch: ${branch}\n`);
    assert.throws(() => readPlanPolicy(root), /Integration branch/, branch);
  }
});

test('a valid digest over malformed policy cannot produce a completed state', (t) => {
  const { root } = project(t);
  const malformed = '# Plan\n\n## Delivery mode\n- Scale: enormous\n';
  approve(root, malformed);
  write(root, 'docs/stories/S1-1-done.md', story('S1-1', { status: 'merged' }));
  write(root, 'docs/retros/sprint-1.md', '# Sprint 1 retrospective\n');
  git(root, 'add', 'docs');
  git(root, 'commit', '-qm', 'Track malformed policy');
  const state = inspectProjectState(root);
  assert.equal(state.approval.plan_changed, false);
  assert.equal(state.phase, 'planning');
  assert.notEqual(state.phase, 'done');
  assert.ok(state.diagnostics.some((item) => item.code === 'PLAN_POLICY_INVALID' && item.status === 'DRIFT'));
});

test('pm status exposes current inspection and preserves legacy status reads', (t) => {
  const current = project(t);
  approve(current.root, '# Plan\n');
  git(current.root, 'add', 'docs');
  git(current.root, 'commit', '-qm', 'Current project');
  const currentResult = spawnSync(process.execPath, [pmCli, 'status'], { cwd: current.root, encoding: 'utf8' });
  assert.equal(currentResult.status, 0, currentResult.stdout);
  const currentJson = JSON.parse(currentResult.stdout);
  assert.equal(currentJson.ok, true);
  assert.equal(currentJson.format, 'current');
  assert.equal(currentJson.approval.implementation_ready, true);

  const legacy = project(t);
  write(legacy.root, 'pm/pm-state.json', {
    project: 'Legacy',
    spec: null,
    constitution: null,
    scale: 'standard',
    phase: 'implementation',
    signed_off: true,
    approver: 'Ben',
    approved_date: '2026-09-01',
    integration_branch: 'main',
    current_sprint: 1,
    total_sprints: 1,
    last_analysis_status: null,
    assignments: {},
    updated: '2026-09-01',
  });
  git(legacy.root, 'add', 'pm');
  git(legacy.root, 'commit', '-qm', 'Legacy project');
  const legacyResult = spawnSync(process.execPath, [pmCli, 'status'], { cwd: legacy.root, encoding: 'utf8' });
  assert.equal(legacyResult.status, 0, legacyResult.stdout);
  const legacyJson = JSON.parse(legacyResult.stdout);
  assert.equal(legacyJson.ok, true);
  assert.equal(legacyJson.core.project, 'Legacy');
  assert.equal(legacyJson.managed, true);
  assert.equal(Object.hasOwn(legacyJson, 'format'), false, 'legacy status shape remains unchanged');
});
