import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseExec as upstreamExecution } from './fixtures/upstream-v0.25.1/hooks/lib.mjs';
import { parseStory, replaceStoryExecution } from '../plugins/deliver/skills/deliver/scripts/lib/story.mjs';

const currentPmApi = await import('../plugins/deliver/skills/deliver/scripts/lib/current-pm.mjs');
const pmCli = fileURLToPath(new URL('../plugins/deliver/skills/deliver/scripts/pm.mjs', import.meta.url));

const rel = 'docs/stories/S2-3-roundtrip.md';
const contract = [
  '# S2-3: Round trip',
  '<!-- pm-meta: {"builder":"codex-builder","touches":["src"]} -->',
  'Sprint: 2 · Priority: high · Covers: AC-023 · Depends on: none · Parallel-safe: yes',
  'Risk: low · Review lenses: code-integrity-reviewer · Specs: none',
  '',
  '## Acceptance criteria (testable)',
  '- [ ] The same criterion survives both hosts.',
  '',
].join('\n');

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}

function write(root, relative, value) {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
  return file;
}

function call(root, ...args) {
  const result = spawnSync(process.execPath, [pmCli, ...args], { cwd: root, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch {}
  return { ...result, json };
}

function admissionProject(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-remote-admission-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Casey Example');
  git(root, 'config', 'user.email', 'casey@example.invalid');
  assert.equal(call(root, 'init').status, 0);
  write(root, 'docs/plan.md', '# Plan\n\n## Delivery mode\n- Scale: standard\n- Checkpoint policy: story-level\n- Integration branch: main\n- Skeleton: none\n');
  const merged = replaceStoryExecution(parseStory(contract, rel), {
    owner: 'casey-abcdef123456', builder: 'codex-builder', branch: 'pm/S2-3-roundtrip',
    status: 'merged', rounds: 1, retries: 0, updated: '2026-09-10 13:00',
  }, { note: '2026-09-10 13:00 integrated' });
  write(root, rel, merged.after);
  const nextRel = 'docs/stories/S2-4-next.md';
  write(root, nextRel, contract.replaceAll('S2-3', 'S2-4').replace('Round trip', 'Next story'));
  write(root, 'src/value.txt', 'imported completion\n');
  git(root, 'add', 'docs', 'src');
  git(root, 'commit', '-qm', 'Import upstream merged story');
  const approved = call(root, 'approve', '--approver', 'Ben');
  assert.equal(approved.status, 0, approved.stdout);
  git(root, 'add', 'docs/approval.json');
  git(root, 'commit', '-qm', 'Approve imported project');
  return { root, nextRel };
}

test('upstream Execution is accepted and Codex closure remains readable upstream', () => {
  const upstream = `${contract}## Execution\n<!-- pm-exec: {"owner":"casey-abcdef123456","builder":"codex-builder","branch":"pm/S2-3-roundtrip","status":"in-review","rounds":2,"retries":1,"updated":"2026-09-10 12:00","host_note":"keep"} -->\n`;
  const document = parseStory(upstream, rel);
  assert.equal(document.acceptance[0].text, 'The same criterion survives both hosts.');
  const closed = replaceStoryExecution(document, { status: 'merged', updated: '2026-09-10 13:00' }, { note: '2026-09-10 13:00 integrated' });
  const readBack = upstreamExecution(closed.after);
  assert.equal(readBack.status, 'merged');
  assert.equal(readBack.rounds, 2);
  assert.equal(readBack.retries, 1);
  assert.equal(readBack.host_note, 'keep');
  assert.equal(closed.contractHash, document.contractHash);
});

test('Codex Execution accepts an upstream boundary update without losing identity', () => {
  const claimed = replaceStoryExecution(parseStory(contract, rel), {
    owner: 'casey-abcdef123456', builder: 'codex-builder', branch: 'pm/S2-3-roundtrip',
    status: 'claimed', rounds: 0, retries: 0, updated: '2026-09-10 12:00',
  });
  const fromUpstream = claimed.after.replace('"status":"claimed"', '"status":"building"');
  const document = parseStory(fromUpstream, rel);
  assert.equal(document.execution.owner, 'casey-abcdef123456');
  assert.equal(document.execution.branch, 'pm/S2-3-roundtrip');
  assert.equal(document.execution.status, 'building');
  assert.equal(document.contractHash, claimed.contractHash);
});

test('native remote admission preserves imported completion and fails closed on malformed local evidence', async (t) => {
  assert.equal(typeof currentPmApi.remoteAdmissionStatus, 'function',
    'current PM must export the native remote admission projection');

  await t.test('imported upstream merged story remains clear without a native remote record', () => {
    const fixture = admissionProject(t);
    const status = currentPmApi.remoteAdmissionStatus(fixture.root);
    assert.equal(status.version, 'remote-admission-status-v1');
    assert.equal(status.state, 'CLEAR');
    assert.equal(status.blocking, false);
    assert.equal(status.integration_branch, 'main');
    assert.equal(status.integration_record, null);
    assert.deepEqual(status.diagnostics, []);
    const projected = call(fixture.root, 'status');
    assert.equal(projected.status, 0, projected.stdout);
    assert.deepEqual(projected.json.remote, status);
    const claimed = call(fixture.root, 'claim', '--story', fixture.nextRel);
    assert.equal(claimed.status, 0, claimed.stdout);
    assert.equal(claimed.json.resumed, false);
  });

  for (const kind of ['malformed regular record', 'symlinked record']) {
    await t.test(kind, () => {
      const fixture = admissionProject(t);
      const integrations = path.join(fixture.root, '.deliver/integrations');
      fs.mkdirSync(integrations, { recursive: true });
      const record = path.join(integrations, '11111111-1111-4111-8111-111111111111.json');
      if (kind === 'symlinked record') {
        const outside = write(path.dirname(fixture.root), `${path.basename(fixture.root)}-outside.json`, '{}\n');
        t.after(() => fs.rmSync(outside, { force: true }));
        fs.symlinkSync(outside, record);
      } else {
        fs.writeFileSync(record, '{not json\n');
      }
      const status = currentPmApi.remoteAdmissionStatus(fixture.root);
      assert.equal(status.version, 'remote-admission-status-v1');
      assert.equal(status.state, 'UNKNOWN');
      assert.equal(status.blocking, true);
      assert(status.diagnostics.some((item) => /record|malformed|symlink|canonical|evidence/i.test(`${item.code} ${item.message}`)));
      const before = fs.lstatSync(record).isSymbolicLink() ? fs.readlinkSync(record) : fs.readFileSync(record, 'utf8');
      const refused = call(fixture.root, 'claim', '--story', fixture.nextRel);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stdout, /remote|unknown|integration|evidence|admission/i);
      assert.equal(fs.lstatSync(record).isSymbolicLink() ? fs.readlinkSync(record) : fs.readFileSync(record, 'utf8'), before);
    });
  }
});
