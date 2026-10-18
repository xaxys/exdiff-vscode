import type { RefInfo, RepoInfo } from './types';
import { listRefs } from './git';

export { parseReflog } from './git';

/**
 * All refs a picker needs: local branches, remote branches, tags, the 20 most
 * recent commits and the 10 most recent reflog entries.
 *
 * The implementation lives in `git.ts` (`listRefs`) so that `git.ts` never has
 * to import `refs.ts`; this module is the public surface required by the core
 * contract.
 */
export async function collectRefs(repo: RepoInfo, gitPath?: string): Promise<RefInfo[]> {
  return await listRefs(repo, gitPath);
}
