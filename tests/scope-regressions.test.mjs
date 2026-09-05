import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { snapshot, compareSnapshots } from '../plugins/deliver/skills/deliver/scripts/lib/scope.mjs';

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
