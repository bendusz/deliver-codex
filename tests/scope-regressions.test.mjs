import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { canonical, sha256 } from '../plugins/deliver/skills/deliver/scripts/lib/state.mjs';
import { captureGitAnchor, snapshot, compareSnapshots, inspectScope } from '../plugins/deliver/skills/deliver/scripts/lib/scope.mjs';

function legacyLocalGitMetadata(root, git) {
  const safe = (...args) => { try { return git(root, ...args); } catch { return ''; } };
  const gitDirRaw = safe('rev-parse', '--git-dir').replace(/(\r?\n)+$/, '');
  const gitDir = gitDirRaw ? path.resolve(root, gitDirRaw) : '';
  const commonDirRaw = safe('rev-parse', '--git-common-dir').replace(/(\r?\n)+$/, '');
  const commonDir = commonDirRaw ? path.resolve(root, commonDirRaw) : gitDir;
  const fileHash = (base, rel) => { try { return sha256(fs.readFileSync(path.join(base, rel))); } catch { return sha256(''); } };
  const hooks = [];
  try {
    for (const name of fs.readdirSync(path.join(commonDir, 'hooks')).sort()) {
      hooks.push(`${name}:${fileHash(commonDir, path.join('hooks', name))}`);
    }
  } catch {}
  return sha256(canonical({
    head: safe('rev-parse', '--verify', 'HEAD').trim() || 'UNBORN',
    ref: safe('symbolic-ref', '-q', 'HEAD').trim() || 'DETACHED',
    index: sha256(safe('diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv')),
    index_flags: sha256(safe('ls-files', '-s', '-v', '-z')),
    worktree_config: fileHash(gitDir, 'config.worktree'),
    common_config: fileHash(commonDir, 'config'),
    exclude: fileHash(commonDir, path.join('info', 'exclude')),
    hooks,
  }));
}

function legacySubmoduleBaseline(root, moduleRoot, git) {
  const current = snapshot(root, ['src']);
  const nestedMetadata = legacyLocalGitMetadata(moduleRoot, git);
  const rootMetadata = legacyLocalGitMetadata(root, git);
  const stage = git(root, 'ls-files', '--stage', '--', 'vendor/dependency').trim().split(/\s+/);
  const entries = { ...current.entries, 'vendor/dependency': `gitlink:${stage[1]}:${nestedMetadata}` };
  const gitMeta = sha256(canonical({ local: rootMetadata, submodules: { 'vendor/dependency': nestedMetadata } }));
  return { ...current, entries, git_meta: gitMeta, hash: sha256(canonical({ entries, git_meta: gitMeta })) };
}

function fixture(t) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-scope-regression-')));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' });
  const write = (root, rel, content) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };
  const repo = (name) => {
    const root = path.join(temporary, name);
    fs.mkdirSync(root);
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'user.email', 'test@example.invalid');
    write(root, 'src/value.txt', 'before');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'fixture');
    return root;
  };
  return { temporary, git, write, repo };
}

test('declared file, directory and nested symlink inputs fingerprint ignored referents', (t) => {
  const f = fixture(t);
  const root = f.repo('project');
  f.write(root, '.gitignore', 'cache/\ninput*\n');
  f.write(root, 'cache/value.txt', 'before');
  fs.symlinkSync('cache/value.txt', path.join(root, 'input.txt'));
  fs.symlinkSync('cache', path.join(root, 'inputs'));
  fs.mkdirSync(path.join(root, 'input-directory'));
  fs.symlinkSync('../cache/value.txt', path.join(root, 'input-directory/alias.txt'));
  for (const input of ['input.txt', 'inputs', 'input-directory', 'inputs/value.txt']) {
    f.write(root, 'cache/value.txt', 'before');
    const before = snapshot(root, [input]);
    f.write(root, 'cache/value.txt', 'after');
    const after = snapshot(root, [input]);
    assert.notEqual(after.hash, before.hash, input);
    assert.notEqual(after.entries['cache/value.txt'], before.entries['cache/value.txt']);
  }
});

test('read aliases cannot hide inputs in runtime state or outside the checkout', (t) => {
  const f = fixture(t);
  const root = f.repo('project');
  f.write(root, '.deliver/input', 'hidden');
  fs.symlinkSync('.deliver/input', path.join(root, 'input'));
  assert.throws(() => snapshot(root, ['input']), /outside code snapshot/);
  fs.unlinkSync(path.join(root, 'input'));
  f.write(f.temporary, 'outside.txt', 'outside');
  fs.symlinkSync('../outside.txt', path.join(root, 'input'));
  assert.throws(() => snapshot(root, ['input']), /outside code snapshot/);
});

test('sibling worktree creation and commits do not invalidate local scope or evidence', (t) => {
  const f = fixture(t);
  const root = f.repo('project');
  const before = snapshot(root);
  const sibling = path.join(f.temporary, 'sibling');
  f.git(root, 'worktree', 'add', '-b', 'sibling', sibling);
  f.git(sibling, 'commit', '--allow-empty', '-qm', 'independent progress');
  f.git(root, 'pack-refs', '--all');
  const after = snapshot(root);
  assert.equal(after.hash, before.hash);
  assert.equal(compareSnapshots(root, before, after, ['src']).ok, true);
  f.git(root, 'commit', '--allow-empty', '-qm', 'local unauthorized commit');
  assert.equal(compareSnapshots(root, after, snapshot(root), ['src']).git_metadata_changed, true);
});

test('shared configuration changes still invalidate a worktree baseline', (t) => {
  const f = fixture(t);
  const root = f.repo('project');
  const before = snapshot(root);
  f.git(root, 'config', 'core.fileMode', 'false');
  assert.equal(compareSnapshots(root, before, snapshot(root), ['src']).git_metadata_changed, true);
});

test('pre-anchor legacy metadata stays compatible and still detects Git drift recursively', (t) => {
  const f = fixture(t);
  const root = f.repo('project');
  const dependency = f.repo('dependency');
  f.git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', dependency, 'vendor/dependency');
  f.git(root, 'commit', '-am', 'submodule');
  const moduleRoot = path.join(root, 'vendor/dependency');
  const legacyBaseline = legacySubmoduleBaseline(root, moduleRoot, f.git);
  const state = {
    project_root: root,
    pm_binding: null,
    baseline: { snapshot: legacyBaseline, dirty_paths: [] },
    task: { packet: { touches: ['src'], read_paths: [], specs: [] } },
    contracts: null,
  };
  const compatible = inspectScope(state);
  assert.equal(compatible.report.ok, true);
  assert.equal(compatible.report.git_metadata_changed, false);
  assert.equal(compatible.report.git_metadata_compatibility, 'legacy-v1');
  assert.notEqual(compatible.current.hash, legacyBaseline.hash);

  f.git(root, 'commit', '--allow-empty', '-qm', 'unexpected head');
  assert.equal(inspectScope(state).report.git_metadata_changed, true);
  f.git(root, 'reset', '--hard', '-q', 'HEAD^');
  assert.equal(inspectScope(state).report.ok, true);

  f.git(moduleRoot, 'update-index', '--assume-unchanged', 'src/value.txt');
  assert.equal(inspectScope(state).report.git_metadata_changed, true);
  f.git(moduleRoot, 'update-index', '--no-assume-unchanged', 'src/value.txt');
  assert.equal(inspectScope(state).report.ok, true);

  const fileMode = f.git(root, 'config', '--get', 'core.filemode').trim();
  f.git(root, 'config', 'core.filemode', fileMode === 'true' ? 'false' : 'true');
  assert.equal(inspectScope(state).report.git_metadata_changed, true);
  f.git(root, 'config', 'core.filemode', fileMode);
  assert.equal(inspectScope(state).report.ok, true);
});

test('current anchors protect initialized submodule config, hooks and index flags under declared touches', (t) => {
  const f = fixture(t);
  const root = f.repo('project');
  const dependency = f.repo('dependency');
  f.git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', dependency, 'vendor/dependency');
  f.git(root, 'commit', '-am', 'submodule');
  const moduleRoot = path.join(root, 'vendor/dependency');
  f.write(moduleRoot, '.hooks/pre-commit', '#!/bin/sh\n');
  fs.chmodSync(path.join(moduleRoot, '.hooks/pre-commit'), 0o644);
  f.git(moduleRoot, 'config', 'core.hooksPath', '.hooks');
  const baseline = snapshot(root, ['vendor/dependency']);
  const anchor = captureGitAnchor(root);
  assert.ok(anchor.submodules?.['vendor/dependency']);
  const state = {
    project_root: root,
    pm_binding: null,
    baseline: { snapshot: baseline, dirty_paths: [] },
    git_anchor: anchor,
    task: { packet: { touches: ['vendor/dependency'], read_paths: [], specs: [] } },
    contracts: null,
  };
  assert.equal(inspectScope(state).report.ok, true);

  f.git(moduleRoot, 'config', 'deliver.fixture', 'changed');
  assert.equal(inspectScope(state).report.git_metadata_changed, true);
  f.git(moduleRoot, 'config', '--unset', 'deliver.fixture');
  assert.equal(inspectScope(state).report.ok, true);

  const addedHook = path.join(moduleRoot, '.hooks/post-commit');
  fs.writeFileSync(addedHook, '#!/bin/sh\n');
  assert.equal(inspectScope(state).report.git_metadata_changed, true);
  fs.unlinkSync(addedHook);
  assert.equal(inspectScope(state).report.ok, true);

  f.git(moduleRoot, 'update-index', '--assume-unchanged', 'src/value.txt');
  assert.equal(inspectScope(state).report.git_metadata_changed, true);
  f.git(moduleRoot, 'update-index', '--no-assume-unchanged', 'src/value.txt');
  assert.equal(inspectScope(state).report.ok, true);

  fs.chmodSync(path.join(moduleRoot, '.hooks/pre-commit'), 0o755);
  assert.equal(inspectScope(state).report.git_metadata_changed, true);
  fs.chmodSync(path.join(moduleRoot, '.hooks/pre-commit'), 0o644);
  assert.equal(inspectScope(state).report.ok, true);
});

test('flat current anchors upgrade only while nested metadata still matches baseline evidence', (t) => {
  const f = fixture(t);
  const root = f.repo('project');
  const dependency = f.repo('dependency');
  f.git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', dependency, 'vendor/dependency');
  f.git(root, 'commit', '-am', 'submodule');
  const baseline = snapshot(root, ['src']);
  const anchor = captureGitAnchor(root);
  delete anchor.submodules;
  delete anchor.metadata_version;
  const state = {
    project_root: root,
    pm_binding: null,
    baseline: { snapshot: baseline, dirty_paths: [] },
    git_anchor: anchor,
    task: { packet: { touches: ['src'], read_paths: [], specs: [] } },
    contracts: null,
  };
  const compatible = inspectScope(state);
  assert.equal(compatible.report.ok, true);
  assert.equal(compatible.report.git_anchor_compatibility, 'flat-v1');

  const moduleRoot = path.join(root, 'vendor/dependency');
  f.git(moduleRoot, 'config', 'deliver.fixture', 'changed');
  assert.equal(inspectScope(state).report.git_metadata_changed, true);
});

test('initialized submodules are fingerprinted with granular content and HEAD changes', (t) => {
  const f = fixture(t);
  const root = f.repo('project');
  const dependency = f.repo('dependency');
  f.git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', dependency, 'vendor/dependency');
  f.git(root, 'commit', '-am', 'submodule');
  const before = snapshot(root);
  assert.ok(before.entries['vendor/dependency'].startsWith('gitlink:'));
  assert.ok(before.entries['vendor/dependency/src/value.txt']);
  f.write(root, 'vendor/dependency/src/value.txt', 'after');
  const after = snapshot(root);
  assert.equal(compareSnapshots(root, before, after, ['src']).ok, false);
  assert.equal(compareSnapshots(root, before, after, ['vendor/dependency/src']).ok, true);
  f.git(path.join(root, 'vendor/dependency'), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-am', 'changed dependency');
  assert.notEqual(snapshot(root).entries['vendor/dependency'], after.entries['vendor/dependency']);
  assert.equal(compareSnapshots(root, after, snapshot(root), ['vendor/dependency']).git_metadata_changed, true);
});

test('ignored declared inputs inside a submodule participate in its snapshot', (t) => {
  const f = fixture(t);
  const root = f.repo('project');
  const dependency = f.repo('dependency');
  f.git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', dependency, 'vendor/dependency');
  f.write(root, 'vendor/dependency/.gitignore', 'cache/\n');
  f.write(root, 'vendor/dependency/cache/input.txt', 'before');
  const before = snapshot(root, ['vendor/dependency/cache/input.txt']);
  f.write(root, 'vendor/dependency/cache/input.txt', 'after');
  assert.notEqual(snapshot(root, ['vendor/dependency/cache/input.txt']).hash, before.hash);
});
