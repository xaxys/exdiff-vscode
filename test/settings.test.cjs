'use strict';

/**
 * Headless tests for `out/core/settings.js` (`readConfig`).
 *
 * `ConfigSource` is a tiny interface, so the tests use a plain-object double
 * that records exactly which keys the reader probes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_CONFIG, readConfig } = require('../out/core/settings.js');

/** Minimal `ConfigSource` backed by a plain object; records every lookup. */
function source(values) {
  const lookups = [];
  return {
    lookups,
    get(key, defaultValue) {
      lookups.push(key);
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : defaultValue;
    },
  };
}

test('readConfig falls back to DEFAULT_CONFIG for an empty source', () => {
  const config = readConfig(source({}));

  assert.deepEqual(config, {
    baseRef: 'auto',
    snapshotDirTemplate: '${repoRoot}/.exdiff',
    autoAttach: 'ask',
    rightSide: 'workingTree',
    gitPath: 'git',
    maxFilesInTree: 2000,
    snapshotRetentionDays: 7,
  });
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.notEqual(config, DEFAULT_CONFIG, 'a fresh object must be returned, not the frozen default');
});

test('readConfig reads every full "exdiff.*" key', () => {
  const config = readConfig(
    source({
      'exdiff.baseRef': 'origin/main',
      'exdiff.snapshotDir': '${repoParent}/snapshots/${repoName}/${slot}',
      'exdiff.autoAttach': 'always',
      'exdiff.rightSide': 'ref',
      'exdiff.gitPath': 'C:\\Program Files\\Git\\cmd\\git.exe',
      'exdiff.maxFilesInTree': 50,
      'exdiff.snapshotRetentionDays': 30,
    }),
  );

  assert.deepEqual(config, {
    baseRef: 'origin/main',
    snapshotDirTemplate: '${repoParent}/snapshots/${repoName}/${slot}',
    autoAttach: 'always',
    rightSide: 'ref',
    gitPath: 'C:\\Program Files\\Git\\cmd\\git.exe',
    maxFilesInTree: 50,
    snapshotRetentionDays: 30,
  });
});

test('readConfig also accepts short keys (getConfiguration("exdiff") shape)', () => {
  const config = readConfig(
    source({
      baseRef: 'HEAD~2',
      snapshotDirTemplate: '/tmp/exdiff/${repoName}',
      autoAttach: 'never',
      rightSide: 'ref',
      gitPath: '/usr/local/bin/git',
      maxFilesInTree: 7,
      snapshotRetentionDays: 3,
    }),
  );

  assert.deepEqual(config, {
    baseRef: 'HEAD~2',
    snapshotDirTemplate: '/tmp/exdiff/${repoName}',
    autoAttach: 'never',
    rightSide: 'ref',
    gitPath: '/usr/local/bin/git',
    maxFilesInTree: 7,
    snapshotRetentionDays: 3,
  });
});

test('readConfig prefers the full key when both spellings are present', () => {
  const config = readConfig(
    source({
      'exdiff.baseRef': 'origin/develop',
      baseRef: 'HEAD~3',
      'exdiff.maxFilesInTree': 11,
      maxFilesInTree: 12,
    }),
  );

  assert.equal(config.baseRef, 'origin/develop');
  assert.equal(config.maxFilesInTree, 11);
});

test('readConfig accepts the snapshotDir/snapshotDirTemplate aliases', () => {
  assert.equal(
    readConfig(source({ 'exdiff.snapshotDir': '${repoParent}/a/${repoName}' })).snapshotDirTemplate,
    '${repoParent}/a/${repoName}',
  );
  assert.equal(
    readConfig(source({ snapshotDir: '${repoParent}/b/${repoName}' })).snapshotDirTemplate,
    '${repoParent}/b/${repoName}',
  );
  assert.equal(
    readConfig(source({ 'exdiff.snapshotDirTemplate': '${repoParent}/c/${repoName}' })).snapshotDirTemplate,
    '${repoParent}/c/${repoName}',
  );
});

test('readConfig rejects unknown enum values and restores the defaults', () => {
  assert.equal(readConfig(source({ 'exdiff.autoAttach': 'sometimes' })).autoAttach, 'ask');
  assert.equal(readConfig(source({ 'exdiff.autoAttach': 'ALWAYS' })).autoAttach, 'ask', 'enum values are case sensitive');
  assert.equal(readConfig(source({ 'exdiff.autoAttach': 42 })).autoAttach, 'ask');
  assert.equal(readConfig(source({ 'exdiff.autoAttach': '' })).autoAttach, 'ask');

  assert.equal(readConfig(source({ 'exdiff.rightSide': 'index' })).rightSide, 'workingTree');
  assert.equal(readConfig(source({ 'exdiff.rightSide': null })).rightSide, 'workingTree');
  assert.equal(readConfig(source({ 'exdiff.rightSide': 'ref' })).rightSide, 'ref');
});

test('readConfig rejects malformed numbers and keeps positive integers', () => {
  assert.equal(readConfig(source({ 'exdiff.maxFilesInTree': 0 })).maxFilesInTree, 2000);
  assert.equal(readConfig(source({ 'exdiff.maxFilesInTree': -5 })).maxFilesInTree, 2000);
  assert.equal(readConfig(source({ 'exdiff.maxFilesInTree': Number.NaN })).maxFilesInTree, 2000);
  assert.equal(readConfig(source({ 'exdiff.maxFilesInTree': Number.POSITIVE_INFINITY })).maxFilesInTree, 2000);
  assert.equal(readConfig(source({ 'exdiff.maxFilesInTree': 'not-a-number' })).maxFilesInTree, 2000);
  assert.equal(readConfig(source({ 'exdiff.maxFilesInTree': null })).maxFilesInTree, 2000);
  assert.equal(readConfig(source({ 'exdiff.maxFilesInTree': 1 })).maxFilesInTree, 1);
  assert.equal(readConfig(source({ 'exdiff.maxFilesInTree': 3.9 })).maxFilesInTree, 3);
  assert.equal(readConfig(source({ 'exdiff.maxFilesInTree': '42' })).maxFilesInTree, 42);
});

test('readConfig rejects empty strings and non-strings for string settings', () => {
  assert.equal(readConfig(source({ 'exdiff.baseRef': '   ' })).baseRef, 'auto');
  assert.equal(readConfig(source({ 'exdiff.baseRef': '' })).baseRef, 'auto');
  assert.equal(readConfig(source({ 'exdiff.baseRef': null })).baseRef, 'auto');
  assert.equal(readConfig(source({ 'exdiff.baseRef': 42 })).baseRef, 'auto');
  assert.equal(readConfig(source({ 'exdiff.baseRef': '  origin/main  ' })).baseRef, 'origin/main');

  assert.equal(readConfig(source({ 'exdiff.gitPath': '  ' })).gitPath, 'git');
  assert.equal(readConfig(source({ 'exdiff.gitPath': 'git-custom' })).gitPath, 'git-custom');

  assert.equal(readConfig(source({ 'exdiff.snapshotDir': '   ' })).snapshotDirTemplate, DEFAULT_CONFIG.snapshotDirTemplate);
});

test('readConfig probes the documented keys first', () => {
  const src = source({});
  readConfig(src);
  assert.equal(src.lookups[0], 'exdiff.baseRef');
  assert.ok(src.lookups.includes('exdiff.snapshotDir'));
  assert.ok(src.lookups.includes('exdiff.autoAttach'));
  assert.ok(src.lookups.includes('exdiff.rightSide'));
  assert.ok(src.lookups.includes('exdiff.gitPath'));
  assert.ok(src.lookups.includes('exdiff.maxFilesInTree'));
  assert.ok(src.lookups.includes('exdiff.snapshotRetentionDays'));
});

test('readConfig accepts 0 as "disable pruning" and rejects negative retention', () => {
  assert.equal(readConfig(source({ 'exdiff.snapshotRetentionDays': 0 })).snapshotRetentionDays, 0);
  assert.equal(readConfig(source({ 'exdiff.snapshotRetentionDays': -1 })).snapshotRetentionDays, 7);
  assert.equal(readConfig(source({ 'exdiff.snapshotRetentionDays': 3.9 })).snapshotRetentionDays, 3);
  assert.equal(readConfig(source({ snapshotRetentionDays: '14' })).snapshotRetentionDays, 14);
  assert.equal(readConfig(source({ 'exdiff.snapshotRetentionDays': 'nope' })).snapshotRetentionDays, 7);
});
