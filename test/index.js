'use strict';

/**
 * Entry point for `node --test test/` (the command used by `npm test`).
 *
 * Node.js 24 no longer expands a directory argument into the test files it
 * contains — the argument is treated as a single entry point — but it still
 * resolves a directory through normal CommonJS resolution, so this file is
 * loaded and simply pulls in every test file.
 *
 * `node --test "test/*.test.cjs"` runs the same files in separate processes;
 * both invocations are supported and produce identical results.
 */

require('./paths.test.cjs');
require('./settings.test.cjs');
require('./git.test.cjs');
require('./rangeDiff.test.cjs');
require('./snapshot.test.cjs');
require('./maintenance.test.cjs');
require('./i18n.test.cjs');
