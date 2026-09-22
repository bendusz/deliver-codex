import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { setupProject } from '../bin/deliver.mjs';
import {
  analyzeProjectArtifacts,
  claimReadinessFromAnalysis,
} from '../plugins/deliver/skills/deliver/scripts/lib/analyze.mjs';

const CLI = new URL('../plugins/deliver/skills/deliver/scripts/analyze.mjs', import.meta.url);
const LIBRARY = new URL('../plugins/deliver/skills/deliver/scripts/lib/analyze.mjs', import.meta.url);
const temporaryRoots = [];

after(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
});

function temporaryProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-analysis-'));
  temporaryRoots.push(root);
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  return root;
}

function write(root, rel, text) {
  const target = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

function spec({ clarification = false, extra = '' } = {}) {
  return `# Example feature specification

## Functional requirements

- FR-001: The system stores one value.
${extra}
## Acceptance criteria

- AC-001: WHEN a value is submitted, THE SYSTEM SHALL return it.

## Clarifications

${clarification ? '[NEEDS CLARIFICATION: Which format?]' : ''}
`;
}

function plan({ scale = 'standard', skeleton = 'none', storyRows = [], commands = null, references = 'FR-001, AC-001' } = {}) {
  const rows = storyRows.length
    ? storyRows.map((id) => `| ${id} | Story ${id} | high | ${references} | none | no |`).join('\n')
    : '';
  return `# Example delivery plan

## Source spec

- docs/spec.md

## Delivery policy

- Scale: ${scale}
- Execution mode: Managed
- Checkpoint policy: autonomous
- Integration branch: main
- Skeleton: ${skeleton}

## Scope

### In

- Store and return one value.

### Out

- Remote deployment.

## Stories

| ID | Title | Priority | Covers | Depends on | Parallel safe |
| --- | --- | --- | --- | --- | --- |
${rows}

## Traceability

| Requirement | Covered by | Notes |
| --- | --- | --- |
| ${references.split(', ')[0] ?? 'none'} | ${storyRows[0] ?? 'planned'} | |
| ${references.split(', ')[1] ?? 'none'} | ${storyRows[0] ?? 'planned'} | |

## Commands

${commands ?? '- Test: `node --test`\n- Lint: `N/A`\n- Build: `N/A`\n- Run: `N/A`'}

## Risks

- Local file errors return a failure.

## Clarifications


## Sign-off

Approved by __________ on ____-__-__
`;
}

function story({
  id = 'S1-1',
  title = 'Store a value',
  covers = 'FR-001, AC-001',
  dependsOn = 'none',
  parallelSafe = 'no',
  touches = ['src/value.mjs'],
  risk = 'low',
  lenses = 'code-integrity-reviewer',
  verification = 'node --test tests/value.test.mjs',
  specs = 'none',
  execution = '',
} = {}) {
  const sprint = id.match(/^S(\d+)-/)[1];
  return `# ${id}: ${title}

<!-- pm-meta: ${JSON.stringify({ builder: 'codex-builder', touches })} -->

Sprint: ${sprint} · Priority: high · Covers: ${covers} · Depends on: ${dependsOn} · Parallel-safe: ${parallelSafe}
Risk: ${risk} · Review lenses: ${lenses} · Specs: ${specs}

## Goal

Store one value locally.

## Context

Use src/value.mjs without changing its public behavior.

## Acceptance criteria

- [ ] AC-001: The submitted value is returned.

## Out of scope

- Deployment.

## Verification

- Prove done with: \`${verification}\`

## Verification evidence

${execution}`;
}

function approve(root) {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Analysis Test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'analysis@example.test'], { cwd: root });
  const digest = execFileSync('git', ['hash-object', '--', 'docs/plan.md'], { cwd: root, encoding: 'utf8' }).trim();
  write(root, 'docs/approval.json', `${JSON.stringify({
    status: 'approved',
    approver: 'test-user',
    approved_date: '2026-09-10',
    plan_digest: digest,
    updated: '2026-09-10 12:00',
  }, null, 2)}\n`);
  execFileSync('git', ['add', 'docs'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
}

function contentSnapshot(root) {
  const output = {};
  function walk(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target, rel);
      else if (entry.isSymbolicLink()) output[rel] = `link:${fs.readlinkSync(target)}`;
      else output[rel] = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    }
  }
  walk(root);
  return output;
}

test('post-plan analysis is stage-aware and keeps pending approval non-blocking', () => {
  const root = temporaryProject();
  write(root, 'docs/spec.md', spec());
  write(root, 'docs/plan.md', plan());
  write(root, 'docs/approval.json', '{"status":"pending","approver":null,"approved_date":null,"plan_digest":null,"updated":"2026-09-10"}\n');
  const before = contentSnapshot(root);

  const analysis = analyzeProjectArtifacts(root, { stage: 'post-plan', scope: { kind: 'project' } });

  assert.equal(analysis.status, 'REVIEW_REQUIRED');
  assert.equal(analysis.factual_status, 'CLEAR');
  assert.equal(analysis.semantic_review.status, 'REVIEW_REQUIRED');
  assert(!analysis.findings.some((item) => item.code.startsWith('APPROVAL_')));
  assert(!analysis.findings.some((item) => item.code === 'STORIES_MISSING'));
  assert(analysis.artifacts.some((item) => item.path === 'docs/stories/' && item.state === 'missing'));
  assert.deepEqual(contentSnapshot(root), before);
});

test('pre-claim analysis binds content and leaves standard semantic review explicit', () => {
  const root = temporaryProject();
  write(root, 'docs/spec.md', spec());
  write(root, 'docs/plan.md', plan({ storyRows: ['S1-1'] }));
  write(root, 'docs/stories/S1-1-store.md', story());
  approve(root);
  const before = contentSnapshot(root);

  const analysis = analyzeProjectArtifacts(root, {
    stage: 'pre-claim',
    scope: { kind: 'story', storyId: 'S1-1' },
  });
  const readiness = claimReadinessFromAnalysis(analysis, { storyId: 'S1-1' });

  assert.equal(analysis.factual_status, 'CLEAR');
  assert.equal(analysis.status, 'REVIEW_REQUIRED');
  assert.equal(readiness.status, 'REVIEW_REQUIRED');
  assert.equal(readiness.ready, false);
  assert.match(analysis.content_identity, /^[0-9a-f]{64}$/);
  assert.deepEqual(contentSnapshot(root), before, 'analysis changed project or Git bytes');

  write(root, 'docs/constitution.md', '# Rules\n');
  const changed = analyzeProjectArtifacts(root, {
    stage: 'pre-claim',
    scope: { kind: 'story', storyId: 'S1-1' },
  });
  assert.notEqual(changed.content_identity, analysis.content_identity);
});

test('tiny scale can become structurally ready without a semantic analysis gate', () => {
  const root = temporaryProject();
  write(root, 'docs/plan.md', plan({ scale: 'tiny', storyRows: ['S1-1'], references: 'none' })
    .replace('- docs/spec.md', '- none, intent captured inline'));
  write(root, 'docs/stories/S1-1-store.md', story({ covers: 'none' }));
  approve(root);

  const analysis = analyzeProjectArtifacts(root, {
    stage: 'pre-claim',
    scope: { kind: 'story', storyId: 'S1-1' },
  });
  const readiness = claimReadinessFromAnalysis(analysis, { storyId: 'S1-1' });

  assert.equal(analysis.semantic_review.status, 'NOT_REQUIRED');
  assert.equal(analysis.factual_status, 'CLEAR');
  assert.deepEqual(readiness, {
    ready: true,
    story_id: 'S1-1',
    analysis_identity: analysis.analysis_identity,
    content_identity: analysis.content_identity,
    blocker_ids: [],
    status: 'READY',
  });
});

test('large pre-claim analysis blocks missing phase prerequisites without demanding completion evidence', () => {
  const root = temporaryProject();
  write(root, 'docs/spec.md', spec());
  write(root, 'docs/plan.md', plan({ scale: 'large', storyRows: ['S1-1'] }));
  write(root, 'docs/stories/S1-1-store.md', story());
  approve(root);

  const analysis = analyzeProjectArtifacts(root, {
    stage: 'pre-claim',
    scope: { kind: 'story', storyId: 'S1-1' },
  });
  const codes = new Set(analysis.findings.map((item) => item.code));

  for (const code of [
    'CONSTITUTION_REQUIRED',
    'QUALITY_CHECKLIST_REQUIRED',
    'SPECDD_SKELETON_REQUIRED',
    'SPECDD_BOOTSTRAP_REQUIRED',
    'STORY_CONTRACTS_REQUIRED',
  ]) assert(codes.has(code), `missing large-scale prerequisite ${code}`);
  assert.equal(analysis.factual_status, 'BLOCKED');
  assert.equal(claimReadinessFromAnalysis(analysis, { storyId: 'S1-1' }).status, 'BLOCKED');
  assert(analysis.semantic_review.items.some((item) => item.id === 'SEM-QUALITY-CHECKLISTS'
    && item.status === 'UNASSESSED'));
  for (const rel of [
    'docs/constitution.md',
    'docs/checklists/spec-quality.md',
    'docs/checklists/plan-quality.md',
    'docs/checklists/story-readiness-S1-1.md',
    '.specdd/bootstrap.md',
  ]) assert(analysis.artifacts.some((item) => item.path === rel && item.state === 'missing'), `missing identity ${rel}`);
  assert(!analysis.artifacts.some((item) => item.path.includes('verification')),
    'pre-claim analysis demanded later verification evidence');
});

test('declared contracts are exact identity inputs below large scale', () => {
  const root = temporaryProject();
  write(root, 'docs/spec.md', spec());
  write(root, 'docs/plan.md', plan({ scale: 'small', storyRows: ['S1-1'] }));
  write(root, 'docs/stories/S1-1-store.md', story({ specs: 'contracts/value.sdd' }));
  write(root, 'contracts/value.sdd', 'Spec: Value\nOwns: src/value.mjs\n');
  approve(root);

  const first = analyzeProjectArtifacts(root, {
    stage: 'pre-claim',
    scope: { kind: 'story', storyId: 'S1-1' },
  });
  assert.equal(first.factual_status, 'CLEAR');
  assert.equal(first.status, 'FACTS_CLEAR');
  const contractIdentity = first.artifacts.find((item) => item.path === 'contracts/value.sdd');
  assert.equal(contractIdentity.state, 'file');
  assert.match(contractIdentity.digest, /^[0-9a-f]{64}$/);

  write(root, 'contracts/value.sdd', 'Spec: Value\nOwns: src/value.mjs\nMust: return submitted values\n');
  const changed = analyzeProjectArtifacts(root, {
    stage: 'pre-claim',
    scope: { kind: 'story', storyId: 'S1-1' },
  });
  assert.notEqual(changed.content_identity, first.content_identity);
  assert.notEqual(changed.analysis_identity, first.analysis_identity);

  fs.rmSync(path.join(root, 'contracts/value.sdd'));
  const missing = analyzeProjectArtifacts(root, {
    stage: 'pre-claim',
    scope: { kind: 'story', storyId: 'S1-1' },
  });
  assert(missing.findings.some((item) => item.code === 'DECLARED_CONTRACT_MISSING'));
  assert(missing.artifacts.some((item) => item.path === 'contracts/value.sdd' && item.state === 'missing'));

  fs.mkdirSync(path.join(root, 'contracts/value.sdd'));
  const invalid = analyzeProjectArtifacts(root, {
    stage: 'pre-claim',
    scope: { kind: 'story', storyId: 'S1-1' },
  });
  assert.equal(invalid.status, 'UNKNOWN');
  assert(invalid.findings.some((item) => item.code === 'ARTIFACT_UNREADABLE'
    && item.location.path === 'contracts/value.sdd'));
  assert(invalid.artifacts.some((item) => item.path === 'contracts/value.sdd' && item.state === 'invalid'));
});

test('located findings cover clarifications, requirements, dependencies, scope, commands and lenses', () => {
  const root = temporaryProject();
  write(root, 'docs/spec.md', spec({
    clarification: true,
    extra: '- FR-002: The system audits changes.\n',
  }));
  write(root, 'docs/plan.md', plan({
    storyRows: ['S1-1', 'S1-2'],
    references: 'FR-001, AC-001, FR-999',
    commands: '- Test: `<command>`\n- Build: `N/A`\n- Run: `N/A`',
  }));
  write(root, 'docs/stories/S1-1-auth.md', story({
    id: 'S1-1',
    title: 'Authentication for a user',
    covers: 'AC-001, FR-999',
    dependsOn: 'S1-2',
    parallelSafe: 'yes',
    touches: ['src/shared'],
    lenses: 'architecture-reviewer',
    verification: '@gate:lint',
  }));
  write(root, 'docs/stories/S1-2-store.md', story({
    id: 'S1-2',
    dependsOn: 'S1-1',
    parallelSafe: 'yes',
    touches: ['src/shared/value.mjs'],
  }));

  const analysis = analyzeProjectArtifacts(root, { stage: 'post-decomposition' });
  const codes = new Set(analysis.findings.map((item) => item.code));
  for (const code of [
    'CLARIFICATION_UNRESOLVED',
    'PLAN_REQUIREMENT_UNKNOWN',
    'REQUIREMENT_NOT_PLANNED',
    'REQUIREMENT_UNCOVERED',
    'STORY_REQUIREMENT_UNKNOWN',
    'DEPENDENCY_CYCLE',
    'PARALLEL_SCOPE_OVERLAP',
    'PLAN_COMMAND_MALFORMED',
    'PLAN_COMMAND_MISSING',
    'STORY_GATE_UNDEFINED',
    'REVIEW_LENS_MISSING',
  ]) assert(codes.has(code), `missing finding ${code}`);
  assert.equal(analysis.status, 'BLOCKED');
  const riskReview = analysis.semantic_review.items.find((item) => item.id === 'SEM-RISK-LENSES');
  assert(riskReview.candidates.some((candidate) => candidate.story_id === 'S1-1'
    && candidate.status === 'JUDGMENT_REQUIRED'));
  for (const item of analysis.findings) {
    assert.match(item.location.path, /^(?:docs\/|\.git)/);
    assert(Number.isSafeInteger(item.location.line) && item.location.line >= 1);
    assert(item.remediation.length > 0);
  }
});

test('nonregular story input becomes UNKNOWN without hanging or changing files', () => {
  const root = temporaryProject();
  write(root, 'docs/spec.md', spec());
  write(root, 'docs/plan.md', plan({ storyRows: ['S1-1'] }));
  fs.mkdirSync(path.join(root, 'docs/stories/S1-1-not-a-file.md'), { recursive: true });
  const before = contentSnapshot(root);

  const started = Date.now();
  const analysis = analyzeProjectArtifacts(root, { stage: 'post-decomposition' });
  assert(Date.now() - started < 2000);
  assert.equal(analysis.status, 'UNKNOWN');
  assert(analysis.findings.some((item) => item.code === 'ARTIFACT_UNREADABLE' && item.status === 'UNKNOWN'));
  assert.deepEqual(contentSnapshot(root), before);
});

test('invalid UTF-8 is identity-bound UNKNOWN input', () => {
  const root = temporaryProject();
  write(root, 'docs/plan.md', plan());
  fs.writeFileSync(path.join(root, 'docs/spec.md'), Buffer.from([0xc3, 0x28]));

  const analysis = analyzeProjectArtifacts(root, { stage: 'post-plan' });
  const identity = analysis.artifacts.find((item) => item.path === 'docs/spec.md');
  assert.equal(analysis.status, 'UNKNOWN');
  assert.equal(identity.state, 'invalid');
  assert.match(identity.digest, /^[0-9a-f]{64}$/);
  assert(analysis.findings.some((item) => item.code === 'ARTIFACT_UNREADABLE'));
});

test('CLI and imports are bounded, read-only and side-effect-free', () => {
  const root = temporaryProject();
  write(root, 'docs/spec.md', spec());
  write(root, 'docs/plan.md', plan());
  write(root, 'marker.txt', 'unchanged');
  const before = contentSnapshot(root);
  const imported = spawnSync(process.execPath, ['--input-type=module', '--eval', [
    'globalThis.fetch = () => { throw new Error("provider call"); };',
    `await import(${JSON.stringify(LIBRARY.href)});`,
    `await import(${JSON.stringify(CLI.href)});`,
  ].join('\n')], { cwd: root, encoding: 'utf8', timeout: 2000 });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
  assert.equal(imported.stderr, '');

  const executed = spawnSync(process.execPath, [fileURLToPath(CLI),
    '--root', root, '--stage', 'post-plan', '--format', 'json'], {
    cwd: root, encoding: 'utf8', timeout: 3000,
  });
  assert.equal(executed.status, 0, executed.stderr);
  const report = JSON.parse(executed.stdout);
  assert.equal(report.status, 'REVIEW_REQUIRED');
  assert.deepEqual(contentSnapshot(root), before);
});

test('quality checklists are installed as unchecked evidence contracts', async () => {
  const root = temporaryProject();
  await setupProject({ projectDir: root });
  const templates = [
    'checklist-spec-quality.md.template',
    'checklist-plan-quality.md.template',
    'checklist-story-readiness.md.template',
    'checklist-verification-quality.md.template',
  ];
  for (const name of templates) {
    const content = fs.readFileSync(path.join(root, '.agents/skills/deliver/assets/templates', name), 'utf8');
    assert.match(content, /- \[ \]/);
    assert.doesNotMatch(content, /- \[[xX]\]/);
    assert.match(content, /Evidence:/);
  }
  const governance = fs.readFileSync(path.join(root, '.agents/skills/deliver/references/governance.md'), 'utf8');
  assert.match(governance, /Never\s+edit, scaffold, check off or fix an artifact during analysis/);
  assert.match(governance, /`tiny` and `small` do not acquire a new\s+analysis gate/);
  assert.match(governance, /clean regex scan[\s\S]*cannot declare/);
});
