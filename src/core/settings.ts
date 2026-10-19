import type { ExDiffConfig } from './types';

/**
 * Minimal configuration reader. In VS Code this is backed by
 * `vscode.workspace.getConfiguration()`, in tests by a plain object.
 */
export interface ConfigSource {
  get<T>(key: string, defaultValue: T): T;
}

export const DEFAULT_CONFIG: ExDiffConfig = Object.freeze({
  baseRef: 'auto',
  snapshotDirTemplate: '${repoRoot}/.exdiff',
  autoAttach: 'ask',
  rightSide: 'workingTree',
  gitPath: 'git',
  maxFilesInTree: 2000,
  snapshotRetentionDays: 7,
});

const AUTO_ATTACH_VALUES = ['ask', 'always', 'never'] as const;
const RIGHT_SIDE_VALUES = ['workingTree', 'ref'] as const;

/**
 * Candidate keys per setting. Lookups are tried in order and the first
 * non-`undefined` value wins, so a single `config.get` implementation can be
 * backed either by `getConfiguration()` (full keys such as `exdiff.baseRef`),
 * by `getConfiguration('exdiff')` (short keys such as `baseRef`) or by a test
 * double keyed with `ExDiffConfig` property names.
 */
const SETTING_KEYS = {
  baseRef: ['exdiff.baseRef', 'baseRef'],
  snapshotDir: ['exdiff.snapshotDir', 'snapshotDir', 'exdiff.snapshotDirTemplate', 'snapshotDirTemplate'],
  autoAttach: ['exdiff.autoAttach', 'autoAttach'],
  rightSide: ['exdiff.rightSide', 'rightSide'],
  gitPath: ['exdiff.gitPath', 'gitPath'],
  maxFilesInTree: ['exdiff.maxFilesInTree', 'maxFilesInTree'],
  snapshotRetentionDays: ['exdiff.snapshotRetentionDays', 'snapshotRetentionDays'],
} as const;

/**
 * Reads `ExDiffConfig` from `src`, falling back to {@link DEFAULT_CONFIG} for
 * missing or malformed values.
 */
export function readConfig(src: ConfigSource): ExDiffConfig {
  return {
    baseRef: nonEmptyString(lookup(src, SETTING_KEYS.baseRef), DEFAULT_CONFIG.baseRef),
    snapshotDirTemplate: nonEmptyString(lookup(src, SETTING_KEYS.snapshotDir), DEFAULT_CONFIG.snapshotDirTemplate),
    autoAttach: oneOf(lookup(src, SETTING_KEYS.autoAttach), AUTO_ATTACH_VALUES, DEFAULT_CONFIG.autoAttach),
    rightSide: oneOf(lookup(src, SETTING_KEYS.rightSide), RIGHT_SIDE_VALUES, DEFAULT_CONFIG.rightSide),
    gitPath: nonEmptyString(lookup(src, SETTING_KEYS.gitPath), DEFAULT_CONFIG.gitPath),
    maxFilesInTree: positiveInteger(lookup(src, SETTING_KEYS.maxFilesInTree), DEFAULT_CONFIG.maxFilesInTree),
    snapshotRetentionDays: nonNegativeInteger(
      lookup(src, SETTING_KEYS.snapshotRetentionDays),
      DEFAULT_CONFIG.snapshotRetentionDays,
    ),
  };
}

function lookup(src: ConfigSource, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = src.get<unknown>(key, undefined);
    if (value !== undefined) return value;
  }
  return undefined;
}

function nonEmptyString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}
