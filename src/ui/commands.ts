import * as vscode from 'vscode';

import type { ChangedFile, ExDiffConfig, RepoInfo } from '../core/types';
import { headSha, reflogEntries, resolveBase, revParse, writeTreeFromIndex, type ResolvedBase } from '../core/git';
import { ensureSnapshot } from '../core/snapshot';
import { OPEN_CHANGED_FILE_COMMAND, type ChangesView } from './changesView';
import { diffTitle, openFileDiff, type Comparison, type Side } from './diff';
import { info, registerCommand, shortErrorMessage, warn } from './errors';
import type { UiHost } from './host';
import { findStaleSnapshots, pruneStaleSnapshots } from './maintenance';
import { withExProgress } from './progress';
import { OPEN_RANGE_COMMAND, type RebaseView } from './rebaseView';
import { compareRefs, pickBaseRef, swapSides } from './refPicker';
import {
  activeFileUri,
  fileExists,
  resolveActiveRepo,
  resolveInside,
  resolveTarget,
  type FileTarget,
} from './repo';
import { normalize } from './snapshots';
import { attachSnapshots, cleanSnapshots, detachSnapshots, ensureAttached } from './workspaceFolders';

/**
 * Registers every command contributed in `package.json` plus the two internal
 * commands used by the tree items. All handlers share the error wrapper from
 * `errors.ts` (red notification + "Show Details" → output channel).
 */
export function registerCommands(host: UiHost, changesView: ChangesView, rebaseView: RebaseView): void {
  const { context, output } = host;

  registerCommand<[vscode.Uri | undefined, vscode.Uri[] | undefined]>(
    context,
    output,
    'exdiff.openFileWithBase',
    async (uri, uris) => await openFileWithBase(host, uri, uris),
  );

  registerCommand<[vscode.Uri | undefined]>(
    context,
    output,
    'exdiff.openFileWithAmendPrev',
    async (uri) => await openFileWithAmendPrev(host, uri),
  );

  registerCommand<[vscode.Uri | undefined]>(
    context,
    output,
    'exdiff.openFileWorkingTree',
    async (uri) => await openFileWorkingTree(host, uri),
  );

  registerCommand<[vscode.Uri | undefined]>(
    context,
    output,
    'exdiff.openFileStaged',
    async (uri) => await openFileStaged(host, uri),
  );

  registerCommand(context, output, 'exdiff.openBaseSide', async (uri?: vscode.Uri) => {
    await openBaseSide(host, uri);
  });

  registerCommand(context, output, 'exdiff.showChanges', async () => {
    await changesView.refresh();
    await vscode.commands.executeCommand('exdiff.changes.focus');
  });

  registerCommand(context, output, 'exdiff.compareRefs', async () => {
    await compareRefs(host, changesView);
  });

  registerCommand(context, output, 'exdiff.showRebaseChanges', async () => {
    await rebaseView.showRebaseChanges();
  });

  registerCommand(context, output, 'exdiff.swapSides', async () => {
    await swapSides(changesView);
  });

  registerCommand(context, output, 'exdiff.pickBaseRef', async () => {
    await pickBaseRef(host, changesView);
  });

  registerCommand(context, output, 'exdiff.refresh', async () => {
    await changesView.refresh();
    await rebaseView.refresh();
  });

  registerCommand(context, output, 'exdiff.attachSnapshots', async () => {
    const repo = await requireRepo(host);
    if (!repo) return;
    const count = await attachSnapshots(repo, host.getConfig());
    await info(
      count > 0
        ? vscode.l10n.t('ExDiff: Attached {0} snapshot folder(s)', count)
        : vscode.l10n.t('ExDiff: No snapshots to attach (open a diff first to create one)'),
    );
  });

  registerCommand(context, output, 'exdiff.detachSnapshots', async () => {
    const repo = await requireRepo(host);
    if (!repo) return;
    const count = await detachSnapshots(repo, host.getConfig());
    await info(
      count > 0
        ? vscode.l10n.t('ExDiff: Removed {0} snapshot folder(s) from the workspace', count)
        : vscode.l10n.t('ExDiff: No snapshot folders are attached'),
    );
  });

  registerCommand(context, output, 'exdiff.cleanSnapshots', async () => {
    const repo = await requireRepo(host);
    if (!repo) return;
    const deleteSnapshots = vscode.l10n.t('Delete Snapshots');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        'ExDiff: Delete all snapshot folders of this repository? They will be materialized again the next time you open a diff (slow the first time).',
      ),
      { modal: true },
      deleteSnapshots,
    );
    if (choice !== deleteSnapshots) return;
    const result = await cleanSnapshots(repo, host.getConfig());
    await info(
      vscode.l10n.t(
        'ExDiff: Removed {0} workspace folder(s) and deleted {1} snapshot folder(s)',
        result.detached,
        result.removed,
      ),
    );
  });

  registerCommand<[Comparison, ChangedFile]>(
    context,
    output,
    OPEN_CHANGED_FILE_COMMAND,
    async (comparison, file) => await changesView.openFile(comparison, file),
  );

  registerCommand<[number | null | undefined]>(
    context,
    output,
    OPEN_RANGE_COMMAND,
    async (index) => {
      if (index === null || index === undefined) {
        await rebaseView.openFullRangeDiff();
      } else {
        await rebaseView.openPair(index);
      }
    },
  );

  registerCommand<[vscode.Uri | undefined]>(
    context,
    output,
    'exdiff.openFileWithPreviousCommit',
    async (uri) => await openFileWithPreviousCommit(host, uri),
  );

  registerCommand(context, output, 'exdiff.pruneSnapshots', async () => {
    const repo = await requireRepo(host);
    if (!repo) return;

    const cfg = host.getConfig();
    if (cfg.snapshotRetentionDays <= 0) {
      await info(
        vscode.l10n.t('ExDiff: Automatic pruning is disabled (exdiff.snapshotRetentionDays = 0)'),
      );
      return;
    }

    const stale = await findStaleSnapshots(repo, cfg);
    if (stale.length === 0) {
      await info(vscode.l10n.t('ExDiff: No snapshots older than {0} days', cfg.snapshotRetentionDays));
      return;
    }

    const deleteLabel = vscode.l10n.t('Delete');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Delete {0} snapshot folder(s) older than {1} days?',
        stale.length,
        cfg.snapshotRetentionDays,
      ),
      { modal: true },
      deleteLabel,
    );
    if (choice !== deleteLabel) return;

    const result = await pruneStaleSnapshots(repo, cfg);
    await info(vscode.l10n.t('ExDiff: Deleted {0} snapshot folder(s)', result.removed));
  });
}

// --- ExDiff: Open Changes with Base ---------------------------------------

async function openFileWithBase(
  host: UiHost,
  uri: vscode.Uri | undefined,
  uris: vscode.Uri[] | undefined,
): Promise<void> {
  const cfg = host.getConfig();
  const targets = collectTargets(uri, uris);
  if (targets.length === 0) {
    await warn(notInRepo());
    return;
  }

  if (targets.length > 10) {
    const openAll = vscode.l10n.t('Open All');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('Open {0} diff editors?', targets.length),
      { modal: true },
      openAll,
    );
    if (choice !== openAll) return;
  }

  let missingRepo = 0;
  let missingBase = false;
  const baseCache = new Map<string, ResolvedBase | null>();

  for (const targetUri of targets) {
    const target = await resolveTarget(targetUri, cfg);
    if (!target) {
      missingRepo += 1;
      continue;
    }

    let base = baseCache.get(target.repo.root);
    if (base === undefined) {
      base = await resolveBase(target.repo, cfg.baseRef, cfg.gitPath);
      baseCache.set(target.repo.root, base);
    }
    if (!base) {
      missingBase = true;
      break;
    }

    const baseLabel = `${base.ref}@${base.sha.slice(0, 7)}`;
    const right = await resolveRightSide(target.repo, cfg);
    if (!right) return;

    await openFileDiff(target.repo, cfg, host.context, {
      left: { kind: 'snapshot', slot: 'base', sha: base.sha, label: baseLabel },
      right,
      relPath: target.relPath,
      title: diffTitle(target.relPath, baseLabel, right.label),
    });
  }

  if (missingBase) await warn(missingBaseRef(cfg.baseRef));
  if (missingRepo > 0) await warn(notInRepo());
}

// --- ExDiff: Open Changes with Previous Amend ----------------------------

async function openFileWithAmendPrev(host: UiHost, uri: vscode.Uri | undefined): Promise<void> {
  const cfg = host.getConfig();
  const target = await singleTarget(host, uri);
  if (!target) return;

  const entries = await reflogEntries(target.repo, cfg.gitPath, 1);
  const latest = entries[0];
  if (!latest || !latest.message.startsWith('commit (amend)')) {
    const detail = latest?.message ?? vscode.l10n.t('the reflog is empty');
    const compareAnyway = vscode.l10n.t('Compare Anyway');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('The last operation was not an amend ({0}). Compare with HEAD@{1} anyway?', detail),
      compareAnyway,
    );
    if (choice !== compareAnyway) return;
  }

  const amendSha = await revParse(target.repo, 'HEAD@{1}', cfg.gitPath);
  if (!amendSha) {
    await warn(vscode.l10n.t('ExDiff: Cannot find HEAD@{1} (no previous commit in the reflog)'));
    return;
  }

  const right = await resolveRightSide(target.repo, cfg);
  if (!right) return;

  await openFileDiff(target.repo, cfg, host.context, {
    left: { kind: 'snapshot', slot: 'amend', sha: amendSha, label: 'HEAD@{1}' },
    right,
    relPath: target.relPath,
    title: diffTitle(target.relPath, 'HEAD@{1}', right.label),
  });
}

// --- ExDiff: Open Changes with Previous Commit ---------------------------

async function openFileWithPreviousCommit(host: UiHost, uri: vscode.Uri | undefined): Promise<void> {
  const cfg = host.getConfig();
  const target = await singleTarget(host, uri);
  if (!target) return;

  const head = await headSha(target.repo, cfg.gitPath);
  if (!head) {
    await warn(vscode.l10n.t('ExDiff: No commits yet'));
    return;
  }

  const previous = await revParse(target.repo, 'HEAD~1', cfg.gitPath);
  if (!previous) {
    await warn(vscode.l10n.t('ExDiff: No previous commit yet (HEAD~1 does not exist)'));
    return;
  }

  // Both sides are committed snapshots: this shows exactly what the current
  // HEAD commit changed and ignores `exdiff.rightSide` / uncommitted edits.
  await openFileDiff(target.repo, cfg, host.context, {
    left: { kind: 'snapshot', slot: 'prev', sha: previous, label: 'HEAD~1' },
    right: { kind: 'snapshot', slot: 'head', sha: head, label: 'HEAD' },
    relPath: target.relPath,
    title: diffTitle(target.relPath, 'HEAD~1', 'HEAD'),
  });
}

// --- ExDiff: Open Changes with HEAD (uncommitted) ------------------------

async function openFileWorkingTree(host: UiHost, uri: vscode.Uri | undefined): Promise<void> {
  const cfg = host.getConfig();
  const target = await singleTarget(host, uri);
  if (!target) return;

  const head = await headSha(target.repo, cfg.gitPath);
  if (!head) {
    await warn(vscode.l10n.t('ExDiff: No commits yet, cannot compare with HEAD'));
    return;
  }

  const right: Side = { kind: 'worktree', label: vscode.l10n.t('Working Tree') };
  await openFileDiff(target.repo, cfg, host.context, {
    left: { kind: 'snapshot', slot: 'head', sha: head, label: 'HEAD' },
    right,
    relPath: target.relPath,
    title: diffTitle(target.relPath, 'HEAD', right.label),
  });
}

// --- ExDiff: Open Changes with HEAD (staged only) ------------------------

async function openFileStaged(host: UiHost, uri: vscode.Uri | undefined): Promise<void> {
  const cfg = host.getConfig();
  const target = await singleTarget(host, uri);
  if (!target) return;

  const head = await headSha(target.repo, cfg.gitPath);
  if (!head) {
    await warn(vscode.l10n.t('ExDiff: No commits yet'));
    return;
  }

  let indexTree: string;
  try {
    indexTree = await withExProgress(
      vscode.l10n.t('Reading the index…'),
      async () => await writeTreeFromIndex(target.repo, cfg.gitPath),
    );
  } catch (error) {
    await warn(
      vscode.l10n.t(
        'ExDiff: Cannot read the index (unresolved conflicts?): {0}',
        shortErrorMessage(error),
      ),
    );
    return;
  }

  await openFileDiff(target.repo, cfg, host.context, {
    left: { kind: 'snapshot', slot: 'head', sha: head, label: 'HEAD' },
    right: { kind: 'snapshot', slot: 'index', sha: indexTree, label: 'Index' },
    relPath: target.relPath,
    title: diffTitle(target.relPath, 'HEAD', 'Index'),
  });
}

// --- ExDiff: Open Base Version of This File ------------------------------

async function openBaseSide(host: UiHost, uri: vscode.Uri | undefined): Promise<void> {
  const cfg = host.getConfig();
  const target = await singleTarget(host, uri);
  if (!target) return;

  const base = await resolveBase(target.repo, cfg.baseRef, cfg.gitPath);
  if (!base) {
    await warn(missingBaseRef(cfg.baseRef));
    return;
  }

  const baseLabel = `${base.ref}@${base.sha.slice(0, 7)}`;
  const paths = await withExProgress(
    vscode.l10n.t('Preparing snapshot "base" ({0})…', baseLabel),
    async (report) => await ensureSnapshot(target.repo, 'base', base.sha, cfg, { onProgress: report }),
  );

  const absolute = resolveInside(paths.dir, target.relPath);
  if (!(await fileExists(absolute))) {
    await info(vscode.l10n.t('ExDiff: {0} does not exist in {1}', target.relPath, baseLabel));
    return;
  }

  await vscode.window.showTextDocument(vscode.Uri.file(absolute), { preview: true });
  // Attach after opening: this can restart the extension host in a
  // single-folder workspace, and the editor is restored afterwards.
  await ensureAttached(host.context, target.repo, paths, cfg);
}

// --- helpers -------------------------------------------------------------

async function resolveRightSide(repo: RepoInfo, cfg: ExDiffConfig): Promise<Side | null> {
  if (cfg.rightSide === 'workingTree') {
    return { kind: 'worktree', label: vscode.l10n.t('Working Tree') };
  }
  const head = await headSha(repo, cfg.gitPath);
  if (!head) {
    await warn(vscode.l10n.t('ExDiff: No commits yet, cannot compare with HEAD'));
    return null;
  }
  return { kind: 'snapshot', slot: 'head', sha: head, label: 'HEAD' };
}

async function singleTarget(host: UiHost, uri: vscode.Uri | undefined): Promise<FileTarget | null> {
  const cfg = host.getConfig();
  const targetUri = uri ?? activeFileUri();
  if (!targetUri) {
    await warn(vscode.l10n.t('ExDiff: No file is open'));
    return null;
  }
  const target = await resolveTarget(targetUri, cfg);
  if (!target) {
    await warn(notInRepo());
    return null;
  }
  return target;
}

async function requireRepo(host: UiHost): Promise<RepoInfo | null> {
  const repo = await resolveActiveRepo(host.getConfig());
  if (!repo) {
    await warn(notInRepo());
    return null;
  }
  return repo;
}

/** Shared notification text: the command needs a file that belongs to a repository. */
function notInRepo(): string {
  return vscode.l10n.t('ExDiff: Current file is not in a Git repository');
}

/** Shared notification text for an unresolvable `exdiff.baseRef`. */
function missingBaseRef(baseRef: string): string {
  if (baseRef.trim() === 'auto') {
    return vscode.l10n.t('ExDiff: Cannot detect a base branch (exdiff.baseRef)');
  }
  return vscode.l10n.t('ExDiff: Cannot find base ref "{0}" (exdiff.baseRef)', baseRef);
}

function collectTargets(uri?: vscode.Uri, uris?: vscode.Uri[]): vscode.Uri[] {
  const result: vscode.Uri[] = [];
  const seen = new Set<string>();

  const add = (value: unknown): void => {
    if (!isFileUri(value)) return;
    const key = normalize(value.fsPath);
    if (seen.has(key)) return;
    seen.add(key);
    result.push(value);
  };

  if (Array.isArray(uris)) {
    for (const item of uris) add(item);
  }
  add(uri);
  if (result.length === 0) add(activeFileUri());
  return result;
}

function isFileUri(value: unknown): value is vscode.Uri {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { scheme?: unknown; fsPath?: unknown };
  return candidate.scheme === 'file' && typeof candidate.fsPath === 'string';
}
