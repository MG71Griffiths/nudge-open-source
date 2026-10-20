'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const root = path.resolve(__dirname, '..');
(async () => {
  const {requireAdminOrigin} = await import(pathToFileURL(path.join(root, 'Backend/scripts/require-admin-origin.mjs')));
  for (const value of ['', 'http://admin.example', 'https://configure-nudge-backend.invalid', 'https://user:pass@admin.example', 'https://admin.example/', 'https://admin.example/path', 'https://admin.example?secret=example']) {
    assert.throws(() => requireAdminOrigin(value));
  }
  assert.equal(requireAdminOrigin('https://admin.example'), 'https://admin.example');
  const env = {...process.env}; delete env.NUDGE_ADMIN_ORIGIN;
  const commands = {
    'enrich-catalogue.mjs': [],
    'score-catalogue-pilot.mjs': [],
    'index-catalogue-discovery.mjs': ['--token-file', '/nonexistent-export-test-token'],
    'index-catalogue-places.mjs': ['--token-file', '/nonexistent-export-test-token'],
    'refresh-catalogue-scores.mjs': ['--token-file', '/nonexistent-export-test-token'],
    'tag-womens-food-catalogue.mjs': ['--token-file', '/nonexistent-export-test-token'],
    'warm-product-images.mjs': ['--token-file', '/nonexistent-export-test-token'],
    'review-product-contributions.mjs': ['list'],
  };
  for (const [file, args] of Object.entries(commands)) {
    const result = spawnSync(process.execPath, ['Backend/scripts/' + file, ...args], {cwd: root, env, encoding: 'utf8', timeout: 30000});
    assert.notEqual(result.status, 0, file + ' must reject an unconfigured destination');
    assert.match((result.stdout || '') + (result.stderr || ''), /NUDGE_ADMIN_ORIGIN/, file + ' must reject missing destination before credential access or network work');
  }
  console.log('PASS: all eight administrative CLIs reject an unconfigured destination; unsafe origins rejected.');
})().catch(error => {console.error(error); process.exitCode = 1;});
