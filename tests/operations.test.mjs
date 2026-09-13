import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { setupProject } from '../bin/deliver.mjs';

const temporaryRoots = [];
after(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
});

async function installedSkill() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-operations-'));
  temporaryRoots.push(root);
  await setupProject({ projectDir: root });
  return path.join(root, '.agents/skills/deliver');
}

const read = (root, relative) => fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8');

test('installed operation map resolves every native operation and its one reference', async () => {
  const skill = await installedSkill();
  const map = JSON.parse(read(skill, 'assets/operations.json'));
  assert.deepEqual(map.invocation, {
    skill: '$deliver <operation> [arguments]',
    ordinary_language: true,
    registered_slash_commands: false,
    runtime_commands_are_operations: false,
  });

  const expected = [
    'advise', 'analyze', 'approve', 'benchmark-builders', 'checklist', 'claim', 'clarify', 'complete',
    'constitution', 'contracts', 'correct-course', 'decompose', 'deliver', 'discover', 'doctor',
    'handoff', 'migrate', 'parallel', 'plan', 'research', 'resume', 'retrospective', 'review',
    'specify', 'status', 'verify', 'wiki',
  ];
  assert.deepEqual(map.operations.map((operation) => operation.name).sort(), expected);

  const tokens = new Set();
  for (const operation of map.operations) {
    assert.equal(typeof operation.reference, 'string');
    assert(fs.existsSync(path.join(skill, operation.reference)), `${operation.name} reference missing`);
    assert(Array.isArray(operation.arguments), `${operation.name} arguments missing`);
    assert.equal(typeof operation.output?.description, 'string', `${operation.name} output missing`);
    assert(Array.isArray(operation.output.paths), `${operation.name} output paths missing`);
    assert.match(operation.mutation?.mode, /^(?:read-only|external-read|project-write|delivery-write)$/);
    assert(Array.isArray(operation.mutation.paths), `${operation.name} write paths missing`);
    assert(Array.isArray(operation.mutation.external), `${operation.name} external authority missing`);
    for (const token of [operation.name, ...operation.aliases]) {
      assert(!tokens.has(token), `ambiguous operation token ${token}`);
      tokens.add(token);
    }
  }

  const byName = Object.fromEntries(map.operations.map((operation) => [operation.name, operation]));
  assert.equal(byName.discover.reference, 'references/discovery.md');
  assert.equal(byName.specify.reference, 'references/specification.md');
  assert.equal(byName.clarify.reference, 'references/specification.md');
  assert.equal(byName.plan.reference, 'references/planning.md');
  assert.equal(byName.approve.reference, 'references/planning.md');
  assert.equal(byName.decompose.reference, 'references/decomposition.md');
  assert.deepEqual(byName.analyze.mutation, { mode: 'read-only', paths: [], external: [] });
  assert.deepEqual(byName.status.mutation, { mode: 'read-only', paths: [], external: [] });
  assert(byName.complete.mutation.external.includes('verified-merge'));
  assert.equal(byName.complete.reference, 'references/shipping.md');
  assert.deepEqual(byName.complete.output.paths, [
    'docs/stories/<story-id>-<slug>.md',
    'docs/verification/<story-id>.md',
    'docs/checklists/verification-<story-id>.md',
    'docs/handoff/<actor-id>.md',
  ]);

  const operationContract = read(skill, 'references/operations.md');
  assert.match(operationContract, /Read only its `reference`/);
  assert.match(operationContract, /not registered slash commands/);
  assert.match(operationContract, /Low-level `scripts\/deliver\.mjs` and `scripts\/pm\.mjs` commands/);
});

test('installed planning templates preserve identifiers, scale choices and unclaimed stories', async () => {
  const skill = await installedSkill();
  const templateNames = [
    'AGENTS.md.template',
    'approval.json.template',
    'completion-report.md.template',
    'constitution.md.template',
    'plan.md.template',
    'spec.md.template',
    'story.md.template',
    'verification-report.md.template',
  ];
  for (const name of templateNames) {
    const content = read(skill, `assets/templates/${name}`);
    assert(!content.includes('${CLAUDE_PLUGIN_ROOT}'), `${name} has a Claude-root assumption`);
    assert(!content.includes('/deliver:'), `${name} advertises slash registration`);
  }

  const spec = read(skill, 'assets/templates/spec.md.template');
  for (const identifier of ['US-001', 'FR-001', 'AC-001', 'SM-001']) assert.match(spec, new RegExp(identifier));
  assert.match(spec, /\[NEEDS CLARIFICATION: <question>\]/);

  const plan = read(skill, 'assets/templates/plan.md.template');
  assert.match(plan, /Scale: <tiny \| small \| standard \| large \| regulated>/);
  assert.match(plan, /Execution mode: <Quick \| Managed \| Governed>/);
  assert.match(plan, /Checkpoint policy: <story-level \| sprint-level \| autonomous>/);
  assert.match(plan, /FR-001, AC-001/);

  const story = read(skill, 'assets/templates/story.md.template');
  assert.match(story, /pm-meta: \{"builder"/);
  assert.match(story, /- \[ \] AC-001: <Observable criterion\.>/);
  assert.doesNotMatch(story, /^## Execution$/m);
  assert.doesNotMatch(story, /pm-exec:/);
  assert.match(story, /claim operation adds the Execution section/);

  const approval = JSON.parse(read(skill, 'assets/templates/approval.json.template'));
  assert.deepEqual(approval, {
    status: 'pending',
    approver: null,
    approved_date: null,
    plan_digest: null,
    updated: '<YYYY-MM-DD HH:MM>',
  });

  for (const reference of ['discovery.md', 'specification.md', 'planning.md', 'decomposition.md']) {
    const content = read(skill, `references/${reference}`);
    assert.match(content, /\*\*Enter:/, `${reference} has no Enter rule`);
    assert.match(content, /\*\*Leave:/, `${reference} has no Leave rule`);
  }
  const specification = read(skill, 'references/specification.md');
  assert.match(specification, /one\s+question at a time, up to five/);
  assert.match(specification, /immediately update the authoritative spec/);

  const scales = read(skill, 'references/scale-profiles.md');
  assert.match(scales, /`tiny` \| Minimal plan, one ready story/);
  assert.match(scales, /`standard` \| Spec, plan, post-plan and post-decomposition analysis/);
  assert.match(scales, /`large` \| Everything in `standard`, plus a constitution, quality checklists, SpecDD contracts/);
  assert.match(scales, /`regulated` \| Everything in `large`, plus mandatory security review/);
  assert.match(scales, /Execution mode controls orchestration/);
  assert.match(scales, /standing authority[\s\S]*scoped commits, branch pushes, pull request creation or updates, and verified merges/);

  const entry = read(skill, 'SKILL.md');
  assert(entry.split(/\s+/).length < 800);
  for (const route of ['operations', 'discovery', 'specification', 'planning', 'scale-profiles', 'decomposition']) {
    assert.match(entry, new RegExp(`references/${route}\\.md`));
  }
  assert.match(entry, /references\/shipping\.md/);
  const shipping = read(skill, 'references/shipping.md');
  assert.match(shipping, /integrate-prepare[\s\S]*git merge --no-ff --no-edit[\s\S]*integrate-adopt/);
  assert.match(shipping, /report-prepare[\s\S]*close-prepare[\s\S]*handoff-prepare/);
  assert.match(shipping, /standing authority/);
});
