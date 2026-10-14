// UI-level behaviour with a mocked `vscode` module: QuickPick defaults, silent background lookups, tree provider.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createVscodeMock, installVscodeMock } = require('./helpers/vscodeMock');

const vscode = createVscodeMock();
installVscodeMock(vscode);

const { QuickPickService } = require('../dist/ui/quickPick');
const { RepositoryService } = require('../dist/git/repositoryService');
const { GitRunner } = require('../dist/git/gitRunner');
const { BranchTreeProvider } = require('../dist/ui/branchTreeProvider');

const branches = [
  { name: 'main', isRemote: false, isCurrent: true },
  { name: 'staging', isRemote: false, isCurrent: false, lastCommitSubject: 'wip' },
  { name: 'production', isRemote: true, isCurrent: false }
];

describe('QuickPickService', () => {
  beforeEach(() => vscode.reset());

  test('does not pre-select any branch', async () => {
    await new QuickPickService().promptBranchSelection(branches, 'main');

    const { items, options } = vscode.calls.quickPick[0];
    assert.strictEqual(items.length, 3);
    assert.ok(items.every(i => i.picked === false), 'every item must start unchecked');
    assert.strictEqual(options.canPickMany, true);
    assert.match(options.placeHolder, /'main'/);
  });

  test('returns the names of the ticked branches', async () => {
    vscode.responses.quickPick = items => [items[1], items[2]];

    const result = await new QuickPickService().promptBranchSelection(branches, 'main');

    assert.deepStrictEqual(result, ['staging', 'production']);
  });

  test('returns undefined when nothing is ticked or the picker is dismissed', async () => {
    const service = new QuickPickService();

    vscode.responses.quickPick = () => [];
    assert.strictEqual(await service.promptBranchSelection(branches, 'main'), undefined);

    vscode.responses.quickPick = () => undefined;
    assert.strictEqual(await service.promptBranchSelection(branches, 'main'), undefined);
  });
});

describe('RepositoryService.getActiveRepository', () => {
  let root;
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  const folder = p => ({ uri: { fsPath: p }, name: path.basename(p), index: 0 });
  const makeRepo = name => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    git(dir, 'init', '-q');
    return dir;
  };

  beforeEach(() => {
    vscode.reset();
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gss-ui-')));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const service = () => new RepositoryService(new GitRunner());

  test('no repository: user-triggered call shows an error, background call stays silent', async () => {
    vscode.workspace.workspaceFolders = [folder(root)]; // plain folder, not a git repo

    assert.strictEqual(await service().getActiveRepository({ interactive: false }), undefined);
    assert.strictEqual(vscode.calls.error.length, 0, 'background lookup must not show an error');

    assert.strictEqual(await service().getActiveRepository(), undefined);
    assert.strictEqual(vscode.calls.error.length, 1, 'interactive lookup still reports the problem');
  });

  test('several repositories: background call never prompts, interactive call does', async () => {
    const a = makeRepo('a');
    const b = makeRepo('b');
    vscode.workspace.workspaceFolders = [folder(a), folder(b)];

    const silent = await service().getActiveRepository({ interactive: false });
    assert.strictEqual(silent.rootPath, a, 'falls back to the first repository');
    assert.strictEqual(vscode.calls.quickPick.length, 0);

    vscode.responses.quickPick = items => items[1];
    const svc = service();
    const picked = await svc.getActiveRepository();
    assert.strictEqual(picked.rootPath, b);
    assert.strictEqual(vscode.calls.quickPick.length, 1);

    const remembered = await svc.getActiveRepository({ interactive: false });
    assert.strictEqual(remembered.rootPath, b, 'background lookups reuse the last picked repository');
  });

  test('matches the active editor by path, not by string prefix (repo vs repo2)', async () => {
    const repo = makeRepo('repo');
    const repo2 = makeRepo('repo2');
    vscode.workspace.workspaceFolders = [folder(repo), folder(repo2)];
    vscode.window.activeTextEditor = {
      document: { isUntitled: false, uri: { fsPath: path.join(repo2, 'file.ts') } }
    };

    const result = await service().getActiveRepository();

    assert.strictEqual(result.rootPath, repo2);
    assert.strictEqual(vscode.calls.quickPick.length, 0);
  });
});

describe('BranchTreeProvider', () => {
  test('renders without ever triggering a prompt (asks for a non-interactive repository lookup)', async () => {
    const seen = [];
    const repoService = {
      getActiveRepository: async options => {
        seen.push(options);
        return undefined;
      }
    };
    const provider = new BranchTreeProvider(repoService, {}, { defaultRemote: 'origin', getPresets: () => [] });

    assert.deepStrictEqual(await provider.getChildren(), []);
    assert.deepStrictEqual(seen, [{ interactive: false }]);
  });
});
