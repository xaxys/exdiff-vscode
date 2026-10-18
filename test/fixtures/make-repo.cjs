'use strict';

/**
 * Fixture builders for the ExDiff headless test-suite.
 *
 * Every repository lives in its own unique directory below `os.tmpdir()` and is
 * removed by {@link cleanup}; nothing in here ever touches a user repository.
 *
 * `git(repo, args)` runs git synchronously and returns stdout. `repo` may be a
 * repository object returned by {@link createRepo} or a plain directory path.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CORE_DIR = path.resolve(__dirname, '..', '..', 'out', 'core');
const { resolveRepo } = require(path.join(CORE_DIR, 'git.js'));

/** Keeps git non-interactive: `rebase --continue` must never wait for an editor. */
const GIT_ENV = Object.freeze({
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
});

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Every fixture root created by this process. Tests remove their own fixtures
 * through `t.after(cleanup)`, but a test that dies between `createRepo()` and
 * the `t.after()` registration would leak one — the exit sweep catches those.
 */
const liveFixtures = new Set();

process.on('exit', () => {
  for (const dir of liveFixtures) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    } catch {
      // Best effort while the process is shutting down.
    }
  }
});

/** Accepts both a fixture repository object and a plain directory. */
function repoDir(repo) {
  if (typeof repo === 'string') return repo;
  if (repo && typeof repo.dir === 'string') return repo.dir;
  throw new TypeError(`Expected a fixture repository or a directory path, got: ${String(repo)}`);
}

function runGit(repo, args, options) {
  const opts = options || {};
  const encoding = opts.buffer ? 'buffer' : 'utf8';
  const result = spawnSync(opts.gitPath || 'git', args, {
    cwd: repoDir(repo),
    encoding,
    env: { ...process.env, ...GIT_ENV, ...(opts.env || {}) },
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    input: opts.input,
  });
  if (result.error) throw result.error;
  return result;
}

/** Runs git synchronously, throws when it exits non-zero (raw stdout is returned). */
function git(repo, args, options) {
  const result = runGit(repo, args, options);
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed with exit code ${result.status} in ${repoDir(repo)}:\n${result.stderr}`,
    );
  }
  return result.stdout;
}

/** Runs git synchronously and reports the exit code instead of throwing. */
function tryGit(repo, args, options) {
  const result = runGit(repo, args, options);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Runs git and returns raw bytes (for blobs / binary fixtures). */
function gitBuffer(repo, args, options) {
  return runGit(repo, args, { ...options, buffer: true }).stdout;
}

/** `git config <key> <value>` in the fixture repository. */
function config(repo, key, value) {
  git(repo, ['config', key, value]);
}

/** Writes a file below the repository root, creating parent directories. */
function writeFile(repo, relPath, content) {
  const absolute = path.join(repoDir(repo), ...String(relPath).split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  return absolute;
}

function currentSha(repo) {
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

/**
 * Creates a throw-away repository in `os.tmpdir()`.
 *
 * Local `user.name` / `user.email` (plus eol, signing and hooks settings) are
 * always set explicitly so the fixtures do not depend on the machine config.
 *
 * @param {{ name?: string, initialCommit?: boolean, autocrlf?: boolean }} [options]
 * @returns {Promise<{ base: string, dir: string, repoInfo: object,
 *   git: (args: string[], options?: object) => string }>}
 */
async function createRepo(options) {
  const opts = options || {};
  const name = opts.name || 'repo';
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'exdiff-fixture-'));
  liveFixtures.add(base);

  try {
    const dir = path.join(base, name);
    fs.mkdirSync(dir, { recursive: true });

    git(dir, ['init', '-b', 'main']);
    // An empty hooks directory immunises the fixture against a global hooksPath.
    const hooksDir = path.join(base, 'no-hooks');
    fs.mkdirSync(hooksDir, { recursive: true });

    config(dir, 'user.name', 'ExDiff Fixture');
    config(dir, 'user.email', 'exdiff-fixture@example.invalid');
    config(dir, 'core.autocrlf', opts.autocrlf ? 'true' : 'false');
    config(dir, 'commit.gpgsign', 'false');
    config(dir, 'tag.gpgSign', 'false');
    config(dir, 'core.hooksPath', hooksDir);

    const repoInfo = await resolveRepo(dir);
    if (!repoInfo) throw new Error(`Failed to resolve the fixture repository at ${dir}`);

    const repo = {
      base,
      dir,
      repoInfo,
      git: (args, gitOptions) => git(dir, args, gitOptions),
    };

    if (opts.initialCommit !== false) {
      commitFile(repo, 'initial.txt', 'initial\n', 'chore: initial commit');
    }
    return repo;
  } catch (error) {
    cleanup(base);
    throw error;
  }
}

/**
 * Writes `relPath`, stages everything and commits.
 * @returns {string} the new commit SHA
 */
function commitFile(repo, relPath, content, message) {
  writeFile(repo, relPath, content);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', message]);
  return currentSha(repo);
}

/**
 * Amends the current commit (optionally rewriting `file` first).
 * @returns {{ previous: string, sha: string }}
 */
function amend(repo, message, file, content) {
  const previous = currentSha(repo);
  if (file !== undefined && file !== null) writeFile(repo, file, content);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--amend', '-m', message]);
  return { previous, sha: currentSha(repo) };
}

/**
 * Builds a realistic `git rebase upstream/main` scenario on top of an empty
 * fixture repository and returns the ranges that
 * `deriveRebaseRanges()` is expected to infer.
 *
 * Layout (two base commits, two feature commits, one upstream commit and one
 * conflict that is resolved during the rebase):
 *
 *   1. `base: add shared.txt` + `base: add stable.txt` -> oldBase
 *   2. feature: `feat: add feature-a`    -> replays cleanly ("=")
 *   3. feature: `feat: change shared lines 4-6` -> oldTip, conflicts
 *   4. upstream: `upstream: change line 5` -> newBase
 *   5..6. rebased feature commits        -> newTip
 *
 * @returns {Promise<{ oldBase: string, oldTip: string, newBase: string, newTip: string }>}
 */
async function rebaseOntoUpstream(repo) {
  const dir = repoDir(repo);
  const initial = numberedLines('line', 12);

  commitFile(repo, 'shared.txt', initial, 'base: add shared.txt');
  commitFile(repo, 'stable.txt', 'stable\n', 'base: add stable.txt');
  const oldBase = currentSha(repo);

  git(repo, ['checkout', '-b', 'feature']);
  commitFile(repo, 'feature-a.txt', 'alpha\nbeta\n', 'feat: add feature-a');
  commitFile(
    repo,
    'shared.txt',
    numberedLines('line', 12, {
      4: 'line04-feature',
      5: 'line05-feature',
      6: 'line06-feature',
    }),
    'feat: change shared lines 4-6',
  );
  const oldTip = currentSha(repo);

  git(repo, ['checkout', 'main']);
  writeFile(repo, 'shared.txt', numberedLines('line', 12, { 5: 'line05-upstream' }));
  writeFile(repo, 'upstream.txt', 'upstream\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'upstream: change line 5']);
  const newBase = currentSha(repo);

  git(repo, ['checkout', 'feature']);
  const rebase = tryGit(repo, ['rebase', 'main']);
  if (rebase.status === 0) {
    throw new Error('Fixture error: "git rebase main" was expected to conflict');
  }
  const conflicted = fs.readFileSync(path.join(dir, 'shared.txt'), 'utf8');
  if (!conflicted.includes('<<<<<<<') || !conflicted.includes('>>>>>>>')) {
    throw new Error(`Fixture error: shared.txt has no conflict markers:\n${conflicted}`);
  }

  writeFile(
    repo,
    'shared.txt',
    numberedLines('line', 12, {
      4: 'line04-feature',
      5: 'line05-resolved',
      6: 'line06-feature',
    }),
  );
  git(repo, ['add', 'shared.txt']);
  const continued = tryGit(repo, ['rebase', '--continue']);
  if (continued.status !== 0) {
    throw new Error(`Fixture error: "git rebase --continue" failed:\n${continued.stdout}\n${continued.stderr}`);
  }
  const newTip = currentSha(repo);

  const oldCount = Number(git(repo, ['rev-list', '--count', `${oldBase}..${oldTip}`]).trim());
  const newCount = Number(git(repo, ['rev-list', '--count', `${newBase}..${newTip}`]).trim());
  if (oldCount !== newCount || oldCount !== 2) {
    throw new Error(`Fixture error: expected two commits on each side, got old=${oldCount} new=${newCount}`);
  }

  return { oldBase, oldTip, newBase, newTip };
}

/** Builds `line01\nline02\n...` with optional per-line replacements (1-based). */
function numberedLines(prefix, count, replacements) {
  const overrides = replacements || {};
  const lines = [];
  for (let index = 1; index <= count; index += 1) {
    lines.push(overrides[index] !== undefined ? overrides[index] : `${prefix}${String(index).padStart(2, '0')}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Recursively lists files (posix relative paths, sorted). */
function walkFiles(dir, options) {
  const opts = options || {};
  const ignoreGit = opts.ignoreGit !== false;
  const ignoreExDiff = opts.ignoreExDiff !== false;
  const out = [];

  const visit = (absolute, prefix) => {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (ignoreGit && (rel === '.git' || rel.startsWith('.git/'))) continue;
      // ExDiff snapshots live inside the repository and are git-ignored.
      if (ignoreExDiff && (rel === '.exdiff' || rel.startsWith('.exdiff/'))) continue;
      if (entry.isDirectory()) visit(path.join(absolute, entry.name), rel);
      else out.push(rel);
    }
  };

  visit(dir, '');
  return out.sort();
}

/** Reads every file below `dir` into `Map<posixRelativePath, Buffer>`. */
function readTree(dir, options) {
  const tree = new Map();
  for (const rel of walkFiles(dir, options)) {
    tree.set(rel, fs.readFileSync(path.join(dir, ...rel.split('/'))));
  }
  return tree;
}

/**
 * Compares two directory trees byte for byte.
 * @returns {{ missing: string[], extra: string[], different: string[] }} all empty when equal
 */
function diffTrees(actualDir, expectedDir, options) {
  const actual = readTree(actualDir, options);
  const expected = readTree(expectedDir, options);
  const missing = [...expected.keys()].filter((rel) => !actual.has(rel)).sort();
  const extra = [...actual.keys()].filter((rel) => !expected.has(rel)).sort();
  const different = [...actual.keys()]
    .filter((rel) => expected.has(rel) && !actual.get(rel).equals(expected.get(rel)))
    .sort();
  return { missing, extra, different };
}

/** Deletes a fixture repository (or a raw directory) recursively. */
function cleanup(target) {
  if (!target) return;
  const dir = typeof target === 'string' ? target : target.base || target.dir;
  if (!dir) return;
  liveFixtures.delete(dir);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

module.exports = {
  git,
  tryGit,
  gitBuffer,
  createRepo,
  commitFile,
  amend,
  rebaseOntoUpstream,
  writeFile,
  currentSha,
  walkFiles,
  readTree,
  diffTrees,
  cleanup,
};
