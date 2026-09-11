import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseReviewReceipt, requiredReviewLenses } from '../plugins/deliver/skills/deliver/scripts/lib/review.mjs';

const snapshot = 'a'.repeat(64);

test('panel parser retains member identities, concerns and derived findings', () => {
  const receipt = parseReviewReceipt({
    status: 'PASS',
    findings: [],
    panel: {
      snapshot_hash: snapshot,
      members: [
        { lens: 'code-integrity-reviewer', reviewer: 'reviewer-a', verdict: 'PASS', snapshot_hash: snapshot, findings: [] },
        { lens: 'architecture-reviewer', reviewer: 'reviewer-b', verdict: 'CONCERNS', snapshot_hash: snapshot,
          findings: [{ severity: 'minor', message: 'Keep the compatibility note.', resolved: false }] },
      ],
    },
  }, { expectedSnapshot: snapshot });
  assert.equal(receipt.status, 'PASS');
  assert.equal(receipt.findings.length, 1);
  assert.equal(receipt.findings[0].lens, 'architecture-reviewer');
  assert.equal(receipt.panel.members[1].verdict, 'CONCERNS');
  assert.throws(() => parseReviewReceipt({ ...receipt, status: 'FAIL' }, { expectedSnapshot: snapshot }), /derived/);
});

test('panel rejects stale member snapshots and reports regulated lens requirements', () => {
  const value = {
    status: 'PASS', findings: [], panel: { snapshot_hash: snapshot, members: [
      { lens: 'code-integrity-reviewer', reviewer: 'reviewer-a', verdict: 'PASS', snapshot_hash: 'b'.repeat(64), findings: [] },
    ] },
  };
  assert.throws(() => parseReviewReceipt(value, { expectedSnapshot: snapshot }), /member/);
  assert.deepEqual(requiredReviewLenses({ reviewLenses: ['architecture-reviewer'] }, 'regulated'),
    ['architecture-reviewer', 'code-integrity-reviewer', 'security-auditor']);
});

test('panel aggregate is an exact order-independent attributed multiset', () => {
  const shared = { severity: 'minor', message: 'Retain the shared concern.', resolved: false };
  const input = {
    status: 'PASS',
    findings: [
      { ...shared, lens: 'architecture-reviewer', reviewer: 'reviewer-b' },
      { ...shared, lens: 'code-integrity-reviewer', reviewer: 'reviewer-a' },
    ],
    panel: { snapshot_hash: snapshot, members: [
      { lens: 'code-integrity-reviewer', reviewer: 'reviewer-a', verdict: 'CONCERNS', snapshot_hash: snapshot, findings: [shared] },
      { lens: 'architecture-reviewer', reviewer: 'reviewer-b', verdict: 'CONCERNS', snapshot_hash: snapshot, findings: [shared] },
    ] },
  };
  const parsed = parseReviewReceipt(input, { expectedSnapshot: snapshot });
  assert.deepEqual(parseReviewReceipt(parsed, { expectedSnapshot: snapshot }), parsed);
  assert.equal(parsed.findings.length, 2, 'duplicate member findings retain multiplicity');
  const mixedAttribution = structuredClone(input);
  mixedAttribution.findings.reverse();
  delete mixedAttribution.findings[0].lens;
  delete mixedAttribution.findings[0].reviewer;
  assert.equal(parseReviewReceipt(mixedAttribution, { expectedSnapshot: snapshot }).findings.length, 2,
    'an unattributed duplicate cannot consume the only match for an attributed duplicate');

  const hidden = structuredClone(input);
  hidden.findings.push({ severity: 'major', message: 'Hidden blocking defect.', resolved: false });
  assert.throws(() => parseReviewReceipt(hidden, { expectedSnapshot: snapshot }), /complete member-derived aggregate/);

  for (const change of [
    (value) => { value.findings.pop(); },
    (value) => { value.findings[0].severity = 'major'; },
    (value) => { value.findings[0].resolved = true; },
    (value) => { value.findings[0].reviewer = 'reviewer-a'; },
    (value) => { value.findings.push({ ...shared }); },
  ]) {
    const invalid = structuredClone(input);
    change(invalid);
    assert.throws(() => parseReviewReceipt(invalid, { expectedSnapshot: snapshot }), /aggregate|differ/);
  }
});

test('legacy receipts without a panel keep their supplied findings', () => {
  const receipt = parseReviewReceipt({ status: 'PASS', findings: [
    { severity: 'minor', message: 'Standalone concern.', resolved: false },
  ] });
  assert.deepEqual(receipt.findings, [{ severity: 'minor', message: 'Standalone concern.', resolved: false }]);
});
