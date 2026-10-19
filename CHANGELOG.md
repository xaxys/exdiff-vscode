# Changelog

All notable changes to the ExDiff extension are documented here.

## 0.2.5

### Fixed

- `auto` no longer assumes `main` or `master`. It reads the current branch's
  reflog creation entry (`branch: Created from …`) to find the real parent
  branch/commit, falls back to the nearest merge-base among local and remote
  branches, then `HEAD~1`. This handles branches forked from arbitrary branches
  (for example `team/feature-a`) and amended branches.

> 0.2.4 introduced fork-point comparison but used main/master heuristics.
> 0.2.5 replaces that heuristic.

## 0.2.4

### Added

- **Fork-point base comparison.** **ExDiff: Open Changes with Base** now compares
  from `git merge-base <baseRef> HEAD`, so it shows only the current branch's
  changes. Commits that landed on the base branch after divergence are excluded.
- `exdiff.baseRef` defaults to `auto`, which detects `origin/HEAD`,
  `upstream/HEAD`, `origin/main`, `origin/master`, `upstream/main`,
  `upstream/master`, `main`, `master`, then falls back to `HEAD~1`.
- **ExDiff: Set Base Ref…** now offers **Auto-detect base branch**.

### Changed

- Base labels include the resolved ref and fork commit, for example
  `origin/main@abc1234`.

> Upgrading from 0.2.3: if `exdiff.baseRef` is explicitly set to `HEAD~1`,
> change it to `auto` or to a base branch such as `origin/main`.

## 0.2.3 — First public release

### Added

- **Real-file diffs with full language support.** Every revision is materialized
  into `<repoRoot>/.exdiff/<snapshot>` with a temporary index and
  `git checkout-index`, then added to the workspace. Hover, Go to Definition,
  Find References, Find Implementations and diagnostics work on both sides of
  the diff.
- **Comparisons:** base, previous commit, previous amend, working tree, staged
  only (`HEAD ↔ index`), and any two refs.
- **Rebase review:** `git range-diff` commit pairs with per-pair patches,
  including conflict resolutions.
- **Changes view:** statuses, line counts, renames and automatic refresh.
- **Localization:** English and Simplified Chinese UI, following VS Code's
  display language.
- **Snapshot cleanup:** `exdiff.snapshotRetentionDays` (default 7) prunes stale
  ad-hoc snapshots at startup; **ExDiff: Prune Stale Snapshots** removes all
  expired snapshots.
- **Marketplace metadata:** icon, categories, keywords, gallery banner and
  bilingual documentation.

### Fixed

- Use the valid Marketplace category `SCM Providers` (`Source Control` is only its display name).
