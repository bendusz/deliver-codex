#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BenchmarkInputError,
  BenchmarkValidationError,
  readBenchmarkResultFile,
  renderBenchmarkMarkdown,
} from './lib/benchmark.mjs';

const EXIT_USAGE = 64;
const EXIT_INVALID = 65;
const EXIT_INPUT = 66;

export function runBenchmarkCli(argv, io = process) {
  if (argv.length !== 1) {
    io.stderr.write('usage: benchmark.mjs <result.json>\n');
    return EXIT_USAGE;
  }

  try {
    const result = readBenchmarkResultFile(argv[0]);
    io.stdout.write(renderBenchmarkMarkdown(result));
    return 0;
  } catch (error) {
    if (error instanceof BenchmarkValidationError) {
      io.stderr.write('benchmark: invalid benchmark result\n');
      return EXIT_INVALID;
    }
    if (error instanceof BenchmarkInputError) {
      const code = error.reason === 'invalid_json' || error.reason === 'too_large'
        ? EXIT_INVALID
        : EXIT_INPUT;
      io.stderr.write(`benchmark: ${error.message}\n`);
      return code;
    }
    throw error;
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath !== null && fileURLToPath(import.meta.url) === entryPath) {
  process.exitCode = runBenchmarkCli(process.argv.slice(2));
}
