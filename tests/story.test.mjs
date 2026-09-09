import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  isValidGitBranchName,
  parseStory,
  readStory,
  replaceStoryExecution,
  storyTaskContract,
} from '../plugins/deliver/skills/deliver/scripts/lib/story.mjs';

const rel = 'docs/stories/S2-3-reader.md';
const exec = {
  owner: 'casey-example-com-589b8fa8ab93',
  builder: 'codex-builder',
  branch: 'pm/S2-3-reader',
  status: 'claimed',
  rounds: 0,
  retries: 0,
  updated: '2026-09-10 09:00',
  extension: { retained: true },
};

function story({ execution = null, headers = true, executionFirst = false } = {}) {
  const executionText = [
    '## Execution',
    '<!-- Never written at decomposition. Shape: pm-exec: {"status":"<claimed|building>"} -->',
    ...(execution ? [`<!-- pm-exec: ${JSON.stringify(execution)} -->`] : []),
    '',
  ].join('\n');
  const contract = [
    '# S2-3: Parse current stories',
    '<!-- pm-meta: {"builder":"codex-builder","touches":["src/parser",".github/workflows"],"extension":{"retained":true}} -->',
    ...(headers ? [
      'Sprint: 2 · Priority: high · Covers: FR-001, AC-009 · Depends on: S1-2 · Parallel-safe: yes',
      'Risk: med · Review lenses: code-integrity-reviewer, security-auditor · Specs: src/parser/parser.sdd',
    ] : []),
    '',
    '## Goal',
    'Parse the current story contract.',
    '',
    '## Acceptance criteria (testable)',
    '- [ ] Preserve exact criterion text.  ',
    '- [x] Keep checkbox order.',
    '',
    '## Verification',
    '- Prove done with: `node --test`',
    '',
  ].join('\n');
  return executionFirst ? `${executionText}${contract}` : `${contract}${executionText}`;
}

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-story-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, relative, text) {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

test('parseStory preserves ordered requirement text and parses current optional headers', () => {
  const document = parseStory(story(), rel);
  assert.equal(document.id, 'S2-3');
  assert.equal(document.title, 'Parse current stories');
  assert.equal(document.sprint, 2);
  assert.equal(document.priority, 'high');
  assert.deepEqual(document.covers, ['FR-001', 'AC-009']);
  assert.deepEqual(document.dependsOn, ['S1-2']);
  assert.equal(document.parallelSafe, true);
  assert.equal(document.risk, 'med');
  assert.deepEqual(document.reviewLenses, ['code-integrity-reviewer', 'security-auditor']);
  assert.deepEqual(document.specs, ['src/parser/parser.sdd']);
  assert.deepEqual(document.meta.extension, { retained: true });
  assert.deepEqual(document.acceptance, [
    { text: 'Preserve exact criterion text.  ', checked: false, line: 10 },
    { text: 'Keep checkbox order.', checked: true, line: 11 },
  ]);
  assert.equal(document.execution, null, 'the template Shape example is not active execution');
  assert.equal(document.executionHash, null);
  assert.match(document.textHash, /^[0-9a-f]{64}$/);
  assert.match(document.contractHash, /^[0-9a-f]{64}$/);
});

test('optional visible headers may be absent while the story ID still supplies the sprint', () => {
  const document = parseStory(story({ headers: false }), rel);
  assert.equal(document.sprint, 2);
  assert.equal(document.priority, null);
  assert.deepEqual(document.covers, []);
  assert.deepEqual(document.dependsOn, []);
  assert.equal(document.parallelSafe, null);
  assert.equal(document.risk, null);
  assert.deepEqual(document.reviewLenses, []);
  assert.deepEqual(document.specs, []);
});

test('current story structure parses with CRLF line endings', () => {
  const document = parseStory(story().replaceAll('\n', '\r\n'), rel);
  assert.deepEqual(document.acceptance.map((criterion) => criterion.text), [
    'Preserve exact criterion text.  ',
    'Keep checkbox order.',
  ]);
  assert.equal(document.execution, null);
});

test('execution replacement keeps substantive bytes and unknown safe fields', () => {
  const before = parseStory(story(), rel);
  const transition = replaceStoryExecution(before, exec, { note: '2026-09-10 claim recorded.' });
  assert.equal(transition.before, before.text);
  assert.equal(transition.after, transition.document.text);
  assert.equal(transition.contractHash, before.contractHash);
  assert.equal(transition.document.execution.status, 'claimed');
  assert.deepEqual(transition.document.execution.extension, { retained: true });
  assert.match(transition.executionHash, /^[0-9a-f]{64}$/);
  assert.match(transition.after, /Shape: pm-exec:/);
  assert.match(transition.after, /2026-09-10 claim recorded/);

  const updated = replaceStoryExecution(transition.document, {
    status: 'building',
    rounds: 1,
    updated: '2026-09-10 09:01',
  });
  assert.equal(updated.document.execution.owner, exec.owner);
  assert.deepEqual(updated.document.execution.extension, { retained: true });
  assert.equal(updated.document.contractHash, before.contractHash);
  assert.notEqual(updated.document.executionHash, transition.executionHash);

  assert.deepEqual(storyTaskContract(updated.document), {
    id: 'S2-3',
    acceptanceText: ['Preserve exact criterion text.  ', 'Keep checkbox order.'],
    touches: ['src/parser', '.github/workflows'],
    builder: 'codex-builder',
    specs: ['src/parser/parser.sdd'],
  });
});

test('Execution branches follow Git branch-name rules', () => {
  for (const branch of ['pm/S2-3-reader', 'feature/ordinary-slash', 'release-2026.09']) {
    assert.equal(isValidGitBranchName(branch), true, branch);
    assert.equal(spawnSync('git', ['check-ref-format', '--branch', branch]).status, 0, branch);
    assert.doesNotThrow(() => parseStory(story({ execution: { ...exec, branch } }), rel));
  }
  for (const branch of ['foo//bar', 'foo.', 'foo.lock', 'foo@{bar', '@', '-foo', '.hidden', 'foo/.hidden', 'foo bar', 'foo[bar', 'foo\\bar']) {
    assert.equal(isValidGitBranchName(branch), false, branch);
    if (branch !== '@') assert.notEqual(spawnSync('git', ['check-ref-format', '--branch', branch]).status, 0, branch);
    assert.throws(() => parseStory(story({ execution: { ...exec, branch } }), rel), /branch/);
  }
});

test('story parsing rejects malformed or ambiguous contracts', () => {
  const cases = [
    [story().replace('<!-- pm-meta:', '<!-- pm-meta: nope\n<!-- pm-meta:'), /pm-meta/],
    [story().replace('"rounds":0', '"rounds":-1').replace('## Execution\n', `## Execution\n<!-- pm-exec: ${JSON.stringify(exec).replace('"rounds":0', '"rounds":-1')} -->\n`), /rounds/],
    [story({ execution: { ...exec, status: 'unknown' } }), /status/],
    [story({ execution: exec }).replace('## Verification', '## Execution\n<!-- pm-exec: {} -->\n\n## Verification'), /duplicate|final/],
    [story().replace('"src/parser"', '"../outside"'), /touch/],
    [story().replace('"src/parser"', '".git/config"'), /bounded/],
    [story().replace('"src/parser"', '".deliver/runs"'), /bounded/],
    [story().replace('"src/parser"', '"src/*"'), /bounded/],
    [story().replace('Sprint: 2', 'Sprint: 3'), /Sprint/],
    [story().replace('FR-001', 'unknown'), /Covers/],
    [story().replace('# S2-3:', '# S2-4:'), /does not match/],
    [`${story()}\n## Later\n`, /final/],
  ];
  for (const [text, expected] of cases) assert.throws(() => parseStory(text, rel), expected);
  assert.throws(() => parseStory(story(), '../docs/stories/S2-3-reader.md'), /unsafe/);
  assert.throws(() => parseStory(`${story()}${'x'.repeat(8 * 1024 * 1024)}`, rel), /oversized/);
});

test('readStory refuses symlinks and non-regular files without reading them', (t) => {
  const root = tempRoot(t);
  const real = write(root, rel, story({ execution: exec }));
  assert.equal(readStory(root, rel).execution.status, 'claimed');

  fs.renameSync(real, `${real}.real`);
  fs.symlinkSync(`${real}.real`, real);
  assert.throws(() => readStory(root, rel), /symlink/);
  fs.unlinkSync(real);
  if (process.platform !== 'win32') {
    execFileSync('mkfifo', [real]);
    assert.throws(() => readStory(root, rel), /regular file/);
  }
});
