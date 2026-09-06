import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sha256, canonical, DeliverError } from './state.mjs';
import { changedContracts } from './contracts.mjs';
import { assertPmBinding } from './pm.mjs';

const toPosix = (value) => value.split(path.sep).join('/');
const hasControl = (value) => /[\x00-\x1f\x7f]/.test(value);
const isInside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

export function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, windowsHide: true });
}

export function gitRoot(cwd) {
  try { return fs.realpathSync(git(cwd, ['rev-parse', '--show-toplevel']).replace(/(\r?\n)+$/, '')); }
  catch { throw new DeliverError('Deliver must run inside a Git worktree', 66); }
}

function listZ(root, args) {
  return git(root, args).split('\0').filter(Boolean).map(toPosix);
}

function fingerprint(root, rel) {
  const abs = path.join(root, rel);
  let stat;
  try { stat = fs.lstatSync(abs); } catch { return null; }
  if (stat.isSymbolicLink()) return `symlink:${sha256(fs.readlinkSync(abs))}`;
  if (stat.isFile()) return `file:${stat.mode & 0o100 ? '755' : '644'}:${sha256(fs.readFileSync(abs))}`;
  throw new DeliverError(`unsupported repository path type: ${rel}`, 74);
}

function gitMetadata(root) {
  const safe = (args) => { try { return git(root, args); } catch { return ''; } };
  const gitDirRaw = safe(['rev-parse', '--git-dir']).replace(/(\r?\n)+$/, '');
  const gitDir = gitDirRaw ? path.resolve(root, gitDirRaw) : '';
  const commonDirRaw = safe(['rev-parse', '--git-common-dir']).replace(/(\r?\n)+$/, '');
  const commonDir = commonDirRaw ? path.resolve(root, commonDirRaw) : gitDir;
  const fileHash = (base, rel) => { try { return sha256(fs.readFileSync(path.join(base, rel))); } catch { return sha256(''); } };
  const hooks = [];
  try {
    for (const name of fs.readdirSync(path.join(commonDir, 'hooks')).sort()) hooks.push(`${name}:${fileHash(commonDir, path.join('hooks', name))}`);
  } catch {}
  return sha256(canonical({
    head: safe(['rev-parse', '--verify', 'HEAD']).trim() || 'UNBORN',
    ref: safe(['symbolic-ref', '-q', 'HEAD']).trim() || 'DETACHED',
    index: sha256(safe(['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv'])),
    index_flags: sha256(safe(['ls-files', '-s', '-v', '-z'])),
    worktree_config: fileHash(gitDir, 'config.worktree'),
    common_config: fileHash(commonDir, 'config'),
    exclude: fileHash(commonDir, path.join('info', 'exclude')),
    hooks,
    // Other branches and worktrees can advance independently. Protect this
    // checkout's HEAD/index and shared configuration, not unrelated refs.
  }));
}

const protectedIgnored = (rel) => /(^|\/)(?:AGENTS|CLAUDE)\.md$/.test(rel)
  || /(^|\/)\.(?:agents|codex)(?:\/|$)/.test(rel)
  || rel.endsWith('.sdd') || /(^|\/)\.specdd(?:\/|$)/.test(rel)
  || /(^|\/)(?:config|configs|contract|contracts)(?:[./]|$)/.test(rel);

const covers = (scope, rel) => scope === '.' || rel === scope || rel.startsWith(`${scope}/`);

function resolvedInputs(root, paths) {
  const result = new Set(paths);
  const visited = new Set();
  function visit(abs) {
    let stat;
    try { stat = fs.lstatSync(abs); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    const real = fs.realpathSync(abs);
    const rel = toPosix(path.relative(root, real)) || '.';
    if (!isInside(root, real) || /^(?:\.git|\.deliver)(?:\/|$)/.test(rel)) {
      throw new DeliverError(`declared input resolves outside code snapshot: ${abs}`, 74);
    }
    if (stat.isSymbolicLink() || abs !== real) result.add(rel);
    if (visited.has(real)) return;
    visited.add(real);
    if (fs.statSync(real).isDirectory()) {
      for (const name of fs.readdirSync(real)) {
        if (name === '.git' || name === '.deliver') continue;
        visit(path.join(real, name));
      }
    }
  }
  for (const rel of paths) visit(path.join(root, rel));
  return [...result];
}

export function snapshot(root, relevantPaths = []) {
  root = fs.realpathSync(root);
  relevantPaths = resolvedInputs(root, relevantPaths);
  const gitlinks = new Map(listZ(root, ['ls-files', '--stage', '-z']).flatMap((record) => {
    const match = /^160000 ([0-9a-f]+) [0-3]\t(.+)$/.exec(record);
    return match ? [[match[2], match[1]]] : [];
  }));
  const authoritative = new Set([
    ...listZ(root, ['ls-files', '-z']),
    ...listZ(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const ignored = listZ(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])
    .filter((rel) => !rel.startsWith('.deliver/'));
  for (const rel of ignored) if (protectedIgnored(rel) || relevantPaths.some((scope) => covers(scope, rel))) authoritative.add(rel);
  const entries = Object.create(null);
  const submoduleMetadata = Object.create(null);
  for (const rel of [...authoritative].sort()) {
    if (rel.startsWith('.deliver/')) continue;
    if (hasControl(rel)) throw new DeliverError(`unsupported control character in path: ${JSON.stringify(rel)}`, 74);
    if (gitlinks.has(rel) && fs.existsSync(path.join(root, rel)) && fs.lstatSync(path.join(root, rel)).isDirectory()) {
      const moduleRoot = fs.realpathSync(path.join(root, rel));
      const initialized = gitRoot(moduleRoot) === moduleRoot;
      if (!initialized) {
        if (fs.readdirSync(moduleRoot).length) throw new DeliverError(`uninitialized submodule contains files: ${rel}`, 74);
        entries[rel] = `gitlink:${gitlinks.get(rel)}:uninitialized`;
        continue;
      }
      const moduleInputs = relevantPaths.flatMap((scope) => covers(scope, rel) ? ['.'] : covers(rel, scope) ? [scope.slice(rel.length + 1)] : []);
      const nested = snapshot(moduleRoot, moduleInputs);
      submoduleMetadata[rel] = nested.git_meta;
      entries[rel] = `gitlink:${gitlinks.get(rel)}:${nested.git_meta}`;
      for (const [file, value] of Object.entries(nested.entries)) entries[`${rel}/${file}`] = value;
      continue;
    }
    const value = fingerprint(root, rel);
    if (value !== null) entries[rel] = value;
  }
  const ignoredAdvisory = Object.create(null);
  for (const rel of ignored.sort()) {
    if (authoritative.has(rel)) continue;
    try {
      const stat = fs.lstatSync(path.join(root, rel));
      ignoredAdvisory[rel] = { size: stat.size, mtime_ms: Math.trunc(stat.mtimeMs), kind: stat.isSymbolicLink() ? 'symlink' : 'file' };
    } catch {}
  }
  const localMetadata = gitMetadata(root);
  const gitMeta = gitlinks.size ? sha256(canonical({ local: localMetadata, submodules: submoduleMetadata })) : localMetadata;
  return { entries, git_meta: gitMeta, ignored_advisory: ignoredAdvisory, hash: sha256(canonical({ entries, git_meta: gitMeta })) };
}

export function baselineDirtyPaths(root) {
  const out = listZ(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const paths = [];
  for (let i = 0; i < out.length; i++) {
    const record = out[i];
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const rel = record.slice(3);
    paths.push(rel);
    if ((status[0] === 'R' || status[0] === 'C') && out[i + 1]) paths.push(out[++i]);
  }
  return [...new Set(paths.filter((rel) => !rel.startsWith('.deliver/')))].sort();
}

function validateRelativePath(root, raw, kind) {
  if (typeof raw !== 'string' || raw === '' || path.isAbsolute(raw) || hasControl(raw)) throw new DeliverError(`invalid ${kind} path: ${JSON.stringify(raw)}`, 66);
  const rel = toPosix(path.posix.normalize(toPosix(raw).replace(/\/$/, '')));
  if (rel === '.' || rel === '..' || rel.startsWith('../') || /[*?\[\]{}<>]/.test(rel)) throw new DeliverError(`invalid ${kind} path: ${raw}`, 66);
  if (rel === '.git' || rel.startsWith('.git/') || rel === '.deliver' || rel.startsWith('.deliver/')) throw new DeliverError(`${kind} may not grant ${rel}`, 66);
  const segments = rel.split('/');
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try { stat = fs.lstatSync(current); } catch { break; }
    if (stat.isSymbolicLink()) {
      if (kind === 'touches') throw new DeliverError(`touches may not traverse a symlink: ${rel}`, 66);
      let resolved;
      try { resolved = fs.realpathSync(current); } catch { throw new DeliverError(`${kind} crosses a broken symlink: ${rel}`, 66); }
      const inside = isInside(root, resolved);
      if (!inside) throw new DeliverError(`${kind} escapes the worktree through a symlink: ${rel}`, 66);
      current = resolved;
    }
  }
  return rel;
}

export function validateTaskPaths(root, packet) {
  packet.touches = [...new Set(packet.touches.map((value) => validateRelativePath(root, value, 'touches')))].sort();
  packet.read_paths = [...new Set(packet.read_paths.map((value) => validateRelativePath(root, value, 'read_paths')))].sort();
  packet.specs = [...new Set(packet.specs.map((value) => validateRelativePath(root, value, 'specs')))].sort();
  for (const touch of packet.touches) assertNoEscapingSymlinks(root, touch);
  return packet;
}

function assertNoEscapingSymlinks(root, rel) {
  const abs = path.join(root, rel);
  let stat;
  try { stat = fs.lstatSync(abs); } catch { return; }
  if (stat.isSymbolicLink()) {
    throw new DeliverError(`touches contains a symlink; use an explicit non-aliased scope: ${rel}`, 66);
  }
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (rel === '.' && (entry.name === '.git' || entry.name === '.deliver')) continue;
    assertNoEscapingSymlinks(root, `${rel}/${entry.name}`.replace(/^\.\//, ''));
  }
}

const allowed = (rel, touches) => touches.some((scope) => rel === scope || rel.startsWith(`${scope}/`));

function symlinkEscapes(root, rel) {
  let stat;
  try { stat = fs.lstatSync(path.join(root, rel)); } catch { return false; }
  if (!stat.isSymbolicLink()) return false;
  const target = path.resolve(path.dirname(path.join(root, rel)), fs.readlinkSync(path.join(root, rel)));
  return !isInside(root, target);
}

export function compareSnapshots(root, baseline, current, touches, dirtyAtStart = []) {
  const before = baseline.entries;
  const after = current.entries;
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((rel) => before[rel] !== after[rel]).sort();
  const deleted = changed.filter((rel) => Object.hasOwn(before, rel) && !Object.hasOwn(after, rel));
  const added = changed.filter((rel) => !Object.hasOwn(before, rel) && Object.hasOwn(after, rel));
  const renames = [];
  const used = new Set();
  for (const from of deleted) {
    const to = added.find((candidate) => !used.has(candidate) && before[from] === after[candidate]);
    if (to) { used.add(to); renames.push({ from, to }); }
  }
  const outOfScope = changed.filter((rel) => !allowed(rel, touches));
  const preexistingDirtyChanged = changed.filter((rel) => dirtyAtStart.some((dirty) => covers(dirty, rel)));
  const symlinkEscapesFound = changed.filter((rel) => symlinkEscapes(root, rel));
  const gitChanged = baseline.git_meta !== current.git_meta;
  const ignoredAdvisoryChanged = [...new Set([
    ...Object.keys(baseline.ignored_advisory || {}),
    ...Object.keys(current.ignored_advisory || {}),
  ])].filter((rel) => canonical(baseline.ignored_advisory?.[rel]) !== canonical(current.ignored_advisory?.[rel])).sort();
  return {
    ok: outOfScope.length === 0 && preexistingDirtyChanged.length === 0 && symlinkEscapesFound.length === 0 && !gitChanged,
    changed,
    added,
    deleted,
    renames,
    out_of_scope: outOfScope,
    preexisting_dirty_changed: preexistingDirtyChanged,
    symlink_escapes: symlinkEscapesFound,
    git_metadata_changed: gitChanged,
    ignored_advisory_changed: ignoredAdvisoryChanged,
  };
}

export function inspectScope(state) {
  assertPmBinding(state);
  if (!state.baseline || !state.task) throw new DeliverError('task has no baseline; run start first', 66);
  validateTaskPaths(state.project_root, state.task.packet);
  const current = snapshot(state.project_root, [...state.task.packet.touches, ...state.task.packet.read_paths, ...state.task.packet.specs]);
  const report = compareSnapshots(state.project_root, state.baseline.snapshot, current, state.task.packet.touches, state.baseline.dirty_paths);
  report.contracts_changed = [...new Set([...changedContracts(state), ...(state.contracts
    ? report.changed.filter((rel) => rel.endsWith('.sdd') || /(^|\/)\.specdd(?:\/|$)/.test(rel)) : [])])].sort();
  if (report.contracts_changed.length) report.ok = false;
  return { current, report };
}
