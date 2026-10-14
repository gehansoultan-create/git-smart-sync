const { test, describe } = require('node:test');
const assert = require('node:assert');
const { GitRunner } = require('../dist/git/gitRunner');
const { BranchService } = require('../dist/git/branchService');

describe('BranchService', () => {
  const runner = new GitRunner();
  const service = new BranchService(runner);
  const cwd = process.cwd();

  test('should retrieve local branches including current branch', async () => {
    try {
      await runner.execute(['branch', 'main'], cwd);
    } catch {
      // branch already exists
    }
    const branches = await service.getLocalBranches(cwd, 'main');
    assert.ok(Array.isArray(branches));
    assert.ok(branches.length > 0);
    const mainBranch = branches.find(b => b.name === 'main');
    assert.ok(mainBranch, 'Should find main branch');
    assert.strictEqual(mainBranch.isRemote, false);
  });

  test('should confirm HEAD is an ancestor of HEAD (fast-forward valid)', async () => {
    const canFf = await service.canFastForward('HEAD', 'HEAD', cwd);
    assert.strictEqual(canFf, true);
  });

  test('should calculate divergence between identical refs as 0 ahead and 0 behind', async () => {
    const div = await service.getDivergenceCounts('HEAD', 'HEAD', cwd);
    assert.strictEqual(div.ahead, 0);
    assert.strictEqual(div.behind, 0);
  });

  test('should return combined deduplicated branch list', async () => {
    const all = await service.getAllBranches(cwd, 'origin', 'main');
    assert.ok(all.length >= 1);
    const names = all.map(b => b.name);
    const uniqueNames = new Set(names);
    assert.strictEqual(names.length, uniqueNames.size, 'Branch list must have no duplicates');
  });
});

describe('BranchService.resolveRefs', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const { after } = require('node:test');

  const git = (cwd, ...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const refService = new BranchService(new GitRunner());
  const dirs = [];
  const makeTempDir = prefix => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };
  after(() => dirs.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

  test('returns the refs that exist and leaves missing ones out (a miss is not an error)', async () => {
    const repo = makeTempDir('gss-refs-');
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'c1');
    const sha = git(repo, 'rev-parse', 'HEAD');
    const branch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');

    const refs = await refService.resolveRefs(
      [`refs/heads/${branch}`, 'refs/heads/does-not-exist', 'refs/remotes/origin/nope'],
      repo
    );

    assert.strictEqual(refs.get(`refs/heads/${branch}`), sha);
    assert.strictEqual(refs.size, 1);
    assert.strictEqual((await refService.resolveRefs([], repo)).size, 0);
  });

  test('a git failure is propagated instead of being reported as "refs not found"', async () => {
    const notARepo = makeTempDir('gss-notrepo-');
    const previous = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(notARepo); // stop git from finding a repo above the temp dir
    try {
      await assert.rejects(refService.resolveRefs(['refs/heads/main'], notARepo));
    } finally {
      if (previous === undefined) {
        delete process.env.GIT_CEILING_DIRECTORIES;
      } else {
        process.env.GIT_CEILING_DIRECTORIES = previous;
      }
    }
  });
});
