import fs from 'node:fs';
import path from 'node:path';
import { canonical, DeliverError, sha256 } from './state.mjs';

const MAX_STORY_BYTES = 8 * 1024 * 1024;
const EXECUTION_STATUSES = new Set(['claimed', 'building', 'built', 'in-review', 'blocked', 'merged']);
const BUILDERS = new Set(['auto', 'codex-builder', 'expert-builder']);
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const fail = (message) => { throw new DeliverError(message, 66); };
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function safeRelative(rel, label, prefix = null) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || /[\x00-\x1f\x7f]/.test(rel)) fail(`unsafe ${label}`);
  const parts = rel.split(/[\\/]/);
  if (parts.some((part) => !part || part === '.' || part === '..')) fail(`unsafe ${label}`);
  const normalized = parts.join('/');
  if (prefix && !normalized.startsWith(prefix)) fail(`unsafe ${label}`);
  return normalized;
}

function storyPath(relPath) {
  const rel = safeRelative(relPath, 'story path', 'docs/stories/');
  if (!/^docs\/stories\/S\d+-\d+-[^/]+\.md$/.test(rel)) fail('story path must be docs/stories/S<digits>-<digits>-<name>.md');
  return rel;
}

function scopePath(value) {
  const rel = safeRelative(value, 'story touch path');
  if (/[?*\[\]{}<>]/.test(rel) || rel === '.git' || rel.startsWith('.git/')
    || rel === '.deliver' || rel.startsWith('.deliver/')) fail('story touch paths must be bounded repository paths');
  return rel;
}

function validateJson(value, label, depth = 0) {
  if (depth > 16) fail(`${label} is nested too deeply`);
  if (typeof value === 'string' && (value.length > 65536 || /[\x00-\x1f\x7f]/.test(value))) fail(`unsafe value in ${label}`);
  if (typeof value === 'number' && !Number.isFinite(value)) fail(`unsafe value in ${label}`);
  if (Array.isArray(value)) {
    for (const item of value) validateJson(item, label, depth + 1);
    return;
  }
  if (!record(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (RESERVED_KEYS.has(key) || /[\x00-\x1f\x7f]/.test(key)) fail(`unsafe field in ${label}`);
    validateJson(item, label, depth + 1);
  }
}

function parseCommentJson(text, kind) {
  const start = new RegExp(`<!--\\s*${kind}\\s*:`, 'g');
  const starts = [...text.matchAll(start)];
  const comments = [];
  for (const match of text.matchAll(/<!--([\s\S]*?)-->/g)) {
    const body = match[1].trim();
    if (!body.startsWith(`${kind}:`)) continue;
    comments.push({ raw: match[0], body: body.slice(kind.length + 1).trim(), index: match.index, end: match.index + match[0].length });
  }
  if (starts.length !== comments.length) fail(`malformed ${kind} comment`);
  if (comments.length !== 1) fail(`story needs exactly one ${kind} comment`);
  if (/\r|\n/.test(comments[0].body)) fail(`${kind} must contain one-line JSON`);
  let value;
  try { value = JSON.parse(comments[0].body); } catch { fail(`invalid JSON in ${kind}`); }
  if (!record(value)) fail(`${kind} must be a JSON object`);
  validateJson(value, kind);
  return { ...comments[0], value };
}

function optionalExecComment(text) {
  const starts = [...text.matchAll(/<!--\s*pm-exec\s*:/g)];
  const comments = [];
  for (const match of text.matchAll(/<!--([\s\S]*?)-->/g)) {
    const body = match[1].trim();
    if (!body.startsWith('pm-exec:')) continue;
    comments.push({ raw: match[0], body: body.slice('pm-exec:'.length).trim(), index: match.index, end: match.index + match[0].length });
  }
  if (starts.length !== comments.length) fail('malformed pm-exec comment');
  if (comments.length > 1) fail('story has duplicate pm-exec comments');
  if (!comments.length) return null;
  if (/\r|\n/.test(comments[0].body)) fail('pm-exec must contain one-line JSON');
  let value;
  try { value = JSON.parse(comments[0].body); } catch { fail('invalid JSON in pm-exec'); }
  if (!record(value)) fail('pm-exec must be a JSON object');
  validateJson(value, 'pm-exec');
  return { ...comments[0], value };
}

function cleanString(value, label, max = 512) {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(`invalid ${label}`);
  return value;
}

export function isValidGitBranchName(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || value === '@'
    || value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.')
    || value.includes('..') || value.includes('//') || value.includes('@{')
    || /[\x00-\x20\x7f~^:?*[\\\]]/.test(value)) return false;
  return value.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'));
}

function normalizeMeta(meta) {
  if (!BUILDERS.has(meta.builder) || !Array.isArray(meta.touches) || !meta.touches.length) fail('invalid story pm-meta builder or touches');
  const touches = meta.touches.map(scopePath);
  if (new Set(touches).size !== touches.length) fail('story pm-meta touches must be unique');
  return { ...meta, builder: meta.builder, touches };
}

function normalizeExecution(value) {
  validateJson(value, 'pm-exec');
  const required = ['owner', 'builder', 'branch', 'status', 'rounds', 'retries', 'updated'];
  if (!required.every((key) => Object.hasOwn(value, key))) fail('pm-exec is missing required fields');
  cleanString(value.owner, 'pm-exec owner', 256);
  if (!['codex-builder', 'expert-builder'].includes(value.builder)) fail('invalid pm-exec builder');
  if (!isValidGitBranchName(value.branch)) fail('invalid pm-exec branch');
  if (!EXECUTION_STATUSES.has(value.status)) fail('invalid pm-exec status');
  for (const key of ['rounds', 'retries']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) fail(`invalid pm-exec ${key}`);
  }
  cleanString(value.updated, 'pm-exec updated', 128);
  return { ...value };
}

function sections(text, heading) {
  const source = heading === 'Execution'
    ? '^## Execution[ \\t]*\\r?$'
    : '^## Acceptance criteria(?: \\(testable\\))?[ \\t]*\\r?$';
  const re = new RegExp(source, 'gm');
  return [...text.matchAll(re)].map((match) => ({ index: match.index, end: match.index + match[0].length, raw: match[0] }));
}

function executionSection(text) {
  const found = sections(text, 'Execution');
  if (found.length > 1) fail('story has duplicate Execution sections');
  if (!found.length) return null;
  const section = found[0];
  if (/^## /m.test(text.slice(section.end).replace(/^\r?\n/, ''))) fail('Execution must be the final level-two section');
  return { start: section.index, headingEnd: section.end, end: text.length };
}

function splitList(value, label, pattern) {
  if (value.trim().toLowerCase() === 'none') return [];
  const items = value.split(',').map((item) => item.trim());
  if (!items.length || items.some((item) => !pattern.test(item)) || new Set(items).size !== items.length) fail(`invalid ${label}`);
  return items;
}

function parseHeaders(text, id) {
  const sprint = Number(id.match(/^S(\d+)-/)[1]);
  let priority = null;
  let covers = [];
  let dependsOn = [];
  let parallelSafe = null;
  let risk = null;
  let reviewLenses = [];
  let specs = [];
  const sprintLines = [...text.matchAll(/^Sprint:.*$/gm)];
  if (sprintLines.length > 1) fail('story has duplicate Sprint headers');
  if (sprintLines.length) {
    const match = sprintLines[0][0].match(/^Sprint:\s*(\d+)\s*·\s*Priority:\s*(high|med|low)\s*·\s*Covers:\s*(.*?)\s*·\s*Depends on:\s*(.*?)\s*·\s*Parallel-safe:\s*(yes|no)\s*$/);
    if (!match || Number(match[1]) !== sprint) fail('invalid story Sprint header');
    priority = match[2];
    covers = splitList(match[3], 'story Covers header', /^(?:US|FR|AC|SM)-\d+$/);
    dependsOn = splitList(match[4], 'story Depends on header', /^S\d+-\d+$/);
    parallelSafe = match[5] === 'yes';
  }
  const riskLines = [...text.matchAll(/^Risk:.*$/gm)];
  if (riskLines.length > 1) fail('story has duplicate Risk headers');
  if (riskLines.length) {
    const match = riskLines[0][0].match(/^Risk:\s*(low|med|high)\s*·\s*Review lenses:\s*(.*?)(?:\s*·\s*Specs:\s*(.*?))?\s*$/);
    if (!match) fail('invalid story Risk header');
    risk = match[1];
    reviewLenses = splitList(match[2], 'story Review lenses header', /^[a-z][a-z0-9-]*$/);
    specs = match[3] === undefined ? [] : splitList(match[3], 'story Specs header', /^(?!\/)[^\x00-\x1f\x7f*?\[\]{}<>]+\.sdd$/)
      .map((item) => safeRelative(item, 'story spec path'));
  }
  return { sprint, priority, covers, dependsOn, parallelSafe, risk, reviewLenses, specs };
}

function acceptanceCriteria(text) {
  const found = sections(text, 'Acceptance criteria');
  if (found.length !== 1) fail('story needs exactly one Acceptance criteria section');
  const start = found[0].end + (text.slice(found[0].end).match(/^\r?\n/)?.[0].length || 0);
  const next = text.slice(start).search(/^## /m);
  const end = next < 0 ? text.length : start + next;
  const criteria = [];
  for (const match of text.slice(start, end).matchAll(/^- \[([ xX])\] ([^\r\n]*)\r?$/gm)) {
    if (!match[2]) fail('acceptance criterion text must not be empty');
    const absolute = start + match.index;
    criteria.push({
      text: match[2],
      checked: match[1].toLowerCase() === 'x',
      line: text.slice(0, absolute).split(/\r?\n/).length,
    });
  }
  if (!criteria.length) fail('story needs explicit acceptance checkboxes');
  return criteria;
}

export function parseStory(text, relPath) {
  const rel = storyPath(relPath);
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_STORY_BYTES || text.includes('\0')) fail('invalid or oversized story text');
  const heading = text.match(/^#\s+(S\d+-\d+)(?::|\s+[—-])\s*([^\r\n]+)\r?$/m);
  if (!heading || !heading[2] || /[\x00-\x1f\x7f]/.test(heading[2])) fail('story needs an ID and title heading');
  const fileId = path.basename(rel).match(/^(S\d+-\d+)-/)[1];
  if (heading[1] !== fileId) fail('story heading ID does not match its path');
  const metaComment = parseCommentJson(text, 'pm-meta');
  const metaLine = text.slice(0, metaComment.index).split(/\r?\n/).length;
  if (metaLine > 12) fail('pm-meta must appear in the first 12 lines');
  const meta = normalizeMeta(metaComment.value);
  const section = executionSection(text);
  const execComment = optionalExecComment(text);
  if (execComment && (!section || execComment.index < section.headingEnd)) fail('pm-exec must be inside the final Execution section');
  const execution = execComment ? normalizeExecution(execComment.value) : null;
  const contractText = section ? text.slice(0, section.start) : text;
  const headers = parseHeaders(contractText, heading[1]);
  const acceptance = acceptanceCriteria(contractText);
  return {
    id: heading[1],
    path: rel,
    title: heading[2],
    text,
    textHash: sha256(text),
    contractHash: sha256(contractText),
    meta,
    ...headers,
    acceptance,
    execution,
    executionHash: execution ? sha256(canonical(execution)) : null,
  };
}

export function readStory(root, relPath) {
  const rel = storyPath(relPath);
  let realRoot;
  try {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('project root must be a real directory');
    realRoot = fs.realpathSync.native(root);
  } catch (error) {
    if (error instanceof DeliverError) throw error;
    fail(`cannot read project root: ${error.message}`);
  }
  let cursor = realRoot;
  for (const part of rel.split('/')) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (error) { fail(`cannot read story ${rel}: ${error.message}`); }
    if (stat.isSymbolicLink()) fail(`story path is a symlink: ${rel}`);
  }
  let stat;
  try { stat = fs.statSync(cursor); } catch (error) { fail(`cannot read story ${rel}: ${error.message}`); }
  if (!stat.isFile() || stat.size > MAX_STORY_BYTES) fail(`story must be a regular file no larger than ${MAX_STORY_BYTES} bytes: ${rel}`);
  return parseStory(fs.readFileSync(cursor, 'utf8'), rel);
}

export function storyTaskContract(document) {
  if (!record(document) || typeof document.contractHash !== 'string' || !record(document.meta) || !Array.isArray(document.acceptance)) fail('invalid StoryDocument');
  return {
    id: document.id,
    acceptanceText: document.acceptance.map((criterion) => criterion.text),
    touches: [...document.meta.touches],
    builder: document.meta.builder,
    specs: [...document.specs],
  };
}

export function replaceStoryExecution(document, nextExec, { note } = {}) {
  if (!record(document) || typeof document.text !== 'string' || typeof document.path !== 'string') fail('invalid StoryDocument');
  if (!record(nextExec)) fail('next execution must be a JSON object');
  const merged = normalizeExecution({ ...(document.execution || {}), ...nextExec });
  if (note !== undefined) cleanString(note, 'Execution note', 1000);
  const currentSection = executionSection(document.text);
  const currentComment = optionalExecComment(document.text);
  let retained = '';
  let prefix = document.text;
  if (currentSection) {
    prefix = document.text.slice(0, currentSection.start);
    retained = document.text.slice(currentSection.headingEnd).replace(/^\r?\n/, '');
    if (currentComment) {
      const offset = currentSection.headingEnd + (document.text.slice(currentSection.headingEnd).match(/^\r?\n/)?.[0].length || 0);
      const start = currentComment.index - offset;
      retained = `${retained.slice(0, start)}${retained.slice(start + currentComment.raw.length)}`;
    }
    retained = retained.replace(/^\r?\n+/, '').replace(/\s+$/, '');
  } else if (!prefix.endsWith('\n')) prefix += '\n';
  const lines = [`<!-- pm-exec: ${JSON.stringify(merged)} -->`];
  if (retained) lines.push(retained);
  if (note !== undefined) lines.push(`- ${note}`);
  const after = `${prefix}## Execution\n${lines.join('\n')}\n`;
  const nextDocument = parseStory(after, document.path);
  if (nextDocument.contractHash !== document.contractHash) fail('Execution replacement changed the story contract');
  return {
    before: document.text,
    after,
    contractHash: nextDocument.contractHash,
    executionHash: nextDocument.executionHash,
    document: nextDocument,
  };
}
