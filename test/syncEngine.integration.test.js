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
    const hook = path.join(remote, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\necho "rejected by test hook" >&2\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    commit(work, 'a.txt', 'two', 'c2');

    const report = await sync(['staging']);

    assert.strictEqual(report.results[0].status, 'failed');
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
});
