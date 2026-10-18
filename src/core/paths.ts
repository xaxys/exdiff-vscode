import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const MAX_SLOT_LENGTH = 60;

/** Names that Windows refuses to use as a file/directory name, with or without an extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Converts native separators to posix separators (Git always speaks posix). */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Path of `file` relative to `root`, using posix separators.
 *
 * Returns `null` when `file` is outside `root` (including a different Windows
 * drive). Comparison is case-insensitive on Windows because `path.relative`
 * normalises case there. The root itself yields `''`.
 */
export function relativeInside(root: string, file: string): string | null {
  const rootAbs = path.resolve(root);
  const fileAbs = path.resolve(file);
  const relative = path.relative(rootAbs, fileAbs);

  if (relative === '') return '';
  if (path.isAbsolute(relative)) return null;

  const segments = relative.split(path.sep);
  if (segments[0] === '..') return null;

  return segments.join('/');
}

/** `true` when `candidate` is a strict descendant of `root`. */
export function isPathInside(root: string, candidate: string): boolean {
  const relative = relativeInside(root, candidate);
  return relative !== null && relative !== '';
}

/**
 * Expands `${repoRoot}`, `${repoParent}`, `${repoName}` and `${slot}`.
 * Unknown variables are left untouched so users can spot typos in the setting.
 */
export function expandTemplate(
  template: string,
  vars: { repoParent: string; repoName: string; repoRoot: string; slot: string },
): string {
  return template.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match: string, name: string) => {
    switch (name) {
      case 'repoRoot':
        return vars.repoRoot;
      case 'repoParent':
        return vars.repoParent;
      case 'repoName':
        return vars.repoName;
      case 'slot':
        return vars.slot;
      default:
        return match;
    }
  });
}

/**
 * Turns an arbitrary ref (`feature/foo`, `HEAD@{1}`, `refs/tags/v1.0`) into a
 * directory name that is safe on Windows: `[A-Za-z0-9._-]` only, at most 60
 * characters, no leading/trailing dots or dashes, never a reserved device name.
 */
export function sanitizeSlotName(ref: string): string {
  let name = ref.replace(/[^A-Za-z0-9._-]/g, '-');
  name = name.replace(/-{2,}/g, '-').replace(/^[-.]+/, '').replace(/[-.]+$/, '');

  if (name.length > MAX_SLOT_LENGTH) {
    name = name.slice(0, MAX_SLOT_LENGTH).replace(/[-.]+$/, '');
  }
  if (!name) return 'ref';

  const stem = name.split('.')[0] ?? '';
  if (WINDOWS_RESERVED.test(stem)) {
    name = `_${name}`.slice(0, MAX_SLOT_LENGTH);
  }
  return name;
}

/**
 * Creates (or truncates) an empty file for the missing side of a diff at
 * `<baseDir>/empty/<relPath>` and returns its absolute path.
 *
 * The relative directory structure and the extension are preserved so that
 * VS Code still picks the right language mode for syntax highlighting.
 */
export async function emptySidePath(baseDir: string, relPath: string): Promise<string> {
  const root = path.resolve(baseDir, 'empty');
  const target = path.resolve(root, portableRelativePath(relPath));
  if (!isPathInside(root, target)) {
    throw new Error(`Refusing to create an empty file outside "${root}": ${relPath}`);
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, '', 'utf8');
  return target;
}

function portableRelativePath(relPath: string): string {
  const segments = toPosix(relPath)
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    .map(sanitizeSegment);
  return segments.length > 0 ? segments.join('/') : '_';
}

function sanitizeSegment(segment: string): string {
  let name = segment.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
  if (!name) return '_';
  const stem = name.split('.')[0] ?? '';
  if (WINDOWS_RESERVED.test(stem)) {
    name = `_${name}`;
  }
  return name;
}
