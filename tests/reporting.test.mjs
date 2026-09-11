import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderVerificationArtifacts } from '../plugins/deliver/skills/deliver/scripts/lib/reporting.mjs';

function values() {
  const snapshot = 'a'.repeat(64);
  const record = {
    evidence: { finalized: true, gates: [{ name: 'test', command: 'node --test', status: 'PASS', identity: 'b'.repeat(64) }] },
    integration: { commit: '1'.repeat(40) },
    source: { story: 'S1-2', story_path: 'docs/stories/S1-2-report.md', candidate: '2'.repeat(40), snapshot_hash: snapshot },
    manifest: { hash: 'c'.repeat(64) },
    plan: { scale: 'large' },
  };
  const story = { reviewLenses: ['architecture-reviewer'] };
  const review = {
    identity: 'd'.repeat(64), panel: { members: [
      { lens: 'code-integrity-reviewer', reviewer: 'reviewer-a', verdict: 'PASS', snapshot_hash: snapshot },
      { lens: 'architecture-reviewer', reviewer: 'reviewer-b', verdict: 'PASS', snapshot_hash: snapshot },
    ] },
  };
  const verification = { identity: 'e'.repeat(64), criteria: [{ id: 'AC-1', status: 'PASS', evidence: 'Observed output matched the fixture.' }] };
  return { record, story, review, verification };
}

test('deterministic report binds C, M and receipt identities without naming P', () => {
  const input = values();
  const first = renderVerificationArtifacts(input.record, input.story, input.review, input.verification);
  const second = renderVerificationArtifacts(input.record, input.story, input.review, input.verification);
  assert.deepEqual(second, first);
  assert.match(first.report, new RegExp(`Candidate C: ${'2'.repeat(40)}`));
  assert.match(first.report, new RegExp(`Integrated M: ${'1'.repeat(40)}`));
  assert.match(first.report, new RegExp(`Review receipt: ${'d'.repeat(64)}`));
  assert.doesNotMatch(first.report, /commit P|own hash/i);
  assert.match(first.checklist, /\[x\] AC-1: PASS\. Evidence: Observed output/);
});

test('large reporting rejects missing lenses and non-PASS criteria', () => {
  const input = values();
  input.review.panel.members = input.review.panel.members.filter((item) => item.lens !== 'architecture-reviewer');
  assert.throws(() => renderVerificationArtifacts(input.record, input.story, input.review, input.verification), /missing required lenses/);
  input.review = values().review;
  input.verification.criteria[0].status = 'UNKNOWN';
  assert.throws(() => renderVerificationArtifacts(input.record, input.story, input.review, input.verification), /unsupported PASS/);
});

test('reporting retains minor concerns and neutralizes multiline evidence markup', () => {
  const input = values();
  input.review.findings = [{
    severity: 'minor', message: 'Keep the small concern.', resolved: false,
    lens: 'code-integrity-reviewer', reviewer: 'reviewer-a',
  }];
  input.review.panel.members[0].verdict = 'CONCERNS';
  input.verification.criteria[0].evidence = 'Observed output.\n## Injected heading\n- [ ] Fake unchecked claim';
  const rendered = renderVerificationArtifacts(input.record, input.story, input.review, input.verification);
  assert.match(rendered.report, /Keep the small concern/);
  assert.doesNotMatch(rendered.report, /\n## Injected heading/);
  assert.doesNotMatch(rendered.report, /\n- \[ \] Fake unchecked claim/);
  assert.match(rendered.report, /Observed output\. +## Injected heading/);
  assert.doesNotMatch(rendered.checklist, /\n## Injected heading|\n- \[ \] Fake unchecked claim/);
});
