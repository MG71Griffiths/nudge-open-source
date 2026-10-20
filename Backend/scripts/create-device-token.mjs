import { randomBytes, createHash } from 'node:crypto';
import { mkdir, access, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Run this yourself in a private terminal. Never print the token or API key.
const directory = new URL('../.private/', import.meta.url);
await mkdir(directory, { recursive: true, mode: 0o700 });
try {
  // Check both first so a leftover hash cannot create a mismatched token pair.
  for (const name of ['device-token.txt', 'device-token-sha256.txt']) {
    try { await access(new URL(name, directory)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw Object.assign(new Error('Already exists'), { code: 'EEXIST' });
  }
  const token = randomBytes(32).toString('hex');
  const digest = createHash('sha256').update(token, 'utf8').digest('hex');
  await writeFile(new URL('device-token.txt', directory), token, { flag: 'wx', mode: 0o600 });
  await writeFile(new URL('device-token-sha256.txt', directory), digest, { flag: 'wx', mode: 0o600 });
  console.log(`Created private device token and server hash in ${fileURLToPath(directory)}`);
  console.log('No secret was printed. Keep device-token.txt private; install its hash as the Worker secret.');
} catch (error) {
  if (error.code === 'EEXIST') console.error('Token files already exist. Keep them or move both to a secure backup before generating a replacement.');
  else console.error('Could not create private token files. Check folder permissions.');
  process.exitCode = 1;
}
