'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.local', 'source-checks');
fs.mkdirSync(out, {recursive: true});
const env = {...process.env, NUDGE_ADMIN_ORIGIN: 'https://admin.example'};
for (const key of Object.keys(env)) if (/^(OPENAI|SUPABASE|PRIVATE_ACCESS_TOKEN|CATALOGUE_ADMIN_TOKEN|NUDGE_CATALOGUE_ADMIN_TOKEN|CLOUDFLARE_API)/.test(key)) delete env[key];
env.NODE_OPTIONS = '--jitless --require=' + JSON.stringify(path.join(__dirname, 'deny-external-network.cjs'));
const summary = [];
function run(name, program, args) {
  const handle = fs.openSync(path.join(out, name + '.log'), 'w');
  const result = spawnSync(program, args, {cwd: root, env, stdio: ['ignore', handle, handle], timeout: 600000});
  fs.closeSync(handle);
  if (result.error) fs.appendFileSync(path.join(out, name + '.log'), String(result.error));
  summary.push({name, exitCode: result.status, passed: result.status === 0});
  console.log(name + ': ' + (result.status === 0 ? 'PASS' : 'FAIL (see .local/source-checks/' + name + '.log)'));
}
run('package', 'python3', ['tests/check_package.py']);
run('export-config', process.execPath, ['tools/check-export-config.cjs']);
run('backend', process.execPath, ['--test', '--test-concurrency=1', ...fs.readdirSync(path.join(root, 'Backend/test')).filter(n => n.endsWith('.test.js')).sort().map(n => 'Backend/test/' + n)]);
const webTests = fs.readdirSync(path.join(root, 'tests')).filter(n => n.endsWith('.test.cjs')).sort();
for (const name of webTests) run('web-' + name.replace('.test.cjs', ''), process.execPath, ['tests/' + name]);
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({network: 'external fetch/http/https denied; explicit mocks and loopback allowed', checks: summary}, null, 2) + '\n');
process.exitCode = summary.every(x => x.passed) ? 0 : 1;
