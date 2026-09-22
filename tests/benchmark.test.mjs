import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  BENCHMARK_INPUT_MAX_BYTES,
  BenchmarkValidationError,
  assertBenchmarkResult,
  renderBenchmarkMarkdown,
  scoreBenchmarkResult,
  validateBenchmarkResult,
} from '../plugins/deliver/skills/deliver/scripts/lib/benchmark.mjs';

const CLI = fileURLToPath(new URL('../plugins/deliver/skills/deliver/scripts/benchmark.mjs', import.meta.url));
const LIBRARY = fileURLToPath(new URL('../plugins/deliver/skills/deliver/scripts/lib/benchmark.mjs', import.meta.url));

function configuration(id, overrides = {}) {
  return {
    id,
    label: `Builder ${id}`,
    provider: 'native',
    model: `model-${id}`,
    role: 'deliver-builder',
    reasoning_effort: 'high',
    ...overrides,
  };
}

function run(id, overrides = {}) {
  return {
    configuration: configuration(id),
    story: 'STORY-13',
    base_commit: 'abcdef1234567890',
    status: 'completed',
    elapsed_seconds: id === 'a' ? 10 : 20,
    retries: id === 'a' ? 0 : 1,
    gates: { passed: 3, total: 3 },
    first_pass_gates: id === 'a',
    review_findings: { block: 0, major: 0 },
    changed_paths: 4,
    tokens: null,
    cost: null,
    ...overrides,
  };
}

function result(overrides = {}) {
  return {
    schema_version: 1,
    benchmark_id: 'benchmark-13',
    story: 'STORY-13',
    base_commit: 'abcdef1234567890',
    runs: [run('a'), run('b')],
    ...overrides,
  };
}

function withTemporaryDirectory(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-benchmark-'));
  try {
    return callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('validator accepts two explicit configurations and unavailable measurements', () => {
  const fixture = result();
  assert.deepEqual(validateBenchmarkResult(fixture), { valid: true, errors: [] });
  assert.equal(assertBenchmarkResult(fixture), fixture);
});

test('validator rejects inconsistent identifiers, duplicate effective configurations, and invalid measurements', () => {
  const fixture = result();
  fixture.runs[1].story = 'OTHER-STORY';
  fixture.runs[1].base_commit = '1234567';
  fixture.runs[1].configuration = {
    ...fixture.runs[0].configuration,
    id: 'different-label-only',
    label: 'Different label only',
  };
  fixture.runs[0].elapsed_seconds = Number.POSITIVE_INFINITY;
  fixture.runs[0].gates = { passed: 4, total: 3 };
  fixture.runs[0].retries = 1;
  fixture.runs[0].tokens = 2.5;
  fixture.runs[1].cost = Number.NaN;

  const validation = validateBenchmarkResult(fixture);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('\n'), /story must match/);
  assert.match(validation.errors.join('\n'), /base_commit must match/);
  assert.match(validation.errors.join('\n'), /distinct effective builder configurations/);
  assert.match(validation.errors.join('\n'), /finite number/);
  assert.match(validation.errors.join('\n'), /cannot exceed/);
  assert.match(validation.errors.join('\n'), /first_pass_gates cannot be true when retries is non-zero/);
  assert.match(validation.errors.join('\n'), /tokens must be an integer/);
  assert.throws(() => scoreBenchmarkResult(fixture), BenchmarkValidationError);
});

test('scorer keeps upstream quality factors and selects only an eligible run', () => {
  const scored = scoreBenchmarkResult(result());
  assert.equal(scored.runs.find((item) => item.configuration.id === 'a').score, 100);
  assert.equal(scored.outcome.kind, 'winner');
  assert.equal(scored.outcome.winner_configuration_id, 'a');

  const gateFailureWithHigherRawScore = result({
    runs: [
      run('a', {
        gates: { passed: 2, total: 3 },
        first_pass_gates: false,
        elapsed_seconds: 1,
      }),
      run('b', { elapsed_seconds: 100, retries: 3 }),
    ],
  });
  const eligibleWins = scoreBenchmarkResult(gateFailureWithHigherRawScore);
  assert.equal(eligibleWins.outcome.kind, 'winner');
  assert.equal(eligibleWins.outcome.winner_configuration_id, 'b');
});

test('scorer reports ties and no eligible winner explicitly', () => {
  const tied = result({
    runs: [
      run('a', { elapsed_seconds: 10, retries: 0, first_pass_gates: true }),
      run('b', { elapsed_seconds: 10, retries: 0, first_pass_gates: true }),
    ],
  });
  const tieScore = scoreBenchmarkResult(tied);
  assert.deepEqual(tieScore.outcome, {
    kind: 'tie',
    winner_configuration_id: null,
    tied_configuration_ids: ['a', 'b'],
    score: 100,
  });

  const ineligible = result({
    runs: [
      run('a', { status: 'failed', first_pass_gates: false }),
      run('b', { review_findings: { block: 0, major: 1 } }),
    ],
  });
  const noWinner = scoreBenchmarkResult(ineligible);
  assert.equal(noWinner.outcome.kind, 'no_eligible_winner');
  assert.equal(noWinner.outcome.winner_configuration_id, null);
  assert.match(renderBenchmarkMarkdown(ineligible), /Outcome: no eligible winner\./);
});

test('Markdown renderer escapes untrusted labels and keeps table rows intact', () => {
  const fixture = result({ benchmark_id: 'bench\n# injected' });
  fixture.runs[0].configuration.label = 'builder |\n| injected <script>';
  const markdown = renderBenchmarkMarkdown(fixture);

  assert.doesNotMatch(markdown, /^# injected/m);
  assert.doesNotMatch(markdown, /<script>/);
  assert.match(markdown, /builder \\\| \\\| injected &lt;script&gt;/);
  const dataRows = markdown.split('\n').filter((line) => line.startsWith('| ')
    && !line.startsWith('| Configuration'));
  assert.equal(dataRows.length, 2);
});

test('import has no output, provider calls, or filesystem changes', () => withTemporaryDirectory((directory) => {
  const marker = path.join(directory, 'marker.txt');
  fs.writeFileSync(marker, 'unchanged');
  const before = fs.readdirSync(directory);
  const program = [
    'globalThis.fetch = () => { throw new Error("provider call"); };',
    `await import(${JSON.stringify(pathToFileURL(LIBRARY).href)});`,
    `await import(${JSON.stringify(pathToFileURL(CLI).href)});`,
  ].join('\n');
  const imported = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 2000,
  });

  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
  assert.equal(imported.stderr, '');
  assert.deepEqual(fs.readdirSync(directory), before);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'unchanged');
}));

test('CLI scores a bounded regular file without changing its directory', () => withTemporaryDirectory((directory) => {
  const input = path.join(directory, 'result.json');
  fs.writeFileSync(input, JSON.stringify(result()));
  const before = fs.readdirSync(directory);
  const executed = spawnSync(process.execPath, [CLI, input], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 2000,
  });

  assert.equal(executed.status, 0, executed.stderr);
  assert.match(executed.stdout, /^# Builder benchmark\n/);
  assert.match(executed.stdout, /Outcome: Builder a \[a\] has the highest eligible score at 100\./);
  assert.equal(executed.stderr, '');
  assert.deepEqual(fs.readdirSync(directory), before);
}));

test('CLI rejects oversized files and non-regular FIFO input without hanging', (t) => withTemporaryDirectory((directory) => {
  const oversized = path.join(directory, 'oversized.json');
  fs.writeFileSync(oversized, Buffer.alloc(BENCHMARK_INPUT_MAX_BYTES + 1, 32));
  const tooLarge = spawnSync(process.execPath, [CLI, oversized], {
    encoding: 'utf8',
    timeout: 2000,
  });
  assert.equal(tooLarge.status, 65);
  assert.match(tooLarge.stderr, /exceeds/);

  const fifo = path.join(directory, 'result.fifo');
  const madeFifo = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  if (madeFifo.error?.code === 'ENOENT') {
    t.skip('mkfifo is unavailable');
    return;
  }
  assert.equal(madeFifo.status, 0, madeFifo.stderr);
  const rejected = spawnSync(process.execPath, [CLI, fifo], {
    encoding: 'utf8',
    timeout: 2000,
  });
  assert.equal(rejected.error, undefined);
  assert.equal(rejected.status, 66);
  assert.match(rejected.stderr, /regular file/);
}));
