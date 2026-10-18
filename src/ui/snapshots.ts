import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { ExDiffConfig, RepoInfo, SnapshotPaths } from '../core/types';
import { resolveSnapshotPaths } from '../core/snapshot';

/**
 * Enumerates the snapshot slots that currently exist on disk for `repo`.
 *
 * A slot exists when both the sidecar `<root>/<slot>.json` and the snapshot
 * directory `<root>/<slot>` are present. The default template keeps every slot
 * under one root; a template that contains `${slot}` gives every slot its own
 * root, so the sidecars are discovered with a bounded directory walk.
 */
export async function listSnapshotPaths(repo: RepoInfo, cfg: ExDiffConfig): Promise<SnapshotPaths[]> {
  const template = cfg.snapshotDirTemplate;
  const baseRoot = resolveSnapshotPaths(repo, 'base', template).root;
  const result: SnapshotPaths[] = [];
  const seen = new Set<string>();

  const add = async (slot: string): Promise<void> => {
    if (!slot) return;
    let paths: SnapshotPaths;
    try {
      paths = resolveSnapshotPaths(repo, slot, template);
    } catch {
      return;
    }
    const key = normalize(paths.dir);
    if (seen.has(key)) return;
    if (!(await isDirectory(paths.dir))) return;
    seen.add(key);
    result.push(paths);
  };

  const start = template.includes('${slot}')
    ? commonDirectory(baseRoot, resolveSnapshotPaths(repo, '__exdiff_probe__', template).root)
    : baseRoot;
  await scanSidecars(start, 0, add);
  return result;
}

/** Deepest directory shared by two absolute paths (used to find the slot container). */
function commonDirectory(a: string, b: string): string {
  const aParts = path.resolve(a).split(path.sep);
  const bParts = path.resolve(b).split(path.sep);
  const common: string[] = [];
  const length = Math.min(aParts.length, bParts.length);
  for (let index = 0; index < length; index += 1) {
    const left = aParts[index];
    const right = bParts[index];
    if (process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right) {
      common.push(left);
    } else {
      break;
    }
  }
  if (common.length === 0) return path.parse(path.resolve(a)).root;
  return common.join(path.sep);
}

/** Reads a directory, returning `[]` for missing/unreadable directories. */
export async function readdirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

export function normalize(candidate: string): string {
  const resolved = path.resolve(candidate);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** `true` when `candidate` is `root` itself or lives below it. */
export function isSameOrInside(root: string, candidate: string): boolean {
  const normalizedRoot = normalize(root);
  const normalizedCandidate = normalize(candidate);
  if (normalizedCandidate === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
  return normalizedCandidate.startsWith(prefix);
}

/**
 * Walks `dir` looking for `<name>.json` sidecars that sit next to a `<name>`
 * directory. Such directories are snapshot roots and are not descended into,
 * which keeps the walk away from the (potentially huge) checkouts.
 */
async function scanSidecars(
  dir: string,
  depth: number,
  add: (slot: string) => Promise<void>,
): Promise<void> {
  if (depth > 4) return;

  const entries = await readdirSafe(dir);
  const directories = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  const slotDirectories = new Set<string>();

  for (const entry of entries) {
    if (!entry.isFile() || entry.name.endsWith('.tmp') || !entry.name.endsWith('.json')) continue;
    const slot = entry.name.slice(0, -'.json'.length);
    if (!slot || !directories.has(slot)) continue;
    slotDirectories.add(slot);
    await add(slot);
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || slotDirectories.has(entry.name)) continue;
    await scanSidecars(path.join(dir, entry.name), depth + 1, add);
  }
}
