import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { ExDiffConfig, RepoInfo, SnapshotMeta, SnapshotPaths } from './types';
import { changedFiles, git } from './git';
import { expandTemplate, isPathInside, relativeInside, toPosix } from './paths';
import { DEFAULT_CONFIG } from './settings';

/** One serialization chain per snapshot directory (`checkout-index` must not race). */
const slotLocks = new Map<string, Promise<unknown>>();

/** Keep well below the Windows 32k command line limit. */
const CHECKOUT_BATCH_MAX_PATHS = 200;
const CHECKOUT_BATCH_MAX_CHARS = 8000;

/** Progress callback shape used by {@link ensureSnapshot}. */
type SnapshotProgress = (message: string) => void;

/**
 * Computes where a slot lives:
 *
 * - `root` = expanded `cfg.snapshotDir` template (default `${repoRoot}/.exdiff`)
 * - `dir`  = `<root>/<slot>` (the actual snapshot work tree)
 * - `meta` = `<root>/<slot>.json` (sidecar with the synced SHA, outside `dir`)
 *
 * `slot` must already be a plain directory name (use `sanitizeSlotName` for
 * arbitrary refs); separators, `.`/`..` and drive letters are rejected.
 */
export function resolveSnapshotPaths(repo: RepoInfo, slot: string, template: string): SnapshotPaths {
  const safeSlot = normalizeSlot(slot);
  const repoParent = path.dirname(repo.root);
  const repoName = path.basename(repo.root);
  const rawTemplate = template && template.trim().length > 0 ? template : DEFAULT_CONFIG.snapshotDirTemplate;
  const expanded = expandTemplate(rawTemplate, {
    repoParent,
    repoName,
    repoRoot: repo.root,
    slot: safeSlot,
  });

  // User supplied templates may be relative; resolve them against the
  // repository root instead of the (arbitrary) process working directory.
  const root = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(repo.root, expanded);

  return {
    root,
    dir: path.join(root, safeSlot),
    meta: path.join(root, `${safeSlot}.json`),
  };
}

/**
 * Makes sure `<snapshotRoot>/<slot>` contains a real checkout of `sha`.
 *
 * - Same SHA as the sidecar and the directory still exists: no-op.
 * - Otherwise an incremental update (`git diff` + `checkout-index` of the
 *   changed paths, deletions removed from disk) is attempted first and a full
 *   materialization is used as fallback.
 * - `opts.force` always does a full rebuild (the directory is recreated).
 *
 * Calls for the same slot are serialized through a per-directory promise lock.
 */
export async function ensureSnapshot(
  repo: RepoInfo,
  slot: string,
  sha: string,
  cfg: ExDiffConfig,
  opts?: { force?: boolean; onProgress?: SnapshotProgress },
): Promise<SnapshotPaths> {
  const paths = resolveSnapshotPaths(repo, slot, cfg.snapshotDirTemplate);
  const targetSha = sha.trim();
  if (!targetSha) throw new Error('ensureSnapshot() requires a commit or tree SHA');

  const progress = (message: string): void => {
    try {
      opts?.onProgress?.(message);
    } catch {
      // A broken progress callback must never abort a sync.
    }
  };

  return await withSlotLock(paths.dir, async () => {
    const meta = await readSnapshotMeta(paths);
    const dirExists = await pathExists(paths.dir);

    if (!opts?.force && meta && meta.sha === targetSha && dirExists) {
      return paths;
    }

    if (!opts?.force && meta && dirExists) {
      progress(`ExDiff: updating snapshot "${slot}" (${shortSha(meta.sha)} → ${shortSha(targetSha)})`);
      try {
        await syncIncremental(repo, paths, meta.sha, targetSha, cfg, progress);
        await writeSnapshotMeta(paths, slot, targetSha);
        return paths;
      } catch (error) {
        progress(
          `ExDiff: incremental update of "${slot}" failed (${errorMessage(error)}); rebuilding from scratch`,
        );
      }
    }

    progress(`ExDiff: materializing snapshot "${slot}" at ${shortSha(targetSha)}`);
    await materializeFull(repo, paths, targetSha, cfg, progress);
    await writeSnapshotMeta(paths, slot, targetSha);
    return paths;
  });
}

/** Reads `<snapshotRoot>/<slot>.json`. Returns `null` when missing or malformed. */
export async function readSnapshotMeta(paths: SnapshotPaths): Promise<SnapshotMeta | null> {
  let raw: string;
  try {
    raw = await fs.readFile(paths.meta, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const record = parsed as Record<string, unknown>;
  const sha = typeof record.sha === 'string' ? record.sha.trim() : '';
  if (!sha) return null;

  return {
    slot: typeof record.slot === 'string' ? record.slot : '',
    sha,
    syncedAt: typeof record.syncedAt === 'number' && Number.isFinite(record.syncedAt) ? record.syncedAt : 0,
  };
}

/** A slot and the time its sidecar was last written. */
export interface SnapshotAgeEntry {
  slot: string;
  syncedAt: number;
}

/** Ad-hoc snapshots created by "Compare Two Refs…" (unbounded in count). */
export function isAdHocSlot(slot: string): boolean {
  return slot.startsWith('ref-');
}

/**
 * Slots whose sidecar is older than `retentionDays`.
 *
 * `retentionDays <= 0` disables pruning. `onlyAdHoc` restricts the result to
 * `ref-*` slots, which is what the automatic startup cleanup uses; the fixed
 * slots (`base`, `head`, `index`, `amend`, `prev`) are only pruned by the
 * explicit command.
 */
export function selectStaleSnapshots(
  entries: SnapshotAgeEntry[],
  retentionDays: number,
  now: number = Date.now(),
  onlyAdHoc = false,
): string[] {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return [];
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;

  return entries
    .filter((entry) => entry.syncedAt > 0 && entry.syncedAt < cutoff)
    .filter((entry) => !onlyAdHoc || isAdHocSlot(entry.slot))
    .map((entry) => entry.slot);
}

/** Deletes `dir` recursively and the sidecar. Also drops `root` when it became empty. */
export async function removeSnapshot(paths: SnapshotPaths): Promise<void> {
  await withSlotLock(paths.dir, async () => {
    await fs.rm(paths.dir, { recursive: true, force: true });
    await fs.rm(paths.meta, { force: true });
    await pruneRootIfEmpty(paths.root);
  });
}

/**
 * Removes the snapshot root when no slot is left.
 *
 * The root lives inside the repository by default and contains ExDiff's own
 * `.gitignore`, `.tmp` and `empty` entries. Anything else (another sidecar, a
 * slot directory, a user file) means the root is still in use.
 */
async function pruneRootIfEmpty(root: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return;
  }

  const own = new Set(['.gitignore', '.tmp', 'empty']);
  if (entries.some((entry) => !own.has(entry))) return;

  for (const name of ['.tmp', 'empty', '.gitignore']) {
    await fs.rm(path.join(root, name), { recursive: true, force: true });
  }
  try {
    await fs.rmdir(root);
  } catch {
    // Another process may still be using it.
  }
}

async function materializeFull(
  repo: RepoInfo,
  paths: SnapshotPaths,
  sha: string,
  cfg: ExDiffConfig,
  progress: SnapshotProgress,
): Promise<void> {
  await ensureSnapshotRoot(paths.root);
  const indexFile = await createTempIndexPath(paths.root);
  try {
    const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: indexFile };
    // Populate the throw-away index first: if `sha` is bad, the old snapshot survives.
    await git(['read-tree', sha], { cwd: repo.root, gitPath: cfg.gitPath, env });

    await fs.rm(paths.dir, { recursive: true, force: true });
    await fs.mkdir(paths.dir, { recursive: true });

    progress(`ExDiff: checking out ${shortSha(sha)} into ${paths.dir}`);
    await git(['checkout-index', '-a', '-f'], {
      cwd: repo.root,
      gitPath: cfg.gitPath,
      env: { ...env, GIT_WORK_TREE: paths.dir },
    });
  } finally {
    await fs.rm(indexFile, { force: true });
  }
}

async function syncIncremental(
  repo: RepoInfo,
  paths: SnapshotPaths,
  fromSha: string,
  toSha: string,
  cfg: ExDiffConfig,
  progress: SnapshotProgress,
): Promise<void> {
  const changes = await changedFiles(repo, fromSha, toSha, cfg.gitPath);
  if (changes.length === 0) return;

  await ensureSnapshotRoot(paths.root);

  const toDelete: string[] = [];
  const toCheckout: string[] = [];

  for (const change of changes) {
    switch (change.status) {
      case 'D':
        toDelete.push(change.newPath);
        break;
      case 'R':
        if (change.oldPath) toDelete.push(change.oldPath);
        toCheckout.push(change.newPath);
        break;
      default:
        // A / M / C / T / U / X / B — the previously known path (if any) stays.
        toCheckout.push(change.newPath);
        break;
    }
  }

  for (const relPath of toDelete) {
    await removeFileAndPrune(paths.dir, relPath);
  }
  if (toCheckout.length === 0) return;

  const indexFile = await createTempIndexPath(paths.root);
  try {
    const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: indexFile, GIT_WORK_TREE: paths.dir };
    await git(['read-tree', toSha], { cwd: repo.root, gitPath: cfg.gitPath, env });

    progress(`ExDiff: updating ${toCheckout.length} file(s) in ${paths.dir}`);
    await checkoutPaths(repo, paths.dir, toCheckout, env, cfg.gitPath);
  } finally {
    await fs.rm(indexFile, { force: true });
  }
}

async function checkoutPaths(
  repo: RepoInfo,
  snapshotDir: string,
  relPaths: string[],
  env: NodeJS.ProcessEnv,
  gitPath: string | undefined,
): Promise<void> {
  const verified: string[] = [];
  const seen = new Set<string>();
  for (const relPath of relPaths) {
    const safe = assertInsideSnapshot(snapshotDir, relPath);
    if (seen.has(safe)) continue;
    seen.add(safe);
    verified.push(safe);
  }
  if (verified.length === 0) return;

  // checkout-index creates leading directories itself, but doing it up front keeps
  // failures (permissions, length limits) out of the git batches.
  const directories = new Set(verified.map((relPath) => path.dirname(path.resolve(snapshotDir, relPath))));
  for (const directory of directories) {
    await fs.mkdir(directory, { recursive: true });
  }

  for (const batch of chunkPaths(verified)) {
    // `-f` must come before `--`; paths are posix and relative to the repo root.
    await git(['checkout-index', '-f', '--', ...batch], { cwd: repo.root, gitPath, env });
  }
}

async function removeFileAndPrune(snapshotDir: string, relPath: string): Promise<void> {
  const safe = assertInsideSnapshot(snapshotDir, relPath);
  const absolute = path.resolve(snapshotDir, safe);
  await fs.rm(absolute, { recursive: true, force: true });

  const root = path.resolve(snapshotDir);
  let directory = path.dirname(absolute);
  while (directory !== root && isPathInside(root, directory)) {
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch {
      break;
    }
    if (entries.length > 0) break;
    try {
      await fs.rmdir(directory);
    } catch {
      break;
    }
    directory = path.dirname(directory);
  }
}

function normalizeSlot(slot: string): string {
  const trimmed = slot.trim();
  if (
    !trimmed ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('\0') ||
    /[\\/]/.test(trimmed) ||
    /^[A-Za-z]:/.test(trimmed)
  ) {
    throw new Error(`Invalid snapshot slot name: ${JSON.stringify(slot)}`);
  }
  return trimmed;
}

/**
 * Validates a path that came out of git and returns it as a posix path relative
 * to the snapshot directory. Rejects absolute paths, drive letters and `..`.
 */
function assertInsideSnapshot(snapshotDir: string, relPath: string): string {
  const posix = toPosix(relPath).replace(/^\.\/+/, '');
  const absolute = path.resolve(snapshotDir, posix);
  const inside = relativeInside(snapshotDir, absolute);

  if (
    !posix ||
    posix.startsWith('/') ||
    posix.includes('\0') ||
    /^[A-Za-z]:/.test(posix) ||
    inside === null ||
    inside === ''
  ) {
    throw new Error(`Refusing to touch a path outside the snapshot directory: ${JSON.stringify(relPath)}`);
  }
  // `inside` is the normalised, posix-separated path with the original case,
  // which is what `git checkout-index` expects.
  return inside;
}

function chunkPaths(relPaths: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentLength = 0;

  for (const relPath of relPaths) {
    const cost = relPath.length + 1;
    if (current.length >= CHECKOUT_BATCH_MAX_PATHS || (current.length > 0 && currentLength + cost > CHECKOUT_BATCH_MAX_CHARS)) {
      batches.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(relPath);
    currentLength += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Makes sure the snapshot root exists and stays invisible to `git status`.
 *
 * The root lives inside the repository by default, so a `.gitignore`
 * containing `*` is written there. Git then ignores the snapshots, the
 * sidecars, `.tmp` and `empty` without touching the repository's own
 * `.gitignore`.
 */
async function ensureSnapshotRoot(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const ignoreFile = path.join(root, '.gitignore');
  try {
    await fs.writeFile(ignoreFile, '# ExDiff snapshots\n*\n', { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/** The throw-away index lives inside the snapshot root, not in the system temp dir. */
async function createTempIndexPath(root: string): Promise<string> {
  const directory = path.join(root, '.tmp');
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(
    directory,
    `index-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  );
  await fs.rm(file, { force: true });
  return file;
}

async function writeSnapshotMeta(paths: SnapshotPaths, slot: string, sha: string): Promise<void> {
  const meta: SnapshotMeta = { slot, sha, syncedAt: Date.now() };
  await fs.mkdir(path.dirname(paths.meta), { recursive: true });

  const temp = `${paths.meta}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  try {
    await fs.rename(temp, paths.meta);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.stat(candidate);
    return true;
  } catch {
    return false;
  }
}

function withSlotLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = slotLocks.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  slotLocks.set(key, tail);
  void tail.then(() => {
    if (slotLocks.get(key) === tail) slotLocks.delete(key);
  });
  return run;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
