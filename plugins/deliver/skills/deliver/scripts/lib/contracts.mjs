import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DeliverError, sha256 } from './state.mjs';

const checker = fileURLToPath(new URL('../specdd.mjs', import.meta.url));
const covers = (scope, target) => scope === '.' || target === scope || target.startsWith(`${scope}/`);

// Freeze explicit spec authority before the builder starts. The semantic
// meaning of Must/Done when remains a review and verification responsibility.
export function captureContracts(root, packet) {
  if (!packet.specs.length) return null;
  const specs = [...new Set(packet.specs)];
  for (const spec of specs) {
    if (!spec.endsWith('.sdd')) throw new DeliverError(`not a SpecDD contract: ${spec}`, 66);
  }
  const required = new Set();
  for (const rootSpec of [`${path.basename(root)}.sdd`, 'root.sdd']) {
    if (fs.existsSync(path.join(root, rootSpec))) required.add(rootSpec);
  }
  function directoryContracts(rel) {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === '.deliver') continue;
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) directoryContracts(child);
      else if (entry.name.endsWith('.sdd')) required.add(child);
    }
  }
  for (const target of [...packet.touches, ...specs]) {
    const isDirectory = fs.existsSync(path.join(root, target)) && fs.lstatSync(path.join(root, target)).isDirectory();
    if (isDirectory) directoryContracts(target);
    let dir = isDirectory ? target : path.posix.dirname(target);
    while (dir !== '.') {
      for (const candidate of [`${dir}/${path.posix.basename(dir)}.sdd`, `${dir}.sdd`]) {
        if (fs.existsSync(path.join(root, candidate))) required.add(candidate);
      }
      dir = path.posix.dirname(dir);
    }
  }
  for (const spec of required) {
    if (!specs.includes(spec)) throw new DeliverError(`task specs omit governing contract: ${spec}`, 66);
  }
  const result = spawnSync(process.execPath, [checker, 'inspect', '--root', root,
    ...specs.flatMap((spec) => ['--spec', spec])], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 15000 });
  let report;
  try { report = JSON.parse(result.stdout); } catch { throw new DeliverError('SpecDD checker did not return a valid report', 66); }
  if (result.status !== 0 || !report.ok) throw new DeliverError('SpecDD contracts failed inspection', 66, report.findings);
  const editable = [...new Set(report.editablePaths)];
  for (const touch of packet.touches) {
    if (touch.endsWith('.sdd') || touch === '.specdd' || touch.startsWith('.specdd/')) {
      throw new DeliverError('contract changes require a separate approved contract phase before this code task', 66);
    }
    if (!editable.some((scope) => covers(scope, touch))) {
      throw new DeliverError(`task touch is outside explicit SpecDD authority: ${touch}`, 66);
    }
  }
  const hashes = {};
  for (const rel of [...specs, '.specdd/bootstrap.md', '.specdd/bootstrap.project.md', '.specdd/bootstrap.local.md']) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    const real = fs.realpathSync(file);
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) throw new DeliverError(`contract escapes project: ${rel}`, 66);
    if (!fs.statSync(real).isFile()) throw new DeliverError(`contract is not a regular file: ${rel}`, 66);
    hashes[rel] = sha256(fs.readFileSync(real));
  }
  return { dialect: 'specdd-literal-paths-2026-09-05', specs, editable_paths: editable, hashes };
}

export function changedContracts(state) {
  if (!state.contracts) return [];
  return Object.entries(state.contracts.hashes).flatMap(([rel, hash]) => {
    try {
      const real = fs.realpathSync(path.join(state.project_root, rel));
      if (!real.startsWith(`${state.project_root}${path.sep}`)) return [rel];
      return sha256(fs.readFileSync(real)) === hash ? [] : [rel];
    } catch { return [rel]; }
  });
}
