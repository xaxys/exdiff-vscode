import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

import type { ExDiffConfig, RepoInfo, SnapshotPaths } from '../core/types';
import { resolveRepo } from '../core/git';
import { relativeInside } from '../core/paths';
import { resolveSnapshotPaths } from '../core/snapshot';
import { listSnapshotPaths, normalize } from './snapshots';

/** A worktree file plus the repository that contains it. */
export interface FileTarget {
  repo: RepoInfo;
  /** Repository-relative, posix separators. Never empty. */
  relPath: string;
}

/** Joins a repository-relative posix path onto a native absolute directory. */
export function resolveInside(base: string, relPath: string): string {
  const segments = relPath.split('/').filter((segment) => segment.length > 0);
  return segments.length > 0 ? path.join(base, ...segments) : base;
}

/** Repository-relative posix path for `absolute`, or `null` when it is outside. */
export function relativePath(repo: RepoInfo, absolute: string): string | null {
  const relative = relativeInside(repo.root, absolute);
  return relative && relative.length > 0 ? relative : null;
}

export async function fileExists(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/** URI of the active editor when it is a real file, otherwise `undefined`. */
export function activeFileUri(): vscode.Uri | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri && uri.scheme === 'file' ? uri : undefined;
}

/** Every distinct repository reachable through the current workspace folders. */
export async function workspaceRepos(cfg: ExDiffConfig): Promise<RepoInfo[]> {
  const result: RepoInfo[] = [];
  const seen = new Set<string>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') continue;
    const repo = await resolveRepo(folder.uri.fsPath, cfg.gitPath);
    if (!repo) continue;
    const key = normalize(repo.root);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(repo);
  }
  return result;
}

/**
 * Repository used by the views when no file is passed: the active editor's
 * repository first, then the first workspace folder that is a repository.
 */
export async function resolveActiveRepo(cfg: ExDiffConfig): Promise<RepoInfo | null> {
  const active = activeFileUri();
  if (active) {
    const repo = await resolveRepo(path.dirname(active.fsPath), cfg.gitPath);
    if (repo) return repo;
  }
  const repos = await workspaceRepos(cfg);
  return repos[0] ?? null;
}

/**
 * Resolves a URI to `{ repo, relPath }`.
 *
 * Snapshots live inside the repository by default, so files below the
 * snapshot root are mapped back to their repository-relative path *before*
 * they are treated as ordinary worktree files. Empty placeholders
 * (`<root>/empty/<relPath>`) are handled by the same rule.
 *
 * Custom templates may place snapshots outside the repository; those are
 * resolved through the snapshot sidecars.
 */
export async function resolveTarget(
  uri: vscode.Uri,
  cfg: ExDiffConfig,
): Promise<FileTarget | null> {
  if (uri.scheme !== 'file') return null;

  const direct = await resolveRepo(path.dirname(uri.fsPath), cfg.gitPath);
  if (direct) {
    const root = resolveSnapshotPaths(direct, 'base', cfg.snapshotDirTemplate).root;
    const withinRoot = relativeInside(root, uri.fsPath);
    if (withinRoot) {
      const segments = withinRoot.split('/');
      return segments.length >= 2 ? { repo: direct, relPath: segments.slice(1).join('/') } : null;
    }

    const relPath = relativePath(direct, uri.fsPath);
    if (relPath) return { repo: direct, relPath };
  }

  const repos = await workspaceRepos(cfg);
  for (const repo of repos) {
    let snapshotPaths: SnapshotPaths[];
    try {
      snapshotPaths = await listSnapshotPaths(repo, cfg);
    } catch {
      continue;
    }
    for (const paths of snapshotPaths) {
      const relPath = relativeInside(paths.dir, uri.fsPath);
      if (relPath) return { repo, relPath };
    }
    // Templates without ${slot} keep every slot directly under one root; this
    // also covers slots whose directory is not discoverable (e.g. no sidecar).
    const root = resolveSnapshotPaths(repo, 'base', cfg.snapshotDirTemplate).root;
    const rootRelative = relativeInside(root, uri.fsPath);
    if (rootRelative) {
      const segments = rootRelative.split('/');
      if (segments.length >= 2) return { repo, relPath: segments.slice(1).join('/') };
    }
  }

  return null;
}
