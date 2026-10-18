import * as vscode from 'vscode';

import type { ExDiffConfig, RangeDiffPair, RebaseRanges, RepoInfo } from '../core/types';
import { deriveRebaseRanges, rangeDiff } from '../core/git';
import { parseRangeDiff, relationshipLabel, splitPairPatches } from '../core/rangeDiff';
import { errorMessage, info, warn } from './errors';
import type { UiHost } from './host';
import { withExProgress } from './progress';
import { resolveActiveRepo } from './repo';

/** Scheme of the read-only documents that show `git range-diff --patch` output. */
export const RANGE_SCHEME = 'exdiff-range';

/** Internal command used by the rebase tree items. `null` means "full diff". */
export const OPEN_RANGE_COMMAND = 'exdiff.internal.openRangeDiff';

type RebaseNode =
  | { kind: 'full' }
  | { kind: 'pair'; pair: RangeDiffPair }
  | { kind: 'info'; label: string };

/**
 * Tree view + content provider for the last rebase (`git range-diff`).
 *
 * The inferred ranges are cached in `workspaceState` so the review survives a
 * window reload even after `ORIG_HEAD` has been overwritten.
 */
export class RebaseView
  implements vscode.TreeDataProvider<RebaseNode>, vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly host: UiHost;
  private readonly view: vscode.TreeView<RebaseNode>;
  private readonly emitter = new vscode.EventEmitter<RebaseNode | undefined | void>();
  private readonly contentEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly contents = new Map<string, string>();

  readonly onDidChangeTreeData = this.emitter.event;
  readonly onDidChange = this.contentEmitter.event;

  private repo: RepoInfo | null = null;
  private ranges: RebaseRanges | null = null;
  private pairs: RangeDiffPair[] = [];
  private nodes: RebaseNode[] = [];
  private emptyMessage: string | null = vscode.l10n.t('No rebase detected');
  private disposed = false;

  constructor(host: UiHost) {
    this.host = host;
    this.view = vscode.window.createTreeView('exdiff.rebase', {
      treeDataProvider: this,
      showCollapseAll: false,
    });
    this.render();
  }

  // --- public API ---------------------------------------------------------

  /** Derives the last rebase ranges, caches them and lists the commit pairs. */
  async showRebaseChanges(): Promise<void> {
    const cfg = this.host.getConfig();
    const repo = await resolveActiveRepo(cfg);
    if (!repo) {
      const message = vscode.l10n.t('Current file is not in a Git repository');
      this.setEmpty(message);
      await warn(message);
      return;
    }

    let ranges: RebaseRanges | null;
    try {
      ranges = await withExProgress(
        vscode.l10n.t('Detecting the last rebase…'),
        async () => await deriveRebaseRanges(repo, cfg.gitPath),
      );
    } catch (error) {
      this.setEmpty(vscode.l10n.t('Failed to detect the rebase: {0}', errorMessage(error)));
      await warn(vscode.l10n.t('ExDiff: Failed to detect the rebase: {0}', errorMessage(error)));
      return;
    }

    if (!ranges) {
      const message = vscode.l10n.t(
        'No rebase detected (ORIG_HEAD and a rebase (start) reflog entry are required)',
      );
      this.setEmpty(message);
      await info(`ExDiff: ${message}`);
      return;
    }

    this.repo = repo;
    this.ranges = ranges;
    await this.host.context.workspaceState.update(storageKey(repo), ranges);
    await this.loadPairs(cfg);
    await vscode.commands.executeCommand('exdiff.rebase.focus');
  }

  /** Re-shows the cached rebase ranges of the active repository, if any. */
  async restoreFromCache(): Promise<void> {
    const cfg = this.host.getConfig();
    const repo = await resolveActiveRepo(cfg);
    if (!repo) return;

    const cached = this.host.context.workspaceState.get<RebaseRanges>(storageKey(repo));
    if (!isRebaseRanges(cached)) return;

    this.repo = repo;
    this.ranges = cached;
    await this.loadPairs(cfg);
  }

  /** Refresh button: re-reads the range-diff output for the current ranges. */
  async refresh(): Promise<void> {
    if (this.repo && this.ranges) {
      await this.loadPairs(this.host.getConfig());
      return;
    }
    await this.restoreFromCache();
  }

  /** Opens the `--patch` fragment of one commit pair (1-based `index`). */
  async openPair(index: number): Promise<void> {
    const repo = this.repo;
    const ranges = this.ranges;
    if (!repo || !ranges) {
      await warn(vscode.l10n.t('ExDiff: No rebase ranges available, run "Show Rebase Changes" first'));
      return;
    }

    const cfg = this.host.getConfig();
    const output = await withExProgress(
      vscode.l10n.t('Loading patch for pair {0}…', index),
      async () => await this.runRangeDiff(repo, ranges, cfg, true),
    );
    const chunks = splitPairPatches(output);
    const chunk = chunks[index - 1];
    const noPatch = vscode.l10n.t('(no patch)');
    if (!chunk) {
      await this.showDocument(`pair-${index}`, noPatch);
      return;
    }

    const patch = chunk.patch.trim().length > 0 ? chunk.patch : noPatch;
    await this.showDocument(`pair-${index}`, `${chunk.header}\n\n${patch}\n`);
  }

  /** Opens the complete `git range-diff --patch` output. */
  async openFullRangeDiff(): Promise<void> {
    const repo = this.repo;
    const ranges = this.ranges;
    if (!repo || !ranges) {
      await warn(vscode.l10n.t('ExDiff: No rebase ranges available, run "Show Rebase Changes" first'));
      return;
    }

    const cfg = this.host.getConfig();
    const output = await withExProgress(
      vscode.l10n.t('Loading the full range diff…'),
      async () => await this.runRangeDiff(repo, ranges, cfg, true),
    );
    const content = output.trim().length > 0 ? output : vscode.l10n.t('(no patch)');
    await this.showDocument('range-diff', content);
  }

  // --- TreeDataProvider ---------------------------------------------------

  getChildren(element?: RebaseNode): vscode.ProviderResult<RebaseNode[]> {
    if (element) return [];
    return this.nodes;
  }

  getTreeItem(node: RebaseNode): vscode.TreeItem {
    if (node.kind === 'info') {
      return new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    }

    if (node.kind === 'full') {
      const title = vscode.l10n.t('Open full range diff');
      const item = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.None);
      item.description = vscode.l10n.t('{0} commits', this.pairs.length);
      item.iconPath = new vscode.ThemeIcon('diff');
      item.command = { command: OPEN_RANGE_COMMAND, title, arguments: [null] };
      return item;
    }

    const pair = node.pair;
    const oldSha = pair.oldSha ? pair.oldSha.slice(0, 7) : '-------';
    const newSha = pair.newSha ? pair.newSha.slice(0, 7) : '-------';
    // `relationshipLabel` returns the English source string; core cannot use
    // `vscode.l10n` itself.
    const relation = vscode.l10n.t(relationshipLabel(pair.relation));
    const label = `${oldSha} ${relation} ${newSha} ${pair.subject}`.trim();

    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = `${pair.oldIndex ?? '-'} → ${pair.newIndex ?? '-'}`;
    item.tooltip = `${pair.oldSha ?? '-'} → ${pair.newSha ?? '-'}\n${pair.subject}`;
    item.iconPath = new vscode.ThemeIcon(iconFor(pair.relation));
    item.command = { command: OPEN_RANGE_COMMAND, title: vscode.l10n.t('Open patch'), arguments: [pair.index] };
    return item;
  }

  // --- TextDocumentContentProvider ---------------------------------------

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  dispose(): void {
    this.disposed = true;
    this.view.dispose();
    this.emitter.dispose();
    this.contentEmitter.dispose();
  }

  // --- internals ----------------------------------------------------------

  private async loadPairs(cfg: ExDiffConfig): Promise<void> {
    const repo = this.repo;
    const ranges = this.ranges;
    if (!repo || !ranges || this.disposed) return;

    try {
      const output = await withExProgress(
        vscode.l10n.t('Running git range-diff…'),
        async () => await this.runRangeDiff(repo, ranges, cfg, false),
      );
      this.pairs = parseRangeDiff(output);
      this.emptyMessage =
        this.pairs.length === 0
          ? vscode.l10n.t('No commit pair between the two rebase ranges')
          : null;
    } catch (error) {
      this.pairs = [];
      this.emptyMessage = vscode.l10n.t('range-diff failed: {0}', errorMessage(error));
    }
    this.render();
  }

  private async runRangeDiff(
    repo: RepoInfo,
    ranges: RebaseRanges,
    cfg: ExDiffConfig,
    patch: boolean,
  ): Promise<string> {
    return await rangeDiff(
      repo,
      { base: ranges.oldBase, tip: ranges.oldTip },
      { base: ranges.newBase, tip: ranges.newTip },
      patch ? { patch: true } : undefined,
      cfg.gitPath,
    );
  }

  private render(): void {
    if (this.disposed) return;

    const nodes: RebaseNode[] = [];
    if (this.emptyMessage) {
      nodes.push({ kind: 'info', label: this.emptyMessage });
    } else {
      nodes.push({ kind: 'full' });
      for (const pair of this.pairs) nodes.push({ kind: 'pair', pair });
    }

    this.nodes = nodes;
    this.view.description = this.describe();
    this.emitter.fire();
  }

  private describe(): string {
    if (!this.ranges) return this.emptyMessage ?? '';
    const ranges = this.ranges;
    return `${short(ranges.oldBase)}..${short(ranges.oldTip)} → ${short(ranges.newBase)}..${short(ranges.newTip)}`;
  }

  private setEmpty(message: string): void {
    this.repo = null;
    this.ranges = null;
    this.pairs = [];
    this.emptyMessage = message;
    this.render();
  }

  private async showDocument(key: string, content: string): Promise<void> {
    const uri = vscode.Uri.from({
      scheme: RANGE_SCHEME,
      path: `/${repoHash(this.repo?.root ?? '')}-${key}.diff`,
    });
    this.contents.set(uri.toString(), content);
    this.contentEmitter.fire(uri);
    await vscode.window.showTextDocument(uri, { preview: true });
  }
}

function storageKey(repo: RepoInfo): string {
  return `exdiff.rebaseRanges:${repo.root}`;
}

function isRebaseRanges(value: unknown): value is RebaseRanges {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (['oldBase', 'oldTip', 'newBase', 'newTip'] as const).every(
    (key) => typeof record[key] === 'string' && (record[key] as string).length > 0,
  );
}

function iconFor(relation: RangeDiffPair['relation']): string {
  switch (relation) {
    case '=':
      return 'check';
    case '!':
      return 'diff-modified';
    case '<':
      return 'diff-removed';
    case '>':
      return 'diff-added';
    default:
      return 'question';
  }
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function repoHash(value: string): string {
  let first = 5381;
  let second = 52711;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    first = ((first << 5) + first + code) >>> 0;
    second = ((second << 5) + second + code * 31) >>> 0;
  }
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}
