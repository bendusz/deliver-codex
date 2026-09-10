import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { setupProject } from '../bin/deliver.mjs';

const sourceRoles = fileURLToPath(new URL('../plugins/deliver/skills/deliver/assets/codex-agents/', import.meta.url));
const temporaryRoots = [];
const protectedInstructionHashes = Object.freeze({
  'deliver-architecture': '98e9e830aaa4960e2b81c6cab7bca37b5459a59cc3d17cd74b8ed743991a2cf1',
  'deliver-debugger': 'e833df8270eedf46f557d082ba5e7524f29c589df2476c130f2199e8ccafef70',
  'deliver-explorer': 'ccc928a2669f56fe8069a9ec39f1dd9c076f9ba150b18ace3a92de6a042e6ac7',
  'deliver-researcher': '3b8a5385a7d0d616782b6433b36b449c9c442e3d7d578e7f1e1dd65a49585c29',
  'deliver-reviewer': 'ddc8c40173271d9c6764ffe1f3634f043953ba1b5002e12fc6720057c6fde625',
  'deliver-security': '66d0687badd30189f13f8b2c8694c03683df7253a771df9d9be08b7a0990d551',
  'deliver-verifier': 'dfc2c147aa31284d0191e0df1c726dd1b079c71e0f06fb32a97fe6fab569eabd',
});

after(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
});

function roleNames(directory) {
  return fs.readdirSync(directory).filter((name) => name.endsWith('.toml')).sort();
}

function readRole(directory, name) {
  return fs.readFileSync(path.join(directory, `${name}.toml`), 'utf8');
}

function roleHeader(text) {
  const marker = "developer_instructions = '''";
  const index = text.indexOf(marker);
  assert(index >= 0, 'role has no developer instructions');
  return text.slice(0, index);
}

function instructionHash(text) {
  const instructions = text.slice(text.indexOf("developer_instructions = '''"));
  return crypto.createHash('sha256').update(instructions).digest('hex');
}

test('all source roles inherit session sandbox policy and protected duties are unchanged', () => {
  const names = roleNames(sourceRoles);
  assert.equal(names.length, 13);
  for (const fileName of names) {
    const text = fs.readFileSync(path.join(sourceRoles, fileName), 'utf8');
    assert.doesNotMatch(roleHeader(text), /^sandbox_mode[ \t]*=/m, fileName);
  }
  for (const [name, expectedHash] of Object.entries(protectedInstructionHashes)) {
    const text = readRole(sourceRoles, name);
    assert.equal(instructionHash(text), expectedHash, `${name} behavioral instructions changed`);
  }
});

test('setup installs inheriting roles twice and preserves user Codex configuration', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-role-policy-'));
  temporaryRoots.push(project);
  const codex = path.join(project, '.codex');
  const installedAgents = path.join(codex, 'agents');
  fs.mkdirSync(installedAgents, { recursive: true });
  const config = '[projects."existing"]\ntrust_level = "trusted"\n';
  const customRole = 'name = "custom-reviewer"\nmodel = "user-selected"\n';
  fs.writeFileSync(path.join(codex, 'config.toml'), config);
  fs.writeFileSync(path.join(installedAgents, 'custom-reviewer.toml'), customRole);

  await setupProject({ projectDir: project });

  const installedSkillRoles = path.join(project, '.agents/skills/deliver/assets/codex-agents');
  for (const fileName of roleNames(sourceRoles)) {
    const source = fs.readFileSync(path.join(sourceRoles, fileName), 'utf8');
    for (const directory of [installedSkillRoles, installedAgents]) {
      const installed = fs.readFileSync(path.join(directory, fileName), 'utf8');
      assert.equal(installed, source, `${fileName} differs in ${directory}`);
      assert.doesNotMatch(roleHeader(installed), /^sandbox_mode[ \t]*=/m, fileName);
    }
  }
  assert.equal(fs.readFileSync(path.join(codex, 'config.toml'), 'utf8'), config);
  assert.equal(fs.readFileSync(path.join(installedAgents, 'custom-reviewer.toml'), 'utf8'), customRole);
});
