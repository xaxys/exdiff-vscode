# Changelog

All notable changes to the ExDiff extension are documented here.

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
