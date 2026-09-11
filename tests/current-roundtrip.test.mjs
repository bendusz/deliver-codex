import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseExec as upstreamExecution } from './fixtures/upstream-v0.25.1/hooks/lib.mjs';
import { parseStory, replaceStoryExecution } from '../plugins/deliver/skills/deliver/scripts/lib/story.mjs';

const rel = 'docs/stories/S2-3-roundtrip.md';
const contract = [
  '# S2-3: Round trip',
  '<!-- pm-meta: {"builder":"codex-builder","touches":["src"]} -->',
  'Sprint: 2 · Priority: high · Covers: AC-023 · Depends on: none · Parallel-safe: yes',
  'Risk: low · Review lenses: code-integrity-reviewer · Specs: none',
  '',
  '## Acceptance criteria (testable)',
  '- [ ] The same criterion survives both hosts.',
  '',
].join('\n');

test('upstream Execution is accepted and Codex closure remains readable upstream', () => {
  const upstream = `${contract}## Execution\n<!-- pm-exec: {"owner":"casey-abcdef123456","builder":"codex-builder","branch":"pm/S2-3-roundtrip","status":"in-review","rounds":2,"retries":1,"updated":"2026-09-10 12:00","host_note":"keep"} -->\n`;
  const document = parseStory(upstream, rel);
  assert.equal(document.acceptance[0].text, 'The same criterion survives both hosts.');
  const closed = replaceStoryExecution(document, { status: 'merged', updated: '2026-09-10 13:00' }, { note: '2026-09-10 13:00 integrated' });
  const readBack = upstreamExecution(closed.after);
  assert.equal(readBack.status, 'merged');
  assert.equal(readBack.rounds, 2);
  assert.equal(readBack.retries, 1);
  assert.equal(readBack.host_note, 'keep');
  assert.equal(closed.contractHash, document.contractHash);
});

test('Codex Execution accepts an upstream boundary update without losing identity', () => {
  const claimed = replaceStoryExecution(parseStory(contract, rel), {
    owner: 'casey-abcdef123456', builder: 'codex-builder', branch: 'pm/S2-3-roundtrip',
    status: 'claimed', rounds: 0, retries: 0, updated: '2026-09-10 12:00',
  });
  const fromUpstream = claimed.after.replace('"status":"claimed"', '"status":"building"');
  const document = parseStory(fromUpstream, rel);
  assert.equal(document.execution.owner, 'casey-abcdef123456');
  assert.equal(document.execution.branch, 'pm/S2-3-roundtrip');
  assert.equal(document.execution.status, 'building');
  assert.equal(document.contractHash, claimed.contractHash);
});
