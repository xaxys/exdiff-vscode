import * as vscode from 'vscode';

import type { ExDiffConfig } from '../core/types';
import { readConfig } from '../core/settings';

/**
 * Shared services handed to every UI module. The configuration is read on
 * demand (never cached) so changes apply to the very next command.
 */
export interface UiHost {
  readonly context: vscode.ExtensionContext;
  readonly output: vscode.OutputChannel;
  getConfig(): ExDiffConfig;
}

export function createHost(context: vscode.ExtensionContext, output: vscode.OutputChannel): UiHost {
  return {
    context,
    output,
    getConfig: () =>
      readConfig({
        get: <T>(key: string, defaultValue: T): T =>
          vscode.workspace.getConfiguration().get<T>(key, defaultValue),
      }),
  };
}
