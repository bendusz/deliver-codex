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

T05R owns only scripts/lib/remote.mjs and tests/remote.test.mjs. No PM/runtime state operations or transition imports. Only the shared DeliverError class may be imported from state.mjs for existing CLI error interoperability.
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

## T05B protected-branch closure publication

After remote source merge M, prepare a unique `pm/<story-id>-closure-<token>` checkout from
exact fetched M. Adopt local P/E/H there using the existing per-commit contracts. P is required
for large/regulated, requested for standard, otherwise skipped. E changes only merged Execution
and names source merge M. H changes only the actor handoff and uses BASE_COMMIT E. Local adoption
is provisional publication evidence; the remote story remains in-review until closure is proven.

T05B validates the exact M/P/E/H topology/allowlist and passes the closure branch as the generic
adapter's storyBranch with expectedHead H. No PM/state imports are added to standalone T05R.
Publish one ordinary non-draft PR, obey actual checks, and merge with the normal merge-commit
method plus match-head-commit. No admin/force or silent squash/rebase fallback. If merge commits
are prohibited, leave an explicit MERGE_METHOD_UNSUPPORTED reconciliation state and preserve
branch/PR. Document this provider limitation; do not claim remote closure is complete.

Check the remote base is M before publication and again before merge. Fetch actual result R
and require integration ref R, parents M/H, tree(R)=tree(H), and preserved P/E/H ancestry.
R is a publication wrapper recorded in external evidence, not a new source snapshot/adoption.
Only then report remote completion. E names M; the external receipt records R. Because diff
E..R contains only H in this normal case, upstream handoff freshness accepts BASE_COMMIT E.

The provider's match-head-commit does not lock the base. An external base race must not invent
PASS. If actual R still proves exact report/story publication without conflict rewrite, record
closure_published/handoff_stale and use an executable bounded handoff-only prepare/publish/reconcile
operation from the current integration tip. Never rerun/relabel source gates for a handoff repair.
Ambiguous or changed closure bytes stay unresolved. B owns CLI closure prepare/publish/reconcile
and its exact local proof, extending L APIs only from a fresh task baseline.

Tests use real temporary Git and a fake provider for large P/E/H and small E/H, disallowed merge
method, checks/head failures, base race with honest stale handoff and actual repair path, and
rejection of extra paths/conflict rewrites. No test calls real remotes or bypasses branch rules.

`prepareHandoffRepair(closureRecord,{integrationRoot})` requires published E reachable on the
fetched integration ref, absent/stale handoff, clean checkout and exact current head N. Create
a fresh branch at N; adopt H2 direct child with only the actor handoff and BASE_COMMIT N. Use
normal provider push/PR/check/merge. Result S must have parents N/H2, tree(S)=tree(H2), and diff
N..S only the handoff. Persist every token/attempt/result; another base race is HANDOFF_BASE_RACE.
Cap automatic publication retries at two in this durable record. These are publication attempts,
not new builder dispatches; never reset or rewrite completed source/story attempt counters.
Exhaustion preserves published closure and reports incomplete handoff reconciliation.

## Structured checks exit status clarification

The current GitHub CLI checks source exports JSON before applying the human-output failed/pending exit statuses. Treat exit0 structured output according to each bucket, including failure and pending. Nonzero structured output remains a provider error/UNKNOWN and never READY. The narrow exact no-check exit1 exception above occurs before JSON export and remains valid. Source: https://github.com/cli/cli/blob/trunk/pkg/cmd/pr/checks/checks.go (reviewed 2026-09-10). This clarifies the active T05R dispatch; its frozen task input copy is unchanged.

## T05B already-merged provider reconciliation

Independent T05R review confirmed the direct adapter returns PR_MERGED from initial lookup
and intentionally does not treat that label as completion. Its public PR result currently omits
mergeCommit, so B cannot claim restart/queue recovery using that result alone. Before wiring
remote lifecycle completion, B must add a read-only already-merged reconciliation operation
in remote.mjs: exact expected PR repository/owner/head/base/number, current MERGED status and full
merge commit, followed by remote-base proof. It must issue no second merge command or push.
An advanced base needs actual fetched Git ancestry proof in B. Malformed/missing data stays
UNKNOWN; queued/open remains pending. Persist the returned actual proof against the original
prepared lifecycle record. Exercise interruption after provider merge and before local receipt,
and queue completion on a later process, using the fake provider plus real Git history.
