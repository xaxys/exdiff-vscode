# ExDiff

**English** | [简体中文](README.zh-CN.md)

[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=xaxys.ExDiff) · [GitHub source](https://github.com/xaxys/exdiff-vscode)

Review Git changes in VS Code without losing your editor smarts. ExDiff opens any two revisions of a file as **real files on disk**, so hover, Go to Definition, Find References, Find Implementations and diagnostics keep working on **both sides** of the diff.

## Why ExDiff

VS Code's built-in Git diff shows the older revision as a virtual `git:` document. It is not on disk and does not belong to any workspace folder, so the language server ignores it:

- no hover, no `F12`, no Find References;
- no lint or type diagnostics;
- no navigation into the old version of the code.

ExDiff materializes each revision as a real snapshot inside the repository and adds it to the workspace. Both sides of the diff become ordinary `file://` documents, and your language server treats the old revision exactly like normal source code.

```
Built-in diff:  [ virtual git: document ]  →  no language server  →  [ working file ]
ExDiff:         [ real snapshot file    ]  →  language server ✅  →  [ working file ]
```

ExDiff only reads Git objects. It never modifies your working tree, index, refs or reflog.

## Features

- **Language features on both sides** — hover, Go to Definition, Find References, Find Implementations (where supported) and diagnostics.
- **Review a single-commit branch** — compare against a configurable base (`HEAD~1` by default), or exactly `HEAD~1 ↔ HEAD`.
- **Amend-friendly** — see what the last `git commit --amend` actually changed.
- **Rebase review** — `git range-diff` commit pairs with per-pair patches, including how conflicts were resolved.
- **Staged-only review** — `HEAD ↔ index` with no unstaged noise.
- **Any two refs** — branches, remote branches, tags, recent commits and reflog entries.
- **Changes view** — statuses, line counts, renames and automatic refresh.
- **Read-only and offline** — no telemetry, no network access, no background Git mutations.

## Requirements

- VS Code **1.85** or newer.
- Git on `PATH` (or point `exdiff.gitPath` at the executable).
- A language server that supports multi-root workspaces. TypeScript/JavaScript, Go and Python work out of the box; see [Limitations](#limitations) for Rust, C/C++ and others.

## Install

- **Marketplace**: install [ExDiff](https://marketplace.visualstudio.com/items?itemName=xaxys.ExDiff) from the Visual Studio Marketplace.
- **VSIX**: `code --install-extension exdiff-0.2.3.vsix`

Reload the window after installing.

## Quick start

1. Open a Git repository in VS Code.
2. Open a file, right-click it, and choose **ExDiff: Open Changes with Base** (or run it from the Command Palette).
3. Hover, press `F12`, or press `Shift+F12` on the left-hand (old) side.

The first time, VS Code asks whether to add the snapshot folder to the workspace. Choose **Add** — this is what makes language features work on the old revision. The answer is remembered.

## Commands

| Command | What it does |
|---|---|
| **ExDiff: Open Changes with Base** | Current file vs `exdiff.baseRef` (default `HEAD~1`). The right side is the working tree or `HEAD`, depending on `exdiff.rightSide`. |
| **ExDiff: Open Changes with Previous Amend** | `HEAD@{1}` vs the current version. Useful right after `git commit --amend`. Asks for confirmation when the last reflog entry is not an amend. |
| **ExDiff: Open Changes with Previous Commit** | `HEAD~1` vs `HEAD`. Shows exactly what the latest commit changed, ignoring settings and uncommitted edits. |
| **ExDiff: Open Changes with HEAD (uncommitted)** | `HEAD` vs the working tree, including unstaged and untracked changes. |
| **ExDiff: Open Changes with HEAD (staged only)** | `HEAD` vs the index, so only staged changes are shown. |
| **ExDiff: Show Changed Files** | Focuses the **Changes** view for the current repository. |
| **ExDiff: Compare Two Refs…** | Picks any two branches, tags, commits or reflog entries and lists the changed files. |
| **ExDiff: Show Rebase Changes** | Detects the last rebase and shows `git range-diff` commit pairs with per-pair patches. |
| **ExDiff: Open Base Version of This File** | Opens the base revision as a normal editor, with the full language server. |
| **ExDiff: Swap Sides** | Swaps the two sides of the current comparison. |
| **ExDiff: Set Base Ref…** | Picks a base revision and saves it to `exdiff.baseRef`. |
| **ExDiff: Refresh** | Re-reads the Changes and Rebase views. |
| **ExDiff: Attach Snapshots** | Adds existing snapshot folders to the workspace. |
| **ExDiff: Detach Snapshots** | Removes snapshot folders from the workspace without deleting them. Useful to remove duplicate Find References hits. |
| **ExDiff: Delete Snapshots** | Removes and deletes all snapshots for the repository. |
| **ExDiff: Prune Stale Snapshots** | Deletes snapshots older than `exdiff.snapshotRetentionDays` after confirmation. |

### Where to find the commands

- **Command Palette** — press `Ctrl+Shift+P` and type `ExDiff`.
- **Editor title bar** — compare with base, open the base version.
- **Editor context menu** — the `ExDiff` group.
- **Explorer context menu** — on files: compare with base.
- **Activity Bar** — the ExDiff icon opens **Changes** and **Rebase Changes** views.

## Views

### Changes

Lists every file changed between the base and `HEAD`, with its status (added, modified, deleted, renamed…), line counts and rename mapping. Click a file to open a diff whose two sides are real files. The view refreshes on save, window focus, configuration changes and Git ref/index updates.

### Rebase Changes

After a rebase, lists the commit pairs reported by `git range-diff`:

| Marker | Meaning |
|---|---|
| `=` | unchanged |
| `!` | rewritten (the patch shows what changed, including conflict resolution) |
| `<` | only in the old range |
| `>` | only in the new range |

Select a pair to read its patch, or open the full range diff.

## Settings

| Setting | Default | Description |
|---|---|---|
| `exdiff.baseRef` | `HEAD~1` | Revision used as the base (left side). Any revision accepted by `git rev-parse`, such as `HEAD~1`, `origin/main`, a tag or a commit SHA. |
| `exdiff.snapshotDir` | `${repoRoot}/.exdiff` | Where snapshots are stored. Supports `${repoRoot}`, `${repoParent}`, `${repoName}` and `${slot}`. The default lives inside the repository and is self-ignored, so `git status` stays clean. Deleting the repository also deletes this folder. |
| `exdiff.autoAttach` | `ask` | Whether snapshot folders are added to the workspace automatically: `ask`, `always` or `never`. |
| `exdiff.rightSide` | `workingTree` | Right side of the diff: the working tree (includes uncommitted changes) or the `HEAD` snapshot. |
| `exdiff.gitPath` | `git` | Path to the Git executable. |
| `exdiff.maxFilesInTree` | `2000` | Maximum number of files listed in the Changes view. |
| `exdiff.snapshotRetentionDays` | `7` | Snapshots older than this are pruned. At startup only temporary `ref-*` snapshots are pruned; the Prune command removes all expired snapshots. `0` disables pruning. |

## Typical workflows

### Review the single commit on a branch

A common workflow is to keep a branch exactly one commit ahead of a base branch and amend that commit repeatedly:

1. Run **ExDiff: Open Changes with Base**.
2. The left side is a real checkout of `HEAD~1`; the right side is your working file.
3. Use hover, `F12` and Find References on either side.

If you want to ignore uncommitted changes, set `exdiff.rightSide` to `ref`.

### Review exactly the latest commit

Run **ExDiff: Open Changes with Previous Commit**. This compares `HEAD~1` and `HEAD` only, regardless of your settings or uncommitted edits.

### Work with an amend loop

1. `git commit --amend`.
2. Run **ExDiff: Open Changes with Previous Amend**.
3. The left side is the pre-amend commit (`HEAD@{1}`); the right side follows `exdiff.rightSide`.

### Review a rebase

1. `git fetch upstream && git rebase upstream/master`.
2. Run **ExDiff: Show Rebase Changes**.
3. Open a commit pair to see how the patch changed. Pairs marked `!` were rewritten — often because of conflict resolution.

The detected ranges are cached per repository, so the review survives a window reload.

### Review only staged changes

Run **ExDiff: Open Changes with HEAD (staged only)**. The index is materialized with `git write-tree`, so unstaged edits are excluded.

### Compare arbitrary revisions

Run **ExDiff: Compare Two Refs…** and pick two branches, tags, commits or reflog entries. The Changes view switches to that comparison.

## How it works

- ExDiff materializes a revision into `<repoRoot>/.exdiff/<snapshot>` using a temporary index and `git checkout-index`. The snapshot contains no `.git`, so it is not treated as another repository.
- The snapshot folder is added to the workspace with `vscode.workspace.updateWorkspaceFolders()`. That is what makes the language server index it.
- Snapshots are updated incrementally when the revision changes, and reused when it does not.
- The `.exdiff` folder carries its own `.gitignore`, so the snapshots, sidecars and temporary files never appear in `git status`.
- ExDiff never writes to your working tree, index, refs or reflog. `git write-tree` only creates an unreachable tree object for the staged-only comparison.

## Limitations

1. **Duplicate Find References** — the snapshot and the real repository both contain the code, so references appear twice. Run **Detach Snapshots** when you are not reviewing.
2. **Multi-root language servers** — TypeScript/JavaScript, Go and Python work well. Rust (`linkedProjects`), C/C++ (`compile_commands.json`) and some JVM/Kotlin servers need extra configuration, and cross-snapshot navigation is not guaranteed.
3. **Disk and memory** — each snapshot is roughly the size of the tracked files, and every attached snapshot adds another LSP index. Use **Detach Snapshots** or **Delete Snapshots** to reclaim space.
4. **First materialization is slow** on large repositories. Later updates are incremental, and an unchanged revision is reused.
5. **Submodules** are not materialized; their entries appear as empty directories.
6. **Single-folder workspaces** — adding the first snapshot folder may restart the extension host (VS Code behavior when a single-folder workspace becomes multi-root). The diff tab is restored; re-run the command if it was interrupted. Saving a multi-root `.code-workspace` avoids this.
7. **Diff editor features** — peek, some rename refactorings and some code actions are still more limited than in a normal editor. Use **Open Base Version of This File** for the full experience.
8. **Snapshots are disposable** — manual edits are not detected. Delete the snapshots to rebuild them.
9. **Cleanup** — temporary `ref-*` snapshots are pruned at startup after `exdiff.snapshotRetentionDays` (default 7). **Prune Stale Snapshots** removes all expired snapshots. **Detach** only changes the workspace; **Delete** removes files from disk.
10. **Snapshots inside the repository** — tools that scan the whole working tree (some linters, test runners or build scripts) may also visit `.exdiff`. Add `.exdiff` to their ignore configuration if necessary, or point `exdiff.snapshotDir` at a folder outside the repository.

## Troubleshooting

| Symptom | What to do |
|---|---|
| The old side has no hover, `F12` or diagnostics | The snapshot folder is not part of the workspace. Run **ExDiff: Attach Snapshots**, or set `exdiff.autoAttach` to `always`. |
| “Not in a Git repository” | The file is outside any repository, or the repository is bare. Check that `git rev-parse --show-toplevel` works; set `exdiff.gitPath` if Git is not on `PATH`. |
| “Base ref not found” | The repository has no parent commit, or `exdiff.baseRef` is invalid. Use **ExDiff: Set Base Ref…** to pick `HEAD`, a branch or a commit. |
| “No commits yet” | Create the first commit, then run the command again. |
| Find References shows two hits | Expected: one in the snapshot, one in the real repository. Run **ExDiff: Detach Snapshots** when you are done reviewing. |
| A snapshot does not match the revision | The snapshot was edited manually. Run **ExDiff: Delete Snapshots** and open the diff again. |
| “Unable to add the snapshot folder to the workspace” | The workspace file is read-only, the folder is already present, or the workspace is untrusted. Add the folder manually or make the workspace writable. |
| **ExDiff: Show Rebase Changes** finds nothing | It needs `ORIG_HEAD` and a `rebase (start)` reflog entry. A later operation may have overwritten `ORIG_HEAD`; use **Compare Two Refs…** with the two ranges instead. |
| Snapshots use too much disk | Run **ExDiff: Delete Snapshots**, lower `exdiff.snapshotRetentionDays`, or delete `<repoRoot>/.exdiff` manually after detaching. |
| The first diff on a large repository is slow | The initial checkout is a full materialization. Later updates are incremental; `exdiff.snapshotDir` can point at a faster disk. |

## Language

ExDiff ships with English and Simplified Chinese UI strings. It follows VS Code's display language; switch with **Configure Display Language** and restart. Other languages fall back to English.

## Privacy

ExDiff has no telemetry, makes no network requests, and never uploads your code. Everything runs locally.

## License

MIT © 2026 xaxys. See [LICENSE](LICENSE).
