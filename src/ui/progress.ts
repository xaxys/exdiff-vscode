import * as vscode from 'vscode';

/**
 * Runs `task` behind the standard ExDiff notification progress. The first
 * argument is the initial message; `report()` forwards core progress text
 * (from `ensureSnapshot`'s `onProgress`) to the notification.
 */
export async function withExProgress<T>(
  message: string,
  task: (report: (message: string) => void) => Promise<T>,
): Promise<T> {
  return await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'ExDiff' },
    (progress) => {
      progress.report({ message });
      return task((next) => progress.report({ message: stripPrefix(next) }));
    },
  );
}

/** Core progress strings are already prefixed with `ExDiff:`; the title shows it. */
function stripPrefix(message: string): string {
  return message.replace(/^ExDiff:\s*/i, '');
}
