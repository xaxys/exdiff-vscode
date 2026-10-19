'use strict';

/**
 * Headless tests for `out/core/git.js` and `out/core/refs.js`.
 *
 * Every test builds its own repository below `os.tmpdir()` and removes it in
 * `t.after()`, so the suite is repeatable, order independent and never touches
 * a user repository.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  changedFiles,
  deriveRebaseRanges,
  execGit,
  git: gitCmd,
  headSha,
  listRefs,
  parseReflog,
  rangeDiff,
  reflogEntries,
  resolveBase,
  resolveRepo,
  revListCount,
  revParse,
  writeTreeFromIndex,
} = require('../out/core/git.js');
const { GitError } = require('../out/core/types.js');
const { collectRefs, parseReflog: parseReflogFromRefs } = require('../out/core/refs.js');
const {
  amend,
  cleanup,
  commitFile,
  createRepo,
  git,
  rebaseOntoUpstream,
  tryGit,
  writeFile,
} = require('./fixtures/make-repo.cjs');

/** Normalises a path for comparisons (Windows: case-insensitive, 8.3 names expanded). */
function canonical(target) {
  let resolved = path.resolve(target);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // Path does not exist: keep path.resolve().
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Creates a directory that does not contain (and is not below) a git repository. */
function tempNonRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exdiff-not-a-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

test('resolveRepo resolves the root, subdirectories, and rejects non-repositories', async (t) => {
  const repo = await createRepo();
  t.after(() => cleanup(repo));

  const info = await resolveRepo(repo.dir);
  assert.ok(info, 'the fixture repository must resolve');
  assert.equal(canonical(info.root), canonical(repo.dir));
  assert.equal(canonical(info.gitdir), canonical(path.join(repo.dir, '.git')));
  assert.equal(canonical(info.commondir), canonical(path.join(repo.dir, '.git')));

  const nested = path.join(repo.dir, 'src', 'deep', 'nested');
  fs.mkdirSync(nested, { recursive: true });
  const fromNested = await resolveRepo(nested);
  assert.ok(fromNested);
  assert.equal(canonical(fromNested.root), canonical(repo.dir));
  assert.equal(canonical(fromNested.gitdir), canonical(path.join(repo.dir, '.git')));
  assert.deepEqual(
    { root: canonical(fromNested.root), gitdir: canonical(fromNested.gitdir) },
    { root: canonical(info.root), gitdir: canonical(info.gitdir) },
  );

  const notRepo = tempNonRepo(t);
  assert.equal(await resolveRepo(notRepo), null, 'a plain directory is not a repository');
  assert.equal(await resolveRepo(path.join(notRepo, 'missing', 'dir')), null, 'a missing directory is not a repository');
});

test('resolveRepo returns null for bare repositories', async (t) => {
  const repo = await createRepo();
  t.after(() => cleanup(repo));

  const bare = path.join(repo.base, 'bare.git');
  git(repo.base, ['init', '--bare', '-b', 'main', bare]);
  assert.equal(await resolveRepo(bare), null);
});

test('revParse resolves revisions and returns null for everything else', async (t) => {
  const repo = await createRepo();
  t.after(() => cleanup(repo));
  const head = commitFile(repo, 'a.txt', 'a\n', 'feat: add a');
  const parent = git(repo, ['rev-parse', 'HEAD~1']).trim();
  git(repo, ['tag', 'v1', parent]);

  assert.equal(await revParse(repo.repoInfo, 'HEAD'), head);
  assert.equal(await revParse(repo.repoInfo, 'HEAD~1'), parent);
  assert.equal(await revParse(repo.repoInfo, 'main'), head);
  assert.equal(await revParse(repo.repoInfo, 'v1'), parent, 'a lightweight tag resolves to its commit');
  assert.equal(await revParse(repo.repoInfo, head.slice(0, 7)), head, 'abbreviated SHAs are accepted');

  assert.equal(await revParse(repo.repoInfo, 'no-such-ref'), null);
  assert.equal(await revParse(repo.repoInfo, 'HEAD~99'), null);
  assert.equal(await revParse(repo.repoInfo, ''), null);

  const tree = git(repo, ['rev-parse', 'HEAD^{tree}']).trim();
  assert.equal(await revParse(repo.repoInfo, tree), null, 'a tree is not a commit');
});

test('headSha returns the HEAD commit, or null on an unborn branch', async (t) => {
  const repo = await createRepo({ initialCommit: false });
  t.after(() => cleanup(repo));

  assert.equal(await headSha(repo.repoInfo), null);

  const sha = commitFile(repo, 'a.txt', 'a\n', 'feat: first');
  assert.equal(await headSha(repo.repoInfo), sha);
  assert.equal(await headSha(repo.repoInfo), git(repo, ['rev-parse', 'HEAD']).trim());
});

test('changedFiles reports A/M/D/R, binary, unicode and spaced paths with exact line counts', async (t) => {
  const repo = await createRepo();
  t.after(() => cleanup(repo));

  const binary = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0xff, 0xfe, 0x0a]);

  commitFile(repo, 'a.txt', 'a1\na2\na3\n', 'base: a');
  commitFile(repo, 'mod.txt', 'm1\nm2\nm3\n', 'base: mod');
  commitFile(repo, 'del/gone.txt', 'gone\n', 'base: del');
  commitFile(repo, 'old/name.txt', 'rename-1\nrename-2\nrename-3\n', 'base: old');
  commitFile(repo, '中文/原始.txt', '原始内容\n', 'base: unicode');
  const from = git(repo, ['rev-parse', 'HEAD']).trim();

  writeFile(repo, 'a.txt', 'a1\na2\na3\na4\na5\n');
  writeFile(repo, 'mod.txt', 'm1\nm2-changed\nm3\nm4\n');
  writeFile(repo, 'new/added.txt', 'added\n');
  fs.rmSync(path.join(repo.dir, 'del'), { recursive: true, force: true });
  fs.mkdirSync(path.join(repo.dir, 'new'), { recursive: true });
  fs.renameSync(path.join(repo.dir, 'old', 'name.txt'), path.join(repo.dir, 'new', 'name.txt'));
  fs.rmSync(path.join(repo.dir, 'old'), { recursive: true, force: true });
  writeFile(repo, 'bin.dat', binary);
  writeFile(repo, 'dir with space/b c.txt', 'space\n');
  writeFile(repo, '新增/中文 文件.txt', '中文内容\n第二行\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'feat: mixed changes']);
  const to = git(repo, ['rev-parse', 'HEAD']).trim();

  const changes = await changedFiles(repo.repoInfo, from, to);
  const byPath = new Map(changes.map((change) => [change.newPath, change]));
  assert.equal(changes.length, byPath.size, 'every target path appears exactly once');
  assert.equal(changes.length, 8);

  assert.deepEqual(byPath.get('a.txt'), {
    status: 'M',
    oldPath: undefined,
    newPath: 'a.txt',
    additions: 2,
    deletions: 0,
  });
  assert.deepEqual(byPath.get('mod.txt'), {
    status: 'M',
    oldPath: undefined,
    newPath: 'mod.txt',
    additions: 2,
    deletions: 1,
  });
  assert.deepEqual(byPath.get('new/added.txt'), {
    status: 'A',
    oldPath: undefined,
    newPath: 'new/added.txt',
    additions: 1,
    deletions: 0,
  });
  assert.deepEqual(byPath.get('del/gone.txt'), {
    status: 'D',
    oldPath: undefined,
    newPath: 'del/gone.txt',
    additions: 0,
    deletions: 1,
  });
  assert.deepEqual(byPath.get('new/name.txt'), {
    status: 'R',
    oldPath: 'old/name.txt',
    newPath: 'new/name.txt',
    additions: 0,
    deletions: 0,
  });
  assert.equal(byPath.has('old/name.txt'), false, 'a renamed file is reported once, under its new path');
  assert.deepEqual(byPath.get('bin.dat'), {
    status: 'A',
    oldPath: undefined,
    newPath: 'bin.dat',
    additions: null,
    deletions: null,
  });
  assert.deepEqual(byPath.get('dir with space/b c.txt'), {
    status: 'A',
    oldPath: undefined,
    newPath: 'dir with space/b c.txt',
    additions: 1,
    deletions: 0,
  });
  assert.deepEqual(byPath.get('新增/中文 文件.txt'), {
    status: 'A',
    oldPath: undefined,
    newPath: '新增/中文 文件.txt',
    additions: 2,
    deletions: 0,
  });

  for (const change of changes) {
    assert.doesNotMatch(change.newPath, /\\/, `${change.newPath} must be posix`);
    assert.doesNotMatch(change.newPath, /^\.\//, `${change.newPath} must be repository relative`);
  }

  // Modifying the binary file must not invent line counts either.
  writeFile(repo, 'bin.dat', Buffer.from([0x00, 0xff, 0x00, 0x01, 0x02]));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'chore: touch binary']);
  const toBinary = git(repo, ['rev-parse', 'HEAD']).trim();
  const binaryChanges = await changedFiles(repo.repoInfo, to, toBinary);
  assert.deepEqual(binaryChanges, [
    { status: 'M', oldPath: undefined, newPath: 'bin.dat', additions: null, deletions: null },
  ]);

  assert.deepEqual(await changedFiles(repo.repoInfo, to, to), []);
});

test('changedFiles keeps the line counts of a rename that also changed content', async (t) => {
  const repo = await createRepo();
  t.after(() => cleanup(repo));

  const rows = Array.from({ length: 40 }, (_, index) => `row ${index + 1}`).join('\n') + '\n';
  commitFile(repo, 'olddir/big.txt', rows, 'base: big');
  const from = git(repo, ['rev-parse', 'HEAD']).trim();

  fs.mkdirSync(path.join(repo.dir, 'newdir'), { recursive: true });
  fs.renameSync(path.join(repo.dir, 'olddir', 'big.txt'), path.join(repo.dir, 'newdir', 'big.txt'));
  fs.writeFileSync(path.join(repo.dir, 'newdir', 'big.txt'), rows.replace('row 20\n', 'row 20 changed\n'));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'feat: rename and edit']);
  const to = git(repo, ['rev-parse', 'HEAD']).trim();

  assert.deepEqual(await changedFiles(repo.repoInfo, from, to), [
    {
      status: 'R',
      oldPath: 'olddir/big.txt',
      newPath: 'newdir/big.txt',
      additions: 1,
      deletions: 1,
    },
  ]);
});

test('writeTreeFromIndex writes a tree that matches "git diff --cached"', async (t) => {
  const repo = await createRepo();
  t.after(() => cleanup(repo));

  commitFile(repo, 'tracked.txt', 'one\ntwo\n', 'base: tracked');
  commitFile(repo, 'removed.txt', 'remove me\n', 'base: removed');

  writeFile(repo, 'tracked.txt', 'one\ntwo\nthree\n');
  writeFile(repo, 'staged/new.txt', 'staged new\n');
  fs.rmSync(path.join(repo.dir, 'removed.txt'));
  git(repo, ['add', '-A']);

  const headBefore = git(repo, ['rev-parse', 'HEAD']).trim();
  const cachedBefore = git(repo, ['diff', '--cached', '--name-status']);
  const statusBefore = git(repo, ['status', '--porcelain']);

  const tree = await writeTreeFromIndex(repo.repoInfo);
  assert.match(tree, /^[0-9a-f]{40}$/, 'writeTreeFromIndex returns a tree SHA');

  // The helper must not move HEAD, rewrite the index or touch the worktree.
  assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), headBefore);
  assert.equal(git(repo, ['diff', '--cached', '--name-status']), cachedBefore);
  assert.equal(git(repo, ['status', '--porcelain']), statusBefore);

  assert.equal(
    git(repo, ['diff', '--stat', 'HEAD', tree]),
    git(repo, ['diff', '--cached', '--stat']),
    '"git diff --stat HEAD <tree>" must equal "git diff --cached --stat"',
  );
  assert.equal(
    git(repo, ['diff', '--name-status', 'HEAD', tree]),
    git(repo, ['diff', '--cached', '--name-status']),
    '"git diff --name-status HEAD <tree>" must equal "git diff --cached --name-status"',
  );
  assert.equal(
    git(repo, ['diff', 'HEAD', tree]),
    git(repo, ['diff', '--cached']),
    'the full patch must be identical',
  );

  const changes = await changedFiles(repo.repoInfo, 'HEAD', tree);
  const byPath = new Map(changes.map((change) => [change.newPath, change]));
  assert.deepEqual(byPath.get('tracked.txt'), {
    status: 'M',
    oldPath: undefined,
    newPath: 'tracked.txt',
    additions: 1,
    deletions: 0,
  });
  assert.deepEqual(byPath.get('staged/new.txt'), {
    status: 'A',
    oldPath: undefined,
    newPath: 'staged/new.txt',
    additions: 1,
    deletions: 0,
  });
  assert.deepEqual(byPath.get('removed.txt'), {
    status: 'D',
    oldPath: undefined,
    newPath: 'removed.txt',
    additions: 0,
    deletions: 1,
  });
});

test('reflogEntries surfaces the amend entry and HEAD@{1} still resolves', async (t) => {
  const repo = await createRepo();
  t.after(() => cleanup(repo));

  commitFile(repo, 'a.txt', 'a\n', 'feat: a');
  const beforeAmend = git(repo, ['rev-parse', 'HEAD']).trim();
  const amended = amend(repo, 'feat: a (amended)', 'a.txt', 'a changed\n');

  const entries = await reflogEntries(repo.repoInfo);
  assert.ok(entries.length >= 2);
  assert.equal(entries[0].selector, 'HEAD@{0}');
  assert.equal(entries[0].sha, amended.sha);
  assert.match(entries[0].message, /commit \(amend\)/);
  assert.match(entries[0].message, /feat: a \(amended\)/);
  assert.equal(entries[1].sha, beforeAmend);
  assert.equal(entries[1].selector, 'HEAD@{1}');
  assert.match(entries[1].message, /commit: feat: a$/);
  assert.equal(await revParse(repo.repoInfo, 'HEAD@{1}'), beforeAmend);

  const limited = await reflogEntries(repo.repoInfo, undefined, 2);
  assert.deepEqual(limited, entries.slice(0, 2));
});

test('parseReflog understands NUL, tab and plain reflog output', () => {
  const shaA = 'a'.repeat(40);
  const shaB = '0123456789abcdef0123456789abcdef01234567';

  assert.deepEqual(
    parseReflog(`HEAD@{0}\0${shaA}\0commit (amend): hello world\nHEAD@{1}\0${shaB}\0commit: initial\n`),
    [
      { selector: 'HEAD@{0}', sha: shaA, message: 'commit (amend): hello world' },
      { selector: 'HEAD@{1}', sha: shaB, message: 'commit: initial' },
    ],
    'NUL separated triplets (the format reflogEntries uses)',
  );

  assert.deepEqual(parseReflog(`HEAD@{0}\t${shaA}\trebase (pick): subject\twith tab\r\n`), [
    { selector: 'HEAD@{0}', sha: shaA, message: 'rebase (pick): subject\twith tab' },
  ]);

  assert.deepEqual(parseReflog(`${shaA.slice(0, 7)} HEAD@{0}: commit: hello\n${shaB.slice(0, 7)} HEAD@{3}:rebase (finish): returning to refs/heads/feature\n`), [
    { selector: 'HEAD@{0}', sha: shaA.slice(0, 7), message: 'commit: hello' },
    { selector: 'HEAD@{3}', sha: shaB.slice(0, 7), message: 'rebase (finish): returning to refs/heads/feature' },
  ]);

  assert.deepEqual(parseReflog(''), []);
  assert.deepEqual(parseReflog('\n\n   \n'), []);
  assert.deepEqual(parseReflog('not a reflog line\nHEAD@{0}\0only-two-fields\n'), []);
  assert.equal(parseReflogFromRefs, parseReflog, 'refs.js re-exports the very same parser');
});

test('deriveRebaseRanges recovers both sides of a conflicting rebase', async (t) => {
  const repo = await createRepo({ initialCommit: false });
  t.after(() => cleanup(repo));

  const expected = await rebaseOntoUpstream(repo);
  const ranges = await deriveRebaseRanges(repo.repoInfo);

  assert.deepEqual(ranges, expected);
  assert.equal(await revListCount(repo.repoInfo, `${expected.oldBase}..${expected.oldTip}`), 2);
  assert.equal(await revListCount(repo.repoInfo, `${expected.newBase}..${expected.newTip}`), 2);

  assert.equal(git(repo, ['rev-parse', 'ORIG_HEAD']).trim(), expected.oldTip, 'oldTip comes from ORIG_HEAD');
  assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), expected.newTip, 'newTip is HEAD');
  assert.equal(git(repo, ['rev-parse', 'main']).trim(), expected.newBase, 'newBase is the rebase target');
  assert.equal(
    git(repo, ['merge-base', 'main', expected.oldTip]).trim(),
    expected.oldBase,
    'oldBase is the merge base of the two sides',
  );
  assert.equal(tryGit(repo, ['merge-base', '--is-ancestor', expected.oldBase, expected.oldTip]).status, 0);
  assert.equal(tryGit(repo, ['merge-base', '--is-ancestor', expected.newBase, expected.newTip]).status, 0);
  assert.notEqual(expected.oldTip, expected.newTip);
});

test('deriveRebaseRanges falls back to the reflog when ORIG_HEAD is gone', async (t) => {
  const repo = await createRepo({ initialCommit: false });
  t.after(() => cleanup(repo));

  const expected = await rebaseOntoUpstream(repo);
  const origHead = path.join(repo.dir, '.git', 'ORIG_HEAD');
  assert.equal(fs.existsSync(origHead), true, 'rebase must write ORIG_HEAD');
  fs.rmSync(origHead, { force: true });

  assert.deepEqual(await deriveRebaseRanges(repo.repoInfo), expected);
});

test('deriveRebaseRanges returns null when there was no rebase', async (t) => {
  const repo = await createRepo();
  t.after(() => cleanup(repo));

  assert.equal(await deriveRebaseRanges(repo.repoInfo), null, 'ORIG_HEAD is missing');

  // A hard reset creates ORIG_HEAD but no "rebase (start)" reflog entry.
  commitFile(repo, 'a.txt', 'a\n', 'feat: a');
  git(repo, ['reset', '--hard', 'HEAD']);
  assert.equal(fs.existsSync(path.join(repo.dir, '.git', 'ORIG_HEAD')), true);
  assert.equal(await deriveRebaseRanges(repo.repoInfo), null);
});

test('rangeDiff renders the rebased commits (including the patch of a rewritten pair)', async (t) => {
  const repo = await createRepo({ initialCommit: false });
  t.after(() => cleanup(repo));

  const expected = await rebaseOntoUpstream(repo);
  const oldRange = { base: expected.oldBase, tip: expected.oldTip };
  const newRange = { base: expected.newBase, tip: expected.newTip };

  const output = await rangeDiff(repo.repoInfo, oldRange, newRange);
  assert.ok(output.trim().length > 0, 'range-diff output must not be empty');
  assert.match(output, /feat: add feature-a/);
  assert.match(output, /feat: change shared lines 4-6/);

  const headers = output.split(/\r?\n/).filter((line) => /^(\d+|-):\s+/.test(line));
  assert.equal(headers.length, 2, 'one header per feature commit');
  assert.ok(
    headers.some((line) => / ! /.test(line)),
    `expected at least one rewritten pair ("!"), got:\n${output}`,
  );

  const patched = await rangeDiff(repo.repoInfo, oldRange, newRange, { patch: true });
  assert.match(patched, /feat: change shared lines 4-6/);
  const patchLines = patched.split(/\r?\n/);
  assert.ok(
    patchLines.some((line) => /^\s+[-+]\S/.test(line)),
    `expected indented "+"/"-" patch lines, got:\n${patched}`,
  );
  assert.ok(
    patchLines.some((line) => /^\s+@@ /.test(line)),
    `expected a hunk header in the patch output, got:\n${patched}`,
  );
});

test('listRefs exposes branches, remotes, tags, recent commits and reflog entries', async (t) => {
  const repo = await createRepo();
  t.after(() => cleanup(repo));

  commitFile(repo, 'a.txt', 'a\n', 'feat: add a');
  const head = commitFile(repo, 'b.txt', 'b\n', 'feat: add b');
  git(repo, ['branch', 'topic']);
  git(repo, ['tag', 'v1']);
  git(repo, ['tag', '-a', 'v2', '-m', 'annotated tag']);
  // A tag pointing at a blob cannot be used as a diff side and must be hidden.
  git(repo, ['tag', 'blob-tag', git(repo, ['rev-parse', 'HEAD:a.txt']).trim()]);
  git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);

  const tagObject = git(repo, ['rev-parse', 'v2']).trim();
  const tagCommit = git(repo, ['rev-parse', 'v2^{commit}']).trim();
  assert.notEqual(tagObject, tagCommit, 'the fixture tag must be annotated');

  const refs = await listRefs(repo.repoInfo);
  const byRef = new Map(refs.map((ref) => [ref.ref, ref]));

  const main = byRef.get('main');
  assert.ok(main, 'local branch "main" must be listed');
  assert.equal(main.kind, 'branch');
  assert.equal(main.sha, head);
  assert.equal(main.label, 'main (HEAD)');

  const topic = byRef.get('topic');
  assert.equal(topic.kind, 'branch');
  assert.equal(topic.sha, head);
  assert.equal(topic.label, 'topic');

  const lightweight = byRef.get('v1');
  assert.equal(lightweight.kind, 'tag');
  assert.equal(lightweight.sha, head);

  const annotated = byRef.get('v2');
  assert.equal(annotated.kind, 'tag');
  assert.equal(annotated.sha, tagCommit, 'an annotated tag must be peeled to its commit');
  assert.notEqual(annotated.sha, tagObject);
  assert.equal(annotated.sha, git(repo, ['rev-parse', `${annotated.ref}^{commit}`]).trim());
  assert.equal(byRef.has('blob-tag'), false, 'tags that do not peel to a commit must be skipped');

  const remote = byRef.get('origin/main');
  assert.equal(remote.kind, 'remote');
  assert.equal(remote.sha, head);
  assert.equal(byRef.has('origin/HEAD'), false, 'the symbolic remote HEAD must be skipped');

  const commits = refs.filter((ref) => ref.kind === 'commit');
  assert.ok(commits.length >= 2);
  assert.equal(commits[0].sha, head);
  assert.equal(commits[0].ref, head);
  assert.equal(commits[0].label, 'feat: add b');

  const reflog = refs.filter((ref) => ref.kind === 'reflog');
  assert.ok(reflog.length >= 1);
  assert.match(reflog[0].ref, /^HEAD@\{\d+\}$/);
  assert.equal(reflog[0].sha, head);
  assert.match(reflog[0].description, /^HEAD@\{0\} · [0-9a-f]{7,40}$/);

  assert.ok(refs.length > 0);
  for (const ref of refs) {
    assert.match(ref.sha, /^[0-9a-f]{40}$/, `${ref.ref} must carry a full SHA`);
    assert.ok(ref.label.length > 0, `${ref.ref} must have a label`);
    assert.equal(await revParse(repo.repoInfo, ref.ref), ref.sha, `revParse(${ref.ref})`);
  }

  assert.deepEqual(await collectRefs(repo.repoInfo), refs, 'collectRefs is the public alias of listRefs');
});

test('listRefs returns an empty list for an unborn repository', async (t) => {
  const repo = await createRepo({ initialCommit: false });
  t.after(() => cleanup(repo));

  assert.deepEqual(await listRefs(repo.repoInfo), []);
  assert.deepEqual(await collectRefs(repo.repoInfo), []);
});

test('git() throws GitError and execGit() reports failures without throwing', async (t) => {
  const repo = await createRepo();
  t.after(() => cleanup(repo));

  await assert.rejects(
    () => gitCmd(['rev-parse', '--verify', 'no-such-ref'], { cwd: repo.dir }),
    (error) => {
      assert.ok(error instanceof GitError, 'the rejection must be a GitError');
      assert.equal(error.name, 'GitError');
      assert.equal(error.exitCode, 128);
      assert.match(error.stderr, /no-such-ref|Needed a single revision/i);
      assert.deepEqual(error.argv, ['rev-parse', '--verify', 'no-such-ref']);
      assert.match(error.message, /git rev-parse --verify no-such-ref failed with exit code 128/);
      return true;
    },
  );

  const failed = await execGit(['rev-parse', '--verify', 'no-such-ref'], { cwd: repo.dir });
  assert.equal(failed.exitCode, 128);
  assert.equal(failed.stdout, '');
  assert.ok(failed.stderr.length > 0);

  const ok = await execGit(['rev-parse', '--show-toplevel'], { cwd: repo.dir });
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.stdout.trim().length > 0, true);
  assert.equal(ok.stderr, '');

  const missingBinary = await execGit(['--version'], { cwd: repo.dir, gitPath: 'exdiff-definitely-not-git' });
  assert.equal(missingBinary.exitCode, -1);
  assert.equal(missingBinary.stdout, '');
  assert.ok(missingBinary.stderr.length > 0, 'a spawn failure must be reported in stderr');
});

test('resolveBase auto uses the current branch creation point', async (t) => {
  const repo = await createRepo({ initialCommit: false });
  t.after(() => cleanup(repo));

  commitFile(repo, 'base.txt', 'base\n', 'base');
  const fork = git(repo, ['rev-parse', 'HEAD']).trim();

  git(repo, ['checkout', '-b', 'feature']);
  commitFile(repo, 'feature.txt', 'feature\n', 'feature work');

  git(repo, ['checkout', 'main']);
  commitFile(repo, 'main.txt', 'main\n', 'main moved');
  git(repo, ['checkout', 'feature']);

  const auto = await resolveBase(repo.repoInfo, 'auto');
  assert.ok(auto, 'auto must resolve a base');
  assert.match(auto.ref, /^fork@/, 'created-from-HEAD branches are labelled with the fork commit');
  assert.equal(auto.sha, fork, 'the base must be the creation point, not the main tip');
  assert.equal(auto.mergeBase, true);

  const explicit = await resolveBase(repo.repoInfo, 'main');
  assert.ok(explicit);
  assert.equal(explicit.sha, fork);
  assert.equal(explicit.mergeBase, true);
});

test('resolveBase auto finds an arbitrary parent branch from the reflog', async (t) => {
  const repo = await createRepo({ initialCommit: false });
  t.after(() => cleanup(repo));

  commitFile(repo, 'root.txt', 'root\n', 'root');
  git(repo, ['checkout', '-b', 'team/base']);
  commitFile(repo, 'team.txt', 'team\n', 'team base');
  const fork = git(repo, ['rev-parse', 'HEAD']).trim();

  git(repo, ['checkout', '-b', 'feature', 'team/base']);
  commitFile(repo, 'feature.txt', 'feature\n', 'feature work');

  // Advance the parent after the branch was created; the fork point must stay.
  git(repo, ['checkout', 'team/base']);
  commitFile(repo, 'team2.txt', 'team2\n', 'team base moved');
  git(repo, ['checkout', 'feature']);

  const auto = await resolveBase(repo.repoInfo, 'auto');
  assert.ok(auto);
  assert.equal(auto.ref, 'team/base');
  assert.equal(auto.sha, fork, 'the fork point must not follow the parent branch tip');
  assert.equal(auto.mergeBase, true);
});

test('resolveBase auto falls back to the nearest branch when the reflog is gone', async (t) => {
  const repo = await createRepo({ initialCommit: false });
  t.after(() => cleanup(repo));

  commitFile(repo, 'root.txt', 'root\n', 'root');

  git(repo, ['checkout', '-b', 'team/base']);
  commitFile(repo, 'team.txt', 'team\n', 'team base');
  const fork = git(repo, ['rev-parse', 'HEAD']).trim();

  git(repo, ['checkout', '-b', 'feature', 'team/base']);
  commitFile(repo, 'f1.txt', 'f1\n', 'feature 1');
  commitFile(repo, 'f2.txt', 'f2\n', 'feature 2');

  git(repo, ['checkout', 'main']);
  commitFile(repo, 'main.txt', 'main\n', 'main moved');
  git(repo, ['checkout', 'feature']);

  // Drop the creation entry: auto must look at all branches instead.
  fs.rmSync(path.join(repo.dir, '.git', 'logs', 'refs', 'heads', 'feature'), { force: true });

  const auto = await resolveBase(repo.repoInfo, 'auto');
  assert.ok(auto);
  assert.equal(auto.sha, fork, 'the nearest branch fork is the root commit');
  assert.equal(auto.mergeBase, true);
  assert.notEqual(auto.sha, git(repo, ['rev-parse', 'HEAD~1']).trim(), 'HEAD~1 is not the branch fork');
});

test('resolveBase auto falls back to HEAD~1 on the only branch', async (t) => {
  const repo = await createRepo();
  t.after(() => cleanup(repo));

  commitFile(repo, 'second.txt', 'second\n', 'second');
  const parent = git(repo, ['rev-parse', 'HEAD~1']).trim();
  const head = git(repo, ['rev-parse', 'HEAD']).trim();

  const base = await resolveBase(repo.repoInfo, 'auto');
  assert.ok(base);
  assert.equal(base.ref, 'HEAD~1');
  assert.equal(base.sha, parent);
  assert.notEqual(base.sha, head);
});
