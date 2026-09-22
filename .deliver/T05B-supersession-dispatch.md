# T05B premerge supersession dispatch

Routine clarification of the existing approved requirement and operation names, agreed with native architecture during initial implementation. This does not change task scope, approval, baseline or counters. Read with T05B-operation-dispatch.md and the frozen remote contracts.

Keep `input.target.expectedHead = C` immutable. Add a separate normalized input observation:

```text
remote_observation: {
  version: 'remote-premerge-observation-v1',
  repository_identity, pr_number, story_branch, integration_branch,
  observed_remote_head, observed_remote_base, result_identity
}
```

Head may be null only for exact PR_ABSENT. A base must be a proved OID before qualifying a base change. Adapter inspect obtains the already-permitted optional remoteBase through bounded read-only ls-remote against the validated destination. No CLI proof flag or caller-supplied observation is added. Desired operation payload identity excludes the observation; existing input_identity binds both.

Existing source publish/merge commands provide the path:

1. Reject stale record/source/target. A successful source merge forbids supersession and writes; preserve the existing same-input proven result. A live local invocation returns PROVIDER_EXECUTING before provider reads. Other executing attempts permit only the already-defined read-only reconciliation/replay proof.
2. Obtain one exact read-only current observation. Unknown, failed, absent, pending, ambiguous or changed repository/PR/branch identities cannot qualify supersession.
3. Derive the predecessor observation from its latest observed result when available, otherwise its prepared input. A completed push of C therefore compares against its returned C; a prepared successor at drifted D compares against D.
4. Refuse changes to the desired payload excluding remote_observation. Compare stable repository/PR/branch identity and head/base OIDs. A changed result hash, check detail or timestamp alone cannot qualify a new attempt.
5. Equal observations execute an active prepared token once or return the retained observed/effect result idempotently.
6. Only an exact proved head/base OID change with stable repository/PR/branch identity and no source merge proof permits a successor. Atomically mark the predecessor superseded with superseded_by=newToken; append a prepared successor with supersedes=oldToken and unchanged retry. Return PROVIDER_SUPERSEDED without a provider write. The next identical call with unchanged observation executes that prepared token once.

Retain slot.effect during successor preparation/execution. The prepared transition has an identified supersession_proof containing the predecessor attempt identity, predecessor effect identity or null, prior/current observation identities and changed fields. On successor success the slot may point to its new effect; the prior effect remains recoverable from the retained observed result and supersession proof. Never rewrite or delete old observed result bytes or identity. Source counters and publication retry do not change. Subsequent actual Git lineage/tree proof remains mandatory.

Acceptance covers exact head and base changes; reciprocal links and one execution; immutable C; unchanged-observation idempotence; metadata-only changes; failed/unknown/malformed observations; stale record hashes; successful merge refusal; and preserved prior effect/history/counters.
