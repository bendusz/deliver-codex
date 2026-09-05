#!/usr/bin/env node

/*
 * A small, deliberately conservative SpecDD reader for Deliver.
 *
 * This is not the upstream SpecDD validator.  It reads the parts Deliver
 * needs for authorization: sections, explicit paths, ownership, and Must
 * inheritance.  In particular, ordinary prose in Owns is not a path.
 */

import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KNOWN_SECTIONS = Object.freeze([
  'Spec', 'Platform', 'Purpose', 'Structure', 'Owns', 'Can modify',
  'Can read', 'References', 'Must', 'Must not', 'Forbids', 'Depends on',
  'Exposes', 'Accepts', 'Returns', 'Raises', 'Handles', 'Tasks',
  'Done when', 'Scenario', 'Example',
]);

const KNOWN = new Set(KNOWN_SECTIONS);
const INLINE_SECTIONS = new Set(['Spec', 'Platform', 'Scenario', 'Example']);
const BODYLESS_SECTIONS = new Set(['Spec', 'Platform']);
const REPEATABLE_SECTIONS = new Set(['Scenario', 'Example']);
const PATH_SECTIONS = new Set([
  'Structure', 'Owns', 'Can modify', 'Can read', 'References',
  'Depends on', 'Forbids', 'Exposes',
]);
const GLOB_CHARS = /[*?[\]{}]/;
const PATH_PREFIX = /^(?:\.\/|\.\.\/|\/)/;
const UNSUPPORTED_PATH_PREFIX = /^~\//;
const MAX_SPEC_BYTES = 1024 * 1024;

function finding(code, message, line = null, extra = {}) {
  return { code, message, severity: 'error', ...(line == null ? {} : { line }), ...extra };
}

function isBlank(line) {
  return /^\s*$/.test(line);
}

function isComment(line) {
  return /^\s*#/.test(line);
}

function trimInline(value) {
  return value == null ? null : value.trim();
}

function parseKeyValue(text) {
  // A key-value separator is a colon followed by one literal space, with a
  // non-whitespace character immediately before the colon.
  const match = text.match(/^(.*\S): (.*)$/);
  if (!match) return null;
  return { key: match[1], value: match[2] };
}

function startsExplicitPath(text) {
  return PATH_PREFIX.test(text);
}

function pathCandidate(entry) {
  const text = entry.text.trim();
  // Paths in inline code are literal code text in the current dialect.
  if (text.startsWith('`')) return null;
  const keyValue = parseKeyValue(text);
  const candidate = keyValue ? keyValue.key.trim() : text;
  if (startsExplicitPath(candidate)) {
    return { raw: candidate, keyValue: Boolean(keyValue), glob: GLOB_CHARS.test(candidate) };
  }
  if (UNSUPPORTED_PATH_PREFIX.test(candidate)) {
    return { raw: candidate, unsupportedPrefix: true, keyValue: Boolean(keyValue), glob: false };
  }
  return null;
}

function parseBodyEntry(line, lineNumber, sectionName) {
  const text = line.slice(2).trim();
  const keyValue = parseKeyValue(text);
  const entry = {
    text,
    line: lineNumber,
    section: sectionName,
    raw: line,
    kind: keyValue ? 'key-value' : 'text',
    ...(keyValue || {}),
    continuation: [],
  };
  const candidate = PATH_SECTIONS.has(sectionName) ? pathCandidate(entry) : null;
  if (candidate) entry.path = candidate;
  return entry;
}

function normalizeEntry(entry) {
  return [entry.text, ...entry.continuation].map((part) => part.trim()).filter(Boolean).join(' ');
}

function parseHeader(line, lineNumber) {
  const exact = line.match(/^([A-Za-z][A-Za-z ]*):(.*)$/);
  if (!exact) return null;
  const label = exact[1];
  const tail = exact[2];
  const hasWhitespace = tail.length > 0 && /^\s/.test(tail);
  const hasSpace = tail.length > 0 && /^ +/.test(tail);
  return {
    label,
    line: lineNumber,
    inline: tail.length === 0 ? null : (hasSpace ? tail.trim() : null),
    malformedInlineSpacing: tail.length > 0 && !hasSpace,
    hasWhitespace,
  };
}

function looksLikeKnownHeaderWithoutColon(line) {
  return KNOWN_SECTIONS.some((section) => line === section || line.startsWith(`${section} `));
}

/**
 * Parse a SpecDD document without resolving any filesystem paths.
 *
 * The returned section entries retain source lines and normalized text so
 * callers can make policy decisions without reparsing the source.
 */
export function parseSpec(text) {
  if (typeof text !== 'string') throw new TypeError('parseSpec(text) expects a string');

  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  const findings = [];
  let current = null;
  let sawSection = false;
  const scenarioTitles = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    if (isBlank(line) || isComment(line)) continue;

    const indent = line.match(/^[ \t]*/)?.[0] ?? '';
    if (indent.includes('\t')) {
      findings.push(finding('tabs-in-indentation', 'Tabs are not valid in non-comment indentation.', lineNumber));
    }
    const content = line.slice(indent.length);
    const header = indent.length === 0 ? parseHeader(line, lineNumber) : null;

    if (header) {
      const { label, inline, malformedInlineSpacing } = header;
      const known = KNOWN.has(label);
      if (!known && KNOWN.has(label.trim())) {
        findings.push(finding('space-before-colon', `${label.trim()}: must not have whitespace before the colon.`, lineNumber, { section: label.trim() }));
        current = null;
        continue;
      }
      if (!known) {
        findings.push(finding('unknown-section', `Unknown section: ${label}.`, lineNumber, { section: label }));
        current = null;
        continue;
      }
      if (malformedInlineSpacing) {
        findings.push(finding('inline-spacing', `${label}: must separate inline text from the colon with a space.`, lineNumber, { section: label }));
      }
      if (!INLINE_SECTIONS.has(label) && inline != null) {
        findings.push(finding('inline-not-allowed', `${label}: does not accept inline text.`, lineNumber, { section: label }));
      }
      if (INLINE_SECTIONS.has(label) && malformedInlineSpacing) {
        // Keep the value absent. A malformed header must not become an
        // authorization input by accident.
        current = { name: label, line: lineNumber, inline: null, entries: [] };
      } else {
        current = { name: label, line: lineNumber, inline, entries: [] };
      }
      sections.push(current);
      sawSection = true;
      if (label === 'Scenario') {
        if (!inline) findings.push(finding('missing-inline-value', 'Scenario requires a nonempty inline title.', lineNumber, { section: label }));
        else if (scenarioTitles.has(inline)) findings.push(finding('duplicate-scenario', `Duplicate Scenario title: ${inline}.`, lineNumber, { section: label }));
        else scenarioTitles.add(inline);
      }
      continue;
    }

    if (indent.length === 0) {
      if (looksLikeKnownHeaderWithoutColon(line)) {
        findings.push(finding('malformed-section-header', 'Known section labels must be followed immediately by a colon.', lineNumber));
      } else if (!sawSection) {
        findings.push(finding('text-before-spec', 'Only blank lines and comments may precede the first section.', lineNumber));
      } else {
        findings.push(finding('invalid-line', 'Text outside a section is not valid SpecDD content.', lineNumber));
      }
      continue;
    }

    if (!current) {
      findings.push(finding('body-without-section', 'Body text appeared before a recognized section.', lineNumber));
      continue;
    }
    if (indent.length % 2 !== 0) {
      findings.push(finding('odd-indentation', 'Non-comment indentation must use multiples of two spaces.', lineNumber));
    }

    if (indent.length === 2) {
      if (BODYLESS_SECTIONS.has(current.name)) {
        findings.push(finding('body-not-allowed', `${current.name} is inline-only and cannot contain body entries.`, lineNumber, { section: current.name }));
      }
      const entry = parseBodyEntry(line, lineNumber, current.name);
      if (current.name === 'Tasks') {
        const task = entry.text.match(/^\[([^\]])\](?: (.*))?$/);
        if (!task || ![' ', 'x', 'X', '-', '!', '?'].includes(task[1])) {
          findings.push(finding('invalid-task', 'Tasks entries must use a supported task marker.', lineNumber, { section: current.name }));
        } else if (!task[2]?.trim()) {
          findings.push(finding('empty-task', 'Tasks entries need task text.', lineNumber, { section: current.name }));
        }
      }
      current.entries.push(entry);
    } else if (indent.length >= 4 && indent.length % 2 === 0) {
      if (BODYLESS_SECTIONS.has(current.name)) {
        findings.push(finding('body-not-allowed', `${current.name} is inline-only and cannot contain continuation lines.`, lineNumber, { section: current.name }));
      }
      const previous = current.entries.at(-1);
      if (!previous) {
        findings.push(finding('orphan-continuation', 'A continuation line needs a preceding body entry.', lineNumber, { section: current.name }));
      } else {
        previous.continuation.push(content.trim());
      }
    } else {
      findings.push(finding('invalid-indentation', 'Body entries use two spaces and continuation lines use four or more spaces.', lineNumber, { section: current.name }));
    }
  }

  if (!sections.length || sections[0].name !== 'Spec') {
    findings.push(finding('first-section-not-spec', 'The first section must be Spec.'));
  }
  const spec = sections.find((section) => section.name === 'Spec');
  if (!spec || !spec.inline) findings.push(finding('missing-spec', 'A complete spec needs a nonempty Spec inline value.', spec?.line ?? null));
  for (const section of sections) {
    if (section.name === 'Platform' && !section.inline) {
      findings.push(finding('missing-platform', 'Platform, when present, must have a nonempty inline value.', section.line, { section: section.name }));
    }
  }
  const seen = new Map();
  for (const section of sections) {
    if (REPEATABLE_SECTIONS.has(section.name)) continue;
    if (seen.has(section.name)) {
      findings.push(finding('duplicate-section', `Section ${section.name} may appear only once.`, section.line, { section: section.name }));
    }
    seen.set(section.name, section.line);
  }
  for (const section of sections) {
    for (const entry of section.entries) entry.normalized = normalizeEntry(entry);
  }

  return {
    valid: findings.length === 0,
    findings,
    sections,
    // Convenient normalized aliases used by callers and tests.
    spec: spec?.inline ?? null,
    platform: sections.find((section) => section.name === 'Platform')?.inline ?? null,
    owns: sections.filter((section) => section.name === 'Owns').flatMap((section) => section.entries),
    canModify: sections.filter((section) => section.name === 'Can modify').flatMap((section) => section.entries),
    must: sections.filter((section) => section.name === 'Must').flatMap((section) => section.entries),
    mustNot: sections.filter((section) => section.name === 'Must not').flatMap((section) => section.entries),
  };
}

function slash(value) {
  return value.split(path.sep).join('/');
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function realpathForExistingAncestor(target) {
  let cursor = target;
  const suffix = [];
  while (true) {
    try {
      const resolved = await realpath(cursor);
      return path.join(resolved, ...suffix.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return null;
      const parent = path.dirname(cursor);
      if (parent === cursor) return null;
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function overlap(a, b) {
  return a === b || a === '.' || b === '.' || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function sectionEntries(parsed, name) {
  return parsed.sections.filter((section) => section.name === name).flatMap((section) => section.entries);
}

function entryTexts(entries) {
  return entries.map((entry) => entry.normalized || entry.text.trim()).filter(Boolean);
}

async function resolveEntry({ entry, section, specPath, root, rootReal, relativeToRoot }) {
  const candidate = entry.path;
  if (!candidate) return null;
  if (candidate.unsupportedPrefix) {
    return { finding: finding('unsupported-path-prefix', `Unsupported path prefix in ${candidate.raw}.`, entry.line, { section, raw: candidate.raw }) };
  }
  const base = candidate.raw.startsWith('/') ? root : path.dirname(specPath);
  const rawWithoutRoot = candidate.raw.startsWith('/') ? candidate.raw.slice(1) : candidate.raw;
  const absolute = path.resolve(base, rawWithoutRoot);
  if (!isWithin(root, absolute)) {
    return {
      raw: candidate.raw,
      enforcement: 'excluded',
      finding: finding('path-escape', `Path ${candidate.raw} escapes the content root.`, entry.line, { section, raw: candidate.raw, resolved: absolute, severity: 'error', enforcement: 'excluded' }),
    };
  }

  if (candidate.glob) {
    const authority = section === 'Owns' || section === 'Can modify';
    return {
      raw: candidate.raw,
      glob: true,
      enforcement: 'excluded',
      finding: finding('unsupported-glob', `Glob ${candidate.raw} is not enforced by Deliver.`, entry.line, { section, raw: candidate.raw, severity: authority ? 'error' : 'warning', enforcement: 'excluded' }),
    };
  }

  if ((section === 'Owns' || section === 'Can modify') && /\.sdd\/*$/i.test(candidate.raw)) {
    return {
      raw: candidate.raw,
      enforcement: 'excluded',
      finding: finding('spec-file-ownership', `Spec files cannot be owned or editable: ${candidate.raw}.`, entry.line, { section, raw: candidate.raw, severity: 'error', enforcement: 'excluded' }),
    };
  }

  const normalized = slash(path.relative(root, absolute) || '.');

  const real = await realpathForExistingAncestor(absolute);
  if (real && !isWithin(rootReal, real)) {
    return {
      raw: candidate.raw,
      enforcement: 'excluded',
      finding: finding('symlink-escape', `Path ${candidate.raw} resolves through a symlink outside the content root.`, entry.line, { section, raw: candidate.raw, resolved: real, severity: 'error', enforcement: 'excluded' }),
    };
  }
  return {
    raw: candidate.raw,
    path: normalized,
    absolute,
    specRelative: slash(path.relative(path.dirname(specPath), absolute) || '.'),
    section,
    line: entry.line,
    glob: false,
    enforcement: 'included',
    relativeToRoot,
  };
}

function dedupePaths(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.path || seen.has(item.path)) return false;
    seen.add(item.path);
    return true;
  });
}

async function governedDirectory(specPath, root) {
  const directory = path.dirname(specPath);
  const stem = path.basename(specPath, '.sdd');
  const rootName = path.basename(root);
  if (directory === root) {
    if (stem === rootName || stem.toLowerCase() === 'root') return root;
    try {
      const child = path.join(directory, stem);
      await accessDirectory(child);
      return child;
    } catch {
      return null;
    }
  }
  if (path.basename(directory) === stem) return directory;
  try {
    const child = path.join(directory, stem);
    await accessDirectory(child);
    return child;
  } catch {
    return null;
  }
}

async function accessDirectory(directory) {
  const info = await stat(directory);
  if (!info.isDirectory()) throw new Error('not a directory');
}

/**
 * Inspect a fixed snapshot of the supplied specs. No files are created or
 * modified. Relative spec paths are relative to root.
 */
export async function inspectSpecs(root, specPaths) {
  if (typeof root !== 'string' || !Array.isArray(specPaths)) {
    throw new TypeError('inspectSpecs(root, specPaths) expects a root string and an array of spec paths');
  }
  if (specPaths.some((specPath) => typeof specPath !== 'string' || specPath.trim() === '')) {
    throw new TypeError('inspectSpecs(root, specPaths) expects nonempty string spec paths');
  }
  const rootAbsolute = path.resolve(root);
  const inputs = [...new Set(specPaths.map((specPath) => path.resolve(rootAbsolute, specPath)))];

  // Validate the root before reading any spec. A symlink root would make the
  // content boundary ambiguous, so fail closed.
  let rootReal;
  try {
    const rootStat = await lstat(rootAbsolute);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('root must be a real directory');
    rootReal = await realpath(rootAbsolute);
  } catch (error) {
    return {
      root: rootAbsolute,
      specs: [],
      ownership: [],
      writeScope: [],
      ownedPaths: [],
      editablePaths: [],
      findings: [finding('invalid-root', `Cannot use content root ${rootAbsolute}: ${error.message}`, null, { severity: 'error' })],
      ok: false,
      snapshot: true,
    };
  }

  // Validate every input first. No external, symlinked, non-regular, or
  // oversized input reaches readFile. This is also the authorization
  // snapshot boundary: edits to .sdd files after this point cannot widen it.
  const preflight = await Promise.all(inputs.map(async (specPath) => {
    if (!isWithin(rootAbsolute, specPath)) {
      return { specPath, valid: false, findings: [finding('spec-outside-root', `Spec ${specPath} is outside the content root.`, null, { severity: 'error' })] };
    }
    try {
      const info = await lstat(specPath);
      if (info.isSymbolicLink()) {
        return { specPath, valid: false, findings: [finding('symlink-escape', `Spec ${specPath} is a symlink and cannot be inspected.`, null, { severity: 'error' })] };
      }
      if (!info.isFile()) {
        return { specPath, valid: false, findings: [finding('spec-not-file', `Spec ${specPath} is not a regular file.`, null, { severity: 'error' })] };
      }
      if (info.size > MAX_SPEC_BYTES) {
        return { specPath, valid: false, findings: [finding('spec-too-large', `Spec ${specPath} exceeds the ${MAX_SPEC_BYTES}-byte limit.`, null, { severity: 'error' })] };
      }
      const specReal = await realpath(specPath);
      if (!isWithin(rootReal, specReal)) {
        return { specPath, valid: false, findings: [finding('symlink-escape', `Spec ${specPath} resolves outside the content root.`, null, { severity: 'error', resolved: specReal })] };
      }
      return { specPath, valid: true, findings: [] };
    } catch (error) {
      return { specPath, valid: false, findings: [finding('read-error', `Cannot validate spec ${specPath}: ${error.message}`, null, { severity: 'error' })] };
    }
  }));

  const snapshots = await Promise.all(preflight.map(async (check) => {
    if (!check.valid) {
      return {
        specPath: check.specPath,
        source: null,
        preflightFindings: check.findings,
        parsed: { valid: false, sections: [], findings: check.findings },
      };
    }
    try {
      const source = await readFile(check.specPath, 'utf8');
      return { specPath: check.specPath, source, preflightFindings: [], parsed: parseSpec(source) };
    } catch (error) {
      return { specPath: check.specPath, source: null, preflightFindings: [], parsed: { valid: false, sections: [], findings: [finding('read-error', `Cannot read spec ${check.specPath}: ${error.message}`, null, { severity: 'error' })] } };
    }
  }));

  const findings = [];
  const specs = [];
  for (const snapshot of snapshots) {
    const { specPath, parsed } = snapshot;
    const relativeSpec = slash(path.relative(rootAbsolute, specPath) || path.basename(specPath));
    const record = {
      path: specPath,
      relativePath: relativeSpec,
      directory: path.dirname(specPath),
      parsed,
      spec: parsed.spec ?? null,
      platform: parsed.platform ?? null,
      ownsText: entryTexts(parsed.owns || []),
      owns: [],
      canModify: [],
      writeScope: [],
      inheritedMust: [],
      must: entryTexts(parsed.must || []),
      inheritedMustNot: [],
      mustNot: entryTexts(parsed.mustNot || []),
    };
    record.governedDirectory = snapshot.preflightFindings?.length ? null : await governedDirectory(specPath, rootAbsolute);
    findings.push(...(snapshot.preflightFindings || []).map((item) => ({ ...item, spec: relativeSpec })));
    findings.push(...parsed.findings.map((item) => ({ ...item, spec: relativeSpec })));

    const candidates = [];
    for (const section of parsed.sections) {
      if (!PATH_SECTIONS.has(section.name)) continue;
      for (const entry of section.entries) {
        if (!entry.path) continue;
        const resolved = await resolveEntry({
          entry,
          section: section.name,
          specPath,
          root: rootAbsolute,
          rootReal,
          relativeToRoot: relativeSpec,
        });
        if (!resolved) continue;
        if (resolved.finding) findings.push({ ...resolved.finding, spec: relativeSpec });
        if (resolved.path) candidates.push({ ...resolved, spec: relativeSpec });
      }
    }
    record.paths = candidates;
    record.owns = dedupePaths(candidates.filter((item) => item.section === 'Owns'));
    const canModify = candidates.filter((item) => item.section === 'Can modify');
    const ownedPathSet = new Set(record.owns.map((item) => item.path));
    for (const item of canModify) {
      if (ownedPathSet.has(item.path)) {
        findings.push(finding('duplicate-scope-entry', `Path ${item.path} is repeated in Owns and Can modify.`, item.line, {
          severity: 'error', spec: relativeSpec, path: item.path,
        }));
      }
    }
    record.canModify = dedupePaths(canModify);
    record.writeScope = dedupePaths([...record.owns, ...canModify]);
    record.ownedPaths = record.owns.map((item) => item.path);
    record.canModifyPaths = record.canModify.map((item) => item.path);
    record.editablePaths = record.writeScope.map((item) => item.path);
    specs.push(record);
  }

  const ownership = specs.flatMap((spec) => spec.owns.map((item) => ({ ...item, owner: spec.relativePath })));
  for (let i = 0; i < ownership.length; i += 1) {
    for (let j = i + 1; j < ownership.length; j += 1) {
      const left = ownership[i];
      const right = ownership[j];
      if (left.owner !== right.owner && overlap(left.path, right.path)) {
        findings.push(finding('duplicate-ownership', `Owned paths overlap: ${left.path} and ${right.path}.`, null, {
          severity: 'error', path: left.path, paths: [left.path, right.path], specs: [left.owner, right.owner],
        }));
      }
    }
  }

  // Ancestor context is cumulative. The caller controls which specs belong
  // to this authorization snapshot; no filesystem discovery widens it.
  for (const child of specs) {
    const childDirectory = child.governedDirectory || path.dirname(path.resolve(rootAbsolute, child.relativePath));
    const ancestors = specs
      .filter((candidate) => candidate !== child && candidate.governedDirectory
        && (!child.governedDirectory || candidate.governedDirectory !== childDirectory)
        && isWithin(candidate.governedDirectory, childDirectory))
      .sort((a, b) => a.governedDirectory.length - b.governedDirectory.length);
    child.inheritedMust = ancestors.flatMap((ancestor) => entryTexts(ancestor.parsed.must || []).map((text) => ({ text, spec: ancestor.relativePath })));
    child.must = [...child.inheritedMust.map((item) => item.text), ...entryTexts(child.parsed.must || [])];
    child.inheritedMustNot = ancestors.flatMap((ancestor) => entryTexts(ancestor.parsed.mustNot || []).map((text) => ({ text, spec: ancestor.relativePath })));
    child.mustNot = [...child.inheritedMustNot.map((item) => item.text), ...entryTexts(child.parsed.mustNot || [])];
  }

  // This focused checker has no soft validation category. Every finding is a
  // blocker unless a future caller explicitly labels it as a warning.
  const errors = findings.filter((item) => item.severity !== 'warning');
  return {
    root: rootAbsolute,
    specs,
    ownership,
    writeScope: specs.flatMap((spec) => spec.writeScope.map((item) => ({ ...item, spec: spec.relativePath }))),
    ownedPaths: ownership.map((item) => item.path),
    editablePaths: specs.flatMap((spec) => spec.editablePaths),
    findings,
    ok: errors.length === 0,
    snapshot: true,
  };
}

function usage() {
  return 'Usage: node specdd.mjs inspect --root ROOT --spec path.sdd [--spec another.sdd]';
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] !== 'inspect') {
    console.error(usage());
    return 2;
  }
  let root = null;
  const specPaths = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) {
        console.error(`${arg} requires a value\n${usage()}`);
        return 2;
      }
      root = value;
    } else if (arg === '--spec') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) {
        console.error(`${arg} requires a value\n${usage()}`);
        return 2;
      }
      specPaths.push(value);
    }
    else if (arg.startsWith('--root=')) root = arg.slice('--root='.length);
    else if (arg.startsWith('--spec=')) specPaths.push(arg.slice('--spec='.length));
    else {
      console.error(`Unknown argument: ${arg}\n${usage()}`);
      return 2;
    }
  }
  if (!root || specPaths.length === 0) {
    console.error(usage());
    return 2;
  }
  const result = await inspectSpecs(root, specPaths);
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

export default { parseSpec, inspectSpecs, main };

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
