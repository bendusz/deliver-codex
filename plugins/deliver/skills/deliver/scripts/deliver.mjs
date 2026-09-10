#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  archiveEvidence,
  DeliverError,
  approvalIsCurrent,
  createRun,
  currentPlanHash,
  readJsonFile,
  readRun,
  sha256,
  syncPlan,
  updateRun,
  validateTaskPacket,
} from './lib/state.mjs';
import { baselineDirtyPaths, captureGitAnchor, gitRoot, inspectScope, snapshot, validateTaskPaths } from './lib/scope.mjs';
import { executeGate, gateIsCurrent, parseEnvironment } from './lib/gates.mjs';
import { captureContracts } from './lib/contracts.mjs';
import { preparePmBinding } from './lib/pm.mjs';
import { detectProjectFormat, inspectProjectState } from './lib/project-state.mjs';
import { adoptPreparedCommit, assertFinalCandidate, prepareCommitAdoption, transitionCurrentExecution } from './lib/transitions.mjs';

const HELP = `Deliver deterministic runtime

Usage:
  deliver.mjs help
  deliver.mjs init --mode quick [--plan <file>]
  deliver.mjs init --mode managed|governed --plan <file>
  deliver.mjs status --run <uuid|state.json>
  deliver.mjs approve --run <run> --approver <id>
  deliver.mjs start --run <run> --task <packet.json> --builder <id> [--story docs/stories/<story>.md]
  deliver.mjs check --run <run>
  deliver.mjs gate --run <run> --name <command-name> --command <exact-shell-command> [--cwd <relative-dir>] [--env <json>]
  deliver.mjs review --run <run> --snapshot <sha256> --reviewer <id> --receipt <json>
  deliver.mjs verify --run <run> --snapshot <sha256> --verifier <id> --results <json>
  deliver.mjs checkpoint --run <run> --label <text>
  deliver.mjs correct-course --run <run> --kind retry|fix|plan --reason <text> [--plan <file>]
  deliver.mjs commit-prepare --run <run>
  deliver.mjs commit-adopt --run <run> --token <uuid> --commit <full-sha>
  deliver.mjs finish --run <run>

All mutating commands accept --expected-revision <n>. Output is one JSON object.
Gate commands are intentionally authorized runtime steps. The runtime invokes the exact
--command string through the platform shell in the recorded cwd, with a 10 minute limit.
`;

const VALUE_FLAGS = new Set([
  '--mode', '--plan', '--run', '--approver', '--task', '--builder', '--expected-revision',
  '--name', '--command', '--cwd', '--env', '--reviewer', '--receipt', '--verifier', '--results',
  '--label', '--kind', '--reason', '--snapshot', '--story',
  '--token', '--commit',
]);

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!VALUE_FLAGS.has(key)) throw new DeliverError(`unknown argument: ${key}`, 64);
    if (argv[i + 1] === undefined) throw new DeliverError(`${key} requires a value`, 64);
    if (Object.hasOwn(out, key)) throw new DeliverError(`duplicate argument: ${key}`, 64);
    out[key] = argv[++i];
  }
  if (out['--expected-revision'] !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(out['--expected-revision'])) throw new DeliverError('--expected-revision must be a non-negative integer', 64);
    out.expectedRevision = Number(out['--expected-revision']);
  }
  return out;
}

const required = (o, key) => {
  const value = o[key];
  if (typeof value !== 'string' || value.trim() === '') throw new DeliverError(`${key} is required`, 64);
  return value;
};

const actor = (value, flag) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(value || '')) throw new DeliverError(`${flag} must be an explicit safe identity`, 64);
  return value;
};

const snapshotArgument = (o) => {
  const value = required(o, '--snapshot');
  if (!/^[0-9a-f]{64}$/.test(value)) throw new DeliverError('--snapshot must be a lowercase SHA-256 hash from check', 64);
  return value;
};

function event(state, type, extra = {}) {
  state.events.push({ at: new Date().toISOString(), type, ...extra });
}

function active(state) {
  if (state.phase !== 'active') throw new DeliverError(`run must be active, current phase is ${state.phase}`, 66);
}

function requireCurrentApproval(state) {
  const format = detectProjectFormat(state.project_root);
  if (format === 'current') {
    const shared = inspectProjectState(state.project_root, { actorId: null });
    if (!shared?.approval?.implementation_ready) throw new DeliverError('current project needs an approved tracked marker and matching shared plan', 66);
    const planPath = path.join(state.project_root, 'docs', 'plan.md');
    if (state.plan.path !== planPath || currentPlanHash(state) !== state.plan.hash) throw new DeliverError('runtime must use the unchanged approved shared docs/plan.md', 66);
    if (!approvalIsCurrent(state) || state.approval.source !== 'current-project'
      || state.approval.shared_plan_digest !== shared.approval.plan_digest) {
      state.approval = {
        approver: shared.approval.approver || 'shared-project',
        plan_hash: state.plan.hash,
        approved_at: shared.approval.approved_date || new Date().toISOString(),
        source: 'current-project',
        shared_plan_digest: shared.approval.plan_digest,
      };
      event(state, 'shared_approval_reused', { plan_hash: state.plan.hash, plan_digest: shared.approval.plan_digest });
    }
    return shared;
  }
  if (state.mode !== 'quick' && !approvalIsCurrent(state)) throw new DeliverError(`${state.mode} mode needs explicit approval for the current plan`, 66);
  return null;
}

function parseReceipt(file) {
  const receipt = readJsonFile(file, 'review receipt');
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || !['PASS', 'FAIL'].includes(receipt.status) || !Array.isArray(receipt.findings)) {
    throw new DeliverError('review receipt must contain status PASS|FAIL and a findings array', 66);
  }
  const findings = receipt.findings.map((finding, index) => {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding) || !['block', 'major', 'minor'].includes(finding.severity) || typeof finding.message !== 'string' || finding.message.trim() === '') {
      throw new DeliverError(`invalid review finding at index ${index}`, 66);
    }
    if (finding.path !== undefined && typeof finding.path !== 'string') throw new DeliverError(`review finding ${index} path must be a string`, 66);
    if (finding.resolved !== undefined && typeof finding.resolved !== 'boolean') throw new DeliverError(`review finding ${index} resolved must be boolean`, 66);
    return { severity: finding.severity, message: finding.message, ...(finding.path === undefined ? {} : { path: finding.path }), resolved: finding.resolved === true };
  });
  if (receipt.summary !== undefined && typeof receipt.summary !== 'string') throw new DeliverError('review summary must be a string', 66);
  if (receipt.status === 'PASS' && findings.some((finding) => !finding.resolved && finding.severity !== 'minor')) {
    throw new DeliverError('a PASS review may not contain unresolved block or major findings', 66);
  }
  return { status: receipt.status, findings, ...(receipt.summary === undefined ? {} : { summary: receipt.summary }) };
}

function parseVerification(file, acceptance) {
  const document = readJsonFile(file, 'verification results');
  if (!document || typeof document !== 'object' || Array.isArray(document) || !Array.isArray(document.criteria)) {
    throw new DeliverError('verification results must contain a criteria array', 66);
  }
  const criteria = document.criteria.map((criterion, index) => {
    if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion) || typeof criterion.id !== 'string' || !['PASS', 'FAIL', 'UNKNOWN'].includes(criterion.status) || typeof criterion.evidence !== 'string' || criterion.evidence.trim() === '') {
      throw new DeliverError(`invalid verification criterion at index ${index}`, 66);
    }
    return { id: criterion.id, status: criterion.status, evidence: criterion.evidence };
  });
  const expected = acceptance.map((item) => item.id).sort();
  const actual = criteria.map((item) => item.id).sort();
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new DeliverError('verification criteria must cover each acceptance id exactly once', 66);
  }
  return criteria;
}

function summarize(state, file) {
  const planHash = currentPlanHash(state);
  let scope = null;
  if (state.baseline && state.task) {
    try { scope = inspectScope(state).report; }
    catch (error) { scope = { ok: false, error: error.message }; }
  }
  return {
    ok: true,
    run_id: state.run_id,
    state_path: file,
    revision: state.revision,
    mode: state.mode,
    phase: state.phase,
    plan: { ...state.plan, current_hash: planHash, changed: planHash !== state.plan.hash },
    approval_current: approvalIsCurrent(state),
    task_id: state.task?.packet.id || null,
    builder: state.task?.builder || null,
    scope,
    gates: state.gates.map((gate) => ({ name: gate.name, command: gate.command, status: gate.status, snapshot_hash: gate.snapshot_hash })),
    review: state.review && {
      status: state.review.status,
      builder: state.review.builder,
      reviewer: state.review.reviewer,
      snapshot_hash: state.review.snapshot_hash,
      findings: state.review.findings.length,
      unresolved_blocking: state.review.findings.filter((finding) => !finding.resolved && finding.severity !== 'minor').length,
      unresolved_minor: state.review.findings.filter((finding) => !finding.resolved && finding.severity === 'minor').length,
    },
    verification: state.verification && {
      verifier: state.verification.verifier,
      snapshot_hash: state.verification.snapshot_hash,
      counts: Object.fromEntries(['PASS', 'FAIL', 'UNKNOWN'].map((status) => [status, state.verification.criteria.filter((criterion) => criterion.status === status).length])),
    },
    counters: state.counters,
  };
}

function output(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

function main() {
  const [command = 'help', ...rest] = process.argv.slice(2);
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP);
    return;
  }
  const o = args(rest);
  if (command === 'init') {
    const root = gitRoot(process.cwd());
    const format = detectProjectFormat(root);
    let plan = o['--plan'];
    if (format === 'current') {
      const sharedPlan = path.join(root, 'docs', 'plan.md');
      if (plan && path.resolve(root, plan) !== sharedPlan) throw new DeliverError('current projects must use the shared docs/plan.md', 64);
      plan = 'docs/plan.md';
    }
    const created = createRun(root, required(o, '--mode'), plan);
    if (format !== 'current') {
      output(summarize(created.state, created.file));
      return;
    }
    const shared = inspectProjectState(root, { actorId: null });
    if (!shared?.approval?.implementation_ready) {
      output(summarize(created.state, created.file));
      return;
    }
    const updated = updateRun(created.file, 0, (state) => { requireCurrentApproval(state); });
    output(summarize(updated.state, updated.file));
    return;
  }
  const run = required(o, '--run');
  if (command === 'status') {
    const loaded = readRun(run);
    output(summarize(loaded.state, loaded.file));
    return;
  }
  if (command === 'approve') {
    const approver = actor(required(o, '--approver'), '--approver');
    const updated = updateRun(run, o.expectedRevision, (state) => {
      if (detectProjectFormat(state.project_root) === 'current') {
        throw new DeliverError('current projects use pm.mjs approve; the runtime reuses that shared approval', 66);
      }
      const planHash = syncPlan(state);
      state.approval = { approver, plan_hash: planHash, approved_at: new Date().toISOString() };
      event(state, 'approved', { approver, plan_hash: planHash });
    });
    output(summarize(updated.state, updated.file));
    return;
  }
  if (command === 'start') {
    const builder = actor(required(o, '--builder'), '--builder');
    const taskPath = required(o, '--task');
    const packetInput = validateTaskPacket(readJsonFile(taskPath, 'task packet'));
    const started = updateRun(run, o.expectedRevision, (state) => {
      if (state.phase !== 'initialized') throw new DeliverError(`cannot start from phase ${state.phase}`, 66);
      syncPlan(state);
      requireCurrentApproval(state);
      const packet = validateTaskPaths(state.project_root, packetInput);
      state.pm_binding = preparePmBinding(state, packet, o['--story']);
      state.contracts = captureContracts(state.project_root, packet);
      state.task = { packet, builder, started_at: new Date().toISOString() };
      const dirtyPaths = baselineDirtyPaths(state.project_root);
      const baselineSnapshot = snapshot(state.project_root, [...packet.touches, ...packet.read_paths, ...packet.specs]);
      state.baseline = { captured_at: new Date().toISOString(), snapshot: baselineSnapshot, dirty_paths: dirtyPaths };
      if (state.pm_binding?.format === 'current') {
        state.git_anchor = captureGitAnchor(state.project_root);
        state.execution_audit = null;
        state.commit_adoption = { pending: null, history: [] };
      }
      state.phase = 'active';
      event(state, 'baseline_captured', { snapshot_hash: baselineSnapshot.hash, dirty_paths: dirtyPaths });
    });
    output(summarize(started.state, started.file));
    return;
  }
  if (command === 'check') {
    const loaded = readRun(run);
    active(loaded.state);
    const checked = inspectScope(loaded.state);
    output({ ok: checked.report.ok, run_id: loaded.state.run_id, revision: loaded.state.revision, snapshot_hash: checked.current.hash, ...checked.report });
    if (!checked.report.ok) process.exitCode = 74;
    return;
  }
  if (command === 'gate') {
    const name = required(o, '--name');
    const commandText = required(o, '--command');
    const environment = parseEnvironment(o['--env']);
    const updated = updateRun(run, o.expectedRevision, (state) => {
      active(state);
      syncPlan(state);
      requireCurrentApproval(state);
      const receipt = executeGate(state, { name, command: commandText, cwd: o['--cwd'] || '.', environment });
      state.gates.push(receipt);
      event(state, 'gate_executed', { name, status: receipt.status, snapshot_hash: receipt.snapshot_hash });
      return receipt;
    });
    output({ ok: updated.result.status === 'PASS', run_id: updated.state.run_id, revision: updated.state.revision, gate: updated.result });
    if (updated.result.status !== 'PASS') process.exitCode = 1;
    return;
  }
  if (command === 'review') {
    const reviewer = actor(required(o, '--reviewer'), '--reviewer');
    const reviewedSnapshot = snapshotArgument(o);
    const receipt = parseReceipt(required(o, '--receipt'));
    const updated = updateRun(run, o.expectedRevision, (state) => {
      active(state);
      syncPlan(state);
      requireCurrentApproval(state);
      if (reviewer === state.task.builder) throw new DeliverError('reviewer must differ from builder', 66);
      const checked = inspectScope(state);
      if (!checked.report.ok) throw new DeliverError('cannot review out-of-scope changes', 74, checked.report);
      if (checked.current.hash !== reviewedSnapshot) throw new DeliverError('review snapshot is stale or does not match this run', 66);
      state.review = { ...receipt, builder: state.task.builder, reviewer, snapshot_hash: checked.current.hash, recorded_at: new Date().toISOString() };
      event(state, 'review_recorded', { reviewer, status: receipt.status, snapshot_hash: checked.current.hash });
    });
    output(summarize(updated.state, updated.file));
    return;
  }
  if (command === 'verify') {
    const verifier = actor(required(o, '--verifier'), '--verifier');
    const verifiedSnapshot = snapshotArgument(o);
    const updated = updateRun(run, o.expectedRevision, (state) => {
      active(state);
      syncPlan(state);
      requireCurrentApproval(state);
      if (verifier === state.task.builder) throw new DeliverError('verifier must differ from builder', 66);
      if (state.mode === 'governed' && state.review?.reviewer === verifier) throw new DeliverError('governed verifier must differ from reviewer', 66);
      const criteria = parseVerification(required(o, '--results'), state.task.packet.acceptance);
      const checked = inspectScope(state);
      if (!checked.report.ok) throw new DeliverError('cannot verify out-of-scope changes', 74, checked.report);
      if (checked.current.hash !== verifiedSnapshot) throw new DeliverError('verification snapshot is stale or does not match this run', 66);
      state.verification = { verifier, criteria, snapshot_hash: checked.current.hash, recorded_at: new Date().toISOString() };
      event(state, 'verification_recorded', { verifier, snapshot_hash: checked.current.hash });
    });
    output(summarize(updated.state, updated.file));
    return;
  }
  if (command === 'checkpoint') {
    const label = required(o, '--label');
    if (label.length > 200 || /[\x00-\x1f\x7f]/.test(label)) throw new DeliverError('checkpoint label must be printable and at most 200 characters', 64);
    const updated = updateRun(run, o.expectedRevision, (state) => {
      active(state);
      const checked = inspectScope(state);
      if (!checked.report.ok) throw new DeliverError('cannot checkpoint out-of-scope changes', 74, checked.report);
      state.checkpoints.push({ label, snapshot_hash: checked.current.hash, at: new Date().toISOString() });
      event(state, 'checkpoint', { label, snapshot_hash: checked.current.hash });
    });
    output(summarize(updated.state, updated.file));
    return;
  }
  if (command === 'correct-course') {
    const kind = required(o, '--kind');
    const reason = required(o, '--reason');
    if (!['retry', 'fix', 'plan'].includes(kind)) throw new DeliverError('--kind must be retry, fix, or plan', 64);
    if (reason.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(reason)) throw new DeliverError('reason must be printable and at most 1000 characters', 64);
    const current = readRun(run);
    if (kind !== 'plan' && detectProjectFormat(current.state.project_root) === 'current') {
      const transitioned = transitionCurrentExecution(run, { to: 'building', attempt: kind, reason, expectedRevision: o.expectedRevision });
      output(summarize(transitioned.state, transitioned.file));
      return;
    }
    const updated = updateRun(run, o.expectedRevision, (state) => {
      if (state.phase === 'finished') throw new DeliverError('finished runs cannot be corrected', 66);
      if (kind === 'plan') {
        const newPlan = path.resolve(state.project_root, required(o, '--plan'));
        let hash;
        try { hash = sha256(fs.readFileSync(newPlan)); } catch (error) { throw new DeliverError(`cannot read new plan: ${error.message}`, 66); }
        state.plan = { path: newPlan, hash };
        state.approval = null;
        state.counters.corrections += 1;
      } else {
        const counter = kind === 'retry' ? 'retries' : 'fixes';
        const limit = kind === 'retry' ? 2 : 3;
        if (state.counters[counter] >= limit) throw new DeliverError(`${kind} limit of ${limit} has been reached`, 66);
        state.counters[counter] += 1;
      }
      archiveEvidence(state, 'correct_course', { kind, reason, plan_hash: state.plan.hash });
      event(state, 'correct_course', { kind, reason, plan_hash: state.plan.hash });
    });
    output(summarize(updated.state, updated.file));
    return;
  }
  if (command === 'commit-prepare') {
    const prepared = prepareCommitAdoption(run, o.expectedRevision);
    output({ ...summarize(prepared.state, prepared.file), preparation: prepared.result });
    return;
  }
  if (command === 'commit-adopt') {
    const adopted = adoptPreparedCommit(run, {
      token: required(o, '--token'), commit: required(o, '--commit'), expectedRevision: o.expectedRevision,
    });
    output({ ...summarize(adopted.state, adopted.file), adoption: adopted.result });
    return;
  }
  if (command === 'finish') {
    const updated = updateRun(run, o.expectedRevision, (state) => {
      active(state);
      syncPlan(state);
      requireCurrentApproval(state);
      const checked = inspectScope(state);
      if (!checked.report.ok) throw new DeliverError('scope check failed', 74, checked.report);
      assertFinalCandidate(state);
      if (checked.report.changed.length === 0) throw new DeliverError('cannot finish without a worktree change after the baseline', 66);
      const requiredCommands = Object.entries(state.task.packet.commands);
      for (const [name, commandText] of requiredCommands) {
        const gate = [...state.gates].reverse().find((item) => item.name === name && item.command === commandText);
        if (!gate || !gateIsCurrent(state, gate, checked.current.hash)) throw new DeliverError(`required gate is missing, failed, or stale: ${name}`, 66);
      }
      if (!state.review || state.review.status !== 'PASS' || state.review.snapshot_hash !== checked.current.hash
        || state.review.findings.some((finding) => !finding.resolved && finding.severity !== 'minor')) {
        throw new DeliverError('independent PASS review is missing, unresolved, or stale', 66);
      }
      if (!state.verification || state.verification.snapshot_hash !== checked.current.hash || state.verification.criteria.some((criterion) => criterion.status !== 'PASS')) {
        throw new DeliverError('acceptance verification is missing, non-PASS, or stale', 66);
      }
      if (state.verification.verifier === state.task.builder) throw new DeliverError('verifier must differ from builder', 66);
      if (state.mode === 'governed' && state.verification.verifier === state.review.reviewer) throw new DeliverError('governed verifier must differ from reviewer', 66);
      state.phase = 'finished';
      state.completion_snapshot = checked.current;
      state.finished_at = new Date().toISOString();
      event(state, 'finished', { snapshot_hash: checked.current.hash });
    });
    output(summarize(updated.state, updated.file));
    return;
  }
  throw new DeliverError(`unknown command: ${command}`, 64);
}

try { main(); }
catch (error) {
  const known = error instanceof DeliverError;
  output({ ok: false, error: error.message || String(error), ...(error.details === undefined ? {} : { details: error.details }) });
  process.exitCode = known ? error.code : 70;
}
