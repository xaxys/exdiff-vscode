/**
 * Shared data contracts for the ExDiff core layer.
 *
 * Everything below `src/core` must stay free of any `vscode` import so the
 * modules can be `require()`d from plain Node (headless tests, tooling).
 */

/** A resolved Git repository. All paths are absolute and use native separators. */
export interface RepoInfo {
  /** Working tree root (`git rev-parse --show-toplevel`). */
  root: string;
  /** Git common directory (`git rev-parse --git-common-dir`), absolute. */
  commondir: string;
  /** Git directory (`git rev-parse --absolute-git-dir`), absolute. */
  gitdir: string;
}

/** Result of a git invocation. Non-zero exits are reported, never thrown. */
export interface GitRunResult {
  stdout: string;
  stderr: string;
  /** Process exit code. `-1` when the executable could not be spawned at all. */
  exitCode: number;
}

export interface GitOptions {
  /** Working directory for the git process. */
  cwd: string;
  /** Override for the git executable. Defaults to `git`. */
  gitPath?: string;
  /** Text written to stdin before it is closed. */
  input?: string;
  /** Max captured bytes per stream. Defaults to 64 MiB. */
  maxBuffer?: number;
  /**
   * Extra environment variables, merged over `process.env`.
   * `GIT_OPTIONAL_LOCKS=0` is always injected, see `execGit`.
   */
  env?: NodeJS.ProcessEnv;
}

/** Single-letter status as reported by `git diff --name-status` (`R100` is normalised to `R`). */
export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X' | 'B';

export interface ChangedFile {
  status: FileStatus;
  /** Source path, only set for `R` (rename) and `C` (copy). Always posix. */
  oldPath?: string;
  /** Target path. Always posix and relative to the repository root. */
  newPath: string;
  /** Added lines; `null` for binary files (`-` in `--numstat`). */
  additions: number | null;
  /** Deleted lines; `null` for binary files (`-` in `--numstat`). */
  deletions: number | null;
}

export interface ReflogEntry {
  /** e.g. `HEAD@{3}` — usable as a revision. */
  selector: string;
  sha: string;
  message: string;
}

export interface RefInfo {
  /** String that can be handed to `git rev-parse` (branch, tag, `HEAD@{3}`, SHA). */
  ref: string;
  sha: string;
  /** Human readable label for pickers. */
  label: string;
  /** Optional secondary line (SHA, date, subject). */
  description?: string;
  kind: 'branch' | 'remote' | 'tag' | 'reflog' | 'commit' | 'head';
}

export interface RebaseRanges {
  oldBase: string;
  oldTip: string;
  newBase: string;
  newTip: string;
}

/** Metadata stored in the slot sidecar `<snapshotRoot>/<slot>.json`. */
export interface SnapshotMeta {
  slot: string;
  sha: string;
  /** `Date.now()` of the last successful sync. */
  syncedAt: number;
}

export interface SnapshotPaths {
  /** `<repoParent>/.exdiff/<repoName>` (after template expansion). */
  root: string;
  /** `<root>/<slot>` — the actual snapshot working tree. */
  dir: string;
  /** `<root>/<slot>.json` — sidecar, deliberately outside `dir`. */
  meta: string;
}

export interface ExDiffConfig {
  baseRef: string;
  snapshotDirTemplate: string;
  autoAttach: 'ask' | 'always' | 'never';
  rightSide: 'workingTree' | 'ref';
  gitPath: string;
  maxFilesInTree: number;
  /** Delete stale ad-hoc snapshots after this many days; 0 disables pruning. */
  snapshotRetentionDays: number;
}

export interface RangeDiffPair {
  /** 1-based position of the header line in the range-diff output. */
  index: number;
  relation: '=' | '!' | '<' | '>' | '?';
  /** `null` when the old side has no commit at this position (`-:`). */
  oldIndex: number | null;
  /** `null` when the new side has no commit at this position (`-:`). */
  newIndex: number | null;
  oldSha: string | null;
  newSha: string | null;
  subject: string;
}

/** Thrown by `git()` (and snapshot helpers) when a git command fails. */
export class GitError extends Error {
  readonly exitCode: number;
  readonly stderr: string;
  readonly argv: string[];

  constructor(message: string, exitCode: number, stderr: string, argv: string[]) {
    super(message);
    this.name = 'GitError';
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.argv = argv;
    // Keep `instanceof` working when the class is transpiled to ES5-style output.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
