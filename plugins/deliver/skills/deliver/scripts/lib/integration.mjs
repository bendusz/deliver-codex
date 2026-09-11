import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { canonical, DeliverError, internalDirectory, readRun, sha256, validateTaskPacket } from './state.mjs';
import { assertCurrentBinding } from './current-pm.mjs';
import { readPlanPolicy } from './project-state.mjs';
import { parseReviewReceipt } from './review.mjs';
import { parseVerificationResults, renderVerificationArtifacts } from './reporting.mjs';
import { parseStory, readStory, replaceStoryExecution } from './story.mjs';
import { environmentHandle } from './gates.mjs';
import { captureGitAnchor, snapshot } from './scope.mjs';

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const HASH = /^[0-9a-f]{64}$/;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const NO_MUTATION = Symbol('no-mutation');
const fail = (message, code = 66) => { throw new DeliverError(message, code); };
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const now = () => new Date().toISOString();
const stamp = () => now().replace('T', ' ').replace('Z', '').slice(0, 16);
const covers = (scope, rel) => scope === rel || rel.startsWith(`${scope}/`);

function git(root, args, { buffer = false, env = undefined } = {}) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: buffer ? undefined : 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
      windowsHide: true, ...(env ? { env: { ...process.env, ...env } } : {}),
    });
  } catch (error) {
    fail(`Git cannot complete local integration: ${String(error.stderr || error.message).trim()}`);
  }
}

function rootPath(root) {
  try {
    const real = fs.realpathSync.native(root);
    const stat = fs.lstatSync(real);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('integration root must be a real directory');
    return real;
  } catch (error) {
    if (error instanceof DeliverError) throw error;
    fail(`cannot access integration root: ${error.message}`);
  }
}

function commonRepository(root) {
  const value = String(git(root, ['rev-parse', '--git-common-dir'])).trim();
  return fs.realpathSync.native(path.resolve(root, value));
}

function branch(root) {
  const value = String(git(root, ['symbolic-ref', '--short', 'HEAD'])).trim();
  if (!value) fail('integration checkout must use a named branch');
  return value;
}

function head(root) { return String(git(root, ['rev-parse', '--verify', 'HEAD'])).trim(); }
function tree(root, commit = 'HEAD') { return String(git(root, ['rev-parse', `${commit}^{tree}`])).trim(); }

function statusPaths(root) {
  const records = String(git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0').filter(Boolean);
  const paths = [];
  for (let index = 0; index < records.length; index++) {
    const item = records[index];
    if (item.length < 4) continue;
    const status = item.slice(0, 2);
    paths.push(item.slice(3));
    if ((status[0] === 'R' || status[0] === 'C') && records[index + 1]) paths.push(records[++index]);
  }
  return paths.filter((rel) => rel !== '.deliver' && !rel.startsWith('.deliver/'));
}

function assertClean(root) {
  const dirty = statusPaths(root);
  if (dirty.length) fail(`integration checkout has uncommitted project paths: ${dirty.sort().join(', ')}`);
  const indexTree = String(git(root, ['write-tree'])).trim();
  if (indexTree !== tree(root)) fail('integration checkout index differs from HEAD');
}

function assertOrdinaryIndex(root) {
  const rows = git(root, ['ls-files', '-v', '-z'], { buffer: true }).toString('utf8').split('\0').filter(Boolean);
  const hidden = rows.filter((row) => row[0] !== 'H').map((row) => row.slice(2));
  if (hidden.length) fail(`integration checkout has unsupported index flags: ${hidden.sort().join(', ')}`);
}

function protectedShape(anchor, root = true) {
  return {
    metadata_version: anchor.metadata_version,
    ...(root ? { ref: anchor.ref } : {}),
    protected_hash: anchor.protected_hash,
    submodules: Object.fromEntries(Object.entries(anchor.submodules || {})
      .map(([rel, nested]) => [rel, protectedShape(nested, false)])),
  };
}

const protectedIgnored = (rel) => /(^|\/)(?:AGENTS|CLAUDE)\.md$/.test(rel)
  || /(^|\/)\.(?:agents|codex)(?:\/|$)/.test(rel)
  || rel.endsWith('.sdd') || /(^|\/)\.specdd(?:\/|$)/.test(rel)
  || /(^|\/)(?:config|configs|contract|contracts)(?:[./]|$)/.test(rel);

function liveFingerprint(root, rel) {
  const file = path.join(root, rel);
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink()) return `symlink:${sha256(fs.readlinkSync(file))}`;
  if (stat.isFile()) return `file:${stat.mode & 0o100 ? '755' : '644'}:${sha256(fs.readFileSync(file))}`;
  fail(`unsupported executable checkout path type: ${rel}`);
}

function protectedIgnoredEntries(root) {
  const output = git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], { buffer: true });
  const entries = Object.create(null);
  for (const rel of output.toString('utf8').split('\0').filter(Boolean)
    .filter((item) => item !== '.deliver' && !item.startsWith('.deliver/')).filter(protectedIgnored).sort()) {
    entries[rel] = liveFingerprint(root, rel);
  }
  return entries;
}

function parseTreeRows(root, commit, scopes, recursive = true) {
  const args = ['ls-tree', ...(recursive ? ['-r'] : []), '-z', commit, '--', ...scopes];
  const output = git(root, args, { buffer: true });
  return output.toString('utf8').split('\0').filter(Boolean).map((raw) => {
    const match = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.+)$/.exec(raw);
    if (!match) fail('cannot parse committed integration manifest');
    return { mode: match[1], type: match[2], oid: match[3], rel: match[4] };
  });
}

function treeObjects(root, commit, scopes = ['.']) {
  return Object.fromEntries(parseTreeRows(root, commit, scopes).map((entry) => [entry.rel, entry]));
}

function exactTreeObject(root, commit, rel) {
  return parseTreeRows(root, commit, [rel], false).find((entry) => entry.rel === rel) || null;
}

function moduleRoot(root, rel, { required = false } = {}) {
  const candidate = path.join(root, rel);
  let stat;
  try { stat = fs.lstatSync(candidate); } catch (error) {
    if (error.code === 'ENOENT' && !required) return null;
    fail(`cannot access initialized submodule ${rel}: ${error.message}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    if (!required && stat.isDirectory()) return null;
    fail(`initialized submodule path is not a real directory: ${rel}`);
  }
  const real = fs.realpathSync.native(candidate);
  const relative = path.relative(root, real);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || real !== path.resolve(candidate)) {
    fail(`initialized submodule escapes its checkout: ${rel}`);
  }
  if (fs.readdirSync(real).length === 0) {
    if (!required) return null;
    fail(`required submodule checkout is uninitialized: ${rel}`);
  }
  let top;
  try { top = String(git(real, ['rev-parse', '--show-toplevel'])).trim(); } catch {
    fail(`submodule checkout is not initialized safely: ${rel}`);
  }
  if (fs.realpathSync.native(top) !== real) fail(`submodule checkout has an unexpected Git root: ${rel}`);
  return real;
}

function initializedForLinks(root, links) {
  const result = Object.create(null);
  for (const rel of Object.keys(links).sort()) {
    const nested = moduleRoot(root, rel);
    if (nested) result[rel] = nested;
  }
  return result;
}

function checkoutObjectEntries(root, commit) {
  const entries = Object.create(null);
  for (const item of Object.values(treeObjects(root, commit))) entries[item.rel] = fingerprintBlob(root, item.mode, item.oid);
  return entries;
}

function buildCheckoutProof(root, commit, anchor = captureGitAnchor(root)) {
  const entries = checkoutObjectEntries(root, commit);
  const expectedLinks = Object.fromEntries(Object.entries(entries).filter(([, value]) => /^gitlink:[0-9a-f]+$/.test(value)));
  const currentEntries = checkoutObjectEntries(root, 'HEAD');
  const currentLinks = Object.fromEntries(Object.entries(currentEntries).filter(([, value]) => /^gitlink:[0-9a-f]+$/.test(value)));
  const initialized = initializedForLinks(root, { ...expectedLinks, ...currentLinks });
  const children = Object.create(null);
  for (const [rel, nestedRoot] of Object.entries(initialized)) {
    const match = /^gitlink:([0-9a-f]+)$/.exec(expectedLinks[rel] || '');
    if (!match) fail(`initialized submodule is absent from expected M: ${rel}`);
    if (!anchor.submodules?.[rel]) fail(`initialized submodule is absent from protected anchor: ${rel}`);
    children[rel] = buildCheckoutProof(nestedRoot, match[1], anchor.submodules[rel]);
  }
  return {
    version: 'whole-checkout-v1',
    tree: tree(root, commit),
    entries,
    protected_hash: anchor.protected_hash,
    protected_ignored: protectedIgnoredEntries(root),
    initialized: children,
  };
}

function validateCheckoutProofObjects(root, commit, proof) {
  if (!proof || proof.version !== 'whole-checkout-v1' || proof.tree !== tree(root, commit)
    || canonical(proof.entries) !== canonical(checkoutObjectEntries(root, commit))
    || !HASH.test(proof.protected_hash || '') || !proof.protected_ignored || Array.isArray(proof.protected_ignored)
    || !proof.initialized || Array.isArray(proof.initialized)) fail('invalid expected M checkout proof');
  for (const [rel, nestedProof] of Object.entries(proof.initialized)) {
    const match = /^gitlink:([0-9a-f]+)$/.exec(proof.entries[rel] || '');
    if (!match) fail(`expected initialized submodule is not an M gitlink: ${rel}`);
    validateCheckoutProofObjects(moduleRoot(root, rel, { required: true }), match[1], nestedProof);
  }
  return proof;
}

function verifyCheckoutProof(root, commit, proof, anchor = captureGitAnchor(root)) {
  validateCheckoutProofObjects(root, commit, proof);
  if (head(root) !== commit || tree(root) !== proof.tree) fail('executable checkout is not at its expected commit');
  assertClean(root);
  assertOrdinaryIndex(root);
  for (const [rel, identity] of Object.entries(proof.entries)) {
    if (!String(identity).startsWith('gitlink:') && liveFingerprint(root, rel) !== identity) {
      fail(`executable tracked bytes differ from M: ${rel}`);
    }
  }
  const links = Object.fromEntries(Object.entries(proof.entries).filter(([, value]) => /^gitlink:[0-9a-f]+$/.test(value)));
  const initialized = initializedForLinks(root, links);
  if (canonical(Object.keys(initialized).sort()) !== canonical(Object.keys(proof.initialized).sort())) {
    fail('initialized submodule set differs from prepared M checkout');
  }
  if (anchor.protected_hash !== proof.protected_hash
    || canonical(protectedIgnoredEntries(root)) !== canonical(proof.protected_ignored)) {
    fail('protected Git metadata changed in executable checkout');
  }
  for (const [rel, nestedProof] of Object.entries(proof.initialized)) {
    const match = /^gitlink:([0-9a-f]+)$/.exec(proof.entries[rel]);
    if (!anchor.submodules?.[rel]) fail(`initialized submodule is absent from executable protected anchor: ${rel}`);
    verifyCheckoutProof(initialized[rel], match[1], nestedProof, anchor.submodules[rel]);
  }
  return proof;
}

function executableProof(root, manifest, commit, checkoutProof) {
  if (head(root) !== commit || tree(root) !== tree(root, commit)) fail('integration executable checkout is not at the recorded commit');
  verifyCheckoutProof(root, commit, checkoutProof);
  const anchor = captureGitAnchor(root);
  const live = snapshot(root, manifest.scopes);
  const normalized = normalizeSnapshotGitlinks(root, manifest, live.entries, { strict: true, observedEntries: live.entries });
  const liveManifest = snapshotManifest(manifest, normalized);
  if (canonical(liveManifest) !== canonical(manifest)) fail('integration executable bytes differ from the recorded M manifest');
  return { anchor, snapshot_hash: live.hash };
}

function fingerprintBlob(root, mode, oid) {
  if (mode === '160000') return `gitlink:${oid}`;
  const bytes = git(root, ['cat-file', 'blob', oid], { buffer: true });
  if (mode === '120000') return `symlink:${sha256(bytes)}`;
  if (!['100644', '100755'].includes(mode)) fail(`unsupported committed mode in integration manifest: ${mode}`);
  return `file:${mode === '100755' ? '755' : '644'}:${sha256(bytes)}`;
}

function treeEntries(root, commit, scopes) {
  const result = Object.create(null);
  for (const item of parseTreeRows(root, commit, scopes)) result[item.rel] = fingerprintBlob(root, item.mode, item.oid);
  return result;
}

function sourceBindings(state) {
  return {
    packet: sha256(canonical(state.task.packet)),
    actor: state.pm_binding.actor,
    route: { story: state.pm_binding.story, story_path: state.pm_binding.story_path, branch: state.pm_binding.branch },
    contract_hash: state.pm_binding.contract_hash,
    execution_hash: state.pm_binding.execution_hash,
    receipts: {
      review: receiptIdentity(state.review),
      verification: receiptIdentity(state.verification),
      gates: state.gates.map((item) => receiptIdentity(item)),
    },
  };
}

function manifestFromEntries(entries, scopes, bindings) {
  return { entries, bindings: structuredClone(bindings), hash: sha256(canonical({ entries, bindings })), scopes };
}

function boundManifest(root, commit, packet, storyPath, bindings = {}) {
  const scopes = [...new Set([...packet.touches, ...packet.read_paths, ...packet.specs, storyPath, 'docs/plan.md', 'docs/approval.json'])].sort();
  return manifestFromEntries(committedEntries(root, commit, scopes), scopes, bindings);
}

function committedEntries(root, commit, scopes) {
  const committed = treeEntries(root, commit, scopes);
  for (const scope of scopes) {
    if (scope === '.' || Object.keys(committed).some((rel) => covers(scope, rel))) continue;
    const segments = scope.split('/');
    for (let index = 1; index < segments.length; index++) {
      const rel = segments.slice(0, index).join('/');
      const entry = exactTreeObject(root, commit, rel);
      if (!entry) break;
      if (entry.mode !== '160000') continue;
      committed[rel] = fingerprintBlob(root, entry.mode, entry.oid);
      const nestedRoot = moduleRoot(root, rel, { required: true });
      const childScope = segments.slice(index).join('/');
      for (const [name, identity] of Object.entries(committedEntries(nestedRoot, entry.oid, [childScope]))) {
        committed[`${rel}/${name}`] = identity;
      }
      break;
    }
  }
  const candidates = new Set(Object.keys(committed));
  const entries = Object.create(null);
  for (const rel of [...candidates].sort()) entries[rel] = committed[rel] ?? null;
  for (const scope of scopes) {
    if (![...candidates].some((rel) => covers(scope, rel))) entries[scope] = null;
  }
  return entries;
}

function snapshotManifest(committed, snapshotEntries) {
  const candidates = new Set(Object.keys(committed.entries));
  for (const rel of Object.keys(snapshotEntries)) if (committed.scopes.some((scope) => covers(scope, rel))) candidates.add(rel);
  const entries = Object.create(null);
  for (const rel of [...candidates].sort()) entries[rel] = snapshotEntries[rel] ?? null;
  return manifestFromEntries(entries, committed.scopes, committed.bindings);
}

function manifestMismatches(left, right) {
  const paths = new Set([...Object.keys(left.entries), ...Object.keys(right.entries)]);
  return [...paths].filter((rel) => (left.entries[rel] ?? null) !== (right.entries[rel] ?? null)).sort();
}

function childScopes(scopes, rel) {
  return scopes.flatMap((scope) => covers(scope, rel) ? ['.'] : covers(rel, scope) ? [scope.slice(rel.length + 1)] : []);
}

function subtree(entries, rel) {
  return Object.fromEntries(Object.entries(entries).filter(([name]) => name === rel || name.startsWith(`${rel}/`)));
}

function normalizeSnapshotGitlinks(root, manifest, suppliedEntries, { strict, observedEntries } = {}) {
  const normalized = { ...suppliedEntries };
  const observed = observedEntries || snapshot(root, manifest.scopes).entries;
  const links = Object.entries(manifest.entries).filter(([rel, identity], index, all) => /^gitlink:[0-9a-f]+$/.test(identity || '')
    && !all.some(([parent, parentIdentity]) => parent !== rel && rel.startsWith(`${parent}/`) && /^gitlink:[0-9a-f]+$/.test(parentIdentity || '')));
  for (const [rel, identity] of links) {
    const match = /^gitlink:([0-9a-f]+)$/.exec(identity || '');
    try {
      if (canonical(subtree(suppliedEntries, rel)) !== canonical(subtree(observed, rel))
        || !String(observed[rel] || '').startsWith(`${identity}:`)) fail(`initialized submodule snapshot changed: ${rel}`);
      const moduleRoot = fs.realpathSync.native(path.join(root, rel));
      if (String(git(moduleRoot, ['rev-parse', '--show-toplevel'])).trim() !== moduleRoot || head(moduleRoot) !== match[1]) {
        fail(`initialized submodule is not at M's gitlink: ${rel}`);
      }
      assertClean(moduleRoot);
      assertOrdinaryIndex(moduleRoot);
      const scopes = childScopes(manifest.scopes, rel);
      const nestedManifest = manifestFromEntries(committedEntries(moduleRoot, match[1], scopes), scopes, {});
      const nestedLive = snapshot(moduleRoot, scopes);
      const nestedNormalized = normalizeSnapshotGitlinks(moduleRoot, nestedManifest, nestedLive.entries, {
        strict: true, observedEntries: nestedLive.entries,
      });
      if (canonical(snapshotManifest(nestedManifest, nestedNormalized)) !== canonical(nestedManifest)) {
        fail(`initialized submodule bytes differ from M's gitlink: ${rel}`);
      }
      for (const name of Object.keys(normalized)) if (name.startsWith(`${rel}/`)) delete normalized[name];
      for (const [name, value] of Object.entries(nestedNormalized)) {
        const namespaced = `${rel}/${name}`;
        if (Object.hasOwn(manifest.entries, namespaced)) normalized[namespaced] = value;
      }
      normalized[rel] = identity;
    } catch (error) {
      if (strict) throw error;
    }
  }
  return normalized;
}

function probeMergeTree(root, integration, candidate) {
  const args = ['merge-tree', '--write-tree', integration, candidate];
  const started = now();
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024,
  });
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  const expected = stdout.trim().split(/\s+/)[0];
  return {
    ok: result.status === 0 && !result.error && OID.test(expected),
    tree: result.status === 0 && !result.error && OID.test(expected) ? expected : null,
    log: `command: git ${args.join(' ')}\nstarted: ${started}\nexit: ${result.status ?? 'null'}\n\n[stdout]\n${stdout}\n[stderr]\n${stderr}`,
    attempt: {
      provenance: 'deliver-merge-tree-probe-v1', argv: ['git', '-C', root, ...args], git_version: String(git(root, ['--version'])).trim(),
      integration, candidate, status: result.status,
      signal: result.signal || null, error: result.error?.message || null, started_at: started, finished_at: now(),
      stdout_hash: sha256(stdout), stderr_hash: sha256(stderr),
    },
  };
}

function expectedMergeTree(root, integration, candidate) {
  const probe = probeMergeTree(root, integration, candidate);
  if (!probe.ok) fail('candidate does not form a clean merge');
  return probe.tree;
}

function integrationIdentity(record) {
  return sha256(canonical({
    commit: record.integration.commit,
    tree: record.integration.tree,
    manifest: record.manifest.hash,
  }));
}

function recordPath(root, id, { create = false } = {}) {
  if (!RUN_ID.test(id || '')) fail('integration record id must be a canonical run id');
  const directory = create ? internalDirectory(root, ['integrations']) : path.join(root, '.deliver', 'integrations');
  let stat;
  let real;
  try { stat = fs.lstatSync(directory); real = fs.realpathSync.native(directory); }
  catch (error) { fail(`integration records directory is unavailable: ${error.message}`); }
  const expected = path.join(root, '.deliver', 'integrations');
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== expected) fail('integration records directory is not canonical');
  return path.join(real, `${id}.json`);
}

function atomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temp, file); } finally { try { fs.unlinkSync(temp); } catch {} }
}

function recordHash(record) { return sha256(canonical(record)); }

function expectedReporting(scale, requested) {
  if (['large', 'regulated'].includes(scale)) return 'required';
  if (scale === 'standard' && requested) return 'requested';
  return 'skipped';
}

function preparationIdentity(record) {
  return sha256(canonical({
    source_run_id: record.source.run_id,
    candidate: record.source.candidate,
    base: record.integration.base,
    destination_branch: record.destination.branch,
    reporting_requested: record.reporting_requested,
    reporting: record.reporting,
    merge_token: record.integration.token,
    base_anchor: sha256(canonical(record.integration.base_anchor)),
    base_checkout_proof: sha256(canonical(record.integration.base_checkout_proof)),
    expected_tree: record.integration.expected_tree,
    manifest: record.integration.manifest?.hash || null,
    checkout_proof: record.integration.checkout_proof ? sha256(canonical(record.integration.checkout_proof)) : null,
    failed_probe: record.integration.failure?.identity || null,
  }));
}

function validateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || !RUN_ID.test(record.id || '')) {
    fail('integration record id must be a canonical run id');
  }
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.schema_version !== 1
    || record.kind !== 'local-integration-v1'
    || !record.source || record.source.run_id !== record.id || !record.destination || !record.integration || !record.evidence
    || !record.source.manifest || !record.source.snapshot_manifest
    || !record.report || !record.closure || !record.handoff
    || typeof record.source.root !== 'string' || !path.isAbsolute(record.source.root)
    || typeof record.source.run_path !== 'string' || !path.isAbsolute(record.source.run_path)
    || path.basename(record.source.run_path) !== `${record.id}.json`
    || !HASH.test(record.source.snapshot_hash || '') || !HASH.test(record.source.contract_hash || '') || !HASH.test(record.source.execution_hash || '')
    || !OID.test(record.source.candidate) || !OID.test(record.integration.base)
    || !record.integration.base_anchor || typeof record.integration.base_anchor !== 'object' || Array.isArray(record.integration.base_anchor)
    || !record.integration.base_checkout_proof || typeof record.integration.base_checkout_proof !== 'object'
    || Array.isArray(record.integration.base_checkout_proof)
    || (record.integration.commit !== null && !OID.test(record.integration.commit))
    || !['prepared', 'failed', 'adopted'].includes(record.integration.status)
    || !Array.isArray(record.evidence.gates) || !['required', 'requested', 'skipped'].includes(record.reporting)
    || typeof record.reporting_requested !== 'boolean'
    || !Number.isSafeInteger(record.revision) || record.revision < 0
    || !record.plan || !['tiny', 'small', 'standard', 'large', 'regulated'].includes(record.plan.scale)
    || record.reporting !== expectedReporting(record.plan.scale, record.reporting_requested)
    || !record.preparation || record.preparation.identity !== preparationIdentity(record)
    || typeof record.destination.root !== 'string' || !path.isAbsolute(record.destination.root)
    || typeof record.destination.common_repository !== 'string' || !path.isAbsolute(record.destination.common_repository)) {
    fail('invalid local integration record');
  }
  if (typeof record.evidence.source_reusable !== 'boolean' || !Array.isArray(record.evidence.reuse_mismatches)
    || !Array.isArray(record.evidence.gate_history) || !Array.isArray(record.evidence.review_history)
    || !Array.isArray(record.evidence.verification_history) || !Array.isArray(record.evidence.finalization_history)
    || (record.evidence.reconciliation_history !== undefined && !Array.isArray(record.evidence.reconciliation_history))) {
    fail('invalid integration evidence history');
  }
  if (Object.hasOwn(record.evidence, 'finalization')) {
    const finalization = record.evidence.finalization;
    if (finalization !== null && (!finalization || finalization.version !== 'integration-finalization-v1'
      || !OID.test(finalization.integration_commit || '') || !OID.test(finalization.integration_tree || '')
      || !HASH.test(finalization.snapshot_hash || '') || !HASH.test(finalization.manifest_hash || '')
      || !Array.isArray(finalization.gates) || !finalization.gates.every((gate) => gate && typeof gate === 'object'
        && typeof gate.name === 'string' && typeof gate.command === 'string' && HASH.test(gate.identity || '')
        && typeof gate.log_path === 'string' && HASH.test(gate.log_hash || '') && HASH.test(gate.environment_hash || ''))
      || !HASH.test(finalization.review_identity || '') || !HASH.test(finalization.verification_identity || '')
      || !['required', 'requested', 'skipped'].includes(finalization.reporting)
      || typeof finalization.reporting_requested !== 'boolean'
      || !HASH.test(finalization.identity || '') || finalization.identity !== finalizationIdentity(finalization))) {
      fail('invalid integration evidence finalization identity');
    }
    if (Boolean(finalization) !== record.evidence.finalized
      || (finalization && (record.evidence.effective_review_identity !== finalization.review_identity
        || record.evidence.effective_verification_identity !== finalization.verification_identity))) {
      fail('integration evidence finalization fields disagree');
    }
  }
  for (const entry of record.evidence.reconciliation_history || []) {
    if (!entry || !HASH.test(entry.before_hash || '') || !entry.before || typeof entry.before !== 'object'
      || entry.before_hash !== recordHash(entry.before) || typeof entry.at !== 'string') {
      fail('invalid integration evidence reconciliation history');
    }
  }
  for (const manifest of [record.source.manifest, record.source.snapshot_manifest, record.integration.manifest].filter(Boolean)) {
    if (!manifest.entries || typeof manifest.entries !== 'object' || Array.isArray(manifest.entries)
      || !manifest.bindings || typeof manifest.bindings !== 'object' || Array.isArray(manifest.bindings)
      || !Array.isArray(manifest.scopes) || !manifest.scopes.every((item) => typeof item === 'string') || !HASH.test(manifest.hash || '')
      || manifest.hash !== sha256(canonical({ entries: manifest.entries, bindings: manifest.bindings }))) fail('invalid integration manifest');
  }
  if (record.integration.status === 'adopted' && (!record.integration.manifest || !record.integration.anchor
    || !record.integration.checkout_proof || record.manifest?.hash !== record.integration.manifest.hash
    || !HASH.test(record.integration.executable_snapshot_hash || ''))) {
    fail('adopted integration lacks durable M proof');
  }
  if (record.integration.status === 'prepared' && (!RUN_ID.test(record.integration.token || '')
    || !OID.test(record.integration.expected_tree || '') || !record.integration.manifest
    || !record.integration.checkout_proof || record.integration.failure !== null)) {
    fail('prepared integration record is incomplete');
  }
  if (record.integration.status === 'failed' && (!record.integration.failure || record.integration.commit !== null
    || record.integration.token !== null || record.integration.expected_tree !== null || record.integration.manifest !== null
    || record.integration.checkout_proof !== null || !hasReceiptIdentity(record.integration.failure))) fail('failed integration probe claims an M');
  validateTaskPacket(record.source.packet);
  return record;
}

export function readIntegrationRecord(recordArg, cwd = process.cwd()) {
  const lexical = path.resolve(cwd, recordArg);
  let stat;
  try { stat = fs.lstatSync(lexical); } catch (error) { fail(`cannot read integration record: ${error.message}`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES) fail('integration record must be a bounded regular file');
  let value;
  try { value = JSON.parse(fs.readFileSync(lexical, 'utf8')); } catch { fail('invalid JSON in integration record'); }
  const record = validateRecord(value);
  const file = fs.realpathSync.native(lexical);
  if (file !== lexical || record.id !== record.source.run_id
    || recordPath(rootPath(record.destination.root), record.id) !== file) fail('integration record path does not match its source run and destination checkout');
  return { file, record, hash: recordHash(record) };
}

function withRecord(recordArg, expectedHash, mutate, cwd = process.cwd()) {
  const loaded = readIntegrationRecord(recordArg, cwd);
  if (!HASH.test(expectedHash || '') || loaded.hash !== expectedHash) fail('integration record hash is missing or stale');
  const lock = `${loaded.file}.lock`;
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') fail('integration record is locked');
    throw error;
  }
  try {
    const current = readIntegrationRecord(loaded.file);
    if (current.hash !== expectedHash) fail('integration record changed concurrently');
    if (needsFinalizationReconcile(current.record)) {
      fail('LEGACY_FINALIZATION_RECONCILE_REQUIRED: run pm.mjs integrate-reconcile with this exact record hash');
    }
    assertRecordSource(current.record);
    validateIntegrationProofs(current.record);
    const result = mutate(current.record, current.file);
    if (result?.[NO_MUTATION] === true) {
      return { file: current.file, record: current.record, hash: current.hash, result: result.value, unchanged: true };
    }
    current.record.revision += 1;
    current.record.updated_at = now();
    validateRecord(current.record);
    atomic(current.file, json(current.record));
    return { file: current.file, record: current.record, hash: recordHash(current.record), result };
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(lock); } catch {}
  }
}

function receiptIdentity(value) { return sha256(canonical(value)); }

function hasReceiptIdentity(value) {
  if (!value || !HASH.test(value.identity || '')) return false;
  const { identity, ...body } = value;
  return identity === receiptIdentity(body);
}

function artifactStarted(record) {
  return ['report', 'closure', 'handoff'].some((field) => record[field].pending !== null || record[field].commit !== null);
}

function needsFinalizationReconcile(record) {
  if (Object.hasOwn(record.evidence, 'finalization')) {
    return artifactStarted(record) && (!record.evidence.finalization
      || ['report', 'closure', 'handoff'].some((field) => {
        const stage = record[field];
        return (stage.pending && !HASH.test(stage.pending.finalization_identity || ''))
          || (stage.proof && !HASH.test(stage.proof.finalization_identity || ''));
      }));
  }
  return record.evidence.finalized || artifactStarted(record);
}

function finalizationIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { identity, ...body } = value;
  return sha256(canonical(body));
}

function receiptByIdentity(values, identity, label) {
  if (!HASH.test(identity || '')) fail(`legacy finalization ${label} identity is missing`);
  const matches = values.filter(Boolean).filter((item) => item.identity === identity && hasReceiptIdentity(item));
  const unique = [...new Map(matches.map((item) => [canonical(item), item])).values()];
  if (unique.length !== 1) fail(`legacy finalization ${label} receipt is ${unique.length ? 'ambiguous' : 'missing'}`);
  return unique[0];
}

function gateReceiptPool(record) {
  return [...record.evidence.gates, ...record.evidence.gate_history];
}

function reviewReceiptPool(record) {
  return [record.evidence.review, ...record.evidence.review_history, record.source.review];
}

function verificationReceiptPool(record) {
  return [record.evidence.verification, ...record.evidence.verification_history, record.source.verification];
}

function assertEvidenceActors(record, review, verification, label = 'integration') {
  if (typeof review?.reviewer !== 'string' || !ACTOR_ID.test(review.reviewer)) {
    fail(`${label} reviewer identity must be explicit and valid`);
  }
  if (review.reviewer === record.source.builder) fail(`${label} reviewer must differ from the builder`);
  const panelReviewers = (review.panel?.members || []).map((member) => member?.reviewer);
  if (panelReviewers.some((reviewer) => typeof reviewer !== 'string' || !ACTOR_ID.test(reviewer))) {
    fail(`${label} panel reviewer identities must be explicit and valid`);
  }
  if (panelReviewers.includes(record.source.builder)) fail(`${label} panel reviewers must differ from the builder`);
  if (typeof verification?.verifier !== 'string' || !ACTOR_ID.test(verification.verifier)) {
    fail(`${label} verifier identity must be explicit and valid`);
  }
  if (verification.verifier === record.source.builder
    || verification.verifier === review.reviewer || panelReviewers.includes(verification.verifier)) {
    fail(`${label} verifier must differ from the builder and every reviewer`);
  }
}

function validateFinalizationReceipts(record, gateIdentities, reviewIdentity, verificationIdentity) {
  const declared = Object.entries(record.source.packet.commands).sort(([left], [right]) => left.localeCompare(right));
  if (!Array.isArray(gateIdentities) || gateIdentities.length !== declared.length) {
    fail('legacy finalization gate identities do not cover the declared gates exactly');
  }
  const gates = declared.map(([name, command], index) => {
    const gate = receiptByIdentity(gateReceiptPool(record), gateIdentities[index], `gate ${name}`);
    if (gate.name !== name || gate.command !== command || gate.status !== 'PASS'
      || gate.snapshot_hash !== record.evidence.snapshot_hash || gate.integration_commit !== record.integration.commit
      || gate.cwd !== '.' || gate.environment_additions_hash !== sha256(canonical({}))
      || !HASH.test(gate.environment_hash || '')) fail(`frozen integration gate is missing or failed: ${name}`);
    validateInternalLog(record, gate);
    return gate;
  });
  const review = receiptByIdentity(reviewReceiptPool(record), reviewIdentity, 'review');
  const verification = receiptByIdentity(verificationReceiptPool(record), verificationIdentity, 'verification');
  const reviewSnapshot = review.identity === record.source.review.identity ? record.source.snapshot_hash : record.evidence.snapshot_hash;
  const verificationSnapshot = verification.identity === record.source.verification.identity ? record.source.snapshot_hash : record.evidence.snapshot_hash;
  if (review.status !== 'PASS' || review.snapshot_hash !== reviewSnapshot
    || review.findings.some((item) => !item.resolved && item.severity !== 'minor')) {
    fail('frozen integration review is missing or has unresolved findings');
  }
  if (verification.snapshot_hash !== verificationSnapshot || verification.criteria.some((item) => item.status !== 'PASS')) {
    fail('frozen integration verification is incomplete');
  }
  assertEvidenceActors(record, review, verification, 'frozen integration');
  return { gates, review, verification };
}

function buildFinalization(record, gates, review, verification) {
  const body = {
    version: 'integration-finalization-v1',
    integration_commit: record.integration.commit,
    integration_tree: record.integration.tree,
    snapshot_hash: record.evidence.snapshot_hash,
    manifest_hash: record.manifest.hash,
    gates: gates.map((gate) => ({
      name: gate.name,
      command: gate.command,
      identity: gate.identity,
      log_path: gate.log_path,
      log_hash: gate.log_hash,
      environment_hash: gate.environment_hash,
    })),
    review_identity: review.identity,
    verification_identity: verification.identity,
    reporting: record.reporting,
    reporting_requested: record.reporting_requested,
  };
  return { ...body, identity: sha256(canonical(body)) };
}

function resolveFinalization(record, finalization = record.evidence.finalization) {
  if (!finalization || finalization.version !== 'integration-finalization-v1'
    || finalization.identity !== finalizationIdentity(finalization)
    || finalization.integration_commit !== record.integration.commit
    || finalization.integration_tree !== record.integration.tree
    || finalization.snapshot_hash !== record.evidence.snapshot_hash
    || finalization.manifest_hash !== record.manifest.hash
    || finalization.reporting !== record.reporting
    || finalization.reporting_requested !== record.reporting_requested) {
    fail('integration evidence finalization identity is missing or stale');
  }
  const resolved = validateFinalizationReceipts(record, finalization.gates.map((item) => item.identity),
    finalization.review_identity, finalization.verification_identity);
  const rebuilt = buildFinalization(record, resolved.gates, resolved.review, resolved.verification);
  if (canonical(rebuilt) !== canonical(finalization)) fail('integration evidence finalization provenance is inconsistent');
  return { ...resolved, finalization };
}

function finalizedRecordView(record, resolved) {
  const view = structuredClone(record);
  view.evidence.gates = structuredClone(resolved.gates);
  view.evidence.review = resolved.review.identity === record.source.review.identity ? null : structuredClone(resolved.review);
  view.evidence.verification = resolved.verification.identity === record.source.verification.identity ? null : structuredClone(resolved.verification);
  view.evidence.finalized = true;
  view.evidence.effective_review_identity = resolved.review.identity;
  view.evidence.effective_verification_identity = resolved.verification.identity;
  return view;
}

function assertEvidenceMutable(record) {
  if (artifactStarted(record)) fail('integration evidence is frozen by an artifact preparation or commit');
}

function assertActiveReconciliationEvidence(record) {
  const declared = Object.entries(record.source.packet.commands).sort(([left], [right]) => left.localeCompare(right));
  if (record.evidence.gates.length !== declared.length) {
    fail('LEGACY_ACTIVE_EVIDENCE_MISSING: current gate slots do not cover the declared gates exactly');
  }
  for (const [name, command] of declared) {
    const matches = record.evidence.gates.filter((gate) => gate.name === name && gate.command === command);
    if (matches.length !== 1) {
      fail(`LEGACY_ACTIVE_EVIDENCE_MISSING: current gate slot is missing or ambiguous: ${name}`);
    }
  }
  if (record.evidence.review === null && record.evidence.review_history.length) {
    fail('LEGACY_ACTIVE_EVIDENCE_MISSING: current review pointer is absent after retained review history');
  }
  if (record.evidence.verification === null && record.evidence.verification_history.length) {
    fail('LEGACY_ACTIVE_EVIDENCE_MISSING: current verification pointer is absent after retained verification history');
  }
  const active = assertEvidenceReady(record);
  const reviewSnapshot = record.evidence.review ? record.evidence.snapshot_hash : record.source.snapshot_hash;
  parseReviewReceipt(active.review, { expectedSnapshot: reviewSnapshot });
  parseVerificationResults({ criteria: active.verification.criteria }, record.source.packet.acceptance);
  return active;
}

function legacyFinalizationCandidates(record) {
  const descriptors = [];
  if (record.evidence.finalized) {
    descriptors.push({
      at: record.evidence.finalized_at,
      gateIdentities: Object.entries(record.source.packet.commands).sort(([left], [right]) => left.localeCompare(right))
        .map(([name, command]) => record.evidence.gates.find((item) => item.name === name && item.command === command)?.identity),
      reviewIdentity: record.evidence.effective_review_identity,
      verificationIdentity: record.evidence.effective_verification_identity,
    });
  }
  for (const entry of record.evidence.finalization_history) {
    descriptors.push(entry.finalization
      ? { at: entry.finalized_at || entry.at, finalization: entry.finalization }
      : { at: entry.finalized_at || entry.at, gateIdentities: entry.gates,
        reviewIdentity: entry.review_identity, verificationIdentity: entry.verification_identity });
  }
  const candidates = new Map();
  const errors = [];
  for (const descriptor of descriptors) {
    try {
      const finalization = descriptor.finalization
        ? resolveFinalization(record, descriptor.finalization).finalization
        : (() => {
          const resolved = validateFinalizationReceipts(record, descriptor.gateIdentities,
            descriptor.reviewIdentity, descriptor.verificationIdentity);
          return buildFinalization(record, resolved.gates, resolved.review, resolved.verification);
        })();
      validateIntegrationProofs(record, { legacyFinalization: finalization });
      candidates.set(finalization.identity, { finalization, at: descriptor.at });
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (candidates.size === 0) {
    fail(`LEGACY_FINALIZATION_MISSING: retained evidence does not uniquely prove a valid finalization${errors[0] ? ` (${errors[0]})` : ''}`);
  }
  if (candidates.size !== 1) {
    fail('LEGACY_FINALIZATION_AMBIGUOUS: retained evidence proves more than one artifact-compatible finalization');
  }
  return [...candidates.values()][0];
}

export function reconcileIntegrationEvidence(recordArg, { expectedRecordHash } = {}, cwd = process.cwd()) {
  const loaded = readIntegrationRecord(recordArg, cwd);
  if (!HASH.test(expectedRecordHash || '') || loaded.hash !== expectedRecordHash) fail('integration record hash is missing or stale');
  if (!needsFinalizationReconcile(loaded.record)) fail('integration record does not require legacy finalization reconciliation');
  const lock = `${loaded.file}.lock`;
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') fail('integration record is locked');
    throw error;
  }
  try {
    const current = readIntegrationRecord(loaded.file);
    if (current.hash !== expectedRecordHash) fail('integration record changed concurrently');
    assertRecordSource(current.record);
    assertActiveReconciliationEvidence(current.record);
    const selected = legacyFinalizationCandidates(current.record);
    const before = structuredClone(current.record);
    current.record.evidence.finalization = selected.finalization;
    current.record.evidence.finalized = true;
    current.record.evidence.finalized_at = selected.at || now();
    current.record.evidence.effective_review_identity = selected.finalization.review_identity;
    current.record.evidence.effective_verification_identity = selected.finalization.verification_identity;
    current.record.evidence.reconciliation_history ||= [];
    current.record.evidence.reconciliation_history.push({ at: now(), before_hash: recordHash(before), before });
    for (const field of ['report', 'closure', 'handoff']) {
      for (const proof of [current.record[field].pending, current.record[field].proof].filter(Boolean)) {
        proof.finalization_identity = selected.finalization.identity;
      }
    }
    current.record.revision += 1;
    current.record.updated_at = now();
    validateRecord(current.record);
    validateIntegrationProofs(current.record);
    const after = json(current.record);
    if (Buffer.byteLength(after) > MAX_RECORD_BYTES) fail('LEGACY_FINALIZATION_TOO_LARGE: archived before-image would exceed the bounded integration record size');
    atomic(current.file, after);
    return { file: current.file, record: current.record, hash: recordHash(current.record),
      result: { finalization: selected.finalization.identity, before_hash: recordHash(before) } };
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(lock); } catch {}
  }
}

function assertSourceRun(state) {
  if (state.phase !== 'finished' || state.pm_binding?.format !== 'current' || !state.completion_snapshot) {
    fail('local integration requires a finished current-bound source run');
  }
  assertCurrentBinding(state);
  if (state.review?.status !== 'PASS' || state.review.findings.some((item) => !item.resolved && item.severity !== 'minor')
    || state.verification?.criteria.some((item) => item.status !== 'PASS')) fail('source C lacks complete independent evidence');
  if (state.verification.verifier === state.task.builder || state.verification.verifier === state.review.reviewer) {
    fail('current source verifier must differ from builder and reviewer');
  }
  if (state.git_anchor?.head !== state.commit_adoption?.history?.at(-1)?.commit) fail('source C is not the final adopted candidate');
}

function assertRecordSource(record) {
  const loaded = readRun(record.source.run_path);
  const state = loaded.state;
  assertSourceRun(state);
  if (state.run_id !== record.source.run_id || state.project_root !== record.source.root
    || state.pm_binding.story !== record.source.story || state.pm_binding.story_path !== record.source.story_path
    || state.pm_binding.contract_hash !== record.source.contract_hash || state.pm_binding.execution_hash !== record.source.execution_hash
    || state.pm_binding.actor !== record.source.actor || state.pm_binding.branch !== record.source.branch
    || state.git_anchor.head !== record.source.candidate || tree(state.project_root, record.source.candidate) !== record.source.tree
    || state.completion_snapshot.hash !== record.source.snapshot_hash
    || canonical(state.task.packet) !== canonical(record.source.packet)
    || canonical(state.counters) !== canonical(record.source.counters)
    || record.source.review.identity !== receiptIdentity(state.review)
    || record.source.verification.identity !== receiptIdentity(state.verification)
    || canonical(record.source.gates) !== canonical(state.gates.map((item) => ({ ...item, identity: receiptIdentity(item) })))) {
    fail('integration record no longer matches immutable source C');
  }
  const policy = readPlanPolicy(state.project_root);
  if ((policy?.scale || 'standard') !== record.plan.scale || policy?.integrationBranch !== record.plan.integration_branch
    || state.pm_binding.plan_digest !== record.plan.approval_digest
    || record.destination.branch !== record.plan.integration_branch
    || commonRepository(state.project_root) !== record.destination.common_repository) {
    fail('integration record no longer matches the approved plan or repository');
  }
  if (head(state.project_root) !== record.source.candidate || branch(state.project_root) !== record.source.branch) fail('finished source checkout no longer remains at C');
  const manifest = boundManifest(state.project_root, record.source.candidate, state.task.packet,
    state.pm_binding.story_path, sourceBindings(state));
  const normalizedSource = normalizeSnapshotGitlinks(state.project_root, manifest, state.completion_snapshot.entries, { strict: false });
  const sourceSnapshotManifest = snapshotManifest(manifest, normalizedSource);
  if (canonical(manifest) !== canonical(record.source.manifest)
    || canonical(sourceSnapshotManifest) !== canonical(record.source.snapshot_manifest)) {
    fail('integration record no longer matches immutable source manifests');
  }
  if (record.integration.status === 'failed') {
    if (!hasReceiptIdentity(record.integration.failure)) fail('failed merge probe identity is invalid');
    validateInternalLog(record, record.integration.failure);
  }
  return state;
}

export function prepareLocalIntegration(runArg, { integrationRoot = process.cwd(), verificationReport = false } = {}, cwd = process.cwd()) {
  const loaded = readRun(runArg, cwd);
  const state = loaded.state;
  assertSourceRun(state);
  const sourceRoot = rootPath(state.project_root);
  integrationRoot = rootPath(integrationRoot);
  if (commonRepository(sourceRoot) !== commonRepository(integrationRoot)) fail('source and integration checkouts are not in the same repository');
  const policy = readPlanPolicy(sourceRoot);
  const scale = policy?.scale || 'standard';
  const integrationBranch = policy?.integrationBranch;
  if (!integrationBranch || branch(integrationRoot) !== integrationBranch) fail('check out the approved integration branch before preparing a merge');
  assertClean(integrationRoot);
  assertOrdinaryIndex(integrationRoot);
  const base = head(integrationRoot);
  const baseAnchor = captureGitAnchor(integrationRoot);
  const baseCheckoutProof = buildCheckoutProof(integrationRoot, base, baseAnchor);
  verifyCheckoutProof(integrationRoot, base, baseCheckoutProof, baseAnchor);
  if (branch(sourceRoot) !== state.pm_binding.branch || head(sourceRoot) !== state.git_anchor.head) fail('source checkout no longer identifies candidate C');
  const candidate = state.git_anchor.head;
  try {
    execFileSync('git', ['-C', integrationRoot, 'merge-base', '--is-ancestor', candidate, base], { stdio: 'ignore' });
    fail('candidate C is already an ancestor of the integration branch');
  } catch (error) { if (error instanceof DeliverError) throw error; }
  const sourceManifest = boundManifest(sourceRoot, candidate, state.task.packet, state.pm_binding.story_path, sourceBindings(state));
  const normalizedSource = normalizeSnapshotGitlinks(sourceRoot, sourceManifest, state.completion_snapshot.entries, { strict: false });
  const sourceSnapshotManifest = snapshotManifest(sourceManifest, normalizedSource);
  const sourceMismatches = manifestMismatches(sourceManifest, sourceSnapshotManifest);
  const governance = new Set([state.pm_binding.story_path, 'docs/plan.md', 'docs/approval.json']);
  const governanceDrift = sourceMismatches.filter((rel) => governance.has(rel));
  if (governanceDrift.length) fail(`approved story or plan bytes differ from candidate C: ${governanceDrift.join(', ')}`);
  const reportingRequested = scale === 'standard' && verificationReport === true;
  const reporting = expectedReporting(scale, reportingRequested);
  const id = state.run_id;
  const file = recordPath(integrationRoot, id, { create: true });
  if (fs.existsSync(file)) {
    const existing = readIntegrationRecord(file);
    assertRecordSource(existing.record);
    validateIntegrationProofs(existing.record);
    if (existing.record.source.run_id !== state.run_id || existing.record.source.candidate !== candidate
      || existing.record.destination.root !== integrationRoot || existing.record.reporting !== reporting
      || existing.record.reporting_requested !== reportingRequested) {
      fail('existing integration preparation does not match this source run or reporting contract');
    }
    if (existing.record.integration.status === 'prepared') {
      if (head(integrationRoot) !== existing.record.integration.base) fail('prepared integration base is no longer current');
      verifyCheckoutProof(integrationRoot, existing.record.integration.base, existing.record.integration.base_checkout_proof);
      if (expectedMergeTree(integrationRoot, base, candidate) !== existing.record.integration.expected_tree) fail('prepared clean merge tree changed');
    }
    return { file, record: existing.record, hash: existing.hash, resumed: true };
  }
  const probe = probeMergeTree(integrationRoot, base, candidate);
  const mergedManifest = probe.ok
    ? boundManifest(integrationRoot, probe.tree, state.task.packet, state.pm_binding.story_path, sourceManifest.bindings)
    : null;
  const checkoutProof = probe.ok ? buildCheckoutProof(integrationRoot, probe.tree) : null;
  const mergeGovernanceDrift = mergedManifest ? manifestMismatches(sourceManifest, mergedManifest).filter((rel) => governance.has(rel)) : [];
  if (mergeGovernanceDrift.length) fail(`clean composition changes approved story or plan bytes: ${mergeGovernanceDrift.join(', ')}`);
  const review = { ...structuredClone(state.review), identity: receiptIdentity(state.review) };
  const verification = { ...structuredClone(state.verification), identity: receiptIdentity(state.verification) };
  let failure = null;
  if (!probe.ok) {
    const logDir = internalDirectory(integrationRoot, ['logs', `integration-${id}`]);
    const logFile = path.join(logDir, `merge-tree-${randomUUID()}.log`);
    fs.writeFileSync(logFile, probe.log, { flag: 'wx', mode: 0o600 });
    failure = { ...probe.attempt, log_path: path.relative(integrationRoot, logFile).split(path.sep).join('/'), log_hash: sha256(probe.log) };
    failure.identity = receiptIdentity(failure);
  }
  const sourceReusable = Boolean(mergedManifest) && sourceMismatches.length === 0
    && manifestMismatches(sourceManifest, mergedManifest).length === 0;
  const record = {
    schema_version: 1,
    kind: 'local-integration-v1',
    id,
    revision: 0,
    created_at: now(),
    updated_at: now(),
    source: {
      run_id: state.run_id, run_path: loaded.file, root: sourceRoot, story: state.pm_binding.story,
      story_path: state.pm_binding.story_path, contract_hash: state.pm_binding.contract_hash,
      execution_hash: state.pm_binding.execution_hash, candidate, tree: tree(sourceRoot, candidate),
      snapshot_hash: state.completion_snapshot.hash, builder: state.task.builder,
      actor: state.pm_binding.actor, branch: state.pm_binding.branch,
      packet: structuredClone(state.task.packet), counters: structuredClone(state.counters),
      review, verification, gates: state.gates.map((item) => ({ ...structuredClone(item), identity: receiptIdentity(item) })),
      manifest: sourceManifest, snapshot_manifest: sourceSnapshotManifest,
    },
    plan: { scale, integration_branch: integrationBranch, approval_digest: state.pm_binding.plan_digest },
    destination: { root: integrationRoot, common_repository: commonRepository(integrationRoot), branch: integrationBranch },
    integration: {
      status: probe.ok ? 'prepared' : 'failed', token: probe.ok ? randomUUID() : null, base, candidate,
      base_anchor: baseAnchor, base_checkout_proof: baseCheckoutProof, expected_tree: probe.tree,
      manifest: mergedManifest, checkout_proof: checkoutProof, failure,
      commit: null, tree: null, anchor: null, executable_snapshot_hash: null, adopted_at: null,
    },
    manifest: mergedManifest,
    reporting,
    reporting_requested: reportingRequested,
    preparation: { identity: null },
    evidence: {
      source_reusable: sourceReusable,
      reuse_mismatches: [...new Set([...sourceMismatches, ...(mergedManifest ? manifestMismatches(sourceManifest, mergedManifest) : [])])].sort(),
      snapshot_hash: null, gates: [], gate_history: [], review: null, review_history: [], verification: null,
      verification_history: [], finalization_history: [], finalized: false, finalized_at: null,
      effective_review_identity: null, effective_verification_identity: null,
      finalization: null, reconciliation_history: [],
    },
    report: { pending: null, commit: null, proof: null },
    closure: { pending: null, commit: null, proof: null, execution_hash: null },
    handoff: { pending: null, commit: null, proof: null, path: `docs/handoff/${state.pm_binding.actor}.md` },
  };
  record.preparation.identity = preparationIdentity(record);
  atomic(file, json(record));
  return { file, record, hash: recordHash(record), resumed: false };
}

function assertIntegrationHead(record, { requireCommit = true } = {}) {
  const root = rootPath(record.destination.root);
  if (commonRepository(root) !== record.destination.common_repository || branch(root) !== record.destination.branch) fail('integration checkout identity or branch changed');
  if (requireCommit && head(root) !== record.integration.commit) fail('integration checkout is not at recorded M');
  assertClean(root);
  return root;
}

function destinationRoot(record) {
  const root = rootPath(record.destination.root);
  if (commonRepository(root) !== record.destination.common_repository || branch(root) !== record.destination.branch) {
    fail('integration checkout identity or branch changed');
  }
  return root;
}

export function adoptLocalIntegration(recordArg, { expectedRecordHash, token, commit } = {}, cwd = process.cwd()) {
  return withRecord(recordArg, expectedRecordHash, (record) => {
    if (record.integration.status !== 'prepared' || token !== record.integration.token || !OID.test(commit || '')) fail('merge adoption token or commit is invalid');
    const root = rootPath(record.destination.root);
    if (branch(root) !== record.destination.branch || head(root) !== commit) fail('integration checkout is not at the supplied merge commit');
    const parents = String(git(root, ['rev-list', '--parents', '-n', '1', commit])).trim().split(/\s+/);
    if (parents.length !== 3 || parents[1] !== record.integration.base || parents[2] !== record.source.candidate) {
      fail('local integration must be the prepared no-ff merge of I and C');
    }
    if (expectedMergeTree(root, record.integration.base, record.source.candidate) !== record.integration.expected_tree) {
      fail('prepared clean merge proof no longer matches I and C');
    }
    if (tree(root, commit) !== record.integration.expected_tree) fail('actual merge tree differs from the prepared clean composition');
    const manifest = boundManifest(root, commit, record.source.packet, record.source.story_path, record.integration.manifest.bindings);
    if (canonical(manifest) !== canonical(record.integration.manifest)) fail('actual M manifest differs from its prepared composition');
    const proof = executableProof(root, manifest, commit, record.integration.checkout_proof);
    if (canonical(protectedShape(proof.anchor)) !== canonical(protectedShape(record.integration.base_anchor))) {
      fail('protected Git metadata changed between integration preparation and adoption');
    }
    record.integration.status = 'adopted';
    record.integration.commit = commit;
    record.integration.tree = tree(root, commit);
    record.integration.anchor = proof.anchor;
    record.integration.executable_snapshot_hash = proof.snapshot_hash;
    record.integration.adopted_at = now();
    record.manifest = record.integration.manifest;
    record.evidence.snapshot_hash = integrationIdentity(record);
    return record.integration;
  }, cwd);
}

function recheckM(record) {
  if (record.integration.status !== 'adopted') fail('actual integration M has not been adopted');
  const root = assertIntegrationHead(record);
  if (tree(root) !== record.integration.tree) fail('integration tree changed after adoption');
  const parents = String(git(root, ['rev-list', '--parents', '-n', '1', record.integration.commit])).trim().split(/\s+/);
  if (parents.length !== 3 || parents[1] !== record.integration.base || parents[2] !== record.source.candidate
    || expectedMergeTree(root, record.integration.base, record.source.candidate) !== record.integration.expected_tree
    || record.integration.tree !== record.integration.expected_tree) fail('recorded M is no longer the exact clean I plus C composition');
  const manifest = boundManifest(root, record.integration.commit, record.source.packet, record.source.story_path,
    record.integration.manifest.bindings);
  if (canonical(manifest) !== canonical(record.integration.manifest)) fail('integration manifest changed after adoption');
  if (integrationIdentity(record) !== record.evidence.snapshot_hash) fail('integration evidence snapshot identity is invalid');
  return root;
}

function assertExecutableM(record) {
  const root = recheckM(record);
  const proof = executableProof(root, record.integration.manifest, record.integration.commit, record.integration.checkout_proof);
  if (canonical(proof.anchor) !== canonical(record.integration.anchor)
    || proof.snapshot_hash !== record.integration.executable_snapshot_hash) {
    fail('integration executable checkout or protected metadata differs from adopted M');
  }
  return root;
}

function invalidateFinalization(record, reason) {
  if (!record.evidence.finalized) return;
  record.evidence.finalization_history.push({
    at: now(), reason, finalized_at: record.evidence.finalized_at,
    snapshot_hash: record.evidence.snapshot_hash,
    review_identity: record.evidence.effective_review_identity,
    verification_identity: record.evidence.effective_verification_identity,
    gates: record.evidence.gates.map((item) => item.identity),
    ...(record.evidence.finalization ? { finalization: structuredClone(record.evidence.finalization) } : {}),
  });
  record.evidence.finalized = false;
  record.evidence.finalized_at = null;
  record.evidence.effective_review_identity = null;
  record.evidence.effective_verification_identity = null;
  record.evidence.finalization = null;
}

function validateInternalLog(record, receipt) {
  const rel = receipt?.log_path;
  const directory = `.deliver/logs/integration-${record.id}`;
  if (typeof rel !== 'string' || path.posix.dirname(rel) !== directory
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.log$/.test(path.posix.basename(rel)) || !HASH.test(receipt.log_hash || '')) {
    fail('integration evidence log path or hash is invalid');
  }
  const root = rootPath(record.destination.root);
  const file = path.join(root, ...rel.split('/'));
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { fail(`integration evidence log is unreadable: ${error.message}`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024
    || fs.realpathSync.native(file) !== file) fail('integration evidence log must be a bounded canonical regular file');
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== receipt.log_hash) fail('integration evidence log bytes changed');
}

export function runIntegrationGate(recordArg, { expectedRecordHash, name } = {}, cwd = process.cwd()) {
  return withRecord(recordArg, expectedRecordHash, (record) => {
    assertEvidenceMutable(record);
    const command = record.source.packet.commands?.[name];
    if (typeof command !== 'string') fail('integration gate name is not declared by the source task');
    const root = assertExecutableM(record);
    const logDir = internalDirectory(root, ['logs', `integration-${record.id}`]);
    const log = path.join(logDir, `${name}-${randomUUID()}.log`);
    const started = now();
    const result = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024, windowsHide: true });
    let stable = true;
    let proofError = null;
    try { assertExecutableM(record); } catch (error) { stable = false; proofError = error.message; }
    const environmentAdditionsHash = sha256(canonical({}));
    const receipt = {
      provenance: 'deliver-integration-gate-v1', name, command, integration_commit: record.integration.commit,
      snapshot_hash: record.evidence.snapshot_hash, status: result.status === 0 && !result.error && stable ? 'PASS' : 'FAIL',
      cwd: '.', environment_keys: [], environment_additions_hash: environmentAdditionsHash,
      environment_hash: environmentHandle(root, environmentAdditionsHash),
      exit_code: result.status, signal: result.signal || null, error: result.error?.message || proofError,
      started_at: started, finished_at: now(),
      output: { stdout_bytes: Buffer.byteLength(result.stdout || ''), stderr_bytes: Buffer.byteLength(result.stderr || '') },
    };
    const logText = `command: ${command}\nstarted: ${started}\nexit: ${result.status}\n\n[stdout]\n${result.stdout || ''}\n[stderr]\n${result.stderr || ''}`;
    fs.writeFileSync(log, logText, { flag: 'wx', mode: 0o600 });
    receipt.log_path = path.relative(root, log).split(path.sep).join('/');
    receipt.log_hash = sha256(logText);
    receipt.identity = receiptIdentity(receipt);
    invalidateFinalization(record, `gate ${name} changed`);
    const previous = record.evidence.gates.find((item) => item.name === name);
    if (previous) record.evidence.gate_history.push(previous);
    record.evidence.gates = record.evidence.gates.filter((item) => item.name !== name);
    record.evidence.gates.push(receipt);
    return receipt;
  }, cwd);
}

export function recordIntegrationReview(recordArg, { expectedRecordHash, reviewer, receipt } = {}, cwd = process.cwd()) {
  return withRecord(recordArg, expectedRecordHash, (record) => {
    assertEvidenceMutable(record);
    assertExecutableM(record);
    validateGateReceipts(record);
    if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(reviewer || '') || reviewer === record.source.builder) fail('integration reviewer must be explicit and differ from the builder');
    const parsed = parseReviewReceipt(receipt, { expectedSnapshot: record.evidence.snapshot_hash });
    if (parsed.panel?.members.some((member) => member.reviewer === record.source.builder)) fail('review panel members must differ from the builder');
    const value = { ...parsed, reviewer, snapshot_hash: record.evidence.snapshot_hash, recorded_at: now() };
    value.identity = receiptIdentity(value);
    invalidateFinalization(record, 'integration review changed');
    if (record.evidence.review) record.evidence.review_history.push(record.evidence.review);
    record.evidence.review = value;
    return value;
  }, cwd);
}

export function recordIntegrationVerification(recordArg, { expectedRecordHash, verifier, results } = {}, cwd = process.cwd()) {
  return withRecord(recordArg, expectedRecordHash, (record) => {
    assertEvidenceMutable(record);
    assertExecutableM(record);
    validateGateReceipts(record);
    const review = record.evidence.review || record.source.review;
    const reviewers = new Set([review.reviewer, ...(review.panel?.members || []).map((item) => item.reviewer)]);
    if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(verifier || '') || verifier === record.source.builder || reviewers.has(verifier)) {
      fail('integration verifier must differ from builder and every reviewer');
    }
    const criteria = parseVerificationResults(results, record.source.packet.acceptance);
    const value = { verifier, criteria, snapshot_hash: record.evidence.snapshot_hash, recorded_at: now() };
    value.identity = receiptIdentity(value);
    invalidateFinalization(record, 'integration verification changed');
    if (record.evidence.verification) record.evidence.verification_history.push(record.evidence.verification);
    record.evidence.verification = value;
    return value;
  }, cwd);
}

function effectiveEvidence(record) {
  if (!record.evidence.source_reusable && (!record.evidence.review || !record.evidence.verification)) {
    fail('changed integration inputs require fresh independent M review and verification');
  }
  const review = record.evidence.review || record.source.review;
  const verification = record.evidence.verification || record.source.verification;
  return { review, verification };
}

function validateGateReceipts(record) {
  for (const gate of [...record.evidence.gates, ...record.evidence.gate_history]) {
    if (!hasReceiptIdentity(gate)) fail('integration gate receipt identity is invalid');
    validateInternalLog(record, gate);
  }
}

function assertEvidenceReady(record, { finalized = false } = {}) {
  if (finalized) {
    const resolved = resolveFinalization(record);
    return { ...resolved, view: finalizedRecordView(record, resolved) };
  }
  validateGateReceipts(record);
  for (const [name, command] of Object.entries(record.source.packet.commands)) {
    const gate = record.evidence.gates.find((item) => item.name === name && item.command === command);
    if (!gate || !hasReceiptIdentity(gate) || gate.status !== 'PASS' || gate.snapshot_hash !== record.evidence.snapshot_hash
      || gate.integration_commit !== record.integration.commit || gate.cwd !== '.'
      || gate.environment_additions_hash !== sha256(canonical({}))
      || !HASH.test(gate.environment_hash || '')) {
      fail(`fresh integration gate is missing or failed: ${name}`);
    }
  }
  const { review, verification } = effectiveEvidence(record);
  const reviewSnapshot = record.evidence.review ? record.evidence.snapshot_hash : record.source.snapshot_hash;
  const verificationSnapshot = record.evidence.verification ? record.evidence.snapshot_hash : record.source.snapshot_hash;
  if (!review || !hasReceiptIdentity(review) || review.status !== 'PASS'
    || review.snapshot_hash !== reviewSnapshot
    || review.findings.some((item) => !item.resolved && item.severity !== 'minor')) {
    fail('integration has unresolved review findings');
  }
  if (!verification || !hasReceiptIdentity(verification) || verification.snapshot_hash !== verificationSnapshot
    || verification.criteria.some((item) => item.status !== 'PASS')) {
    fail('integration acceptance verification is incomplete');
  }
  assertEvidenceActors(record, review, verification);
  return { review, verification };
}

export function finalizeIntegrationEvidence(recordArg, { expectedRecordHash } = {}, cwd = process.cwd()) {
  return withRecord(recordArg, expectedRecordHash, (record) => {
    const { review, verification } = assertEvidenceReady(record);
    const gates = Object.entries(record.source.packet.commands).sort(([left], [right]) => left.localeCompare(right))
      .map(([name, command]) => record.evidence.gates.find((item) => item.name === name && item.command === command));
    const finalization = buildFinalization(record, gates, review, verification);
    const value = { snapshot_hash: record.evidence.snapshot_hash, review: review.identity,
      verification: verification.identity, finalization: finalization.identity };
    if (record.evidence.finalized && canonical(record.evidence.finalization) === canonical(finalization)) {
      return { [NO_MUTATION]: true, value };
    }
    assertEvidenceMutable(record);
    assertExecutableM(record);
    record.evidence.finalized = true;
    record.evidence.finalized_at = now();
    record.evidence.effective_review_identity = review.identity;
    record.evidence.effective_verification_identity = verification.identity;
    record.evidence.finalization = finalization;
    return value;
  }, cwd);
}

function safeTrackedPath(rel) {
  if (typeof rel !== 'string' || path.isAbsolute(rel) || /[\x00-\x1f\x7f]/.test(rel)
    || rel.split('/').some((item) => !item || item === '.' || item === '..')
    || !/^(?:docs\/verification\/S\d+-\d+\.md|docs\/checklists\/verification-S\d+-\d+\.md|docs\/stories\/S\d+-\d+-[^/]+\.md|docs\/handoff\/[a-z0-9-]+\.md)$/.test(rel)) {
    fail(`unsafe integration artifact path: ${rel}`);
  }
  return rel;
}

function artifactFile(root, rel) {
  safeTrackedPath(rel);
  let cursor = root;
  for (const part of rel.split('/')) {
    cursor = path.join(cursor, part);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) fail(`integration artifact path is a symlink: ${rel}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return path.join(root, rel);
}

function readArtifact(root, rel) {
  const file = artifactFile(root, rel);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) fail(`invalid integration artifact: ${rel}`);
    return fs.readFileSync(file, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function writeArtifact(root, rel, content) {
  const file = artifactFile(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomic(file, content);
}

function applyPending(root, pending) {
  for (const write of pending.writes) {
    const current = readArtifact(root, write.path);
    if (current !== write.before && current !== write.after) fail(`integration artifact changed concurrently: ${write.path}`);
  }
  for (const write of pending.writes) if (readArtifact(root, write.path) !== write.after) writeArtifact(root, write.path, write.after);
}

function handoffFinding(value) {
  return String(value).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000);
}

function openFindingLines(record, review = effectiveEvidence(record).review) {
  const reviews = [{ label: 'source C', value: record.source.review }];
  if (review.identity !== record.source.review.identity) reviews.push({ label: 'effective M', value: review });
  const findings = reviews.flatMap(({ label, value }) => value.findings
    .filter((item) => !item.resolved).map((item) => ({ ...item, evidence_label: label, evidence_reviewer: value.reviewer })));
  if (!findings.length) return ['OPEN_FINDINGS: none'];
  return ['OPEN_FINDINGS:', ...findings.map((item) => `- [${item.severity}] ${item.evidence_label} · ${handoffFinding(item.lens || 'general')} / ${handoffFinding(item.reviewer || item.evidence_reviewer || 'unknown')}: ${handoffFinding(item.message)}`)];
}

function handoffContent(record, at, next, review) {
  return [
    `# HANDOFF ${at}`,
    '',
    `OBJECTIVE: ${record.source.story} completed`,
    `APPROVAL: approved · SCALE: ${record.plan.scale}`,
    `POSITION: story ${record.source.story} · status merged · rounds ${record.source.counters.fixes}/3 · retries ${record.source.counters.retries}/2 · verification: PASS`,
    '',
    `BASE_COMMIT: ${record.closure.commit}`,
    `BRANCH: ${record.destination.branch} · INTEGRATION: ${record.destination.branch} · UNCOMMITTED: none`,
    `READ_FIRST: ${record.source.story_path}, docs/plan.md`,
    'DONE_THIS_RUN:',
    `- Integrated candidate ${record.source.candidate} at M ${record.integration.commit}; closed at E ${record.closure.commit}.`,
    ...openFindingLines(record, review),
    'NEXT (ordered):',
    `1. ${next}`,
    '',
  ].join('\n');
}

function commitParents(root, commit) {
  return String(git(root, ['rev-list', '--parents', '-n', '1', commit])).trim().split(/\s+/).slice(1);
}

function commitEntry(root, commit, rel) {
  const raw = String(git(root, ['ls-tree', '-z', commit, '--', rel])).split('\0').filter(Boolean);
  if (raw.length !== 1) fail(`integration artifact is absent from commit: ${rel}`);
  const match = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.+)$/.exec(raw[0]);
  if (!match || match[2] !== 'blob' || match[4] !== rel) fail(`integration artifact commit entry is invalid: ${rel}`);
  return { mode: match[1], oid: match[3] };
}

function committedText(root, commit, rel) {
  try { return git(root, ['show', `${commit}:${rel}`], { buffer: true }).toString('utf8'); }
  catch { return null; }
}

function validateAdoptedArtifact(record, field, options) {
  const stage = record[field];
  if (!OID.test(stage.commit || '') || !stage.proof || stage.pending !== null
    || stage.proof.commit !== stage.commit || tree(record.destination.root, stage.commit) !== stage.proof.tree
    || canonical(commitParents(record.destination.root, stage.commit)) !== canonical([stage.proof.parent])) {
    fail(`${field} adopted commit proof is invalid`);
  }
  validateArtifactPending(record, field, stage.proof, options);
  const changed = String(git(record.destination.root, ['diff-tree', '--no-commit-id', '--name-only', '-r', stage.proof.parent, stage.commit, '--']))
    .trim().split(/\r?\n/).filter(Boolean).sort();
  const paths = stage.proof.writes.map((item) => item.path).sort();
  if (canonical(changed) !== canonical(paths)) fail(`${field} adopted commit changes unprepared paths`);
  for (const write of stage.proof.writes) {
    const entry = commitEntry(record.destination.root, stage.commit, write.path);
    if (entry.mode !== write.mode || entry.oid !== write.oid || committedText(record.destination.root, stage.commit, write.path) !== write.after
      || committedText(record.destination.root, stage.proof.parent, write.path) !== write.before) {
      fail(`${field} adopted bytes, mode or parent image changed`);
    }
  }
}

function validateIntegrationProofs(record, { legacyFinalization = null } = {}) {
  const root = rootPath(record.destination.root);
  if (commonRepository(root) !== record.destination.common_repository) fail('integration repository identity changed');
  if (record.integration.base_anchor?.head !== record.integration.base
    || record.integration.base_anchor?.tree !== tree(root, record.integration.base)
    || record.integration.base_anchor?.ref !== `refs/heads/${record.destination.branch}`) {
    fail('integration base I identity is invalid');
  }
  validateCheckoutProofObjects(root, record.integration.base, record.integration.base_checkout_proof);
  const mismatches = [...new Set([
    ...manifestMismatches(record.source.manifest, record.source.snapshot_manifest),
    ...(record.integration.manifest ? manifestMismatches(record.source.manifest, record.integration.manifest) : []),
  ])].sort();
  const reusable = record.integration.manifest !== null && mismatches.length === 0;
  if (record.evidence.source_reusable !== reusable || canonical(record.evidence.reuse_mismatches) !== canonical(mismatches)
    || (record.integration.manifest && canonical(record.manifest) !== canonical(record.integration.manifest))) {
    fail('integration evidence reusability or manifest binding is invalid');
  }
  if (record.integration.status === 'prepared') {
    if (expectedMergeTree(root, record.integration.base, record.source.candidate) !== record.integration.expected_tree) {
      fail('prepared integration composition changed');
    }
    validateCheckoutProofObjects(root, record.integration.expected_tree, record.integration.checkout_proof);
  } else if (record.integration.status === 'failed') {
    if (record.integration.failure.integration !== record.integration.base
      || record.integration.failure.candidate !== record.source.candidate
      || canonical(record.integration.failure.argv) !== canonical(['git', '-C', root, 'merge-tree', '--write-tree', record.integration.base, record.source.candidate])
      || typeof record.integration.failure.git_version !== 'string' || !record.integration.failure.git_version.startsWith('git version ')
      || (record.integration.failure.status !== null && !Number.isInteger(record.integration.failure.status))
      || record.integration.failure.status === 0
      || (record.integration.failure.status === null && typeof record.integration.failure.error !== 'string')
      || !HASH.test(record.integration.failure.stdout_hash || '') || !HASH.test(record.integration.failure.stderr_hash || '')
      || Number.isNaN(Date.parse(record.integration.failure.started_at)) || Number.isNaN(Date.parse(record.integration.failure.finished_at))) {
      fail('failed merge probe is not bound to its actual I/C attempt');
    }
  } else if (record.integration.status === 'adopted') {
    const parents = commitParents(root, record.integration.commit);
    if (canonical(parents) !== canonical([record.integration.base, record.source.candidate])
      || tree(root, record.integration.commit) !== record.integration.tree
      || record.integration.tree !== record.integration.expected_tree
      || expectedMergeTree(root, record.integration.base, record.source.candidate) !== record.integration.expected_tree) {
      fail('adopted integration M topology changed');
    }
    validateCheckoutProofObjects(root, record.integration.commit, record.integration.checkout_proof);
    const manifest = boundManifest(root, record.integration.commit, record.source.packet, record.source.story_path,
      record.integration.manifest.bindings);
    if (canonical(manifest) !== canonical(record.integration.manifest)
      || integrationIdentity(record) !== record.evidence.snapshot_hash) fail('adopted integration M manifest changed');
  }
  for (const field of ['report', 'closure', 'handoff']) {
    if (record[field].commit !== null) validateAdoptedArtifact(record, field, { legacyFinalization });
    else if (record[field].proof !== null) fail(`${field} proof exists without an adopted commit`);
    if (record[field].pending !== null) validateArtifactPending(record, field, record[field].pending, { legacyFinalization });
  }
  if (record.report.commit && record.reporting === 'skipped') fail('report P exists for a skipped reporting contract');
  if (record.closure.commit && record.reporting !== 'skipped' && !record.report.commit) fail('closure E bypasses required report P');
  if (record.handoff.commit && !record.closure.commit) fail('handoff H exists without closure E');
}

function validateArtifactPending(record, field, pending, { legacyFinalization = null } = {}) {
  if (!pending || !OID.test(pending.parent) || !Array.isArray(pending.writes) || !pending.writes.length
    || !pending.writes.every((write) => typeof write.path === 'string' && (write.before === null || typeof write.before === 'string')
      && typeof write.after === 'string' && write.hash === sha256(write.after))) fail(`invalid ${field} preparation`);
  const resolved = resolveFinalization(record, legacyFinalization || record.evidence.finalization);
  if (pending.finalization_identity !== resolved.finalization.identity
    && !(legacyFinalization && pending.finalization_identity === undefined)) {
    fail(`${field} preparation is not bound to the frozen finalization`);
  }
  const view = finalizedRecordView(record, resolved);
  if (field === 'report') {
    const { review, verification } = resolved;
    const story = parseStory(String(git(record.destination.root, ['show', `${pending.parent}:${record.source.story_path}`])), record.source.story_path);
    const artifacts = renderVerificationArtifacts(view, story, review, verification);
    const expected = {
      [`docs/verification/${record.source.story}.md`]: artifacts.report,
      [`docs/checklists/verification-${record.source.story}.md`]: artifacts.checklist,
    };
    if (pending.parent !== record.integration.commit || pending.writes.length !== 2
      || pending.writes.some((write) => write.before !== null || expected[write.path] !== write.after)) fail('report preparation no longer matches finalized evidence');
  } else if (field === 'closure') {
    if (pending.writes.length !== 1 || pending.writes[0].path !== record.source.story_path
      || typeof pending.writes[0].before !== 'string') fail('closure preparation must contain only the existing bound story');
    const expectedParent = record.report.commit || record.integration.commit;
    if (pending.parent !== expectedParent || (record.reporting !== 'skipped' && !record.report.commit)) {
      fail('closure preparation does not follow the required evidence commit');
    }
    const before = parseStory(pending.writes[0].before, record.source.story_path);
    const after = parseStory(pending.writes[0].after, record.source.story_path);
    if (before.contractHash !== record.source.contract_hash || before.executionHash !== record.source.execution_hash
      || after.execution?.status !== 'merged' || typeof after.execution.updated !== 'string') fail('closure preparation changed the story contract or source execution');
    const generated = replaceStoryExecution(before, { status: 'merged', updated: after.execution.updated }, {
      note: `${after.execution.updated} integrated at ${record.integration.commit}`,
    });
    if (generated.after !== pending.writes[0].after || generated.executionHash !== record.closure.execution_hash) fail('closure preparation is not the exact legal Execution transition');
  } else if (field === 'handoff') {
    if (pending.parent !== record.closure.commit || pending.writes.length !== 1 || pending.writes[0].path !== record.handoff.path
      || pending.writes[0].after !== handoffContent(view, pending.handoff_at, pending.next, resolved.review)) fail('handoff preparation no longer matches closure E');
  }
}

function prepareArtifacts(recordArg, expectedRecordHash, field, build, cwd) {
  const updated = withRecord(recordArg, expectedRecordHash, (record) => {
    const root = destinationRoot(record);
    if (record[field].commit) fail(`${field} commit is already adopted`);
    if (record[field].pending) {
      if (head(root) !== record[field].pending.parent) fail(`${field} pending parent is no longer current`);
      validateArtifactPending(record, field, record[field].pending);
      const allowed = new Set(record[field].pending.writes.map((item) => item.path));
      const extra = statusPaths(root).filter((rel) => !allowed.has(rel));
      if (extra.length) fail(`${field} recovery found unrelated worktree changes: ${extra.sort().join(', ')}`);
      applyPending(root, record[field].pending);
      return record[field].pending;
    }
    assertClean(root);
    const pending = build(record, root);
    pending.finalization_identity = resolveFinalization(record).finalization.identity;
    pending.token = randomUUID();
    pending.prepared_at = now();
    for (const write of pending.writes) {
      write.path = safeTrackedPath(write.path);
      write.before = readArtifact(root, write.path);
      if (typeof write.after !== 'string' || Buffer.byteLength(write.after) > 8 * 1024 * 1024) fail('integration artifact bytes are invalid');
      write.hash = sha256(write.after);
    }
    record[field].pending = pending;
    return pending;
  }, cwd);
  applyPending(updated.record.destination.root, updated.result);
  return updated;
}

function adoptArtifacts(recordArg, { expectedRecordHash, token, commit } = {}, field, cwd) {
  return withRecord(recordArg, expectedRecordHash, (record) => {
    const pending = record[field].pending;
    if (!pending || pending.token !== token || !OID.test(commit || '')) fail(`${field} adoption token or commit is invalid`);
    validateArtifactPending(record, field, pending);
    const root = rootPath(record.destination.root);
    if (head(root) !== commit || branch(root) !== record.destination.branch) fail(`${field} commit is not current integration HEAD`);
    assertClean(root);
    const parents = String(git(root, ['rev-list', '--parents', '-n', '1', commit])).trim().split(/\s+/);
    if (parents.length !== 2 || parents[1] !== pending.parent) fail(`${field} commit must be a direct child of its prepared parent`);
    const changed = String(git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', pending.parent, commit, '--'])).trim().split(/\r?\n/).filter(Boolean).sort();
    const paths = pending.writes.map((item) => item.path).sort();
    if (canonical(changed) !== canonical(paths)) fail(`${field} commit changes paths outside its prepared artifact set`);
    for (const write of pending.writes) {
      const bytes = git(root, ['show', `${commit}:${write.path}`], { buffer: true });
      if (sha256(bytes) !== write.hash || fs.readFileSync(artifactFile(root, write.path), 'utf8') !== write.after) fail(`${field} committed bytes differ from preparation`);
      const entry = commitEntry(root, commit, write.path);
      write.mode = entry.mode;
      write.oid = entry.oid;
    }
    record[field].commit = commit;
    record[field].proof = { ...structuredClone(pending), commit, tree: tree(root, commit) };
    record[field].pending = null;
    record[field].adopted_at = now();
    return { commit, paths };
  }, cwd);
}

export function prepareVerificationReport(recordArg, { expectedRecordHash } = {}, cwd = process.cwd()) {
  return prepareArtifacts(recordArg, expectedRecordHash, 'report', (record, root) => {
    if (record.reporting === 'skipped') fail('this integration does not require or request a verification report');
    assertExecutableM(record);
    const { review, verification, view } = assertEvidenceReady(record, { finalized: true });
    if (head(root) !== record.integration.commit) fail('verification report P must begin at M');
    const story = readStory(root, record.source.story_path);
    const artifacts = renderVerificationArtifacts(view, story, review, verification);
    const reportPath = `docs/verification/${record.source.story}.md`;
    const checklistPath = `docs/checklists/verification-${record.source.story}.md`;
    if (readArtifact(root, reportPath) !== null || readArtifact(root, checklistPath) !== null) fail('verification reporting paths must be new at P');
    return { parent: record.integration.commit, writes: [
      { path: reportPath, after: artifacts.report },
      { path: checklistPath, after: artifacts.checklist },
    ] };
  }, cwd);
}

export function adoptVerificationReport(recordArg, options = {}, cwd = process.cwd()) {
  return adoptArtifacts(recordArg, options, 'report', cwd);
}

export function prepareStoryClosure(recordArg, { expectedRecordHash } = {}, cwd = process.cwd()) {
  return prepareArtifacts(recordArg, expectedRecordHash, 'closure', (record, root) => {
    assertEvidenceReady(record, { finalized: true });
    if (record.reporting !== 'skipped' && !record.report.commit) fail('required or requested verification report P is missing');
    const parent = record.report.commit || record.integration.commit;
    if (head(root) !== parent) fail('story closure E must begin at the final evidence commit');
    const story = readStory(root, record.source.story_path);
    if (story.contractHash !== record.source.contract_hash || story.executionHash !== record.source.execution_hash
      || story.execution?.status !== 'in-review') fail('story at integration does not match finished candidate C');
    const closedAt = stamp();
    const closed = replaceStoryExecution(story, { status: 'merged', updated: closedAt }, {
      note: `${closedAt} integrated at ${record.integration.commit}`,
    });
    record.closure.execution_hash = closed.executionHash;
    return { parent, writes: [{ path: record.source.story_path, after: closed.after }] };
  }, cwd);
}

export function adoptStoryClosure(recordArg, options = {}, cwd = process.cwd()) {
  return adoptArtifacts(recordArg, options, 'closure', cwd);
}

export function prepareIntegrationHandoff(recordArg, { expectedRecordHash, next = 'Continue with the next ready story.' } = {}, cwd = process.cwd()) {
  if (typeof next !== 'string' || !next.trim() || next.length > 1000 || /[\x00-\x1f\x7f]/.test(next)) fail('handoff next action is invalid');
  return prepareArtifacts(recordArg, expectedRecordHash, 'handoff', (record, root) => {
    const { review, view } = assertEvidenceReady(record, { finalized: true });
    if (!record.closure.commit || head(root) !== record.closure.commit) fail('handoff H must begin at closure E');
    const handoffAt = stamp();
    return {
      parent: record.closure.commit, handoff_at: handoffAt, next,
      writes: [{ path: record.handoff.path, after: handoffContent(view, handoffAt, next, review) }],
    };
  }, cwd);
}

export function adoptIntegrationHandoff(recordArg, options = {}, cwd = process.cwd()) {
  return adoptArtifacts(recordArg, options, 'handoff', cwd);
}
