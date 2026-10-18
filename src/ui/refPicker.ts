import * as vscode from 'vscode';

import type { RefInfo } from '../core/types';
import { revParse } from '../core/git';
import { collectRefs } from '../core/refs';
import { sanitizeSlotName } from '../core/paths';
import type { ChangesView } from './changesView';
import type { Comparison, Side } from './diff';
import { errorMessage, info, warn } from './errors';
import type { UiHost } from './host';
import { withExProgress } from './progress';
import { resolveActiveRepo } from './repo';

interface RefPickItem extends vscode.QuickPickItem {
  ref?: RefInfo;
  custom?: boolean;
}

/** QuickPick separator groups, built lazily so the titles go through l10n. */
function refGroups(): { title: string; kinds: RefInfo['kind'][] }[] {
  return [
    { title: vscode.l10n.t('Branches'), kinds: ['head', 'branch'] },
    { title: vscode.l10n.t('Remote branches'), kinds: ['remote'] },
    { title: vscode.l10n.t('Tags'), kinds: ['tag'] },
    { title: vscode.l10n.t('Recent commits'), kinds: ['commit'] },
    { title: vscode.l10n.t('Reflog'), kinds: ['reflog'] },
  ];
}

/** Kind word shown in the QuickPick description. */
function kindLabel(kind: RefInfo['kind']): string {
  switch (kind) {
    case 'head':
      return 'HEAD';
    case 'branch':
      return vscode.l10n.t('branch');
    case 'remote':
      return vscode.l10n.t('remote');
    case 'tag':
      return vscode.l10n.t('tag');
    case 'commit':
      return vscode.l10n.t('commit');
    case 'reflog':
      return vscode.l10n.t('reflog');
  }
}

/** Two QuickPicks, then hands the chosen ref/ref comparison to the Changes view. */
export async function compareRefs(host: UiHost, view: ChangesView): Promise<void> {
  const cfg = host.getConfig();
  const repo = await resolveActiveRepo(cfg);
  if (!repo) {
    await warn(vscode.l10n.t('ExDiff: Current file is not in a Git repository'));
    return;
  }

  const refs = await withExProgress(
    vscode.l10n.t('Reading refs…'),
    async () => await collectRefs(repo, cfg.gitPath),
  );
  if (refs.length === 0) {
    await warn(vscode.l10n.t('ExDiff: The repository has no refs'));
    return;
  }

  const left = await pickRef(
    refs,
    vscode.l10n.t('Left ref'),
    vscode.l10n.t('Select the left (base) ref'),
  );
  if (!left) return;

  const right = await pickRef(
    refs,
    vscode.l10n.t('Right ref'),
    vscode.l10n.t('Select the right ref'),
  );
  if (!right) return;

  if (left.ref === right.ref) {
    await warn(vscode.l10n.t('ExDiff: The same ref was selected twice, no comparison was created'));
    return;
  }

  const leftSha = await revParse(repo, left.ref, cfg.gitPath);
  const rightSha = await revParse(repo, right.ref, cfg.gitPath);
  if (!leftSha || !rightSha) {
    await warn(
      vscode.l10n.t(
        'ExDiff: The selected ref cannot be resolved to a commit (it may point to a blob/tree), pick another one',
      ),
    );
    return;
  }

  const comparison: Comparison = {
    repo,
    // The short SHA keeps the slot stable when a branch moves while the diff is
    // open, and keeps `feature/x` / `feature-x` from sharing one directory.
    left: {
      kind: 'snapshot',
      slot: `ref-${sanitizeSlotName(left.ref)}-${leftSha.slice(0, 7)}`,
      sha: leftSha,
      label: left.label,
    },
    right: {
      kind: 'snapshot',
      slot: `ref-${sanitizeSlotName(right.ref)}-${rightSha.slice(0, 7)}`,
      sha: rightSha,
      label: right.label,
    },
    leftLabel: left.label,
    rightLabel: right.label,
  };

  view.setComparison(comparison);
  await vscode.commands.executeCommand('exdiff.changes.focus');
}

/** Picks any ref (or a typed revision) and persists it as `exdiff.baseRef`. */
export async function pickBaseRef(host: UiHost, view: ChangesView): Promise<void> {
  const cfg = host.getConfig();
  const repo = await resolveActiveRepo(cfg);
  if (!repo) {
    await warn(vscode.l10n.t('ExDiff: Current file is not in a Git repository'));
    return;
  }

  const refs = await withExProgress(
    vscode.l10n.t('Reading refs…'),
    async () => await collectRefs(repo, cfg.gitPath),
  );
  const items = buildItems(refs);
  items.unshift({ label: vscode.l10n.t('$(edit) Enter a custom revision…'), alwaysShow: true, custom: true });

  const picked = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t('Base ref'),
    placeHolder: vscode.l10n.t('Current: {0}', cfg.baseRef),
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  if (!picked) return;

  let value: string | undefined;
  if (picked.custom) {
    value = await vscode.window.showInputBox({
      title: vscode.l10n.t('Base ref'),
      prompt: vscode.l10n.t(
        'Any revision that git rev-parse understands (for example HEAD~1, origin/main, v1.0)',
      ),
      value: cfg.baseRef,
      ignoreFocusOut: true,
      validateInput: (input) => (input.trim().length === 0 ? vscode.l10n.t('Must not be empty') : undefined),
    });
  } else {
    value = picked.ref?.ref;
  }

  const trimmed = value?.trim();
  if (!trimmed) return;

  await updateBaseRef(trimmed);
  await info(vscode.l10n.t('ExDiff: Base ref set to "{0}"', trimmed));
  view.resetComparison();
  await view.refresh();
}

/** Swaps the two sides of the current Changes-view comparison. */
export async function swapSides(view: ChangesView): Promise<void> {
  const comparison = view.getComparison();
  if (!comparison) {
    await warn(vscode.l10n.t('ExDiff: There is no comparison to swap'));
    return;
  }
  if (comparison.left.kind !== 'snapshot' || comparison.right.kind !== 'snapshot' || isIndexSide(comparison.left) || isIndexSide(comparison.right)) {
    await warn(
      vscode.l10n.t(
        'ExDiff: Only comparisons where both sides are materializable snapshots can be swapped; the working tree side and the index (temporary tree object) cannot be a snapshot left side',
      ),
    );
    return;
  }

  const swapped: Comparison = {
    ...comparison,
    left: comparison.right,
    right: comparison.left,
    leftLabel: comparison.rightLabel,
    rightLabel: comparison.leftLabel,
  };
  view.setComparison(swapped);
}

async function pickRef(refs: RefInfo[], title: string, placeHolder: string): Promise<RefInfo | undefined> {
  const items = buildItems(refs);
  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder,
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  return picked?.ref;
}

function buildItems(refs: RefInfo[]): RefPickItem[] {
  const items: RefPickItem[] = [];
  for (const group of refGroups()) {
    const matching = refs.filter((ref) => group.kinds.includes(ref.kind));
    if (matching.length === 0) continue;
    items.push({ label: group.title, kind: vscode.QuickPickItemKind.Separator });
    for (const ref of matching) items.push(toItem(ref));
  }
  return items;
}

function toItem(ref: RefInfo): RefPickItem {
  const selector = ref.kind === 'reflog' ? ` · ${ref.ref}` : '';
  return {
    label: ref.label,
    description: `${kindLabel(ref.kind)} · ${ref.sha.slice(0, 7)}${selector}`,
    detail: ref.description,
    ref,
  };
}

function isIndexSide(side: Side): boolean {
  return side.kind === 'snapshot' && side.slot === 'index';
}

async function updateBaseRef(value: string): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('exdiff');
  const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
  const preferred = hasWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;

  try {
    await configuration.update('baseRef', value, preferred);
  } catch (error) {
    if (preferred === vscode.ConfigurationTarget.Global) {
      throw new Error(vscode.l10n.t('Cannot write exdiff.baseRef: {0}', errorMessage(error)));
    }
    // `.vscode/settings.json` may be read-only (or the workspace untrusted):
    // fall back to the user setting instead of failing the command.
    await configuration.update('baseRef', value, vscode.ConfigurationTarget.Global);
  }
}
