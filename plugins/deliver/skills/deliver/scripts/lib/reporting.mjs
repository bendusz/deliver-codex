import { canonical, DeliverError, readJsonFile, sha256 } from './state.mjs';
import { assertPanelCoverage } from './review.mjs';

const fail = (message) => { throw new DeliverError(message, 66); };

export function parseVerificationResults(input, acceptance) {
  const document = typeof input === 'string' ? readJsonFile(input, 'verification results') : input;
  if (!document || typeof document !== 'object' || Array.isArray(document) || !Array.isArray(document.criteria)) {
    fail('verification results must contain a criteria array');
  }
  const criteria = document.criteria.map((criterion, index) => {
    if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion) || typeof criterion.id !== 'string'
      || !['PASS', 'FAIL', 'UNKNOWN'].includes(criterion.status) || typeof criterion.evidence !== 'string'
      || !criterion.evidence.trim() || criterion.evidence.length > 8000) fail(`invalid verification criterion at index ${index}`);
    return { id: criterion.id, status: criterion.status, evidence: criterion.evidence };
  });
  const expected = acceptance.map((item) => item.id).sort();
  const actual = criteria.map((item) => item.id).sort();
  if (new Set(actual).size !== actual.length || canonical(actual) !== canonical(expected)) {
    fail('verification criteria must cover each acceptance id exactly once');
  }
  return criteria;
}

function cleanCell(value) {
  return String(value).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/`/g, '&#96;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;');
}

function findingRows(label, evidence) {
  const findings = evidence?.findings || [];
  if (!findings.length) return [`| ${label} | none | none | none | none |`];
  return findings.map((item) => `| ${label} | ${cleanCell(item.lens || 'general')} | ${cleanCell(item.reviewer || evidence.reviewer || 'unknown')} | ${item.severity} / ${item.resolved ? 'resolved' : 'open'} | ${cleanCell(item.message)} |`);
}

export function renderVerificationArtifacts(record, story, review, verification) {
  if (!record?.evidence?.finalized || !record.integration?.commit) fail('integration evidence must be finalized before reporting');
  if (verification.criteria.some((item) => item.status !== 'PASS')) fail('verification report cannot claim unsupported PASS criteria');
  const requiredLenses = assertPanelCoverage(review, story, record.plan.scale);
  const source = record.source;
  const sourceReview = source.review || review;
  const lines = [
    `# Verification: ${source.story}`,
    '',
    `- Story: ${source.story_path}`,
    `- Candidate C: ${source.candidate}`,
    `- Source snapshot: ${source.snapshot_hash}`,
    `- Integrated M: ${record.integration.commit}`,
    `- Manifest: ${record.manifest.hash}`,
    `- Gate receipts: ${record.evidence.gates.map((item) => item.identity).join(', ') || 'none declared'}`,
    `- Review receipt: ${review.identity}`,
    `- Verification receipt: ${verification.identity}`,
    '',
    '## Gates',
    '',
    '| Gate | Command | Result |',
    '| --- | --- | --- |',
    ...record.evidence.gates.map((gate) => `| ${cleanCell(gate.name)} | ${cleanCell(gate.command)} | ${gate.status} |`),
    ...(record.evidence.gates.length ? [] : ['| none declared | N/A | PASS |']),
    '',
    '## Review panel',
    '',
    '| Lens | Reviewer | Verdict |',
    '| --- | --- | --- |',
    ...review.panel.members.map((member) => `| ${member.lens} | ${cleanCell(member.reviewer)} | ${member.verdict} |`),
    '',
    '## Retained findings',
    '',
    '| Evidence | Lens | Reviewer | Status | Finding |',
    '| --- | --- | --- | --- | --- |',
    ...findingRows('Source C', sourceReview),
    ...(review.identity === sourceReview.identity ? [] : findingRows('Effective M', review)),
    '',
    '## Acceptance verification',
    '',
    '| Criterion | Result | Evidence |',
    '| --- | --- | --- |',
    ...verification.criteria.map((item) => `| ${cleanCell(item.id)} | ${item.status} | ${cleanCell(item.evidence)} |`),
    '',
    '## Integration status',
    '',
    `Integrated at M ${record.integration.commit}. This report does not identify its own commit.`,
    '',
  ];
  const checklist = [
    `# Verification checklist: ${source.story}`,
    '',
    `Candidate C: ${source.candidate}`,
    `Integrated M: ${record.integration.commit}`,
    '',
    ...verification.criteria.map((item) => `- [x] ${cleanCell(item.id)}: ${item.status}. Evidence: ${cleanCell(item.evidence)}`),
    ...requiredLenses.map((lens) => {
      const member = review.panel.members.find((item) => item.lens === lens);
      return `- [x] Review lens ${lens}: ${member.verdict}. Evidence: reviewer ${member.reviewer}, snapshot ${member.snapshot_hash}.`;
    }),
    '',
  ];
  const report = `${lines.join('\n')}\n`;
  const checklistText = `${checklist.join('\n')}\n`;
  return {
    report,
    checklist: checklistText,
    report_hash: sha256(report),
    checklist_hash: sha256(checklistText),
  };
}
