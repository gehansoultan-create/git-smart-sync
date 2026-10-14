import * as vscode from 'vscode';
import { GitRunner } from '../git/gitRunner';
import { BranchService } from '../git/branchService';
import { SyncOptions, SyncBatchReport, SyncBranchResult } from '../types';

/**
 * What the engine decided to do for a single branch, before touching anything.
 * The same plan drives both real syncs and dry-runs, so a dry-run reports exactly
 * what a real sync would do (and what it would refuse to do).
 */
interface BranchPlan {
  branch: string;
  action: 'push-current' | 'push-other' | 'up-to-date' | 'blocked';
  /** Human-readable reason, set when the branch is blocked. */
  reason?: string;
  headSha: string;
  /** Tip of the local branch (undefined if there is no local branch). */
  localSha?: string;
  /** Tip of the remote-tracking branch as of the last fetch (undefined if the branch is new on the remote). */
  remoteSha?: string;
  /** True when the local branch has commits that are not in HEAD and will be overwritten locally. */
  overwriteLocal: boolean;
  /** True when the remote branch is not an ancestor of HEAD, so the push needs --force-with-lease. */
  forceRemote: boolean;
}

const short = (sha: string | undefined): string => (sha ? sha.substring(0, 7) : 'none');

export class SyncEngine {
  constructor(
    private readonly runner: GitRunner,
    private readonly branchService: BranchService
  ) {}

  /**
   * Execute synchronization for a list of branches against target remote.
   *
   * Real syncs fetch the remote first so every safety check compares against the remote's
   * current state. Dry-runs never touch the network: they plan against the remote-tracking
   * refs from the last fetch.
   */
  public async syncBranches(
    branches: string[],
    cwd: string,
    currentBranch: string,
    options: SyncOptions,
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
    token?: vscode.CancellationToken
  ): Promise<SyncBatchReport> {
    const startTime = Date.now();
    const results: SyncBranchResult[] = [];
    const stepIncrement = branches.length > 0 ? 100 / branches.length : 100;

    let headSha = branches.length > 0 ? await this.branchService.resolveHead(cwd) : undefined;
    if (branches.length > 0 && !headSha) {
      for (const branch of branches) {
        results.push({ branch, status: 'failed', message: 'Cannot resolve HEAD (does the repository have any commits?)' });
      }
      return this.buildReport(options.remote, results, startTime);
    }

    if (!options.dryRun && branches.length > 0) {
      // Without a fresh view of the remote every safety decision would rest on stale data,
      // so a failed fetch stops the whole sync before anything is pushed or moved.
      const fetchError = await this.refreshRemote(options.remote, cwd, token);
      if (fetchError) {
        const message = `Could not fetch '${options.remote}': ${fetchError} Nothing was pushed and no local branch was changed.`;
        return this.buildReport(options.remote, this.stopAll(branches, message, token), startTime);
      }

      // Pull happens once, up front: the pull moves HEAD, and every branch (before or after the
      // current one in the list) must be planned and pushed with that same final HEAD.
      // If the pull fails, HEAD is not the integrated state the user asked for, so publishing it
      // to the other branches would be wrong: the whole sync stops before anything is pushed or moved.
      if (options.pullBeforePush && branches.includes(currentBranch)) {
        const pullError = await this.pullCurrentBranch(options.remote, currentBranch, cwd, token);
        if (pullError) {
          const message =
            `Sync stopped because the pull of '${currentBranch}' from '${options.remote}' failed. ` +
            `Nothing was pushed and no local branch was changed. Git said: ${pullError}`;
          return this.buildReport(options.remote, this.stopAll(branches, message, token), startTime);
        }
        headSha = (await this.branchService.resolveHead(cwd)) ?? headSha;
      }
    }

    for (const branch of branches) {
      if (token?.isCancellationRequested) {
        results.push({
          branch,
          status: 'skipped',
          message: 'Operation cancelled by user'
        });
        continue;
      }

      progress?.report({
        message: `Syncing [${branch}]...`,
        increment: stepIncrement
      });

      const branchStart = Date.now();

      try {
        const plan = await this.planBranch(branch, cwd, currentBranch, headSha as string, options);

        if (plan.action === 'blocked') {
          results.push({ branch, status: 'failed', message: plan.reason, durationMs: Date.now() - branchStart });
          continue;
        }

        if (plan.action === 'up-to-date') {
          results.push({
            branch,
            status: 'up-to-date',
            message: `${options.remote}/${branch} is already at ${short(headSha)}`,
            durationMs: Date.now() - branchStart
          });
          continue;
        }

        if (options.dryRun) {
          results.push({
            branch,
            status: 'success',
            message: this.describeDryRun(plan, options),
            durationMs: Date.now() - branchStart
          });
          continue;
        }

        const result = await this.executePlan(plan, cwd, options, token);
        results.push({ ...result, durationMs: Date.now() - branchStart });
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        results.push({
          branch,
          // A user cancellation is not a failure of the branch itself.
          status: token?.isCancellationRequested ? 'skipped' : 'failed',
          message: errorMsg,
          durationMs: Date.now() - branchStart
        });
      }
    }

    return this.buildReport(options.remote, results, startTime);
  }

  /**
   * Update remote-tracking refs so divergence checks and force-with-lease compare against
   * the remote's real state. `--prune` drops remote-tracking refs of branches that were deleted
   * on the remote, otherwise a stale ref could make a deleted branch look "up-to-date".
   *
   * Returns the error message when the fetch failed (the caller must then abort), else undefined.
   */
  private async refreshRemote(remote: string, cwd: string, token?: vscode.CancellationToken): Promise<string | undefined> {
    try {
      await this.runner.execute(['fetch', '--prune', remote], cwd, token);
      return undefined;
    } catch (err: unknown) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Result for every selected branch when the sync is stopped before any branch was processed.
   * A user cancellation is reported as skipped, anything else as failed with `message`.
   */
  private stopAll(branches: string[], message: string, token?: vscode.CancellationToken): SyncBranchResult[] {
    const cancelled = token?.isCancellationRequested === true;
    return branches.map(branch => ({
      branch,
      status: cancelled ? 'skipped' : 'failed',
      message: cancelled ? 'Operation cancelled by user' : message
    }));
  }

  /**
   * Pull the current branch from the remote. Returns the error message on failure, else undefined.
   */
  private async pullCurrentBranch(
    remote: string,
    branch: string,
    cwd: string,
    token?: vscode.CancellationToken
  ): Promise<string | undefined> {
    try {
      await this.runner.execute(['pull', remote, branch], cwd, token);
      return undefined;
    } catch (err: unknown) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Decide what to do for one branch without changing anything.
   */
  private async planBranch(
    branch: string,
    cwd: string,
    currentBranch: string,
    headSha: string,
    options: SyncOptions
  ): Promise<BranchPlan> {
    const localRef = `refs/heads/${branch}`;
    const remoteRef = `refs/remotes/${options.remote}/${branch}`;
    const refs = await this.branchService.resolveRefs([localRef, remoteRef], cwd);
    const localSha = refs.get(localRef);
    const remoteSha = refs.get(remoteRef);

    const isCurrent = branch === currentBranch;
    const allowForce = options.strategy === 'force-with-lease';
    const base = { branch, headSha, localSha, remoteSha };

    if (remoteSha === headSha && (localSha === undefined || localSha === headSha)) {
      return { ...base, action: 'up-to-date', overwriteLocal: false, forceRemote: false };
    }

    // Two independent decisions: (1) may the LOCAL branch pointer be moved over its own commits,
    // (2) does the REMOTE push need --force-with-lease. A diverged local branch says nothing about
    // whether the remote can simply be fast-forwarded, so each has its own condition.
    let overwriteLocal = false;
    let forceRemote = false;

    // Moving another local branch to HEAD must not silently drop commits that only exist on it.
    if (!isCurrent && localSha && localSha !== headSha) {
      if (!(await this.branchService.canFastForward(localSha, headSha, cwd))) {
        if (!allowForce) {
          return {
            ...base,
            action: 'blocked',
            overwriteLocal: false,
            forceRemote: false,
            reason: `Local branch '${branch}' has commits that are not in HEAD (diverged); refusing to move it. Use the 'force-with-lease' strategy to override.`
          };
        }
        overwriteLocal = true;
      }
    }

    // The remote branch must be an ancestor of HEAD for a plain (fast-forward) push.
    // A dry-run never pulls, so for the current branch it assumes the pull would integrate the
    // remote commits; a real sync has already pulled, so the check below is the real one.
    const pullWillIntegrate = isCurrent && options.pullBeforePush === true && options.dryRun === true;
    if (remoteSha && remoteSha !== headSha && !pullWillIntegrate) {
      if (!(await this.branchService.canFastForward(remoteSha, headSha, cwd))) {
        // The current branch is never force-pushed; the user has to pull or merge first.
        if (isCurrent || !allowForce) {
          return {
            ...base,
            action: 'blocked',
            overwriteLocal: false,
            forceRemote: false,
            reason: `${options.remote}/${branch} has commits that are not in HEAD (remote is ahead or diverged). Pull/merge first${isCurrent ? '' : ", or use the 'force-with-lease' strategy to override"}.`
          };
        }
        forceRemote = true;
      }
    }

    return { ...base, action: isCurrent ? 'push-current' : 'push-other', overwriteLocal, forceRemote };
  }

  /**
   * Perform the push for a planned branch. The local branch pointer is only moved
   * AFTER the push succeeded, so a rejected push never leaves local state half-updated.
   */
  private async executePlan(
    plan: BranchPlan,
    cwd: string,
    options: SyncOptions,
    token?: vscode.CancellationToken
  ): Promise<SyncBranchResult> {
    const { branch } = plan;
    const target = `${options.remote}/${branch}`;

    if (plan.action === 'push-current') {
      // Any pull-before-push already happened once, up front, in syncBranches.
      await this.runner.execute(['push', options.remote, branch], cwd, token);
      return { branch, status: 'success', message: `Successfully pushed to ${target}` };
    }

    const pushArgs = ['push', options.remote];
    if (plan.forceRemote) {
      // Pin the lease to the remote tip we inspected; if somebody pushed since, git refuses.
      pushArgs.push(plan.remoteSha ? `--force-with-lease=refs/heads/${branch}:${plan.remoteSha}` : '--force-with-lease');
    }
    pushArgs.push(`${plan.headSha}:refs/heads/${branch}`);
    await this.runner.execute(pushArgs, cwd, token);

    const notes: string[] = [];
    const result: SyncBranchResult = { branch, status: 'success' };

    // Wording only: the push command above still runs, but when the remote branch was already
    // at HEAD (as of the fetch) git transfers nothing, so the message must not claim a push.
    const remoteAlreadyAtHead = plan.remoteSha === plan.headSha;

    if (plan.forceRemote && plan.remoteSha) {
      result.previousRemoteSha = plan.remoteSha;
      notes.push(`overwrote remote ${short(plan.remoteSha)}`);
    }

    if (plan.localSha && plan.localSha !== plan.headSha) {
      try {
        await this.runner.execute(['branch', '-f', branch, plan.headSha], cwd, token);
        result.previousLocalSha = plan.localSha;
        if (plan.overwriteLocal) {
          notes.push(`local branch was ${short(plan.localSha)}`);
        } else if (remoteAlreadyAtHead) {
          notes.push(`local branch moved from ${short(plan.localSha)}`);
        }
      } catch (err: unknown) {
        // e.g. the branch is checked out in another worktree. The push itself already succeeded.
        const reason = err instanceof Error ? err.message : String(err);
        notes.push(`local branch '${branch}' was not moved: ${reason}`);
      }
    }

    const headline = remoteAlreadyAtHead
      ? `${target} was already at ${short(plan.headSha)}; nothing was pushed`
      : `Successfully pushed to ${target}`;
    result.message = `${headline}${notes.length ? ` (${notes.join('; ')})` : ''}`;
    return result;
  }

  private describeDryRun(plan: BranchPlan, options: SyncOptions): string {
    const target = `${options.remote}/${plan.branch}`;
    const details: string[] = [];
    if (plan.remoteSha === plan.headSha) {
      // Only the local branch pointer would change; there is nothing to send to the remote.
      const discarded = plan.overwriteLocal ? ', discarding its own commits' : '';
      return `[Dry Run] ${target} is already at ${short(plan.headSha)}; nothing to push (would only move local branch '${plan.branch}' from ${short(plan.localSha)}${discarded})`;
    }
    if (plan.remoteSha === undefined) {
      details.push('new branch on remote');
    }
    if (plan.forceRemote) {
      details.push('would use --force-with-lease and overwrite commits on the remote');
    }
    if (plan.overwriteLocal) {
      details.push(`local branch (${short(plan.localSha)}) has commits not in HEAD and would be overwritten`);
    }
    if (plan.action === 'push-current' && options.pullBeforePush) {
      details.push('would pull first');
    }
    return `[Dry Run] Would push ${short(plan.headSha)} to ${target}${details.length ? ` (${details.join('; ')})` : ''}`;
  }

  private buildReport(remote: string, results: SyncBranchResult[], startTime: number): SyncBatchReport {
    const count = (status: SyncBranchResult['status']): number => results.filter(r => r.status === status).length;

    return {
      timestamp: new Date(),
      remote,
      results,
      successCount: count('success'),
      failedCount: count('failed'),
      skippedCount: count('skipped'),
      upToDateCount: count('up-to-date'),
      totalDurationMs: Date.now() - startTime
    };
  }
}
