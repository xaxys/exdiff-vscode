'use strict';

/**
 * Headless tests for `out/core/paths.js`.
 *
 * The path helpers are the security boundary between "a path reported by git"
 * and "a path we are about to read/write", so the assertions below check exact
 * results (not just truthiness) and always include the escape attempts.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  emptySidePath,
  expandTemplate,
  isPathInside,
  relativeInside,
  sanitizeSlotName,
  toPosix,
} = require('../out/core/paths.js');

const isWindows = process.platform === 'win32';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exdiff-paths-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

test('toPosix converts native separators only', () => {
  assert.equal(toPosix('a\\b\\c'), 'a/b/c');
  assert.equal(toPosix('a/b/c'), 'a/b/c');
  assert.equal(toPosix('C:\\repo\\src\\a.ts'), 'C:/repo/src/a.ts');
  assert.equal(toPosix(''), '');
});

test('expandTemplate replaces repoRoot/repoParent/repoName/slot and keeps unknown variables', () => {
  const vars = { repoParent: 'D:\\work', repoName: 'proj', repoRoot: 'D:\\work\\proj', slot: 'base' };

  assert.equal(expandTemplate('${repoRoot}/.exdiff', vars), 'D:\\work\\proj/.exdiff');
  assert.equal(
    expandTemplate('${repoParent}/.exdiff/${repoName}/${slot}', vars),
    'D:\\work/.exdiff/proj/base',
  );
  assert.equal(expandTemplate('${repoName} [${slot}]', vars), 'proj [base]');
  assert.equal(expandTemplate('${slot}/${slot}', vars), 'base/base');
  assert.equal(expandTemplate('${repoParent}', vars), 'D:\\work');
  assert.equal(expandTemplate('${repoRoot}', vars), 'D:\\work\\proj');

  // Unknown variables are deliberately left untouched so typos stay visible.
  assert.equal(expandTemplate('${repoParent}/${nope}/${slot}', vars), 'D:\\work/${nope}/base');
  assert.equal(expandTemplate('${repo-parent}', vars), '${repo-parent}');
  assert.equal(expandTemplate('${}', vars), '${}');
  assert.equal(expandTemplate('plain/path', vars), 'plain/path');
  assert.equal(expandTemplate('', vars), '');
});

test('relativeInside returns posix paths below the root and "" for the root itself', (t) => {
  const root = tempDir(t);

  assert.equal(relativeInside(root, root), '');
  assert.equal(relativeInside(root, `${root}${path.sep}`), '');
  assert.equal(relativeInside(root, path.join(root, 'a', 'b', 'c.ts')), 'a/b/c.ts');
  assert.equal(relativeInside(path.join(root, 'a'), path.join(root, 'a', 'b')), 'b');
  // A sibling directory / parent is outside.
  assert.equal(relativeInside(root, path.join(root, '..', 'sibling.txt')), null);
  assert.equal(relativeInside(path.join(root, 'a'), root), null);
  assert.equal(relativeInside(root, path.dirname(root)), null);
  // Normalisation happens before the containment check.
  assert.equal(relativeInside(root, path.join(root, 'a', '..', 'b', '.', 'c.txt')), 'b/c.txt');
  assert.equal(relativeInside(root, path.join(root, 'a', '..', '..', 'escape.txt')), null);
});

test('relativeInside rejects a different Windows drive', { skip: !isWindows }, () => {
  assert.equal(relativeInside('C:\\x', 'D:\\y'), null);
  assert.equal(relativeInside('C:\\x', 'D:\\x\\y'), null);
  assert.equal(relativeInside('C:\\x', 'C:\\x\\y'), 'y');
});

test('relativeInside compares case-insensitively on Windows', { skip: !isWindows }, () => {
  assert.equal(relativeInside('D:\\Repo', 'd:\\repo\\a\\b'), 'a/b');
  assert.equal(relativeInside('d:\\repo', 'D:\\Repo\\A'), 'A');
  assert.equal(relativeInside('D:\\Repo', 'D:\\Repo2\\a'), null);
});

test('isPathInside is a strict-descendant test', (t) => {
  const root = tempDir(t);

  assert.equal(isPathInside(root, root), false, 'the root itself is not inside the root');
  assert.equal(isPathInside(root, `${root}${path.sep}`), false);
  assert.equal(isPathInside(root, path.join(root, 'a')), true);
  assert.equal(isPathInside(root, path.join(root, 'a', 'b.txt')), true);
  assert.equal(isPathInside(root, path.join(root, '..')), false);
  assert.equal(isPathInside(root, path.join(root, '..', 'sibling')), false);
  assert.equal(isPathInside(root, path.dirname(root)), false);
});

test('sanitizeSlotName produces safe Windows directory names', () => {
  const table = [
    ['HEAD@{1}', 'HEAD-1'],
    ['feature/foo', 'feature-foo'],
    ['CON', '_CON'],
    ['nul', '_nul'],
    ['con.txt', '_con.txt'],
    ['LPT1', '_LPT1'],
    ['refs/tags/v1.0', 'refs-tags-v1.0'],
    ['origin/main', 'origin-main'],
    ['HEAD', 'HEAD'],
    ['..foo..', 'foo'],
    ['--bar--', 'bar'],
    ['foo.', 'foo'],
    ['@@@', 'ref'],
    ['', 'ref'],
    ['...', 'ref'],
  ];

  for (const [input, expected] of table) {
    assert.equal(sanitizeSlotName(input), expected, `sanitizeSlotName(${JSON.stringify(input)})`);
  }

  const long = 'x'.repeat(200);
  const truncated = sanitizeSlotName(long);
  assert.equal(truncated, 'x'.repeat(60));
  assert.equal(truncated.length, 60);
  assert.ok(truncated.length <= 60);

  // A dash that lands on the truncation boundary must not survive.
  const dashAtBoundary = sanitizeSlotName(`${'a'.repeat(59)}-tail`);
  assert.equal(dashAtBoundary, 'a'.repeat(59));
  assert.ok(!dashAtBoundary.endsWith('-'));

  // Everything the function returns must be a legal Windows name fragment.
  for (const input of ['HEAD@{1}', 'feature/foo', 'a b c', 'ref: with? bad* chars', '😀', 'a'.repeat(99)]) {
    const name = sanitizeSlotName(input);
    assert.match(name, /^[A-Za-z0-9._-]+$/u, input);
    assert.ok(name.length > 0 && name.length <= 60, input);
    assert.doesNotMatch(name, /^[.-]/, input);
    assert.doesNotMatch(name, /[.-]$/, input);
  }
});

test('emptySidePath keeps the relative directory and extension and writes an empty file', async (t) => {
  const store = tempDir(t);
  const emptyRoot = path.join(store, 'empty');

  const target = await emptySidePath(store, 'src/deep/module/a.ts');
  assert.equal(target, path.join(emptyRoot, 'src', 'deep', 'module', 'a.ts'));
  assert.equal(fs.statSync(target).size, 0);
  assert.equal(path.extname(target), '.ts');
  assert.equal(fs.readFileSync(target, 'utf8'), '');
  assert.ok(isPathInside(emptyRoot, target));

  // Calling it again truncates a file that was edited in the meantime.
  fs.writeFileSync(target, 'not empty any more');
  assert.equal(fs.statSync(target).size, Buffer.byteLength('not empty any more'));
  await emptySidePath(store, 'src/deep/module/a.ts');
  assert.equal(fs.statSync(target).size, 0);

  // Backslashes are accepted as separators too (paths coming from Windows APIs).
  const backslash = await emptySidePath(store, 'src\\win\\b.ts');
  assert.equal(backslash, path.join(emptyRoot, 'src', 'win', 'b.ts'));
});

test('emptySidePath sanitises illegal segments but keeps the extension', async (t) => {
  const store = tempDir(t);
  const emptyRoot = path.join(store, 'empty');

  const illegal = await emptySidePath(store, 'bad<>:"|?*name.txt');
  assert.ok(isPathInside(emptyRoot, illegal));
  assert.equal(path.basename(illegal), 'bad_______name.txt');
  assert.doesNotMatch(path.basename(illegal), /[<>:"|?*]/);
  assert.equal(path.extname(illegal), '.txt');
  assert.equal(fs.statSync(illegal).size, 0);

  const reserved = await emptySidePath(store, 'src/CON/file.txt');
  assert.ok(isPathInside(emptyRoot, reserved));
  assert.match(toPosix(reserved), /\/_CON\/file\.txt$/);
  assert.equal(fs.existsSync(reserved), true);

  // Trailing dots/spaces are illegal on Windows.
  const trailing = await emptySidePath(store, 'dir./file .txt');
  assert.equal(path.basename(path.dirname(trailing)), 'dir');
  assert.equal(path.basename(trailing), 'file .txt');
});

test('emptySidePath never escapes <globalStorage>/empty', async (t) => {
  const store = tempDir(t);
  const emptyRoot = path.join(store, 'empty');
  const parent = path.dirname(store);

  const traversal = await emptySidePath(store, '../../escape/evil.ts');
  assert.ok(isPathInside(emptyRoot, traversal), 'traversal result must stay inside the empty-file root');
  assert.equal(path.basename(traversal), 'evil.ts');
  assert.equal(fs.existsSync(path.join(store, 'escape', 'evil.ts')), false);
  assert.equal(fs.existsSync(path.join(parent, 'escape', 'evil.ts')), false);
  assert.equal(fs.existsSync(path.join(parent, 'evil.ts')), false);

  const windowsAbsolute = await emptySidePath(store, 'C:\\Windows\\System32\\evil.txt');
  assert.ok(isPathInside(emptyRoot, windowsAbsolute));
  assert.equal(fs.existsSync(path.join(store, 'Windows', 'System32', 'evil.txt')), false);

  const emptyRelPath = await emptySidePath(store, '');
  assert.equal(emptyRelPath, path.join(emptyRoot, '_'));
  assert.equal(fs.statSync(emptyRelPath).size, 0);
});
