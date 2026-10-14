// Argument-injection guards and branch listing, against real temporary repositories.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GitRunner } = require('../dist/git/gitRunner');
const { BranchService } = require('../dist/git/branchService');
const { SyncEngine } = require('../dist/sync/syncEngine');
const { remoteNameProblem, branchNameProblem } = require('../dist/git/validation');

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe('name validation', () => {
  test('accepts ordinary remote names', () => {
    for (const name of ['origin', 'upstream', 'my-fork', 'team_remote', 'fork.2', 'user@host', 'a/b']) {
      assert.strictEqual(remoteNameProblem(name), undefined, name);
    }
  });

  test('rejects remote names that git would read as options or that are malformed', () => {
    for (const name of ['', '--upload-pack=touch x', '-o', '--receive-pack=x', 'a b', 'a;b', 'a\nb', '$(x)', undefined, 42]) {
      assert.ok(remoteNameProblem(name), `expected a problem for ${JSON.stringify(name)}`);
    }
  });

  test('accepts ordinary branch names', () => {
    for (const name of ['main', 'feature/AHEAD-fix', 'release/1.2.0', 'fix_bug-12', 'a.b', 'ünïcode']) {
      assert.strictEqual(branchNameProblem(name), undefined, name);
    }
  });

  test('rejects option-like and malformed branch names', () => {
    const bad = [
      '', '-f', '--delete', '@', 'a b', 'a..b', 'a@{1}', 'a//b', '/a', 'a/', 'a.', '.hidden', 'a/.b', 'x.lock',
      'a/b.lock', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[0]', 'a\\b', 'a\tb', '(HEAD detached at abc1234)'
    ];
    for (const name of bad) {
      assert.ok(branchNameProblem(name), `expected a problem for ${JSON.stringify(name)}`);
    }
  });
});

describe('with real repositories', () => {
  let root, remote, work, c1;

  const configure = cwd => {
    git(cwd, 'config', 'user.name', 'Test');
    git(cwd, 'config', 'user.email', 'test@example.com');
    git(cwd, 'config', 'commit.gpgsign', 'false');
  };

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

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gss-hard-')));
    remote = path.join(root, 'remote.git');
    work = path.join(root, 'work');
    git(root, 'init', '-q', '--bare', '-b', 'main', remote);
    git(root, 'clone', '-q', remote, work);
    configure(work);
    git(work, 'checkout', '-q', '-B', 'main');
    fs.writeFileSync(path.join(work, 'a.txt'), 'one');
    git(work, 'add', 'a.txt');
    git(work, 'commit', '-q', '-m', 'fix a | b');
    c1 = git(work, 'rev-parse', 'HEAD');
    git(work, 'push', '-q', '-u', 'origin', 'main');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  describe('branch listing', () => {
    const service = () => new BranchService(new GitRunner());

    test('a remote branch whose name merely contains "HEAD" is listed; origin/HEAD is not', async () => {
      git(work, 'push', '-q', 'origin', 'main:feature/AHEAD-fix');
      git(work, 'fetch', '-q', 'origin');
      git(work, 'remote', 'set-head', 'origin', 'main'); // creates the symbolic refs/remotes/origin/HEAD

      const names = (await service().getRemoteBranches(work, 'origin')).map(b => b.name).sort();

      assert.deepStrictEqual(names, ['feature/AHEAD-fix', 'main']);
    });

    test('only the requested remote is listed', async () => {
      const other = path.join(root, 'other.git');
      git(root, 'init', '-q', '--bare', '-b', 'main', other);
      git(work, 'remote', 'add', 'origin2', other);
      git(work, 'push', '-q', 'origin2', 'main:only-on-origin2');
      git(work, 'fetch', '-q', 'origin2');

      const names = (await service().getRemoteBranches(work, 'origin')).map(b => b.name);

      assert.deepStrictEqual(names, ['main']);
    });

    test('a detached HEAD is not listed as a branch and "|" in a subject survives', async () => {
      git(work, 'checkout', '-q', '--detach');

      const branches = await service().getLocalBranches(work, 'HEAD');

      assert.deepStrictEqual(branches.map(b => b.name), ['main']);
      assert.strictEqual(branches[0].lastCommitSubject, 'fix a | b');
      assert.strictEqual(branches[0].lastCommitHash, c1.substring(0, branches[0].lastCommitHash.length));
    });

    test('a tag with the same name as a branch does not change the branch name', async () => {
      git(work, 'tag', 'main');

      const branches = await service().getLocalBranches(work, 'main');

      assert.deepStrictEqual(branches.map(b => b.name), ['main']);
      assert.strictEqual(branches[0].isCurrent, true);
    });

    test('an unsafe remote name lists nothing instead of reaching git', async () => {
      assert.deepStrictEqual(await service().getRemoteBranches(work, '--upload-pack=x'), []);
    });
  });

  describe('argument injection', () => {
    test('a remote named like a git option is refused: no git command runs and nothing is executed', async () => {
      const marker = path.join(root, 'PWNED');
      const runner = new RecordingRunner();
      const engine = new SyncEngine(runner, new BranchService(new GitRunner()));

      const report = await engine.syncBranches(['release'], work, 'main', {
        remote: `--upload-pack=touch ${marker}`,
        strategy: 'fast-forward'
      });

      assert.strictEqual(report.failedCount, 1);
      assert.match(report.results[0].message, /Invalid remote name/);
      assert.strictEqual(runner.calls.length, 0, 'not even a read-only git command may run');
      assert.strictEqual(fs.existsSync(marker), false, 'the injected command must not have run');
    });

    test('the same refusal applies to a dry-run', async () => {
      const runner = new RecordingRunner();
      const engine = new SyncEngine(runner, new BranchService(new GitRunner()));

      const report = await engine.syncBranches(['release'], work, 'main', { remote: '--receive-pack=x', dryRun: true });

      assert.strictEqual(report.failedCount, 1);
      assert.strictEqual(runner.calls.length, 0);
    });

    test('an option-like or malformed branch is refused and the other branches still sync', async () => {
      const runner = new RecordingRunner();
      const engine = new SyncEngine(runner, new BranchService(new GitRunner()));

      const report = await engine.syncBranches(['--delete', '(HEAD detached at abc)', 'release'], work, 'main', {
        remote: 'origin',
        strategy: 'fast-forward'
      });

      const byBranch = Object.fromEntries(report.results.map(r => [r.branch, r]));
      assert.strictEqual(byBranch['--delete'].status, 'failed');
      assert.match(byBranch['--delete'].message, /Invalid branch name/);
      assert.strictEqual(byBranch['(HEAD detached at abc)'].status, 'failed');
      assert.strictEqual(byBranch.release.status, 'success', byBranch.release.message);
      assert.strictEqual(git(remote, 'rev-parse', 'refs/heads/release'), c1);
      for (const args of runner.calls) {
        assert.ok(!args.includes('--delete'), `no command may receive the option-like branch: ${args.join(' ')}`);
      }
    });

    test('every remote-taking command puts "--" before the remote', async () => {
      git(work, 'branch', 'staging', c1);
      git(work, 'push', '-q', 'origin', 'staging');
      fs.writeFileSync(path.join(work, 'a.txt'), 'two');
      git(work, 'commit', '-q', '-am', 'c2');
      const runner = new RecordingRunner();
      const engine = new SyncEngine(runner, new BranchService(new GitRunner()));

      const report = await engine.syncBranches(['main', 'staging'], work, 'main', {
        remote: 'origin',
        strategy: 'fast-forward',
        pullBeforePush: true
      });

      assert.strictEqual(report.failedCount, 0, JSON.stringify(report.results));
      for (const subcommand of ['fetch', 'pull', 'push']) {
        const calls = runner.ran(subcommand);
        assert.ok(calls.length > 0, `git ${subcommand} was expected to run`);
        for (const args of calls) {
          const dashes = args.indexOf('--');
          assert.ok(dashes !== -1 && dashes < args.indexOf('origin'), `git ${args.join(' ')}`);
        }
      }
      for (const args of runner.ran('branch')) {
        assert.ok(args.indexOf('--') !== -1 && args.indexOf('--') < args.indexOf('staging'), args.join(' '));
      }
    });

    test('pruneRemote refuses an option-like remote and still prunes a normal one', async () => {
      const service = new BranchService(new GitRunner());

      await assert.rejects(service.pruneRemote('--upload-pack=x', work), /Invalid remote name/);
      await assert.doesNotReject(service.pruneRemote('origin', work));
    });
  });
});
