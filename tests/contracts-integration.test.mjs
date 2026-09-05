import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const runtime = fileURLToPath(new URL('../plugins/deliver/skills/deliver/scripts/deliver.mjs', import.meta.url));
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'deliver-contract-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  write('docs/plan.md', 'Implement the approved greeting.\n');
  write('src/greet.mjs', 'export const greet = name => name;\n');
  write('tests/greet.test.mjs', 'import { greet } from "../src/greet.mjs";\n');
  const rootSpec = `${path.basename(root)}.sdd`;
  write(rootSpec, 'Spec: Greetings\nPlatform: Node.js/22\nPurpose:\n  Greet users.\nMust:\n  Keep the public function synchronous.\n');
  write('src/greet.sdd', 'Spec: Greeting\nOwns:\n  ./greet.mjs\nCan modify:\n  /tests/greet.test.mjs\nMust:\n  Greet the supplied name.\n');
  git('add', '.'); git('commit', '-m', 'Fixture');
  const packet = { id: 'greet', objective: 'Add greeting', acceptance: [{ id: 'AC-1', text: 'Returns Hello, Ada!' }], read_paths: [], touches: ['src/greet.mjs', 'tests/greet.test.mjs'], commands: {}, specs: [rootSpec, 'src/greet.sdd'] };
  const call = (...args) => {
    const result = spawnSync(process.execPath, [runtime, ...args], { cwd: root, encoding: 'utf8' });
    return { ...result, json: JSON.parse(result.stdout) };
  };
  const initialized = call('init', '--mode', 'managed', '--plan', 'docs/plan.md');
  assert.equal(initialized.status, 0, initialized.stdout);
  const run = initialized.json.run_id;
  assert.equal(call('approve', '--run', run, '--approver', 'user').status, 0);
  const start = () => { write('.deliver/task.json', JSON.stringify(packet)); return call('start', '--run', run, '--task', '.deliver/task.json', '--builder', 'builder'); };
  return { root, rootSpec, packet, write, call, run, start };
}

test('task start checks and freezes SpecDD authority, including additional Can modify paths', (t) => {
  const f = fixture(t);
  const started = f.start();
  assert.equal(started.status, 0, started.stdout);
  const saved = JSON.parse(fs.readFileSync(started.json.state_path, 'utf8'));
  assert.deepEqual(saved.contracts.editable_paths.sort(), ['src/greet.mjs', 'tests/greet.test.mjs']);
  f.write('src/greet.mjs', 'export const greet = name => `Hello, ${name}!`;\n');
  assert.equal(f.call('check', '--run', f.run).status, 0);
  f.write('src/greet.sdd', 'Spec: Greeting\nOwns:\n  ./greet.mjs\n  ./unapproved.mjs\n');
  const changed = f.call('check', '--run', f.run);
  assert.notEqual(changed.status, 0);
  assert.deepEqual(changed.json.contracts_changed, ['src/greet.sdd']);
});

test('start refuses unauthorized touches and missing governing root contracts', (t) => {
  const f = fixture(t);
  f.packet.touches.push('src/unapproved.mjs');
  const denied = f.start();
  assert.notEqual(denied.status, 0);
  assert.match(denied.json.error, /outside explicit SpecDD authority/);
  f.packet.touches.pop();
  f.packet.specs = ['src/greet.sdd'];
  const missing = f.start();
  assert.notEqual(missing.status, 0);
  assert.match(missing.json.error, /omit governing contract/);
});

test('contract authoring cannot be hidden inside a code task', (t) => {
  const f = fixture(t);
  f.packet.touches.push('src/greet.sdd');
  const denied = f.start();
  assert.notEqual(denied.status, 0);
  assert.match(denied.json.error, /separate approved contract phase/);
});

test('directory touches must include their own and nested contracts', (t) => {
  const f = fixture(t);
  f.write(f.rootSpec, 'Spec: Root\nCan modify:\n  /src\n');
  f.write('src/src.sdd', 'Spec: Source\nMust:\n  Preserve source invariants.\n');
  f.packet.touches = ['src'];
  f.packet.specs = [f.rootSpec, 'src/greet.sdd'];
  const omitted = f.start();
  assert.notEqual(omitted.status, 0);
  assert.match(omitted.json.error, /omit governing contract: src\/src.sdd/);
  f.packet.specs.push('src/src.sdd');
  const started = f.start();
  assert.equal(started.status, 0, started.stdout);
  f.write('src/src.sdd', 'Spec: Source\nMust:\n  Weakened invariants.\n');
  const changed = f.call('check', '--run', f.run);
  assert.notEqual(changed.status, 0);
  assert.ok(changed.json.contracts_changed.includes('src/src.sdd'));
});

test('new or ignored contracts cannot be authored beneath a code directory scope', (t) => {
  const f = fixture(t);
  f.write(f.rootSpec, 'Spec: Root\nCan modify:\n  /src\n');
  f.write('.gitignore', '*.sdd\n.specdd/\n');
  f.packet.touches = ['src'];
  assert.equal(f.start().status, 0);
  f.write('src/new.sdd', 'Spec: New\nOwns:\n  ./new.mjs\n');
  f.write('src/.specdd/bootstrap.local.md', 'New instructions');
  const changed = f.call('check', '--run', f.run);
  assert.notEqual(changed.status, 0);
  assert.deepEqual(changed.json.contracts_changed, ['src/.specdd/bootstrap.local.md', 'src/new.sdd']);
});
