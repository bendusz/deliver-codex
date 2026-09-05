import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp as makeTemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { buildLaunchArgs, setupProject } from "../bin/deliver.mjs";

const launcher = join(dirname(new URL(import.meta.url).pathname), "..", "bin", "deliver.mjs");
const temporaryRoots = [];
async function mkdtemp(prefix) {
  const root = await makeTemp(prefix);
  temporaryRoots.push(root);
  return root;
}
after(async () => Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "deliver-test-"));
  const source = join(root, "source");
  const roles = join(source, "assets", "codex-agents");
  await mkdir(roles, { recursive: true });
  await writeFile(join(source, "SKILL.md"), "# Deliver\n");
  await mkdir(join(source, "scripts"));
  await writeFile(join(source, "scripts", "run.mjs"), "console.log('ok')\n");
  await writeFile(join(roles, "planner.toml"), "name = 'planner'\n");
  return { root, source, roles, project: join(root, "project") };
}

test("setup copies skill and role agents, then is idempotent", async () => {
  const { source, roles, project } = await fixture();
  await mkdir(project);
  const first = await setupProject({ projectDir: project, sourceRoot: source, roleRoot: roles });
  assert.ok(first.created.includes(join(project, ".agents/skills/deliver/SKILL.md")));
  assert.equal(await readFile(join(project, ".agents/skills/deliver/SKILL.md"), "utf8"), "# Deliver\n");
  assert.equal(await readFile(join(project, ".codex/agents/deliver-planner.toml"), "utf8"), "name = 'planner'\n");
  const second = await setupProject({ projectDir: project, sourceRoot: source, roleRoot: roles });
  assert.equal(second.created.length, 0);
  assert.equal(second.unchanged.length, 7);
});

test("preflight detects conflicts before creating any new files", async () => {
  const { source, roles, project } = await fixture();
  await mkdir(join(project, ".agents/skills/deliver"), { recursive: true });
  await writeFile(join(project, ".agents/skills/deliver/SKILL.md"), "# Deliver\n");
  await mkdir(join(project, ".agents/skills/deliver/scripts"));
  await writeFile(join(project, ".agents/skills/deliver/scripts", "run.mjs"), "different\n");
  await assert.rejects(
    setupProject({ projectDir: project, sourceRoot: source, roleRoot: roles }),
    /existing content differs/,
  );
  assert.equal(await readFile(join(project, ".agents/skills/deliver/SKILL.md"), "utf8"), "# Deliver\n");
  await assert.rejects(readFile(join(project, ".codex/agents/deliver-planner.toml"), "utf8"), { code: "ENOENT" });
});

test("refuses symlinked source and destination paths", async (t) => {
  const { root, source, roles, project } = await fixture();
  await mkdir(project);
  if (process.platform === "win32") return t.skip("symlink permissions vary on Windows");
  await symlink(join(root, "elsewhere"), join(source, "escape"));
  await assert.rejects(setupProject({ projectDir: project, sourceRoot: source, roleRoot: roles }), /symlink/);
});

test("refuses a symlink in an existing destination parent", async (t) => {
  const { root, source, roles, project } = await fixture();
  await mkdir(project);
  if (process.platform === "win32") return t.skip("symlink permissions vary on Windows");
  await symlink(join(root, "outside"), join(project, ".agents"));
  await assert.rejects(setupProject({ projectDir: project, sourceRoot: source, roleRoot: roles }), /symlink/);
});

test("launch arguments keep prompt characters in one argv value", () => {
  const args = buildLaunchArgs({ projectDir: "/tmp/project", prompt: ["hello", "$(touch", "owned);", "&&", "echo", "x"] });
  assert.deepEqual(args, [
    "-C", "/tmp/project", "-m", "gpt-6-astra",
    "-c", 'model_reasoning_effort="high"',
    "-c", 'agents.default_subagent_model="gpt-5.6-sol"',
    "-c", 'agents.default_subagent_reasoning_effort="high"',
    "$deliver hello $(touch owned); && echo x",
  ]);
});

test("launcher passes injection-looking prompts as literal argv data", async () => {
  const root = await mkdtemp(join(tmpdir(), "deliver-launch-test-"));
  const project = join(root, "project");
  const fakeBin = join(root, "bin");
  const output = join(root, "argv.json");
  await mkdir(join(project, ".agents/skills/deliver"), { recursive: true });
  await mkdir(fakeBin);
  await writeFile(join(project, ".agents/skills/deliver/SKILL.md"), "# Deliver\n");
  await writeFile(join(fakeBin, "codex"), "#!/usr/bin/env node\nawait import('node:fs/promises').then(({writeFile}) => writeFile(process.env.DELIVER_ARGV_OUT, JSON.stringify(process.argv.slice(2))))\n");
  await chmod(join(fakeBin, "codex"), 0o755);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcher, "--project", project, "--", "$(touch", "owned);"], {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, DELIVER_ARGV_OUT: output },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")).at(-1), "$deliver $(touch owned);");
});
