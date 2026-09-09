import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DeliverError } from './state.mjs';
import { isValidGitBranchName, readStory } from './story.mjs';

const APPROVAL = 'docs/approval.json';
const PLAN = 'docs/plan.md';
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const PHASES = {
  migration: 'references/migrations.md',
  discovery: 'references/discovery.md',
  retrospective: 'references/retrospective.md',
  specification: 'references/specification.md',
  planning: 'references/planning-and-signoff.md',
  decomposition: 'references/decomposition.md',
  implementation: 'references/implementation-loop.md',
  done: 'references/documentation.md',
};
const fail = (message) => { throw new DeliverError(message, 66); };
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const chomp = (value) => value.replace(/(\r?\n)+$/, '');

function rootPath(root) {
  try {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('project root must be a real directory');
    return fs.realpathSync.native(root);
  } catch (error) {
    if (error instanceof DeliverError) throw error;
    fail(`cannot inspect project root: ${error.message}`);
  }
}

function relativePath(rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || /[\x00-\x1f\x7f]/.test(rel)) fail('unsafe project artifact path');
  const parts = rel.split(/[\\/]/);
  if (parts.some((part) => !part || part === '.' || part === '..')) fail('unsafe project artifact path');
  return parts.join('/');
}

function artifactPath(root, rel) {
  const realRoot = rootPath(root);
  const normalized = relativePath(rel);
  let cursor = realRoot;
  for (const part of normalized.split('/')) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (error) {
      if (error.code === 'ENOENT') return { path: cursor, rel: normalized, missing: true };
      throw error;
    }
    if (stat.isSymbolicLink()) fail(`project artifact path is a symlink: ${normalized}`);
  }
  return { path: cursor, rel: normalized, missing: false };
}

function readRegular(root, rel) {
  const resolved = artifactPath(root, rel);
  if (resolved.missing) return null;
  const stat = fs.statSync(resolved.path);
  if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) fail(`project artifact must be a regular file no larger than ${MAX_ARTIFACT_BYTES} bytes: ${resolved.rel}`);
  return fs.readFileSync(resolved.path, 'utf8');
}

function git(root, args) {
  try {
    return { ok: true, stdout: execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true,
    }) };
  } catch {
    return { ok: false, stdout: '' };
  }
}

function tracked(root, rel) {
  const result = git(root, ['ls-files', '--error-unmatch', '--', rel]);
  if (result.ok) return true;
  const inside = git(root, ['rev-parse', '--is-inside-work-tree']);
  return inside.ok && chomp(inside.stdout) === 'true' ? false : null;
}

function pathExists(root, rel) {
  try {
    const resolved = artifactPath(root, rel);
    return !resolved.missing;
  } catch {
    return true;
  }
}

function parseJsonObject(text, label) {
  let value;
  try { value = JSON.parse(text); } catch { fail(`invalid JSON in ${label}`); }
  if (!record(value)) fail(`${label} must contain a JSON object`);
  return value;
}

function optionalString(value, label, max = 512) {
  if (value !== null && value !== undefined
    && (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value))) fail(`invalid ${label}`);
}

export function readApprovalMarker(root) {
  const text = readRegular(root, APPROVAL);
  if (text === null) return null;
  const marker = parseJsonObject(text, APPROVAL);
  if (!['pending', 'approved', 'revoked'].includes(marker.status)) fail('invalid approval status');
  optionalString(marker.approver, 'approval approver', 256);
  optionalString(marker.approved_date, 'approval date', 128);
  optionalString(marker.updated, 'approval updated time', 128);
  if (marker.plan_digest !== null && marker.plan_digest !== undefined
    && (typeof marker.plan_digest !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(marker.plan_digest))) fail('invalid approval plan_digest');
  return marker;
}

function onePlanValue(text, label) {
  const matches = [...text.matchAll(new RegExp(`^- ${label}:[ \\t]*([^\\r\\n]*?)[ \\t]*(?:<!--.*-->)?[ \\t]*\\r?$`, 'gm'))];
  if (matches.length > 1) fail(`duplicate plan ${label}`);
  return matches.length ? matches[0][1].trim() : null;
}

export function readPlanPolicy(root) {
  const text = readRegular(root, PLAN);
  if (text === null) return null;
  const scale = onePlanValue(text, 'Scale');
  const checkpointPolicy = onePlanValue(text, 'Checkpoint policy');
  const integrationBranch = onePlanValue(text, 'Integration branch');
  const skeleton = onePlanValue(text, 'Skeleton');
  if (scale !== null && !['tiny', 'small', 'standard', 'large', 'regulated'].includes(scale)) fail('invalid plan Scale');
  if (checkpointPolicy !== null && !['story-level', 'sprint-level', 'autonomous'].includes(checkpointPolicy)) fail('invalid plan Checkpoint policy');
  if (integrationBranch !== null && !isValidGitBranchName(integrationBranch)) fail('invalid plan Integration branch');
  if (skeleton !== null && !['specdd', 'none'].includes(skeleton)) fail('invalid plan Skeleton');
  return { path: PLAN, scale, checkpointPolicy, integrationBranch, skeleton };
}

function storyDirectory(root) {
  try {
    const resolved = artifactPath(root, 'docs/stories');
    if (resolved.missing) return null;
    const stat = fs.statSync(resolved.path);
    if (!stat.isDirectory()) fail('docs/stories must be a real directory');
    return resolved.path;
  } catch (error) {
    if (error instanceof DeliverError) throw error;
    fail(`cannot inspect docs/stories: ${error.message}`);
  }
}

function recognizableStory(root) {
  let dir;
  try { dir = storyDirectory(root); } catch { return { meta: false, exec: false }; }
  if (!dir) return { meta: false, exec: false };
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { meta: false, exec: false }; }
  const found = { meta: false, exec: false };
  for (const entry of entries) {
    if (!entry.isFile() || !/^S\d+-\d+-.*\.md$/.test(entry.name)) continue;
    try {
      const stat = fs.lstatSync(path.join(dir, entry.name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARTIFACT_BYTES) continue;
      const text = fs.readFileSync(path.join(dir, entry.name), 'utf8');
      if (/<!--\s*pm-meta\s*:/.test(text)) found.meta = true;
      if (/<!--\s*pm-exec\s*:/.test(text)) found.exec = true;
    } catch {}
  }
  return found;
}

export function detectProjectFormat(root) {
  const realRoot = rootPath(root);
  if (pathExists(realRoot, APPROVAL)) return 'current';
  if (tracked(realRoot, APPROVAL) === true || git(realRoot, ['cat-file', '-e', `HEAD:${APPROVAL}`]).ok) return 'current';
  const storyMarkers = recognizableStory(realRoot);
  if (storyMarkers.exec) return 'current';
  if (pathExists(realRoot, 'pm/pm-state.json') || pathExists(realRoot, 'tmp/pm-state.json')) return 'legacy';
  if (storyMarkers.meta) return 'current';
  return 'none';
}

function cksum(text) {
  const bytes = Buffer.from(text);
  let crc = 0;
  const add = (byte) => {
    crc = (crc ^ (byte << 24)) >>> 0;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0)) >>> 0;
  };
  for (const byte of bytes) add(byte);
  for (let size = bytes.length; size > 0; size = Math.floor(size / 256)) add(size & 255);
  return ~crc >>> 0;
}

function actorIdentity(root) {
  let source = '';
  for (const key of ['user.email', 'user.name']) {
    const result = git(root, ['config', key]);
    if (result.ok) source = chomp(result.stdout);
    if (source) break;
  }
  if (!source) return null;
  source = source.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  const slug = source.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) return null;
  const first = cksum(source).toString(16).padStart(8, '0');
  const second = cksum(`${source}:pm-skill`).toString(16).padStart(8, '0');
  return `${slug}-${(first + second).slice(0, 12)}`;
}

function baseState(format, actor) {
  return {
    managed: true,
    legacy: null,
    approval: null,
    phase: null,
    next_reference: null,
    actor,
    branch: null,
    story: null,
    unmerged: [],
    unreadable: [],
    claims: [],
    sprints_without_retro: [],
    worktrees: 0,
    uncommitted: null,
    handoff: null,
    wiki_entries: null,
    format,
    current_sprint: null,
    plan: null,
    stories: [],
    diagnostics: [],
  };
}

function diagnostic(out, code, status, rel, message) {
  const item = { code, status, path: rel, message };
  if (!out.diagnostics.some((existing) => JSON.stringify(existing) === JSON.stringify(item))) out.diagnostics.push(item);
}

function inspectLegacy(root, actor) {
  const out = baseState('legacy', actor);
  out.legacy = pathExists(root, 'pm/pm-state.json') ? 'pm/pm-state.json' : 'tmp/pm-state.json';
  out.phase = 'migration';
  out.next_reference = PHASES.migration;
  return out;
}

function regularExists(out, root, rel, code) {
  try { return readRegular(root, rel) !== null; }
  catch (error) {
    diagnostic(out, code, 'UNKNOWN', rel, error.message);
    return false;
  }
}

export function inspectProjectState(root, { actorId } = {}) {
  const realRoot = rootPath(root);
  const format = detectProjectFormat(realRoot);
  if (format === 'none') return null;
  let actor = actorId === undefined ? actorIdentity(realRoot) : actorId;
  const invalidActor = actor !== null && (typeof actor !== 'string' || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(actor));
  if (invalidActor) actor = null;
  if (format === 'legacy') return inspectLegacy(realRoot, actor);
  const out = baseState('current', actor);
  if (invalidActor) diagnostic(out, 'ACTOR_ID_INVALID', 'UNKNOWN', '.git/config', 'The supplied actor identity is unsafe.');
  let marker = null;
  try { marker = readApprovalMarker(realRoot); }
  catch (error) { diagnostic(out, 'APPROVAL_UNREADABLE', 'UNKNOWN', APPROVAL, error.message); }
  if (!marker) diagnostic(out, 'APPROVAL_MISSING', 'MISSING', APPROVAL, 'Current-format project has no readable approval marker.');

  let planText = null;
  try { planText = readRegular(realRoot, PLAN); }
  catch (error) { diagnostic(out, 'PLAN_UNREADABLE', 'UNKNOWN', PLAN, error.message); }
  if (planText !== null) {
    try { out.plan = readPlanPolicy(realRoot); }
    catch (error) { diagnostic(out, 'PLAN_POLICY_INVALID', 'DRIFT', PLAN, error.message); }
  }

  const markerTracked = tracked(realRoot, APPROVAL);
  const planTracked = tracked(realRoot, PLAN);
  const digestResult = planText === null ? { ok: false, stdout: '' } : git(realRoot, ['hash-object', '--', PLAN]);
  const digestNow = digestResult.ok ? chomp(digestResult.stdout) : null;
  if (marker) {
    const digest = typeof marker.plan_digest === 'string' && marker.plan_digest ? marker.plan_digest : null;
    const planChanged = Boolean(marker.status === 'approved' && digest && digestNow && digest !== digestNow);
    const implementationReady = marker.status === 'approved' && markerTracked === true && planTracked === true
      && planText !== null && digest !== null && digestNow !== null && digest === digestNow;
    out.approval = {
      status: marker.status,
      approver: marker.approver ?? null,
      approved_date: marker.approved_date ?? null,
      plan_digest: digest,
      plan_changed: planChanged,
      marker_tracked: markerTracked,
      plan_tracked: planTracked,
      implementation_ready: implementationReady,
    };
    if (!implementationReady) {
      const status = markerTracked === null || planTracked === null || (planText !== null && digestNow === null) ? 'UNKNOWN'
        : marker.status !== 'approved' || !digest || planText === null ? 'MISSING' : 'DRIFT';
      diagnostic(out, 'APPROVAL_NOT_EXECUTABLE', status, APPROVAL,
        'Implementation requires an approved tracked marker, a tracked regular plan, and a matching non-null Git blob digest.');
    }
  }
  if (markerTracked === null || planTracked === null) diagnostic(out, 'GIT_TRACKING_UNKNOWN', 'UNKNOWN', '.git/index', 'Git tracking state could not be read.');

  let names = [];
  try {
    const dir = storyDirectory(realRoot);
    if (dir) names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => /^S\d+-\d+-.*\.md$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) { diagnostic(out, 'STORIES_UNREADABLE', 'UNKNOWN', 'docs/stories', error.message); }

  const storySlots = [];
  for (const name of names) {
    const id = name.match(/^(S\d+-\d+)-/)[1];
    const rel = `docs/stories/${name}`;
    try {
      const document = readStory(realRoot, rel);
      out.stories.push(document);
      storySlots.push({ id, document });
    } catch (error) {
      out.unreadable.push(id);
      storySlots.push({ id, document: null });
      diagnostic(out, 'STORY_UNREADABLE', 'UNKNOWN', rel, error.message);
    }
  }

  const branchResult = git(realRoot, ['branch', '--show-current']);
  out.branch = branchResult.ok ? (chomp(branchResult.stdout) || 'DETACHED') : 'DETACHED';
  if (!branchResult.ok) diagnostic(out, 'GIT_BRANCH_UNKNOWN', 'UNKNOWN', '.git/HEAD', 'Current Git branch could not be read.');
  const mine = storySlots.find(({ document }) => document?.execution?.branch === out.branch)
    || storySlots.find(({ id }) => out.branch.startsWith(`pm/${id}-`));
  if (mine) out.story = { id: mine.id, exec: mine.document?.execution ?? null };
  out.unmerged = storySlots.filter(({ document }) => !document || document.execution?.status !== 'merged').map(({ id }) => id);
  out.claims = storySlots.filter((slot) => slot !== mine && slot.document?.execution?.status && slot.document.execution.status !== 'merged')
    .map(({ id, document }) => ({ id, owner: document.execution.owner, status: document.execution.status, branch: document.execution.branch }));

  const worktreeResult = git(realRoot, ['worktree', 'list', '--porcelain']);
  if (worktreeResult.ok) out.worktrees = Math.max(0, worktreeResult.stdout.split(/\r?\n/).filter((line) => line.startsWith('worktree ')).length - 1);
  else diagnostic(out, 'GIT_WORKTREES_UNKNOWN', 'UNKNOWN', '.git', 'Git worktrees could not be read.');
  const statusResult = git(realRoot, ['status', '--porcelain', '--untracked-files=all']);
  if (statusResult.ok) out.uncommitted = statusResult.stdout.split(/\r?\n/).filter(Boolean).length;
  else diagnostic(out, 'GIT_STATUS_UNKNOWN', 'UNKNOWN', '.git/index', 'Git working-tree state could not be read.');
  const headProbe = git(realRoot, ['rev-parse', '--verify', 'HEAD']);
  if (!headProbe.ok) diagnostic(out, 'GIT_HEAD_UNKNOWN', 'UNKNOWN', '.git/HEAD', 'Git HEAD does not resolve to a commit.');

  if (out.actor) {
    const rel = `docs/handoff/${out.actor}.md`;
    let text = null;
    try { text = readRegular(realRoot, rel); }
    catch (error) { diagnostic(out, 'HANDOFF_UNREADABLE', 'UNKNOWN', rel, error.message); }
    if (text !== null) {
      const base = text.match(/^BASE_COMMIT:\s*([0-9a-f]{7,64})/m)?.[1] ?? null;
      const headResult = git(realRoot, ['rev-parse', 'HEAD']);
      const head = headResult.ok ? chomp(headResult.stdout) : null;
      let current = Boolean(base && head && head.startsWith(base));
      if (!current && base && head) {
        const changed = git(realRoot, ['diff', '--name-only', base, 'HEAD', '--']);
        if (changed.ok) current = changed.stdout.split(/\r?\n/).filter(Boolean).every((item) => item === rel);
        else diagnostic(out, 'HANDOFF_FRESHNESS_UNKNOWN', 'UNKNOWN', rel, 'The handoff base commit could not be compared with HEAD.');
      }
      if (!base) diagnostic(out, 'HANDOFF_BASE_MISSING', 'DRIFT', rel, 'Handoff has no valid BASE_COMMIT.');
      if (!head) diagnostic(out, 'GIT_HEAD_UNKNOWN', 'UNKNOWN', '.git/HEAD', 'Git HEAD could not be read.');
      out.handoff = { path: rel, current };
    }
  }

  try {
    const index = readRegular(realRoot, 'docs/wiki/index.md');
    if (index !== null) out.wiki_entries = index.split(/\r?\n/).filter((line) => line.startsWith('- ')).length;
  } catch (error) { diagnostic(out, 'WIKI_UNREADABLE', 'UNKNOWN', 'docs/wiki/index.md', error.message); }

  const sprints = [...new Set(storySlots.map(({ id }) => Number(id.match(/^S(\d+)-/)[1])))].sort((a, b) => a - b);
  const retroSkipped = out.plan?.scale === 'tiny' || out.plan?.scale === 'small';
  for (const sprint of sprints) {
    const entries = storySlots.filter(({ id }) => Number(id.match(/^S(\d+)-/)[1]) === sprint);
    const complete = entries.every(({ document }) => document?.execution?.status === 'merged');
    if (!complete || retroSkipped) continue;
    const rel = `docs/retros/sprint-${sprint}.md`;
    if (!regularExists(out, realRoot, rel, 'RETRO_UNREADABLE')) out.sprints_without_retro.push(sprint);
  }

  const hasSpec = regularExists(out, realRoot, 'docs/spec.md', 'SPEC_UNREADABLE');
  const hasPlan = planText !== null;
  const approvalStops = !out.approval || out.approval.status !== 'approved' || out.approval.plan_changed;
  if (approvalStops) out.phase = hasSpec || hasPlan || storySlots.length ? 'planning' : 'discovery';
  else if (out.sprints_without_retro.length) out.phase = 'retrospective';
  else if (storySlots.length) out.phase = out.unmerged.length ? 'implementation' : 'done';
  else if (!hasSpec && !hasPlan) out.phase = 'discovery';
  else if (!hasPlan) out.phase = 'specification';
  else out.phase = 'decomposition';

  const completionUncertain = out.diagnostics.some((item) => item.status === 'UNKNOWN' && [
    'PLAN_UNREADABLE', 'PLAN_POLICY_INVALID', 'STORIES_UNREADABLE', 'STORY_UNREADABLE',
    'RETRO_UNREADABLE', 'GIT_TRACKING_UNKNOWN', 'GIT_BRANCH_UNKNOWN', 'GIT_WORKTREES_UNKNOWN',
    'GIT_STATUS_UNKNOWN', 'GIT_HEAD_UNKNOWN',
  ].includes(item.code)) || out.diagnostics.some((item) => item.code === 'PLAN_POLICY_INVALID');
  if (out.phase === 'done' && !out.approval?.implementation_ready) out.phase = 'planning';
  if (out.phase === 'done' && completionUncertain) {
    out.phase = out.diagnostics.some((item) => item.code === 'PLAN_POLICY_INVALID') ? 'planning' : 'implementation';
  }
  out.next_reference = PHASES[out.phase];
  out.current_sprint = out.sprints_without_retro[0]
    ?? (out.unmerged.length ? Math.min(...out.unmerged.map((id) => Number(id.match(/^S(\d+)-/)[1]))) : null)
    ?? (sprints.length ? sprints.at(-1) : null);
  if (out.plan) {
    out.plan.tracked = planTracked;
    out.plan.blob_digest = digestNow;
  }
  return out;
}
