// Minimal in-memory stand-in for the `vscode` module so UI/command code can be tested with plain Node.
const Module = require('node:module');

function createVscodeMock() {
  const calls = { error: [], warning: [], info: [], quickPick: [] };
  const responses = { warning: undefined, quickPick: undefined };
  const respond = (value, ...args) => (typeof value === 'function' ? value(...args) : value);

  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

  class TreeItem {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  }

  class EventEmitter {
    constructor() {
      this.event = () => ({ dispose() {} });
    }
    fire() {}
  }

  const mock = {
    calls,
    responses,
    reset() {
      for (const key of Object.keys(calls)) calls[key].length = 0;
      responses.warning = undefined;
      responses.quickPick = undefined;
      mock.window.activeTextEditor = undefined;
      mock.window.editorChangeListeners.length = 0;
      mock.commands.registered.clear();
      mock.workspace.workspaceFolders = undefined;
    },
    window: {
      activeTextEditor: undefined,
      showErrorMessage: async (...args) => void calls.error.push(args),
      showInformationMessage: async (...args) => void calls.info.push(args),
      showWarningMessage: async (...args) => {
        calls.warning.push(args);
        return respond(responses.warning, ...args);
      },
      showQuickPick: async (items, options) => {
        calls.quickPick.push({ items, options });
        return respond(responses.quickPick, items, options);
      },
      withProgress: async (_options, task) => task({ report() {} }, token),
      editorChangeListeners: [],
      onDidChangeActiveTextEditor(listener) {
        mock.window.editorChangeListeners.push(listener);
        return { dispose() {} };
      },
      createTreeView: () => ({ dispose() {} }),
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '' }),
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} })
    },
    commands: {
      registered: new Map(),
      registerCommand(name, handler) {
        mock.commands.registered.set(name, handler);
        return { dispose() {} };
      }
    },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: () => ({ get: (_key, defaultValue) => defaultValue })
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { Notification: 15 },
    TreeItem,
    EventEmitter,
    ThemeIcon: class {},
    ThemeColor: class {},
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }
  };
  return mock;
}

/** Make `require('vscode')` return the given mock for everything loaded afterwards in this process. */
function installVscodeMock(mock) {
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? mock : originalLoad.call(this, request, ...rest);
  };
}

module.exports = { createVscodeMock, installVscodeMock };
