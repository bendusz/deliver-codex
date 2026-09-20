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

function gitDirectories(root) {
  const safe = (args) => { try { return git(root, args); } catch { return ''; } };
  const gitDirRaw = safe(['rev-parse', '--git-dir']).replace(/(\r?\n)+$/, '');
  const gitDir = gitDirRaw ? path.resolve(root, gitDirRaw) : '';
  const commonDirRaw = safe(['rev-parse', '--git-common-dir']).replace(/(\r?\n)+$/, '');
  const commonDir = commonDirRaw ? path.resolve(root, commonDirRaw) : gitDir;
  return { safe, gitDir, commonDir };
}

function legacyProtectedGitMetadata(root) {
  const { gitDir, commonDir } = gitDirectories(root);
  const fileHash = (base, rel) => { try { return sha256(fs.readFileSync(path.join(base, rel))); } catch { return sha256(''); } };
  const hooks = [];
  try {
    for (const name of fs.readdirSync(path.join(commonDir, 'hooks')).sort()) hooks.push(`${name}:${fileHash(commonDir, path.join('hooks', name))}`);
  } catch {}
  return sha256(canonical({
    worktree_config: fileHash(gitDir, 'config.worktree'),
    common_config: fileHash(commonDir, 'config'),
    exclude: fileHash(commonDir, path.join('info', 'exclude')),
    hooks,
  }));
}

function effectiveHooks(root) {
  const { gitDir, commonDir } = gitDirectories(root);
  let configured = '';
  try { configured = git(root, ['config', '--path', '--get', 'core.hooksPath']).trim(); } catch {}
  const location = configured ? path.resolve(root, configured) : path.join(commonDir, 'hooks');
  const limit = 8 * 1024 * 1024;
  const result = { configured: configured || null, path: location, kind: 'missing', entries: [] };
  let locationStat;
  try { locationStat = fs.lstatSync(location); } catch (error) {
    if (error.code === 'ENOENT') return { result, active: false, upgrade_safe: true };
    throw new DeliverError(`cannot inspect effective Git hooks path: ${error.message}`, 66);
  }
  let directory = location;
  if (locationStat.isSymbolicLink()) {
    result.kind = 'symlink';
    result.target = fs.readlinkSync(location);
    try { directory = fs.realpathSync(location); } catch { throw new DeliverError('effective Git hooks path is a broken symlink', 66); }
    const resolved = fs.statSync(directory);
    if (!resolved.isDirectory()) throw new DeliverError('effective Git hooks path symlink must resolve to a directory', 66);
  } else if (locationStat.isDirectory()) {
    result.kind = 'directory';
  } else {
    throw new DeliverError('effective Git hooks path must be a directory or directory symlink', 66);
  }
  const names = fs.readdirSync(directory).sort();
  if (names.length > 1024) throw new DeliverError('effective Git hooks path has too many entries', 66);
  let total = 0;
  let active = false;
  for (const name of names) {
    if (hasControl(name)) throw new DeliverError('effective Git hooks path contains an unsafe entry name', 66);
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    const mode = stat.mode & 0o777;
    if (stat.isFile()) {
      if (stat.size > limit || total + stat.size > 32 * 1024 * 1024) throw new DeliverError('effective Git hooks exceed the protected metadata limit', 66);
      total += stat.size;
      result.entries.push({ name, kind: 'file', mode, hash: sha256(fs.readFileSync(file)) });
      if (!name.endsWith('.sample') && (mode & 0o111) !== 0) active = true;
      continue;
    }
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(file);
      const entry = { name, kind: 'symlink', mode, target };
      let resolved;
      try { resolved = fs.statSync(file); } catch { throw new DeliverError(`effective Git hook is a broken symlink: ${name}`, 66); }
      if (!resolved.isFile() || resolved.size > limit || total + resolved.size > 32 * 1024 * 1024) {
        throw new DeliverError(`effective Git hook symlink has an unsafe target: ${name}`, 66);
      }
      total += resolved.size;
      entry.target_mode = resolved.mode & 0o777;
      entry.target_hash = sha256(fs.readFileSync(file));
      result.entries.push(entry);
      if (!name.endsWith('.sample') && (entry.target_mode & 0o111) !== 0) active = true;
      continue;
    }
    throw new DeliverError(`effective Git hooks path contains a nonregular entry: ${name}`, 66);
  }
  return { result, active, upgrade_safe: !active };
}

export function protectedGitMetadata(root) {
  const { gitDir, commonDir } = gitDirectories(root);
  const fileHash = (base, rel) => { try { return sha256(fs.readFileSync(path.join(base, rel))); } catch { return sha256(''); } };
  return sha256(canonical({
    worktree_config: fileHash(gitDir, 'config.worktree'),
    common_config: fileHash(commonDir, 'config'),
    exclude: fileHash(commonDir, path.join('info', 'exclude')),
    hooks: effectiveHooks(root).result,
  }));
}

function initializedSubmodules(root) {
  const modules = [];
  for (const record of listZ(root, ['ls-files', '--stage', '-z'])) {
    const match = /^160000 [0-9a-f]+ [0-3]\t(.+)$/.exec(record);
    if (!match) continue;
    const rel = match[1];
    const candidate = path.join(root, rel);
    let stat;
    try { stat = fs.lstatSync(candidate); } catch { continue; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    const moduleRoot = fs.realpathSync(candidate);
    try {
      if (gitRoot(moduleRoot) === moduleRoot) modules.push({ rel, root: moduleRoot });
    } catch {}
  }
  return modules.sort((left, right) => left.rel.localeCompare(right.rel));
}

function captureNestedGitAnchor(root) {
  const anchor = {
    metadata_version: 'protected-v2',
    head: git(root, ['rev-parse', '--verify', 'HEAD']).trim(),
    tree: git(root, ['rev-parse', 'HEAD^{tree}']).trim(),
    index_tree: git(root, ['write-tree']).trim(),
    index_flags: sha256(git(root, ['ls-files', '-v', '-z'])),
    protected_hash: protectedGitMetadata(root),
  };
  if (!anchor.head || !anchor.tree || !anchor.index_tree) throw new Error('unborn nested repository');
  const submodules = Object.fromEntries(initializedSubmodules(root)
    .map((module) => [module.rel, captureNestedGitAnchor(module.root)]));
  if (Object.keys(submodules).length) anchor.submodules = submodules;
  return anchor;
}

export function captureGitAnchor(root) {
  try {
    const head = git(root, ['rev-parse', '--verify', 'HEAD']).trim();
    const ref = git(root, ['symbolic-ref', '-q', 'HEAD']).trim();
    const tree = git(root, ['rev-parse', 'HEAD^{tree}']).trim();
    const indexTree = git(root, ['write-tree']).trim();
    if (!head || !ref.startsWith('refs/heads/') || !tree || !indexTree) throw new Error('unborn or detached HEAD');
    const anchor = {
      metadata_version: 'protected-v2',
      head,
      ref,
      tree,
      index_tree: indexTree,
      index_flags: sha256(git(root, ['ls-files', '-v', '-z'])),
      protected_hash: protectedGitMetadata(root),
    };
    const submodules = Object.fromEntries(initializedSubmodules(root)
      .map((module) => [module.rel, captureNestedGitAnchor(module.root)]));
    if (Object.keys(submodules).length) anchor.submodules = submodules;
    return anchor;
  } catch (error) {
    if (error instanceof DeliverError) throw error;
    throw new DeliverError(`cannot capture protected Git anchor: ${error.message}`, 66);
  }
}

export function legacyAnchorUpgradeSafe(root) {
  if (!effectiveHooks(root).upgrade_safe) return false;
  return initializedSubmodules(root).every((module) => legacyAnchorUpgradeSafe(module.root));
}

function rootAnchor(anchor) {
  const { submodules: _submodules, ...root } = anchor;
  return root;
}

function protectedV1Compatible(root, stored, current) {
  if (stored.metadata_version !== undefined) return false;
  const { metadata_version: _version, ...currentV1Shape } = current;
  if (canonical(stored) === canonical(currentV1Shape)) return true;
  if (!legacyAnchorUpgradeSafe(root) || stored.protected_hash !== legacyProtectedGitMetadata(root)) return false;
  return canonical({ ...stored, protected_hash: current.protected_hash }) === canonical(currentV1Shape);
}

function nestedMetadata(entries) {
  const result = Object.create(null);
  for (const [rel, value] of Object.entries(entries)) {
    const match = /^gitlink:[0-9a-f]+:([0-9a-f]{64})$/.exec(value);
    if (match) result[rel] = match[1];
  }
  return result;
}

function gitMetadata(root) {
  const { safe } = gitDirectories(root);
  return sha256(canonical({
    head: safe(['rev-parse', '--verify', 'HEAD']).trim() || 'UNBORN',
    ref: safe(['symbolic-ref', '-q', 'HEAD']).trim() || 'DETACHED',
    tree: safe(['rev-parse', 'HEAD^{tree}']).trim(),
    index_tree: safe(['write-tree']).trim(),
    index_flags: sha256(safe(['ls-files', '-v', '-z'])),
    protected_hash: protectedGitMetadata(root),
    index: sha256(safe(['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv'])),
    // Other branches and worktrees can advance independently. Protect this
    // checkout's HEAD/index and shared configuration, not unrelated refs.
  }));
}

function legacyGitMetadataV1(root) {
  const { safe, gitDir, commonDir } = gitDirectories(root);
  const fileHash = (base, rel) => { try { return sha256(fs.readFileSync(path.join(base, rel))); } catch { return sha256(''); } };
  const hooks = [];
  try {
    for (const name of fs.readdirSync(path.join(commonDir, 'hooks')).sort()) {
      hooks.push(`${name}:${fileHash(commonDir, path.join('hooks', name))}`);
    }
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

function snapshotVersion(root, relevantPaths, metadataVersion) {
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
      const nested = snapshotVersion(moduleRoot, moduleInputs, metadataVersion);
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
  const localMetadata = metadataVersion === 'legacy-v1' ? legacyGitMetadataV1(root) : gitMetadata(root);
  const gitMeta = gitlinks.size ? sha256(canonical({ local: localMetadata, submodules: submoduleMetadata })) : localMetadata;
  return { entries, git_meta: gitMeta, ignored_advisory: ignoredAdvisory, hash: sha256(canonical({ entries, git_meta: gitMeta })) };
}

export function snapshot(root, relevantPaths = []) {
  return snapshotVersion(root, relevantPaths, 'current');
}

function legacySnapshotV1(root, relevantPaths = []) {
  return snapshotVersion(root, relevantPaths, 'legacy-v1');
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

export function compareSnapshots(root, baseline, current, touches, dirtyAtStart = [], { ignoreGitMetadata = false } = {}) {
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
  const gitChanged = !ignoreGitMetadata && baseline.git_meta !== current.git_meta;
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

export function inspectScope(state, { allowPendingAdoption = false, ignoreGitAnchor = false } = {}) {
  assertPmBinding(state);
  if (!state.baseline || !state.task) throw new DeliverError('task has no baseline; run start first', 66);
  if (state.commit_adoption?.pending && !allowPendingAdoption) throw new DeliverError('commit adoption is pending; commit or reconcile it before continuing', 66);
  validateTaskPaths(state.project_root, state.task.packet);
  const relevantPaths = [...state.task.packet.touches, ...state.task.packet.read_paths, ...state.task.packet.specs];
  const current = snapshot(state.project_root, relevantPaths);
  const baselineForComparison = state.baseline.snapshot;
  let currentForComparison = current;
  let metadataCompatibility = null;
  if (state.baseline_metadata_version === 'legacy-v1') {
    currentForComparison = legacySnapshotV1(state.project_root, relevantPaths);
    metadataCompatibility = 'legacy-v1';
  } else if (!state.git_anchor && baselineForComparison.git_meta !== current.git_meta) {
    const legacyCurrent = legacySnapshotV1(state.project_root, relevantPaths);
    if (baselineForComparison.git_meta === legacyCurrent.git_meta) {
      currentForComparison = legacyCurrent;
      metadataCompatibility = 'legacy-v1';
    }
  }
  let coordinatorExecutionChanged = null;
  if (state.execution_audit) {
    const audit = state.execution_audit;
    if (baselineForComparison.entries[audit.story_path] !== audit.original_entry
      || current.entries[audit.story_path] !== audit.current_entry) {
      throw new DeliverError('audited Execution entry does not match the original baseline or current story', 66);
    }
    const entries = { ...currentForComparison.entries };
    if (audit.original_entry === null) delete entries[audit.story_path];
    else entries[audit.story_path] = audit.original_entry;
    currentForComparison = { ...currentForComparison, entries };
    coordinatorExecutionChanged = audit.story_path;
  }
  const report = compareSnapshots(state.project_root, baselineForComparison, currentForComparison,
    state.task.packet.touches, state.baseline.dirty_paths, { ignoreGitMetadata: Boolean(state.git_anchor) });
  if (state.git_anchor && !ignoreGitAnchor) {
    const anchor = captureGitAnchor(state.project_root);
    const exact = canonical(anchor) === canonical(state.git_anchor);
    const protectedCompatible = !exact && protectedV1Compatible(state.project_root, state.git_anchor, anchor);
    const flatRoot = rootAnchor(anchor);
    const flatRootCompatible = canonical(flatRoot) === canonical(state.git_anchor)
      || protectedV1Compatible(state.project_root, state.git_anchor, flatRoot);
    const flatCompatible = !exact && !protectedCompatible && state.git_anchor.submodules === undefined
      && anchor.submodules !== undefined
      && flatRootCompatible
      && canonical(nestedMetadata(baselineForComparison.entries)) === canonical(nestedMetadata(currentForComparison.entries))
      && legacyAnchorUpgradeSafe(state.project_root);
    report.git_metadata_changed = !exact && !protectedCompatible && !flatCompatible;
    if (protectedCompatible) report.git_anchor_compatibility = 'protected-v1';
    if (flatCompatible) report.git_anchor_compatibility = 'flat-v1';
    if (report.git_metadata_changed) report.ok = false;
  }
  report.coordinator_execution_changed = coordinatorExecutionChanged;
  report.git_metadata_compatibility = metadataCompatibility;
  report.contracts_changed = [...new Set([...changedContracts(state), ...(state.contracts
    ? report.changed.filter((rel) => rel.endsWith('.sdd') || /(^|\/)\.specdd(?:\/|$)/.test(rel)) : [])])].sort();
  if (report.contracts_changed.length) report.ok = false;
  return { current, report };
}
