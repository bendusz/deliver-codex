# T05R standalone provider port design

Independent architecture recommendation; implementation pending T04 PASS. T05L must not import
the port before it exists. T05B after both merges wires actual CLI/C-M-P-E-H reconciliation.

`createGitHubRemoteAdapter({run=runCommand, timeoutMs=30000})` exposes synchronous
`inspect(target)`, `publish(target,{title,body,createDraft,markReady:false})`,
`merge(target,{prNumber,method,subject,body})`. Target is root/remote/storyBranch/integrationBranch/
expectedHead, with a full lowercase 40/64 character OID. Method is explicit merge/squash/rebase;
T05B uses merge for exact upstream compatibility and explicitly reconciles alternative policies.
Injected runner receives file git|gh, args, cwd, input if needed, timeoutMs; returns exitCode,
stdout, stderr and optional errorCode. No shell. Expected provider conditions return data.

Every result carries stage/state, expectedHead and optional repository/pr/checks/mergeCommit/
remoteBase/diagnostic. Distinguish unavailable binary, unsupported/ambiguous remote, auth needed,
head mismatch, absent/ambiguous/incomplete/closed/draft PR, pending/failed/unknown checks, rejected
push, failed PR write, ready PR, blocked/pending/mismatched/successful merge. Never reinterpret
command failure, bad JSON, auth or ambiguous lookup as missing PR. Bound output/JSON and never
return raw auth output.

1. Validate names, get exactly one push URL using git remote get-url --push --all REMOTE, parse
   host/owner/repo, probe gh auth status --active --hostname HOST without --show-token. Require
   story checkout symbolic branch and HEAD exactly match supplied candidate.
2. gh pr list --repo HOST/OWNER/REPO --state all --head BRANCH --base BASE --limit 100 with explicit
   JSON fields number/state/isDraft/headRefName/headRefOid/baseRefName/headRepositoryOwner/url/
   mergeCommit. Filter exact owner/branch/base locally; owner:branch is unsupported for --head.
   Multiple or full-page lookup is ambiguous/incomplete. Check before and after publish.
3. Push exact EXPECTED:refs/heads/BRANCH using git push --porcelain; no force/-u/set-upstream/
   config/no-verify. Create/edit one PR with explicit repo/head/base/title/body file. New draft
   selection is explicit; existing draft remains draft unless markReady=true then gh pr ready.
4. Re-read exact PR number and head/base/repo/open/draft/mergeStateStatus. gh pr checks --required
   --json name,state,bucket,workflow; pass/skipping accepted, pending/fail/cancel/unknown distinct.
   Re-read after checks to catch head race. Exact no-required-checks behavior is being clarified;
   never collapse arbitrary error into no checks or permanently block a positively proven no-CI
   repository. Actual server branch protection still controls the normal merge call.
5. gh pr merge NUMBER --repo ... --match-head-commit EXPECTED --METHOD --subject ... --body-file
   FILE; no admin/auto/delete-branch. Post-read must show MERGED and full mergeCommit.oid; queue
   acceptance alone is MERGE_PENDING. git ls-remote --refs REMOTE refs/heads/BASE must return one
   matching OID; mismatch is not completed. T05B may subsequently prove ancestry/reconcile tip.

Developer command-handling rule: create a bounded mode0600 temporary body file after preflight,
pass its path to --body-file and clean up. Fake runner reads its exact bytes during invocation.
This preserves multiline bodies without shell expansion or escaping transformations.

T05R owns only scripts/lib/remote.mjs and tests/remote.test.mjs. No PM/state/transition imports.
Scripted fake runner asserts exact argv/body bytes, missing binaries/auth before push, multiple
URLs, malicious-looking names/body, lookup races/ambiguity/history, push/PR/draft/ready failures,
empty/pass/skipping/pending/fail/malformed checks, changed head, refused/queued merge and absent/
mismatched merge SHA/remote base. Assert no shell/admin/auto/force/tracking/config mutation and
no real network/service calls. Real native user-operation wiring is T05B, not this unit port.

## Accepted no-required-checks rule

Current official gh checks implementation returns exit1 before JSON export for the exact
messages `no checks reported on the '<head>' branch` and
`no required checks reported on the '<head>' branch`. Treat this as NO_REQUIRED_CHECKS only
with empty stdout, exact validated branch in that stderr (only CRLF normalization and one
trailing newline removed), and a fresh post-check PR view proving OPEN/non-draft/exact
repo/base/owner/head OID, mergeable MERGEABLE and mergeStateStatus CLEAN. Request both mergeable
and mergeStateStatus in view JSON. All other errors/outputs/UNKNOWN/BLOCKED/DRAFT/HAS_HOOKS
states stay non-ready. Valid exit0 JSON arrays are processed normally. Never infer no checks
from an empty statusCheckRollup or exit1 alone. Recheck exact head/CLEAN immediately before
merge; normal server protection still applies and actual postmerge proof is mandatory.

Official source evidence reviewed by architect: cli/cli pkg/cmd/pr/checks/checks.go emits these
errors after a successful GraphQL query; GitHub GraphQL defines CLEAN as mergeable with passing
commit status. Test both exact messages+CLEAN, either message+unsettled/blocked state, and
arbitrary stderr/malformed output separately.

Temporary-body details: fresh os.tmpdir directory mode0700; wx file mode0600; exact bounded UTF-8
body; absolute path passed to gh; finally cleanup on success, nonzero exit and runner throw.
Fake runner inspects bytes/mode during call and tests verify no worktree/.deliver body file.

## Provider result and publish details

Export a closed stage/state vocabulary beside the adapter factory. Omit a redundant ok boolean.
Stages are preflight/lookup/publish/checks/merge/postmerge. Preserve distinct PUBLISHED, READY and
MERGED outcomes, missing versus ambiguous remote, unavailable executable versus Git failure,
and PR lookup failure versus absence. Diagnostics use fixed safe codes/messages, never raw
stderr. Invalid caller targets/options throw DeliverError 64/66; expected provider outcomes
return discriminated results. T05B switches explicitly and never treats an unknown state as ready.

Publishing an existing PR may begin with an older remote head. Verify exact PR repository,
owner, branch, base and eligible state before pushing; require the expected head after push.
Inspect/readiness and merge always require the exact expected head. Do not prevent ordinary
scoped PR updates by demanding that an unpushed local commit already be the PR head.

Default runner suppresses terminal credential prompts and bounds time/output. SSH git@host
is valid; embedded HTTPS credentials are rejected. Provider URLs are same-host HTTPS or omitted.
Root must be a real directory. Validate JSON fields/types rather than trusting a partial object.
