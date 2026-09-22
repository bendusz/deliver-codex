#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DeliverError } from './lib/state.mjs';
import { gitRoot, snapshot } from './lib/scope.mjs';
import { initializePm, readPm, approvePm, claimPm, completePm, recoverPm, pmActorId } from './lib/pm.mjs';
import { detectProjectFormat, inspectProjectState } from './lib/project-state.mjs';
import {
  approveCurrentPm,
  assertCurrentPmReady,
  claimCurrentPm,
  initializeCurrentPm,
  recoverCurrentPm,
  remoteAdmissionStatus,
  revokeCurrentPm,
} from './lib/current-pm.mjs';
import { recoverExecutionTransition, transitionCurrentExecution } from './lib/transitions.mjs';
import {
  adoptIntegrationHandoff,
  adoptLocalIntegration,
  adoptStoryClosure,
  adoptVerificationReport,
  finalizeIntegrationEvidence,
  prepareIntegrationHandoff,
  prepareIntegrationCorrection,
  prepareLocalIntegration,
  prepareStoryClosure,
  prepareVerificationReport,
  reconcileIntegrationEvidence,
  recordIntegrationReview,
  recordIntegrationVerification,
  runIntegrationGate,
  recoverIntegrationCorrectionStart,
  publishRemoteSource, inspectRemoteSourceReadiness, mergeRemoteSource, reconcileRemoteSource,
  prepareRemoteIntegrationEvidence, runRemoteIntegrationGate, recordRemoteIntegrationReview,
  recordRemoteIntegrationVerification, finalizeRemoteIntegrationEvidence,
  prepareRemoteClosureCheckout, adoptRemoteClosureCheckout,
  prepareRemoteVerificationReport, adoptRemoteVerificationReport,
  prepareRemoteStoryClosure, adoptRemoteStoryClosure, prepareRemoteHandoff, adoptRemoteHandoff,
  publishRemoteClosure, reconcileRemoteClosure, prepareHandoffRepair, adoptHandoffRepair,
  publishRemoteHandoffRepair, reconcileRemoteHandoffRepair, prepareRemoteCompletion, adoptRemoteCompletion,
} from './lib/integration.mjs';

const help = `Shared Deliver project state
  pm.mjs init [--name PROJECT] [--format current|legacy]
  pm.mjs status
  pm.mjs actor-id
  pm.mjs approve --approver ACTUAL_USER
  pm.mjs revoke [--reason TEXT]
  pm.mjs claim --story docs/stories/S1-1-example.md [--branch pm/S1-1-example]
  pm.mjs transition --run RUN --to building|built|in-review|blocked [--attempt fix|retry] [--reason TEXT]
  pm.mjs integrate-prepare --run RUN [--verification-report]
  pm.mjs integrate-adopt --integration FILE --expected-record HASH --token TOKEN --commit SHA
  pm.mjs integrate-gate --integration FILE --expected-record HASH --name GATE
  pm.mjs integrate-review --integration FILE --expected-record HASH --reviewer ID --receipt JSON
  pm.mjs integrate-verify --integration FILE --expected-record HASH --verifier ID --results JSON
  pm.mjs integrate-finalize --integration FILE --expected-record HASH
  pm.mjs integrate-reconcile --integration FILE --expected-record HASH
  pm.mjs correction-prepare --run RUN --integration FILE --expected-record HASH
  pm.mjs report-prepare|close-prepare --integration FILE --expected-record HASH
  pm.mjs report-adopt|close-adopt --integration FILE --expected-record HASH --token TOKEN --commit SHA
  pm.mjs handoff-prepare --integration FILE --expected-record HASH [--next TEXT]
  pm.mjs handoff-adopt --integration FILE --expected-record HASH --token TOKEN --commit SHA
  pm.mjs remote-source-publish|remote-source-readiness|remote-source-merge|remote-source-reconcile ...
  pm.mjs remote-evidence-prepare|remote-evidence-gate|remote-evidence-review|remote-evidence-verify|remote-evidence-finalize ...
  pm.mjs remote-closure-checkout-prepare|remote-closure-checkout-adopt ...
  pm.mjs remote-report-prepare|remote-report-adopt|remote-close-prepare|remote-close-adopt ...
  pm.mjs remote-handoff-prepare|remote-handoff-adopt|remote-closure-publish|remote-closure-reconcile ...
  pm.mjs remote-handoff-repair-prepare|remote-handoff-repair-adopt|remote-handoff-repair-publish|remote-handoff-repair-reconcile ...
  pm.mjs remote-completion-prepare|remote-completion-adopt ...
  pm.mjs complete --run UUID --commit FULL_INTEGRATION_SHA --next "Next ready story or decision"
  pm.mjs recover

Run in the project checkout. These commands never commit, merge, push or execute a model.
The explicit integrate-gate command executes only a gate declared by the finished source task.
Complete records a verified, committed story boundary, not an unmerged implementation.
Recover completes an interrupted journal only when every file matches its before/after image.
`;

function durableCurrentMarker(root) {
  if (fs.existsSync(path.join(root, 'docs', 'approval.json'))) return true;
  for (const args of [
    ['ls-files', '--error-unmatch', '--', 'docs/approval.json'],
    ['cat-file', '-e', 'HEAD:docs/approval.json'],
  ]) {
    try {
      execFileSync('git', ['-C', root, ...args], { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {}
  }
  return false;
}

function boundedBodyFile(root, file) {
  if (typeof file !== 'string' || !file || file.includes('\0')) throw new DeliverError('--body-file must name a bounded regular file', 64);
  const absolute = path.resolve(root, file); const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new DeliverError('--body-file must name a bounded regular file', 64);
  return fs.readFileSync(absolute, 'utf8');
}
try {
  const [command = 'help', ...rest] = process.argv.slice(2);
  if (['help', '--help', '-h'].includes(command)) process.stdout.write(help);
  else {
    const allowed = {
      init: ['--name', '--format'], status: [], 'actor-id': [], approve: ['--approver'], revoke: ['--reason'], claim: ['--story', '--branch'],
      transition: ['--run', '--to', '--attempt', '--reason', '--expected-revision'], complete: ['--run', '--commit', '--next'], recover: [],
      'integrate-prepare': ['--run', '--verification-report'], 'integrate-adopt': ['--integration', '--expected-record', '--token', '--commit'],
      'integrate-gate': ['--integration', '--expected-record', '--name'], 'integrate-review': ['--integration', '--expected-record', '--reviewer', '--receipt'],
      'integrate-verify': ['--integration', '--expected-record', '--verifier', '--results'], 'integrate-finalize': ['--integration', '--expected-record'],
      'integrate-reconcile': ['--integration', '--expected-record'],
      'correction-prepare': ['--run', '--integration', '--expected-record'],
      'report-prepare': ['--integration', '--expected-record'], 'report-adopt': ['--integration', '--expected-record', '--token', '--commit'],
      'close-prepare': ['--integration', '--expected-record'], 'close-adopt': ['--integration', '--expected-record', '--token', '--commit'],
      'handoff-prepare': ['--integration', '--expected-record', '--next'], 'handoff-adopt': ['--integration', '--expected-record', '--token', '--commit'],
      'remote-source-publish': ['--integration', '--expected-record', '--remote', '--title', '--body-file', '--draft', '--mark-ready'],
      'remote-source-readiness': ['--integration', '--expected-record'],
      'remote-source-merge': ['--integration', '--expected-record', '--pr', '--method', '--subject', '--body-file'],
      'remote-source-reconcile': ['--integration', '--expected-record', '--pr'],
      'remote-evidence-prepare': ['--integration', '--expected-record', '--evidence-root'],
      'remote-evidence-gate': ['--integration', '--expected-record', '--name'],
      'remote-evidence-review': ['--integration', '--expected-record', '--reviewer', '--receipt'],
      'remote-evidence-verify': ['--integration', '--expected-record', '--verifier', '--results'],
      'remote-evidence-finalize': ['--integration', '--expected-record'],
      'remote-closure-checkout-prepare': ['--integration', '--expected-record'],
      'remote-closure-checkout-adopt': ['--integration', '--expected-record', '--token'],
      'remote-report-prepare': ['--integration', '--expected-record'], 'remote-report-adopt': ['--integration', '--expected-record', '--token', '--commit'],
      'remote-close-prepare': ['--integration', '--expected-record'], 'remote-close-adopt': ['--integration', '--expected-record', '--token', '--commit'],
      'remote-handoff-prepare': ['--integration', '--expected-record', '--next'], 'remote-handoff-adopt': ['--integration', '--expected-record', '--token', '--commit'],
      'remote-closure-publish': ['--integration', '--expected-record', '--remote', '--title', '--body-file'],
      'remote-closure-reconcile': ['--integration', '--expected-record', '--pr'],
      'remote-handoff-repair-prepare': ['--integration', '--expected-record'],
      'remote-handoff-repair-adopt': ['--integration', '--expected-record', '--token', '--commit'],
      'remote-handoff-repair-publish': ['--integration', '--expected-record', '--remote', '--title', '--body-file'],
      'remote-handoff-repair-reconcile': ['--integration', '--expected-record', '--pr'],
      'remote-completion-prepare': ['--integration', '--expected-record'],
      'remote-completion-adopt': ['--integration', '--expected-record', '--token'],
    };
    if (!Object.hasOwn(allowed, command)) throw new DeliverError('unknown shared PM command', 64);
    const options = {};
    for (let i = 0; i < rest.length;) {
      const flag = rest[i++];
      if (!allowed[command].includes(flag) || Object.hasOwn(options, flag)) throw new DeliverError('unknown, duplicate or missing PM option', 64);
      if (['--verification-report', '--draft', '--mark-ready'].includes(flag)) options[flag] = true;
      else {
        if (!rest[i]) throw new DeliverError('unknown, duplicate or missing PM option', 64);
        options[flag] = rest[i++];
      }
    }
    const root = gitRoot(process.cwd());
    const format = detectProjectFormat(root);
    let result;
    if (command === 'init') {
      const requested = options['--format'];
      if (requested !== undefined && !['current', 'legacy'].includes(requested)) throw new DeliverError('--format must be current or legacy', 64);
      if (format === 'legacy' && requested === 'current') throw new DeliverError('explicit migration is required before converting a legacy project to current format', 66);
      if (format === 'current' && requested === 'legacy') {
        const current = inspectProjectState(root, { actorId: null });
        const executionEvidence = current?.stories.some((story) => story.execution !== null);
        if (durableCurrentMarker(root) || executionEvidence) throw new DeliverError('current projects cannot initialize legacy state alongside current artifacts', 66);
      }
      const selected = requested || (format === 'legacy' ? 'legacy' : 'current');
      result = selected === 'legacy' ? initializePm(root, options['--name']) : initializeCurrentPm(root, options['--name']);
    }
    else if (command === 'status') {
      assertCurrentPmReady(root);
      if (format === 'current') result = { ...inspectProjectState(root), remote: remoteAdmissionStatus(root) };
      else {
        const shared = readPm(root);
        result = { managed: Boolean(shared), ...shared };
      }
    }
    else if (command === 'actor-id') result = { actor: pmActorId(root) };
    else if (command === 'approve') result = format === 'current'
      ? approveCurrentPm(root, options['--approver']) : approvePm(root, options['--approver']);
    else if (command === 'revoke') {
      if (format !== 'current') throw new DeliverError('revoke is available for current-format projects', 66);
      result = revokeCurrentPm(root, options['--reason']);
    }
    else if (command === 'claim') result = format === 'current'
      ? claimCurrentPm(root, options['--story'], options['--branch']) : claimPm(root, options['--story'], options['--branch']);
    else if (command === 'transition') {
      if (format !== 'current') throw new DeliverError('Execution transitions require a current-format project', 66);
      const revision = options['--expected-revision'];
      if (revision !== undefined && !/^(0|[1-9][0-9]*)$/.test(revision)) throw new DeliverError('--expected-revision must be a non-negative integer', 64);
      const transitioned = transitionCurrentExecution(options['--run'], {
        to: options['--to'], attempt: options['--attempt'], reason: options['--reason'],
        expectedRevision: revision === undefined ? undefined : Number(revision),
      }, root);
      result = {
        run_id: transitioned.state.run_id,
        revision: transitioned.state.revision,
        story: transitioned.state.pm_binding.story,
        status: transitioned.execution.status,
        rounds: transitioned.execution.rounds,
        retries: transitioned.execution.retries,
        noop: transitioned.noop,
      };
    }
    else if (command === 'complete') {
      if (format === 'current') throw new DeliverError('current story completion requires the integration workflow', 66);
      result = completePm(root, options['--run'], options['--commit'], options['--next'], snapshot);
    }
    else if (command === 'integrate-prepare') result = prepareLocalIntegration(options['--run'], {
      integrationRoot: root, verificationReport: options['--verification-report'] === true,
    }, root);
    else if (command === 'integrate-adopt') result = adoptLocalIntegration(options['--integration'], {
      expectedRecordHash: options['--expected-record'], token: options['--token'], commit: options['--commit'],
    }, root);
    else if (command === 'integrate-gate') result = runIntegrationGate(options['--integration'], {
      expectedRecordHash: options['--expected-record'], name: options['--name'],
    }, root);
    else if (command === 'integrate-review') result = recordIntegrationReview(options['--integration'], {
      expectedRecordHash: options['--expected-record'], reviewer: options['--reviewer'], receipt: options['--receipt'],
    }, root);
    else if (command === 'integrate-verify') result = recordIntegrationVerification(options['--integration'], {
      expectedRecordHash: options['--expected-record'], verifier: options['--verifier'], results: options['--results'],
    }, root);
    else if (command === 'integrate-finalize') result = finalizeIntegrationEvidence(options['--integration'], {
      expectedRecordHash: options['--expected-record'],
    }, root);
    else if (command === 'integrate-reconcile') result = reconcileIntegrationEvidence(options['--integration'], {
      expectedRecordHash: options['--expected-record'],
    }, root);
    else if (command === 'correction-prepare') result = prepareIntegrationCorrection(options['--run'], {
      integrationRecord: options['--integration'], expectedRecordHash: options['--expected-record'],
    }, root);
    else if (command === 'report-prepare') result = prepareVerificationReport(options['--integration'], {
      expectedRecordHash: options['--expected-record'],
    }, root);
    else if (command === 'report-adopt') result = adoptVerificationReport(options['--integration'], {
      expectedRecordHash: options['--expected-record'], token: options['--token'], commit: options['--commit'],
    }, root);
    else if (command === 'close-prepare') result = prepareStoryClosure(options['--integration'], {
      expectedRecordHash: options['--expected-record'],
    }, root);
    else if (command === 'close-adopt') result = adoptStoryClosure(options['--integration'], {
      expectedRecordHash: options['--expected-record'], token: options['--token'], commit: options['--commit'],
    }, root);
    else if (command === 'handoff-prepare') result = prepareIntegrationHandoff(options['--integration'], {
      expectedRecordHash: options['--expected-record'], next: options['--next'],
    }, root);
    else if (command === 'handoff-adopt') result = adoptIntegrationHandoff(options['--integration'], {
      expectedRecordHash: options['--expected-record'], token: options['--token'], commit: options['--commit'],
    }, root);
    else if (command === 'remote-source-publish') result = publishRemoteSource(options['--integration'], {
      expectedRecordHash: options['--expected-record'], remote: options['--remote'], title: options['--title'],
      body: boundedBodyFile(root, options['--body-file']), createDraft: options['--draft'] === true, markReady: options['--mark-ready'] === true,
    }, root);
    else if (command === 'remote-source-readiness') result = inspectRemoteSourceReadiness(options['--integration'], { expectedRecordHash: options['--expected-record'] }, root);
    else if (command === 'remote-source-merge') result = mergeRemoteSource(options['--integration'], { expectedRecordHash: options['--expected-record'],
      prNumber: Number(options['--pr']), method: options['--method'], subject: options['--subject'], body: boundedBodyFile(root, options['--body-file']) }, root);
    else if (command === 'remote-source-reconcile') result = reconcileRemoteSource(options['--integration'], { expectedRecordHash: options['--expected-record'], prNumber: Number(options['--pr']) }, root);
    else if (command === 'remote-evidence-prepare') result = prepareRemoteIntegrationEvidence(options['--integration'], { expectedRecordHash: options['--expected-record'], evidenceRoot: options['--evidence-root'] }, root);
    else if (command === 'remote-evidence-gate') result = runRemoteIntegrationGate(options['--integration'], { expectedRecordHash: options['--expected-record'], name: options['--name'] }, root);
    else if (command === 'remote-evidence-review') result = recordRemoteIntegrationReview(options['--integration'], { expectedRecordHash: options['--expected-record'], reviewer: options['--reviewer'], receipt: options['--receipt'] }, root);
    else if (command === 'remote-evidence-verify') result = recordRemoteIntegrationVerification(options['--integration'], { expectedRecordHash: options['--expected-record'], verifier: options['--verifier'], results: options['--results'] }, root);
    else if (command === 'remote-evidence-finalize') result = finalizeRemoteIntegrationEvidence(options['--integration'], { expectedRecordHash: options['--expected-record'] }, root);
    else if (command === 'remote-closure-checkout-prepare') result = prepareRemoteClosureCheckout(options['--integration'], { expectedRecordHash: options['--expected-record'] }, root);
    else if (command === 'remote-closure-checkout-adopt') result = adoptRemoteClosureCheckout(options['--integration'], { expectedRecordHash: options['--expected-record'], token: options['--token'], closureRoot: root }, root);
    else if (command === 'remote-report-prepare') result = prepareRemoteVerificationReport(options['--integration'], { expectedRecordHash: options['--expected-record'] }, root);
    else if (command === 'remote-report-adopt') result = adoptRemoteVerificationReport(options['--integration'], { expectedRecordHash: options['--expected-record'], token: options['--token'], commit: options['--commit'] }, root);
    else if (command === 'remote-close-prepare') result = prepareRemoteStoryClosure(options['--integration'], { expectedRecordHash: options['--expected-record'] }, root);
    else if (command === 'remote-close-adopt') result = adoptRemoteStoryClosure(options['--integration'], { expectedRecordHash: options['--expected-record'], token: options['--token'], commit: options['--commit'] }, root);
    else if (command === 'remote-handoff-prepare') result = prepareRemoteHandoff(options['--integration'], { expectedRecordHash: options['--expected-record'], next: options['--next'] }, root);
    else if (command === 'remote-handoff-adopt') result = adoptRemoteHandoff(options['--integration'], { expectedRecordHash: options['--expected-record'], token: options['--token'], commit: options['--commit'] }, root);
    else if (command === 'remote-closure-publish') result = publishRemoteClosure(options['--integration'], { expectedRecordHash: options['--expected-record'], remote: options['--remote'], title: options['--title'], body: boundedBodyFile(root, options['--body-file']) }, root);
    else if (command === 'remote-closure-reconcile') result = reconcileRemoteClosure(options['--integration'], { expectedRecordHash: options['--expected-record'], prNumber: Number(options['--pr']) }, root);
    else if (command === 'remote-handoff-repair-prepare') result = prepareHandoffRepair(options['--integration'], { expectedRecordHash: options['--expected-record'], integrationRoot: root }, root);
    else if (command === 'remote-handoff-repair-adopt') result = adoptHandoffRepair(options['--integration'], { expectedRecordHash: options['--expected-record'], token: options['--token'], commit: options['--commit'] }, root);
    else if (command === 'remote-handoff-repair-publish') result = publishRemoteHandoffRepair(options['--integration'], { expectedRecordHash: options['--expected-record'], remote: options['--remote'], title: options['--title'], body: boundedBodyFile(root, options['--body-file']) }, root);
    else if (command === 'remote-handoff-repair-reconcile') result = reconcileRemoteHandoffRepair(options['--integration'], { expectedRecordHash: options['--expected-record'], prNumber: Number(options['--pr']) }, root);
    else if (command === 'remote-completion-prepare') result = prepareRemoteCompletion(options['--integration'], { expectedRecordHash: options['--expected-record'] }, root);
    else if (command === 'remote-completion-adopt') result = adoptRemoteCompletion(options['--integration'], { expectedRecordHash: options['--expected-record'], token: options['--token'] }, root);
    else {
      result = recoverIntegrationCorrectionStart(root);
      if (!result.recovered) result = recoverExecutionTransition(root);
      if (!result.recovered) result = recoverCurrentPm(root);
      if (!result.recovered) result = recoverPm(root);
    }
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  }
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = error instanceof DeliverError ? error.code : 70;
}
