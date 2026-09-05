#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateTaskPacket } from '../plugins/deliver/skills/deliver/scripts/lib/state.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const plugin = path.join(root, 'plugins/deliver');
const skill = path.join(plugin, 'skills/deliver');
const read = (file) => fs.readFileSync(file, 'utf8');
const json = (file) => JSON.parse(read(file));
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', '.git', '.agents', '.deliver'].includes(entry.name)) return [];
    const file = path.join(dir, entry.name);
    assert(!entry.isSymbolicLink(), `source symlink: ${file}`);
    return entry.isDirectory() ? files(file) : [file];
  });
}
const manifest = json(path.join(plugin, '.codex-plugin/plugin.json'));
assert.equal(manifest.name, 'deliver');
assert.equal(manifest.version, json(path.join(root, 'package.json')).version);
assert.equal(manifest.skills, './skills/');
assert.equal(manifest.author.name, 'Ben Vegh');
assert.equal(manifest.interface.displayName, 'Deliver');
assert(!('mcpServers' in manifest) && !('apps' in manifest));
assert(!JSON.stringify(manifest).includes('TODO'));
const entry = read(path.join(skill, 'SKILL.md'));
assert.match(entry, /^---\nname: deliver\ndescription: [^\n]+\n---/);
assert(entry.split(/\s+/).length < 800, 'entrypoint exceeds its context budget');
for (const match of entry.matchAll(/`(references\/[^`]+\.md)`/g)) {
  assert(fs.existsSync(path.join(skill, match[1])), `missing routed reference ${match[1]}`);
}
const roles = files(path.join(skill, 'assets/codex-agents')).filter((file) => file.endsWith('.toml'));
assert(roles.length >= 6);
for (const file of roles) {
  const text = read(file);
  const name = text.match(/^name = "([^"]+)"$/m)?.[1];
  assert.equal(name, path.basename(file, '.toml'));
  assert.match(text, /^description = "[^\n]+"$/m);
  assert.match(text, /^model = "gpt-5\.6-(?:sol|luna|terra)"$/m);
  assert.match(text, /^model_reasoning_effort = "(?:medium|high|xhigh)"$/m);
  assert.match(text, /developer_instructions = '''\n[\s\S]+\n'''\n?$/);
}
validateTaskPacket(json(path.join(skill, 'assets/task.example.json')));
for (const file of files(root)) {
  if (file.endsWith('.json')) json(file);
  if (file.endsWith('.mjs')) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
  if (file.startsWith(skill) && /\.(?:md|mjs|toml)$/.test(file)) {
    assert(!read(file).includes('${CLAUDE_PLUGIN_ROOT}'), `Claude path coupling in ${file}`);
  }
}
console.log(`Deliver validation passed: manifest, skill routes, ${roles.length} roles, JSON and JavaScript syntax.`);
