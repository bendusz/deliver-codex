import assert from 'node:assert/strict';
import { mkdtemp as makeTemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { inspectSpecs, parseSpec } from '../plugins/deliver/skills/deliver/scripts/specdd.mjs';

const temporaryRoots = [];
async function mkdtemp(prefix) {
  const root = await makeTemp(prefix);
  temporaryRoots.push(root);
  return root;
}
after(async () => Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true }))));

test('parseSpec accepts current inline Platform and keeps prose in Owns', () => {
  const parsed = parseSpec(`Spec: Example\nPlatform: Node.js 22\nOwns:\n  ./src/main.js\n  The source adapter and its behavior.\nCan modify:\n  ./tests/main.test.js\n`);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.platform, 'Node.js 22');
  assert.deepEqual(parsed.owns.map((entry) => entry.path?.raw ?? null), ['./src/main.js', null]);
  assert.deepEqual(parsed.owns.map((entry) => entry.normalized), ['./src/main.js', 'The source adapter and its behavior.']);
});

test('Platform body syntax is rejected', () => {
  const parsed = parseSpec('Spec: Example\nPlatform:\n  Node.js 22\n');
  assert.ok(parsed.findings.some((item) => item.code === 'missing-platform'));
  assert.ok(parsed.findings.some((item) => item.code === 'body-not-allowed'));
});

test('malformed supported section headers and indentation are findings', () => {
  const parsed = parseSpec('Spec : Example\nPurpose:\n  okay\n   bad-indent\n');
  assert.ok(parsed.findings.some((item) => item.code === 'space-before-colon'));
  assert.ok(parsed.findings.some((item) => item.code === 'odd-indentation'));
});

test('inspect resolves nested ../ paths and root-prefixed paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'specdd-'));
  await mkdir(path.join(root, 'modules', 'child'), { recursive: true });
  await writeFile(path.join(root, 'root.sdd'), `Spec: Root\nMust:\n  Keep root boundaries.\nMust not:\n  Cross module boundaries.\nOwns:\n  /README.md\n`);
  await writeFile(path.join(root, 'modules', 'modules.sdd'), `Spec: Modules\nOwns:\n  ../shared.js\n`);
  await writeFile(path.join(root, 'modules', 'child', 'child.sdd'), `Spec: Child\nOwns:\n  ../child.js\n  /modules/child/local.js\nCan modify:\n  ./generated.json\n`);
  const result = await inspectSpecs(root, ['root.sdd', 'modules/modules.sdd', 'modules/child/child.sdd']);
  const child = result.specs.find((spec) => spec.relativePath.endsWith('child/child.sdd'));
  assert.equal(result.ok, true);
  assert.deepEqual(child.owns.map((item) => item.path), ['modules/child.js', 'modules/child/local.js']);
  assert.deepEqual(child.writeScope.map((item) => item.path), ['modules/child.js', 'modules/child/local.js', 'modules/child/generated.json']);
  assert.deepEqual(child.inheritedMust.map((item) => item.text), ['Keep root boundaries.']);
  assert.deepEqual(child.inheritedMustNot.map((item) => item.text), ['Cross module boundaries.']);
});

test('same-directory sibling specs do not inherit each other', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'specdd-'));
  await mkdir(path.join(root, 'a'), { recursive: true });
  await mkdir(path.join(root, 'b'), { recursive: true });
  await writeFile(path.join(root, 'a', 'a.sdd'), 'Spec: A\nMust:\n  A only.\n');
  await writeFile(path.join(root, 'b', 'b.sdd'), 'Spec: B\nMust:\n  B only.\n');
  const result = await inspectSpecs(root, ['a/a.sdd', 'b/b.sdd']);
  assert.deepEqual(result.specs[0].inheritedMust, []);
  assert.deepEqual(result.specs[1].inheritedMust, []);
});

test('leaf specs inherit root and containing-directory rules without sibling leakage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'specdd-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'root.sdd'), 'Spec: Root\nMust:\n  Preserve compatibility.\nMust not:\n  Leak secrets.\n');
  await writeFile(path.join(root, 'src/src.sdd'), 'Spec: Source\nMust:\n  Stay synchronous.\nMust not:\n  Add network access.\n');
  await writeFile(path.join(root, 'src/greet.sdd'), 'Spec: Greet\nOwns:\n  ./greet.mjs\nMust:\n  Greet the caller.\n');
  await writeFile(path.join(root, 'src/other.sdd'), 'Spec: Other\nMust:\n  Sibling-only rule.\n');
  const result = await inspectSpecs(root, ['root.sdd', 'src/src.sdd', 'src/greet.sdd', 'src/other.sdd']);
  assert.equal(result.ok, true);
  const leaf = result.specs.find((spec) => spec.relativePath === 'src/greet.sdd');
  assert.deepEqual(leaf.must, ['Preserve compatibility.', 'Stay synchronous.', 'Greet the caller.']);
  assert.deepEqual(leaf.mustNot, ['Leak secrets.', 'Add network access.']);
});

test('Owns is exclusive while Can modify widens only the write scope', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'specdd-'));
  await writeFile(path.join(root, 'one.sdd'), `Spec: One\nOwns:\n  ./one.js\nCan modify:\n  ./shared.test.js\n`);
  await writeFile(path.join(root, 'two.sdd'), `Spec: Two\nCan modify:\n  ./shared.test.js\n`);
  const result = await inspectSpecs(root, ['one.sdd', 'two.sdd']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.specs[0].writeScope.map((item) => item.path), ['one.js', 'shared.test.js']);
  assert.equal(result.ownership.length, 1);
});

test('the same literal path is not repeated in Owns and Can modify', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'specdd-'));
  await writeFile(path.join(root, 'module.sdd'), 'Spec: Module\nOwns:\n  ./module.js\nCan modify:\n  ./module.js\n');
  const result = await inspectSpecs(root, ['module.sdd']);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((item) => item.code === 'duplicate-scope-entry'));
});

test('traversal outside root and symlink escapes are rejected and excluded', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'specdd-root-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'specdd-outside-'));
  await mkdir(path.join(root, 'module'), { recursive: true });
  await writeFile(path.join(root, 'module', 'module.sdd'), `Spec: Module\nOwns:\n  ../../../outside.js\n  ./linked/secret.js\n`);
  await mkdir(path.join(outside, 'linked'), { recursive: true });
  await writeFile(path.join(outside, 'linked', 'secret.js'), 'secret');
  try {
    await symlink(path.join(outside, 'linked'), path.join(root, 'module', 'linked'));
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('symlinks unavailable');
    throw error;
  }
  const result = await inspectSpecs(root, ['module/module.sdd']);
  assert.ok(result.findings.some((item) => item.code === 'path-escape'));
  assert.ok(result.findings.some((item) => item.code === 'symlink-escape'));
  assert.deepEqual(result.specs[0].owns, []);
});

test('duplicate ownership catches exact and ancestor overlap', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'specdd-'));
  await writeFile(path.join(root, 'one.sdd'), 'Spec: One\nOwns:\n  ./src\n');
  await writeFile(path.join(root, 'two.sdd'), 'Spec: Two\nOwns:\n  ./src/main.js\n');
  const result = await inspectSpecs(root, ['one.sdd', 'two.sdd']);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((item) => item.code === 'duplicate-ownership'));
});

test('inspect is read-only and does not create missing specs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'specdd-'));
  const spec = path.join(root, 'missing.sdd');
  const result = await inspectSpecs(root, ['missing.sdd']);
  assert.equal(result.ok, false);
  await assert.rejects(readFile(spec));
});

test('globs remain parse-valid but are excluded from enforcement', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'specdd-'));
  await writeFile(path.join(root, 'module.sdd'), 'Spec: Module\nOwns:\n  ./src/*.js\n');
  const result = await inspectSpecs(root, ['module.sdd']);
  assert.equal(parseSpec(await readFile(path.join(root, 'module.sdd'), 'utf8')).valid, true);
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((item) => item.code === 'unsupported-glob'));
  assert.deepEqual(result.specs[0].owns, []);
});

test('spec files cannot become owned or editable paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'specdd-'));
  await writeFile(path.join(root, 'module.sdd'), 'Spec: Module\nOwns:\n  ./other.sdd\nCan modify:\n  ./change.sdd\n');
  await writeFile(path.join(root, 'other.sdd'), 'Spec: Other\n');
  const result = await inspectSpecs(root, ['module.sdd', 'other.sdd']);
  assert.equal(result.ok, false);
  assert.equal(result.specs[0].editablePaths.includes('other.sdd'), false);
  assert.ok(result.findings.some((item) => item.code === 'spec-file-ownership'));
});

test('context-only globs are warnings and do not widen authority', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'specdd-'));
  await writeFile(path.join(root, 'module.sdd'), 'Spec: Module\nCan read:\n  ./docs/*.md\n');
  const result = await inspectSpecs(root, ['module.sdd']);
  assert.equal(result.ok, true);
  assert.ok(result.findings.some((item) => item.code === 'unsupported-glob' && item.severity === 'warning'));
  assert.deepEqual(result.specs[0].editablePaths, []);
});

test('symlinked spec inputs are rejected before their contents are read', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'specdd-root-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'specdd-outside-'));
  await writeFile(path.join(outside, 'secret.sdd'), 'Spec: Secret\nOwns:\n  /secret.txt\n');
  try {
    await symlink(path.join(outside, 'secret.sdd'), path.join(root, 'linked.sdd'));
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('symlinks unavailable');
    throw error;
  }
  const result = await inspectSpecs(root, ['linked.sdd']);
  assert.ok(result.findings.some((item) => item.code === 'symlink-escape'));
  assert.deepEqual(result.specs[0].parsed.sections, []);
});
