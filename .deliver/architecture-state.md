# Independent architecture guidance for T02-T05

Source: native state_architecture agent, approved plan review. This is design evidence, not a
code review PASS for future implementation.

- Dependency direction: state -> basic persistence/hash; story -> state; project-state -> story/state;
  pm -> project-state/story/state; scope must not create a cycle through pm. Runtime composes them.
- Story acceptance has ordered text, checked flag and line, not invented stable IDs. Runtime packets
  retain their independent acceptance IDs and compare ordered text exactly.
- Hash the full story contract with only the precisely delimited final Execution section removed.
  Reject duplicate/ambiguous sections and invalid metadata; never exclude an entire story or docs tree.
- Inspector reads current marker, plan policy, stories/Execution, Git claims, worktrees, handoff,
  missing retrospectives and unreadable stories. Missing identity does not block discovery/status.
- Current format remains detectable if marker is malformed/nonregular, deleted but tracked in Git,
  or recognizable root story metadata remains. An arbitrary plan alone is not shared provenance.
- Bind current execution to tracked regular marker and plan with matching approved Git blob digest,
  owner, branch, resolved builder, story contract/execution hashes, and bounded packet scope.
- Preserve legacy bindings as a tagged union until explicit migration. New projects use current format.
- Check binding on check/gate/review/verify/finish. Search existing runs to prevent budget reset.
- Transition statuses claimed -> building -> built -> in-review; fix returns to building; blocked
  is explicit; only verified integration can mark merged. Persist retry/fix increments before dispatch.
- Recover torn story/run publication with before-image checks, unchanged contract/ownership and the
  maximum spent counters. Never decrement a spent budget.
- Commit adoption is two-phase: prepare audited source/Execution entries and protected Git metadata,
  then PM stages exact paths and commits. Adoption accepts only the specified current HEAD that is
  one direct child of the prepared HEAD, same branch, clean index/tree outside runtime evidence,
  identical intended entries and unchanged Git config/hooks/excludes.
- Keep original content baseline and dirty-file protections immutable. Add a mutable git_anchor for
  accepted coordinator HEAD/index transitions; cumulative scope stays measured from task start.
- An adopted HEAD changes snapshot identity. Clear and rerun gates/review/verification; never relabel
  old PASS evidence. Worker commits continue to fail the normal audit.
- Complete only after actual local/remote merge on the integration branch with contents matching
  verified code. Changed integration contents require fresh evidence. Write merged status and merge
  SHA note, then commit close metadata; BASE_COMMIT handoff points at the actual resulting commit.
- Remote PR merge must check current branch/check/head/merge SHA, use normal branch protection and
  exact-head matching, and never infer success from exit code alone.
- Future PM pushes should avoid writing branch tracking config while workers have active baselines.
  This run observed and recovered that issue by restoring only coordinator-created tracking settings.

Key regressions: malformed/FIFO state never done; revoked/deleted approval blocks shared Quick;
foreign/duplicate claims cannot reset retries; exact audited commit adoption keeps cumulative scope
and expires old receipts; altered integrated contents cannot be marked merged from old verification.

## T04/T05 final closure lineage, independently clarified

1. Candidate C contains audited source and final pre-integration Execution `in-review`. Normal
   T04 direct-child/exact-content commit adoption advances git_anchor, retains original scope,
   clears old evidence. Run fresh gates/review/verifier at C. `.deliver` evidence may remain
   uncommitted. Finish certifies source evidence at C, not merged project progress.
2. Integrate C to actual M. Validate actual task/source entries and story contract against C;
   record integration-verification lineage C/evidence snapshot -> M. Conflict resolution or
   source/contract delta needs fresh gates/review/verification. Squash/rebase requires explicit
   reconciliation; no-ff history is default.
3. Deterministic closure commit E changes ONLY this story's final Execution from in-review to
   merged, updated timestamp, and actual M merge-SHA note. Preserve owner/builder/branch/counters,
   unknown safe metadata and contractHash. Validate exact before image and path/content delta.
   E is a closure record, not a relabeled code-evidence snapshot. It does not use normal adoption
   to clear the already retained evidence; it has its own validated lineage.
4. Separate handoff-only commit H writes current actor handoff with BASE_COMMIT E. A commit
   cannot contain its own SHA. Upstream treats H current because everything after E changes only
   that actor handoff. Do not combine Execution closure and handoff with BASE_COMMIT M.
5. Journal C/M/E/H for recovery and recheck ancestry/trees/exact diffs. Any extra path, changed
   story contract or source during E/H leaves the metadata exception and needs fresh evidence.
   Protected remotes may need closure PRs but retain E then handoff-only H semantics and checks.

Integration must support a finished source run in its story worktree and a separate integration
checkout in the same Git repository. Preserve source run.project_root and baseline identity;
validate common-repository identity and explicitly record destination checkout/commit in the
integration lineage. Do not rewrite a run's project_root or pretend its original evidence was
captured in the integration checkout. This is required before T12 parallel worktrees.

T08 native routing: project-state.next_reference deliberately retains upstream 0.25.1 names for
compatibility (planning-and-signoff, implementation-loop, migrations, documentation). Doctor/resume
and hook must map those phases to actual installed native references (planning, workflow/runtime,
migration, shipping/recovery), or expose a separate native_reference. Do not send users to missing
upstream-only paths or alter the compatibility next_reference field merely to route native code.

## T03/T12 current claim precedence

- Public sequential claim publishes from a clean integration checkout at the inspected plan
  integration tip, ignoring only framework execution evidence. Target story is authoritative
  first: unreadable blocks, merged is terminal, any other Execution status holds the claim.
  Same owner resumes its existing run/counters; foreign ownership blocks.
- Only for an unclaimed target, inspect target-scoped local and fetched remote story refs plus
  attached worktrees. Use an exact `<story-id>-` boundary; S1-1 never matches S1-10. Hidden or
  ambiguous claim signals block; no automatic deletion/adoption of refs/worktrees.
- Proven integration/closure outranks retained old source-ref copies still marked in-review.
  Accept native C/M/E lineage or equivalent legitimate upstream Git merge/closure evidence;
  imported upstream completion must not require a Codex .deliver journal. Manual merged text
  alone cannot suppress contradictory active evidence. Retained proven-old worktrees are
  cleanup advisories, not global blockers for the next story.
- Key runs/claims/counters by repository + story/owner/branch, not actor globally. Foreign claims
  on independent other stories do not block globally. Public sequential same-actor concurrent
  work may return PARALLEL_BATCH_REQUIRED. T12 later prevalidates an independent wave against
  one integration tip and publishes its Execution claims before worktree dispatch.
- Keep pure claim conflict preparation separate from publication; no new actor.active_story or
  batch backlog file. Remote visibility is local plus fetched tracking refs, never distributed
  atomic locking or claimed current remote freshness without evidence.

## Accepted T04 CLI preparation

- `pm transition --run RUN --to building|built|in-review|blocked [--attempt fix|retry] [--reason TEXT]`.
  Legal forward path claimed->building->built->in-review, explicit blocked, and bounded fix/retry
  return to building. Same-state resume is a no-op. Current-bound correct-course fix/retry must
  route through the same atomic story/run counter transition; standalone/legacy keep their
  existing behavior. T05 alone records merged.
- `deliver commit-prepare --run RUN` records audited parent/branch/paths, exact expected tree via
  a temporary index, protected metadata and nonce. No live .deliver receipt is staged.
- `deliver commit-adopt --run RUN --token TOKEN --commit FULL_SHA` accepts only the exact single
  direct-child commit and matching tree/index/worktree/protected metadata. Advances git_anchor,
  preserves original baseline/dirty paths, records adoption, clears all earlier evidence.
- Support necessary intermediate PM commits in claimed/building/built/in-review states. Only
  the final candidate C must be in-review. Requiring in-review for every intermediate commit
  would break the approved commit-as-you-go workflow.
- Story/run before/after journals preserve contract, owner, route, branch, safe unknown fields
  and MAX credible spent counters across torn publication. Metadata normalization applies only
  to the bound, audited Execution entry, never whole stories or arbitrary docs paths.

## T05 shared verification separation

The approved plan requires a separate final verifier at every current shared-project scale.
T03 preserved existing mode-based receipt handling; T05 must enforce the current binding rule
at verify, finish, state validation and integration reconciliation. Current shared Managed/Quick
cannot use the same reviewer/verifier. Standalone Quick/Managed behavior remains unchanged.
This is a release acceptance requirement, not a new user approval checkpoint.

## T13B coordinator preparation (pending architecture review)

Upstream comparison permits at most one clarification retry, independent of normal delivery
retry/fix budgets. Both candidates use the same approved tracked story and fixed clean base,
identical deterministic gates and risk-selected independent review, with no persisted route
change, merge, push or automatic route selection. Prevalidate two distinct effective available
native configurations before any worktree mutation. Each worktree and result remains isolated;
never expose one candidate result to the other builder. Preserve dirty or failed worktrees.
Native host dispatch must be an explicit callable adapter or prepare/dispatch/record protocol,
not a claim that a dependency-free Node process can call the host's collaboration tools itself.
The CLI must support the real documented native flow; fake-adapter test support alone is not
a completed user operation. Availability/model/role must be positively reported, no guessed
substitution. Snapshot-bound gates and independent review are measured evidence; tokens/cost
are null unless exposed. Restart must retain first response, spent retry and incomplete dispatch
without double-dispatching or replacing failed evidence. T13A scorer remains deterministic.

## T08 coordinator preparation (pending architecture review)

Use the T07 analyzer on the live artifacts for every first claim. A caller-supplied analysis
JSON cannot replace deterministic recomputation. Standard/large/regulated semantic review
attestation must bind the recomputed pre-claim story scope, content and analysis identities,
identify its reviewer, cover every required semantic item and retain located findings. Missing,
stale, incomplete, UNKNOWN or unresolved blocking review cannot authorize claim. Tiny/small
skip mandatory semantic review but still enforce factual readiness, valid approval and claims.
Same-owner legitimate resume retains its claim/run/counters and must not be made impossible by
an analyzer rule that expects an unclaimed story. Existing lifecycle fixtures must provide real
required project artifacts or choose an explicitly valid tiny/small policy; never add a hidden
test bypass. Large/regulated checklists remain required evidence, not automatic checkbox PASS.

Keep doctor, resume inspection and hook observational. Hook stdin is byte-bounded before JSON
parse; nonregular files, symlink escapes and malformed state are bounded diagnostics. No gate
execution, model calls, config edits, fetch, migration, lock deletion or report writes during
inspection. CLI may explicitly emit an environment report, separated from the read-only module.
Environment probes report available executables and declared requirements, not unsupported
claims that an entire arbitrary shell command will succeed. Never print config/secret values;
check required names only. Hook resolves the same packaged inspector/diagnostics, with stable
native_reference mapping while upstream next_reference remains unchanged.

Material correct-course must revoke shared approval with recoverable before-image publication
and retain all spent retries/fixes and historical evidence. A new baseline requires explicit
reconciliation; it cannot reset an active story budget or resurrect an old PASS.

T14 documentation correction: legacy `references/specdd.md` opening still says not to enable
SpecDD merely because a project is large. Reconcile with the approved large/regulated mandatory
contracts policy and `scale-profiles.md`; ordinary lower-scale use remains optional and official
plugin installation remains optional. T07 analyzer must honor the approved scale requirements.

## T08/T13B independent design review accepted refinements

T08 artifact review requires a dedicated bounded schema before any run exists:
`{schema_version, stage: pre-claim, story_id, analysis_identity, content_identity, reviewer,
items, findings}`. `pm claim --semantic-review <regular-json>` recomputes T07 analysis live,
requires exact identity/stage/story, complete coverage of required semantic items, no FAIL/UNKNOWN
or unresolved block/major, and persists receipt hash/provenance before claim publication.
Reviewer identity is an attestation, not authentication. Existing code review receipts cannot
serve as artifact analysis, and caller-supplied analysis never replaces recomputation.

Large/regulated preclaim checklists: `docs/checklists/spec-quality.md`, `plan-quality.md`,
`story-readiness-<id>.md`, with checked non-placeholder Evidence and semantic assessment.
`verification-<id>.md`, durable verification reports and wiki lint are later-phase requirements.
T07 binds all prerequisite bytes; T08 consumes semantic coverage, not mere file existence.

Material correction revokes the shared approval marker first through recoverable publication,
then updates the selected run under revision lock. Preserve superseded gate/review/verification
identities in history, retain MAX counters, clear only active pointers. A crash between steps is
safely revoked and doctor reports reconciliation. Never update the run first. Observational
diagnostics use noncreating store readers, bounded regular run enumeration and unique matching
pm_binding selection; ambiguity remains explicit. Environment report goes to stdout; writing
`tmp/environment-check.md` is an explicit caller action.

T13B uses a separate workflow manifest in `tmp/builder-benchmark/<id>/`, not the T13A result
schema as restart state. Manifest binds full base OID, story/contract, two effective configurations,
unique non-pm/S branches/worktrees, dispatch state/token/attempt/timestamps, HEAD/snapshot, exact
gate receipts/logs, scope result, panel receipt hashes and exposed/null usage. Derive aggregate
metrics from actual evidence; never trust adapter summary counts.

Document a real native protocol: prepare validates both positively available configurations and
immutable inputs before creating either worktree; dispatch-prepare persists a deterministic
candidate/attempt token before host spawn; host invokes the actual named native role/model;
record-dispatch/result binds actual agent identity/evidence; gate/review/finalize derive results.
Pending dispatch after interruption is UNKNOWN and never automatically resent. Fake adapters
exercise the same protocol as tests only. Installed TOML alone is not positive host model
availability. Both candidates get byte-identical approved story/task/gates/panel and full base,
scope is checked before gates, no route/Execution/approval mutation, no merge/push, one separately
persisted clarification retry. Clarification can restate existing immutable artifacts only;
material change blocks both. Operations/SKILL route updates added to T13B packet.

## T05 durable reporting phase (independent architecture clarification)

Large/regulated story closure uses C -> M -> P -> E -> H. P adds only
`docs/verification/<story-id>.md` and `docs/checklists/verification-<story-id>.md` after
proven M. Standard may opt in; tiny/small skip. The report references verified source C,
source snapshot and actual gate/review/distinct-verifier receipt identities, and Integrated as M.
It never embeds P or its own hash. Reporting preparation stores exact expected bytes/blob hashes
externally; reporting adoption verifies exact direct-child P of M and only these paths.
Every PASS must map to actual current C evidence and every acceptance ID; UNKNOWN/FAIL remains
blocking, required lenses/separation hold, and checklist evidence is concrete. Exact deterministic
report generation is preferable to pretending arbitrary prose claims can be machine-proven.

P does not relabel source evidence or rerun source gates when it proves source/contract/story
bytes unchanged and exact reporting/evidence lineage. Any extra path or changed evidence exits
the reporting exception. E remains story-only merged Execution and requires valid P at the
applicable scale. T08 only diagnoses/routes missing/stale reports; it never writes them.

Project-level regulated wiki lint follows final story closure and required retrospectives, not
every claim/story. T11 will provide a bounded read-only wiki manifest/lint identity over tracked
regular docs/wiki files, with tool/version, commit and located findings; semantic review remains
explicit where needed. A final completion report after these terminal story runs references
actual story lineages and current wiki lint. Allocate the complete project-reporting operation
after T10/T11 against their actual APIs, not inside T05 before those dependencies exist.
It is scoped reporting work, never a broad documentation exemption from evidence checks.

Ordinary story handoff BASE_COMMIT points E. After additional validated project-level reporting,
it points the latest non-handoff closure/reporting commit. The handoff-only commit never refers
to its own hash. Future wiki changes invalidate the matching wiki lint identity; source changes
require their own authorized story/evidence, never retroactive rewriting of an old report.

## Structured review evidence interface for T05/T11

Runtime currently strips every input review field except status/findings/summary. Extend it
with a bounded optional `panel: {snapshot_hash, members: [{lens, reviewer, verdict, findings}]}`
whose verdict is PASS/CONCERNS/FAIL. Every member binds the same snapshot, all safe identities
are validated, and aggregate top-level verdict/findings are derived from all members. Never
trust an underreported aggregate or infer lens proof from prose. Preserve original member
CONCERNS and all minor findings in a runtime PASS-with-minors aggregate.

Existing no-panel receipts remain compatible for legacy/standalone. Current large/regulated
reporting P needs exact story-declared lens coverage plus code-integrity-reviewer always and
security-auditor for regulated; no invented panel evidence. Native role names and persisted
upstream lens names are distinct; document their explicit dispatch mapping. T11's adapter
must feed the actual runtime parser/state, not merely emit disconnected examples.

T05 introduces the retained panel contract and reporting consumption; T11 supplies the full
pure source-verdict/aggregation/scoped-review adapter and actual runtime integration. Packets
now contain review.mjs, runtime/state and focused review-panel tests as applicable.

T08 packet includes existing current transition/integration/reporting/remote fixtures solely
for supplying real required readiness artifacts when first-claim enforcement arrives. Keep
behavioral assertions; no hidden bypass or wholesale scale downgrading to avoid the new gate.

Panel implementation detail: retain each member's actual snapshot identity (or an equally explicit
validated source receipt identity), require it to match the panel/runtime snapshot, and never
replace an old member identity while aggregating. T11 standalone review-scope content identities
are not automatically interchangeable with runtime snapshots. Runtime dispatch must capture and
validate both identities against the actual intended task content before review; generic recent
or worktree review cannot silently certify omitted earlier task commits. Full task review uses
the original cumulative task scope/base, even after intermediate commit adoption.

## Proposed T05 task split, pending remote-port interface

After T04 independent PASS, T05 may split into T05L local C/M/P/E/H + panel evidence and T05R
standalone GitHub provider port (remote.mjs/tests/remote.test.mjs) in parallel. A fresh T05B
after both integrate wires the actual remote CLI and exercises the complete remote lifecycle.
Do not import an absent remote module in the local-only task or merge sibling source commits
into an active run to satisfy dependencies: that changes its protected baseline. T05R tests
the same real adapter protocol with injected fake runner; it is not by itself the complete
remote user operation. No split packets/runs exist yet; finalize exact interfaces/scopes first.

## T04 first coordinator check diagnosis

Actual original baseline Git metadata is unchanged. New gitMetadata fields/ls-files format
changed its digest shape and falsely reject pre-T04 no-anchor runs. Independent architect
recomputed the exact old algorithm and matched stored baseline f69f8e0908e... . Fix round1
must compare exact legacy-v1 metadata only for pre-anchor persisted runs, recursively including
initialized submodules, while retaining new-format snapshots for fresh evidence. Baseline bytes
are immutable; no blanket old-run exemption. Regression must prove old baseline acceptance and
continued HEAD/index flags/config drift rejection. Actual failed check saved with task evidence.

## T05 combined integration evidence contract

Always execute declared task gates on actual combined integration M. Preserve C review/verifier
only when a committed binding manifest is identical at C/M and composition is a proven clean
merge of prior integration I and candidate C. Manifest expands exact mode/blob/missing entries
for touches, read_paths and specs, plus story contract, approved plan/marker, packet, actor/route
and source receipt identities. Recompute the clean merge tree with Git plumbing and compare
M exactly; conflict/manual content is not clean composition.

A separate .deliver/integrations record binds original source run/C/snapshot/manifest/review/
verifier, destination checkout/I/M/tree/method/manifest, and fresh M/tree/environment/log-bound
gates. Never mutate original run.project_root, baseline, completion snapshot or C evidence;
never claim old C gates ran at M. This preserves independently completed sibling local receipts
while testing their actual combined tree. Prior I may contain legitimate imported upstream
completion without native journals.

Candidate C manifest must also match the actual bound input content certified by its source
snapshot, not merely equal M's committed manifest. T04 can preserve pre-start dirty user work.
If such bytes affect touches/read_paths/specs, a review of that worktree is not automatically a
review of C's committed blobs. Require that match or fresh M review/verification; do not erase
or commit the pre-existing work. Unrelated unbound dirty files do not justify a blanket rejection.

Proposed pure boundaries: prepareIntegrationEvidence(runArg,{integrationRoot,candidateCommit,
integrationCommit}); runIntegrationGates(preparation,{expectedPreparationHash}) rechecks before
each exact command; finalizeIntegrationEvidence(preparation,gateReceipts) recomputes lineage/
manifest/receipt digests. Only a PASS receipt tied to M permits P/E. Changed bound inputs,
manual/conflict composition, unknown lineage or failed M gates requires fresh source evidence.

Resolved correction protocol is recorded in integration-correction-design.md. T05L supports
fresh independent review and distinct verification of M when only evidence needs refreshing.
T05C supplies token-bound correction branches/runs for actual source findings, after T05L.
Normal claim/start and completed source-run immutability remain unchanged. T05 is incomplete
until L, R, C and final remote wiring B all pass their own acceptance.

## T08 current PM journal correction

Independent read-only audit confirmed current-pm validateJournal/applyJournal checks paths and
string equality but permits arbitrary approval/story after-images. T08 owns operation-specific
validation for init/approve/revoke/claim before every recovery write. Init is canonical pending;
approval/revocation preserve unknown fields and validate their exact legal field deltas and live
tracked plan policy/digest; claim preserves contract and creates only exact claimed Execution
with owner/route/zero counters after its original readiness and conflict checks. Reject new
story creation, merged/criteria mutation and mixed/two-story journals. Existing v1 recovery may
infer one unique legal operation, otherwise report ambiguity without mutation. Genuine applied
claim images may normalize only the exact validated after-image to before when proving the
original clean checkout precondition. No broad dirty exemption or pretend authentication.

T05 implementation is split into L local integration/reporting/panel, R provider port, C tokenized
source correction, and B final remote wiring. L and R can begin in separate worktrees after T04
PASS. C starts from integrated L. B starts after L/R/C; no dependency merges into active runs.
