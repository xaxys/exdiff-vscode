import { execFile } from 'node:child_process';
import * as path from 'node:path';

import type {
  ChangedFile,
  FileStatus,
  GitOptions,
  GitRunResult,
  RebaseRanges,
  ReflogEntry,
  RefInfo,
  RepoInfo,
} from './types';
import { GitError } from './types';

/** 64 MiB is plenty for `--name-status -z` / `--numstat -z` on huge change sets. */
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

const FILE_STATUSES = new Set<string>(['A', 'M', 'D', 'R', 'C', 'T', 'U', 'X', 'B']);

/** Field separator for `for-each-ref`, which does not understand `%x00`. */
const REF_FIELD_SEPARATOR = '\u001f';

const REF_FORMAT = [
  '%(refname)',
  '%(objectname)',
  '%(*objectname)',
  '%(objecttype)',
  '%(HEAD)',
  '%(committerdate:iso-strict)',
  '%(subject)',
  '%(symref)',
  // Appended (not inserted) so the indexes above stay stable. Used to reject
  // tags that point at blobs/trees instead of commits.
  '%(*objecttype)',
].join(REF_FIELD_SEPARATOR);

/**
 * Runs git and never rejects because of a non-zero exit code.
 *
 * Always sets `GIT_OPTIONAL_LOCKS=0` so read-only queries never refresh (and
 * therefore never rewrite) the user's index. Never passes `shell: true`.
 */
export async function execGit(args: string[], opts: GitOptions): Promise<GitRunResult> {
  const command = opts.gitPath?.trim() || 'git';
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...opts.env };

  return new Promise<GitRunResult>((resolve) => {
    const child = execFile(
      command,
      args,
      {
        cwd: opts.cwd,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
        env,
      },
      (error, stdout, stderr) => {
        let exitCode = 0;
        if (error) {
          exitCode = typeof error.code === 'number' ? error.code : -1;
        }
        const capturedErr = stderr ?? '';
        resolve({
          stdout: stdout ?? '',
          // Spawn failures (ENOENT, EACCES, maxBuffer) carry no stderr of their own.
          stderr: capturedErr || (error && typeof error.code !== 'number' ? error.message : ''),
          exitCode,
        });
      },
    );

    // git may exit before it reads stdin; EPIPE must not crash the extension host.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(opts.input ?? '');
  });
}

/** Runs git, throws {@link GitError} on a non-zero exit code and trims stdout. */
export async function git(args: string[], opts: GitOptions): Promise<string> {
  return (await gitOrThrow(args, opts)).trim();
}

async function gitOrThrow(args: string[], opts: GitOptions): Promise<string> {
  const result = await execGit(args, opts);
  if (result.exitCode !== 0) {
    throw new GitError(gitFailureMessage(args, result.exitCode, result.stderr), result.exitCode, result.stderr, args);
  }
  return result.stdout;
}

function gitFailureMessage(args: string[], exitCode: number, stderr: string): string {
  const command = ['git', ...args].join(' ');
  const detail = stderr.trim();
  return detail ? `${command} failed with exit code ${exitCode}: ${detail}` : `${command} failed with exit code ${exitCode}`;
}

/**
 * Resolves the repository that contains `fromDir`.
 * Returns `null` for non-repositories, bare repositories and unreadable directories.
 */
export async function resolveRepo(fromDir: string, gitPath?: string): Promise<RepoInfo | null> {
  const cwd = path.resolve(fromDir);
  const result = await execGit(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], {
    cwd,
    gitPath,
  });
  if (result.exitCode !== 0) return null;

  const lines = result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length < 3) return null;

  const root = path.resolve(cwd, lines[0]);
  const gitdir = path.resolve(cwd, lines[1]);
  // `--git-common-dir` is printed relative to the current directory (e.g. `../../.git`).
  const commondir = path.resolve(cwd, lines[2]);
  if (!root || !gitdir || !commondir) return null;

  return { root, commondir, gitdir };
}

/** Resolves `rev` to a commit SHA. Returns `null` when it is not a valid commit. */
export async function revParse(repo: RepoInfo, rev: string, gitPath?: string): Promise<string | null> {
  const result = await execGit(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], {
    cwd: repo.root,
    gitPath,
  });
  if (result.exitCode !== 0) return null;
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
}

/** `HEAD` as a commit SHA, or `null` on an unborn branch. */
export async function headSha(repo: RepoInfo, gitPath?: string): Promise<string | null> {
  const result = await execGit(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: repo.root, gitPath });
  if (result.exitCode !== 0) return null;
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
}

/** A base ref resolved to its fork point with `HEAD`. */
export interface ResolvedBase {
  /** Ref that was used, for example `origin/main`, `main` or `HEAD~1`. */
  ref: string;
  /** Merge-base commit with `HEAD`, or the ref tip when there is no common ancestor. */
  sha: string;
  /** True when `sha` is the merge-base rather than the ref tip. */
  mergeBase: boolean;
}

/** `git merge-base a b`, or `null` when there is no common ancestor / a ref is invalid. */
export async function mergeBase(
  repo: RepoInfo,
  a: string,
  b: string,
  gitPath?: string,
): Promise<string | null> {
  const result = await execGit(['merge-base', a, b], { cwd: repo.root, gitPath });
  if (result.exitCode !== 0) return null;
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
}

/** Current branch name, or `null` for a detached HEAD / unborn branch. */
export async function currentBranch(repo: RepoInfo, gitPath?: string): Promise<string | null> {
  const result = await execGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: repo.root,
    gitPath,
  });
  if (result.exitCode !== 0) return null;
  const name = result.stdout.trim();
  return name.length > 0 ? name : null;
}

/** `true` when `ancestor` is an ancestor of (or equal to) `descendant`. */
async function isAncestor(
  repo: RepoInfo,
  ancestor: string,
  descendant: string,
  gitPath?: string,
): Promise<boolean> {
  const result = await execGit(['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: repo.root,
    gitPath,
  });
  return result.exitCode === 0;
}

/** Human-readable label for a reflog start point. */
function baseRefLabel(start: string): string {
  if (!start || start === 'HEAD') return 'fork';
  if (/^[0-9a-f]{7,40}$/i.test(start)) return `fork@${start.slice(0, 7)}`;
  return start.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '');
}

/**
 * Fork point recorded when the current branch was created.
 *
 * `git reflog show <branch>` keeps a `branch: Created from <start>` entry. The
 * entry's commit is the parent tip at creation; prefer it while it is still an
 * ancestor of HEAD (amends do not change it). If the branch was rebased onto a
 * new base, fall back to the merge-base with the named start ref.
 */
async function creationFork(repo: RepoInfo, gitPath?: string): Promise<ResolvedBase | null> {
  const branch = await currentBranch(repo, gitPath);
  if (!branch) return null;

  const result = await execGit(
    ['reflog', 'show', '--format=%H%x00%gs', `refs/heads/${branch}`],
    { cwd: repo.root, gitPath },
  );
  if (result.exitCode !== 0) return null;

  for (const line of result.stdout.split(/\r?\n/)) {
    const separator = line.indexOf('\0');
    if (separator <= 0) continue;

    const sha = line.slice(0, separator).trim();
    const subject = line.slice(separator + 1);
    const match = /^branch: Created from (.+)$/.exec(subject);
    if (!match) continue;

    const start = match[1].trim();
    const label = baseRefLabel(start);
    const display = label === 'fork' && sha ? `fork@${sha.slice(0, 7)}` : label;

    if (sha && (await isAncestor(repo, sha, 'HEAD', gitPath))) {
      return { ref: display, sha, mergeBase: true };
    }

    if (start && start !== 'HEAD') {
      const tip = await revParse(repo, start, gitPath);
      if (tip) {
        const base = await mergeBase(repo, start, 'HEAD', gitPath);
        return { ref: label, sha: base ?? tip, mergeBase: base !== null };
      }
    }
    return null;
  }
  return null;
}

/**
 * Nearest fork point among local and remote branches when the reflog has no
 * creation entry (cloned refs, expired reflogs, detached HEAD). Picks the
 * branch whose merge-base with HEAD has the fewest commits in between.
 */
async function nearestBranchFork(repo: RepoInfo, gitPath?: string): Promise<ResolvedBase | null> {
  const head = await headSha(repo, gitPath);
  if (!head) return null;

  const refs = await execGit(
    [
      'for-each-ref',
      '--sort=-committerdate',
      '--count=50',
      '--format=%(refname)',
      'refs/heads',
      'refs/remotes',
    ],
    { cwd: repo.root, gitPath },
  );
  if (refs.exitCode !== 0) return null;

  const branch = await currentBranch(repo, gitPath);
  const current = branch ? `refs/heads/${branch}` : '';
  const seen = new Set<string>();
  let best: { ref: string; sha: string; distance: number } | null = null;

  for (const raw of refs.stdout.split(/\r?\n/)) {
    const ref = raw.trim();
    if (!ref || ref === current || ref.endsWith('/HEAD') || seen.has(ref)) continue;
    seen.add(ref);

    const base = await mergeBase(repo, ref, 'HEAD', gitPath);
    if (!base || base === head) continue;

    let distance: number;
    try {
      distance = await revListCount(repo, `${base}..HEAD`, gitPath);
    } catch {
      continue;
    }
    if (distance <= 0) continue;

    if (!best || distance < best.distance) {
      best = { ref, sha: base, distance };
      if (distance === 1) break;
    }
  }

  if (!best) return null;
  return { ref: baseRefLabel(best.ref), sha: best.sha, mergeBase: true };
}

/**
 * Resolves `exdiff.baseRef` to a commit and, when possible, the merge-base
 * (fork point) with `HEAD`.
 *
 * `auto` uses the current branch's creation reflog (`branch: Created from …`),
 * then the nearest merge-base among local/remote branches, then `HEAD~1`. An
 * explicit ref is used as-is; `sha` is its merge-base with `HEAD` (or its tip
 * when the histories are unrelated).
 */
export async function resolveBase(
  repo: RepoInfo,
  configuredRef: string,
  gitPath?: string,
): Promise<ResolvedBase | null> {
  const requested = configuredRef.trim() || 'auto';
  if (requested !== 'auto') return await resolveBaseRef(repo, requested, gitPath);

  const created = await creationFork(repo, gitPath);
  if (created) {
    const createdDistance = await distanceToHead(repo, created.sha, gitPath);
    // One commit since the fork is the best possible non-empty base; no need
    // to scan every branch (the common amend workflow).
    if (createdDistance <= 1) return created;
  }

  const nearest = await nearestBranchFork(repo, gitPath);
  const candidates = [created, nearest].filter((entry): entry is ResolvedBase => entry !== null);
  if (candidates.length === 0) return await resolveBaseRef(repo, 'HEAD~1', gitPath);

  // Prefer the fork point closest to HEAD. After a rebase the original creation
  // point is older than the new base, so the nearest branch fork wins.
  let best = candidates[0];
  let bestDistance = await distanceToHead(repo, best.sha, gitPath);
  for (const candidate of candidates.slice(1)) {
    const distance = await distanceToHead(repo, candidate.sha, gitPath);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

async function distanceToHead(repo: RepoInfo, sha: string, gitPath?: string): Promise<number> {
  if (!sha) return Number.POSITIVE_INFINITY;
  try {
    return await revListCount(repo, `${sha}..HEAD`, gitPath);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

async function resolveBaseRef(
  repo: RepoInfo,
  ref: string,
  gitPath?: string,
): Promise<ResolvedBase | null> {
  const tip = await revParse(repo, ref, gitPath);
  if (!tip) return null;
  const base = await mergeBase(repo, ref, 'HEAD', gitPath);
  return { ref, sha: base ?? tip, mergeBase: base !== null };
}

/**
 * HEAD reflog, newest first.
 * Uses `%gd%x00%H%x00%gs` so paths/subjects containing spaces or tabs survive.
 */
export async function reflogEntries(repo: RepoInfo, gitPath?: string, limit = 50): Promise<ReflogEntry[]> {
  const count = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
  const result = await execGit(['reflog', '--format=%gd%x00%H%x00%gs', '-n', String(count)], {
    cwd: repo.root,
    gitPath,
  });
  if (result.exitCode !== 0) return [];
  return parseReflog(result.stdout);
}

/**
 * Parses reflog output.
 *
 * Accepts the canonical NUL separated form (`HEAD@{0}\0<sha>\0<message>`),
 * tab separated variants and plain `git reflog` output
 * (`<sha> HEAD@{0}: <message>`).
 */
export function parseReflog(stdout: string): ReflogEntry[] {
  const entries: ReflogEntry[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;

    if (line.includes('\0')) {
      const fields = line.split('\0');
      if (fields.length < 3) continue;
      const selector = fields[0].trim();
      const sha = fields[1].trim();
      const message = fields.slice(2).join('\0').trim();
      if (selector && sha) entries.push({ selector, sha, message });
      continue;
    }

    if (line.includes('\t')) {
      const fields = line.split('\t');
      const selector = (fields[0] ?? '').trim();
      const sha = (fields[1] ?? '').trim();
      // Only treat it as a tab separated record when the shape is unmistakable;
      // a plain reflog subject may itself contain tabs.
      if (fields.length >= 3 && /@\{\d+\}$/.test(selector) && /^[0-9a-f]{4,40}$/i.test(sha)) {
        entries.push({ selector, sha: sha.toLowerCase(), message: fields.slice(2).join('\t').trim() });
        continue;
      }
    }

    const plain = /^([0-9a-f]{4,40})\s+(\S+@\{[^}]*\})\s*:?\s*(.*)$/i.exec(line);
    if (plain) {
      entries.push({ selector: plain[2], sha: plain[1].toLowerCase(), message: plain[3].trim() });
    }
  }
  return entries;
}

/**
 * Compares two commits or trees.
 * Status comes from `--name-status -z`, line counts from `--numstat -z`, joined by target path.
 */
export async function changedFiles(
  repo: RepoInfo,
  from: string,
  to: string,
  gitPath?: string,
): Promise<ChangedFile[]> {
  const opts: GitOptions = { cwd: repo.root, gitPath };
  const nameStatusOut = await gitOrThrow(
    ['diff', '--name-status', '-z', '--find-renames', '--no-color', from, to],
    opts,
  );
  const numstatOut = await gitOrThrow(['diff', '--numstat', '-z', '--find-renames', '--no-color', from, to], opts);

  const statuses = parseNameStatus(nameStatusOut);
  const stats = parseNumstat(numstatOut);

  return statuses.map((entry) => {
    const stat = stats.get(entry.newPath);
    return {
      status: entry.status,
      oldPath: entry.oldPath,
      newPath: entry.newPath,
      additions: stat ? stat.additions : null,
      deletions: stat ? stat.deletions : null,
    };
  });
}

/** `git write-tree` for the current index. Writes an object, but touches no ref/index/worktree. */
export async function writeTreeFromIndex(repo: RepoInfo, gitPath?: string): Promise<string> {
  return await git(['write-tree'], { cwd: repo.root, gitPath });
}

/** `git range-diff` over two explicit `base..tip` ranges (never `A...B`). */
export async function rangeDiff(
  repo: RepoInfo,
  oldRange: { base: string; tip: string },
  newRange: { base: string; tip: string },
  opts?: { patch?: boolean },
  gitPath?: string,
): Promise<string> {
  const args = ['range-diff', '--no-color', '--no-dual-color'];
  if (opts?.patch) args.push('--patch');
  args.push(`${oldRange.base}..${oldRange.tip}`, `${newRange.base}..${newRange.tip}`);
  return await git(args, { cwd: repo.root, gitPath });
}

/** Number of commits in `range` (`git rev-list --count`). */
export async function revListCount(repo: RepoInfo, range: string, gitPath?: string): Promise<number> {
  const out = await git(['rev-list', '--count', range], { cwd: repo.root, gitPath });
  const count = Number.parseInt(out.trim(), 10);
  if (!Number.isFinite(count)) {
    throw new Error(`Unexpected output from "git rev-list --count ${range}": ${JSON.stringify(out)}`);
  }
  return count;
}

/**
 * Infers the old and new commit ranges of the last rebase:
 *
 * - `oldTip`  = `ORIG_HEAD`, or the reflog entry right before `rebase (start)`
 * - `newBase` = SHA of the newest reflog entry starting with `rebase (start): checkout `
 * - `newTip`  = `HEAD`
 * - `count`   = `rev-list --count newBase..newTip`
 * - `oldBase` = `oldTip~count`
 *
 * Returns `null` when any piece is missing or not a commit, or when `count` is 0.
 */
export async function deriveRebaseRanges(repo: RepoInfo, gitPath?: string): Promise<RebaseRanges | null> {
  const entries = await reflogEntries(repo, gitPath, 200);
  const startIndex = entries.findIndex((entry) => entry.message.startsWith('rebase (start): checkout '));
  if (startIndex === -1) return null;
  const start = entries[startIndex];

  let oldTip = await revParse(repo, 'ORIG_HEAD', gitPath);
  if (!oldTip) {
    // A later operation clobbered ORIG_HEAD; the entry immediately before
    // "rebase (start)" is the tip that was rebased.
    const previous = entries[startIndex + 1];
    if (!previous) return null;
    oldTip = await revParse(repo, previous.sha, gitPath);
  }
  if (!oldTip) return null;

  const newBase = await revParse(repo, start.sha, gitPath);
  if (!newBase) return null;

  const newTip = await headSha(repo, gitPath);
  if (!newTip) return null;

  let count: number;
  try {
    count = await revListCount(repo, `${newBase}..${newTip}`, gitPath);
  } catch {
    return null;
  }
  if (count <= 0) return null;

  const oldBase = await revParse(repo, `${oldTip}~${count}`, gitPath);
  if (!oldBase) return null;

  // Final validation: every range boundary must be a commit.
  const [validOldBase, validOldTip, validNewBase, validNewTip] = await Promise.all([
    revParse(repo, oldBase, gitPath),
    revParse(repo, oldTip, gitPath),
    revParse(repo, newBase, gitPath),
    revParse(repo, newTip, gitPath),
  ]);
  if (!validOldBase || !validOldTip || !validNewBase || !validNewTip) return null;

  return { oldBase: validOldBase, oldTip: validOldTip, newBase: validNewBase, newTip: validNewTip };
}

/**
 * Everything a ref picker needs: local branches, remote branches, tags,
 * the 20 most recent commits and the 10 most recent reflog entries.
 */
export async function listRefs(repo: RepoInfo, gitPath?: string): Promise<RefInfo[]> {
  const refs = await collectBranchAndTagRefs(repo, gitPath);
  const commits = await collectRecentCommits(repo, gitPath);
  const reflog = (await reflogEntries(repo, gitPath, 10)).map<RefInfo>((entry) => ({
    ref: entry.selector,
    sha: entry.sha,
    label: entry.message || entry.selector,
    description: `${entry.selector} · ${entry.sha.slice(0, 7)}`,
    kind: 'reflog',
  }));
  return [...refs, ...commits, ...reflog];
}

async function collectBranchAndTagRefs(repo: RepoInfo, gitPath?: string): Promise<RefInfo[]> {
  const out = await git(['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags'], {
    cwd: repo.root,
    gitPath,
  });

  const result: RefInfo[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.split(REF_FIELD_SEPARATOR);
    if (fields.length < 8) continue;

    const refname = fields[0];
    const objectname = fields[1];
    const peeled = fields[2];
    const objectType = fields[3].trim();
    const peeledType = (fields[8] ?? '').trim();
    const head = fields[4].trim();
    const date = fields[5];
    const subject = fields[6];
    const symref = fields[7].trim();

    if (!refname.startsWith('refs/') || !objectname) continue;
    // `refs/remotes/origin/HEAD` is a symbolic duplicate of a real branch.
    if (symref) continue;

    let kind: RefInfo['kind'];
    let shortName: string;
    if (refname.startsWith('refs/heads/')) {
      kind = 'branch';
      shortName = refname.slice('refs/heads/'.length);
    } else if (refname.startsWith('refs/remotes/')) {
      kind = 'remote';
      shortName = refname.slice('refs/remotes/'.length);
    } else if (refname.startsWith('refs/tags/')) {
      kind = 'tag';
      shortName = refname.slice('refs/tags/'.length);
    } else {
      continue;
    }
    if (!shortName) continue;

    // A tag may point at a blob or a tree; those cannot be used as a diff side.
    const effectiveType = peeled ? peeledType : objectType;
    if (kind === 'tag' && effectiveType !== 'commit') continue;

    // Annotated tags point at a tag object; peel it so the SHA can be diffed.
    const sha = peeled || objectname;
    const label = kind === 'branch' && head === '*' ? `${shortName} (HEAD)` : shortName;
    result.push({ ref: shortName, sha, label, description: describeRef(sha, date, subject), kind });
  }
  return result;
}

async function collectRecentCommits(repo: RepoInfo, gitPath?: string): Promise<RefInfo[]> {
  const result = await execGit(['log', '-n', '20', '--format=%H%x00%h%x00%s'], { cwd: repo.root, gitPath });
  if (result.exitCode !== 0) return [];

  const commits: RefInfo[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const fields = line.split('\0');
    if (fields.length < 3) continue;
    const sha = fields[0].trim();
    const shortSha = fields[1].trim();
    const subject = fields.slice(2).join('\0').trim();
    if (!sha) continue;
    commits.push({
      ref: sha,
      sha,
      label: subject || shortSha,
      description: shortSha,
      kind: 'commit',
    });
  }
  return commits;
}

function describeRef(sha: string, date: string, subject: string): string {
  const shortSha = sha.slice(0, 7);
  const when = date ? date.slice(0, 16).replace('T', ' ') : '';
  const trimmedSubject = subject.trim();
  return [shortSha, when, trimmedSubject].filter((part) => part.length > 0).join(' · ');
}

interface NameStatusEntry {
  status: FileStatus;
  oldPath?: string;
  newPath: string;
}

function parseNameStatus(stdout: string): NameStatusEntry[] {
  const tokens = splitNul(stdout);
  const entries: NameStatusEntry[] = [];
  let i = 0;

  while (i < tokens.length) {
    const statusToken = tokens[i++];
    const status = toFileStatus(statusToken);
    if (!status) {
      throw new Error(`Unexpected token in "git diff --name-status -z" output: ${JSON.stringify(statusToken)}`);
    }

    if (status === 'R' || status === 'C') {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      if (oldPath === undefined || newPath === undefined) {
        throw new Error('Truncated rename/copy record in "git diff --name-status -z" output');
      }
      entries.push({ status, oldPath, newPath });
    } else {
      const newPath = tokens[i++];
      if (newPath === undefined) {
        throw new Error('Truncated record in "git diff --name-status -z" output');
      }
      entries.push({ status, newPath });
    }
  }
  return entries;
}

interface NumstatEntry {
  additions: number | null;
  deletions: number | null;
}

function parseNumstat(stdout: string): Map<string, NumstatEntry> {
  const tokens = splitNul(stdout);
  const stats = new Map<string, NumstatEntry>();
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i++];
    const firstTab = token.indexOf('\t');
    const secondTab = firstTab < 0 ? -1 : token.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) {
      throw new Error(`Unexpected token in "git diff --numstat -z" output: ${JSON.stringify(token)}`);
    }

    const additions = parseNumstatCount(token.slice(0, firstTab));
    const deletions = parseNumstatCount(token.slice(firstTab + 1, secondTab));
    let filePath = token.slice(secondTab + 1);

    if (filePath === '') {
      // Renames/copies: `add\tdel\t\0<old>\0<new>\0`.
      i += 1; // old path, only useful for name-status
      const newPath = tokens[i++];
      if (newPath === undefined) {
        throw new Error('Truncated rename/copy record in "git diff --numstat -z" output');
      }
      filePath = newPath;
    }

    stats.set(filePath, { additions, deletions });
  }
  return stats;
}

function parseNumstatCount(value: string): number | null {
  if (value === '-') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function splitNul(stdout: string): string[] {
  return stdout.split('\0').filter((token) => token.length > 0);
}

function toFileStatus(token: string): FileStatus | null {
  if (!token) return null;
  const letter = token[0].toUpperCase();
  return FILE_STATUSES.has(letter) ? (letter as FileStatus) : null;
}
