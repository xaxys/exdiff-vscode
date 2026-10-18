import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

import type { ExDiffConfig, RepoInfo, SnapshotPaths } from '../core/types';
import { removeSnapshot, resolveSnapshotPaths } from '../core/snapshot';
import { errorMessage, warn } from './errors';
import { isDirectory, isSameOrInside, listSnapshotPaths, normalize, readdirSafe } from './snapshots';

/** Persisted answer to the "add snapshot folders to the workspace?" question. */
export const ATTACH_CONSENT_KEY = 'exdiff.attachConsent';

type Consent = 'yes' | 'no' | 'never';

/** One in-flight attach per snapshot directory, so two sides never double-prompt. */
const pendingAttach = new Map<string, Promise<boolean>>();

/** Roots declined for this window; otherwise every file open would re-prompt. */
const declinedThisSession = new Set<string>();

/**
 * Workspace-folder edits are serialized: VS Code rejects overlapping
 * `updateWorkspaceFolders` calls, and the extension host's folder list can lag
 * one tick behind the promise.
 */
let folderUpdateQueue: Promise<unknown> = Promise.resolve();

/** `<repoName> [<slot>]`, e.g. `my-repo [base]`. */
export function snapshotFolderName(repo: RepoInfo, paths: SnapshotPaths): string {
  return `${path.basename(repo.root)} [${path.basename(paths.dir)}]`;
}

/** `true` when the snapshot directory is already one of the workspace folders. */
export function isAttached(dir: string): boolean {
  const target = normalize(dir);
  return (vscode.workspace.workspaceFolders ?? []).some(
    (folder) => folder.uri.scheme === 'file' && normalize(folder.uri.fsPath) === target,
  );
}

/**
 * Makes sure the snapshot directory is a workspace folder.
 *
 * Resolution order:
 * 1. `exdiff.autoAttach === 'never'` (or a persisted "never") → do nothing.
 * 2. Already attached → done.
 * 3. `autoAttach === 'always'` or a persisted "yes" → attach silently.
 * 4. Ask once, persist the answer (`yes` / `no` / `never`).
 *
 * Returns `true` when the folder is (now) part of the workspace.
 */
export function ensureAttached(
  context: vscode.ExtensionContext,
  repo: RepoInfo,
  paths: SnapshotPaths,
  cfg: ExDiffConfig,
): Promise<boolean> {
  const key = normalize(paths.dir);
  const running = pendingAttach.get(key);
  if (running) return running;

  const task = ensureAttachedInner(context, repo, paths, cfg).finally(() => {
    pendingAttach.delete(key);
  });
  pendingAttach.set(key, task);
  return task;
}

/** Attaches every snapshot of `repo` that has a sidecar, skipping existing folders. */
export async function attachSnapshots(
  repo: RepoInfo,
  cfg: ExDiffConfig,
  options: { quiet?: boolean } = {},
): Promise<number> {
  const entries: { uri: vscode.Uri; name: string }[] = [];
  for (const paths of await listSnapshotPaths(repo, cfg)) {
    if (isAttached(paths.dir)) continue;
    entries.push({ uri: vscode.Uri.file(paths.dir), name: snapshotFolderName(repo, paths) });
  }
  if (entries.length === 0) return 0;

  try {
    await addWorkspaceFolders(entries);
    return entries.length;
  } catch (error) {
    if (!options.quiet) {
      await warn(
        vscode.l10n.t('ExDiff: Cannot attach the snapshot folders: {0}', errorMessage(error)),
      );
    }
    return 0;
  }
}

/** Removes every workspace folder that belongs to this repository's snapshots. */
export async function detachSnapshots(repo: RepoInfo, cfg: ExDiffConfig): Promise<number> {
  const template = cfg.snapshotDirTemplate;
  // A fixed root is private to the repo, so anything below it is ours. With a
  // `${slot}` template only exact known snapshot directories are removed —
  // never a parent directory that might contain the user's real workspace.
  const fixedRoots = template.includes('${slot}')
    ? []
    : [resolveSnapshotPaths(repo, 'base', template).root];
  const known = new Set((await listSnapshotPaths(repo, cfg)).map((paths) => normalize(paths.dir)));

  return await removeFolders(
    (folder) =>
      folder.uri.scheme === 'file' &&
      (known.has(normalize(folder.uri.fsPath)) ||
        fixedRoots.some((root) => isSameOrInside(root, folder.uri.fsPath))),
  );
}

/** Removes the given snapshot directories from the workspace (disk untouched). */
export async function detachSnapshotDirs(dirs: string[]): Promise<number> {
  const wanted = new Set(dirs.map(normalize));
  if (wanted.size === 0) return 0;

  return await removeFolders(
    (folder) => folder.uri.scheme === 'file' && wanted.has(normalize(folder.uri.fsPath)),
  );
}

async function removeFolders(shouldRemove: (folder: vscode.WorkspaceFolder) => boolean): Promise<number> {
  // Recompute the index on every iteration: `updateWorkspaceFolders` is
  // asynchronous and the folder list (and therefore every index) can lag.
  let removed = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const index = folders.findIndex(shouldRemove);
    if (index === -1) break;

    const target = folders[index].uri.fsPath;
    try {
      // `applyWorkspaceFolders` waits for onDidChangeWorkspaceFolders, which
      // VS Code requires before it accepts another folder edit.
      const ok = await withFolderUpdateLock(async () => await applyWorkspaceFolders(index, 1, []));
      if (!ok) {
        await warn(
          vscode.l10n.t(
            'ExDiff: Cannot remove the snapshot folder from the workspace (VS Code rejected the workspace update)',
          ),
        );
        break;
      }
      if ((await waitUntilDetached(target, 5000)) || (await waitUntilDetached(target, 2000))) {
        removed += 1;
      } else {
        break;
      }
    } catch (error) {
      await warn(
        vscode.l10n.t('ExDiff: Cannot remove the snapshot folder from the workspace: {0}', errorMessage(error)),
      );
      break;
    }
  }
  return removed;
}

/** Detaches the snapshots, then deletes every slot directory and sidecar. */
export async function cleanSnapshots(
  repo: RepoInfo,
  cfg: ExDiffConfig,
): Promise<{ detached: number; removed: number }> {
  const detached = await detachSnapshots(repo, cfg);

  let removed = 0;
  for (const paths of await listSnapshotPaths(repo, cfg)) {
    await removeSnapshot(paths);
    removed += 1;
  }

  const root = resolveSnapshotPaths(repo, 'base', cfg.snapshotDirTemplate).root;
  await removeOrphanArtifacts(root);

  // Remove ExDiff's own bookkeeping when no snapshots are left. A shared
  // custom root may still contain other repositories' slots, so check first.
  const remaining = await readdirSafe(root);
  if (!remaining.some((entry) => entry.name.endsWith('.json'))) {
    for (const name of ['.tmp', 'empty']) {
      await fs.rm(path.join(root, name), { recursive: true, force: true });
    }
    await fs.rm(path.join(root, '.gitignore'), { force: true });
  }

  try {
    await fs.rmdir(root);
  } catch {
    // Not empty (other slots) or in use — keep it.
  }

  return { detached, removed };
}

async function ensureAttachedInner(
  context: vscode.ExtensionContext,
  repo: RepoInfo,
  paths: SnapshotPaths,
  cfg: ExDiffConfig,
): Promise<boolean> {
  if (cfg.autoAttach === 'never') return false;
  if (isAttached(paths.dir)) return true;

  const consent = context.globalState.get<Consent>(ATTACH_CONSENT_KEY);
  if (consent === 'never') return false;
  if (cfg.autoAttach === 'always' || consent === 'yes') {
    return await attachOne(repo, paths);
  }

  const key = normalize(paths.dir);
  if (declinedThisSession.has(key)) return false;

  const add = vscode.l10n.t('Add');
  const notNow = vscode.l10n.t('Not Now');
  const dontAskAgain = vscode.l10n.t("Don't Ask Again");
  const choice = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      'ExDiff needs to add the snapshot folder "{0}" to the workspace so that hover, Go to Definition, Find References and diagnostics work on the left (old) side of the diff.',
      snapshotFolderName(repo, paths),
    ),
    add,
    notNow,
    dontAskAgain,
  );

  switch (choice) {
    case add:
      await context.globalState.update(ATTACH_CONSENT_KEY, 'yes');
      return await attachOne(repo, paths);
    case notNow:
      await context.globalState.update(ATTACH_CONSENT_KEY, 'no');
      declinedThisSession.add(key);
      return false;
    case dontAskAgain:
      await context.globalState.update(ATTACH_CONSENT_KEY, 'never');
      declinedThisSession.add(key);
      return false;
    default:
      declinedThisSession.add(key);
      return false;
  }
}

async function attachOne(repo: RepoInfo, paths: SnapshotPaths): Promise<boolean> {
  const name = snapshotFolderName(repo, paths);
  try {
    await addWorkspaceFolders([{ uri: vscode.Uri.file(paths.dir), name }]);
    return true;
  } catch (error) {
    await warn(
      vscode.l10n.t('ExDiff: Cannot add the snapshot folder "{0}" to the workspace: {1}', name, errorMessage(error)),
    );
    return false;
  }
}

async function addWorkspaceFolders(entries: { uri: vscode.Uri; name: string }[]): Promise<void> {
  const pending = entries.filter((entry) => !isAttached(entry.uri.fsPath));
  if (pending.length === 0) return;

  await withFolderUpdateLock(async () => {
    // `start = length` + `deleteCount = 0` appends. `applyWorkspaceFolders`
    // waits for onDidChangeWorkspaceFolders, which VS Code requires before it
    // accepts the next folder edit.
    const start = vscode.workspace.workspaceFolders?.length ?? 0;
    let ok = await applyWorkspaceFolders(start, 0, pending);
    if (ok && (await waitUntilAttached(pending, 3000))) return;
    if (await waitUntilAttached(pending, 1000)) return;

    // Rejected while another update was still settling, or the folder list
    // settled late. Retry at index 0 (never depends on a stale length).
    ok = await applyWorkspaceFolders(0, 0, pending);
    if (ok && (await waitUntilAttached(pending, 3000))) return;
    if (await waitUntilAttached(pending, 1000)) return;

    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    throw new Error(
      vscode.l10n.t(
        'VS Code rejected the workspace folder update (folders={0}; adding={1})',
        folders.join('; '),
        pending.map((entry) => entry.uri.fsPath).join(', '),
      ),
    );
  });
}

/**
 * Calls `updateWorkspaceFolders` and waits for `onDidChangeWorkspaceFolders`.
 *
 * VS Code only accepts the next folder edit after that event has fired; the
 * `vscode.workspace.workspaceFolders` array can be updated slightly earlier,
 * which makes polling it insufficient.
 */
async function applyWorkspaceFolders(
  start: number,
  deleteCount: number,
  add: { uri: vscode.Uri; name?: string }[],
): Promise<boolean> {
  let settle!: (changed: boolean) => void;
  const changed = new Promise<boolean>((resolve) => {
    settle = resolve;
  });

  let subscription: vscode.Disposable | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (value: boolean): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    subscription?.dispose();
    subscription = undefined;
    settle(value);
  };

  subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => finish(true));
  timer = setTimeout(() => finish(false), 5000);

  let ok: boolean;
  try {
    ok = vscode.workspace.updateWorkspaceFolders(start, deleteCount, ...add);
  } catch (error) {
    finish(false);
    throw new Error(errorMessage(error));
  }
  if (!ok) {
    finish(false);
    return false;
  }

  await changed;
  return true;
}

/** Waits for VS Code to make the (already accepted) folders visible to extensions. */
async function waitUntilAttached(entries: { uri: vscode.Uri }[], timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (entries.every((entry) => isAttached(entry.uri.fsPath))) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return entries.every((entry) => isAttached(entry.uri.fsPath));
}

/** Waits for VS Code to propagate a folder removal before the next edit. */
async function waitUntilDetached(dir: string, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAttached(dir)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAttached(dir);
}

/** Runs workspace-folder edits one at a time. */
function withFolderUpdateLock<T>(task: () => Promise<T>): Promise<T> {
  const run = folderUpdateQueue.then(task, task);
  folderUpdateQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Deletes sidecars/temp files left behind by snapshots whose directory is gone. */
async function removeOrphanArtifacts(dir: string): Promise<void> {
  if (!(await isDirectory(dir))) return;

  const entries = await readdirSafe(dir);
  const directories = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const target = path.join(dir, entry.name);
    if (entry.name.endsWith('.tmp')) {
      await fs.rm(target, { force: true });
      continue;
    }
    if (!entry.name.endsWith('.json')) continue;
    const slot = entry.name.slice(0, -'.json'.length);
    if (slot && directories.has(slot)) continue; // removed by removeSnapshot()
    await fs.rm(target, { force: true });
  }
}
