'use strict';

/**
 * Static i18n checks for the extension manifest and the runtime bundle.
 *
 * Nothing here touches the file system for writing: the tests only read
 * `package.json`, the two `package.nls*.json` files, `l10n/bundle.l10n.zh-cn.json`
 * and the TypeScript sources, so they are cross-platform and repeatable.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const BUNDLE_FILE = path.join(ROOT, 'l10n', 'bundle.l10n.zh-cn.json');

const PLACEHOLDER = /^%(.+)%$/;

/** Relation labels produced by `src/core/rangeDiff.ts`; added to the bundle by hand. */
const RELATIONSHIP_LABELS = ['unchanged', 'rewritten', 'only in old', 'only in new', 'unknown'];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const pkg = readJson(path.join(ROOT, 'package.json'));
const nlsEn = readJson(path.join(ROOT, 'package.nls.json'));
const nlsZh = readJson(path.join(ROOT, 'package.nls.zh-cn.json'));
const bundle = readJson(BUNDLE_FILE);

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/* -------------------------------------------------------------------------- */
/* 1. package.json %key% placeholders                                          */
/* -------------------------------------------------------------------------- */

/** Every `%key%` string anywhere in a JSON value, in document order. */
function collectPlaceholders(value, found = []) {
  if (typeof value === 'string') {
    const match = PLACEHOLDER.exec(value);
    if (match) found.push(match[1]);
  } else if (Array.isArray(value)) {
    for (const item of value) collectPlaceholders(item, found);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectPlaceholders(item, found);
  }
  return found;
}

test('every %key% in package.json exists in package.nls.json and package.nls.zh-cn.json', () => {
  const keys = collectPlaceholders(pkg);
  assert.ok(keys.length > 0, 'package.json contains no %key% placeholders');

  for (const key of keys) {
    assert.ok(has(nlsEn, key), `package.nls.json is missing "${key}"`);
    assert.ok(has(nlsZh, key), `package.nls.zh-cn.json is missing "${key}"`);
  }
});

test('package.nls.json and package.nls.zh-cn.json define the same keys', () => {
  assert.deepEqual(Object.keys(nlsZh).sort(), Object.keys(nlsEn).sort());
});

/* -------------------------------------------------------------------------- */
/* 2. vscode.l10n.t() literals in the TypeScript sources                        */
/* -------------------------------------------------------------------------- */

function typescriptFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      typescriptFiles(full, found);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      found.push(full);
    }
  }
  return found;
}

/** `vscode.l10n.t` / `l10n.t` property access. */
function isL10nT(node) {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== 't') return false;
  const target = node.expression;
  if (!ts.isPropertyAccessExpression(target) || target.name.text !== 'l10n') return false;
  return ts.isIdentifier(target.expression) || ts.isPropertyAccessExpression(target.expression);
}

/**
 * Collects the first argument of every `l10n.t(...)` call that is a string
 * literal. Non-literal arguments (e.g. `relationshipLabel(pair.relation)`) are
 * reported separately: they cannot be checked statically.
 */
function collectL10nLiterals() {
  const literals = [];
  const dynamic = [];

  for (const file of typescriptFiles(SRC_DIR)) {
    const source = fs.readFileSync(file, 'utf8');
    const text = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    const visit = (node) => {
      if (ts.isCallExpression(node) && isL10nT(node.expression)) {
        const argument = node.arguments[0];
        if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
          const { line } = text.getLineAndCharacterOfPosition(argument.getStart(text));
          literals.push({ file: path.relative(ROOT, file), line: line + 1, message: argument.text });
        } else {
          dynamic.push(path.relative(ROOT, file));
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(text);
  }

  return { literals, dynamic };
}

const { literals, dynamic } = collectL10nLiterals();

test('every literal passed to l10n.t() is a key of the zh-cn bundle', () => {
  assert.ok(literals.length > 0, 'no literal l10n.t() call found in src/**/*.ts');

  for (const { file, line, message } of literals) {
    assert.ok(has(bundle, message), `${file}:${line} uses "${message}" which is missing from l10n/bundle.l10n.zh-cn.json`);
  }
});

test('non-literal l10n.t() arguments only receive the known relation labels', () => {
  // `relationshipLabel()` is the single non-literal source; its five possible
  // return values are added to the bundle by hand.
  assert.ok(dynamic.length <= 1, `unexpected non-literal l10n.t() arguments in: ${dynamic.join(', ')}`);
  for (const label of RELATIONSHIP_LABELS) {
    assert.ok(has(bundle, label), `relation label "${label}" is missing from l10n/bundle.l10n.zh-cn.json`);
  }
});

/* -------------------------------------------------------------------------- */
/* 3. bundle shape                                                             */
/* -------------------------------------------------------------------------- */

test('the zh-cn bundle maps non-empty English keys to non-empty translations', () => {
  const entries = Object.entries(bundle);
  assert.ok(entries.length > 0, 'l10n/bundle.l10n.zh-cn.json is empty');

  for (const [key, value] of entries) {
    assert.equal(typeof key, 'string');
    assert.ok(key.trim().length > 0, 'the bundle contains an empty key');
    assert.equal(typeof value, 'string', `translation for "${key}" is not a string`);
    assert.ok(value.trim().length > 0, `translation for "${key}" is empty`);
  }

  assert.equal(Object.keys(bundle).length, entries.length, 'the bundle must be a flat object');
});
