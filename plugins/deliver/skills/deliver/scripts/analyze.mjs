#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ANALYSIS_STAGES,
  AnalysisInputError,
  analyzeProjectArtifacts,
  renderAnalysisMarkdown,
} from './lib/analyze.mjs';

const USAGE = 'usage: analyze.mjs --root <directory> --stage <post-plan|post-decomposition|pre-claim> [--story <S<n>-<n>>] [--format <json|markdown>]';

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length > 10 || argv.some((item) => typeof item !== 'string' || item.length > 4096 || /[\x00-\x1f\x7f]/.test(item))) {
    throw new AnalysisInputError('invalid command arguments');
  }
  const options = { root: null, stage: null, storyId: null, format: 'markdown' };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new AnalysisInputError(`missing value for ${flag}`);
    if (!['--root', '--stage', '--story', '--format'].includes(flag) || seen.has(flag)) {
      throw new AnalysisInputError(`unknown or duplicate argument ${flag}`);
    }
    seen.add(flag);
    if (flag === '--root') options.root = value;
    else if (flag === '--stage') options.stage = value;
    else if (flag === '--story') options.storyId = value;
    else options.format = value;
  }
  if (!options.root || !ANALYSIS_STAGES.includes(options.stage) || !['json', 'markdown'].includes(options.format)) {
    throw new AnalysisInputError('required arguments are missing or invalid');
  }
  return options;
}

export function runAnalyzeCli(argv, io = process) {
  let options;
  try { options = parseArguments(argv); }
  catch (error) {
    io.stderr.write(`${USAGE}\n`);
    return 64;
  }
  try {
    const analysis = analyzeProjectArtifacts(options.root, {
      stage: options.stage,
      scope: options.storyId ? { kind: 'story', storyId: options.storyId } : { kind: 'project' },
    });
    io.stdout.write(options.format === 'json'
      ? `${JSON.stringify(analysis, null, 2)}\n`
      : renderAnalysisMarkdown(analysis));
    return ['BLOCKED', 'UNKNOWN'].includes(analysis.status) ? 1 : 0;
  } catch (error) {
    if (!(error instanceof AnalysisInputError)) throw error;
    io.stderr.write(`analyze: ${error.message}\n`);
    return 66;
  }
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entry !== null && fileURLToPath(import.meta.url) === entry) {
  process.exitCode = runAnalyzeCli(process.argv.slice(2));
}
