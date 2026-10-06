import { existsSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { readConfig, writeGuard } from './config.js';
import { ShopifyClient } from './client.js';
import { Repository } from './repository.js';
import { createOutput } from './output.js';
import { run } from './run.js';
import { createProgress } from './progress.js';

let lock, progress, finalStatus = 'failed';
try {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const [mode, ...args] = process.argv.slice(2);
  if (!['audit', 'write'].includes(mode) || args.some(a => a !== '--confirm-write')) throw new Error('Usage: node src/cli.js audit | write --confirm-write');
  writeGuard(mode, args, process.env);
  const config = readConfig();
  config.writeEnabled = mode === 'write';
  try { lock = await open('.recommendations.lock', 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another run may be active. Inspect .recommendations.lock; remove it only after confirming no run is active.'); throw error; }
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), mode }));
  const output = await createOutput(mode);
  console.log(`Output: ${output.directory}`);
  progress = createProgress(output.directory);
  const client = new ShopifyClient(config, { onProgress: progress.update });
  const summary = await run({ mode, config, client, repository: new Repository(client, progress.update), output });
  finalStatus = summary.status;
  console.log(JSON.stringify(summary, null, 2));
  if (summary.status !== 'completed') process.exitCode = 1;
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally {
  progress?.close(finalStatus);
  if (lock) { await lock.close(); await unlink('.recommendations.lock'); }
}
