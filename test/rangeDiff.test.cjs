'use strict';

/**
 * Headless tests for `out/core/rangeDiff.js`.
 *
 * The parser is fed both hand-written samples (so every relation character and
 * every "unpaired" shape is covered deterministically) and the real output of a
 * conflicting rebase fixture.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseRangeDiff, relationshipLabel, splitPairPatches } = require('../out/core/rangeDiff.js');
const { rangeDiff } = require('../out/core/git.js');
const { cleanup, createRepo, rebaseOntoUpstream } = require('./fixtures/make-repo.cjs');

test('parseRangeDiff parses <, >, = and ! headers with unpaired commits', () => {
  const sample = [
    'Range-diff against 9a104a9:',
    '1:  cee5f44 < -:  ------- my feature',
    '-:  ------- > 1:  22a9e01 upstream change',
    '2:  9a104a9 = 2:  882a3be feat: change b',
    '3:  1111111 ! 3:  2222222 feat: rewritten',
    '',
  ].join('\n');

  const pairs = parseRangeDiff(sample);
  assert.equal(pairs.length, 4, 'the explanation line before the first header is ignored');

  assert.deepEqual(pairs[0], {
    index: 1,
    relation: '<',
    oldIndex: 1,
    newIndex: null,
    oldSha: 'cee5f44',
    newSha: null,
    subject: 'my feature',
  });

  assert.deepEqual(pairs[1], {
    index: 2,
    relation: '>',
    oldIndex: null,
    newIndex: 1,
    oldSha: null,
    newSha: '22a9e01',
    subject: 'upstream change',
  });

  assert.deepEqual(pairs[2], {
    index: 3,
    relation: '=',
    oldIndex: 2,
    newIndex: 2,
    oldSha: '9a104a9',
    newSha: '882a3be',
    subject: 'feat: change b',
  });

  assert.deepEqual(pairs[3], {
    index: 4,
    relation: '!',
    oldIndex: 3,
    newIndex: 3,
    oldSha: '1111111',
    newSha: '2222222',
    subject: 'feat: rewritten',
  });
});

test('parseRangeDiff ignores text that is not a pair header', () => {
  assert.deepEqual(parseRangeDiff(''), []);
  assert.deepEqual(parseRangeDiff('nothing to see here\n\n'), []);
  assert.deepEqual(parseRangeDiff('1: short < -: ------- subject\n'), [], 'abbreviated SHAs below 7 chars are not headers');
});

test('parseRangeDiff parses real range-diff output from a conflicting rebase', async (t) => {
  const repo = await createRepo({ initialCommit: false });
  t.after(() => cleanup(repo));

  const ranges = await rebaseOntoUpstream(repo);
  const output = await rangeDiff(
    repo.repoInfo,
    { base: ranges.oldBase, tip: ranges.oldTip },
    { base: ranges.newBase, tip: ranges.newTip },
  );

  const pairs = parseRangeDiff(output);
  assert.equal(pairs.length, 2, `expected two pairs, got:\n${output}`);
  assert.ok(
    pairs.some((pair) => pair.relation === '!'),
    `expected at least one rewritten ("!") pair, got:\n${output}`,
  );
  assert.ok(
    pairs.some((pair) => pair.relation === '='),
    `expected the cleanly replayed commit to be unmodified ("="), got:\n${output}`,
  );

  const rewritten = pairs.find((pair) => pair.relation === '!');
  assert.equal(rewritten.index, 2);
  assert.equal(rewritten.oldIndex, 2);
  assert.equal(rewritten.newIndex, 2);
  assert.equal(rewritten.subject, 'feat: change shared lines 4-6');
  assert.ok(ranges.oldTip.startsWith(rewritten.oldSha), `${rewritten.oldSha} must prefix ${ranges.oldTip}`);
  assert.ok(ranges.newTip.startsWith(rewritten.newSha), `${rewritten.newSha} must prefix ${ranges.newTip}`);
  assert.notEqual(rewritten.oldSha, rewritten.newSha);

  for (const pair of pairs) {
    if (pair.oldSha) assert.match(pair.oldSha, /^[0-9a-f]{7,40}$/);
    if (pair.newSha) assert.match(pair.newSha, /^[0-9a-f]{7,40}$/);
  }
});

test('splitPairPatches returns one chunk per header, keeping indented patches', () => {
  const sample = [
    'preamble that belongs to no pair',
    '1:  aaaaaaa = 1:  bbbbbbb same subject',
    '',
    '2:  ccccccc ! 2:  ddddddd changed subject',
    '    @@ file.txt',
    '     context',
    '    -old',
    '    +new',
    '',
    '',
    '3:  eeeeeee < -:  ------- only old',
  ].join('\n');

  const chunks = splitPairPatches(sample);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks[0], { header: '1:  aaaaaaa = 1:  bbbbbbb same subject', patch: '' });
  assert.deepEqual(chunks[1], {
    header: '2:  ccccccc ! 2:  ddddddd changed subject',
    patch: '    @@ file.txt\n     context\n    -old\n    +new',
  });
  assert.deepEqual(chunks[2], { header: '3:  eeeeeee < -:  ------- only old', patch: '' });

  assert.deepEqual(splitPairPatches(''), []);
  assert.deepEqual(splitPairPatches('only a preamble\n'), []);
});

test('splitPairPatches matches the real "range-diff --patch" output', async (t) => {
  const repo = await createRepo({ initialCommit: false });
  t.after(() => cleanup(repo));

  const ranges = await rebaseOntoUpstream(repo);
  const output = await rangeDiff(
    repo.repoInfo,
    { base: ranges.oldBase, tip: ranges.oldTip },
    { base: ranges.newBase, tip: ranges.newTip },
    { patch: true },
  );

  const pairs = parseRangeDiff(output);
  const chunks = splitPairPatches(output);
  assert.equal(chunks.length, pairs.length, 'one chunk per pair header');

  for (let index = 0; index < pairs.length; index += 1) {
    assert.ok(chunks[index].header.startsWith(`${pairs[index].oldIndex ?? '-'}:`), chunks[index].header);
  }

  const rewrittenIndex = pairs.findIndex((pair) => pair.relation === '!');
  assert.ok(rewrittenIndex >= 0, `expected a rewritten pair in:\n${output}`);
  const rewrittenPatch = chunks[rewrittenIndex].patch;
  assert.notEqual(rewrittenPatch, '', 'a rewritten pair must carry a patch');
  assert.match(rewrittenPatch, /^\s+@@ shared\.txt$/m, 'the patch must contain an indented hunk header');
  assert.match(rewrittenPatch, /^\s+-line04$/m, 'removed lines are prefixed with "-"');
  assert.match(rewrittenPatch, /^\s+\+line04-feature$/m, 'added lines are prefixed with "+"');
  assert.match(rewrittenPatch, /^\s+\+\+line05-resolved$/m, 'two-column range-diff marks the new side of a replacement');
  assert.match(rewrittenPatch, /^\s+--line05$/m, 'two-column range-diff marks the old side of a replacement');

  const equalIndex = pairs.findIndex((pair) => pair.relation === '=');
  assert.ok(equalIndex >= 0);
  assert.equal(chunks[equalIndex].patch, '', 'an unmodified pair has no patch and must not throw');
});

test('relationshipLabel maps every relation and falls back to "unknown"', () => {
  assert.equal(relationshipLabel('='), 'unchanged');
  assert.equal(relationshipLabel('!'), 'rewritten');
  assert.equal(relationshipLabel('<'), 'only in old');
  assert.equal(relationshipLabel('>'), 'only in new');
  assert.equal(relationshipLabel('?'), 'unknown');
  assert.equal(relationshipLabel('x'), 'unknown');
  assert.equal(relationshipLabel(undefined), 'unknown');
});
