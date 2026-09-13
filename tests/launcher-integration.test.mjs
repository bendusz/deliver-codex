import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { buildLaunchArgs } from '../bin/deliver.mjs';

const launcher = fileURLToPath(new URL('../bin/deliver.mjs', import.meta.url));

function fakeLaunchFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'deliver-fake-launch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const fakeBin = path.join(root, 'bin');
  const output = path.join(root, 'argv.json');
  const configPath = path.join(project, '.codex/config.toml');
  const config = 'model = "user-selected-model"\n';
  mkdirSync(path.join(project, '.agents/skills/deliver'), { recursive: true });
  mkdirSync(path.dirname(configPath), { recursive: true });
  mkdirSync(fakeBin);
  writeFileSync(path.join(project, '.agents/skills/deliver/SKILL.md'), '# Deliver\n');
  writeFileSync(configPath, config);
  writeFileSync(
    path.join(fakeBin, 'codex'),
    "#!/usr/bin/env node\nawait import('node:fs').then(({writeFileSync}) => writeFileSync(process.env.DELIVER_ARGV_OUT, JSON.stringify(process.argv.slice(2))))\n",
  );
  chmodSync(path.join(fakeBin, 'codex'), 0o755);
  const run = (...args) => spawnSync(process.execPath, [launcher, '--project', project, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}`, DELIVER_ARGV_OUT: output },
  });
  return { config, configPath, output, run };
}

function optionValue(argv, option) {
  const index = argv.indexOf(option);
  assert.notEqual(index, -1, `${option} was not passed`);
  return argv[index + 1];
}

test('launcher defaults to danger-full-access without approval prompts', (t) => {
  const { config, configPath, output, run } = fakeLaunchFixture(t);
  const result = run('implement the approved task');
  assert.equal(result.status, 0, result.stderr);
  const argv = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(optionValue(argv, '--sandbox'), 'danger-full-access');
  assert.equal(optionValue(argv, '--ask-for-approval'), 'never');
  assert.equal(readFileSync(configPath, 'utf8'), config);
});

test('launcher propagates an explicit sandbox as one argv value', (t) => {
  const { output, run } = fakeLaunchFixture(t);
  const result = run('--sandbox', 'read-only', 'review the approved task');
  assert.equal(result.status, 0, result.stderr);
  const argv = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(optionValue(argv, '--sandbox'), 'read-only');
  assert.equal(optionValue(argv, '--ask-for-approval'), 'on-request');
});

test('launcher rejects missing, invalid, and duplicate sandbox options', (t) => {
  const { run } = fakeLaunchFixture(t);
  const missing = run('--sandbox');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--sandbox requires a value/);
  const invalid = run('--sandbox', 'unrestricted');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Invalid sandbox mode/);
  const duplicate = run('--sandbox', 'read-only', '--sandbox', 'workspace-write');
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /Duplicate launch option: --sandbox/);
});

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
  assert.match(dry.stdout, /danger-full-access/);
  assert.match(dry.stdout, /--ask-for-approval/);
  assert.match(dry.stdout, /never/);
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
