'use strict';

/**
 * Runs inside a real VS Code extension host.
 *
 * Verifies that the extension activates, that every contributed command is
 * registered, and that the diff/editor commands really open diffs whose two
 * sides are on-disk files (the whole point of ExDiff).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const COMMANDS = [
  'exdiff.openFileWithBase',
  'exdiff.openFileWithAmendPrev',
  'exdiff.openFileWithPreviousCommit',
  'exdiff.openFileWorkingTree',
  'exdiff.openFileStaged',
  'exdiff.showChanges',
  'exdiff.compareRefs',
  'exdiff.showRebaseChanges',
  'exdiff.openBaseSide',
  'exdiff.swapSides',
  'exdiff.pickBaseRef',
  'exdiff.refresh',
  'exdiff.attachSnapshots',
  'exdiff.detachSnapshots',
  'exdiff.cleanSnapshots',
  'exdiff.pruneSnapshots',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, predicate, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function allTabs() {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
}

function isTextDiff(tab) {
  return (
    typeof vscode.TabInputTextDiff === 'function' &&
    tab.input instanceof vscode.TabInputTextDiff
  );
}

async function execute(id) {
  const timeout = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`${id} did not finish within 60s (a notification may be blocking)`)),
      60000,
    ),
  );
  await Promise.race([Promise.resolve(vscode.commands.executeCommand(id)), timeout]);
}

exports.run = async function run() {
  const extension = vscode.extensions.getExtension('xaxys.exdiff');
  assert.ok(extension, 'xaxys.exdiff extension was not discovered');
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  for (const id of COMMANDS) {
    assert.ok(commands.includes(id), `${id} is not registered`);
  }

  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the test workspace folder is missing');
  const repo = folder.uri.fsPath;

  await vscode.workspace
    .getConfiguration('exdiff')
    .update('autoAttach', 'always', vscode.ConfigurationTarget.Workspace);

  const file = path.join(repo, 'a.txt');
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));

  await execute('exdiff.openFileWithBase');

  const firstDiff = await waitFor('the base diff editor', () =>
    allTabs().find(
      (tab) =>
        isTextDiff(tab) &&
        tab.input.original.fsPath.includes(`${path.sep}.exdiff${path.sep}`) &&
        tab.input.original.fsPath.endsWith('a.txt'),
    ),
  );
  assert.equal(path.resolve(firstDiff.input.modified.fsPath), path.resolve(file));
  assert.match(firstDiff.label, /HEAD~1/, `unexpected diff title: ${firstDiff.label}`);

  const snapshotFolder = await waitFor('the base snapshot workspace folder', () =>
    (vscode.workspace.workspaceFolders ?? []).find((item) => item.name.endsWith('[base]')),
  );
  assert.equal(path.basename(snapshotFolder.uri.fsPath), 'base');
  assert.equal(
    path.dirname(snapshotFolder.uri.fsPath),
    path.join(repo, '.exdiff'),
    'the snapshot must live inside the repository',
  );
  assert.equal(
    fs.existsSync(path.join(path.dirname(repo), '.exdiff')),
    false,
    'snapshots must not be created next to the repository',
  );

  // Staged-only comparison: left = HEAD snapshot, right = index snapshot.
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
  await execute('exdiff.openFileStaged');
  const stagedDiff = await waitFor('the staged diff editor', () =>
    allTabs().find((tab) => isTextDiff(tab) && /Index/.test(tab.label)),
  );
  assert.match(stagedDiff.input.original.fsPath, /[\\/]head[\\/]a\.txt$/);
  assert.match(stagedDiff.input.modified.fsPath, /[\\/]index[\\/]a\.txt$/);
  const indexed = await vscode.workspace.openTextDocument(stagedDiff.input.modified);
  assert.match(indexed.getText(), /three/, 'the index side must contain the staged content');

  // HEAD~1 ↔ HEAD: both sides are committed snapshots and the staged edit must
  // not leak into the diff.
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
  await execute('exdiff.openFileWithPreviousCommit');
  const commitDiff = await waitFor('the previous-commit diff editor', () =>
    allTabs().find((tab) => isTextDiff(tab) && tab.label.includes('HEAD~1')),
  );
  assert.match(commitDiff.input.original.fsPath, /[\\/]prev[\\/]a\.txt$/);
  assert.match(commitDiff.input.modified.fsPath, /[\\/]head[\\/]a\.txt$/);
  const committed = await vscode.workspace.openTextDocument(commitDiff.input.modified);
  assert.doesNotMatch(committed.getText(), /three/, 'the HEAD side must not include staged changes');

  // Uncommitted comparison and the base side as a normal editor.
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
  await execute('exdiff.openFileWorkingTree');
  await execute('exdiff.openBaseSide');

  const baseSide = await waitFor('the base version editor', () =>
    vscode.window.visibleTextEditors.find((editor) =>
      editor.document.uri.fsPath.includes(`${path.sep}base${path.sep}`),
    ),
  );
  assert.ok(baseSide.document.uri.fsPath.endsWith('a.txt'));

  // The Changes view must refresh without throwing.
  await execute('exdiff.showChanges');
  await execute('exdiff.refresh');

  // Detach every snapshot folder, then re-attach them from disk.
  const folderNames = () => (vscode.workspace.workspaceFolders ?? []).map((item) => item.name).join(', ');
  console.log(`[ExDiff IT] folders before detach: ${folderNames()}`);
  await execute('exdiff.detachSnapshots');
  console.log(`[ExDiff IT] folders after detach: ${folderNames()}`);
  await waitFor(
    'all snapshot folders to be detached',
    () =>
      (vscode.workspace.workspaceFolders ?? []).every(
        (item) => !/\[(base|head|index|amend)\]$/.test(item.name),
      ),
  );

  await execute('exdiff.attachSnapshots');
  await waitFor(
    'the base snapshot folder to be re-attached',
    () => (vscode.workspace.workspaceFolders ?? []).some((item) => item.name.endsWith('[base]')),
  );
};
