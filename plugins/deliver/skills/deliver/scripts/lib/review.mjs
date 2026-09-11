import { DeliverError, readJsonFile } from './state.mjs';

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(value);
const digest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const fail = (message) => { throw new DeliverError(message, 66); };

function finding(value, label, { attribution = false } = {}) {
  if (!record(value) || !['block', 'major', 'minor'].includes(value.severity)
    || typeof value.message !== 'string' || !value.message.trim() || value.message.length > 4000
    || (value.path !== undefined && (typeof value.path !== 'string' || value.path.length > 1000))
    || (value.lens !== undefined && (!attribution || typeof value.lens !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.lens)))
    || (value.reviewer !== undefined && (!attribution || !identity(value.reviewer)))
    || (value.resolved !== undefined && typeof value.resolved !== 'boolean')) fail(`invalid review finding in ${label}`);
  return {
    severity: value.severity,
    message: value.message,
    ...(value.path === undefined ? {} : { path: value.path }),
    resolved: value.resolved === true,
    ...(value.lens === undefined ? {} : { lens: value.lens }),
    ...(value.reviewer === undefined ? {} : { reviewer: value.reviewer }),
  };
}

function sameFinding(supplied, derived) {
  return supplied.severity === derived.severity && supplied.message === derived.message
    && supplied.path === derived.path && supplied.resolved === derived.resolved
    && (supplied.lens === undefined || supplied.lens === derived.lens)
    && (supplied.reviewer === undefined || supplied.reviewer === derived.reviewer);
}

function assertPanelAggregate(supplied, derived) {
  if (!supplied.length) return;
  if (supplied.length !== derived.length) fail('top-level panel findings must equal the complete member-derived aggregate');
  const remaining = [...derived];
  const constrainedFirst = [...supplied].sort((left, right) => Number(right.lens !== undefined) + Number(right.reviewer !== undefined)
    - Number(left.lens !== undefined) - Number(left.reviewer !== undefined));
  for (const item of constrainedFirst) {
    const index = remaining.findIndex((candidate) => sameFinding(item, candidate));
    if (index === -1) fail('top-level panel findings differ from the member-derived aggregate');
    remaining.splice(index, 1);
  }
  if (remaining.length) fail('top-level panel findings omit member-derived findings');
}

export function parseReviewReceipt(input, { expectedSnapshot } = {}) {
  const receipt = typeof input === 'string' ? readJsonFile(input, 'review receipt') : input;
  if (!record(receipt) || !['PASS', 'FAIL'].includes(receipt.status) || !Array.isArray(receipt.findings)) {
    fail('review receipt must contain status PASS|FAIL and a findings array');
  }
  const topFindings = receipt.findings.map((item, index) => finding(item, `top-level findings[${index}]`, { attribution: true }));
  if (receipt.summary !== undefined && (typeof receipt.summary !== 'string' || receipt.summary.length > 8000)) fail('review summary must be a bounded string');
  if (receipt.panel === undefined) {
    if (receipt.status === 'PASS' && topFindings.some((item) => !item.resolved && item.severity !== 'minor')) {
      fail('a PASS review may not contain unresolved block or major findings');
    }
    return { status: receipt.status, findings: topFindings, ...(receipt.summary === undefined ? {} : { summary: receipt.summary }) };
  }
  const panel = receipt.panel;
  if (!record(panel) || !digest(panel.snapshot_hash) || !Array.isArray(panel.members) || !panel.members.length || panel.members.length > 16) {
    fail('review panel must bind one to sixteen members to a snapshot');
  }
  if (expectedSnapshot !== undefined && panel.snapshot_hash !== expectedSnapshot) fail('review panel snapshot does not match the reviewed snapshot');
  const members = panel.members.map((member, index) => {
    if (!record(member) || typeof member.lens !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(member.lens)
      || !identity(member.reviewer) || !['PASS', 'CONCERNS', 'FAIL'].includes(member.verdict)
      || member.snapshot_hash !== panel.snapshot_hash || !Array.isArray(member.findings)) fail(`invalid review panel member at index ${index}`);
    const findings = member.findings.map((item, findingIndex) => finding(item, `panel member ${index} finding ${findingIndex}`));
    if (member.verdict === 'PASS' && findings.some((item) => !item.resolved && item.severity !== 'minor')) fail('PASS panel member has unresolved blocking findings');
    if (member.verdict === 'CONCERNS' && !findings.some((item) => !item.resolved)) fail('CONCERNS panel member must retain an unresolved finding');
    return { lens: member.lens, reviewer: member.reviewer, verdict: member.verdict, snapshot_hash: member.snapshot_hash, findings };
  });
  if (new Set(members.map((item) => item.lens)).size !== members.length) fail('review panel lenses must be unique');
  const findings = members.flatMap((member) => member.findings.map((item) => ({ ...item, lens: member.lens, reviewer: member.reviewer })));
  assertPanelAggregate(topFindings, findings);
  const status = members.some((member) => member.verdict === 'FAIL')
    || findings.some((item) => !item.resolved && item.severity !== 'minor') ? 'FAIL' : 'PASS';
  if (receipt.status !== status) fail('review status must equal the verdict derived from panel members');
  return {
    status,
    findings,
    ...(receipt.summary === undefined ? {} : { summary: receipt.summary }),
    panel: { snapshot_hash: panel.snapshot_hash, members },
  };
}

export function requiredReviewLenses(story, scale) {
  const required = new Set(['code-integrity-reviewer', ...(story.reviewLenses || [])]);
  if (scale === 'regulated') required.add('security-auditor');
  return [...required].sort();
}

export function assertPanelCoverage(review, story, scale) {
  const required = requiredReviewLenses(story, scale);
  if (!review?.panel) fail(`durable reporting requires a structured review panel covering: ${required.join(', ')}`);
  const actual = new Set(review.panel.members.map((item) => item.lens));
  const missing = required.filter((lens) => !actual.has(lens));
  if (missing.length) fail(`review panel is missing required lenses: ${missing.join(', ')}`);
  return required;
}
