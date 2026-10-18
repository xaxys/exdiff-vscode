import type { RangeDiffPair } from './types';

/**
 * Range-diff header line, e.g.
 *
 * ```
 * 1:  cee5f44 < -:  ------- my feature
 * -:  ------- > 1:  22a9e01 upstream change
 * 1:  9a104a9 ! 1:  882a3be feat: change b
 * ```
 */
const HEADER_PATTERN = /^(\d+|-):\s+([0-9a-f]{7,40}|-+)\s+([<>=!])\s+(\d+|-):\s+([0-9a-f]{7,40}|-+)\s+(.*)$/;

/**
 * Parses the pair headers of a `git range-diff` run.
 * Explanation lines before the first header are ignored.
 *
 * `index` is the 1-based position of the header in the output (it is *not* the
 * commit number shown in the header, which differs when commits are unpaired).
 */
export function parseRangeDiff(stdout: string): RangeDiffPair[] {
  const pairs: RangeDiffPair[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    const match = HEADER_PATTERN.exec(line);
    if (!match) continue;

    pairs.push({
      index: pairs.length + 1,
      relation: match[3] as RangeDiffPair['relation'],
      oldIndex: match[1] === '-' ? null : Number.parseInt(match[1], 10),
      newIndex: match[4] === '-' ? null : Number.parseInt(match[4], 10),
      oldSha: normalizeSha(match[2]),
      newSha: normalizeSha(match[5]),
      subject: match[6].trim(),
    });
  }

  return pairs;
}

/**
 * Splits range-diff output into one chunk per pair: the header line plus the
 * indented patch that follows it. Text before the first header and the empty
 * tail after the last chunk are dropped.
 */
export function splitPairPatches(stdout: string): { header: string; patch: string }[] {
  const chunks: { header: string; patch: string }[] = [];
  let header: string | null = null;
  let patchLines: string[] = [];

  const flush = (): void => {
    if (header === null) return;
    chunks.push({ header, patch: patchLines.join('\n').replace(/\n+$/, '') });
  };

  for (const line of stdout.split(/\r?\n/)) {
    if (HEADER_PATTERN.test(line)) {
      flush();
      header = line;
      patchLines = [];
    } else if (header !== null) {
      patchLines.push(line);
    }
  }
  flush();

  return chunks;
}

/**
 * English source label for a range-diff relation character.
 *
 * Core cannot depend on `vscode`, so this returns the English string that the
 * UI layer feeds to `vscode.l10n.t()` for translation.
 */
export function relationshipLabel(relation: RangeDiffPair['relation']): string {
  switch (relation) {
    case '=':
      return 'unchanged';
    case '!':
      return 'rewritten';
    case '<':
      return 'only in old';
    case '>':
      return 'only in new';
    default:
      return 'unknown';
  }
}

function normalizeSha(value: string): string | null {
  return /^-+$/.test(value) ? null : value;
}
