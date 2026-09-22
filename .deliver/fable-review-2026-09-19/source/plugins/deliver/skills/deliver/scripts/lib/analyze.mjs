import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { readApprovalMarker, readPlanPolicy } from './project-state.mjs';
import { canonical, sha256 } from './state.mjs';
import { parseStory } from './story.mjs';

export const ANALYSIS_STAGES = Object.freeze(['post-plan', 'post-decomposition', 'pre-claim']);
export const ANALYSIS_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const ANALYSIS_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const ANALYSIS_MAX_STORIES = 500;
export const ANALYSIS_TIMEOUT_MS = 10_000;

const FIXED_ARTIFACTS = Object.freeze([
  'docs/constitution.md',
  'docs/spec.md',
  'docs/plan.md',
  'docs/approval.json',
]);
const REQUIREMENT = /\b(?:FR|AC)-\d+\b/g;
const REQUIREMENT_DECLARATION = /^\s*-\s+((?:FR|AC)-\d+):\s*(.*)$/gm;
const STORY_NAME = /^S\d+-\d+-[^/]+\.md$/;
const STORY_ID = /^S\d+-\d+$/;
const SEVERITY_ORDER = Object.freeze({ CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 });
const REQUIRED_SEMANTIC_SCALES = new Set(['standard', 'large', 'regulated']);
const PLAN_COMMANDS = Object.freeze(['test', 'lint', 'build', 'run']);
const SECURITY_LENS = 'security-auditor';
const ARCHITECTURE_LENS = 'architecture-reviewer';
const INTEGRITY_LENS = 'code-integrity-reviewer';
const LARGE_SCALES = new Set(['large', 'regulated']);

export class AnalysisInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AnalysisInputError';
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkDeadline(context) {
  if (Date.now() > context.deadline) throw new AnalysisInputError('artifact analysis exceeded its time limit');
}

function realProjectRoot(root) {
  if (typeof root !== 'string' || root.length === 0 || root.includes('\0')) {
    throw new AnalysisInputError('project root must be a path');
  }
  try {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new AnalysisInputError('project root must be a real directory');
    }
    return fs.realpathSync.native(root);
  } catch (error) {
    if (error instanceof AnalysisInputError) throw error;
    throw new AnalysisInputError(`cannot read project root: ${error.message}`);
  }
}

function normalizeOptions(stage, scope) {
  if (!ANALYSIS_STAGES.includes(stage)) {
    throw new AnalysisInputError(`stage must be one of ${ANALYSIS_STAGES.join(', ')}`);
  }
  const selected = scope ?? { kind: 'project' };
  if (!isRecord(selected) || !['project', 'story'].includes(selected.kind)) {
    throw new AnalysisInputError('scope must select the project or one story');
  }
  if (selected.kind === 'project' && Object.keys(selected).some((key) => key !== 'kind')) {
    throw new AnalysisInputError('project scope has unknown fields');
  }
  if (selected.kind === 'story'
    && (Object.keys(selected).sort().join(',') !== 'kind,storyId' || !STORY_ID.test(selected.storyId))) {
    throw new AnalysisInputError('story scope needs one S<digits>-<digits> storyId');
  }
  return { stage, scope: { ...selected } };
}

function safeArtifactPath(root, rel) {
  const parts = rel.split('/');
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if (error.code === 'ENOENT') return { state: 'missing', path: cursor };
      return { state: 'invalid', path: cursor, message: error.message };
    }
    if (stat.isSymbolicLink()) return { state: 'invalid', path: cursor, message: 'path is a symlink' };
  }
  return { state: 'present', path: cursor };
}

function addIdentity(context, entry) {
  if (!context.identities.some((existing) => existing.path === entry.path)) context.identities.push(entry);
}

function readArtifact(context, rel) {
  checkDeadline(context);
  const resolved = safeArtifactPath(context.root, rel);
  if (resolved.state === 'missing') {
    addIdentity(context, { path: rel, state: 'missing' });
    return { state: 'missing', text: null };
  }
  if (resolved.state === 'invalid') {
    addIdentity(context, { path: rel, state: 'invalid', reason: resolved.message });
    return { state: 'invalid', text: null, message: resolved.message };
  }
  let stat;
  try {
    stat = fs.statSync(resolved.path);
  } catch (error) {
    addIdentity(context, { path: rel, state: 'invalid', reason: error.message });
    return { state: 'invalid', text: null, message: error.message };
  }
  if (!stat.isFile()) {
    addIdentity(context, { path: rel, state: 'invalid', reason: 'not a regular file' });
    return { state: 'invalid', text: null, message: 'not a regular file' };
  }
  if (stat.size > ANALYSIS_MAX_FILE_BYTES || context.totalBytes + stat.size > ANALYSIS_MAX_TOTAL_BYTES) {
    addIdentity(context, { path: rel, state: 'invalid', reason: 'artifact size limit exceeded', size: stat.size });
    return { state: 'invalid', text: null, message: 'artifact size limit exceeded' };
  }
  let bytes;
  try {
    bytes = fs.readFileSync(resolved.path);
  } catch (error) {
    addIdentity(context, { path: rel, state: 'invalid', reason: error.message });
    return { state: 'invalid', text: null, message: error.message };
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw new Error('artifact contains a null byte');
  } catch (error) {
    addIdentity(context, {
      path: rel,
      state: 'invalid',
      reason: error.message,
      bytes: bytes.length,
      digest: sha256(bytes),
    });
    return { state: 'invalid', text: null, message: error.message };
  }
  context.totalBytes += bytes.length;
  addIdentity(context, {
    path: rel,
    state: 'file',
    bytes: bytes.length,
    digest: sha256(bytes),
  });
  return { state: 'file', text };
}

function lineAt(text, index) {
  return text.slice(0, Math.max(index, 0)).split(/\r?\n/).length;
}

function lineMatching(text, pattern) {
  const match = text.match(pattern);
  return match?.index === undefined ? 1 : lineAt(text, match.index);
}

function finding({ code, category, severity, path: rel, line = 1, subject = '', status = 'FOUND', message, evidence, remediation }) {
  const key = sha256(canonical([code, rel, subject])).slice(0, 10);
  return {
    id: `AN-${code}-${key}`,
    code,
    category,
    severity,
    status,
    location: { path: rel, line },
    message,
    evidence,
    remediation,
  };
}

function addArtifactError(findings, rel, artifact) {
  if (artifact.state !== 'invalid') return;
  findings.push(finding({
    code: 'ARTIFACT_UNREADABLE',
    category: 'input',
    severity: 'HIGH',
    status: 'UNKNOWN',
    path: rel,
    subject: rel,
    message: `Cannot analyze ${rel}.`,
    evidence: artifact.message,
    remediation: 'Replace it with a bounded regular file inside the project, then run analysis again.',
  }));
}

function requireReadableArtifact(context, findings, rel, {
  code,
  category = 'scale',
  subject = rel,
  message,
  remediation,
}) {
  const artifact = readArtifact(context, rel);
  addArtifactError(findings, rel, artifact);
  if (artifact.state === 'missing') findings.push(finding({
    code,
    category,
    severity: 'HIGH',
    path: rel,
    subject,
    message,
    evidence: `${rel} is missing.`,
    remediation,
  }));
  return artifact;
}

function inspectPreimplementationArtifacts(context, findings, { stage, scale, policy, stories, scopedStoryId }) {
  const checklistPaths = [];
  const contractPaths = [...new Set(stories.flatMap((story) => story.specs))].sort();

  for (const rel of contractPaths) requireReadableArtifact(context, findings, rel, {
    code: 'DECLARED_CONTRACT_MISSING',
    category: 'contracts',
    subject: rel,
    message: `Declared contract ${rel} is unavailable.`,
    remediation: 'Author the declared governing contract in the approved contract phase, then rerun analysis.',
  });

  if (!LARGE_SCALES.has(scale)) return { checklistPaths, contractPaths };

  requireReadableArtifact(context, findings, 'docs/constitution.md', {
    code: 'CONSTITUTION_REQUIRED',
    message: `${scale} scale requires a project constitution before implementation.`,
    remediation: 'Create docs/constitution.md from the production constitution template and review its rules.',
  });

  checklistPaths.push('docs/checklists/spec-quality.md', 'docs/checklists/plan-quality.md');
  if (stage !== 'post-plan') {
    const checklistStories = stage === 'pre-claim' && scopedStoryId
      ? stories.filter((story) => story.id === scopedStoryId)
      : stories;
    checklistPaths.push(...checklistStories.map((story) => `docs/checklists/story-readiness-${story.id}.md`));
  }
  for (const rel of checklistPaths) requireReadableArtifact(context, findings, rel, {
    code: 'QUALITY_CHECKLIST_REQUIRED',
    category: 'checklists',
    subject: rel,
    message: `${scale} scale requires ${rel} at this analysis stage.`,
    remediation: 'Create the checklist from its matching production template and record evidence without automatic checkoffs.',
  });

  if (stage === 'post-plan') return { checklistPaths, contractPaths };
  if (policy?.skeleton !== 'specdd') findings.push(finding({
    code: 'SPECDD_SKELETON_REQUIRED',
    category: 'contracts',
    severity: 'HIGH',
    path: 'docs/plan.md',
    line: 1,
    subject: policy?.skeleton ?? 'missing',
    message: `${scale} scale requires the SpecDD skeleton before decomposition or claim.`,
    evidence: `Skeleton=${policy?.skeleton ?? 'missing'}`,
    remediation: 'Set Skeleton to specdd through the approved planning flow and create the authorized contract skeleton.',
  }));
  requireReadableArtifact(context, findings, '.specdd/bootstrap.md', {
    code: 'SPECDD_BOOTSTRAP_REQUIRED',
    category: 'contracts',
    message: `${scale} scale requires the SpecDD bootstrap before implementation.`,
    remediation: 'Create the authorized .specdd/bootstrap.md without installing or discovering contracts during analysis.',
  });
  for (const story of stories) if (story.specs.length === 0) findings.push(finding({
    code: 'STORY_CONTRACTS_REQUIRED',
    category: 'contracts',
    severity: 'HIGH',
    path: story.path,
    line: lineMatching(story.text, /^Risk:/m),
    subject: story.id,
    message: `${story.id} declares no governing SpecDD contract at ${scale} scale.`,
    evidence: 'Specs: none',
    remediation: 'Declare the exact bounded governing .sdd paths after the authorized contract phase.',
  }));
  return { checklistPaths, contractPaths };
}

function inventoryStories(context, findings) {
  checkDeadline(context);
  const rel = 'docs/stories';
  const resolved = safeArtifactPath(context.root, rel);
  if (resolved.state === 'missing') {
    addIdentity(context, { path: `${rel}/`, state: 'missing' });
    return [];
  }
  if (resolved.state === 'invalid') {
    addIdentity(context, { path: `${rel}/`, state: 'invalid', reason: resolved.message });
    addArtifactError(findings, rel, { state: 'invalid', message: resolved.message });
    return [];
  }
  let stat;
  let entries;
  try {
    stat = fs.statSync(resolved.path);
    if (!stat.isDirectory()) throw new Error('not a directory');
    entries = fs.readdirSync(resolved.path, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  } catch (error) {
    addIdentity(context, { path: `${rel}/`, state: 'invalid', reason: error.message });
    addArtifactError(findings, rel, { state: 'invalid', message: error.message });
    return [];
  }
  if (entries.length > ANALYSIS_MAX_STORIES * 2) {
    addIdentity(context, { path: `${rel}/`, state: 'invalid', reason: 'directory entry limit exceeded' });
    addArtifactError(findings, rel, { state: 'invalid', message: 'directory entry limit exceeded' });
    return [];
  }
  const names = entries.map((entry) => `${entry.name}:${entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other'}`);
  addIdentity(context, { path: `${rel}/`, state: 'directory', digest: sha256(canonical(names)), entries: entries.length });
  const storyEntries = entries.filter((entry) => STORY_NAME.test(entry.name));
  if (storyEntries.length > ANALYSIS_MAX_STORIES) {
    findings.push(finding({
      code: 'STORY_LIMIT_EXCEEDED', category: 'input', severity: 'HIGH', status: 'UNKNOWN', path: rel,
      subject: String(storyEntries.length), message: 'The story count exceeds the analysis limit.',
      evidence: `${storyEntries.length} stories exceed the ${ANALYSIS_MAX_STORIES} story limit.`,
      remediation: 'Split or archive the project stories before analysis.',
    }));
    return [];
  }
  return storyEntries.map((entry) => {
    const storyRel = `${rel}/${entry.name}`;
    const artifact = readArtifact(context, storyRel);
    addArtifactError(findings, storyRel, artifact);
    return { path: storyRel, artifact };
  });
}

function section(text, heading) {
  const matches = [...text.matchAll(new RegExp(`^## ${heading}[ \\t]*\\r?$`, 'gm'))];
  if (matches.length !== 1) return { count: matches.length, text: '', line: matches[0]?.index === undefined ? 1 : lineAt(text, matches[0].index) };
  const start = matches[0].index + matches[0][0].length;
  const rest = text.slice(start).replace(/^\r?\n/, '');
  const next = rest.search(/^## /m);
  return {
    count: 1,
    text: next < 0 ? rest : rest.slice(0, next),
    line: lineAt(text, start) + 1,
  };
}

function declaredRequirements(text, rel, findings) {
  const declarations = new Map();
  for (const match of text.matchAll(REQUIREMENT_DECLARATION)) {
    const id = match[1];
    const item = { id, path: rel, line: lineAt(text, match.index), text: match[2] };
    if (declarations.has(id)) {
      findings.push(finding({
        code: 'REQUIREMENT_DUPLICATE', category: 'coverage', severity: 'HIGH', path: rel,
        line: item.line, subject: id, message: `${id} is declared more than once.`, evidence: match[0],
        remediation: `Keep one authoritative ${id} declaration and update references without changing its ID.`,
      }));
    } else declarations.set(id, item);
  }
  return declarations;
}

function requirementReferences(text) {
  return [...new Set(text.match(REQUIREMENT) ?? [])];
}

function clarificationFindings(text, rel) {
  return [...text.matchAll(/\[NEEDS CLARIFICATION(?::[^\]\r\n]*)?\]/g)].map((match) => finding({
    code: 'CLARIFICATION_UNRESOLVED', category: 'clarification', severity: 'HIGH', path: rel,
    line: lineAt(text, match.index), subject: match[0], message: 'An unresolved clarification remains.',
    evidence: match[0], remediation: 'Resolve the question in the authoritative artifact before continuing.',
  }));
}

function parsePlanCommands(text, findings) {
  const commandsSection = section(text, 'Commands');
  const commands = new Map();
  if (commandsSection.count !== 1) {
    findings.push(finding({
      code: 'PLAN_COMMANDS_MALFORMED', category: 'commands', severity: 'HIGH', path: 'docs/plan.md',
      line: commandsSection.line, subject: 'Commands', message: 'The plan needs exactly one Commands section.',
      evidence: `Found ${commandsSection.count} Commands sections.`, remediation: 'Add one Commands section using the production plan format.',
    }));
    return commands;
  }
  const matches = [...commandsSection.text.matchAll(/^- ([A-Za-z][A-Za-z -]*):[ \t]*(.*?)\r?$/gm)];
  for (const match of matches) {
    const name = match[1].trim().toLowerCase();
    if (!PLAN_COMMANDS.includes(name)) continue;
    const line = commandsSection.line + lineAt(commandsSection.text, match.index) - 1;
    if (commands.has(name)) {
      findings.push(finding({
        code: 'PLAN_COMMAND_DUPLICATE', category: 'commands', severity: 'HIGH', path: 'docs/plan.md', line,
        subject: name, message: `The ${name} command is declared more than once.`, evidence: match[0],
        remediation: `Keep one ${name} command declaration.`,
      }));
      continue;
    }
    const raw = match[2].trim();
    const code = raw.match(/^`([^`\r\n]+)`$/)?.[1] ?? (raw === 'N/A' ? 'N/A' : null);
    if (code === null || /^<.*>$/.test(code) || code.trim().length === 0) {
      findings.push(finding({
        code: 'PLAN_COMMAND_MALFORMED', category: 'commands', severity: 'HIGH', path: 'docs/plan.md', line,
        subject: name, message: `The ${name} command is not a concrete command or N/A.`, evidence: match[0],
        remediation: `Set ${match[1]} to one exact command in backticks, or N/A when it is inapplicable.`,
      }));
    }
    commands.set(name, { value: code, line });
  }
  for (const name of PLAN_COMMANDS) {
    if (!commands.has(name)) findings.push(finding({
      code: 'PLAN_COMMAND_MISSING', category: 'commands', severity: 'HIGH', path: 'docs/plan.md',
      line: commandsSection.line, subject: name, message: `The plan does not declare its ${name} command.`,
      evidence: 'No matching command row exists.', remediation: `Add ${name} with an exact command or N/A.`,
    }));
  }
  return commands;
}

function plannedStoryIds(text) {
  const ids = [];
  for (const match of text.matchAll(/^\|\s*(S\d+-\d+)\s*\|/gm)) ids.push({ id: match[1], line: lineAt(text, match.index) });
  return ids;
}

function storyVerification(document, findings, planCommands) {
  const verification = section(document.text, 'Verification');
  const rel = document.path;
  if (verification.count !== 1) {
    findings.push(finding({
      code: 'STORY_VERIFICATION_MISSING', category: 'commands', severity: 'HIGH', path: rel,
      line: verification.line, subject: document.id, message: 'The story needs exactly one Verification section.',
      evidence: `Found ${verification.count} Verification sections.`, remediation: 'Add one exact verification command.',
    }));
    return;
  }
  const matches = [...verification.text.matchAll(/^- Prove done with:[ \t]*`([^`\r\n]+)`[ \t]*\r?$/gm)];
  if (matches.length !== 1 || /^<.*>$/.test(matches[0]?.[1] ?? '') || /^(?:N\/A|none)$/i.test(matches[0]?.[1] ?? '')) {
    findings.push(finding({
      code: 'STORY_VERIFICATION_MISSING', category: 'commands', severity: 'HIGH', path: rel,
      line: verification.line, subject: document.id, message: 'The story needs one usable exact verification command.',
      evidence: matches.length === 1 ? matches[0][0] : `Found ${matches.length} exact command declarations.`,
      remediation: 'Name the exact local command that proves this story is done.',
    }));
    return;
  }
  const command = matches[0][1].trim();
  const namedGate = command.match(/^@?gate:([a-z][a-z0-9-]*)$/)?.[1] ?? null;
  if (namedGate && (!planCommands.has(namedGate) || planCommands.get(namedGate).value === 'N/A')) {
    findings.push(finding({
      code: 'STORY_GATE_UNDEFINED', category: 'commands', severity: 'HIGH', path: rel,
      line: verification.line + lineAt(verification.text, matches[0].index) - 1,
      subject: `${document.id}:${namedGate}`, message: `The story names undefined gate ${namedGate}.`,
      evidence: matches[0][0], remediation: `Define ${namedGate} as a usable plan command or put the exact additional command in the story.`,
    }));
  }
}

function storyRiskText(document) {
  return [document.title, document.meta.touches.join(' '), section(document.text, 'Goal').text, section(document.text, 'Context').text].join('\n');
}

function lensFindings(document, scale) {
  const findings = [];
  const lenses = new Set(document.reviewLenses);
  const line = lineMatching(document.text, /^Risk:/m);
  const add = (lens, trigger, reason) => findings.push(finding({
    code: 'REVIEW_LENS_MISSING', category: 'review-lenses', severity: 'HIGH', path: document.path, line,
    subject: `${document.id}:${lens}`, message: `${document.id} omits ${lens}.`, evidence: reason,
    remediation: `Add ${lens} to Review lenses or revise the declared scope with evidence.`,
  }));
  if (!lenses.has(INTEGRITY_LENS)) add(INTEGRITY_LENS, 'required', 'Every story requires code integrity review.');
  if (scale === 'regulated' && !lenses.has(SECURITY_LENS)) {
    add(SECURITY_LENS, 'regulated', 'Regulated scale requires security review.');
  }
  return findings;
}

function lensCandidates(stories, required) {
  const candidates = [];
  for (const story of stories) {
    const text = storyRiskText(story);
    const checks = [
      {
        kind: 'security',
        lens: SECURITY_LENS,
        pattern: /\b(?:auth(?:entication|orization)?|oauth|secret|credential|password|untrusted|user[- ]supplied|upload|webhook|network|https?|socket|dependency|package-lock|lockfile|database|sql)\b/i,
      },
      {
        kind: 'architecture',
        lens: ARCHITECTURE_LENS,
        pattern: /\b(?:public api|interface|schema|migration|module boundar(?:y|ies)|architecture|plugin manifest|cli contract)\b/i,
      },
    ];
    for (const check of checks) {
      const match = text.match(check.pattern);
      if (!match || story.reviewLenses.includes(check.lens)) continue;
      candidates.push({
        story_id: story.id,
        location: { path: story.path, line: lineMatching(story.text, /^Risk:/m) },
        kind: check.kind,
        trigger: match[0],
        missing_declared_lens: check.lens,
        status: required ? 'JUDGMENT_REQUIRED' : 'OPTIONAL_REVIEW',
      });
    }
  }
  return candidates;
}

function storyMetadataFindings(document) {
  const findings = [];
  const sprintLine = lineMatching(document.text, /^Sprint:/m);
  const riskLine = lineMatching(document.text, /^Risk:/m);
  if (document.priority === null || document.parallelSafe === null) findings.push(finding({
    code: 'STORY_HEADER_MISSING', category: 'story-metadata', severity: 'HIGH', path: document.path,
    line: sprintLine, subject: document.id, message: 'The story has no complete Sprint metadata header.',
    evidence: 'Priority or Parallel-safe was not declared.', remediation: 'Fill the production Sprint metadata header.',
  }));
  if (document.risk === null) findings.push(finding({
    code: 'STORY_RISK_MISSING', category: 'story-metadata', severity: 'HIGH', path: document.path,
    line: riskLine, subject: document.id, message: 'The story has no complete Risk metadata header.',
    evidence: 'Risk was not declared.', remediation: 'Fill the production Risk and Review lenses header.',
  }));
  const extraMeta = Object.keys(document.meta).filter((key) => !['builder', 'touches'].includes(key));
  if (extraMeta.length) findings.push(finding({
    code: 'STORY_META_EXTRA_KEYS', category: 'scope', severity: 'HIGH', path: document.path,
    line: lineMatching(document.text, /<!--\s*pm-meta:/), subject: document.id,
    message: 'pm-meta contains fields outside the production contract.', evidence: extraMeta.join(', '),
    remediation: 'Keep only builder and touches in pm-meta.',
  }));
  return findings;
}

function touchesOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function dependencyAndScopeFindings(stories, stage, scopedStoryId) {
  const findings = [];
  const byId = new Map();
  for (const story of stories) {
    if (byId.has(story.id)) findings.push(finding({
      code: 'STORY_ID_DUPLICATE', category: 'dependencies', severity: 'HIGH', path: story.path,
      line: 1, subject: story.id, message: `${story.id} appears in more than one story file.`,
      evidence: `${byId.get(story.id).path} and ${story.path}`, remediation: 'Keep one authoritative file for this story ID.',
    }));
    else byId.set(story.id, story);
  }
  for (const story of stories) {
    for (const dependency of story.dependsOn) {
      const target = byId.get(dependency);
      if (!target) findings.push(finding({
        code: 'DEPENDENCY_UNKNOWN', category: 'dependencies', severity: 'HIGH', path: story.path,
        line: lineMatching(story.text, /^Sprint:/m), subject: `${story.id}:${dependency}`,
        message: `${story.id} depends on missing story ${dependency}.`, evidence: `Depends on: ${dependency}`,
        remediation: 'Add the missing story or remove the invalid dependency.',
      }));
      else if (stage === 'pre-claim' && story.id === scopedStoryId && target.execution?.status !== 'merged') findings.push(finding({
        code: 'DEPENDENCY_NOT_MERGED', category: 'dependencies', severity: 'HIGH', path: story.path,
        line: lineMatching(story.text, /^Sprint:/m), subject: `${story.id}:${dependency}`,
        message: `${story.id} depends on ${dependency}, which is not merged.`,
        evidence: `Observed status: ${target.execution?.status ?? 'unclaimed'}.`,
        remediation: `Merge and verify ${dependency} before claiming ${story.id}.`,
      }));
    }
  }

  const colors = new Map();
  const stack = [];
  const cycles = new Set();
  function visit(id) {
    colors.set(id, 'gray');
    stack.push(id);
    const story = byId.get(id);
    for (const next of story?.dependsOn ?? []) {
      if (!byId.has(next)) continue;
      if (!colors.has(next)) visit(next);
      else if (colors.get(next) === 'gray') {
        const cycle = stack.slice(stack.indexOf(next)).concat(next);
        const body = cycle.slice(0, -1);
        const rotations = body.map((_, index) => [...body.slice(index), ...body.slice(0, index)]);
        rotations.sort((a, b) => a.join('>') < b.join('>') ? -1 : 1);
        cycles.add(`${rotations[0].join('>')}>${rotations[0][0]}`);
      }
    }
    stack.pop();
    colors.set(id, 'black');
  }
  for (const id of [...byId.keys()].sort()) if (!colors.has(id)) visit(id);
  for (const cycle of [...cycles].sort()) {
    const first = byId.get(cycle.split('>')[0]);
    findings.push(finding({
      code: 'DEPENDENCY_CYCLE', category: 'dependencies', severity: 'HIGH', path: first.path,
      line: lineMatching(first.text, /^Sprint:/m), subject: cycle, message: `Story dependency cycle: ${cycle}.`,
      evidence: cycle, remediation: 'Remove or reverse an edge so dependency order is acyclic.',
    }));
  }

  const parallel = stories.filter((story) => story.parallelSafe === true);
  for (let leftIndex = 0; leftIndex < parallel.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < parallel.length; rightIndex += 1) {
      const left = parallel[leftIndex];
      const right = parallel[rightIndex];
      for (const leftTouch of left.meta.touches) {
        for (const rightTouch of right.meta.touches) {
          if (!touchesOverlap(leftTouch, rightTouch)) continue;
          findings.push(finding({
            code: 'PARALLEL_SCOPE_OVERLAP', category: 'scope', severity: 'HIGH', path: right.path,
            line: lineMatching(right.text, /<!--\s*pm-meta:/),
            subject: `${left.id}:${right.id}:${leftTouch}:${rightTouch}`,
            message: `${left.id} and ${right.id} are parallel-safe but their write scopes overlap.`,
            evidence: `${leftTouch} overlaps ${rightTouch}.`,
            remediation: 'Separate their touches or mark the stories as unsafe for parallel execution.',
          }));
        }
      }
    }
  }
  return findings;
}

function approvalFindings(root, stage, planArtifact, approvalArtifact, findings) {
  const required = stage !== 'post-plan';
  let approval = null;
  if (approvalArtifact.state === 'file') {
    try { approval = readApprovalMarker(root); }
    catch (error) {
      findings.push(finding({
        code: 'APPROVAL_MALFORMED', category: 'approval', severity: 'HIGH', status: 'UNKNOWN', path: 'docs/approval.json',
        subject: 'approval', message: 'The approval marker cannot be validated.', evidence: error.message,
        remediation: 'Repair the marker without inventing approval, then run analysis again.',
      }));
    }
  }
  if (!approval) {
    if (required && approvalArtifact.state !== 'invalid') findings.push(finding({
      code: 'APPROVAL_MISSING', category: 'approval', severity: 'HIGH', path: 'docs/approval.json',
      subject: stage, message: 'This analysis stage requires an approved plan marker.',
      evidence: 'No readable approval marker exists.', remediation: 'Complete explicit plan approval before decomposition or claim.',
    }));
    return { status: approvalArtifact.state, approval_status: null };
  }
  if (approval.status !== 'approved') {
    if (required) findings.push(finding({
      code: 'APPROVAL_NOT_APPROVED', category: 'approval', severity: 'HIGH', path: 'docs/approval.json',
      subject: approval.status, message: `The plan approval status is ${approval.status}.`,
      evidence: `status=${approval.status}`, remediation: 'Obtain explicit approval for the current plan.',
    }));
    return { status: 'readable', approval_status: approval.status };
  }
  if (planArtifact.state !== 'file') return { status: 'unverified', approval_status: approval.status };
  let planDigest = null;
  let planTracked = null;
  let approvalTracked = null;
  try {
    planDigest = execFileSync('git', ['-C', root, 'hash-object', '--', 'docs/plan.md'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, windowsHide: true,
    }).trim();
    const tracked = (rel) => {
      try {
        execFileSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', rel], {
          encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'], timeout: 2000, windowsHide: true,
        });
        return true;
      } catch (error) {
        if (error.killed || error.signal) throw error;
        return false;
      }
    };
    planTracked = tracked('docs/plan.md');
    approvalTracked = tracked('docs/approval.json');
  } catch {
    findings.push(finding({
      code: 'APPROVAL_GIT_UNKNOWN', category: 'approval', severity: 'HIGH', status: 'UNKNOWN', path: '.git',
      subject: stage, message: 'Git could not verify approval against the plan.',
      evidence: 'The bounded Git approval probe failed.', remediation: 'Restore local Git metadata and run analysis again.',
    }));
    return { status: 'unknown', approval_status: approval.status };
  }
  if (!approval.plan_digest || approval.plan_digest !== planDigest) findings.push(finding({
    code: 'APPROVAL_DIGEST_MISMATCH', category: 'approval', severity: 'CRITICAL', path: 'docs/approval.json',
    subject: approval.plan_digest ?? 'missing', message: 'Approval does not bind the current plan content.',
    evidence: `marker=${approval.plan_digest ?? 'null'} current=${planDigest}`, remediation: 'Review and approve the current plan content.',
  }));
  if (!planTracked || !approvalTracked) findings.push(finding({
    code: 'APPROVAL_NOT_TRACKED', category: 'approval', severity: 'HIGH', path: 'docs/approval.json',
    subject: `${planTracked}:${approvalTracked}`, message: 'Executable approval requires tracked plan and marker files.',
    evidence: `plan tracked=${planTracked}; marker tracked=${approvalTracked}`, remediation: 'Record the approved plan and marker in project history.',
  }));
  return {
    status: 'verified',
    approval_status: approval.status,
    plan_digest: planDigest,
    marker_digest: approval.plan_digest ?? null,
    plan_tracked: planTracked,
    approval_tracked: approvalTracked,
  };
}

function semanticReview(scale, artifacts, stories, commands, preimplementation) {
  const required = REQUIRED_SEMANTIC_SCALES.has(scale) || !scale;
  const items = [
    {
      id: 'SEM-AC-TESTABILITY',
      category: 'testability',
      locations: stories.length ? stories.map((story) => story.path) : ['docs/spec.md', 'docs/plan.md'],
      prompt: 'Judge whether each acceptance criterion is observable and tests the intended behavior.',
    },
    {
      id: 'SEM-RISK-LENSES',
      category: 'review-lenses',
      locations: stories.map((story) => story.path),
      prompt: 'Judge actual security and architecture risk beyond deterministic keyword triggers.',
      candidates: lensCandidates(stories, required),
    },
    {
      id: 'SEM-TERMINOLOGY',
      category: 'terminology',
      locations: artifacts.filter((entry) => entry.state === 'file').map((entry) => entry.path),
      prompt: 'Judge whether the same domain concepts use consistent names across artifacts.',
    },
    {
      id: 'SEM-CONSTITUTION',
      category: 'constitution',
      locations: artifacts.some((entry) => entry.path === 'docs/constitution.md' && entry.state === 'file')
        ? ['docs/constitution.md', 'docs/plan.md', ...stories.map((story) => story.path)] : [],
      prompt: 'Judge plan and story alignment with each project-specific constitution rule.',
    },
  ];
  const unavailable = [...commands.entries()].filter(([, command]) => command.value === 'N/A').map(([name]) => name);
  if (unavailable.length) items.push({
    id: 'SEM-COMMAND-NA',
    category: 'commands',
    locations: ['docs/plan.md'],
    prompt: `Confirm these commands are genuinely inapplicable: ${unavailable.join(', ')}.`,
  });
  if (LARGE_SCALES.has(scale)) items.push({
    id: 'SEM-QUALITY-CHECKLISTS',
    category: 'checklists',
    locations: preimplementation.checklistPaths,
    prompt: 'Judge every checklist checkoff against its cited evidence; file or checkbox presence alone is not PASS evidence.',
  });
  if (preimplementation.contractPaths.length || LARGE_SCALES.has(scale)) items.push({
    id: 'SEM-CONTRACT-COVERAGE',
    category: 'contracts',
    locations: [...new Set([...stories.map((story) => story.path), ...preimplementation.contractPaths])],
    prompt: 'Judge whether the exact declared contracts govern the story scope and express the required boundaries.',
  });
  return {
    status: required ? 'REVIEW_REQUIRED' : 'NOT_REQUIRED',
    required,
    items: items.map((item) => ({ ...item, status: required ? 'UNASSESSED' : 'OPTIONAL' })),
    note: required
      ? 'Deterministic checks cannot establish semantic correctness.'
      : 'This scale does not require artifact semantic analysis; the prompts remain available for optional review.',
  };
}

function sortFindings(findings) {
  return findings.sort((left, right) => (SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity])
    || (left.location.path < right.location.path ? -1 : left.location.path > right.location.path ? 1 : 0)
    || left.location.line - right.location.line
    || (left.code < right.code ? -1 : left.code > right.code ? 1 : 0)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

export function analyzeProjectArtifacts(root, { stage, scope = { kind: 'project' } } = {}) {
  const options = normalizeOptions(stage, scope);
  const realRoot = realProjectRoot(root);
  const context = {
    root: realRoot,
    deadline: Date.now() + ANALYSIS_TIMEOUT_MS,
    totalBytes: 0,
    identities: [],
  };
  const findings = [];
  const artifacts = Object.fromEntries(FIXED_ARTIFACTS.map((rel) => {
    const artifact = readArtifact(context, rel);
    addArtifactError(findings, rel, artifact);
    return [rel, artifact];
  }));
  const storyArtifacts = inventoryStories(context, findings);

  const planArtifact = artifacts['docs/plan.md'];
  const specArtifact = artifacts['docs/spec.md'];
  const approvalArtifact = artifacts['docs/approval.json'];
  let policy = null;
  if (planArtifact.state !== 'file') {
    if (planArtifact.state === 'missing') findings.push(finding({
      code: 'PLAN_MISSING', category: 'input', severity: 'HIGH', path: 'docs/plan.md', subject: stage,
      message: 'Artifact analysis requires a delivery plan.', evidence: 'docs/plan.md is missing.',
      remediation: 'Create the plan before running this analysis stage.',
    }));
  } else {
    try { policy = readPlanPolicy(realRoot); }
    catch (error) {
      findings.push(finding({
        code: 'PLAN_POLICY_MALFORMED', category: 'input', severity: 'HIGH', status: 'UNKNOWN', path: 'docs/plan.md',
        subject: 'policy', message: 'The delivery policy cannot be parsed.', evidence: error.message,
        remediation: 'Repair the production Delivery policy fields and run analysis again.',
      }));
    }
  }
  const scale = policy?.scale ?? null;
  if (planArtifact.state === 'file' && !scale) findings.push(finding({
    code: 'PLAN_SCALE_MISSING', category: 'input', severity: 'HIGH', path: 'docs/plan.md',
    line: lineMatching(planArtifact.text, /^## Delivery policy/m), subject: 'Scale',
    message: 'The plan has no valid Scale declaration.', evidence: 'Scale is absent.',
    remediation: 'Choose one production scale before continuing.',
  }));
  if (specArtifact.state === 'missing' && scale !== 'tiny') findings.push(finding({
    code: 'SPEC_MISSING', category: 'input', severity: 'HIGH', path: 'docs/spec.md', subject: scale ?? 'unknown',
    message: 'This project scale requires a specification.', evidence: `scale=${scale ?? 'unknown'}`,
    remediation: 'Create a production specification or explicitly choose tiny scale when appropriate.',
  }));

  if (specArtifact.state === 'file') findings.push(...clarificationFindings(specArtifact.text, 'docs/spec.md'));
  if (planArtifact.state === 'file') findings.push(...clarificationFindings(planArtifact.text, 'docs/plan.md'));
  const declarations = specArtifact.state === 'file'
    ? declaredRequirements(specArtifact.text, 'docs/spec.md', findings)
    : new Map();
  if (specArtifact.state === 'file' && declarations.size === 0) findings.push(finding({
    code: 'REQUIREMENTS_MISSING', category: 'coverage', severity: 'HIGH', path: 'docs/spec.md',
    subject: 'FR-AC', message: 'The specification declares no FR or AC requirements.',
    evidence: 'No production requirement declarations were found.', remediation: 'Add stable testable FR and AC declarations.',
  }));

  const planReferences = planArtifact.state === 'file' ? requirementReferences(planArtifact.text) : [];
  if (declarations.size) {
    for (const reference of planReferences) if (!declarations.has(reference)) findings.push(finding({
      code: 'PLAN_REQUIREMENT_UNKNOWN', category: 'coverage', severity: 'HIGH', path: 'docs/plan.md',
      line: lineMatching(planArtifact.text, new RegExp(`\\b${reference}\\b`)), subject: reference,
      message: `The plan references undeclared requirement ${reference}.`, evidence: reference,
      remediation: 'Correct the reference or add the requirement to the authoritative specification.',
    }));
    for (const [id, declaration] of declarations) if (!planReferences.includes(id)) findings.push(finding({
      code: 'REQUIREMENT_NOT_PLANNED', category: 'coverage', severity: 'HIGH', path: declaration.path,
      line: declaration.line, subject: id, message: `${id} is not referenced by the plan.`, evidence: declaration.text,
      remediation: `Map ${id} in the plan or explicitly remove it from approved scope.`,
    }));
  }

  const commands = planArtifact.state === 'file' ? parsePlanCommands(planArtifact.text, findings) : new Map();
  const stories = [];
  for (const entry of storyArtifacts) {
    if (entry.artifact.state !== 'file') continue;
    try {
      const document = parseStory(entry.artifact.text, entry.path);
      stories.push(document);
      findings.push(...storyMetadataFindings(document));
      findings.push(...lensFindings(document, scale));
      storyVerification(document, findings, commands);
      if (stage === 'post-decomposition' && document.execution !== null) findings.push(finding({
        code: 'STORY_CLAIMED_DURING_DECOMPOSITION', category: 'story-metadata', severity: 'HIGH', path: document.path,
        line: lineMatching(document.text, /^## Execution/m), subject: document.id,
        message: `${document.id} has execution state during post-decomposition analysis.`,
        evidence: `status=${document.execution.status}`, remediation: 'Finish decomposition before claiming stories, or use the correct later analysis stage.',
      }));
      if (stage === 'pre-claim' && options.scope.kind === 'story'
        && document.id === options.scope.storyId && document.execution !== null) findings.push(finding({
        code: 'STORY_ALREADY_CLAIMED', category: 'story-metadata', severity: 'HIGH', path: document.path,
        line: lineMatching(document.text, /^## Execution/m), subject: document.id,
        message: `${document.id} already has execution state.`, evidence: `status=${document.execution.status}`,
        remediation: 'Resume the existing claim instead of creating another claim.',
      }));
    } catch (error) {
      findings.push(finding({
        code: 'STORY_MALFORMED', category: 'input', severity: 'HIGH', status: 'UNKNOWN', path: entry.path,
        subject: entry.path, message: 'The strict story parser rejected this artifact.', evidence: error.message,
        remediation: 'Repair the story to the production template without discarding its requirements.',
      }));
    }
  }
  stories.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : left.path < right.path ? -1 : 1);

  const needsStories = stage !== 'post-plan';
  if (needsStories && storyArtifacts.length === 0) findings.push(finding({
    code: 'STORIES_MISSING', category: 'input', severity: 'HIGH', path: 'docs/stories', subject: stage,
    message: 'This analysis stage requires decomposed stories.', evidence: 'No production story files were found.',
    remediation: 'Decompose the approved plan into ready stories before continuing.',
  }));
  if (options.scope.kind === 'story' && !stories.some((story) => story.id === options.scope.storyId)) findings.push(finding({
    code: 'SCOPED_STORY_MISSING', category: 'input', severity: 'HIGH', path: 'docs/stories',
    subject: options.scope.storyId, message: `Scoped story ${options.scope.storyId} is unavailable.`,
    evidence: `No readable ${options.scope.storyId} story exists.`, remediation: 'Select an existing readable story.',
  }));

  if (needsStories) {
    const byRequirement = new Map([...declarations.keys()].map((id) => [id, []]));
    for (const story of stories) {
      if (declarations.size > 0 && story.covers.length === 0) findings.push(finding({
        code: 'STORY_REQUIREMENTS_MISSING', category: 'coverage', severity: 'HIGH', path: story.path,
        line: lineMatching(story.text, /^Sprint:/m), subject: story.id,
        message: `${story.id} covers no declared requirement.`, evidence: 'Covers: none',
        remediation: 'Map the story to stable FR or AC IDs, or remove the orphan scope.',
      }));
      for (const id of story.covers) {
        if (!declarations.has(id) && declarations.size > 0) findings.push(finding({
          code: 'STORY_REQUIREMENT_UNKNOWN', category: 'coverage', severity: 'HIGH', path: story.path,
          line: lineMatching(story.text, /^Sprint:/m), subject: `${story.id}:${id}`,
          message: `${story.id} covers undeclared requirement ${id}.`, evidence: id,
          remediation: 'Correct Covers or declare the requirement in the specification.',
        }));
        else if (byRequirement.has(id)) byRequirement.get(id).push(story.id);
      }
      for (const criterion of story.acceptance) {
        const id = criterion.text.match(/^((?:FR|AC)-\d+):\s+\S/)?.[1] ?? null;
        if (!id) findings.push(finding({
          code: 'STORY_CRITERION_ID_MISSING', category: 'coverage', severity: 'HIGH', path: story.path,
          line: criterion.line, subject: `${story.id}:${criterion.line}`,
          message: 'Acceptance criterion has no stable FR or AC ID.', evidence: criterion.text,
          remediation: 'Prefix the criterion with its authoritative stable requirement ID.',
        }));
        else if (declarations.size > 0 && !declarations.has(id)) findings.push(finding({
          code: 'STORY_CRITERION_UNKNOWN', category: 'coverage', severity: 'HIGH', path: story.path,
          line: criterion.line, subject: `${story.id}:${id}`,
          message: `Acceptance criterion references undeclared requirement ${id}.`, evidence: criterion.text,
          remediation: 'Use an authoritative AC or FR ID from the specification.',
        }));
      }
    }
    for (const [id, covered] of byRequirement) if (covered.length === 0) {
      const declaration = declarations.get(id);
      findings.push(finding({
        code: 'REQUIREMENT_UNCOVERED', category: 'coverage', severity: 'HIGH', path: declaration.path,
        line: declaration.line, subject: id, message: `${id} is not covered by any story.`,
        evidence: declaration.text, remediation: `Add ${id} to the Covers field of a ready story.`,
      }));
    }

    const planned = planArtifact.state === 'file' ? plannedStoryIds(planArtifact.text) : [];
    const plannedSet = new Set(planned.map((item) => item.id));
    const actualSet = new Set(stories.map((story) => story.id));
    for (const item of planned) if (!actualSet.has(item.id)) findings.push(finding({
      code: 'PLANNED_STORY_MISSING', category: 'coverage', severity: 'HIGH', path: 'docs/plan.md', line: item.line,
      subject: item.id, message: `Planned story ${item.id} has no readable story artifact.`, evidence: item.id,
      remediation: 'Create the planned story or revise and reapprove the plan.',
    }));
    for (const story of stories) if (!plannedSet.has(story.id)) findings.push(finding({
      code: 'STORY_NOT_PLANNED', category: 'coverage', severity: 'HIGH', path: story.path, line: 1,
      subject: story.id, message: `${story.id} is not declared in the plan.`, evidence: story.title,
      remediation: 'Add the story to the plan and reconcile approval, or remove the orphan scope.',
    }));
    findings.push(...dependencyAndScopeFindings(
      stories,
      stage,
      options.scope.kind === 'story' ? options.scope.storyId : null,
    ));
  }

  const preimplementation = inspectPreimplementationArtifacts(context, findings, {
    stage,
    scale,
    policy,
    stories,
    scopedStoryId: options.scope.kind === 'story' ? options.scope.storyId : null,
  });

  const approvalIdentity = approvalFindings(realRoot, stage, planArtifact, approvalArtifact, findings);
  addIdentity(context, { path: '.git/approval-probe', state: 'probe', ...approvalIdentity });
  checkDeadline(context);
  context.identities.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const contentIdentity = sha256(canonical(context.identities));
  const semantic = semanticReview(scale, context.identities, stories, commands, preimplementation);
  sortFindings(findings);
  const unknown = findings.some((item) => item.status === 'UNKNOWN');
  const blocking = findings.some((item) => item.status === 'FOUND' && ['CRITICAL', 'HIGH'].includes(item.severity));
  const factualStatus = unknown ? 'UNKNOWN' : blocking ? 'BLOCKED' : findings.length ? 'CONCERNS' : 'CLEAR';
  const status = unknown ? 'UNKNOWN'
    : blocking ? 'BLOCKED'
      : semantic.required ? 'REVIEW_REQUIRED'
        : findings.length ? 'CONCERNS' : 'FACTS_CLEAR';
  return {
    schema_version: 1,
    stage,
    scope: options.scope,
    scale,
    content_identity: contentIdentity,
    analysis_identity: sha256(canonical({ stage, scope: options.scope, contentIdentity })),
    status,
    factual_status: factualStatus,
    artifacts: context.identities,
    findings,
    semantic_review: semantic,
  };
}

export function claimReadinessFromAnalysis(analysis, { storyId } = {}) {
  if (!isRecord(analysis) || analysis.schema_version !== 1 || typeof analysis.content_identity !== 'string'
    || !Array.isArray(analysis.findings) || !isRecord(analysis.semantic_review)) {
    throw new AnalysisInputError('invalid artifact analysis result');
  }
  if (!STORY_ID.test(storyId ?? '')) throw new AnalysisInputError('claim readiness needs one storyId');
  const base = {
    ready: false,
    story_id: storyId,
    analysis_identity: analysis.analysis_identity,
    content_identity: analysis.content_identity,
    blocker_ids: analysis.findings
      .filter((item) => item.status === 'UNKNOWN'
        || (item.status === 'FOUND' && ['CRITICAL', 'HIGH'].includes(item.severity)))
      .map((item) => item.id),
  };
  if (analysis.stage !== 'pre-claim') return { ...base, status: 'WRONG_STAGE' };
  if (analysis.scope?.kind !== 'story' || analysis.scope.storyId !== storyId) return { ...base, status: 'WRONG_SCOPE' };
  if (analysis.findings.some((item) => item.status === 'UNKNOWN')) return { ...base, status: 'UNKNOWN' };
  if (base.blocker_ids.length) return { ...base, status: 'BLOCKED' };
  if (analysis.semantic_review.status === 'REVIEW_REQUIRED') return { ...base, status: 'REVIEW_REQUIRED' };
  if (analysis.semantic_review.status !== 'NOT_REQUIRED') return { ...base, status: 'UNKNOWN' };
  return { ...base, ready: true, status: 'READY' };
}

export function analyzeClaimReadiness(root, { storyId } = {}) {
  const analysis = analyzeProjectArtifacts(root, {
    stage: 'pre-claim',
    scope: { kind: 'story', storyId },
  });
  return { analysis, readiness: claimReadinessFromAnalysis(analysis, { storyId }) };
}

function escapeMarkdown(value) {
  return String(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\|`*_[\]{}()#+.!-])/g, '\\$1');
}

export function renderAnalysisMarkdown(analysis) {
  if (!isRecord(analysis) || analysis.schema_version !== 1 || !Array.isArray(analysis.findings)) {
    throw new AnalysisInputError('invalid artifact analysis result');
  }
  const lines = [
    '# PM artifact analysis report',
    '',
    `Stage: ${escapeMarkdown(analysis.stage)}`,
    '',
    `Scale: ${escapeMarkdown(analysis.scale ?? 'unknown')}`,
    '',
    `Content identity: ${escapeMarkdown(analysis.content_identity)}`,
    '',
    `Factual status: ${escapeMarkdown(analysis.factual_status)}`,
    '',
    '| ID | Category | Severity | Status | Location | Finding | Recommendation |',
    '|---|---|---|---|---|---|---|',
    ...analysis.findings.map((item) => `| ${escapeMarkdown(item.id)} | ${escapeMarkdown(item.category)} | ${item.severity} | ${item.status} | ${escapeMarkdown(`${item.location.path}:${item.location.line}`)} | ${escapeMarkdown(item.message)} | ${escapeMarkdown(item.remediation)} |`),
    '',
    '## Semantic review',
    '',
    `Status: ${analysis.semantic_review.status}`,
    '',
    ...analysis.semantic_review.items.map((item) => `- [ ] ${escapeMarkdown(item.id)}: ${escapeMarkdown(item.prompt)}`),
    '',
  ];
  return lines.join('\n');
}
