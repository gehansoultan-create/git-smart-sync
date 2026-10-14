/**
 * Guards for values that end up as arguments of git commands.
 *
 * `GitRunner` uses `execFile`, so there is no shell involved, but git itself still parses its
 * arguments: a "remote" such as `--upload-pack=<cmd>` is read as an option and makes git run
 * `<cmd>`. Remote and branch names come from settings (which a workspace can ship in
 * `.vscode/settings.json`), so they must be rejected before they are put on a command line.
 *
 * These checks are intentionally a conservative subset of `git check-ref-format`: their job is to
 * keep option-like and malformed values out, git still has the final say on everything else.
 */

/** Returns why `remote` cannot be used as a git remote name, or undefined when it is acceptable. */
export function remoteNameProblem(remote: unknown): string | undefined {
  if (typeof remote !== 'string' || remote.length === 0) {
    return 'the name is empty';
  }
  if (remote.startsWith('-')) {
    return "the name starts with '-' and would be read as a git option";
  }
  if (!/^[\p{L}\p{N}_.][\p{L}\p{N}_.@+/-]*$/u.test(remote)) {
    return 'the name contains characters that are not allowed in a remote name';
  }
  return undefined;
}

/** Returns why `branch` cannot be used as a branch name, or undefined when it is acceptable. */
export function branchNameProblem(branch: unknown): string | undefined {
  if (typeof branch !== 'string' || branch.length === 0) {
    return 'the name is empty';
  }
  if (branch.startsWith('-')) {
    return "the name starts with '-' and would be read as a git option";
  }
  if (branch === '@') {
    return "'@' is not a valid branch name";
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f~^:?*[\\]/.test(branch)) {
    return 'the name contains whitespace, control or special characters (~ ^ : ? * [ \\)';
  }
  if (branch.includes('..') || branch.includes('@{') || branch.includes('//')) {
    return "the name contains '..', '@{' or '//'";
  }
  if (branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.')) {
    return "the name starts or ends with '/' or ends with '.'";
  }
  if (branch.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))) {
    return "a path component starts with '.' or ends with '.lock'";
  }
  return undefined;
}

/** Throws when `remote` is not safe to pass to git. */
export function assertSafeRemoteName(remote: string): void {
  const problem = remoteNameProblem(remote);
  if (problem) {
    throw new Error(`Invalid remote name '${remote}': ${problem}.`);
  }
}
