# Evaluation and release boundaries

This first implementation is a usable local Codex workflow, not a claim that orchestration
outperforms ordinary Codex. The automated suite verifies deterministic contracts without model
API calls. A forward test exercised installed Quick setup, a real failing/passing Node test,
fresh-process resume and snapshot invalidation. It did not fabricate independent peer review.

Before recommending Managed or SpecDD broadly, compare these configurations with the same
GPT-6-Astra main and GPT-5.6 worker settings:

1. Ordinary Codex on the user's bounded request.
2. Deliver Quick or Managed without SpecDD/wiki.
3. The same Deliver flow with only the affected SpecDD contracts.

Use a local fix, a cross-module interface change, and a legitimately approved contract change.
Repeat after an interruption between implementation and review. Seed an out-of-scope path
change and a contract mismatch without telling the reviewer the expected finding.

Record acceptance correctness, missed/false findings, turns, agent dispatches, elapsed time,
tokens when exposed, correct first action after resume, repeated questions, stale evidence and
contract maintenance cost. An experiment that compares different models or unmatched task
scope does not establish a workflow benefit. Do not promote cheaper routing solely because
one small example passed.

Not completed in this build: live paid Claude review, a full model-to-model comparative benchmark,
cross-machine state relocation, distributed claims, automatic legacy migration and live Windows
CLI integration. These are explicit limitations, not simulated successes.

## Documentation checked

- [Codex native agents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Codex skills](https://learn.chatgpt.com/docs/build-skills)
- [Codex hook runtime](https://developers.openai.com/codex/hooks)
- [Plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference)
- [SpecDD language](https://specdd.ai/language-reference/)
- [Official SpecDD Codex plugin](https://github.com/specdd/plugin-codex)

Checked on 2026-09-05. Local help probes used Codex 0.153.4 and Claude Code 2.1.261.
