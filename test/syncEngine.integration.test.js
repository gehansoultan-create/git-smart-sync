// Integration tests: real git repositories (a bare "remote" plus working clones) in a temp dir.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GitRunner } = require('../dist/git/gitRunner');
const { BranchService } = require('../dist/git/branchService');
const { SyncEngine } = require('../dist/sync/syncEngine');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(cwd, file, content, message) {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

function configure(cwd) {
  git(cwd, 'config', 'user.name', 'Test');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'commit.gpgsign', 'false');
}

describe('SyncEngine (real repositories)', () => {
  let root, remote, work, c1, engine;

  const sync = (branches, options = {}) =>
    engine.syncBranches(branches, work, 'main', { remote: 'origin', strategy: 'fast-forward', ...options });
  const remoteSha = branch => git(remote, 'rev-parse', `refs/heads/${branch}`);
  const localSha = branch => git(work, 'rev-parse', `refs/heads/${branch}`);

  /** Create a branch at c1 on both the remote and locally. */
  const seedBranch = name => {
    git(work, 'branch', name, c1);
    git(work, 'push', '-q', 'origin', `${name}:${name}`);
  };

  /** Push an extra commit to origin/<branch> from a second clone, unknown to `work`. */
  const pushFromOtherClone = branch => {
    const other = path.join(root, 'other');
    git(root, 'clone', '-q', remote, other);
    configure(other);
    git(other, 'checkout', '-q', '-B', branch, `origin/${branch}`);
    const sha = commit(other, 'other.txt', 'someone else', 'remote-only commit');
    git(other, 'push', '-q', 'origin', branch);
    return sha;
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gss-'));
    remote = path.join(root, 'remote.git');
    work = path.join(root, 'work');
    git(root, 'init', '-q', '--bare', '-b', 'main', remote);
    git(root, 'clone', '-q', remote, work);
    configure(work);
    git(work, 'checkout', '-q', '-B', 'main');
    c1 = commit(work, 'a.txt', 'one', 'c1');
    git(work, 'push', '-q', '-u', 'origin', 'main');
    engine = new SyncEngine(new GitRunner(), new BranchService(new GitRunner()));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('fast-forwards another branch (remote and local) to HEAD', async () => {
    seedBranch('staging');
    const c2 = commit(work, 'a.txt', 'two', 'c2');
    git(work, 'push', '-q', 'origin', 'main');

    const report = await sync(['staging']);

    assert.strictEqual(report.results[0].status, 'success', report.results[0].message);
    assert.strictEqual(remoteSha('staging'), c2);
    assert.strictEqual(localSha('staging'), c2);
  });

  test('creates a branch that does not exist yet on the remote', async () => {
    const report = await sync(['release']);

    assert.strictEqual(report.results[0].status, 'success', report.results[0].message);
    assert.strictEqual(remoteSha('release'), c1);
  });

  test('refuses to move a local branch that has diverged from HEAD', async () => {
    seedBranch('staging');
    git(work, 'checkout', '-q', 'staging');
    const own = commit(work, 'b.txt', 'only on staging', 'staging-only');
    git(work, 'checkout', '-q', 'main');
    commit(work, 'a.txt', 'two', 'c2');

    const report = await sync(['staging']);

    assert.strictEqual(report.results[0].status, 'failed');
    assert.match(report.results[0].message, /diverged/);
    assert.strictEqual(localSha('staging'), own, 'local commits must not be dropped');
    assert.strictEqual(remoteSha('staging'), c1, 'remote must be untouched');
  });

  test('uses the real remote state: blocks when the remote branch is ahead, keeps local pointer', async () => {
    seedBranch('staging');
    const remoteOnly = pushFromOtherClone('staging');
    commit(work, 'a.txt', 'two', 'c2');

    const report = await sync(['staging']);

    assert.strictEqual(report.results[0].status, 'failed');
    assert.match(report.results[0].message, /origin\/staging has commits that are not in HEAD/);
    assert.strictEqual(localSha('staging'), c1, 'local branch must not move when the sync is refused');
    assert.strictEqual(remoteSha('staging'), remoteOnly);
  });

  test('force-with-lease overwrites a diverged remote and reports the overwritten SHA', async () => {
    seedBranch('staging');
    const remoteOnly = pushFromOtherClone('staging');
    const c2 = commit(work, 'a.txt', 'two', 'c2');

    const report = await sync(['staging'], { strategy: 'force-with-lease' });

    assert.strictEqual(report.results[0].status, 'success', report.results[0].message);
    assert.strictEqual(report.results[0].previousRemoteSha, remoteOnly);
    assert.strictEqual(remoteSha('staging'), c2);
    assert.strictEqual(localSha('staging'), c2);
  });

  test('a rejected push does not move the local branch pointer', async () => {
    seedBranch('staging');
    // Make the remote refuse to update refs/heads/staging. A stale lock file does that on every
    // platform ("cannot lock ref"), unlike a shell hook, which needs `sh` and the executable bit.
    fs.writeFileSync(path.join(remote, 'refs', 'heads', 'staging.lock'), '');
    commit(work, 'a.txt', 'two', 'c2');

    const report = await sync(['staging']);

    assert.strictEqual(report.results[0].status, 'failed');
    assert.match(report.results[0].message, /lock/i, 'the failure must come from the refused ref update');
    assert.strictEqual(localSha('staging'), c1, 'local branch must stay where it was');
    assert.strictEqual(remoteSha('staging'), c1);
  });

  test('reports branches already at HEAD as up-to-date without pushing', async () => {
    seedBranch('staging'); // staging === main === c1

    const report = await sync(['staging']);

    assert.strictEqual(report.results[0].status, 'up-to-date');
    assert.strictEqual(report.upToDateCount, 1);
    assert.strictEqual(report.successCount, 0);
  });

  test('dry-run reports real outcomes and changes nothing', async () => {
    seedBranch('staging');
    seedBranch('qa');
    git(work, 'checkout', '-q', 'qa');
    commit(work, 'b.txt', 'only on qa', 'qa-only');
    git(work, 'checkout', '-q', 'main');
    commit(work, 'a.txt', 'two', 'c2');
    const qaBefore = localSha('qa');

    const report = await sync(['staging', 'qa'], { dryRun: true });

    const byBranch = Object.fromEntries(report.results.map(r => [r.branch, r]));
    assert.strictEqual(byBranch.staging.status, 'success');
    assert.match(byBranch.staging.message, /\[Dry Run\]/);
    assert.strictEqual(byBranch.qa.status, 'failed', 'a diverged branch must not be reported as pushable');
    assert.strictEqual(remoteSha('staging'), c1);
    assert.strictEqual(localSha('staging'), c1);
    assert.strictEqual(localSha('qa'), qaBefore);
  });

  test('cancelled operations are reported as skipped, not failed', async () => {
    const token = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose() {} }) };
    const cancelled = await engine.syncBranches(['staging', 'qa'], work, 'main', { remote: 'origin' }, undefined, token);
    assert.strictEqual(cancelled.skippedCount, 2);
    assert.strictEqual(cancelled.failedCount, 0);
  });

  // ─── Fetch failure, force separation, --prune and pullBeforePush ──────────────────────────────

  /** A GitRunner that remembers every git invocation, so tests can assert on what was (not) run. */
  class RecordingRunner extends GitRunner {
    constructor() {
      super();
      this.calls = [];
    }
    execute(args, ...rest) {
      this.calls.push(args);
      return super.execute(args, ...rest);
    }
    ran(subcommand) {
      return this.calls.filter(args => args[0] === subcommand);
    }
  }

  const recordingEngine = () => {
    const runner = new RecordingRunner();
    return { runner, engine: new SyncEngine(runner, new BranchService(new GitRunner())) };
  };
  const breakRemote = () => git(work, 'remote', 'set-url', 'origin', path.join(root, 'does-not-exist.git'));
  const syncWith = (eng, branches, options = {}) =>
    eng.syncBranches(branches, work, 'main', { remote: 'origin', strategy: 'fast-forward', ...options });

  test('a failed fetch stops the sync: nothing is pushed or moved and every branch reports it', async () => {
    seedBranch('staging');
    commit(work, 'a.txt', 'two', 'c2');
    breakRemote();
    const { runner, engine: eng } = recordingEngine();

    const report = await syncWith(eng, ['staging', 'release']);

    assert.strictEqual(report.failedCount, 2);
    assert.strictEqual(report.successCount, 0);
    for (const result of report.results) {
      assert.strictEqual(result.status, 'failed');
      assert.match(result.message, /Could not fetch 'origin'/);
      assert.match(result.message, /Nothing was pushed/);
    }
    assert.strictEqual(runner.ran('push').length, 0, 'no push may run on stale remote data');
    assert.strictEqual(runner.ran('branch').length, 0, 'no local branch may be moved');
    assert.strictEqual(localSha('staging'), c1);
    assert.strictEqual(remoteSha('staging'), c1);
  });

  test('a dry-run never fetches, so it still works while the remote is unreachable', async () => {
    seedBranch('staging');
    commit(work, 'a.txt', 'two', 'c2');
    breakRemote();
    const { runner, engine: eng } = recordingEngine();

    const report = await syncWith(eng, ['staging'], { dryRun: true });

    assert.strictEqual(report.results[0].status, 'success', report.results[0].message);
    assert.strictEqual(runner.ran('fetch').length, 0);
  });

  test('a diverged LOCAL branch alone does not force-push the remote', async () => {
    seedBranch('staging'); // remote staging stays at c1, an ancestor of the new HEAD
    git(work, 'checkout', '-q', 'staging');
    const own = commit(work, 'b.txt', 'only on staging', 'staging-only');
    git(work, 'checkout', '-q', 'main');
    const c2 = commit(work, 'a.txt', 'two', 'c2');
    const { runner, engine: eng } = recordingEngine();

    const report = await syncWith(eng, ['staging'], { strategy: 'force-with-lease' });

    const result = report.results[0];
    assert.strictEqual(result.status, 'success', result.message);
    const pushes = runner.ran('push');
    assert.strictEqual(pushes.length, 1);
    assert.ok(!pushes[0].some(arg => arg.startsWith('--force-with-lease')), 'the remote push must be a plain fast-forward');
    assert.strictEqual(result.previousRemoteSha, undefined, 'nothing on the remote was overwritten');
    assert.doesNotMatch(result.message, /overwrote remote/);
    assert.strictEqual(result.previousLocalSha, own);
    assert.match(result.message, /local branch was/);
    assert.strictEqual(remoteSha('staging'), c2);
    assert.strictEqual(localSha('staging'), c2);
  });

  test('a diverged REMOTE branch is force-pushed with the lease pinned to the inspected tip', async () => {
    seedBranch('staging');
    const remoteOnly = pushFromOtherClone('staging');
    const c2 = commit(work, 'a.txt', 'two', 'c2');
    const { runner, engine: eng } = recordingEngine();

    const report = await syncWith(eng, ['staging'], { strategy: 'force-with-lease' });

    const result = report.results[0];
    assert.strictEqual(result.status, 'success', result.message);
    assert.ok(
      runner.ran('push')[0].includes(`--force-with-lease=refs/heads/staging:${remoteOnly}`),
      'the lease must name the remote tip that was inspected'
    );
    assert.strictEqual(result.previousRemoteSha, remoteOnly);
    assert.match(result.message, /overwrote remote/);
    assert.strictEqual(remoteSha('staging'), c2);
  });

  test('the dry-run tells local overwrite and remote overwrite apart', async () => {
    seedBranch('staging');
    seedBranch('qa');
    git(work, 'checkout', '-q', 'qa');
    commit(work, 'b.txt', 'only on qa', 'qa-only');
    git(work, 'checkout', '-q', 'main');
    commit(work, 'a.txt', 'two', 'c2');

    const report = await sync(['staging', 'qa'], { dryRun: true, strategy: 'force-with-lease' });

    const byBranch = Object.fromEntries(report.results.map(r => [r.branch, r]));
    assert.doesNotMatch(byBranch.staging.message, /overwrite/);
    assert.match(byBranch.qa.message, /local branch .* would be overwritten/);
    assert.doesNotMatch(byBranch.qa.message, /commits on the remote/, 'remote qa is an ancestor of HEAD: no force needed');
  });

  test('fetch --prune: a branch deleted on the remote is not mistaken for up-to-date', async () => {
    seedBranch('gone');
    git(work, 'branch', '-D', 'gone'); // no local branch, only the remote-tracking ref origin/gone (at HEAD)
    git(remote, 'branch', '-D', 'gone'); // deleted on the remote behind our back

    const report = await sync(['gone']);

    assert.strictEqual(report.results[0].status, 'success', report.results[0].message);
    assert.strictEqual(remoteSha('gone'), c1, 'the branch must be re-created on the remote');
  });

  for (const order of [['main', 'staging'], ['staging', 'main']]) {
    test(`pullBeforePush: every branch gets the post-pull HEAD (order: ${order.join(', ')})`, async () => {
      seedBranch('staging');
      const remoteOnly = pushFromOtherClone('main'); // origin/main moves ahead; a pull fast-forwards

      const report = await sync(order, { pullBeforePush: true });

      const byBranch = Object.fromEntries(report.results.map(r => [r.branch, r]));
      assert.strictEqual(localSha('main'), remoteOnly, 'the current branch was pulled');
      assert.strictEqual(byBranch.staging.status, 'success', byBranch.staging.message);
      assert.strictEqual(remoteSha('staging'), remoteOnly, 'staging must not receive the stale pre-pull commit');
      assert.strictEqual(localSha('staging'), remoteOnly);
      assert.strictEqual(byBranch.main.status, 'up-to-date', 'after the pull the remote is already at HEAD');
    });
  }

  /** Remote main and local main both edit a.txt, so `git pull origin main` fails with a conflict. */
  const setUpConflictingPull = () => {
    seedBranch('staging');
    seedBranch('qa');
    git(work, 'config', 'pull.rebase', 'false'); // make the outcome independent of the user's git config
    const other = path.join(root, 'other');
    git(root, 'clone', '-q', remote, other);
    configure(other);
    const remoteEdit = commit(other, 'a.txt', 'remote version', 'remote edit');
    git(other, 'push', '-q', 'origin', 'main');
    const localEdit = commit(work, 'a.txt', 'local version', 'local edit');
    return { remoteEdit, localEdit };
  };

  for (const order of [['main', 'staging', 'qa'], ['staging', 'qa', 'main']]) {
    test(`pullBeforePush: a failed pull stops the whole sync, nothing is pushed or moved (order: ${order.join(', ')})`, async () => {
      const { remoteEdit, localEdit } = setUpConflictingPull();
      const { runner, engine: eng } = recordingEngine();

      const report = await syncWith(eng, order, { pullBeforePush: true });

      assert.strictEqual(report.failedCount, 3, 'every selected branch is reported as failed');
      assert.strictEqual(report.successCount, 0);
      assert.deepStrictEqual(report.results.map(r => r.branch), order);
      for (const result of report.results) {
        assert.strictEqual(result.status, 'failed');
        assert.match(result.message, /Sync stopped because the pull of 'main' from 'origin' failed/);
        assert.match(result.message, /Nothing was pushed and no local branch was changed/);
        assert.match(result.message, /Git said: \S/, "git's own output is appended to the message");
      }
      // The pull really failed on a conflict (it left a merge in progress), not for some other reason.
      assert.doesNotThrow(() => git(work, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'));
      assert.strictEqual(runner.ran('pull').length, 1);
      assert.strictEqual(runner.ran('push').length, 0, 'no push may run after a failed pull');
      assert.strictEqual(runner.ran('branch').length, 0, 'no local branch may be moved after a failed pull');
      assert.strictEqual(git(work, 'rev-parse', 'HEAD'), localEdit, 'a failed pull must leave HEAD where it was');
      assert.strictEqual(localSha('main'), localEdit);
      assert.strictEqual(localSha('staging'), c1);
      assert.strictEqual(localSha('qa'), c1);
      assert.strictEqual(remoteSha('main'), remoteEdit);
      assert.strictEqual(remoteSha('staging'), c1);
      assert.strictEqual(remoteSha('qa'), c1);
    });
  }

  test('pullBeforePush: cancelling during the pull skips every branch (not failed) and pushes nothing', async () => {
    setUpConflictingPull();
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    class CancelDuringPullRunner extends RecordingRunner {
      execute(args, ...rest) {
        if (args[0] === 'pull') {
          this.calls.push(args);
          token.isCancellationRequested = true; // the user pressed Cancel while the pull was running
          return Promise.reject(new Error('Operation was cancelled by user.'));
        }
        return super.execute(args, ...rest);
      }
    }
    const runner = new CancelDuringPullRunner();
    const eng = new SyncEngine(runner, new BranchService(new GitRunner()));

    const report = await eng.syncBranches(
      ['main', 'staging', 'qa'],
      work,
      'main',
      { remote: 'origin', strategy: 'fast-forward', pullBeforePush: true },
      undefined,
      token
    );

    assert.strictEqual(report.skippedCount, 3);
    assert.strictEqual(report.failedCount, 0, 'a cancellation is not a failure');
    for (const result of report.results) {
      assert.strictEqual(result.message, 'Operation cancelled by user');
    }
    assert.strictEqual(runner.ran('push').length, 0);
    assert.strictEqual(runner.ran('branch').length, 0);
    assert.strictEqual(localSha('staging'), c1);
    assert.strictEqual(remoteSha('staging'), c1);
  });

  test('pullBeforePush: when the pull creates a merge commit, every branch gets that merge commit', async () => {
    seedBranch('staging');
    git(work, 'config', 'pull.rebase', 'false'); // make the outcome independent of the user's git config
    const remoteOnly = pushFromOtherClone('main'); // other.txt on origin/main
    const localOnly = commit(work, 'b.txt', 'local', 'local commit'); // non-conflicting, so the pull merges

    const report = await sync(['main', 'staging'], { pullBeforePush: true });

    const head = git(work, 'rev-parse', 'HEAD');
    const parents = git(work, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1);
    assert.deepStrictEqual([...parents].sort(), [localOnly, remoteOnly].sort(), 'HEAD is the merge of both sides');
    const byBranch = Object.fromEntries(report.results.map(r => [r.branch, r]));
    assert.strictEqual(byBranch.main.status, 'success', byBranch.main.message);
    assert.strictEqual(byBranch.staging.status, 'success', byBranch.staging.message);
    assert.strictEqual(remoteSha('main'), head);
    assert.strictEqual(remoteSha('staging'), head, 'staging must get the merge commit, not the pre-pull commit');
    assert.strictEqual(localSha('staging'), head);
  });

  test('pullBeforePush does nothing when the current branch is not among the selected branches', async () => {
    seedBranch('staging');
    pushFromOtherClone('main'); // origin/main is ahead, but main is not selected
    const c2 = commit(work, 'a.txt', 'two', 'c2');
    const { runner, engine: eng } = recordingEngine();

    const report = await syncWith(eng, ['staging'], { pullBeforePush: true });

    assert.strictEqual(runner.ran('pull').length, 0, 'only the current branch is ever pulled, and only when selected');
    assert.strictEqual(report.results[0].status, 'success', report.results[0].message);
    assert.strictEqual(remoteSha('staging'), c2);
    assert.strictEqual(git(work, 'rev-parse', 'HEAD'), c2, 'HEAD is untouched');
  });

  // ─── Result wording: "already at HEAD" vs a real push ─────────────────────────────────────────

  /** staging: remote already at the new HEAD (c2), local staging still at c1 (a fast-forward behind). */
  const remoteAtHeadLocalBehind = () => {
    seedBranch('staging');
    const c2 = commit(work, 'a.txt', 'two', 'c2');
    git(work, 'push', '-q', 'origin', `${c2}:refs/heads/staging`);
    return c2;
  };

  test('remote already at HEAD: the report says nothing was pushed, and the local branch is still moved', async () => {
    const c2 = remoteAtHeadLocalBehind();

    const report = await sync(['staging']);

    const result = report.results[0];
    assert.strictEqual(result.status, 'success', result.message);
    assert.match(result.message, /origin\/staging was already at/);
    assert.match(result.message, /nothing was pushed/);
    assert.doesNotMatch(result.message, /Successfully pushed/);
    assert.match(result.message, /local branch moved from/);
    assert.strictEqual(result.previousLocalSha, c1);
    assert.strictEqual(localSha('staging'), c2);
    assert.strictEqual(remoteSha('staging'), c2);
  });

  test('a push that really changes the remote still says "Successfully pushed"', async () => {
    seedBranch('staging');
    commit(work, 'a.txt', 'two', 'c2');

    const report = await sync(['staging']);

    assert.match(report.results[0].message, /Successfully pushed to origin\/staging/);
    assert.doesNotMatch(report.results[0].message, /nothing was pushed/);
  });

  test('dry-run: remote already at HEAD is described as "nothing to push", only the local branch would move', async () => {
    remoteAtHeadLocalBehind();
    git(work, 'fetch', '-q', 'origin');

    const report = await sync(['staging'], { dryRun: true });

    const result = report.results[0];
    assert.strictEqual(result.status, 'success', result.message);
    assert.match(result.message, /\[Dry Run\] origin\/staging is already at/);
    assert.match(result.message, /nothing to push/);
    assert.match(result.message, /would only move local branch 'staging'/);
    assert.strictEqual(localSha('staging'), c1, 'a dry-run changes nothing');
  });

  // ─── resolveRefs: a git failure must not look like "the branch does not exist" ────────────────

  test('a git failure while reading refs is reported as a failure, not as "new branch on the remote"', async () => {
    class FailingRefsRunner extends GitRunner {
      execute(args, ...rest) {
        if (args[0] === 'for-each-ref') {
          return Promise.reject(new Error('simulated for-each-ref failure'));
        }
        return super.execute(args, ...rest);
      }
    }
    const runner = new RecordingRunner();
    const eng = new SyncEngine(runner, new BranchService(new FailingRefsRunner()));
    commit(work, 'a.txt', 'two', 'c2');

    const report = await syncWith(eng, ['staging']);

    assert.strictEqual(report.results[0].status, 'failed');
    assert.match(report.results[0].message, /simulated for-each-ref failure/);
    assert.strictEqual(runner.ran('push').length, 0, 'nothing may be pushed when the refs could not be read');
    assert.throws(() => remoteSha('staging'), 'staging must not have been created on the remote');
  });

  test('a dry-run with pullBeforePush never pulls, fetches or pushes', async () => {
    commit(work, 'a.txt', 'two', 'c2');
    const { runner, engine: eng } = recordingEngine();

    const report = await syncWith(eng, ['main', 'staging'], { dryRun: true, pullBeforePush: true });

    const byBranch = Object.fromEntries(report.results.map(r => [r.branch, r]));
    assert.match(byBranch.main.message, /would pull first/);
    for (const subcommand of ['fetch', 'pull', 'push', 'branch']) {
      assert.strictEqual(runner.ran(subcommand).length, 0, `dry-run must not run git ${subcommand}`);
    }
  });
});
