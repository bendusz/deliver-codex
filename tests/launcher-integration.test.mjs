import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { buildLaunchArgs } from '../bin/deliver.mjs';

const launcher = fileURLToPath(new URL('../bin/deliver.mjs', import.meta.url));
test('actual setup CLI installs the complete bundled skill and preserves configuration', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'deliver-cli-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, '.codex'));
  const config = 'model = "user-selected-model"\n';
  writeFileSync(path.join(root, '.codex/config.toml'), config);
  const run = (...args) => spawnSync(process.execPath, [launcher, ...args], { encoding: 'utf8' });
  const installed = run('setup', '--project', root);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(readFileSync(path.join(root, '.agents/skills/deliver/SKILL.md'), 'utf8'), /name: deliver/);
  assert.match(readFileSync(path.join(root, '.codex/agents/deliver-builder.toml'), 'utf8'), /gpt-5.6-sol/);
  assert.equal(readFileSync(path.join(root, '.codex/config.toml'), 'utf8'), config);
  const dry = run('--project', root, '--dry-run', 'implement the approved task');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /gpt-6-astra/);
  const again = run('setup', '--project', root);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Created 0/);
});

test('invalid model and reasoning configuration cannot be injected', () => {
  assert.throws(() => buildLaunchArgs({ projectDir: '/tmp', effort: 'high"\nother="x' }), /Invalid reasoning/);
  assert.throws(() => buildLaunchArgs({ projectDir: '/tmp', model: '--yolo' }), /Invalid model/);
});

test('npm-style symlinked bin invocation still enters the launcher', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX npm bin symlink');
  const root = mkdtempSync(path.join(tmpdir(), 'deliver-bin-link-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const link = path.join(root, 'deliver');
  symlinkSync(launcher, link);
  const result = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /deliver setup/);
});
