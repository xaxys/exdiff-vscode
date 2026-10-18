import * as vscode from 'vscode';

export type CommandHandler<TArgs extends unknown[]> = (...args: TArgs) => Promise<void> | void;

/** `true` when the error only means "the user pressed Escape". */
export function isCancellation(error: unknown): boolean {
  return error instanceof vscode.CancellationError;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

/** Single-line, length-limited rendering of an error message for notifications. */
export function shortErrorMessage(error: unknown, limit = 400): string {
  const text = errorMessage(error).replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Writes the full stack trace to the ExDiff output channel, then shows a
 * notification whose "Show Details" button reveals that channel.
 */
export async function reportError(
  output: vscode.OutputChannel,
  commandId: string,
  error: unknown,
): Promise<void> {
  const message = errorMessage(error);
  const stack =
    error instanceof Error && error.stack ? error.stack : `${error instanceof Error ? error.name : 'Error'}: ${message}`;

  output.appendLine(`[${new Date().toISOString()}] ${commandId} failed`);
  output.appendLine(stack);
  output.appendLine('');

  const showDetails = vscode.l10n.t('Show Details');
  const choice = await vscode.window.showErrorMessage(
    vscode.l10n.t('ExDiff: {0}', shortErrorMessage(error)),
    showDetails,
  );
  if (choice === showDetails) output.show(true);
}

/**
 * Registers a command with the shared error handling: a thrown error becomes
 * `ExDiff: …` + "Show Details" and a full stack in the output channel.
 *
 * Commands that end in a user cancellation (QuickPick dismissed, workspace
 * folder update cancelled) resolve silently instead of showing a red error.
 */
export function registerCommand<TArgs extends unknown[]>(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  id: string,
  handler: CommandHandler<TArgs>,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(id, async (...args: TArgs) => {
      try {
        await handler(...args);
      } catch (error) {
        if (isCancellation(error)) return;
        await reportError(output, id, error);
      }
    }),
  );
}

/** Yellow notification for expected dead ends (no repo, missing ref, …). */
export function warn(message: string): void {
  void vscode.window.showWarningMessage(message);
}

/** Neutral notification for normal "nothing to do" outcomes. */
export function info(message: string): void {
  void vscode.window.showInformationMessage(message);
}
