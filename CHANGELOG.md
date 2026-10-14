# Changelog

All notable changes to the **Git Smart Branch Sync** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Branch picker no longer pre-selects every branch.** Pressing Enter in the QuickPick used to push the current commit to all local and remote branches.
- **Local branch pointer is moved only after a successful push.** Previously `git branch -f` ran first, so a rejected push left the local branch moved with no rollback.
- **Safety checks use the remote's real state.** The remote is fetched before syncing and each branch is compared against its remote-tracking tip, not only the (possibly stale) local branch. `force-with-lease` is pinned to the inspected remote tip.
- **No more error toasts from background updates.** The status bar and tree view no longer show "No active Git repository" or open a repository picker when you switch editors in a non-Git or multi-root workspace.
- Repository detection no longer mistakes `/path/repo2` for being inside `/path/repo`.
- Cancelled syncs are reported as skipped instead of failed.

### Changed
- **Dry-Run is now a real simulation.** It runs the same checks as a real sync and reports branches that would be blocked (diverged), are already up-to-date, or would be pushed. It uses the last fetched remote state and makes no network calls.
- Branches already at HEAD are reported as `up-to-date` and are not pushed.
- Results record the overwritten remote / previous local SHA when `force-with-lease` is used, so they can be recovered.

### Added
- `gitSmartSync.confirmBeforeSync` setting. A confirmation dialog is also always shown for **Sync All** and for the `force-with-lease` strategy.
- Integration tests that run against real temporary repositories with a bare remote (fast-forward, diverged, remote-ahead, force-with-lease, rejected push, dry-run).
- Tests with a mocked `vscode` module covering the branch picker defaults, confirmation dialogs, dry-run report, silent background repository lookups and extension activation.

---

## [1.2.0] - 2026-10-12

### Added
- **Preset Management in UI**: Direct creation (`gitSmartSync.addPreset`) and deletion (`gitSmartSync.deletePreset`) from SCM tree view and command palette.
- **Dedicated Output Channel**: Integrated `Git Smart Sync` OutputChannel logger providing real-time command traces and stderr details.
- **Multi-Remote Selector**: Added `gitSmartSync.selectRemote` command to interactively pick the default synchronization remote.
- **Interactive Error Action**: Added "Show Output" action directly on failed sync and prune notifications.
- **Automated VS Code Marketplace Publishing**: Integrated publishing step to Visual Studio Marketplace in `release.yml` with `VSCE_PAT`.
- **Logger Test Suite**: Expanded unit tests to verify command and error recording in `GitRunner`.

### Fixed
- **Tree View Inline Sync Bug**: Resolved runtime error when triggering branch sync from SCM tree item inline action.

---

## [1.1.0] - 2026-10-11

### Added
- **Dedicated SCM Sidebar View**: Custom `Git Smart Sync` tree view under Source Control showing Presets, Local, and Remote branches.
- **Branch Presets System**: Configurable branch groups (e.g. `release`, `development`) for one-click multi-branch sync.
- **Divergence Guardrails**: Safe fast-forward verification before moving branch pointers.
- **Dry-Run Preview**: Test sync effects without pushing using `gitSmartSync.dryRun`.
- **Remote Prune Command**: Prune stale remote tracking branches directly from editor (`gitSmartSync.prune`).
- **Cancellation Token Support**: Cancel active pushes mid-flight safely via VS Code progress notification.
- **Automated Test Suite**: Integrated unit tests with Node test runner.
- **Branding Assets**: Crisp 128x128 extension icon and vector SVG.
- **CI/CD Automation**: GitHub Actions workflows for continuous integration and automated VSIX release.

### Changed
- Complete rewrite from JavaScript to modular **TypeScript** with strict type safety.
- Switched from raw string shell execution to secure argument-parameterized `execFile`.
- Replaced root `extension.js` with compiled `dist/extension.js`.

---

## [1.0.0] - 2026-10-11

### Added
- Initial release of Git Smart Branch Sync.
- Interactive multi-branch selection dropdown with checkboxes.
- Status bar sync button and Source Control title bar button.
- Configurable default remote (`gitSmartSync.defaultRemote`).
