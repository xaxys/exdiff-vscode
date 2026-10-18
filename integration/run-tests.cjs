'use strict';

/**
 * Integration smoke test runner.
 *
 * Creates a throw-away multi-root workspace (a repository plus a dummy second
 * folder, so adding snapshot folders never has to convert a single-folder
 * workspace into a multi-root one), launches a real VS Code instance with a
 * fresh profile and runs `integration/suite/index.cjs` inside the extension
 * host. The downloaded VS Code lives in `.vscode-test/` (git-ignored).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '..');
  const harness = fs.mkdtempSync(path.join(os.tmpdir(), 'exdiff-it-'));
  const workspace = path.join(harness, 'repo');
  const extraFolder = path.join(harness, 'extra');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(extraFolder, { recursive: true });

  const workspaceFile = path.join(harness, 'exdiff.code-workspace');
  fs.writeFileSync(
    workspaceFile,
    `${JSON.stringify(
      {
        folders: [{ path: 'repo' }, { path: 'extra' }],
        settings: {},
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const git = (args) =>
    execFileSync('git', args, {
      cwd: workspace,
      encoding: 'utf8',
      env: { ...process.env, GIT_EDITOR: 'true' },
    });

  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'integration@example.com']);
  git(['config', 'user.name', 'ExDiff Integration']);

  fs.writeFileSync(path.join(workspace, 'a.txt'), 'one\n');
  git(['add', '-A']);
  git(['commit', '-m', 'base']);

  fs.writeFileSync(path.join(workspace, 'a.txt'), 'one\ntwo\n');
  git(['commit', '-am', 'feat: two']);

  // A staged modification of a tracked file: both sides of the staged-only
  // diff (HEAD snapshot and index snapshot) must exist on disk.
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'one\ntwo\nthree\n');
  git(['add', 'a.txt']);

  // An added, staged file for the Changes view.
  fs.writeFileSync(path.join(workspace, 'b.txt'), 'staged\n');
  git(['add', 'b.txt']);

  const userData = path.join(harness, 'user-data');
  const extensions = path.join(harness, 'extensions');

  try {
    await runTests({
      version: 'stable',
      extensionDevelopmentPath,
      extensionTestsPath: path.join(__dirname, 'suite', 'index.cjs'),
      launchArgs: [
        workspaceFile,
        '--user-data-dir',
        userData,
        '--extensions-dir',
        extensions,
        '--disable-gpu',
        '--disable-workspace-trust',
        '--disable-telemetry',
        '--skip-welcome',
      ],
      extensionTestsEnv: { EXDIFF_IT_WORKSPACE: workspace },
    });
  } finally {
    fs.rmSync(harness, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
