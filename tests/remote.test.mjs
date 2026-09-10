import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { DeliverError } from '../plugins/deliver/skills/deliver/scripts/lib/state.mjs';
import {
  GITHUB_REMOTE_STAGES,
  GITHUB_REMOTE_STATES,
  createGitHubRemoteAdapter,
} from '../plugins/deliver/skills/deliver/scripts/lib/remote.mjs';

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);

function response(exitCode = 0, stdout = '', stderr = '', errorCode) {
  return { exitCode, stdout, stderr, ...(errorCode ? { errorCode } : {}) };
}

function pr(state, extra = {}) {
  return {
    number: 17,
    state: state.merged ? 'MERGED' : state.closed ? 'CLOSED' : 'OPEN',
    isDraft: state.draft,
    headRefName: 'pm/S1-1-value',
    headRefOid: state.pushed ? HEAD : state.initialHead,
    baseRefName: 'main',
    headRepositoryOwner: { login: 'Example' },
    url: 'https://github.example.test/Example/Project/pull/17',
    mergeCommit: state.merged ? { oid: state.mergeOid } : null,
    ...extra,
  };
}

function fixture(t, { exists = true, initialHead = HEAD, draft = false, onRun } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-remote-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'marker.txt'), 'unchanged\n');
  const state = {
    exists,
    initialHead,
    draft,
    closed: false,
    pushed: false,
    merged: false,
    mergeOid: MERGE,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    checks: [],
    checksExitCode: 0,
  };
  const calls = [];
  const bodies = [];

  const defaults = (request) => {
    const { file, args } = request;
    if (file === 'git' && args[0] === 'remote' && args.length === 1) return response(0, 'origin\n');
    if (file === 'git' && args[0] === 'remote') return response(0, 'git@github.example.test:Example/Project.git\n');
    if (file === 'git' && args[0] === 'symbolic-ref') return response(0, 'pm/S1-1-value\n');
    if (file === 'git' && args[0] === 'rev-parse') return response(0, `${HEAD}\n`);
    if (file === 'git' && args[0] === 'push') {
      state.pushed = true;
      return response(0, 'ok\n');
    }
    if (file === 'git' && args[0] === 'ls-remote') return response(0, `${state.mergeOid}\trefs/heads/main\n`);
    if (file === 'gh' && args[0] === 'auth') return response();
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'list') {
      return response(0, JSON.stringify(state.exists ? [pr(state)] : []));
    }
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      return response(0, JSON.stringify(pr(state, {
        mergeable: state.mergeable,
        mergeStateStatus: state.mergeStateStatus,
      })));
    }
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'checks') {
      return response(state.checksExitCode, JSON.stringify(state.checks), state.checksExitCode ? 'status' : '');
    }
    if (file === 'gh' && args[0] === 'pr' && ['create', 'edit'].includes(args[1])) {
      const bodyPath = args[args.indexOf('--body-file') + 1];
      bodies.push({
        path: bodyPath,
        content: fs.readFileSync(bodyPath, 'utf8'),
        mode: fs.statSync(bodyPath).mode & 0o777,
        directoryMode: fs.statSync(path.dirname(bodyPath)).mode & 0o777,
      });
      state.exists = true;
      if (args[1] === 'create') state.draft = args.includes('--draft');
      return response(0, 'written\n');
    }
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'ready') {
      state.draft = false;
      return response();
    }
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'merge') {
      const bodyPath = args[args.indexOf('--body-file') + 1];
      bodies.push({
        path: bodyPath,
        content: fs.readFileSync(bodyPath, 'utf8'),
        mode: fs.statSync(bodyPath).mode & 0o777,
        directoryMode: fs.statSync(path.dirname(bodyPath)).mode & 0o777,
      });
      state.merged = true;
      return response();
    }
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
  };
  const run = (request) => {
    assert.equal(request.cwd, root);
    assert.equal(request.timeoutMs, 30_000);
    calls.push(structuredClone(request));
    const override = onRun?.(request, state, calls);
    return override === undefined ? defaults(request) : override;
  };
  return {
    root,
    target: {
      root,
      remote: 'origin',
      storyBranch: 'pm/S1-1-value',
      integrationBranch: 'main',
      expectedHead: HEAD,
    },
    adapter: createGitHubRemoteAdapter({ run }),
    state,
    calls,
    bodies,
  };
}

function assertNoUnsafeArgs(calls) {
  const forbidden = new Set(['--force', '-f', '-u', '--set-upstream', '--admin', '--auto', '--delete-branch', '--no-verify', 'config']);
  for (const call of calls) {
    assert(['git', 'gh'].includes(call.file));
    assert(!call.args.some((arg) => forbidden.has(arg)), `unsafe argv: ${call.args.join(' ')}`);
  }
}

function withRelativeTmpdirAndRestrictiveUmask(callback) {
  const originalCwd = process.cwd();
  const originalUmask = process.umask();
  const hadTmpdir = Object.hasOwn(process.env, 'TMPDIR');
  const originalTmpdir = process.env.TMPDIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-remote-environment-'));
  const coordinatorRoot = path.join(sandbox, 'coordinator');
  const temporaryBase = path.join(sandbox, 'relative-tmp');
  fs.mkdirSync(coordinatorRoot);
  fs.mkdirSync(temporaryBase);
  const resolvedBase = fs.realpathSync.native(temporaryBase);

  try {
    process.chdir(coordinatorRoot);
    process.env.TMPDIR = '../relative-tmp';
    process.umask(0o777);
    return callback(resolvedBase);
  } finally {
    process.umask(originalUmask);
    if (hadTmpdir) process.env.TMPDIR = originalTmpdir;
    else delete process.env.TMPDIR;
    process.chdir(originalCwd);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

function assertProtectedBody(body, temporaryBase, call) {
  assert(path.isAbsolute(body.path));
  assert.equal(path.dirname(path.dirname(body.path)), temporaryBase);
  assert.equal(body.mode, 0o600);
  assert.equal(body.directoryMode, 0o700);
  assert.equal(call.args[call.args.indexOf('--body-file') + 1], body.path);
  assert.equal(fs.existsSync(body.path), false);
  assert.equal(fs.existsSync(path.dirname(body.path)), false);
}

test('exports a closed protocol and rejects invalid caller input with shared DeliverError', (t) => {
  assert.deepEqual(GITHUB_REMOTE_STAGES, ['preflight', 'lookup', 'publish', 'checks', 'merge', 'postmerge']);
  for (const state of ['UNAVAILABLE', 'REMOTE_AMBIGUOUS', 'PR_LOOKUP_FAILED', 'PUBLISHED', 'READY', 'MERGED']) {
    assert(GITHUB_REMOTE_STATES.includes(state));
  }
  const f = fixture(t);
  assert.throws(() => f.adapter.inspect({ ...f.target, expectedHead: 'short' }), (error) => error instanceof DeliverError && error.code === 64);
  assert.throws(() => f.adapter.publish(f.target, { title: 'x\ny', body: '', createDraft: false }), DeliverError);
  assert.throws(() => f.adapter.merge(f.target, { prNumber: 17, method: 'admin', subject: 'x', body: '' }), DeliverError);
});

test('preflight keeps unavailable, Git, missing or ambiguous remote, authentication and head failures distinct', (t) => {
  const unavailable = fixture(t, {
    onRun(request) {
      if (request.file === 'git' && request.args[0] === 'remote') return response(null, '', '', 'ENOENT');
    },
  });
  assert.equal(unavailable.adapter.inspect(unavailable.target).state, 'UNAVAILABLE');

  const missing = fixture(t, {
    onRun(request) {
      if (request.file === 'git' && request.args[0] === 'remote' && request.args.length > 1) return response(2, '', 'not found');
      if (request.file === 'git' && request.args[0] === 'remote') return response(0, 'upstream\n');
    },
  });
  assert.equal(missing.adapter.inspect(missing.target).state, 'REMOTE_MISSING');

  const ambiguous = fixture(t, {
    onRun(request) {
      if (request.file === 'git' && request.args[0] === 'remote') {
        return response(0, 'git@github.example.test:Example/Project.git\nhttps://github.example.test/Example/Project.git\n');
      }
    },
  });
  assert.equal(ambiguous.adapter.inspect(ambiguous.target).state, 'REMOTE_AMBIGUOUS');

  const credentialed = fixture(t, {
    onRun(request) {
      if (request.file === 'git' && request.args[0] === 'remote') {
        return response(0, 'https://user:secret@github.example.test/Example/Project.git\n');
      }
    },
  });
  assert.equal(credentialed.adapter.inspect(credentialed.target).state, 'UNSUPPORTED_REMOTE');

  const auth = fixture(t, {
    onRun(request) {
      if (request.file === 'gh' && request.args[0] === 'auth') return response(1, '', 'token: should never escape');
    },
  });
  const authResult = auth.adapter.publish(auth.target, { title: 'Title', body: 'Body', createDraft: false });
  assert.equal(authResult.state, 'AUTH_REQUIRED');
  assert(!JSON.stringify(authResult).includes('should never escape'));
  assert(!auth.calls.some((call) => call.args[0] === 'push'));

  const mismatch = fixture(t, {
    onRun(request) {
      if (request.file === 'git' && request.args[0] === 'rev-parse') return response(0, `${OLD_HEAD}\n`);
    },
  });
  assert.equal(mismatch.adapter.inspect(mismatch.target).state, 'HEAD_MISMATCH');

  const oversized = fixture(t, {
    onRun(request) {
      if (request.file === 'git' && request.args[0] === 'remote') return response(0, 'x'.repeat(2 * 1024 * 1024 + 1));
    },
  });
  const oversizedResult = oversized.adapter.inspect(oversized.target);
  assert.equal(oversizedResult.state, 'GIT_ERROR');
  assert.equal(oversizedResult.diagnostic.code, 'COMMAND_OUTPUT_LIMIT');
});

test('inspect distinguishes absent, failed, incomplete and ambiguous lookup', (t) => {
  const absent = fixture(t, { exists: false });
  assert.equal(absent.adapter.inspect(absent.target).state, 'PR_ABSENT');

  const failed = fixture(t, {
    onRun(request) {
      if (request.file === 'gh' && request.args[1] === 'list') return response(1, '', 'provider failed');
    },
  });
  assert.equal(failed.adapter.inspect(failed.target).state, 'PR_LOOKUP_FAILED');

  const incomplete = fixture(t, {
    onRun(request, state) {
      if (request.file === 'gh' && request.args[1] === 'list') {
        return response(0, JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ ...pr(state), number: index + 1 }))));
      }
    },
  });
  assert.equal(incomplete.adapter.inspect(incomplete.target).state, 'PR_LOOKUP_INCOMPLETE');

  const ambiguous = fixture(t, {
    onRun(request, state) {
      if (request.file === 'gh' && request.args[1] === 'list') {
        return response(0, JSON.stringify([pr(state), { ...pr(state), number: 18 }]));
      }
    },
  });
  assert.equal(ambiguous.adapter.inspect(ambiguous.target).state, 'PR_AMBIGUOUS');
});

test('inspect accepts passing and skipping checks and keeps pending, failed and unknown distinct', (t) => {
  const ready = fixture(t);
  ready.state.checks = [
    { name: 'test', state: 'SUCCESS', bucket: 'pass', workflow: 'ci' },
    { name: 'optional', state: 'SKIPPED', bucket: 'skipping', workflow: 'ci' },
  ];
  const readyResult = ready.adapter.inspect(ready.target);
  assert.equal(readyResult.state, 'READY');
  assert.equal(readyResult.checks.length, 2);
  assert.deepEqual(ready.calls.find((call) => call.file === 'gh' && call.args[1] === 'list').args, [
    'pr', 'list', '--repo', 'github.example.test/example/project', '--state', 'all',
    '--head', 'pm/S1-1-value', '--base', 'main', '--limit', '100', '--json',
    'number,state,isDraft,headRefName,headRefOid,baseRefName,headRepositoryOwner,url,mergeCommit',
  ]);

  for (const [bucket, expected] of [
    ['pending', 'CHECKS_PENDING'],
    ['fail', 'CHECKS_FAILED'],
    ['cancel', 'CHECKS_FAILED'],
    ['mystery', 'CHECKS_UNKNOWN'],
  ]) {
    const f = fixture(t);
    f.state.checks = [{ name: 'test', state: 'STATE', bucket, workflow: 'ci' }];
    assert.equal(f.adapter.inspect(f.target).state, expected, bucket);
  }

  for (const [bucket, exitCode] of [['pass', 1], ['pending', 8], ['fail', 1]]) {
    const f = fixture(t);
    f.state.checks = [{ name: 'test', state: 'STATE', bucket, workflow: 'ci' }];
    f.state.checksExitCode = exitCode;
    const result = f.adapter.inspect(f.target);
    assert.equal(result.state, 'CHECKS_UNKNOWN', `${bucket} JSON with exit ${exitCode}`);
    assert.equal(result.diagnostic.code, 'CHECKS_EXIT_MISMATCH');
  }

  const malformed = fixture(t, {
    onRun(request) {
      if (request.file === 'gh' && request.args[1] === 'checks') return response(0, '{}');
    },
  });
  assert.equal(malformed.adapter.inspect(malformed.target).state, 'CHECKS_UNKNOWN');
});

test('the exact no-required-checks messages need a fresh clean mergeable view', (t) => {
  for (const message of [
    `no checks reported on the 'pm/S1-1-value' branch`,
    `no required checks reported on the 'pm/S1-1-value' branch`,
  ]) {
    const clean = fixture(t, {
      onRun(request) {
        if (request.file === 'gh' && request.args[1] === 'checks') return response(1, '', `${message}\r\n`);
      },
    });
    const result = clean.adapter.inspect(clean.target);
    assert.equal(result.state, 'READY');
    assert.equal(result.diagnostic.code, 'NO_REQUIRED_CHECKS_PROVEN');
  }

  const blocked = fixture(t, {
    onRun(request, state) {
      if (request.file === 'gh' && request.args[1] === 'checks') {
        state.mergeStateStatus = 'BLOCKED';
        return response(1, '', `no required checks reported on the 'pm/S1-1-value' branch\n`);
      }
    },
  });
  assert.equal(blocked.adapter.inspect(blocked.target).state, 'CHECKS_UNKNOWN');

  const arbitrary = fixture(t, {
    onRun(request) {
      if (request.file === 'gh' && request.args[1] === 'checks') return response(1, '', 'no checks today\n');
    },
  });
  assert.equal(arbitrary.adapter.inspect(arbitrary.target).state, 'CHECKS_UNKNOWN');

  const wrongExit = fixture(t, {
    onRun(request) {
      if (request.file === 'gh' && request.args[1] === 'checks') {
        return response(2, '', `no checks reported on the 'pm/S1-1-value' branch\n`);
      }
    },
  });
  assert.equal(wrongExit.adapter.inspect(wrongExit.target).state, 'CHECKS_UNKNOWN');
});

test('publish updates an eligible older PR with an exact nontracking push and exact temporary body', (t) => {
  const f = fixture(t, { initialHead: OLD_HEAD, draft: true });
  const body = 'Literal body with `code`, $HOME, $(touch nope), and newlines.\n\nSecond line.\n';
  const result = f.adapter.publish(f.target, {
    title: 'Update $HOME literally',
    body,
    createDraft: false,
    markReady: true,
  });
  assert.equal(result.state, 'PUBLISHED');
  assert.equal(result.pr.headRefOid, HEAD);
  assert.equal(result.pr.isDraft, false);
  const push = f.calls.find((call) => call.file === 'git' && call.args[0] === 'push');
  assert.deepEqual(push.args, ['push', '--porcelain', 'origin', `${HEAD}:refs/heads/pm/S1-1-value`]);
  const edit = f.calls.find((call) => call.file === 'gh' && call.args[1] === 'edit');
  assert(edit.args.includes('Update $HOME literally'));
  assert(!edit.args.some((arg) => arg.includes('Example:pm/')));
  assert.equal(f.bodies.length, 1);
  assert.deepEqual(f.bodies[0], {
    ...f.bodies[0],
    content: body,
    mode: 0o600,
    directoryMode: 0o700,
  });
  assert.equal(fs.existsSync(f.bodies[0].path), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'marker.txt'), 'utf8'), 'unchanged\n');
  assertNoUnsafeArgs(f.calls);
});

test('publish creates an explicit draft and cleans its body file after provider failure or throw', (t) => {
  const created = fixture(t, { exists: false });
  const published = created.adapter.publish(created.target, {
    title: 'New PR', body: 'new body', createDraft: true,
  });
  assert.equal(published.state, 'PUBLISHED');
  assert.equal(published.pr.isDraft, true);
  assert(created.calls.find((call) => call.file === 'gh' && call.args[1] === 'create').args.includes('--draft'));
  assert.equal(fs.existsSync(created.bodies[0].path), false);

  for (const thrown of [false, true]) {
    let bodyPath;
    const failed = fixture(t, {
      onRun(request) {
        if (request.file === 'gh' && request.args[1] === 'edit') {
          bodyPath = request.args[request.args.indexOf('--body-file') + 1];
          assert.equal(fs.readFileSync(bodyPath, 'utf8'), 'failure body');
          if (thrown) throw Object.assign(new Error('boom'), { code: 'EIO' });
          return response(1, '', 'secret provider output');
        }
      },
    });
    const result = failed.adapter.publish(failed.target, {
      title: 'Failure', body: 'failure body', createDraft: false,
    });
    assert.equal(result.state, 'PR_WRITE_FAILED');
    assert.equal(fs.existsSync(bodyPath), false);
    assert(!JSON.stringify(result).includes('secret provider output'));
  }
});

test('publish uses an absolute mode0600 body and cleans it under a relative TMPDIR and restrictive umask', (t) => {
  const published = fixture(t);
  let rejectedBody;
  const rejected = fixture(t, {
    onRun(request) {
      if (request.file === 'gh' && request.args[1] === 'edit') {
        const bodyPath = request.args[request.args.indexOf('--body-file') + 1];
        rejectedBody = {
          path: bodyPath,
          content: fs.readFileSync(bodyPath, 'utf8'),
          mode: fs.statSync(bodyPath).mode & 0o777,
          directoryMode: fs.statSync(path.dirname(bodyPath)).mode & 0o777,
        };
        return response(1, '', 'provider rejected edit');
      }
    },
  });

  withRelativeTmpdirAndRestrictiveUmask((temporaryBase) => {
    const success = published.adapter.publish(published.target, {
      title: 'Published', body: 'published body', createDraft: false,
    });
    assert.equal(success.state, 'PUBLISHED');
    const edit = published.calls.find((call) => call.file === 'gh' && call.args[1] === 'edit');
    assertProtectedBody(published.bodies[0], temporaryBase, edit);

    const failure = rejected.adapter.publish(rejected.target, {
      title: 'Rejected', body: 'rejected body', createDraft: false,
    });
    assert.equal(failure.state, 'PR_WRITE_FAILED');
    assert.equal(rejectedBody.content, 'rejected body');
    const rejectedEdit = rejected.calls.find((call) => call.file === 'gh' && call.args[1] === 'edit');
    assertProtectedBody(rejectedBody, temporaryBase, rejectedEdit);
  });
});

test('merge uses required checks, match-head-commit and proves the exact remote base', (t) => {
  const f = fixture(t);
  f.state.checks = [{ name: 'test', state: 'SUCCESS', bucket: 'pass', workflow: 'ci' }];
  const body = 'Merge details\nwith literal $() text.\n';
  const result = f.adapter.merge(f.target, {
    prNumber: 17,
    method: 'merge',
    subject: 'Merge S1-1',
    body,
  });
  assert.equal(result.state, 'MERGED');
  assert.equal(result.mergeCommit, MERGE);
  assert.equal(result.remoteBase, MERGE);
  const merge = f.calls.find((call) => call.file === 'gh' && call.args[1] === 'merge');
  assert.deepEqual(merge.args.slice(0, 9), [
    'pr', 'merge', '17', '--repo', 'github.example.test/example/project',
    '--match-head-commit', HEAD, '--merge', '--subject',
  ]);
  assert.equal(merge.args[9], 'Merge S1-1');
  assert.equal(merge.args[10], '--body-file');
  assert.equal(f.bodies.at(-1).content, body);
  assert.equal(f.bodies.at(-1).mode, 0o600);
  assert.equal(fs.existsSync(f.bodies.at(-1).path), false);
  assert.deepEqual(f.calls.find((call) => call.file === 'git' && call.args[0] === 'ls-remote').args,
    ['ls-remote', '--refs', 'origin', 'refs/heads/main']);
  assertNoUnsafeArgs(f.calls);
});

test('merge uses an absolute mode0600 body and cleans it under a relative TMPDIR and restrictive umask', (t) => {
  const merged = fixture(t);
  merged.state.checks = [{ name: 'test', state: 'SUCCESS', bucket: 'pass', workflow: 'ci' }];
  let rejectedBody;
  const rejected = fixture(t, {
    onRun(request) {
      if (request.file === 'gh' && request.args[1] === 'merge') {
        const bodyPath = request.args[request.args.indexOf('--body-file') + 1];
        rejectedBody = {
          path: bodyPath,
          content: fs.readFileSync(bodyPath, 'utf8'),
          mode: fs.statSync(bodyPath).mode & 0o777,
          directoryMode: fs.statSync(path.dirname(bodyPath)).mode & 0o777,
        };
        return response(1, '', 'provider rejected merge');
      }
    },
  });
  rejected.state.checks = [{ name: 'test', state: 'SUCCESS', bucket: 'pass', workflow: 'ci' }];

  withRelativeTmpdirAndRestrictiveUmask((temporaryBase) => {
    const success = merged.adapter.merge(merged.target, {
      prNumber: 17, method: 'merge', subject: 'Merge success', body: 'merge success body',
    });
    assert.equal(success.state, 'MERGED');
    const merge = merged.calls.find((call) => call.file === 'gh' && call.args[1] === 'merge');
    assertProtectedBody(merged.bodies[0], temporaryBase, merge);

    const failure = rejected.adapter.merge(rejected.target, {
      prNumber: 17, method: 'merge', subject: 'Merge failure', body: 'merge failure body',
    });
    assert.equal(failure.state, 'MERGE_REJECTED');
    assert.equal(rejectedBody.content, 'merge failure body');
    const rejectedMerge = rejected.calls.find((call) => call.file === 'gh' && call.args[1] === 'merge');
    assertProtectedBody(rejectedBody, temporaryBase, rejectedMerge);
  });
});

test('merge never reports completion for refusal, queueing, changed head or remote-base mismatch', (t) => {
  const refused = fixture(t, {
    onRun(request) {
      if (request.file === 'gh' && request.args[1] === 'merge') return response(1, '', 'protected');
    },
  });
  assert.equal(refused.adapter.merge(refused.target, {
    prNumber: 17, method: 'merge', subject: 'Merge', body: '',
  }).state, 'MERGE_REJECTED');

  const queued = fixture(t, {
    onRun(request) {
      if (request.file === 'gh' && request.args[1] === 'merge') return response(0, 'queued\n');
    },
  });
  assert.equal(queued.adapter.merge(queued.target, {
    prNumber: 17, method: 'merge', subject: 'Merge', body: '',
  }).state, 'MERGE_PENDING');

  let viewCount = 0;
  const raced = fixture(t, {
    onRun(request, state) {
      if (request.file === 'gh' && request.args[1] === 'view') {
        viewCount += 1;
        return response(0, JSON.stringify(pr(state, {
          headRefOid: viewCount >= 3 ? OLD_HEAD : HEAD,
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
        })));
      }
    },
  });
  assert.equal(raced.adapter.merge(raced.target, {
    prNumber: 17, method: 'merge', subject: 'Merge', body: '',
  }).state, 'HEAD_MISMATCH');
  assert(!raced.calls.some((call) => call.file === 'gh' && call.args[1] === 'merge'));

  const mismatch = fixture(t, {
    onRun(request) {
      if (request.file === 'git' && request.args[0] === 'ls-remote') return response(0, `${OLD_HEAD}\trefs/heads/main\n`);
    },
  });
  assert.equal(mismatch.adapter.merge(mismatch.target, {
    prNumber: 17, method: 'merge', subject: 'Merge', body: '',
  }).state, 'MERGE_MISMATCH');
});
