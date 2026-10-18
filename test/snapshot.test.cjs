'use strict';

/**
 * Headless tests for `out/core/snapshot.js`.
 *
 * Coverage: full materialization fidelity (byte for byte against a real git
 * checkout), CRLF/eol handling, incremental sync vs. full rebuild, `force`,
 * idempotence, concurrent slots, `removeSnapshot` and invalid SHAs.
 *
 * Every fixture repository lives below `os.tmpdir()` and is removed in
 * `t.after()`, including when an assertion fails.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ensureSnapshot,
  readSnapshotMeta,
  removeSnapshot,
  resolveSnapshotPaths,
} = require('../out/core/snapshot.js');
const { isPathInside } = require('../out/core/paths.js');
const { writeTreeFromIndex } = require('../out/core/git.js');
const { DEFAULT_CONFIG } = require('../out/core/settings.js');
const {
  cleanup,
  commitFile,
  createRepo,
  diffTrees,
  git,
  gitBuffer,
  readTree,
  tryGit,
  walkFiles,
  writeFile,
} = require('./fixtures/make-repo.cjs');

const EMPTY_DIFF = { missing: [], extra: [], different: [] };

function config(overrides) {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function snapshotPaths(repo, slot) {
  return resolveSnapshotPaths(repo.repoInfo, slot, config().snapshotDirTemplate);
}

function readRepoFile(repo, relPath) {
  return fs.readFileSync(path.join(repo.dir, ...relPath.split('/')));
}

function readSnapshotFile(paths, relPath) {
  return fs.readFileSync(path.join(paths.dir, ...relPath.split('/')));
}

/** Compares two `readTree()` maps byte for byte. */
function assertSameTree(actual, expected, label) {
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), `${label}: file sets differ`);
  for (const [rel, buffer] of expected) {
    assert.ok(actual.get(rel).equals(buffer), `${label}: "${rel}" differs`);
  }
}

test('ensureSnapshot materializes every file byte for byte (no .git, sidecar outside)', async (t) => {
  const repo = await createRepo();
  t.after(() => cleanup(repo));

  writeFile(repo, 'src/app/main.ts', 'export const x = 1;\n');
  writeFile(repo, 'src/app/empty-file.ts', '');
  writeFile(repo, 'docs/中文 说明.md', '# 标题\n\n正文\n');
  writeFile(repo, 'assets/logo.bin', Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x00]));
  writeFile(repo, 'root.txt', 'root\n');
  writeFile(repo, 'dir with space/spaced name.txt', 'spaced\n');
  // `git archive` would skip export-ignore'd paths; the snapshot must not.
  writeFile(repo, '.gitattributes', 'secret/** export-ignore\n');
  writeFile(repo, 'secret/keep.txt', 'secret\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'base: files']);
  const sha = git(repo, ['rev-parse', 'HEAD']).trim();

  const cfg = config();
  const paths = await ensureSnapshot(repo.repoInfo, 'base', sha, cfg);

  // Path layout: <repoRoot>/.exdiff/<slot> for the tree, <root>/<slot>.json for the sidecar.
  const repoRoot = repo.repoInfo.root;
  assert.deepEqual(paths, {
    root: path.join(repoRoot, '.exdiff'),
    dir: path.join(repoRoot, '.exdiff', 'base'),
    meta: path.join(repoRoot, '.exdiff', 'base.json'),
  });
  assert.equal(isPathInside(paths.dir, paths.meta), false, 'the sidecar must live outside the snapshot tree');
  assert.equal(isPathInside(paths.dir, paths.root), false);
  assert.equal(path.relative(paths.dir, paths.meta), path.join('..', 'base.json'));
  assert.equal(path.dirname(paths.meta), paths.root);
  // The snapshot root is inside the repository, so it must not pollute git status.
  assert.equal(fs.existsSync(path.join(paths.root, '.gitignore')), true);
  assert.equal(git(repo, ['status', '--porcelain']).trim(), '');

  // No .git anywhere inside the snapshot (VS Code must not see a repository).
  assert.equal(fs.existsSync(path.join(paths.dir, '.git')), false);
  const everything = walkFiles(paths.dir, { ignoreGit: false });
  assert.equal(
    everything.some((rel) => rel === '.git' || rel.startsWith('.git/')),
    false,
    'the snapshot must not contain a .git directory',
  );

  // Reference: a real `git checkout` in a separate directory.
  const reference = path.join(repo.base, 'reference');
  const cloned = tryGit(repo.base, ['-c', 'core.autocrlf=false', 'clone', '--quiet', repo.dir, reference]);
  assert.equal(cloned.status, 0, cloned.stderr);
  const checkedOut = tryGit(reference, ['-c', 'core.autocrlf=false', 'checkout', '--detach', sha]);
  assert.equal(checkedOut.status, 0, checkedOut.stderr);

  assert.deepEqual(
    diffTrees(paths.dir, reference),
    EMPTY_DIFF,
    'snapshot bytes must equal a real checkout byte for byte',
  );

  // The snapshot contains exactly the tracked files of that commit.
  const tracked = git(repo, ['ls-tree', '-r', '-z', '--name-only', sha]).split('\0').filter(Boolean).sort();
  assert.deepEqual(walkFiles(paths.dir), tracked);
  assert.ok(tracked.includes('docs/中文 说明.md'));
  assert.ok(tracked.includes('dir with space/spaced name.txt'));
  assert.equal(readSnapshotFile(paths, 'src/app/empty-file.ts').length, 0);
  assert.deepEqual([...readSnapshotFile(paths, 'assets/logo.bin')], [0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x00]);
  assert.match(
    git(repo, ['check-attr', 'export-ignore', '--', 'secret/keep.txt']),
    /export-ignore: set/,
    'the fixture must mark this path as export-ignore',
  );
  assert.equal(
    readSnapshotFile(paths, 'secret/keep.txt').toString('utf8'),
    'secret\n',
    'export-ignore must not hide files from the snapshot (checkout-index, not archive)',
  );

  // Sidecar contents.
  const meta = await readSnapshotMeta(paths);
  assert.equal(meta.slot, 'base');
  assert.equal(meta.sha, sha);
  assert.equal(typeof meta.syncedAt, 'number');
  const onDisk = JSON.parse(fs.readFileSync(paths.meta, 'utf8'));
  assert.equal(onDisk.slot, 'base');
  assert.equal(onDisk.sha, sha);
  assert.equal(onDisk.syncedAt, meta.syncedAt);

  // Materializing a snapshot must not touch the repository itself.
  assert.equal(git(repo, ['status', '--porcelain']), '');
  assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), sha);
});

test('ensureSnapshot preserves CRLF content exactly like a real checkout', async (t) => {
  const repo = await createRepo({ autocrlf: true });
  t.after(() => cleanup(repo));

  commitFile(repo, '.gitattributes', '*.txt text eol=crlf\n', 'base: attributes');
  commitFile(repo, 'crlf.txt', 'one\ntwo\nthree\n', 'base: crlf');
  commitFile(repo, 'nested/deep/crlf2.txt', 'alpha\nbeta\n', 'base: crlf2');
  commitFile(repo, 'src/code.ts', 'const x = 1;\n', 'base: code');
  const sha = git(repo, ['rev-parse', 'HEAD']).trim();

  // Re-materialize the whole worktree through git so every file got its eol conversion.
  for (const entry of fs.readdirSync(repo.dir)) {
    if (entry === '.git') continue;
    fs.rmSync(path.join(repo.dir, entry), { recursive: true, force: true });
  }
  git(repo, ['checkout', '--', '.']);
  assert.equal(git(repo, ['status', '--porcelain']), '');

  const worktreeCrlf = readRepoFile(repo, 'crlf.txt');
  assert.ok(worktreeCrlf.includes('\r\n'), 'the fixture worktree must contain CRLF');
  assert.equal(worktreeCrlf.toString('latin1'), 'one\r\ntwo\r\nthree\r\n');

  const blob = gitBuffer(repo, ['cat-file', 'blob', 'HEAD:crlf.txt']);
  assert.equal(blob.includes(0x0d), false, 'git stores the LF version in the object database');

  const cfg = config();
  const paths = await ensureSnapshot(repo.repoInfo, 'base', sha, cfg);

  const snapshotCrlf = readSnapshotFile(paths, 'crlf.txt');
  assert.ok(snapshotCrlf.includes('\r\n'), 'the snapshot must contain CRLF, not LF');
  assert.equal(snapshotCrlf.toString('latin1'), 'one\r\ntwo\r\nthree\r\n');
  assert.ok(snapshotCrlf.equals(worktreeCrlf), 'snapshot bytes must equal the working tree bytes');
  assert.equal(readSnapshotFile(paths, 'nested/deep/crlf2.txt').toString('latin1'), 'alpha\r\nbeta\r\n');

  // Every tracked file must match the checkout byte for byte (including .gitattributes).
  const tracked = git(repo, ['ls-tree', '-r', '-z', '--name-only', sha]).split('\0').filter(Boolean);
  assert.ok(tracked.length >= 4);
  for (const rel of tracked) {
    assert.ok(
      readSnapshotFile(paths, rel).equals(readRepoFile(repo, rel)),
      `${rel} must match the working tree byte for byte`,
    );
  }
  assert.deepEqual(diffTrees(paths.dir, repo.dir), EMPTY_DIFF);
});

test('incremental sync produces exactly the same tree as a full rebuild', async (t) => {
  const repo = await createRepo();
  t.after(() => cleanup(repo));

  commitFile(repo, 'a.txt', 'a1\na2\na3\n', 'base: a');
  commitFile(repo, 'mod.txt', 'm1\nm2\nm3\n', 'base: mod');
  commitFile(repo, 'dir/deep/m.txt', 'deep\n', 'base: deep');
  commitFile(repo, 'dir/keep.txt', 'keep\n', 'base: keep');
  commitFile(repo, 'old/name.txt', 'rename-1\nrename-2\nrename-3\n', 'base: old');
  commitFile(repo, 'del/nested/gone.txt', 'gone\n', 'base: gone');
  commitFile(repo, '中文/原始.txt', '原始内容\n', 'base: unicode');
  const c1 = git(repo, ['rev-parse', 'HEAD']).trim();

  writeFile(repo, 'a.txt', 'a1\na2\na3\na4\n');
  writeFile(repo, 'mod.txt', 'm1\nm2-changed\nm3\n');
  writeFile(repo, 'new/added/file.txt', 'added\n');
  writeFile(repo, '中文/新增 文件.txt', '新增\n');
  writeFile(repo, 'bin.dat', Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
  fs.rmSync(path.join(repo.dir, 'del'), { recursive: true, force: true });
  fs.mkdirSync(path.join(repo.dir, 'new'), { recursive: true });
  fs.renameSync(path.join(repo.dir, 'old', 'name.txt'), path.join(repo.dir, 'new', 'name.txt'));
  fs.rmSync(path.join(repo.dir, 'old'), { recursive: true, force: true });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'feat: mixed changes']);
  const c2 = git(repo, ['rev-parse', 'HEAD']).trim();

  const headBefore = git(repo, ['rev-parse', 'HEAD']).trim();
  const cachedBefore = git(repo, ['diff', '--cached', '--name-status']);
  const statusBefore = git(repo, ['status', '--porcelain']);

  const cfg = config();
  const incremental = await ensureSnapshot(repo.repoInfo, 'inc', c1, cfg);
  assert.equal((await readSnapshotMeta(incremental)).sha, c1);
  assert.equal(readSnapshotFile(incremental, 'del/nested/gone.txt').toString('utf8'), 'gone\n');

  await ensureSnapshot(repo.repoInfo, 'inc', c2, cfg);
  const full = await ensureSnapshot(repo.repoInfo, 'full', c2, cfg);

  assert.deepEqual(
    diffTrees(incremental.dir, full.dir),
    EMPTY_DIFF,
    'incremental and full materialization must be byte identical',
  );
  assert.deepEqual(diffTrees(full.dir, repo.dir), EMPTY_DIFF, 'the snapshot must match the worktree of c2');

  // Deleted files disappear and their now-empty directories are pruned.
  assert.equal(fs.existsSync(path.join(incremental.dir, 'del', 'nested', 'gone.txt')), false);
  assert.equal(fs.existsSync(path.join(incremental.dir, 'del')), false, 'empty "del" directory must be pruned');
  assert.equal(fs.existsSync(path.join(incremental.dir, 'old')), false, 'empty "old" directory must be pruned');

  // Added / modified / renamed / unicode / binary content is there.
  assert.equal(readSnapshotFile(incremental, 'a.txt').toString('utf8'), 'a1\na2\na3\na4\n');
  assert.equal(readSnapshotFile(incremental, 'mod.txt').toString('utf8'), 'm1\nm2-changed\nm3\n');
  assert.equal(readSnapshotFile(incremental, 'new/added/file.txt').toString('utf8'), 'added\n');
  assert.equal(readSnapshotFile(incremental, 'new/name.txt').toString('utf8'), 'rename-1\nrename-2\nrename-3\n');
  assert.equal(readSnapshotFile(incremental, '中文/新增 文件.txt').toString('utf8'), '新增\n');
  assert.deepEqual([...readSnapshotFile(incremental, 'bin.dat')], [0x00, 0x01, 0x02, 0x00, 0xff]);

  // Unrelated files and their directories survive.
  assert.equal(readSnapshotFile(incremental, 'dir/keep.txt').toString('utf8'), 'keep\n');
  assert.equal(readSnapshotFile(incremental, 'dir/deep/m.txt').toString('utf8'), 'deep\n');
  assert.equal(readSnapshotFile(incremental, '中文/原始.txt').toString('utf8'), '原始内容\n');

  assert.equal((await readSnapshotMeta(incremental)).sha, c2);
  assert.equal((await readSnapshotMeta(full)).sha, c2);

  // Read-only contract: no ref, index or worktree change.
  assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), headBefore);
  assert.equal(git(repo, ['diff', '--cached', '--name-status']), cachedBefore);
  assert.equal(git(repo, ['status', '--porcelain']), statusBefore);
});

test('incremental sync handles a path that turns from a file into a directory (and back)', async (t) => {
  const repo = await createRepo();
  t.after(() => cleanup(repo));

  commitFile(repo, 'swap', 'i am a file\n', 'c1: a file');
  commitFile(repo, 'other/keep.txt', 'keep\n', 'c1: keep');
  const c1 = git(repo, ['rev-parse', 'HEAD']).trim();

  fs.rmSync(path.join(repo.dir, 'swap'));
  writeFile(repo, 'swap/inner.txt', 'inner\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'c2: file -> directory']);
  const c2 = git(repo, ['rev-parse', 'HEAD']).trim();

  fs.rmSync(path.join(repo.dir, 'swap'), { recursive: true, force: true });
  writeFile(repo, 'swap', 'file again\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'c3: directory -> file']);
  const c3 = git(repo, ['rev-parse', 'HEAD']).trim();

  const cfg = config();
  const incremental = await ensureSnapshot(repo.repoInfo, 'inc', c1, cfg);
  assert.equal(readSnapshotFile(incremental, 'swap').toString('utf8'), 'i am a file\n');

  await ensureSnapshot(repo.repoInfo, 'inc', c2, cfg);
  assert.equal(fs.statSync(path.join(incremental.dir, 'swap')).isDirectory(), true);
  assert.equal(readSnapshotFile(incremental, 'swap/inner.txt').toString('utf8'), 'inner\n');

  await ensureSnapshot(repo.repoInfo, 'inc', c3, cfg);
  assert.equal(fs.statSync(path.join(incremental.dir, 'swap')).isFile(), true);
  assert.equal(readSnapshotFile(incremental, 'swap').toString('utf8'), 'file again\n');
  assert.deepEqual(walkFiles(incremental.dir), ['initial.txt', 'other/keep.txt', 'swap']);

  const full = await ensureSnapshot(repo.repoInfo, 'full', c3, cfg);
  assert.deepEqual(diffTrees(incremental.dir, full.dir), EMPTY_DIFF, 'file<->directory swaps must match a full rebuild');
});

test('force rebuilds the snapshot and discards local edits', async (t) => {
  const repo = await createRepo();
  t.after(() => cleanup(repo));

  const sha = commitFile(repo, 'a.txt', 'a1\na2\n', 'base: a');
  const cfg = config();
  const paths = await ensureSnapshot(repo.repoInfo, 'base', sha, cfg);
  const original = readSnapshotFile(paths, 'a.txt');

  fs.writeFileSync(path.join(paths.dir, 'a.txt'), 'tampered\n');
  fs.rmSync(path.join(paths.dir, 'initial.txt'));
  fs.writeFileSync(path.join(paths.dir, 'stray.txt'), 'stray\n');

  // Same SHA without force is a no-op, even for a tampered snapshot.
  await ensureSnapshot(repo.repoInfo, 'base', sha, cfg);
  assert.equal(readSnapshotFile(paths, 'a.txt').toString('utf8'), 'tampered\n');
  assert.equal(fs.existsSync(path.join(paths.dir, 'stray.txt')), true);

  await ensureSnapshot(repo.repoInfo, 'base', sha, cfg, { force: true });
  assert.ok(readSnapshotFile(paths, 'a.txt').equals(original), 'force must restore the original bytes');
  assert.equal(readSnapshotFile(paths, 'a.txt').toString('utf8'), 'a1\na2\n');
  assert.equal(readSnapshotFile(paths, 'initial.txt').toString('utf8'), 'initial\n');
  assert.equal(fs.existsSync(path.join(paths.dir, 'stray.txt')), false, 'force removes stray files');
  assert.equal((await readSnapshotMeta(paths)).sha, sha);
});

test('ensureSnapshot is idempotent for an unchanged SHA', async (t) => {
  const repo = await createRepo();
  t.after(() => cleanup(repo));

  const sha = commitFile(repo, 'a.txt', 'a1\na2\n', 'base: a');
  const cfg = config();
  const paths = await ensureSnapshot(repo.repoInfo, 'base', sha, cfg);

  const file = path.join(paths.dir, 'a.txt');
  const mtimeBefore = fs.statSync(file).mtimeMs;
  const metaBefore = await readSnapshotMeta(paths);

  await new Promise((resolve) => setTimeout(resolve, 60));
  await ensureSnapshot(repo.repoInfo, 'base', sha, cfg);

  assert.equal(fs.statSync(file).mtimeMs, mtimeBefore, 'a same-SHA call must not rewrite files');
  assert.equal(readSnapshotFile(paths, 'a.txt').toString('utf8'), 'a1\na2\n');
  const metaAfter = await readSnapshotMeta(paths);
  assert.equal(metaAfter.sha, metaBefore.sha);
  assert.equal(metaAfter.syncedAt, metaBefore.syncedAt, 'a no-op must not rewrite the sidecar');
  const tracked = git(repo, ['ls-tree', '-r', '-z', '--name-only', sha]).split('\0').filter(Boolean).sort();
  assert.deepEqual(walkFiles(paths.dir), tracked);
});

test('concurrent ensureSnapshot calls for one slot never mix two SHAs', { timeout: 120000 }, async (t) => {
  const repo = await createRepo();
  t.after(() => cleanup(repo));

  const c1 = commitFile(repo, 'a.txt', 'a1\n', 'c1');
  commitFile(repo, 'a.txt', 'a1\na2\n', 'c2');
  const c2 = commitFile(repo, 'b.txt', 'b\n', 'c3');

  const cfg = config();
  const [first, second] = await Promise.all([
    ensureSnapshot(repo.repoInfo, 'race', c1, cfg),
    ensureSnapshot(repo.repoInfo, 'race', c2, cfg),
  ]);
  assert.deepEqual(first, second, 'both calls must resolve to the same slot paths');

  const reference1 = await ensureSnapshot(repo.repoInfo, 'race-ref1', c1, cfg);
  const reference2 = await ensureSnapshot(repo.repoInfo, 'race-ref2', c2, cfg);

  const against1 = diffTrees(first.dir, reference1.dir);
  const against2 = diffTrees(first.dir, reference2.dir);
  const isC1 = against1.missing.length + against1.extra.length + against1.different.length === 0;
  const isC2 = against2.missing.length + against2.extra.length + against2.different.length === 0;

  assert.notEqual(isC1, isC2, `the snapshot must equal exactly one SHA; vs c1=${JSON.stringify(against1)} vs c2=${JSON.stringify(against2)}`);
  const meta = await readSnapshotMeta(first);
  assert.equal(meta.sha, isC1 ? c1 : c2, 'the sidecar must describe the tree that is actually on disk');
  assert.equal(meta.slot, 'race');
});

test('different slots can be materialized in parallel', { timeout: 120000 }, async (t) => {
  const repo = await createRepo();
  t.after(() => cleanup(repo));

  const c1 = commitFile(repo, 'a.txt', 'a1\n', 'c1');
  const c2 = commitFile(repo, 'a.txt', 'a1\na2\na3\n', 'c2');

  const cfg = config();
  const [base, amend] = await Promise.all([
    ensureSnapshot(repo.repoInfo, 'base', c1, cfg),
    ensureSnapshot(repo.repoInfo, 'amend', c2, cfg),
  ]);

  const reference1 = await ensureSnapshot(repo.repoInfo, 'ref-c1', c1, cfg);
  const reference2 = await ensureSnapshot(repo.repoInfo, 'ref-c2', c2, cfg);

  assert.deepEqual(diffTrees(base.dir, reference1.dir), EMPTY_DIFF);
  assert.deepEqual(diffTrees(amend.dir, reference2.dir), EMPTY_DIFF);
  assert.equal((await readSnapshotMeta(base)).sha, c1);
  assert.equal((await readSnapshotMeta(amend)).sha, c2);
  assert.equal(path.dirname(base.dir), path.dirname(amend.dir), 'slots share the snapshot root');
  assert.equal(readSnapshotFile(base, 'a.txt').toString('utf8'), 'a1\n');
  assert.equal(readSnapshotFile(amend, 'a.txt').toString('utf8'), 'a1\na2\na3\n');
});

test('removeSnapshot deletes the tree and the sidecar and prunes an empty root', async (t) => {
  const repo = await createRepo();
  t.after(() => cleanup(repo));

  const sha = commitFile(repo, 'a.txt', 'a1\n', 'c1');
  const cfg = config();
  const base = await ensureSnapshot(repo.repoInfo, 'base', sha, cfg);
  const amend = await ensureSnapshot(repo.repoInfo, 'amend', sha, cfg);

  assert.equal(fs.existsSync(base.dir), true);
  assert.equal(fs.existsSync(base.meta), true);

  await removeSnapshot(base);
  assert.equal(fs.existsSync(base.dir), false, 'the snapshot directory must be deleted');
  assert.equal(fs.existsSync(base.meta), false, 'the sidecar must be deleted');
  assert.equal(fs.existsSync(base.root), true, 'the root survives while another slot exists');
  assert.equal(fs.existsSync(amend.dir), true);

  await removeSnapshot(amend);
  assert.equal(fs.existsSync(amend.dir), false);
  assert.equal(fs.existsSync(amend.meta), false);
  assert.equal(fs.existsSync(base.root), false, 'an empty snapshot root must be pruned');

  // Removing twice must not throw.
  await removeSnapshot(amend);
  assert.equal(fs.existsSync(amend.root), false);
});

test('an invalid SHA throws and leaves the existing snapshot intact', async (t) => {
  const repo = await createRepo();
  t.after(() => cleanup(repo));

  const sha = commitFile(repo, 'a.txt', 'a1\na2\n', 'base: a');
  const cfg = config();
  const paths = await ensureSnapshot(repo.repoInfo, 'base', sha, cfg);

  const before = readTree(paths.dir);
  const metaBefore = await readSnapshotMeta(paths);
  const missingSha = 'deadbeef'.repeat(5);

  await assert.rejects(
    () => ensureSnapshot(repo.repoInfo, 'base', missingSha, cfg, { force: true }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'GitError');
      assert.equal(error.exitCode, 128);
      assert.match(error.stderr, /failed to unpack tree object|not a valid object name/i);
      return true;
    },
  );
  assertSameTree(readTree(paths.dir), before, 'a failed forced rebuild');
  assert.deepEqual(await readSnapshotMeta(paths), metaBefore, 'the sidecar must survive a failed rebuild');

  // Same failure through the incremental path (no force).
  await assert.rejects(
    () => ensureSnapshot(repo.repoInfo, 'base', missingSha, cfg),
    (error) => {
      assert.equal(error.name, 'GitError');
      assert.equal(error.exitCode, 128);
      return true;
    },
  );
  assertSameTree(readTree(paths.dir), before, 'a failed incremental update');

  // A syntactically invalid revision fails too.
  await assert.rejects(() => ensureSnapshot(repo.repoInfo, 'base', 'not-a-sha', cfg, { force: true }), /read-tree/);

  // An empty SHA is rejected before any git command runs.
  await assert.rejects(() => ensureSnapshot(repo.repoInfo, 'base', '   ', cfg), /requires a commit or tree SHA/);
  assertSameTree(readTree(paths.dir), before, 'after all failed attempts');

  // A failed sync must not poison the per-slot lock: the next call still runs.
  const nextSha = commitFile(repo, 'a.txt', 'a1\na2\na3\n', 'base: a again');
  await ensureSnapshot(repo.repoInfo, 'base', nextSha, cfg);
  assert.equal(readSnapshotFile(paths, 'a.txt').toString('utf8'), 'a1\na2\na3\n');
  assert.equal((await readSnapshotMeta(paths)).sha, nextSha);
});

test('ensureSnapshot accepts the tree SHA returned by writeTreeFromIndex (staged-only slot)', async (t) => {
  const repo = await createRepo();
  t.after(() => cleanup(repo));

  commitFile(repo, 'committed.txt', 'committed\n', 'base: committed');
  writeFile(repo, 'committed.txt', 'committed\nstaged\n');
  writeFile(repo, 'staged/new.txt', 'new\n');
  git(repo, ['add', '-A']);
  const tree = await writeTreeFromIndex(repo.repoInfo);

  const cfg = config();
  const paths = await ensureSnapshot(repo.repoInfo, 'index', tree, cfg);

  assert.equal((await readSnapshotMeta(paths)).sha, tree);
  assert.equal(readSnapshotFile(paths, 'committed.txt').toString('utf8'), 'committed\nstaged\n');
  assert.equal(readSnapshotFile(paths, 'staged/new.txt').toString('utf8'), 'new\n');
  assert.equal(readSnapshotFile(paths, 'initial.txt').toString('utf8'), 'initial\n');

  // Worktree-only edits must not leak into the staged-only snapshot.
  writeFile(repo, 'committed.txt', 'committed\nstaged\nworktree only\n');
  const again = await ensureSnapshot(repo.repoInfo, 'index2', tree, cfg);
  assert.equal(readSnapshotFile(again, 'committed.txt').toString('utf8'), 'committed\nstaged\n');
});

test('resolveSnapshotPaths expands templates and rejects unsafe slots', async (t) => {
  const repo = await createRepo();
  t.after(() => cleanup(repo));

  const repoParent = path.dirname(repo.repoInfo.root);
  const repoRoot = repo.repoInfo.root;
  const repoName = path.basename(repo.repoInfo.root);

  const custom = resolveSnapshotPaths(repo.repoInfo, 'base', '${repoParent}/custom/${repoName}');
  assert.equal(custom.root, path.join(repoParent, 'custom', repoName));
  assert.equal(custom.dir, path.join(repoParent, 'custom', repoName, 'base'));
  assert.equal(custom.meta, path.join(repoParent, 'custom', repoName, 'base.json'));

  const inside = resolveSnapshotPaths(repo.repoInfo, 'base', '${repoRoot}/.snapshots');
  assert.equal(inside.root, path.join(repoRoot, '.snapshots'));
  assert.equal(inside.dir, path.join(repoRoot, '.snapshots', 'base'));

  // `${slot}` is expanded in the template as well (the slot is still appended to `root`).
  const withSlot = resolveSnapshotPaths(repo.repoInfo, 'base', '${repoParent}/${repoName}-${slot}');
  assert.equal(withSlot.root, path.join(repoParent, `${repoName}-base`));
  assert.equal(withSlot.dir, path.join(repoParent, `${repoName}-base`, 'base'));

  // Relative templates resolve against the repository root, not process.cwd().
  const relative = resolveSnapshotPaths(repo.repoInfo, 'amend', '.exdiff-alt/${repoName}');
  assert.equal(relative.root, path.resolve(repoRoot, '.exdiff-alt', repoName));
  assert.equal(relative.dir, path.resolve(repoRoot, '.exdiff-alt', repoName, 'amend'));

  // An empty template falls back to the default.
  assert.equal(
    resolveSnapshotPaths(repo.repoInfo, 'base', '').root,
    resolveSnapshotPaths(repo.repoInfo, 'base', DEFAULT_CONFIG.snapshotDirTemplate).root,
  );

  for (const slot of ['', '   ', '.', '..', '../escape', 'a/b', 'a\\b', 'C:\\x', 'nul\0byte']) {
    assert.throws(
      () => resolveSnapshotPaths(repo.repoInfo, slot, DEFAULT_CONFIG.snapshotDirTemplate),
      /Invalid snapshot slot name/,
      `slot ${JSON.stringify(slot)} must be rejected`,
    );
  }
});

test('a malformed or missing sidecar triggers a full rebuild', async (t) => {
  const repo = await createRepo();
  t.after(() => cleanup(repo));

  const sha = commitFile(repo, 'a.txt', 'a1\n', 'c1');
  const cfg = config();
  const paths = await ensureSnapshot(repo.repoInfo, 'base', sha, cfg);

  fs.writeFileSync(paths.meta, '{ this is not json');
  assert.equal(await readSnapshotMeta(paths), null);
  fs.writeFileSync(path.join(paths.dir, 'a.txt'), 'tampered\n');
  await ensureSnapshot(repo.repoInfo, 'base', sha, cfg);
  assert.equal(
    readSnapshotFile(paths, 'a.txt').toString('utf8'),
    'a1\n',
    'without a usable sidecar the snapshot must be rebuilt, not reused',
  );

  // A sidecar that exists while the directory is gone must rebuild as well.
  fs.rmSync(paths.dir, { recursive: true, force: true });
  await ensureSnapshot(repo.repoInfo, 'base', sha, cfg);
  assert.equal(readSnapshotFile(paths, 'a.txt').toString('utf8'), 'a1\n');
  assert.equal((await readSnapshotMeta(paths)).sha, sha);
});
