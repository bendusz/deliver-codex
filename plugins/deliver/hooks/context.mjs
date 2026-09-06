#!/usr/bin/env node
// Optional Codex hook. Never writes state or treats state text as instructions.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (typeof input.cwd !== 'string' || process.env.DELIVER_NO_ENFORCE === '1') process.exit(0);
  const root = execFileSync('git', ['-C', input.cwd, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore']
  }).trimEnd();
  const hints = [];
  try {
    if (fs.lstatSync(path.join(root, 'pm')).isDirectory()
      && fs.lstatSync(path.join(root, 'pm/pm-state.json')).isFile()) {
      hints.push('Shared Deliver project state is in pm/pm-state.json and pm/actors/. Read the Deliver compatibility reference and shared state before selecting or resuming a story.');
    }
  } catch {}
  const store = path.join(root, '.deliver');
  const runs = path.join(store, 'runs');
  const states = (() => { try {
    if (fs.lstatSync(store).isSymbolicLink() || fs.lstatSync(runs).isSymbolicLink()) return [];
    return fs.readdirSync(runs).filter((name) => /^[0-9a-f-]{36}\.json$/.test(name)).slice(-20).flatMap((name) => {
    try {
      const file = path.join(runs, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) return [];
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!['initialized', 'starting', 'active'].includes(state.phase) || !Number.isSafeInteger(state.revision)) return [];
      return [`${name.slice(0, -5)}: ${state.phase}, revision ${state.revision}`];
    } catch { return []; }
    }).slice(0, 3);
  } catch { return []; } })();
  if (states.length) hints.push(`Deliver execution receipts are available under .deliver/runs/: ${states.join('; ')}. Inspect the actual worktree before writing. Multiple runs require explicit selection.`);
  if (hints.length) process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: hints.join(' ')
  } }));
} catch { /* Optional pointer hook is inert without readable valid state. */ }
