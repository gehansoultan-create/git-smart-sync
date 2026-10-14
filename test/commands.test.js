// Command-level behaviour (confirmation dialogs, dry-run report, background lookups) with a mocked `vscode`.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVscodeMock, installVscodeMock } = require('./helpers/vscodeMock');

const vscode = createVscodeMock();
installVscodeMock(vscode);

const { SyncCommand } = require('../dist/commands/syncCommand');
const { SyncAllCommand } = require('../dist/commands/syncAllCommand');
const { DryRunCommand } = require('../dist/commands/dryRunCommand');

const emptyReport = (overrides = {}) => ({
  timestamp: new Date(),
  remote: 'origin',
  results: [],
  successCount: 0,
  failedCount: 0,
  skippedCount: 0,
  upToDateCount: 0,
  totalDurationMs: 5,
  ...overrides
});

function fixture({ strategy = 'fast-forward', confirmBeforeSync = false, report = emptyReport() } = {}) {
  const syncCalls = [];
  const repo = { rootPath: '/repo', repoName: 'repo', currentBranch: 'main', remotes: ['origin'] };
  const repoService = { getActiveRepository: async () => repo };
  const branchService = {
    getAllBranches: async () => [{ name: 'main', isRemote: false, isCurrent: true }, { name: 'staging', isRemote: false, isCurrent: false }],
    getLocalBranches: async () => [{ name: 'main' }, { name: 'staging' }]
  };
  const syncEngine = {
    syncBranches: async (...args) => {
      syncCalls.push(args);
      return report;
    }
  };
  const quickPick = { promptBranchSelection: async () => ['staging'] };
  const configService = { defaultRemote: 'origin', syncStrategy: strategy, autoPullBeforePush: false, confirmBeforeSync };
  const logs = [];
  const logger = { info: m => logs.push(m), error: m => logs.push(m), show() {} };

  const syncCommand = new SyncCommand(repoService, branchService, syncEngine, quickPick, configService, logger);
  return { syncCalls, logs, repoService, branchService, syncEngine, quickPick, configService, logger, syncCommand };
}

describe('SyncCommand confirmation', () => {
  beforeEach(() => vscode.reset());

  test('no dialog for a plain fast-forward sync with confirmBeforeSync off', async () => {
    const f = fixture();

    await f.syncCommand.execute(['staging']);

    assert.strictEqual(vscode.calls.warning.length, 0);
    assert.strictEqual(f.syncCalls.length, 1);
  });

  test('confirmBeforeSync shows a modal dialog and syncs only after "Sync"', async () => {
    const f = fixture({ confirmBeforeSync: true });
    vscode.responses.warning = () => 'Sync';

    await f.syncCommand.execute(['staging']);

    assert.strictEqual(vscode.calls.warning.length, 1);
    assert.strictEqual(vscode.calls.warning[0][1].modal, true);
    assert.strictEqual(f.syncCalls.length, 1);
  });

  test('dismissing the dialog cancels the sync (nothing is pushed)', async () => {
    const f = fixture({ confirmBeforeSync: true });
    vscode.responses.warning = () => undefined;

    await f.syncCommand.execute(['staging']);

    assert.strictEqual(f.syncCalls.length, 0);
  });

  test('force-with-lease always asks, and the dialog warns that diverged branches are overwritten', async () => {
    const f = fixture({ strategy: 'force-with-lease', confirmBeforeSync: false });
    vscode.responses.warning = () => undefined;

    await f.syncCommand.execute(['staging']);

    assert.strictEqual(vscode.calls.warning.length, 1);
    assert.match(vscode.calls.warning[0][1].detail, /force-with-lease/);
    assert.strictEqual(f.syncCalls.length, 0);
  });

  test('Sync All always asks for confirmation, even with confirmBeforeSync off', async () => {
    const f = fixture();
    const syncAll = new SyncAllCommand(f.repoService, f.branchService, f.syncCommand);
    vscode.responses.warning = () => undefined;

    await syncAll.execute();

    assert.strictEqual(vscode.calls.warning.length, 1);
    assert.match(vscode.calls.warning[0][1].detail, /main, staging/);
    assert.strictEqual(f.syncCalls.length, 0);

    vscode.reset();
    vscode.responses.warning = () => 'Sync';
    await syncAll.execute();
    assert.strictEqual(f.syncCalls.length, 1);
  });

  test('the summary mentions up-to-date and skipped branches', async () => {
    const f = fixture({ report: emptyReport({ successCount: 1, upToDateCount: 2, skippedCount: 1 }) });

    await f.syncCommand.execute(['staging']);

    const message = vscode.calls.info[0][0];
    assert.match(message, /1 synced/);
    assert.match(message, /2 already up-to-date/);
    assert.match(message, /1 skipped/);
  });
});

describe('DryRunCommand', () => {
  beforeEach(() => vscode.reset());

  test('labels each branch (would push / up-to-date / blocked), says it is offline, and never confirms or pushes', async () => {
    const report = emptyReport({
      successCount: 1,
      upToDateCount: 1,
      failedCount: 1,
      results: [
        { branch: 'staging', status: 'success', message: '[Dry Run] Would push abc1234 to origin/staging' },
        { branch: 'release', status: 'up-to-date', message: 'origin/release is already at abc1234' },
        { branch: 'qa', status: 'failed', message: "Local branch 'qa' has commits that are not in HEAD (diverged)" }
      ]
    });
    const f = fixture({ report });
    const dryRun = new DryRunCommand(f.repoService, f.branchService, f.syncEngine, f.quickPick, f.configService, f.logger);

    await dryRun.execute();

    assert.strictEqual(f.syncCalls.length, 1);
    assert.strictEqual(f.syncCalls[0][3].dryRun, true, 'the engine must be called in dry-run mode');
    assert.strictEqual(vscode.calls.warning.length, 0, 'a dry-run needs no confirmation');

    const [summary, options] = vscode.calls.info[0];
    assert.match(summary, /1 would push, 1 up-to-date, 1 blocked/);
    assert.match(options.detail, /\[WOULD PUSH\] staging/);
    assert.match(options.detail, /\[UP-TO-DATE\] release/);
    assert.match(options.detail, /\[BLOCKED\] qa/);
    assert.match(options.detail, /no network access/);
  });
});

describe('extension activation: background status-bar updates are silent', () => {
  let plainFolder;
  beforeEach(() => {
    vscode.reset();
    plainFolder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gss-ext-')));
  });
  afterEach(() => fs.rmSync(plainFolder, { recursive: true, force: true }));

  test('opening a non-Git folder and switching editors shows no error toast or prompt', async () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: plainFolder }, name: 'plain', index: 0 }];
    const { activate } = require('../dist/extension');

    activate({ subscriptions: [] });
    assert.ok(vscode.commands.registered.has('gitSmartSync.sync'), 'commands are registered');
    assert.strictEqual(vscode.window.editorChangeListeners.length, 1);

    for (const listener of vscode.window.editorChangeListeners) {
      await listener();
    }
    await new Promise(resolve => setTimeout(resolve, 300)); // let the initial async lookup finish

    assert.strictEqual(vscode.calls.error.length, 0, 'no "No active Git repository" toast');
    assert.strictEqual(vscode.calls.quickPick.length, 0, 'no repository prompt');
  });
});
