#!/usr/bin/env node
import { DeliverError } from './lib/state.mjs';
import { gitRoot, snapshot } from './lib/scope.mjs';
import { initializePm, readPm, approvePm, claimPm, completePm, recoverPm, pmActorId } from './lib/pm.mjs';
import { detectProjectFormat, inspectProjectState } from './lib/project-state.mjs';

const help = `Shared Deliver project state (upstream 0.22.0)
  pm.mjs init [--name PROJECT]
  pm.mjs status
  pm.mjs actor-id
  pm.mjs approve --approver ACTUAL_USER
  pm.mjs claim --story docs/stories/S1-1-example.md [--branch pm/S1-1-example]
  pm.mjs complete --run UUID --commit FULL_INTEGRATION_SHA --next "Next ready story or decision"
  pm.mjs recover

Run in the project checkout. These commands never commit, merge, push or execute a model.
Complete records a verified, committed story boundary, not an unmerged implementation.
Recover completes an interrupted journal only when every file matches its before/after image.
`;
try {
  const [command = 'help', ...rest] = process.argv.slice(2);
  if (['help', '--help', '-h'].includes(command)) process.stdout.write(help);
  else {
    const allowed = { init: ['--name'], status: [], 'actor-id': [], approve: ['--approver'], claim: ['--story', '--branch'], complete: ['--run', '--commit', '--next'], recover: [] };
    if (!Object.hasOwn(allowed, command)) throw new DeliverError('unknown shared PM command', 64);
    const options = {};
    for (let i = 0; i < rest.length; i += 2) {
      if (!allowed[command].includes(rest[i]) || !rest[i + 1] || Object.hasOwn(options, rest[i])) throw new DeliverError('unknown, duplicate or missing PM option', 64);
      options[rest[i]] = rest[i + 1];
    }
    const root = gitRoot(process.cwd());
    let result;
    if (command === 'init') result = initializePm(root, options['--name']);
    else if (command === 'status') {
      const format = detectProjectFormat(root);
      if (format === 'current') result = inspectProjectState(root);
      else {
        const shared = readPm(root);
        result = { managed: Boolean(shared), ...shared };
      }
    }
    else if (command === 'actor-id') result = { actor: pmActorId(root) };
    else if (command === 'approve') result = approvePm(root, options['--approver']);
    else if (command === 'claim') result = claimPm(root, options['--story'], options['--branch']);
    else if (command === 'complete') result = completePm(root, options['--run'], options['--commit'], options['--next'], snapshot);
    else result = recoverPm(root);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  }
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = error instanceof DeliverError ? error.code : 70;
}
