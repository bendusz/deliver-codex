# T08 diagnostics dispatch choice

Before T08 baseline, the coordinator adopts the exact boolean option and CLI/report contract
recommended in `.deliver/T08-environment-proposal-native.json`. This resolves the routine API
spelling left open by the approved architecture design. It adds no task path or capability
beyond the existing observational diagnostics and explicitly requested environment report.

Use `inspectDoctor(root,{runId?,storyId?,environment?:boolean})`, default false. The pure
module returns the bounded diagnostic result and never writes a report or executes a tool.
The CLI is `pm.mjs doctor [--run RUN] [--story STORY] [--environment]
[--output tmp/environment-check.md]`. The environment flag is valueless. Default output is
one JSON line. The optional fixed report path requires the environment flag and is the
only report-writing action. Validate all output path components before creating anything;
reject symlink/nonregular targets and root escapes. Render the already computed checks
without a second probe. The optional hook always disables environment probes.

Use the exact proposal for error codes, result fields and name-only output. This is dispatch
preparation, not implementation, acceptance or an authorization to start T08 before T05B.
