import fs from 'node:fs';

export const BENCHMARK_INPUT_MAX_BYTES = 1024 * 1024;

const LIMITS = Object.freeze({
  id: 128,
  label: 200,
  provider: 128,
  model: 256,
  role: 128,
  reasoningEffort: 64,
  notes: 4000,
  elapsedSeconds: 31_536_000,
  retries: 100,
  gates: 1000,
  findings: 10_000,
  changedPaths: 100_000,
  tokens: 1_000_000_000_000,
  cost: 1_000_000_000,
});

const ROOT_KEYS = new Set(['schema_version', 'benchmark_id', 'story', 'base_commit', 'runs']);
const RUN_KEYS = new Set([
  'configuration',
  'story',
  'base_commit',
  'status',
  'elapsed_seconds',
  'retries',
  'gates',
  'first_pass_gates',
  'review_findings',
  'changed_paths',
  'tokens',
  'cost',
  'notes',
]);
const CONFIGURATION_KEYS = new Set(['id', 'label', 'provider', 'model', 'role', 'reasoning_effort']);
const GATE_KEYS = new Set(['passed', 'total']);
const FINDING_KEYS = new Set(['block', 'major']);
const STATUSES = new Set(['completed', 'blocked', 'failed']);
const BASE_COMMIT = /^[0-9a-f]{7,64}$/i;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path}.${key} is not allowed`);
  }
}

function requireKeys(value, keys, path, errors) {
  for (const key of keys) {
    if (!(key in value)) errors.push(`${path}.${key} is required`);
  }
}

function text(value, path, maxLength, errors) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    errors.push(`${path} must be a non-empty string of at most ${maxLength} characters`);
    return false;
  }
  return true;
}

function nullableText(value, path, maxLength, errors) {
  if (value === null) return true;
  return text(value, path, maxLength, errors);
}

function finiteNumber(value, path, maximum, errors) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) {
    errors.push(`${path} must be a finite number between 0 and ${maximum}`);
    return false;
  }
  return true;
}

function integer(value, path, maximum, errors, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    errors.push(`${path} must be an integer between ${minimum} and ${maximum}`);
    return false;
  }
  return true;
}

function nullableNumber(value, path, maximum, errors, integerOnly = false) {
  if (value === null) return true;
  return integerOnly
    ? integer(value, path, maximum, errors)
    : finiteNumber(value, path, maximum, errors);
}

function validateConfiguration(value, path, errors) {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  requireKeys(value, CONFIGURATION_KEYS, path, errors);
  hasOnlyKeys(value, CONFIGURATION_KEYS, path, errors);
  text(value.id, `${path}.id`, LIMITS.id, errors);
  text(value.label, `${path}.label`, LIMITS.label, errors);
  text(value.provider, `${path}.provider`, LIMITS.provider, errors);
  text(value.model, `${path}.model`, LIMITS.model, errors);
  text(value.role, `${path}.role`, LIMITS.role, errors);
  nullableText(value.reasoning_effort, `${path}.reasoning_effort`, LIMITS.reasoningEffort, errors);
}

function validateRun(value, index, errors) {
  const path = `$.runs[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  requireKeys(value, [
    'configuration',
    'story',
    'base_commit',
    'status',
    'elapsed_seconds',
    'retries',
    'gates',
    'first_pass_gates',
    'review_findings',
    'changed_paths',
    'tokens',
    'cost',
  ], path, errors);
  hasOnlyKeys(value, RUN_KEYS, path, errors);
  validateConfiguration(value.configuration, `${path}.configuration`, errors);
  text(value.story, `${path}.story`, LIMITS.label, errors);
  if (typeof value.base_commit !== 'string' || !BASE_COMMIT.test(value.base_commit)) {
    errors.push(`${path}.base_commit must be a 7 to 64 character hexadecimal commit ID`);
  }

  if (!STATUSES.has(value.status)) errors.push(`${path}.status must be completed, blocked, or failed`);
  finiteNumber(value.elapsed_seconds, `${path}.elapsed_seconds`, LIMITS.elapsedSeconds, errors);
  integer(value.retries, `${path}.retries`, LIMITS.retries, errors);

  if (!isRecord(value.gates)) {
    errors.push(`${path}.gates must be an object`);
  } else {
    requireKeys(value.gates, GATE_KEYS, `${path}.gates`, errors);
    hasOnlyKeys(value.gates, GATE_KEYS, `${path}.gates`, errors);
    const passedValid = integer(value.gates.passed, `${path}.gates.passed`, LIMITS.gates, errors);
    const totalValid = integer(value.gates.total, `${path}.gates.total`, LIMITS.gates, errors, 1);
    if (passedValid && totalValid && value.gates.passed > value.gates.total) {
      errors.push(`${path}.gates.passed cannot exceed gates.total`);
    }
  }

  if (typeof value.first_pass_gates !== 'boolean') {
    errors.push(`${path}.first_pass_gates must be a boolean`);
  }

  if (!isRecord(value.review_findings)) {
    errors.push(`${path}.review_findings must be an object`);
  } else {
    requireKeys(value.review_findings, FINDING_KEYS, `${path}.review_findings`, errors);
    hasOnlyKeys(value.review_findings, FINDING_KEYS, `${path}.review_findings`, errors);
    integer(value.review_findings.block, `${path}.review_findings.block`, LIMITS.findings, errors);
    integer(value.review_findings.major, `${path}.review_findings.major`, LIMITS.findings, errors);
  }

  integer(value.changed_paths, `${path}.changed_paths`, LIMITS.changedPaths, errors);
  nullableNumber(value.tokens, `${path}.tokens`, LIMITS.tokens, errors, true);
  nullableNumber(value.cost, `${path}.cost`, LIMITS.cost, errors);
  if ('notes' in value && typeof value.notes !== 'string') {
    errors.push(`${path}.notes must be a string`);
  } else if (typeof value.notes === 'string' && value.notes.length > LIMITS.notes) {
    errors.push(`${path}.notes must be at most ${LIMITS.notes} characters`);
  }

  const fullGatePass = isRecord(value.gates)
    && Number.isSafeInteger(value.gates.passed)
    && Number.isSafeInteger(value.gates.total)
    && value.gates.passed === value.gates.total;
  if (value.first_pass_gates === true && !fullGatePass) {
    errors.push(`${path}.first_pass_gates cannot be true unless every gate passed`);
  }
  if (value.first_pass_gates === true && value.retries !== 0) {
    errors.push(`${path}.first_pass_gates cannot be true when retries is non-zero`);
  }
  if ((value.status === 'blocked' || value.status === 'failed') && value.first_pass_gates === true) {
    errors.push(`${path}.first_pass_gates cannot be true for a ${value.status} run`);
  }
}

function configurationSignature(configuration) {
  return JSON.stringify([
    configuration.provider,
    configuration.model,
    configuration.role,
    configuration.reasoning_effort,
  ]);
}

export function validateBenchmarkResult(value) {
  const errors = [];
  if (!isRecord(value)) {
    return { valid: false, errors: ['$ must be an object'] };
  }

  requireKeys(value, ROOT_KEYS, '$', errors);
  hasOnlyKeys(value, ROOT_KEYS, '$', errors);
  if (value.schema_version !== 1) errors.push('$.schema_version must equal 1');
  text(value.benchmark_id, '$.benchmark_id', LIMITS.id, errors);
  text(value.story, '$.story', LIMITS.label, errors);
  if (typeof value.base_commit !== 'string' || !BASE_COMMIT.test(value.base_commit)) {
    errors.push('$.base_commit must be a 7 to 64 character hexadecimal commit ID');
  }

  if (!Array.isArray(value.runs) || value.runs.length !== 2) {
    errors.push('$.runs must contain exactly two runs');
  } else {
    value.runs.forEach((run, index) => validateRun(run, index, errors));
    value.runs.forEach((run, index) => {
      if (isRecord(run) && run.story !== value.story) {
        errors.push(`$.runs[${index}].story must match $.story`);
      }
      if (isRecord(run) && run.base_commit !== value.base_commit) {
        errors.push(`$.runs[${index}].base_commit must match $.base_commit`);
      }
    });
    const configurations = value.runs.map((run) => run?.configuration).filter(isRecord);
    if (configurations.length === 2) {
      if (configurations[0].id === configurations[1].id) {
        errors.push('$.runs must use distinct configuration IDs');
      }
      if (configurationSignature(configurations[0]) === configurationSignature(configurations[1])) {
        errors.push('$.runs must use distinct effective builder configurations');
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export class BenchmarkValidationError extends Error {
  constructor(errors) {
    super(`invalid benchmark result: ${errors.join('; ')}`);
    this.name = 'BenchmarkValidationError';
    this.errors = errors;
  }
}

export function assertBenchmarkResult(value) {
  const validation = validateBenchmarkResult(value);
  if (!validation.valid) throw new BenchmarkValidationError(validation.errors);
  return value;
}

function roundedScore(value) {
  return Math.round(value * 10) / 10;
}

function compareIds(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function scoreBenchmarkResult(value) {
  const result = assertBenchmarkResult(value);
  const completedTimes = result.runs
    .filter((run) => run.status === 'completed')
    .map((run) => run.elapsed_seconds);
  const fastest = completedTimes.length > 0 ? Math.min(...completedTimes) : 0;

  const runs = result.runs.map((run) => {
    let rawScore = 0;
    if (run.status === 'completed') {
      const quality = Math.max(20 - run.review_findings.block * 10 - run.review_findings.major * 4, 0);
      const speed = run.elapsed_seconds === 0 || fastest === 0
        ? 5
        : (5 * fastest) / run.elapsed_seconds;
      rawScore = 20
        + (30 * run.gates.passed) / run.gates.total
        + (run.first_pass_gates ? 20 : 0)
        + quality
        + 5 / (1 + run.retries)
        + speed;
    }
    const eligible = run.status === 'completed'
      && run.gates.passed === run.gates.total
      && run.review_findings.block === 0
      && run.review_findings.major === 0;
    return { ...run, eligible, score: roundedScore(rawScore) };
  }).sort((left, right) => right.score - left.score
    || compareIds(left.configuration.id, right.configuration.id));

  const eligible = runs.filter((run) => run.eligible);
  let outcome;
  if (eligible.length === 0) {
    outcome = {
      kind: 'no_eligible_winner',
      winner_configuration_id: null,
      tied_configuration_ids: [],
      score: null,
    };
  } else {
    const bestScore = Math.max(...eligible.map((run) => run.score));
    const tied = eligible
      .filter((run) => run.score === bestScore)
      .map((run) => run.configuration.id)
      .sort(compareIds);
    outcome = tied.length > 1
      ? {
          kind: 'tie',
          winner_configuration_id: null,
          tied_configuration_ids: tied,
          score: bestScore,
        }
      : {
          kind: 'winner',
          winner_configuration_id: tied[0],
          tied_configuration_ids: [],
          score: bestScore,
        };
  }

  return {
    schema_version: result.schema_version,
    benchmark_id: result.benchmark_id,
    story: result.story,
    base_commit: result.base_commit,
    runs,
    outcome,
  };
}

function escapeMarkdown(value) {
  return String(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\|`*_[\]{}()#+.!-])/g, '\\$1');
}

function configurationDisplay(configuration) {
  return `${escapeMarkdown(configuration.label)} [${escapeMarkdown(configuration.id)}]`;
}

function displayNumber(value) {
  return value === null ? 'unknown' : String(value);
}

export function renderBenchmarkMarkdown(value) {
  const scored = scoreBenchmarkResult(value);
  const lines = [
    '# Builder benchmark',
    '',
    `Benchmark: ${escapeMarkdown(scored.benchmark_id)}`,
    '',
    `Story: ${escapeMarkdown(scored.story)}`,
    '',
    `Base commit: ${escapeMarkdown(scored.base_commit)}`,
    '',
    '| Configuration | Status | Eligible | Time | First-pass gates | Gates | Block | Major | Retries | Paths | Tokens | Cost | Score |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...scored.runs.map((run) => `| ${configurationDisplay(run.configuration)} | ${run.status} | ${run.eligible ? 'yes' : 'no'} | ${run.elapsed_seconds}s | ${run.first_pass_gates} | ${run.gates.passed}/${run.gates.total} | ${run.review_findings.block} | ${run.review_findings.major} | ${run.retries} | ${run.changed_paths} | ${displayNumber(run.tokens)} | ${displayNumber(run.cost)} | ${run.score} |`),
    '',
  ];

  if (scored.outcome.kind === 'no_eligible_winner') {
    lines.push('Outcome: no eligible winner. A run must complete, pass every gate, and have no block or major review findings.');
  } else if (scored.outcome.kind === 'tie') {
    const tied = scored.outcome.tied_configuration_ids
      .map((id) => scored.runs.find((run) => run.configuration.id === id)?.configuration)
      .filter(Boolean)
      .map(configurationDisplay)
      .join(', ');
    lines.push(`Outcome: tie between ${tied} at ${scored.outcome.score}. No route was selected.`);
  } else {
    const winner = scored.runs.find((run) => run.configuration.id === scored.outcome.winner_configuration_id);
    lines.push(`Outcome: ${configurationDisplay(winner.configuration)} has the highest eligible score at ${scored.outcome.score}. This result does not change the story route.`);
  }
  lines.push('');
  return lines.join('\n');
}

export function readBenchmarkResultFile(inputPath, { maxBytes = BENCHMARK_INPUT_MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > BENCHMARK_INPUT_MAX_BYTES) {
    throw new RangeError(`maxBytes must be between 1 and ${BENCHMARK_INPUT_MAX_BYTES}`);
  }
  let descriptor;
  try {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    descriptor = fs.openSync(inputPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | noFollow);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new BenchmarkInputError('input must be a regular file', 'not_regular');
    if (stat.size > maxBytes) throw new BenchmarkInputError(`input exceeds ${maxBytes} bytes`, 'too_large');
    const raw = fs.readFileSync(descriptor, 'utf8');
    if (Buffer.byteLength(raw) > maxBytes) {
      throw new BenchmarkInputError(`input exceeds ${maxBytes} bytes`, 'too_large');
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new BenchmarkInputError('input is not valid JSON', 'invalid_json');
    }
  } catch (error) {
    if (error instanceof BenchmarkInputError) throw error;
    throw new BenchmarkInputError('input is missing or unreadable', 'unreadable');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export class BenchmarkInputError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'BenchmarkInputError';
    this.reason = reason;
  }
}
