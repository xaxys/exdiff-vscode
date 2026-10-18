import * as path from 'node:path';
import * as vscode from 'vscode';

import type { ChangedFile, ExDiffConfig, FileStatus, RepoInfo } from '../core/types';
import { changedFiles, headSha, revParse } from '../core/git';
import type { Comparison } from './diff';
import { openPathDiff } from './diff';
import { errorMessage } from './errors';
import type { UiHost } from './host';
import { resolveActiveRepo } from './repo';
import { isSameOrInside, normalize } from './snapshots';

/** Internal command used by the tree items (not part of the public palette). */
export const OPEN_CHANGED_FILE_COMMAND = 'exdiff.internal.openChangedFile';

const STATUS_ICON: Record<FileStatus, string> = {
  A: 'diff-added',
  M: 'diff-modified',
  D: 'diff-removed',
  R: 'diff-renamed',
  C: 'diff-renamed',
  T: 'diff-modified',
  U: 'warning',
  X: 'warning',
  B: 'diff-modified',
};

type ChangesNode =
  | { kind: 'file'; file: ChangedFile; comparison: Comparison }
  | { kind: 'info'; label: string; icon?: string };

/**
 * Tree view listing the files changed between two revisions (base → HEAD by
 * default). The view keeps its own live state: `setComparison()` turns it into
 * an arbitrary ref/ref comparison for `ExDiff: Compare Two Refs…`.
 */
export class ChangesView implements vscode.TreeDataProvider<ChangesNode>, vscode.Disposable {
  private readonly host: UiHost;
  private readonly view: vscode.TreeView<ChangesNode>;
  private readonly emitter = new vscode.EventEmitter<ChangesNode | undefined | void>();
  private readonly disposables: vscode.Disposable[] = [];

  readonly onDidChangeTreeData = this.emitter.event;

  private comparison: Comparison | null = null;
  private explicit = false;
  private files: ChangedFile[] = [];
  private emptyMessage: string | null = vscode.l10n.t('Loading…');
  private nodes: ChangesNode[] = [];
  private repo: RepoInfo | null = null;
  private watchers: vscode.Disposable[] = [];
  private watchedRoot: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(host: UiHost) {
    this.host = host;
    this.view = vscode.window.createTreeView('exdiff.changes', {
      treeDataProvider: this,
      showCollapseAll: false,
    });
    this.disposables.push(
      this.view,
      vscode.workspace.onDidSaveTextDocument((document) => this.onDidSave(document)),
      vscode.workspace.onDidChangeConfiguration((event) => this.onDidChangeConfiguration(event)),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) this.scheduleRefresh();
      }),
    );
    this.rebuildNodes(this.host.getConfig());
    this.view.description = this.describe();
    void this.refresh();
  }

  // --- public API ---------------------------------------------------------

  /** Rebuilds the view; `resetComparison` returns to the configured base → HEAD. */
  async refresh(options: { resetComparison?: boolean } = {}): Promise<void> {
    if (options.resetComparison) this.resetComparison();
    await this.refreshNow();
  }

  /** Switches the view to an arbitrary comparison (used by Compare Two Refs). */
  setComparison(comparison: Comparison): void {
    this.explicit = true;
    this.comparison = comparison;
    void this.refresh();
  }

  getComparison(): Comparison | null {
    return this.comparison;
  }

  /** Drops an explicit comparison so the next refresh uses base → HEAD again. */
  resetComparison(): void {
    this.explicit = false;
    this.comparison = null;
  }

  async openFile(comparison: Comparison, file: ChangedFile): Promise<void> {
    const cfg = this.host.getConfig();
    const renamed = file.status === 'R' || file.status === 'C';
    // `changedFiles(from, to)` reports oldPath for the left/from revision and
    // newPath for the right/to revision, so this holds for swapped comparisons
    // as well (their rename records are simply reversed).
    const oldPath = renamed ? file.oldPath ?? file.newPath : file.newPath;
    await openPathDiff(comparison.repo, cfg, this.host.context, comparison, oldPath, file.newPath);
  }

  // --- TreeDataProvider ---------------------------------------------------

  getChildren(element?: ChangesNode): vscode.ProviderResult<ChangesNode[]> {
    if (element) return [];
    return this.nodes;
  }

  getTreeItem(node: ChangesNode): vscode.TreeItem {
    if (node.kind === 'info') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
      return item;
    }

    const file = node.file;
    const renamed = file.status === 'R' || file.status === 'C';
    const label = renamed && file.oldPath ? `${file.oldPath} → ${file.newPath}` : file.newPath;

    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = formatCounts(file);
    item.tooltip = `${statusText(file.status)}: ${file.newPath}`;
    item.iconPath = new vscode.ThemeIcon(STATUS_ICON[file.status]);
    item.contextValue = 'exdiff.changedFile';
    item.command = {
      command: OPEN_CHANGED_FILE_COMMAND,
      title: vscode.l10n.t('Open Changes'),
      arguments: [node.comparison, file],
    };
    return item;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.disposeWatchers();
    for (const disposable of this.disposables) disposable.dispose();
    this.emitter.dispose();
  }

  // --- refresh plumbing ---------------------------------------------------

  private async refreshNow(): Promise<void> {
    const cfg = this.host.getConfig();
    let comparison: Comparison | null = null;
    let files: ChangedFile[] = [];
    let empty: string | null = null;

    try {
      if (this.explicit) {
        comparison = this.comparison;
        if (!comparison) empty = vscode.l10n.t('No two refs selected for comparison yet');
      } else {
        const loaded = await this.loadDefaultComparison(cfg);
        comparison = loaded.comparison;
        empty = loaded.message;
      }

      if (comparison) {
        this.watch(comparison.repo);
        const from = snapshotSha(comparison.left);
        const to = snapshotSha(comparison.right);
        if (!from || !to) {
          files = [];
          empty = vscode.l10n.t(
            'The Changes view only supports comparisons where both sides are snapshots (the working tree side has no enumerable revision)',
          );
        } else {
          files = await changedFiles(comparison.repo, from, to, cfg.gitPath);
        }
      }
    } catch (error) {
      comparison = this.explicit ? this.comparison : null;
      files = [];
      empty = vscode.l10n.t('Failed to read the changes: {0}', errorMessage(error));
    }

    if (this.disposed) return;

    this.comparison = comparison;
    this.files = files;
    this.emptyMessage = empty;
    this.rebuildNodes(cfg);
    this.view.description = this.describe();
    this.emitter.fire();
  }

  private async loadDefaultComparison(
    cfg: ExDiffConfig,
  ): Promise<{ comparison: Comparison | null; message: string | null }> {
    const repo = await resolveActiveRepo(cfg);
    if (!repo) {
      return {
        comparison: null,
        message: vscode.l10n.t('Current file is not in a Git repository'),
      };
    }

    this.watch(repo);

    const baseSha = await revParse(repo, cfg.baseRef, cfg.gitPath);
    if (!baseSha) {
      return {
        comparison: null,
        message: vscode.l10n.t('Cannot find base ref "{0}" (exdiff.baseRef)', cfg.baseRef),
      };
    }

    const head = await headSha(repo, cfg.gitPath);
    if (!head) return { comparison: null, message: vscode.l10n.t('The repository has no commits yet') };

    return {
      comparison: {
        repo,
        left: { kind: 'snapshot', slot: 'base', sha: baseSha, label: cfg.baseRef },
        right: { kind: 'snapshot', slot: 'head', sha: head, label: 'HEAD' },
        leftLabel: cfg.baseRef,
        rightLabel: 'HEAD',
      },
      message: null,
    };
  }

  private rebuildNodes(cfg: ExDiffConfig): void {
    if (this.emptyMessage) {
      this.nodes = [{ kind: 'info', label: this.emptyMessage, icon: 'info' }];
      return;
    }
    if (this.files.length === 0) {
      this.nodes = [{ kind: 'info', label: vscode.l10n.t('No changes'), icon: 'check' }];
      return;
    }
    if (!this.comparison) {
      this.nodes = [{ kind: 'info', label: vscode.l10n.t('No comparison selected'), icon: 'info' }];
      return;
    }
    const comparison = this.comparison;

    const limit = Math.max(1, cfg.maxFilesInTree);
    const visible = this.files.slice(0, limit);
    const nodes: ChangesNode[] = visible.map((file) => ({ kind: 'file', file, comparison }));
    if (this.files.length > visible.length) {
      nodes.push({
        kind: 'info',
        label: vscode.l10n.t(
          '… {0} more file(s) not shown (exdiff.maxFilesInTree)',
          this.files.length - visible.length,
        ),
        icon: 'ellipsis',
      });
    }
    this.nodes = nodes;
  }

  private describe(): string {
    const parts: string[] = [];
    if (this.comparison) {
      parts.push(`${this.comparison.leftLabel} → ${this.comparison.rightLabel}`);
    }
    if (this.emptyMessage) {
      parts.push(this.emptyMessage);
      return parts.join(' · ');
    }
    parts.push(vscode.l10n.t('{0} files', this.files.length));
    const totals = this.totals();
    if (totals) parts.push(`+${totals.additions} −${totals.deletions}`);
    return parts.join(' · ');
  }

  private totals(): { additions: number; deletions: number } | null {
    let additions = 0;
    let deletions = 0;
    let hasStats = false;
    for (const file of this.files) {
      if (file.additions !== null) {
        additions += file.additions;
        hasStats = true;
      }
      if (file.deletions !== null) {
        deletions += file.deletions;
        hasStats = true;
      }
    }
    return hasStats ? { additions, deletions } : null;
  }

  // --- event handling -----------------------------------------------------

  private onDidSave(document: vscode.TextDocument): void {
    if (document.uri.scheme !== 'file') return;
    if (this.repo && !isSameOrInside(this.repo.root, document.uri.fsPath)) return;
    this.scheduleRefresh();
  }

  private onDidChangeConfiguration(event: vscode.ConfigurationChangeEvent): void {
    if (!event.affectsConfiguration('exdiff')) return;
    if (!this.explicit && event.affectsConfiguration('exdiff.baseRef')) this.comparison = null;
    this.scheduleRefresh();
  }

  private scheduleRefresh(delay = 500): void {
    if (this.disposed) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, delay);
  }

  // --- .git watching ------------------------------------------------------

  private watch(repo: RepoInfo): void {
    this.repo = repo;
    const key = normalize(repo.root);
    if (this.watchedRoot === key) return;

    this.disposeWatchers();
    this.watchedRoot = key;

    const directories = new Set([path.resolve(repo.commondir), path.resolve(repo.gitdir)]);
    for (const directory of directories) {
      try {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(vscode.Uri.file(directory), '{HEAD,index,logs/HEAD,refs/**}'),
        );
        const schedule = (): void => this.scheduleRefresh();
        this.watchers.push(
          watcher,
          watcher.onDidChange(schedule),
          watcher.onDidCreate(schedule),
          watcher.onDidDelete(schedule),
        );
      } catch {
        // Watching .git is a convenience only; never break the view over it.
      }
    }
  }

  private disposeWatchers(): void {
    for (const disposable of this.watchers) disposable.dispose();
    this.watchers = [];
    this.watchedRoot = null;
  }
}

function snapshotSha(side: Comparison['left']): string | null {
  return side.kind === 'snapshot' ? side.sha : null;
}

/** Localized status word for the file tooltip. */
function statusText(status: FileStatus): string {
  switch (status) {
    case 'A':
      return vscode.l10n.t('Added');
    case 'M':
      return vscode.l10n.t('Modified');
    case 'D':
      return vscode.l10n.t('Deleted');
    case 'R':
      return vscode.l10n.t('Renamed');
    case 'C':
      return vscode.l10n.t('Copied');
    case 'T':
      return vscode.l10n.t('Type changed');
    case 'U':
      return vscode.l10n.t('Unmerged');
    case 'X':
      return vscode.l10n.t('Unknown');
    case 'B':
      return vscode.l10n.t('Broken');
  }
}

function formatCounts(file: ChangedFile): string | undefined {
  const additions = file.additions === null ? '' : `+${file.additions}`;
  const deletions = file.deletions === null ? '' : `−${file.deletions}`;
  const text = [additions, deletions].filter((part) => part.length > 0).join(' ');
  return text.length > 0 ? text : undefined;
}
