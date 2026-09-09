import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { setupProject } from '../bin/deliver.mjs';

const temporaryRoots = [];
after(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
});

test('installed production story template fills into the strict runtime parser contract', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-template-compatibility-'));
  temporaryRoots.push(project);
  await setupProject({ projectDir: project });

  const installedSkill = path.join(project, '.agents/skills/deliver');
  const installedTemplatePath = path.join(installedSkill, 'assets/templates/story.md.template');
  const sourceTemplatePath = new URL('../plugins/deliver/skills/deliver/assets/templates/story.md.template', import.meta.url);
  const template = fs.readFileSync(installedTemplatePath, 'utf8');
  assert.equal(template, fs.readFileSync(sourceTemplatePath, 'utf8'));

  const filled = template
    .replace('# S<sprint>-<n>: <Title>', '# S2-3: Parse production stories')
    .replace(
      '<!-- pm-meta: {"builder":"<expert-builder|codex-builder|auto>","touches":["<bounded repo-relative path>"]} -->',
      '<!-- pm-meta: {"builder":"codex-builder","touches":["src/reader.mjs","tests/reader.test.mjs"]} -->',
    )
    .replace(
      'Sprint: <n> · Priority: <high|med|low> · Covers: <FR-..., AC-...> · Depends on: <IDs|none> · Parallel-safe: <yes|no>',
      'Sprint: 2 · Priority: high · Covers: FR-007, AC-009 · Depends on: S2-1, S2-2 · Parallel-safe: yes',
    )
    .replace(
      'Risk: <low|med|high> · Review lenses: <code-integrity-reviewer[, architecture-reviewer][, security-auditor]> · Specs: <.sdd paths|none>',
      'Risk: high · Review lenses: code-integrity-reviewer, architecture-reviewer, security-auditor · Specs: .specdd/reader.sdd',
    )
    .replace('<One observable outcome.>', 'The runtime parses a story created from the packaged template.')
    .replace(
      '<Facts a cold builder needs. Name exact source paths, symbols, interfaces and conventions.>',
      'Read src/reader.mjs and preserve the exported parseStory contract.',
    )
    .replace('AC-001: <Observable criterion.>', 'AC-009: A filled packaged template parses without normalization.')
    .replace('<Excluded work.>', 'Changing parser validation.')
    .replace('<exact command>', 'node --test tests/reader.test.mjs');

  const parserUrl = pathToFileURL(path.join(installedSkill, 'scripts/lib/story.mjs')).href;
  const { parseStory } = await import(parserUrl);
  const document = parseStory(filled, 'docs/stories/S2-3-parse-production-stories.md');

  assert.equal(document.id, 'S2-3');
  assert.equal(document.title, 'Parse production stories');
  assert.equal(document.sprint, 2);
  assert.equal(document.priority, 'high');
  assert.deepEqual(document.covers, ['FR-007', 'AC-009']);
  assert.deepEqual(document.dependsOn, ['S2-1', 'S2-2']);
  assert.equal(document.parallelSafe, true);
  assert.equal(document.risk, 'high');
  assert.deepEqual(document.reviewLenses, [
    'code-integrity-reviewer',
    'architecture-reviewer',
    'security-auditor',
  ]);
  assert.deepEqual(document.specs, ['.specdd/reader.sdd']);
  assert.deepEqual(document.meta, {
    builder: 'codex-builder',
    touches: ['src/reader.mjs', 'tests/reader.test.mjs'],
  });
  assert.deepEqual(document.acceptance.map(({ text, checked }) => ({ text, checked })), [{
    text: 'AC-009: A filled packaged template parses without normalization.',
    checked: false,
  }]);
  assert.equal(document.execution, null);
  assert.equal(document.executionHash, null);
});
