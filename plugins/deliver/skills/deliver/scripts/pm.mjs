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
  revokeCurrentPm,
} from './lib/current-pm.mjs';

const help = `Shared Deliver project state
  pm.mjs init [--name PROJECT] [--format current|legacy]
  pm.mjs status
  pm.mjs actor-id
  pm.mjs approve --approver ACTUAL_USER
  pm.mjs revoke [--reason TEXT]
  pm.mjs claim --story docs/stories/S1-1-example.md [--branch pm/S1-1-example]
  pm.mjs complete --run UUID --commit FULL_INTEGRATION_SHA --next "Next ready story or decision"
  pm.mjs recover

Run in the project checkout. These commands never commit, merge, push or execute a model.
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
try {
  const [command = 'help', ...rest] = process.argv.slice(2);
  if (['help', '--help', '-h'].includes(command)) process.stdout.write(help);
  else {
    const allowed = { init: ['--name', '--format'], status: [], 'actor-id': [], approve: ['--approver'], revoke: ['--reason'], claim: ['--story', '--branch'], complete: ['--run', '--commit', '--next'], recover: [] };
    if (!Object.hasOwn(allowed, command)) throw new DeliverError('unknown shared PM command', 64);
    const options = {};
    for (let i = 0; i < rest.length; i += 2) {
      if (!allowed[command].includes(rest[i]) || !rest[i + 1] || Object.hasOwn(options, rest[i])) throw new DeliverError('unknown, duplicate or missing PM option', 64);
      options[rest[i]] = rest[i + 1];
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
      if (format === 'current') result = inspectProjectState(root);
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
    else if (command === 'complete') {
      if (format === 'current') throw new DeliverError('current story completion requires the integration workflow', 66);
      result = completePm(root, options['--run'], options['--commit'], options['--next'], snapshot);
    }
    else {
      result = recoverCurrentPm(root);
      if (!result.recovered) result = recoverPm(root);
    }
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  }
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = error instanceof DeliverError ? error.code : 70;
}
