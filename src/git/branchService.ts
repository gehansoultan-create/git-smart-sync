import { GitRunner } from './gitRunner';
import { BranchInfo } from '../types';
import { assertSafeRemoteName, remoteNameProblem } from './validation';

/** Field separator for `for-each-ref` output (ASCII unit separator: cannot appear in a ref name or subject line). */
const FIELD_SEP = '\u001f';

export class BranchService {
  constructor(private readonly runner: GitRunner) {}

  /**
   * Retrieve all local branches with their latest commit subject and active status.
   *
   * Uses `for-each-ref refs/heads` rather than `git branch`: the latter also prints a pseudo entry
   * such as `(HEAD detached at abc1234)` that is not a branch, and `%(refname:short)` turns a
   * branch into `heads/<name>` when a tag with the same name exists. `lstrip=2` is unambiguous.
   */
  public async getLocalBranches(cwd: string, currentBranch: string): Promise<BranchInfo[]> {
    try {
      const format = ['%(refname:lstrip=2)', '%(objectname:short)', '%(contents:subject)'].join(FIELD_SEP);
      const output = await this.runner.execute(['for-each-ref', `--format=${format}`, 'refs/heads'], cwd);
      const lines = output.split('\n').filter(Boolean);

      const branches: BranchInfo[] = [];

      for (const line of lines) {
        const [name, hash, ...subjectParts] = line.split(FIELD_SEP);
        const subject = subjectParts.join(FIELD_SEP);
        if (!name) continue;

        const isCurrent = name === currentBranch;
        branches.push({
          name,
          isRemote: false,
          isCurrent,
          lastCommitHash: hash,
          lastCommitSubject: subject
        });
      }

      return branches;
    } catch {
      return [];
    }
  }

  /**
   * Retrieve all remote branches, stripped of the remote prefix.
   */
  public async getRemoteBranches(cwd: string, remote: string): Promise<BranchInfo[]> {
    if (remoteNameProblem(remote)) {
      return [];
    }
    try {
      // Only this remote's refs are listed, so no prefix matching is needed on other remotes.
      const output = await this.runner.execute(
        ['for-each-ref', '--format=%(refname)', `refs/remotes/${remote}`],
        cwd
      );
      const lines = output.split('\n').map(l => l.trim()).filter(Boolean);

      const branches: BranchInfo[] = [];
      const remotePrefix = `refs/remotes/${remote}/`;

      for (const line of lines) {
        if (line.startsWith(remotePrefix)) {
          const name = line.substring(remotePrefix.length);
          // `<remote>/HEAD` is a symbolic pointer to the default branch, not a branch. Only that exact
          // name is skipped: the old substring test also hid branches like `feature/AHEAD-fix`.
          if (name === 'HEAD') continue;
          branches.push({
            name,
            isRemote: true,
            isCurrent: false,
            remoteName: remote
          });
        }
      }

      return branches;
    } catch {
      return [];
    }
  }

  /**
   * Combine local and remote branches into a unified deduplicated list.
   */
  public async getAllBranches(cwd: string, remote: string, currentBranch: string): Promise<BranchInfo[]> {
    const [local, remoteBranches] = await Promise.all([
      this.getLocalBranches(cwd, currentBranch),
      this.getRemoteBranches(cwd, remote)
    ]);

    const branchMap = new Map<string, BranchInfo>();

    for (const b of local) {
      branchMap.set(b.name, b);
    }

    for (const rb of remoteBranches) {
      if (!branchMap.has(rb.name)) {
        branchMap.set(rb.name, rb);
      }
    }

    return Array.from(branchMap.values());
  }

  /**
   * Determine whether a branch can fast-forward to another commit ref
   * without losing commits (i.e., branch is an ancestor of targetRef).
   */
  public async canFastForward(branch: string, targetRef: string, cwd: string): Promise<boolean> {
    try {
      // Returns 0 if branch commit is ancestor of targetRef
      await this.runner.execute(['merge-base', '--is-ancestor', branch, targetRef], cwd);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve the commit SHA that HEAD points to, or undefined if the repository has no commits.
   */
  public async resolveHead(cwd: string): Promise<string | undefined> {
    try {
      return await this.runner.execute(['rev-parse', '--verify', 'HEAD'], cwd);
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve several full ref names (e.g. `refs/heads/main`) to their SHAs in one git call.
   * Refs that do not exist are simply absent from the returned map: `git for-each-ref` exits
   * successfully with no output for them, so an expected miss is not an error.
   * A real git failure (not a repository, corrupt repository, git missing, timeout) is NOT a
   * miss: the error propagates so callers cannot mistake it for "the branch does not exist".
   */
  public async resolveRefs(refNames: string[], cwd: string): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (refNames.length === 0) {
      return result;
    }

    const output = await this.runner.execute(
      ['for-each-ref', '--format=%(refname) %(objectname)', ...refNames],
      cwd
    );
    const wanted = new Set(refNames);
    for (const line of output.split('\n')) {
      const [ref, sha] = line.trim().split(' ');
      if (ref && sha && wanted.has(ref)) {
        result.set(ref, sha);
      }
    }
    return result;
  }

  /**
   * Get ahead/behind commit counts between two branches or refs.
   */
  public async getDivergenceCounts(
    refA: string,
    refB: string,
    cwd: string
  ): Promise<{ ahead: number; behind: number }> {
    try {
      const output = await this.runner.execute(['rev-list', '--left-right', '--count', `${refA}...${refB}`], cwd);
      const [aheadStr, behindStr] = output.trim().split(/\s+/);
      return {
        ahead: parseInt(aheadStr, 10) || 0,
        behind: parseInt(behindStr, 10) || 0
      };
    } catch {
      return { ahead: 0, behind: 0 };
    }
  }

  /**
   * Prune stale remote tracking branches.
   */
  public async pruneRemote(remote: string, cwd: string): Promise<string> {
    assertSafeRemoteName(remote);
    return this.runner.execute(['remote', 'prune', '--', remote], cwd);
  }
}
