import * as path from 'node:path';

import type { ExDiffConfig, RepoInfo, SnapshotPaths } from '../core/types';
import { readSnapshotMeta, removeSnapshot, selectStaleSnapshots } from '../core/snapshot';
import { detachSnapshotDirs } from './workspaceFolders';
import { listSnapshotPaths } from './snapshots';

/** A snapshot slot on disk together with its sidecar timestamp. */
export interface StaleSnapshot {
  paths: SnapshotPaths;
  slot: string;
  syncedAt: number;
}

export interface PruneResult {
  removed: number;
  slots: string[];
}

/**
 * Finds snapshot slots older than `exdiff.snapshotRetentionDays`.
 *
 * `onlyAdHoc` restricts the result to `ref-*` slots (the automatic startup
 * cleanup). Returns `[]` when retention is 0/disabled.
 */
export async function findStaleSnapshots(
  repo: RepoInfo,
  cfg: ExDiffConfig,
  options: { onlyAdHoc?: boolean; now?: number } = {},
): Promise<StaleSnapshot[]> {
  const retention = cfg.snapshotRetentionDays;
  if (!Number.isFinite(retention) || retention <= 0) return [];

  const entries: StaleSnapshot[] = [];
  for (const paths of await listSnapshotPaths(repo, cfg)) {
    const meta = await readSnapshotMeta(paths);
    if (!meta) continue;
    entries.push({ paths, slot: path.basename(paths.dir), syncedAt: meta.syncedAt });
  }

  const stale = new Set(
    selectStaleSnapshots(entries, retention, options.now ?? Date.now(), options.onlyAdHoc ?? false),
  );
  return entries.filter((entry) => stale.has(entry.slot));
}

/** Detaches stale snapshot folders and deletes them from disk. */
export async function pruneStaleSnapshots(
  repo: RepoInfo,
  cfg: ExDiffConfig,
  options: { onlyAdHoc?: boolean; now?: number } = {},
): Promise<PruneResult> {
  const stale = await findStaleSnapshots(repo, cfg, options);
  if (stale.length === 0) return { removed: 0, slots: [] };

  await detachSnapshotDirs(stale.map((entry) => entry.paths.dir));
  for (const entry of stale) {
    await removeSnapshot(entry.paths);
  }

  return { removed: stale.length, slots: stale.map((entry) => entry.slot) };
}
