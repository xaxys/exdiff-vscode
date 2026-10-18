import * as vscode from 'vscode';

import type { ExDiffConfig, RepoInfo, SnapshotPaths } from '../core/types';
import { emptySidePath } from '../core/paths';
import { ensureSnapshot, resolveSnapshotPaths } from '../core/snapshot';
import { withExProgress } from './progress';
import { fileExists, resolveInside } from './repo';
import { ensureAttached } from './workspaceFolders';

/**
 * One side of a diff.
 *
 * - `snapshot`: a materialized checkout of `sha` in the slot directory.
 * - `worktree`: the file as it is on disk right now.
 */
export type Side =
  | { kind: 'snapshot'; slot: string; sha: string; label: string }
  | { kind: 'worktree'; label: string };

/** A comparison between two sides of a repository (used by the Changes view). */
export interface Comparison {
  repo: RepoInfo;
  left: Side;
  right: Side;
  leftLabel: string;
  rightLabel: string;
}

export interface OpenDiffOptions {
  left: Side;
  right: Side;
  /** Path of the file on the right side. */
  relPath: string;
  /** Path of the file on the left side (defaults to `relPath`, set for renames). */
  oldRelPath?: string;
  title: string;
}

/** `<basename> (<leftLabel> ↔ <rightLabel>)`, e.g. `git.ts (HEAD~1 ↔ Working Tree)`. */
export function diffTitle(relPath: string, leftLabel: string, rightLabel: string): string {
  const segments = relPath.split('/');
  const name = segments[segments.length - 1] || relPath;
  return `${name} (${leftLabel} ↔ ${rightLabel})`;
}

/**
 * Opens `vscode.diff` with both sides backed by real files.
 *
 * Snapshot sides are materialized (progress notification) and, when the file
 * does not exist in that revision (added/removed files), replaced by an empty
 * placeholder inside the snapshot root. The snapshot folders are attached to
 * the workspace *after* the diff is visible: converting a single-folder
 * workspace into a multi-root one can restart the extension host, and the
 * opened diff tab survives that.
 */
export async function openFileDiff(
  repo: RepoInfo,
  cfg: ExDiffConfig,
  context: vscode.ExtensionContext,
  options: OpenDiffOptions,
): Promise<void> {
  if (!options.relPath) {
    throw new Error(vscode.l10n.t('Cannot determine the path of the file relative to the repository'));
  }

  const leftRelPath = options.oldRelPath ?? options.relPath;
  const left = await resolveSide(repo, cfg, options.left, leftRelPath);
  const right = await resolveSide(repo, cfg, options.right, options.relPath);

  await vscode.commands.executeCommand('vscode.diff', left.uri, right.uri, options.title, {
    preview: true,
  });

  // Attaching before the diff opens is not required for the diff itself, and
  // doing it afterwards survives the possible extension-host restart.
  const attached = new Set<string>();
  for (const paths of [left.snapshot, right.snapshot]) {
    if (!paths || attached.has(paths.dir)) continue;
    attached.add(paths.dir);
    await ensureAttached(context, repo, paths, cfg);
  }
}

/** Opens the diff described by a Changes-view comparison for one file. */
export async function openPathDiff(
  repo: RepoInfo,
  cfg: ExDiffConfig,
  context: vscode.ExtensionContext,
  comparison: Comparison,
  oldRelPath: string,
  newRelPath: string,
): Promise<void> {
  await openFileDiff(repo, cfg, context, {
    left: comparison.left,
    right: comparison.right,
    relPath: newRelPath,
    oldRelPath,
    title: diffTitle(newRelPath, comparison.leftLabel, comparison.rightLabel),
  });
}

interface ResolvedSide {
  uri: vscode.Uri;
  /** Set for snapshot sides; used to attach the folder after the diff opened. */
  snapshot?: SnapshotPaths;
}

async function resolveSide(
  repo: RepoInfo,
  cfg: ExDiffConfig,
  side: Side,
  relPath: string,
): Promise<ResolvedSide> {
  if (side.kind === 'worktree') {
    const absolute = resolveInside(repo.root, relPath);
    const emptyBase = resolveSnapshotPaths(repo, 'base', cfg.snapshotDirTemplate).root;
    return { uri: vscode.Uri.file(await existingOrEmpty(emptyBase, absolute, relPath)) };
  }

  const paths = await withExProgress(
    vscode.l10n.t('Preparing snapshot "{0}" ({1})…', side.slot, side.label),
    async (report) => await ensureSnapshot(repo, side.slot, side.sha, cfg, { onProgress: report }),
  );

  const absolute = resolveInside(paths.dir, relPath);
  return {
    uri: vscode.Uri.file(await existingOrEmpty(paths.root, absolute, relPath)),
    snapshot: paths,
  };
}

async function existingOrEmpty(
  emptyBase: string,
  absolute: string,
  relPath: string,
): Promise<string> {
  if (await fileExists(absolute)) return absolute;
  return await emptySidePath(emptyBase, relPath);
}
