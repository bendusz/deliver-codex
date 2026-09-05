import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp as makeTemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runReview, buildClaudeArgs } from "../plugins/deliver/skills/deliver/scripts/claude-review.mjs";

const temporaryRoots = [];
async function mkdtemp(prefix) {
  const root = await makeTemp(prefix);
  temporaryRoots.push(root);
  return root;
}
after(async () => Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "claude-review-test-"));
  const input = join(root, "packet.json");
  const output = join(root, "receipt.json");
  const packet = {
    schema_version: 1,
    objective: "Make the greeting consistent.",
    acceptance: [{ id: "a1", text: "The greeting uses the requested name." }],
    context: [{ path: "src/greeting.js", content: "export const greeting = name => `Hello ${name}`;\n" }],
  };
  await writeFile(input, JSON.stringify(packet));
  return { root, input, output, packet };
}

async function fakeClaude(root) {
  const executable = join(root, "fake-claude.mjs");
  await writeFile(executable, `
const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write('--safe-mode --tools --strict-mcp-config --mcp-config --disable-slash-commands --no-session-persistence --permission-mode --print --output-format --model --system-prompt\\n');
  process.exit(0);
}
if (args.includes('--model') && args[args.indexOf('--model') + 1] === 'timeout') await new Promise(() => setInterval(() => {}, 1000));
if (args.includes('--model') && args[args.indexOf('--model') + 1] === 'nonzero') process.exit(7);
if (args.includes('--model') && args[args.indexOf('--model') + 1] === 'malformed') {
  process.stdout.write('not-json');
  process.exit(0);
}
let input = '';
for await (const chunk of process.stdin) input += chunk;
const model = args[args.indexOf('--model') + 1];
const receipt = { status: 'PASS', findings: [], summary: JSON.stringify({ args, input, cwd: process.cwd(), model }) };
process.stdout.write(JSON.stringify({ is_error: false, result: JSON.stringify(receipt) }));
`);
  await chmod(executable, 0o755);
  return [process.execPath, executable];
}

test("runs Claude with the safe argv and writes an exact receipt", async () => {
  const { root, input, output, packet } = await fixture();
  const prefix = await fakeClaude(root);
  const result = await runReview({ inputPath: input, outputPath: output, allowExternal: true, prefix });
  assert.equal(result.model, "claude-opus-5");
  const receipt = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(Object.keys(receipt).sort(), ["findings", "status", "summary"]);
  assert.equal(receipt.status, "PASS");
  const invocation = JSON.parse(receipt.summary);
  assert.deepEqual(invocation.input, JSON.stringify(packet));
  assert.equal(invocation.cwd.startsWith("/"), true);
  assert.deepEqual(buildClaudeArgs({ model: "claude-opus-5" }).slice(0, 14), [
    "--safe-mode", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--disable-slash-commands", "--no-session-persistence", "--permission-mode", "dontAsk", "--print", "--output-format", "json", "--model",
  ]);
});

test("requires consent, scans secrets, and refuses symlinked input/output", async (t) => {
  const { root, input, output } = await fixture();
  const prefix = await fakeClaude(root);
  await assert.rejects(runReview({ inputPath: input, outputPath: output, prefix }), /--allow-external/);
  await writeFile(input, JSON.stringify({
    schema_version: 1,
    objective: "x",
    acceptance: [],
    context: [{ path: "src/x.js", content: "const token = 'ghp_123456789012345678901234567890';" }],
  }));
  await assert.rejects(runReview({ inputPath: input, outputPath: output, allowExternal: true, prefix }), /secret/);
  if (process.platform === "win32") t.skip("symlink permissions vary on Windows");
  const linkedInput = join(root, "linked-packet.json");
  await symlink(input, linkedInput);
  await assert.rejects(runReview({ inputPath: linkedInput, outputPath: output, allowExternal: true, prefix }), /symlink/);
  const linkedOut = join(root, "linked-out.json");
  await symlink(join(root, "outside.json"), linkedOut);
  await writeFile(input, JSON.stringify({ schema_version: 1, objective: "x", acceptance: [], context: [] }));
  await assert.rejects(runReview({ inputPath: input, outputPath: linkedOut, allowExternal: true, prefix }), /symlink|overwrite/);
});

test("rejects output overwrite and leaves no receipt on provider failures", async () => {
  const { root, input, output } = await fixture();
  const prefix = await fakeClaude(root);
  await writeFile(output, "keep me");
  await assert.rejects(runReview({ inputPath: input, outputPath: output, allowExternal: true, prefix }), /overwrite/);
  const failedOutput = join(root, "failed.json");
  await assert.rejects(runReview({ inputPath: input, outputPath: failedOutput, allowExternal: true, prefix, model: "nonzero" }), /exit code 7/);
  await assert.rejects(readFile(failedOutput), { code: "ENOENT" });
  const malformedOutput = join(root, "malformed.json");
  await assert.rejects(runReview({ inputPath: input, outputPath: malformedOutput, allowExternal: true, prefix, model: "malformed" }), /malformed JSON/);
  await assert.rejects(readFile(malformedOutput), { code: "ENOENT" });
});

test("bounds provider time and supports validation-only dry runs", async () => {
  const { root, input, output } = await fixture();
  const prefix = await fakeClaude(root);
  await assert.rejects(runReview({ inputPath: input, outputPath: join(root, "timeout.json"), allowExternal: true, prefix, model: "timeout", timeoutSeconds: 1 }), /timed out/);
  const dryOutput = join(root, "dry.json");
  const dry = await runReview({ inputPath: input, outputPath: dryOutput, prefix: ["/does/not/exist"], dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.model, "claude-opus-5");
  await assert.rejects(readFile(dryOutput), { code: "ENOENT" });
});
