import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRODUCT_IMAGE_ORIGIN, parseWarmArguments, runImageWarmCLI } from '../scripts/warm-product-images.mjs';
import { canonicalProductThumbnail } from '../src/product-images.js';

test('warmer CLI pins the credential recipient and rejects unsafe options', () => {
  assert.throws(() => parseWarmArguments(['--token-file', '/tmp/token', '--origin', 'https://unrelated.example']), /administrative origin/);
  assert.throws(() => parseWarmArguments(['--token-file', '/tmp/token', '--origin', PRODUCT_IMAGE_ORIGIN + '/']), /administrative origin/);
  assert.throws(() => parseWarmArguments(['--token-file', '/tmp/token', '--concurrency', '100']), /Invalid/);
  assert.throws(() => parseWarmArguments(['--token-file', '/tmp/token', '--checkpoint', '/tmp/token']), /different/);
  assert.throws(() => parseWarmArguments(['--token', 'secret']), /Unknown/);
  assert.equal(parseWarmArguments(['--token-file', '/tmp/token']).concurrency, 4);
});

test('CLI resumes from disk and only sends its credential to the private manifest route', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'nudge-image-warm-test-'));
  try {
    const tokenFile = join(folder, 'token'), checkpoint = join(folder, 'progress.json'), token = 'synthetic-test-token-never-real';
    await writeFile(tokenFile, token, {mode: 0o600});
    const args = parseWarmArguments(['--token-file', tokenFile, '--checkpoint', checkpoint]), calls = [], output = [];
    const image = canonicalProductThumbnail('https://images.openfoodfacts.org/images/products/500/000/000/0001/front_en.2.200.jpg');
    const fetcher = async (input, options) => {
      const url = new URL(input); calls.push(url.pathname); assert.equal(url.origin, PRODUCT_IMAGE_ORIGIN); assert.equal(options.redirect, 'error');
      if (url.pathname === '/v1/catalogue/image-manifest') {
        assert.equal(options.headers.authorization, `Bearer ${token}`);
        return Response.json({images: [image], scanned: 1, hasMore: false, nextAfter: null});
      }
      assert.equal(options.headers.authorization, undefined);
      return new Response(new Uint8Array(42), {headers: {'content-length': '42', 'x-nudge-image-cache': 'edge'}});
    };
    const result = await runImageWarmCLI(args, {fetcher, output: value => output.push(value)});
    assert.equal(result.status, 'complete'); assert.equal(result.reused, 1); assert.equal(result.referencedBytes, 42);
    assert.equal(JSON.stringify(output).includes(token), false); assert.equal((await readFile(checkpoint, 'utf8')).includes(token), false);
    assert.equal((await stat(checkpoint)).mode & 0o777, 0o600);
    const count = calls.length;
    assert.equal((await runImageWarmCLI(args, {fetcher, output: () => {}})).status, 'complete'); assert.equal(calls.length, count);
    await assert.rejects(stat(checkpoint + '.lock'), {code: 'ENOENT'});
  } finally { await rm(folder, {recursive: true, force: true}); }
});
