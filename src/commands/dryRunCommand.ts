import * as vscode from 'vscode';
import { RepositoryService } from '../git/repositoryService';
import { BranchService } from '../git/branchService';
import { SyncEngine } from '../sync/syncEngine';
import { QuickPickService } from '../ui/quickPick';
import { ConfigurationService } from '../config/configurationService';
import { OutputChannelLogger } from '../ui/outputChannel';

export class DryRunCommand {
  constructor(
    private readonly repoService: RepositoryService,
    private readonly branchService: BranchService,
    private readonly syncEngine: SyncEngine,
    private readonly quickPick: QuickPickService,
    private readonly configService: ConfigurationService,
    private readonly logger?: OutputChannelLogger
  ) {}

  public async execute(): Promise<void> {
    const repo = await this.repoService.getActiveRepository();
    if (!repo) {
      return;
    }

    const defaultRemote = this.configService.defaultRemote;
    const allBranches = await this.branchService.getAllBranches(
      repo.rootPath,
      defaultRemote,
      repo.currentBranch
    );

    if (allBranches.length === 0) {
      vscode.window.showWarningMessage('No local or remote branches found in this repository.');
      return;
    }

    const targetBranches = await this.quickPick.promptBranchSelection(allBranches, repo.currentBranch);
    if (!targetBranches || targetBranches.length === 0) {
      return;
    }

    const options = {
      remote: defaultRemote,
      strategy: this.configService.syncStrategy,
      pullBeforePush: this.configService.autoPullBeforePush,
      dryRun: true
    };

    this.logger?.info(`[Dry-Run] Simulating push for branches: [${targetBranches.join(', ')}] -> ${defaultRemote}`);

    const report = await this.syncEngine.syncBranches(
      targetBranches,
      repo.rootPath,
      repo.currentBranch,
      options
    );

    const marker: Record<string, string> = {
      success: 'WOULD PUSH',
      'up-to-date': 'UP-TO-DATE',
      failed: 'BLOCKED',
      skipped: 'SKIPPED'
    };
    const summaryLines = report.results.map(r => `• [${marker[r.status] ?? r.status}] ${r.branch}: ${r.message}`);
    this.logger?.info(`[Dry-Run] Result:\n${summaryLines.join('\n')}`);
    vscode.window.showInformationMessage(
      `[Dry-Run Preview] Checked ${report.results.length} branches (${report.successCount} would push, ${report.upToDateCount} up-to-date, ${report.failedCount} blocked).`,
      {
        modal: true,
        detail: `${summaryLines.join('\n')}\n\nBased on the last fetched state of '${defaultRemote}' — no network access was used, nothing was changed.`
      }
    );
  }
}
