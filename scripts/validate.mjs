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
const operationMap = json(path.join(skill, 'assets/operations.json'));
assert.equal(operationMap.schema_version, 1);
assert.equal(operationMap.invocation.skill, '$deliver <operation> [arguments]');
assert.equal(operationMap.invocation.registered_slash_commands, false);
assert.equal(operationMap.invocation.runtime_commands_are_operations, false);
assert(Array.isArray(operationMap.operations) && operationMap.operations.length > 0);
const operationNames = new Set();
const operationTokens = new Set();
for (const operation of operationMap.operations) {
  assert.match(operation.name, /^[a-z][a-z0-9-]*$/, `bad operation name: ${operation.name}`);
  assert(!operationNames.has(operation.name), `duplicate operation: ${operation.name}`);
  operationNames.add(operation.name);
  assert(Array.isArray(operation.aliases));
  for (const token of [operation.name, ...operation.aliases]) {
    assert.match(token, /^[a-z][a-z0-9-]*$/, `bad operation token: ${token}`);
    assert(!operationTokens.has(token), `duplicate operation token: ${token}`);
    operationTokens.add(token);
  }
  assert(Array.isArray(operation.arguments));
  for (const argument of operation.arguments) {
    assert.match(argument.name, /^[a-z][a-z0-9-]*$/);
    assert.equal(typeof argument.required, 'boolean');
    assert.equal(typeof argument.description, 'string');
    assert(argument.description.length > 0);
  }
  assert(['artifact', 'artifact-update', 'artifacts', 'approval', 'benchmark', 'brief', 'completion',
    'claim', 'continuation', 'delivery', 'diagnostic', 'knowledge', 'migration', 'recommendation', 'replan',
    'report', 'state', 'verification', 'verified-change'].includes(operation.output?.kind));
  assert(Array.isArray(operation.output.paths));
  assert.equal(typeof operation.output.description, 'string');
  assert(['read-only', 'external-read', 'project-write', 'delivery-write'].includes(operation.mutation?.mode));
  assert(Array.isArray(operation.mutation.paths));
  assert(Array.isArray(operation.mutation.external));
  if (operation.mutation.mode === 'read-only') {
    assert.deepEqual(operation.mutation.paths, [], `${operation.name} read-only path authority`);
    assert.deepEqual(operation.mutation.external, [], `${operation.name} read-only external authority`);
  }
  assert.match(operation.reference, /^references\/[a-z0-9-]+\.md$/);
  assert(fs.existsSync(path.join(skill, operation.reference)), `missing operation reference ${operation.reference}`);
}
assert(entry.includes('references/operations.md'), 'entrypoint does not route the operation map');
for (const file of files(skill).filter((item) => item.endsWith('.md'))) {
  for (const match of read(file).matchAll(/`(assets\/templates\/[^`]+)`/g)) {
    assert(fs.existsSync(path.join(skill, match[1])), `missing template asset ${match[1]} from ${file}`);
  }
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
