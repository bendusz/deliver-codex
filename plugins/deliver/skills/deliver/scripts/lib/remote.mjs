import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DeliverError } from './state.mjs';

export const GITHUB_REMOTE_STAGES = Object.freeze([
  'preflight', 'lookup', 'publish', 'checks', 'merge', 'postmerge',
]);

export const GITHUB_REMOTE_STATES = Object.freeze([
  'UNAVAILABLE',
  'GIT_ERROR',
  'REMOTE_MISSING',
  'REMOTE_AMBIGUOUS',
  'UNSUPPORTED_REMOTE',
  'AUTH_REQUIRED',
  'HEAD_MISMATCH',
  'PR_ABSENT',
  'PR_AMBIGUOUS',
  'PR_LOOKUP_INCOMPLETE',
  'PR_LOOKUP_FAILED',
  'PR_CLOSED',
  'PR_MERGED',
  'PR_DRAFT',
  'CHECKS_PENDING',
  'CHECKS_FAILED',
  'CHECKS_UNKNOWN',
  'READY',
  'PUSH_REJECTED',
  'PR_WRITE_FAILED',
  'PR_READY_FAILED',
  'PUBLISHED',
  'MERGE_REJECTED',
  'MERGE_PENDING',
  'MERGE_MISMATCH',
  'MERGED',
]);

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PROVIDER_ITEMS = 100;
const LIST_FIELDS = 'number,state,isDraft,headRefName,headRefOid,baseRefName,headRepositoryOwner,url,mergeCommit';
const VIEW_FIELDS = `${LIST_FIELDS},mergeable,mergeStateStatus`;
const CHECK_FIELDS = 'name,state,bucket,workflow';
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_REPOSITORY_PART = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$/;
const SAFE_HOST = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/;
const NO_CHECKS = (branch) => new Set([
  `no checks reported on the '${branch}' branch`,
  `no required checks reported on the '${branch}' branch`,
]);

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const byteLength = (value) => Buffer.byteLength(value, 'utf8');

function invalid(message, code = 64) {
  throw new DeliverError(message, code);
}

function safeBranch(value, label) {
  if (typeof value !== 'string' || !value || value.length > 512 || value === '@'
    || value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.')
    || value.includes('..') || value.includes('//') || value.includes('@{')
    || /[\x00-\x20\x7f~^:?*[\\\]]/.test(value)
    || value.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))) {
    invalid(`${label} must be a valid Git branch name`);
  }
  return value;
}

function boundedLine(value, label, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    invalid(`${label} must be a bounded non-empty single line`);
  }
  return value;
}

function boundedBody(value, label) {
  if (typeof value !== 'string' || value.includes('\0') || byteLength(value) > MAX_BODY_BYTES) {
    invalid(`${label} must be bounded UTF-8 text without null bytes`);
  }
  return value;
}

function realRoot(root) {
  if (typeof root !== 'string' || !root || root.includes('\0')) invalid('target root must be a path', 66);
  try {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) invalid('target root must be a real directory', 66);
    return fs.realpathSync.native(root);
  } catch (error) {
    if (error instanceof DeliverError) throw error;
    invalid(`target root is unavailable: ${error.message}`, 66);
  }
}

function validateTarget(target) {
  if (!record(target)) invalid('target must be an object');
  const allowed = new Set(['root', 'remote', 'storyBranch', 'integrationBranch', 'expectedHead']);
  const unknown = Object.keys(target).filter((key) => !allowed.has(key));
  if (unknown.length) invalid(`unsupported target fields: ${unknown.join(', ')}`);
  const root = realRoot(target.root);
  if (typeof target.remote !== 'string' || !SAFE_REMOTE.test(target.remote) || target.remote.startsWith('-')) {
    invalid('target remote must be an explicit safe Git remote name');
  }
  const storyBranch = safeBranch(target.storyBranch, 'storyBranch');
  const integrationBranch = safeBranch(target.integrationBranch, 'integrationBranch');
  if (storyBranch === integrationBranch) invalid('storyBranch must differ from integrationBranch');
  if (typeof target.expectedHead !== 'string' || !OID.test(target.expectedHead)) {
    invalid('expectedHead must be a full lowercase Git object ID');
  }
  return { root, remote: target.remote, storyBranch, integrationBranch, expectedHead: target.expectedHead };
}

function diagnostic(code, message) {
  return { code, message };
}

function result(target, stage, state, extra = {}) {
  return { stage, state, expectedHead: target.expectedHead, ...extra };
}

export function runCommand({ file, args, cwd, input, timeoutMs }) {
  const child = spawnSync(file, args, {
    cwd,
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GH_PROMPT_DISABLED: '1',
    },
  });
  return {
    exitCode: child.status,
    stdout: child.stdout || '',
    stderr: child.stderr || '',
    ...(child.error ? { errorCode: child.error.code || 'COMMAND_ERROR' } : {}),
  };
}

function command(run, timeoutMs, file, args, cwd, input) {
  let value;
  try {
    value = run({ file, args: [...args], cwd, ...(input === undefined ? {} : { input }), timeoutMs });
  } catch (error) {
    return {
      exitCode: null,
      stdout: '',
      stderr: '',
      errorCode: error?.code === 'ENOENT' ? 'ENOENT' : 'COMMAND_THROW',
    };
  }
  if (!record(value) || !(value.exitCode === null || Number.isInteger(value.exitCode))
    || typeof value.stdout !== 'string' || typeof value.stderr !== 'string'
    || (value.errorCode !== undefined && typeof value.errorCode !== 'string')) {
    return { exitCode: null, stdout: '', stderr: '', errorCode: 'INVALID_RUNNER_RESULT' };
  }
  if (byteLength(value.stdout) + byteLength(value.stderr) > MAX_OUTPUT_BYTES) {
    return { exitCode: null, stdout: '', stderr: '', errorCode: 'OUTPUT_LIMIT' };
  }
  return value;
}

function commandFailure(target, stage, file, invocation, fallbackState, fallbackCode, fallbackMessage) {
  if (!invocation.errorCode) return null;
  if (invocation.errorCode === 'ENOENT') return result(target, stage, 'UNAVAILABLE', {
    diagnostic: diagnostic(file === 'git' ? 'GIT_UNAVAILABLE' : 'GH_UNAVAILABLE', `${file} is unavailable.`),
  });
  return result(target, stage, file === 'git' ? 'GIT_ERROR' : fallbackState, {
    diagnostic: diagnostic(
      invocation.errorCode === 'OUTPUT_LIMIT' ? 'COMMAND_OUTPUT_LIMIT' : fallbackCode,
      invocation.errorCode === 'OUTPUT_LIMIT' ? 'Command output exceeded the adapter limit.' : fallbackMessage,
    ),
  });
}

function trimOneLineEnding(value) {
  return value.replace(/\r\n/g, '\n').replace(/\n$/, '');
}

function repositoryPart(value) {
  return SAFE_REPOSITORY_PART.test(value) && value !== '.' && value !== '..';
}

function repository(host, owner, name) {
  if (!SAFE_HOST.test(host) || !repositoryPart(owner) || !repositoryPart(name)) return null;
  const canonicalHost = host.toLowerCase();
  const canonicalOwner = owner.toLowerCase();
  const canonicalName = name.toLowerCase();
  return {
    host: canonicalHost,
    owner: canonicalOwner,
    name: canonicalName,
    slug: `${canonicalHost}/${canonicalOwner}/${canonicalName}`,
  };
}

function parseRemoteUrl(raw) {
  if (typeof raw !== 'string' || !raw || /[\x00-\x20\x7f]/.test(raw)) return null;
  const scp = /^git@([^/:]+):([^/]+)\/([^/]+)$/.exec(raw);
  if (scp) {
    const name = scp[3].endsWith('.git') ? scp[3].slice(0, -4) : scp[3];
    return repository(scp[1], scp[2], name);
  }
  let parsed;
  try { parsed = new URL(raw); } catch { return null; }
  if (!['https:', 'ssh:'].includes(parsed.protocol) || parsed.port || parsed.search || parsed.hash) return null;
  if (parsed.protocol === 'https:' && (parsed.username || parsed.password)) return null;
  if (parsed.protocol === 'ssh:' && parsed.username && parsed.username !== 'git') return null;
  if (parsed.password || parsed.pathname.includes('%')) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const name = parts[1].endsWith('.git') ? parts[1].slice(0, -4) : parts[1];
  return repository(parsed.hostname, parts[0], name);
}

function preflight(targetInput, run, timeoutMs) {
  const target = validateTarget(targetInput);
  const remote = command(run, timeoutMs, 'git', ['remote', 'get-url', '--push', '--all', target.remote], target.root);
  const remoteFailure = commandFailure(target, 'preflight', 'git', remote, 'GIT_ERROR', 'REMOTE_LOOKUP_ERROR', 'Git could not inspect the configured remote.');
  if (remoteFailure) return { target, failure: remoteFailure };
  if (remote.exitCode !== 0) {
    const listed = command(run, timeoutMs, 'git', ['remote'], target.root);
    const listedFailure = commandFailure(target, 'preflight', 'git', listed, 'GIT_ERROR', 'REMOTE_LIST_ERROR', 'Git could not list configured remotes.');
    if (listedFailure) return { target, failure: listedFailure };
    if (listed.exitCode === 0) {
      const names = trimOneLineEnding(listed.stdout).split('\n').filter(Boolean);
      if (names.every((name) => SAFE_REMOTE.test(name)) && !names.includes(target.remote)) {
        return { target, failure: result(target, 'preflight', 'REMOTE_MISSING', {
          diagnostic: diagnostic('REMOTE_NOT_FOUND', 'The selected Git remote does not exist.'),
        }) };
      }
    }
    return { target, failure: result(target, 'preflight', 'GIT_ERROR', {
      diagnostic: diagnostic('REMOTE_LOOKUP_FAILED', 'Git could not inspect the configured remote.'),
    }) };
  }
  const urls = trimOneLineEnding(remote.stdout).split('\n').filter((line) => line.length > 0);
  if (urls.length === 0) return { target, failure: result(target, 'preflight', 'REMOTE_MISSING', {
    diagnostic: diagnostic('REMOTE_URL_MISSING', 'The selected remote has no push URL.'),
  }) };
  if (urls.length !== 1) return { target, failure: result(target, 'preflight', 'REMOTE_AMBIGUOUS', {
    diagnostic: diagnostic('REMOTE_URL_COUNT', 'The selected remote must have exactly one push URL.'),
  }) };
  const repo = parseRemoteUrl(urls[0]);
  if (!repo) return { target, failure: result(target, 'preflight', 'UNSUPPORTED_REMOTE', {
    diagnostic: diagnostic('REMOTE_URL_UNSUPPORTED', 'The push URL is not an uncredentialed GitHub HTTPS or SSH repository URL.'),
  }) };

  const branch = command(run, timeoutMs, 'git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], target.root);
  const branchFailure = commandFailure(target, 'preflight', 'git', branch, 'GIT_ERROR', 'CHECKOUT_PROBE_ERROR', 'Git could not inspect the checked-out branch.');
  if (branchFailure) return { target, failure: branchFailure };
  if (branch.exitCode !== 0) return { target, failure: result(target, 'preflight', 'GIT_ERROR', {
    repository: repo,
    diagnostic: diagnostic('CHECKOUT_NOT_SYMBOLIC', 'The target checkout is detached or unreadable.'),
  }) };
  if (trimOneLineEnding(branch.stdout) !== target.storyBranch) return { target, failure: result(target, 'preflight', 'HEAD_MISMATCH', {
    repository: repo,
    diagnostic: diagnostic('CHECKOUT_BRANCH_MISMATCH', 'The checked-out branch does not match storyBranch.'),
  }) };

  const head = command(run, timeoutMs, 'git', ['rev-parse', '--verify', 'HEAD'], target.root);
  const headFailure = commandFailure(target, 'preflight', 'git', head, 'GIT_ERROR', 'HEAD_PROBE_ERROR', 'Git could not resolve the checked-out commit.');
  if (headFailure) return { target, failure: headFailure };
  if (head.exitCode !== 0 || !OID.test(trimOneLineEnding(head.stdout))) return { target, failure: result(target, 'preflight', 'GIT_ERROR', {
    repository: repo,
    diagnostic: diagnostic('HEAD_UNREADABLE', 'Git did not return a full commit object ID.'),
  }) };
  if (trimOneLineEnding(head.stdout) !== target.expectedHead) return { target, failure: result(target, 'preflight', 'HEAD_MISMATCH', {
    repository: repo,
    diagnostic: diagnostic('LOCAL_HEAD_MISMATCH', 'The checked-out commit differs from expectedHead.'),
  }) };

  const auth = command(run, timeoutMs, 'gh', ['auth', 'status', '--active', '--hostname', repo.host], target.root);
  const authFailure = commandFailure(target, 'preflight', 'gh', auth, 'AUTH_REQUIRED', 'AUTH_PROBE_ERROR', 'GitHub authentication could not be checked.');
  if (authFailure) return { target, failure: authFailure };
  if (auth.exitCode !== 0) return { target, failure: result(target, 'preflight', 'AUTH_REQUIRED', {
    repository: repo,
    diagnostic: diagnostic('GH_AUTH_REQUIRED', 'Active GitHub CLI authentication is required for this host.'),
  }) };
  return { target, repo };
}

function parseJson(invocation) {
  try { return JSON.parse(invocation.stdout); } catch { return null; }
}

function safeProviderString(value, max = 1000) {
  return typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}

function normalizePr(value, repo) {
  if (!record(value) || !Number.isSafeInteger(value.number) || value.number <= 0
    || !['OPEN', 'CLOSED', 'MERGED'].includes(value.state) || typeof value.isDraft !== 'boolean'
    || !safeProviderString(value.headRefName, 512) || !safeProviderString(value.headRefOid, 64) || !OID.test(value.headRefOid)
    || !safeProviderString(value.baseRefName, 512) || !record(value.headRepositoryOwner)
    || !safeProviderString(value.headRepositoryOwner.login, 100)
    || !(value.url === null || safeProviderString(value.url, 2048))
    || !(value.mergeCommit === null || (record(value.mergeCommit) && safeProviderString(value.mergeCommit.oid, 64)
      && OID.test(value.mergeCommit.oid)))) return null;
  const owner = value.headRepositoryOwner.login.toLowerCase();
  let url = null;
  if (value.url) {
    try {
      const parsed = new URL(value.url);
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password
        && parsed.hostname.toLowerCase() === repo.host) url = value.url;
    } catch {}
  }
  return {
    number: value.number,
    state: value.state,
    isDraft: value.isDraft,
    headRefName: value.headRefName,
    headRefOid: value.headRefOid,
    baseRefName: value.baseRefName,
    headRepositoryOwner: owner,
    url,
    mergeCommit: value.mergeCommit,
    ...(value.mergeable === undefined ? {} : { mergeable: value.mergeable }),
    ...(value.mergeStateStatus === undefined ? {} : { mergeStateStatus: value.mergeStateStatus }),
  };
}

function publicPr(pr) {
  return {
    number: pr.number,
    state: pr.state,
    isDraft: pr.isDraft,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    baseRefName: pr.baseRefName,
    url: pr.url,
  };
}

function lookup(target, repo, run, timeoutMs, { allowStaleHead = false } = {}) {
  const args = ['pr', 'list', '--repo', repo.slug, '--state', 'all', '--head', target.storyBranch,
    '--base', target.integrationBranch, '--limit', String(MAX_PROVIDER_ITEMS), '--json', LIST_FIELDS];
  const invocation = command(run, timeoutMs, 'gh', args, target.root);
  const failure = commandFailure(target, 'lookup', 'gh', invocation, 'PR_LOOKUP_FAILED', 'PR_LOOKUP_ERROR', 'The pull request lookup could not be completed.');
  if (failure) return { failure };
  if (invocation.exitCode !== 0) return { failure: result(target, 'lookup', 'PR_LOOKUP_FAILED', {
    repository: repo,
    diagnostic: diagnostic('PR_LOOKUP_FAILED', 'The pull request lookup could not be completed.'),
  }) };
  const parsed = parseJson(invocation);
  if (!Array.isArray(parsed) || parsed.length > MAX_PROVIDER_ITEMS) return { failure: result(target, 'lookup', 'PR_LOOKUP_FAILED', {
    repository: repo,
    diagnostic: diagnostic('PR_LOOKUP_MALFORMED', 'The pull request lookup returned malformed JSON.'),
  }) };
  if (parsed.length === MAX_PROVIDER_ITEMS) return { failure: result(target, 'lookup', 'PR_LOOKUP_INCOMPLETE', {
    repository: repo,
    diagnostic: diagnostic('PR_LOOKUP_LIMIT', 'The pull request lookup reached its page limit and is incomplete.'),
  }) };
  const normalized = parsed.map((item) => normalizePr(item, repo));
  if (normalized.some((item) => item === null)) return { failure: result(target, 'lookup', 'PR_LOOKUP_FAILED', {
    repository: repo,
    diagnostic: diagnostic('PR_LOOKUP_MALFORMED', 'The pull request lookup returned invalid fields.'),
  }) };
  const matches = normalized.filter((pr) => pr.headRepositoryOwner === repo.owner
    && pr.headRefName === target.storyBranch && pr.baseRefName === target.integrationBranch);
  if (!matches.length) return { failure: result(target, 'lookup', 'PR_ABSENT', {
    repository: repo,
    diagnostic: diagnostic('PR_NOT_FOUND', 'No exact pull request exists for this repository, head and base.'),
  }) };
  if (matches.length !== 1) return { failure: result(target, 'lookup', 'PR_AMBIGUOUS', {
    repository: repo,
    diagnostic: diagnostic('PR_MULTIPLE_MATCHES', 'More than one exact pull request matches this head and base.'),
  }) };
  const pr = matches[0];
  if (pr.state === 'MERGED') return { failure: result(target, 'lookup', 'PR_MERGED', { repository: repo, pr: publicPr(pr) }) };
  if (pr.state !== 'OPEN') return { failure: result(target, 'lookup', 'PR_CLOSED', { repository: repo, pr: publicPr(pr) }) };
  if (!allowStaleHead && pr.headRefOid !== target.expectedHead) return { failure: result(target, 'lookup', 'HEAD_MISMATCH', {
    repository: repo,
    pr: publicPr(pr),
    diagnostic: diagnostic('PR_HEAD_MISMATCH', 'The pull request head differs from expectedHead.'),
  }) };
  return { pr };
}

function view(target, repo, prNumber, run, timeoutMs, { allowMerged = false, stage = 'lookup' } = {}) {
  const invocation = command(run, timeoutMs, 'gh', ['pr', 'view', String(prNumber), '--repo', repo.slug, '--json', VIEW_FIELDS], target.root);
  const failure = commandFailure(target, stage, 'gh', invocation, 'PR_LOOKUP_FAILED', 'PR_VIEW_ERROR', 'The pull request could not be read.');
  if (failure) return { failure };
  if (invocation.exitCode !== 0) return { failure: result(target, stage, 'PR_LOOKUP_FAILED', {
    repository: repo,
    diagnostic: diagnostic('PR_VIEW_FAILED', 'The pull request could not be read.'),
  }) };
  const parsed = parseJson(invocation);
  const pr = normalizePr(parsed, repo);
  if (!pr || !safeProviderString(pr.mergeable, 32) || !safeProviderString(pr.mergeStateStatus, 64)) {
    return { failure: result(target, stage, 'PR_LOOKUP_FAILED', {
      repository: repo,
      diagnostic: diagnostic('PR_VIEW_MALFORMED', 'The pull request view returned invalid fields.'),
    }) };
  }
  if (pr.number !== prNumber || pr.headRepositoryOwner !== repo.owner || pr.headRefName !== target.storyBranch
    || pr.baseRefName !== target.integrationBranch) return { failure: result(target, stage, 'PR_LOOKUP_FAILED', {
    repository: repo,
    diagnostic: diagnostic('PR_IDENTITY_MISMATCH', 'The pull request view does not match the selected repository, head and base.'),
  }) };
  if (pr.headRefOid !== target.expectedHead) return { failure: result(target, stage, 'HEAD_MISMATCH', {
    repository: repo,
    pr: publicPr(pr),
    diagnostic: diagnostic('PR_HEAD_MISMATCH', 'The pull request head differs from expectedHead.'),
  }) };
  if (pr.state === 'MERGED') return allowMerged
    ? { pr }
    : { failure: result(target, stage, 'PR_MERGED', { repository: repo, pr: publicPr(pr) }) };
  if (pr.state !== 'OPEN') return { failure: result(target, stage, 'PR_CLOSED', { repository: repo, pr: publicPr(pr) }) };
  return { pr };
}

function unsettledMergeState(pr) {
  return pr.mergeable !== 'MERGEABLE' || pr.mergeStateStatus !== 'CLEAN';
}

function checks(target, repo, pr, run, timeoutMs) {
  if (pr.isDraft) return result(target, 'checks', 'PR_DRAFT', { repository: repo, pr: publicPr(pr) });
  const invocation = command(run, timeoutMs, 'gh', ['pr', 'checks', String(pr.number), '--repo', repo.slug,
    '--required', '--json', CHECK_FIELDS], target.root);
  const commandProblem = commandFailure(target, 'checks', 'gh', invocation, 'CHECKS_UNKNOWN', 'CHECKS_COMMAND_ERROR', 'Required checks could not be inspected.');
  if (commandProblem) return commandProblem;
  let normalizedChecks = [];
  let noRequiredChecks = false;
  if (invocation.stdout !== '') {
    const parsed = parseJson(invocation);
    if (!Array.isArray(parsed) || parsed.length > MAX_PROVIDER_ITEMS || parsed.some((item) => !record(item)
      || !['name', 'state', 'bucket', 'workflow'].every((key) => safeProviderString(item[key], 1000)))) {
      return result(target, 'checks', 'CHECKS_UNKNOWN', {
        repository: repo, pr: publicPr(pr), diagnostic: diagnostic('CHECKS_MALFORMED', 'Required checks returned invalid JSON.'),
      });
    }
    normalizedChecks = parsed.map((item) => ({
      name: item.name, state: item.state, bucket: item.bucket.toLowerCase(), workflow: item.workflow,
    }));
    if (invocation.exitCode !== 0) return result(target, 'checks', 'CHECKS_UNKNOWN', {
      repository: repo, pr: publicPr(pr), checks: normalizedChecks,
      diagnostic: diagnostic('CHECKS_EXIT_MISMATCH', 'Required checks returned JSON with a nonzero status.'),
    });
    if (normalizedChecks.some((item) => ['fail', 'cancel'].includes(item.bucket))) {
      return result(target, 'checks', 'CHECKS_FAILED', { repository: repo, pr: publicPr(pr), checks: normalizedChecks });
    }
    if (normalizedChecks.some((item) => item.bucket === 'pending')) {
      return result(target, 'checks', 'CHECKS_PENDING', { repository: repo, pr: publicPr(pr), checks: normalizedChecks });
    }
    if (normalizedChecks.some((item) => !['pass', 'skipping'].includes(item.bucket))) {
      return result(target, 'checks', 'CHECKS_UNKNOWN', {
        repository: repo, pr: publicPr(pr), checks: normalizedChecks,
        diagnostic: diagnostic('CHECKS_UNKNOWN_BUCKET', 'A required check has an unknown result bucket.'),
      });
    }
  } else if (invocation.exitCode === 0) {
    return result(target, 'checks', 'CHECKS_UNKNOWN', {
      repository: repo, pr: publicPr(pr),
      diagnostic: diagnostic('CHECKS_MALFORMED', 'Required checks returned no JSON.'),
    });
  } else {
    const stderr = trimOneLineEnding(invocation.stderr);
    if (invocation.exitCode !== 1 || invocation.stdout !== '' || !NO_CHECKS(target.storyBranch).has(stderr)) {
      return result(target, 'checks', 'CHECKS_UNKNOWN', {
        repository: repo, pr: publicPr(pr), diagnostic: diagnostic('CHECKS_LOOKUP_FAILED', 'Required checks could not be established.'),
      });
    }
    noRequiredChecks = true;
  }

  const fresh = view(target, repo, pr.number, run, timeoutMs);
  if (fresh.failure) return fresh.failure;
  if (fresh.pr.isDraft) return result(target, 'checks', 'PR_DRAFT', { repository: repo, pr: publicPr(fresh.pr) });
  if (unsettledMergeState(fresh.pr)) return result(target, 'checks', 'CHECKS_UNKNOWN', {
    repository: repo,
    pr: publicPr(fresh.pr),
    checks: normalizedChecks,
    diagnostic: diagnostic(noRequiredChecks ? 'NO_CHECKS_NOT_CLEAN' : 'MERGE_STATE_NOT_CLEAN',
      'The pull request is not in a clean mergeable state.'),
  });
  return result(target, 'checks', 'READY', {
    repository: repo,
    pr: publicPr(fresh.pr),
    checks: normalizedChecks,
    ...(noRequiredChecks ? { diagnostic: diagnostic('NO_REQUIRED_CHECKS_PROVEN', 'No required checks are configured and the pull request is clean.') } : {}),
  });
}

function withBodyFile(body, callback) {
  const temporaryBase = fs.realpathSync.native(path.resolve(os.tmpdir()));
  if (!path.isAbsolute(temporaryBase) || !fs.statSync(temporaryBase).isDirectory()) {
    throw new Error('Temporary file base must be an absolute directory');
  }
  const directory = fs.mkdtempSync(path.join(temporaryBase, 'deliver-remote-'));
  try {
    fs.chmodSync(directory, 0o700);
    const file = path.join(directory, 'body.md');
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, body, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return callback(file);
  }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function publishOptions(options) {
  if (!record(options)) invalid('publish options must be an object');
  const unknown = Object.keys(options).filter((key) => !['title', 'body', 'createDraft', 'markReady'].includes(key));
  if (unknown.length) invalid(`unsupported publish fields: ${unknown.join(', ')}`);
  if (typeof options.createDraft !== 'boolean'
    || (options.markReady !== undefined && typeof options.markReady !== 'boolean')) invalid('publish draft options must be booleans');
  return {
    title: boundedLine(options.title, 'title'),
    body: boundedBody(options.body, 'body'),
    createDraft: options.createDraft,
    markReady: options.markReady ?? false,
  };
}

function mergeOptions(options) {
  if (!record(options)) invalid('merge options must be an object');
  const unknown = Object.keys(options).filter((key) => !['prNumber', 'method', 'subject', 'body'].includes(key));
  if (unknown.length) invalid(`unsupported merge fields: ${unknown.join(', ')}`);
  if (!Number.isSafeInteger(options.prNumber) || options.prNumber <= 0) invalid('prNumber must be a positive safe integer');
  if (!['merge', 'squash', 'rebase'].includes(options.method)) invalid('method must be merge, squash or rebase');
  return {
    prNumber: options.prNumber,
    method: options.method,
    subject: boundedLine(options.subject, 'subject'),
    body: boundedBody(options.body, 'body'),
  };
}

export function createGitHubRemoteAdapter({ run = runCommand, timeoutMs = 30_000 } = {}) {
  if (typeof run !== 'function') invalid('run must be a command runner');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) invalid('timeoutMs is out of bounds');

  return Object.freeze({
    inspect(targetInput) {
      const prepared = preflight(targetInput, run, timeoutMs);
      if (prepared.failure) return prepared.failure;
      const found = lookup(prepared.target, prepared.repo, run, timeoutMs);
      if (found.failure) return found.failure;
      const viewed = view(prepared.target, prepared.repo, found.pr.number, run, timeoutMs);
      if (viewed.failure) return viewed.failure;
      return checks(prepared.target, prepared.repo, viewed.pr, run, timeoutMs);
    },

    publish(targetInput, optionsInput) {
      const options = publishOptions(optionsInput);
      const prepared = preflight(targetInput, run, timeoutMs);
      if (prepared.failure) return prepared.failure;
      const initial = lookup(prepared.target, prepared.repo, run, timeoutMs, { allowStaleHead: true });
      let existing = null;
      if (initial.failure?.state !== 'PR_ABSENT') {
        if (initial.failure) return initial.failure;
        existing = initial.pr;
      }

      const pushed = command(run, timeoutMs, 'git', ['push', '--porcelain', prepared.target.remote,
        `${prepared.target.expectedHead}:refs/heads/${prepared.target.storyBranch}`], prepared.target.root);
      const pushProblem = commandFailure(prepared.target, 'publish', 'git', pushed, 'PUSH_REJECTED', 'PUSH_COMMAND_ERROR', 'The exact branch push could not be completed.');
      if (pushProblem) return pushProblem;
      if (pushed.exitCode !== 0) return result(prepared.target, 'publish', 'PUSH_REJECTED', {
        repository: prepared.repo,
        diagnostic: diagnostic('PUSH_REJECTED', 'The remote rejected the exact branch update.'),
      });

      const writeArgs = existing
        ? ['pr', 'edit', String(existing.number), '--repo', prepared.repo.slug, '--title', options.title]
        : ['pr', 'create', '--repo', prepared.repo.slug, '--head', prepared.target.storyBranch,
          '--base', prepared.target.integrationBranch, '--title', options.title];
      let written;
      try {
        written = withBodyFile(options.body, (bodyFile) => command(run, timeoutMs, 'gh', [
          ...writeArgs, '--body-file', bodyFile, ...(!existing && options.createDraft ? ['--draft'] : []),
        ], prepared.target.root));
      } catch {
        return result(prepared.target, 'publish', 'PR_WRITE_FAILED', {
          repository: prepared.repo,
          diagnostic: diagnostic('PR_BODY_WRITE_FAILED', 'The bounded pull request body could not be prepared.'),
        });
      }
      const writeProblem = commandFailure(prepared.target, 'publish', 'gh', written, 'PR_WRITE_FAILED', 'PR_WRITE_ERROR', 'The pull request could not be created or updated.');
      if (writeProblem) return writeProblem;
      if (written.exitCode !== 0) return result(prepared.target, 'publish', 'PR_WRITE_FAILED', {
        repository: prepared.repo,
        diagnostic: diagnostic('PR_WRITE_FAILED', 'The pull request could not be created or updated.'),
      });

      let found = lookup(prepared.target, prepared.repo, run, timeoutMs);
      if (found.failure) return found.failure.state === 'PR_ABSENT'
        ? result(prepared.target, 'lookup', 'PR_LOOKUP_FAILED', {
          repository: prepared.repo,
          diagnostic: diagnostic('PR_NOT_VISIBLE_AFTER_WRITE', 'The pull request was not visible after publication.'),
        }) : found.failure;
      if (options.markReady && found.pr.isDraft) {
        const readied = command(run, timeoutMs, 'gh', ['pr', 'ready', String(found.pr.number), '--repo', prepared.repo.slug], prepared.target.root);
        const readyProblem = commandFailure(prepared.target, 'publish', 'gh', readied, 'PR_READY_FAILED', 'PR_READY_ERROR', 'The draft pull request could not be marked ready.');
        if (readyProblem) return readyProblem;
        if (readied.exitCode !== 0) return result(prepared.target, 'publish', 'PR_READY_FAILED', {
          repository: prepared.repo,
          pr: publicPr(found.pr),
          diagnostic: diagnostic('PR_READY_FAILED', 'The draft pull request could not be marked ready.'),
        });
        found = lookup(prepared.target, prepared.repo, run, timeoutMs);
        if (found.failure) return found.failure;
      }
      const viewed = view(prepared.target, prepared.repo, found.pr.number, run, timeoutMs);
      if (viewed.failure) return viewed.failure;
      if (options.markReady && viewed.pr.isDraft) return result(prepared.target, 'publish', 'PR_READY_FAILED', {
        repository: prepared.repo,
        pr: publicPr(viewed.pr),
        diagnostic: diagnostic('PR_STILL_DRAFT', 'The pull request remains draft after the ready request.'),
      });
      return result(prepared.target, 'publish', 'PUBLISHED', {
        repository: prepared.repo,
        pr: publicPr(viewed.pr),
      });
    },

    merge(targetInput, optionsInput) {
      const options = mergeOptions(optionsInput);
      const prepared = preflight(targetInput, run, timeoutMs);
      if (prepared.failure) return prepared.failure;
      const found = lookup(prepared.target, prepared.repo, run, timeoutMs);
      if (found.failure) return found.failure;
      if (found.pr.number !== options.prNumber) return result(prepared.target, 'lookup', 'PR_LOOKUP_FAILED', {
        repository: prepared.repo,
        pr: publicPr(found.pr),
        diagnostic: diagnostic('PR_NUMBER_MISMATCH', 'The supplied pull request number does not match the exact head and base.'),
      });
      const viewed = view(prepared.target, prepared.repo, options.prNumber, run, timeoutMs);
      if (viewed.failure) return viewed.failure;
      const readiness = checks(prepared.target, prepared.repo, viewed.pr, run, timeoutMs);
      if (readiness.state !== 'READY') return readiness;
      const beforeMerge = view(prepared.target, prepared.repo, options.prNumber, run, timeoutMs);
      if (beforeMerge.failure) return beforeMerge.failure;
      if (beforeMerge.pr.isDraft) return result(prepared.target, 'merge', 'PR_DRAFT', {
        repository: prepared.repo, pr: publicPr(beforeMerge.pr),
      });
      if (unsettledMergeState(beforeMerge.pr)) return result(prepared.target, 'merge', 'CHECKS_UNKNOWN', {
        repository: prepared.repo,
        pr: publicPr(beforeMerge.pr),
        diagnostic: diagnostic('PREMERGE_STATE_NOT_CLEAN', 'The pull request is no longer clean and mergeable.'),
      });

      let merged;
      try {
        merged = withBodyFile(options.body, (bodyFile) => command(run, timeoutMs, 'gh', [
          'pr', 'merge', String(options.prNumber), '--repo', prepared.repo.slug,
          '--match-head-commit', prepared.target.expectedHead, `--${options.method}`,
          '--subject', options.subject, '--body-file', bodyFile,
        ], prepared.target.root));
      } catch {
        return result(prepared.target, 'merge', 'MERGE_REJECTED', {
          repository: prepared.repo,
          diagnostic: diagnostic('MERGE_BODY_WRITE_FAILED', 'The bounded merge body could not be prepared.'),
        });
      }
      const mergeProblem = commandFailure(prepared.target, 'merge', 'gh', merged, 'MERGE_REJECTED', 'MERGE_COMMAND_ERROR', 'The pull request merge was rejected.');
      if (mergeProblem) return mergeProblem;
      if (merged.exitCode !== 0) return result(prepared.target, 'merge', 'MERGE_REJECTED', {
        repository: prepared.repo,
        diagnostic: diagnostic('MERGE_REJECTED', 'The pull request merge was rejected.'),
      });

      const after = view(prepared.target, prepared.repo, options.prNumber, run, timeoutMs, {
        allowMerged: true,
        stage: 'postmerge',
      });
      if (after.failure) {
        if (after.failure.state === 'HEAD_MISMATCH' || after.failure.state === 'PR_CLOSED') {
          return result(prepared.target, 'postmerge', 'MERGE_MISMATCH', {
            repository: prepared.repo,
            diagnostic: diagnostic('POSTMERGE_IDENTITY_MISMATCH', 'The post-merge pull request identity changed.'),
          });
        }
        return after.failure;
      }
      if (after.pr.state === 'OPEN') return result(prepared.target, 'postmerge', 'MERGE_PENDING', {
        repository: prepared.repo, pr: publicPr(after.pr),
        diagnostic: diagnostic('MERGE_NOT_FINAL', 'The provider accepted the merge request but has not merged the pull request.'),
      });
      const mergeOid = after.pr.mergeCommit?.oid;
      if (after.pr.state !== 'MERGED' || typeof mergeOid !== 'string' || !OID.test(mergeOid)) {
        return result(prepared.target, 'postmerge', 'MERGE_MISMATCH', {
          repository: prepared.repo, pr: publicPr(after.pr),
          diagnostic: diagnostic('MERGE_COMMIT_MISSING', 'The provider did not return a full merged commit object ID.'),
        });
      }
      const remoteBase = command(run, timeoutMs, 'git', ['ls-remote', '--refs', prepared.target.remote,
        `refs/heads/${prepared.target.integrationBranch}`], prepared.target.root);
      const baseProblem = commandFailure(prepared.target, 'postmerge', 'git', remoteBase, 'GIT_ERROR', 'REMOTE_BASE_ERROR', 'Git could not verify the remote integration branch.');
      if (baseProblem) return baseProblem;
      if (remoteBase.exitCode !== 0) return result(prepared.target, 'postmerge', 'GIT_ERROR', {
        repository: prepared.repo,
        diagnostic: diagnostic('REMOTE_BASE_FAILED', 'Git could not verify the remote integration branch.'),
      });
      const lines = trimOneLineEnding(remoteBase.stdout).split('\n').filter(Boolean);
      const match = lines.length === 1 ? /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\t(refs\/heads\/.+)$/.exec(lines[0]) : null;
      if (!match || match[2] !== `refs/heads/${prepared.target.integrationBranch}` || match[1] !== mergeOid) {
        return result(prepared.target, 'postmerge', 'MERGE_MISMATCH', {
          repository: prepared.repo,
          mergeCommit: mergeOid,
          diagnostic: diagnostic('REMOTE_BASE_MISMATCH', 'The remote integration branch does not exactly match the merged commit.'),
        });
      }
      return result(prepared.target, 'postmerge', 'MERGED', {
        repository: prepared.repo,
        pr: publicPr(after.pr),
        mergeCommit: mergeOid,
        remoteBase: match[1],
      });
    },
  });
}
