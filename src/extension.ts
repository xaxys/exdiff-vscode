import * as vscode from 'vscode';

import { resolveRepo } from './core/git';
import { ChangesView } from './ui/changesView';
import { registerCommands } from './ui/commands';
import { reportError, errorMessage } from './ui/errors';
import { createHost, type UiHost } from './ui/host';
import { pruneStaleSnapshots } from './ui/maintenance';
import { RebaseView, RANGE_SCHEME } from './ui/rebaseView';
import { workspaceRepos } from './ui/repo';
import { ATTACH_CONSENT_KEY, attachSnapshots } from './ui/workspaceFolders';

/**
 * ExDiff activation.
 *
 * Besides wiring the UI it re-attaches snapshot folders that already exist on
 * disk (when the user agreed once, or `exdiff.autoAttach` is `always`). It
 * deliberately never materializes a snapshot here: activation must not trigger
 * a large checkout.
 */
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('ExDiff');
  context.subscriptions.push(output);

  const host = createHost(context, output);
  const changesView = new ChangesView(host);
  const rebaseView = new RebaseView(host);

  context.subscriptions.push(changesView, rebaseView);
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(RANGE_SCHEME, rebaseView));

  registerCommands(host, changesView, rebaseView);

  output.appendLine(`[${new Date().toISOString()}] ExDiff activated`);

  void maintainSnapshots(host).catch((error: unknown) => reportError(output, 'activate', error));
  void rebaseView.restoreFromCache().catch((error: unknown) => reportError(output, 'restoreRebase', error));
}

export function deactivate(): void {
  // Everything is registered on the extension context and disposed by VS Code.
}

/**
 * Prunes stale ad-hoc snapshots and then re-attaches the snapshot folders that
 * already exist.
 *
 * Only `ref-*` slots are pruned automatically: they are created by
 * "Compare Two Refs…" and grow without bound. The fixed slots (`base`, `head`,
 * `index`, `amend`, `prev`) are refreshed on demand and are left to the
 * explicit "Prune Stale Snapshots" command.
 */
async function maintainSnapshots(host: UiHost): Promise<void> {
  const cfg = host.getConfig();
  if (cfg.snapshotRetentionDays > 0) {
    for (const repo of await workspaceRepos(cfg)) {
      try {
        const result = await pruneStaleSnapshots(repo, cfg, { onlyAdHoc: true });
        if (result.removed > 0) {
          host.output.appendLine(
            `[${new Date().toISOString()}] pruned ${result.removed} stale snapshot(s): ${result.slots.join(', ')}`,
          );
        }
      } catch (error) {
        host.output.appendLine(
          `[${new Date().toISOString()}] pruning ${repo.root} failed: ${errorMessage(error)}`,
        );
      }
    }
  }
  await reattachSnapshots(host);
}

async function reattachSnapshots(host: UiHost): Promise<void> {
  const cfg = host.getConfig();
  if (cfg.autoAttach === 'never') return;

  const consent = host.context.globalState.get<string>(ATTACH_CONSENT_KEY);
  if (cfg.autoAttach !== 'always' && consent !== 'yes') return;

  const seen = new Set<string>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') continue;
    const repo = await resolveRepo(folder.uri.fsPath, cfg.gitPath);
    if (!repo) continue;

    const key = process.platform === 'win32' ? repo.root.toLowerCase() : repo.root;
    if (seen.has(key)) continue;
    seen.add(key);

    const count = await attachSnapshots(repo, cfg, { quiet: true });
    if (count > 0) {
      host.output.appendLine(`Re-attached ${count} snapshot folder(s) for ${repo.root}`);
    }
  }
}
