import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { canonical, sha256, DeliverError, internalDirectory } from './state.mjs';
import { inspectScope } from './scope.mjs';

const MAX_OUTPUT = 1024 * 1024;

export function parseEnvironment(file) {
  if (!file) return {};
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new DeliverError(`invalid gate environment JSON: ${error.message}`, 64); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DeliverError('gate environment must be a JSON object', 64);
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== 'string' || item.includes('\0')) throw new DeliverError(`invalid gate environment entry: ${key}`, 64);
  }
  return value;
}

function additionsHash(additions) { return sha256(canonical(additions)); }

export function environmentHandle(cwd, environmentAdditionsHash) {
  // Hash all inherited values, never persist the values themselves. Exclude
  // shell bookkeeping that does not describe the command's effective inputs.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['_', 'SHLVL', 'OLDPWD'].includes(key)));
  return sha256(canonical({ cwd: fs.realpathSync(cwd), inherited, environment_additions_hash: environmentAdditionsHash }));
}

function safeCwd(root, raw = '.') {
  const abs = path.resolve(root, raw);
  let real;
  try { real = fs.realpathSync(abs); } catch { throw new DeliverError(`gate cwd does not exist: ${raw}`, 66); }
  const relative = path.relative(root, real);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new DeliverError('gate cwd escapes the project root', 66);
  return real;
}

export function executeGate(state, { name, command, cwd = '.', environment = {} }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name || '')) throw new DeliverError('gate name must be a safe identifier', 64);
  if (typeof command !== 'string' || command.trim() === '' || command.includes('\0')) throw new DeliverError('--command must be a non-empty exact shell command', 64);
  const gateCwd = safeCwd(state.project_root, cwd);
  if (gateCwd !== state.project_root) throw new DeliverError('declared gates run at the project root; include an explicit directory change in the approved command', 66);
  const environmentAdditionsHash = additionsHash(environment);
  const logDir = internalDirectory(state.project_root, ['logs', state.run_id]);
  const logPath = path.join(logDir, `${name}-${randomUUID()}.log`);
  try {
    fs.lstatSync(logPath);
    throw new DeliverError(`gate log target already exists: ${logPath}`, 66);
  } catch (error) {
    if (error instanceof DeliverError) throw error;
    if (error.code !== 'ENOENT') throw new DeliverError(`cannot inspect gate log target: ${error.message}`, 66);
  }
  const before = inspectScope(state);
  if (!before.report.ok) throw new DeliverError('gate refused because the current scope check fails', 74, before.report);
  const started = new Date().toISOString();
  const result = spawnSync(command, {
    cwd: gateCwd,
    env: { ...process.env, ...environment },
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
    maxBuffer: MAX_OUTPUT,
    timeout: 10 * 60 * 1000,
  });
  const { current, report } = inspectScope(state);
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  try {
    fs.writeFileSync(logPath, `command: ${command}\ncwd: ${gateCwd}\nstarted: ${started}\nexit: ${result.status ?? 'null'}\n\n[stdout]\n${stdout}\n[stderr]\n${stderr}`, { mode: 0o600, flag: 'wx' });
  } catch (error) { throw new DeliverError(`cannot create exclusive gate log: ${error.message}`, 66); }
  // A formatter or generator can change code after its checks have run. Its
  // exit status cannot verify that new tree. Require a stable follow-up gate.
  const mutated = before.current.hash !== current.hash;
  const passed = result.status === 0 && !result.error && report.ok && !mutated;
  return {
    provenance: 'deliver-runtime-executed-v1',
    name,
    command,
    cwd: path.relative(state.project_root, gateCwd).split(path.sep).join('/') || '.',
    environment_keys: Object.keys(environment).sort(),
    environment_additions_hash: environmentAdditionsHash,
    environment_hash: environmentHandle(gateCwd, environmentAdditionsHash),
    snapshot_hash: current.hash,
    status: passed ? 'PASS' : 'FAIL',
    exit_code: result.status,
    signal: result.signal || null,
    error: result.error ? result.error.message : mutated ? 'gate changed authoritative files; rerun a non-mutating check against the resulting tree' : null,
    log_path: path.relative(state.project_root, logPath).split(path.sep).join('/'),
    output: { stdout_bytes: Buffer.byteLength(stdout), stderr_bytes: Buffer.byteLength(stderr), truncated: result.error?.code === 'ENOBUFS' },
    scope: report,
    started_at: started,
    finished_at: new Date().toISOString(),
  };
}

export function gateIsCurrent(state, gate, snapshotHash) {
  if (!gate || gate.provenance !== 'deliver-runtime-executed-v1' || gate.status !== 'PASS' || gate.snapshot_hash !== snapshotHash) return false;
  const cwd = safeCwd(state.project_root, gate.cwd);
  return gate.environment_hash === environmentHandle(cwd, gate.environment_additions_hash);
}
