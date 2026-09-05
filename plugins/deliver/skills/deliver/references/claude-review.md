# Optional Claude review

Use Claude only when the user requests external review or has explicitly enabled it for this
project and scope. It is not a fallback builder or a required delivery gate by default.
The `deliver-claude-reviewer` native role is a GPT-5.6 adapter that runs this workflow, not a
native Claude thread inside Codex.

Prepare a bounded JSON packet after checking the exact code state:

```json
{
  "schema_version": 1,
  "objective": "Review this bounded change for correctness",
  "acceptance": [{"id": "AC-1", "text": "The greeting includes the supplied name"}],
  "context": [{"path": "src/greet.mjs", "content": "export const greet = name => `Hello, ${name}!`;"}]
}
```

Include the actual diff and relevant source/contracts, not a builder's characterization alone.
Keep the packet under the adapter's size limit. Review its exact contents before sending it.
Do not include credentials, environment files, private keys or unrelated source. The built-in
secret scanner catches some recognizable patterns; it cannot certify a packet secret-free.

```text
node <skill-directory>/scripts/claude-review.mjs --input .deliver/claude-packet.json --out .deliver/claude-receipt.json --dry-run
node <skill-directory>/scripts/claude-review.mjs --input .deliver/claude-packet.json --out .deliver/claude-receipt.json --allow-external
```

The second command needs authorization to send this packet to Claude. It uses existing Claude
CLI authentication and may consume paid quota. The adapter gives Claude no built-in tools or
MCP servers, uses safe mode and a temporary working directory, and does not discover additional
project files. Managed machine policy may still apply; this is not an OS sandbox guarantee.
There are no automatic retries or model fallbacks.

A valid review receipt is advisory input to normal review aggregation. Preserve findings and
the code hash reviewed. The coordinator imports it only against that same snapshot and handles
minor versus major findings under the usual rules. Claude did not run tests or inspect files
outside the packet. Do not use its response as independent runtime verification.

Missing CLI/auth, missing isolation flags, timeout, provider failure, malformed output or a
secret-scan rejection means the external review did not complete. Report the failure without
weakening flags. If external review was a required gate, stop until the user resolves or waives it.
