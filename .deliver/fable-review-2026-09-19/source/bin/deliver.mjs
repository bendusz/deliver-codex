#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(THIS_FILE), "..");
export const SOURCE_SKILL_ROOT = resolve(
  REPOSITORY_ROOT,
  "plugins/deliver/skills/deliver",
);
export const SOURCE_ROLE_ROOT = join(SOURCE_SKILL_ROOT, "assets/codex-agents");

const DEFAULT_MODEL = "gpt-6-astra";
const DEFAULT_EFFORT = "high";
const DEFAULT_SUBAGENT_MODEL = "gpt-5.6-sol";
const DEFAULT_SUBAGENT_EFFORT = "high";
const DEFAULT_SANDBOX = "danger-full-access";
const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const SKILL_INSTALL_RELATIVE = join(".agents", "skills", "deliver");
const AGENTS_RELATIVE = join(".codex", "agents");

const HELP = `Usage:
  deliver setup --project PROJECT [--dry-run]
  deliver --project PROJECT [--model MODEL] [--effort LEVEL]
          [--sandbox read-only|workspace-write|danger-full-access]
          [--dry-run] [--] [prompt...]

Commands:
  setup       Install the Deliver skill and its role agents into PROJECT.

The launcher expects Codex CLI to be installed as the codex executable.
`;

function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function isPathInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function pathKind(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return "symlink";
    if (info.isDirectory()) return "directory";
    if (info.isFile()) return "file";
    return "other";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

async function assertNoSymlinkInPath(path, { allowMissingLeaf = true, boundary = path } = {}) {
  const absolute = resolve(path);
  const root = resolve(boundary);
  if (!isPathInside(root, absolute)) fail(`Path is outside its checked boundary: ${absolute}`);
  const pieces = relative(root, absolute).split(sep).filter(Boolean);
  let current = root;
  const rootKind = await pathKind(current);
  if (rootKind === "symlink") fail(`Refusing symlink path: ${current}`);
  for (let index = -1; index < pieces.length; index += 1) {
    if (index >= 0) current = join(current, pieces[index]);
    const kind = await pathKind(current);
    if (kind === "missing" && allowMissingLeaf) return;
    if (kind === "symlink") fail(`Refusing symlink path component: ${current}`);
    if (kind !== "directory" && !(index === pieces.length - 1 && kind !== "missing")) {
      fail(`Destination path component is not a directory: ${current}`);
    }
    if (kind === "missing") return;
  }
}

async function readSourceTree(sourceRoot) {
  const entries = [];
  async function visit(current, relativePath = "") {
    const kind = await pathKind(current);
    if (kind === "symlink") fail(`Source tree contains a symlink: ${current}`);
    if (kind !== "directory") {
      if (kind !== "file") fail(`Source entry is not a regular file or directory: ${current}`);
      const data = await readFile(current);
      entries.push({ type: "file", relativePath, data, mode: (await stat(current)).mode & 0o777 });
      return;
    }
    if (relativePath) entries.push({ type: "directory", relativePath });
    const children = (await readdir(current)).sort();
    for (const child of children) {
      await visit(join(current, child), relativePath ? join(relativePath, child) : child);
    }
  }
  await visit(sourceRoot);
  return entries;
}

async function readRoleSources(roleRoot) {
  const kind = await pathKind(roleRoot);
  if (kind === "missing") return [];
  if (kind !== "directory") fail(`Role source is not a directory: ${roleRoot}`);
  const names = (await readdir(roleRoot)).sort();
  const roles = [];
  for (const name of names) {
    if (!name.endsWith(".toml")) continue;
    const sourcePath = join(roleRoot, name);
    const sourceKind = await pathKind(sourcePath);
    if (sourceKind === "symlink") fail(`Role source contains a symlink: ${sourcePath}`);
    if (sourceKind !== "file") fail(`Role source is not a regular file: ${sourcePath}`);
    roles.push({
      sourcePath,
      destinationName: name.startsWith("deliver-") ? name : `deliver-${name}`,
      data: await readFile(sourcePath),
      mode: (await stat(sourcePath)).mode & 0o777,
    });
  }
  return roles;
}

async function compareDestination(destination, expected, type) {
  const kind = await pathKind(destination);
  if (kind === "missing") return { action: "create", destination, expected, type };
  if (kind === "symlink") fail(`Refusing symlink destination: ${destination}`);
  if (type === "directory") {
    if (kind !== "directory") fail(`Setup conflict at ${destination}: expected a directory.`);
    return { action: "unchanged", destination, type };
  }
  if (kind !== "file") fail(`Setup conflict at ${destination}: expected a regular file.`);
  const actual = await readFile(destination);
  if (Buffer.compare(actual, expected) !== 0) {
    fail(`Setup conflict at ${destination}: existing content differs; refusing to overwrite it.`);
  }
  return { action: "unchanged", destination, type };
}

async function preflightDestinationPath(path, boundary) {
  await assertNoSymlinkInPath(path, { boundary });
}

async function ensureParentDirectories(path, created) {
  const parent = dirname(path);
  const missing = [];
  let current = parent;
  while (true) {
    const kind = await pathKind(current);
    if (kind === "missing") {
      missing.push(current);
      const next = dirname(current);
      if (next === current) break;
      current = next;
      continue;
    }
    if (kind === "symlink") fail(`Refusing symlink destination: ${current}`);
    if (kind !== "directory") fail(`Setup conflict at ${current}: expected a directory.`);
    break;
  }
  for (const directory of missing.reverse()) {
    await mkdir(directory);
    created.push(directory);
  }
}

async function writeNewFile(plan, created) {
  await ensureParentDirectories(plan.destination, created);
  const parent = dirname(plan.destination);
  const temporaryDirectory = await mkdtemp(join(parent, ".deliver-tmp-"));
  const temporary = join(temporaryDirectory, "content");
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, plan.mode || 0o644);
    try {
      await handle.writeFile(plan.expected);
    } finally {
      await handle.close();
    }
    await chmod(temporary, plan.mode || 0o644);
    // link is an atomic create-if-absent; rename would overwrite a file created
    // between preflight and publication.
    await link(temporary, plan.destination);
    created.push(plan.destination);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/**
 * Install the skill and role-agent TOMLs into a project.
 *
 * sourceRoot is injectable for tests and local callers; normal CLI use keeps
 * it pointed at this plugin's bundled skill directory.
 */
export async function setupProject({ projectDir, dryRun = false, sourceRoot = SOURCE_SKILL_ROOT, roleRoot = SOURCE_ROLE_ROOT } = {}) {
  if (!projectDir) fail("setup requires --project PROJECT");
  const project = resolve(projectDir);
  const source = resolve(sourceRoot);
  const rolesSource = resolve(roleRoot);
  if (!isAbsolute(projectDir)) fail("--project must be an absolute path.");
  if ((await pathKind(project)) !== "directory") fail(`Project directory does not exist: ${project}`);
  if ((await pathKind(source)) !== "directory") fail(`Bundled Deliver skill is missing: ${source}`);
  await assertNoSymlinkInPath(source);
  await assertNoSymlinkInPath(project);
  const destinationSkill = join(project, SKILL_INSTALL_RELATIVE);
  const destinationAgents = join(project, AGENTS_RELATIVE);
  // Never let a self-install place the destination inside the source tree. The
  // normal repository root remains safe because it is a parent of source.
  if (isPathInside(source, destinationSkill)) {
    fail("Refusing setup because the project destination is inside the bundled source tree.");
  }

  const sourceEntries = await readSourceTree(source);
  const roleEntries = await readRoleSources(rolesSource);
  const plans = [];
  for (const entry of sourceEntries) {
    const destination = join(destinationSkill, entry.relativePath);
    await preflightDestinationPath(destination, project);
    plans.push(await compareDestination(destination, entry.type === "file" ? entry.data : undefined, entry.type));
    if (entry.type === "file") plans.at(-1).mode = entry.mode;
  }
  await preflightDestinationPath(destinationSkill, project);
  for (const role of roleEntries) {
    const destination = join(destinationAgents, role.destinationName);
    await preflightDestinationPath(destination, project);
    const plan = await compareDestination(destination, role.data, "file");
    plan.mode = role.mode;
    plans.push(plan);
  }

  const toCreate = plans.filter((plan) => plan.action === "create");
  if (dryRun) {
    return {
      dryRun: true,
      created: toCreate.map((plan) => plan.destination),
      unchanged: plans.filter((plan) => plan.action === "unchanged").map((plan) => plan.destination),
    };
  }
  const created = [];
  try {
    for (const plan of toCreate) await (plan.type === "directory" ? ensureParentDirectories(plan.destination, created).then(() => mkdir(plan.destination).then(() => created.push(plan.destination))) : writeNewFile(plan, created));
  } catch (error) {
    // Existing files are never overwritten. Preserve partial new files rather
    // than deleting a path another process may have started using meanwhile.
    error.message += `\nSetup stopped after creating ${created.length} new paths. Existing files were preserved. Rerun setup to finish; it checks existing content before writing.`;
    error.createdPaths = created;
    throw error;
  }
  return {
    dryRun: false,
    created,
    unchanged: plans.filter((plan) => plan.action === "unchanged").map((plan) => plan.destination),
  };
}

export function buildLaunchArgs({
  projectDir,
  model = DEFAULT_MODEL,
  effort = DEFAULT_EFFORT,
  sandbox = DEFAULT_SANDBOX,
  prompt = [],
} = {}) {
  if (!projectDir) throw new Error("projectDir is required");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) throw new Error("Invalid model identifier");
  if (!["low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)) throw new Error("Invalid reasoning effort");
  if (!SANDBOX_MODES.has(sandbox)) throw new Error("Invalid sandbox mode");
  const promptParts = Array.isArray(prompt) ? prompt : [String(prompt)];
  const instruction = ["$deliver", ...promptParts].join(" ").trim();
  const approvalPolicy = sandbox === "danger-full-access" ? "never" : "on-request";
  return [
    "-C",
    resolve(projectDir),
    "--sandbox",
    sandbox,
    "--ask-for-approval",
    approvalPolicy,
    "-m",
    model,
    "-c",
    `model_reasoning_effort="${effort}"`,
    "-c",
    `agents.default_subagent_model="${DEFAULT_SUBAGENT_MODEL}"`,
    "-c",
    `agents.default_subagent_reasoning_effort="${DEFAULT_SUBAGENT_EFFORT}"`,
    instruction,
  ];
}

async function assertInstalled(project) {
  const installedSkill = join(project, SKILL_INSTALL_RELATIVE);
  await assertNoSymlinkInPath(installedSkill, { boundary: project });
  const kind = await pathKind(join(installedSkill, "SKILL.md"));
  if (kind !== "file") {
    fail(`Deliver is not installed in ${project}. Run: node ${THIS_FILE} setup --project ${project}`);
  }
}

function parseSetupArgs(argv) {
  let project;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project") {
      project = argv[++index];
      if (!project) fail("--project requires a value.");
    } else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--help" || arg === "-h") return { help: true };
    else fail(`Unknown setup option: ${arg}`);
  }
  return { project, dryRun };
}

function parseLaunchArgs(argv) {
  let project;
  let model = DEFAULT_MODEL;
  let effort = DEFAULT_EFFORT;
  let sandbox = DEFAULT_SANDBOX;
  let dryRun = false;
  const prompt = [];
  let promptMode = false;
  const seen = new Set();
  const markOnce = (option) => {
    if (seen.has(option)) fail(`Duplicate launch option: ${option}`);
    seen.add(option);
  };
  const optionValue = (option, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${option} requires a value.`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (promptMode) {
      prompt.push(arg);
    } else if (arg === "--") {
      promptMode = true;
    } else if (arg === "--project") {
      markOnce(arg);
      project = optionValue(arg, index++);
    } else if (arg === "--model") {
      markOnce(arg);
      model = optionValue(arg, index++);
    } else if (arg === "--effort") {
      markOnce(arg);
      effort = optionValue(arg, index++);
    } else if (arg === "--sandbox") {
      markOnce(arg);
      sandbox = optionValue(arg, index++);
    } else if (arg === "--dry-run") {
      markOnce(arg);
      dryRun = true;
    }
    else if (arg === "--help" || arg === "-h") return { help: true };
    else prompt.push(arg);
  }
  if (!project) fail("launch requires --project PROJECT");
  return { project, model, effort, sandbox, dryRun, prompt };
}

function printableCommand(args) {
  return ["codex", ...args].map((arg) => JSON.stringify(arg)).join(" ");
}

async function runCodex(project, args) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn("codex", args, { cwd: project, shell: false, stdio: "inherit" });
    child.once("error", (error) => rejectRun(new Error(`Unable to start Codex CLI: ${error.message}`)));
    child.once("close", (code, signal) => {
      if (signal) {
        const signalNumber = {
          SIGHUP: 1,
          SIGINT: 2,
          SIGQUIT: 3,
          SIGTERM: 15,
          SIGKILL: 9,
        }[signal] ?? 1;
        process.exitCode = 128 + signalNumber;
      } else if (code !== null) process.exitCode = code;
      resolveRun();
    });
  });
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv[0] === "setup") {
    const options = parseSetupArgs(argv.slice(1));
    if (options.help) {
      process.stdout.write(HELP);
      return 0;
    }
    const result = await setupProject({ ...options, projectDir: options.project });
    if (options.dryRun) process.stdout.write(`${result.created.map((path) => `would create ${path}`).join("\n")}${result.created.length ? "\n" : ""}`);
    else process.stdout.write(`Deliver setup complete in ${resolve(options.project)}. Created ${result.created.length} item(s).\n`);
    return 0;
  }
  const options = parseLaunchArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const project = resolve(options.project);
  if ((await pathKind(project)) !== "directory") fail(`Project directory does not exist: ${project}`);
  await assertInstalled(project);
  const args = buildLaunchArgs({ ...options, projectDir: project });
  if (options.dryRun) {
    process.stdout.write(`${printableCommand(args)}\n`);
    return 0;
  }
  await runCodex(project, args);
  return process.exitCode ?? 0;
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => resolve(process.argv[1])) === THIS_FILE) {
  main().catch((error) => {
    process.stderr.write(`deliver: ${error.message}\n`);
    process.exitCode = error.exitCode || 1;
  });
}
