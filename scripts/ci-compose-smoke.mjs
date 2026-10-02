import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve('.');
const outputDirectory = resolve('output/t24');
const smokeUrl = process.env.BRICKBILL_SMOKE_URL ?? 'http://127.0.0.1:8080';
const token = process.env.BRICKBILL_SMOKE_TOKEN;
if (!token) throw new Error('BRICKBILL_SMOKE_TOKEN 未设置');

function run(command, args, env = process.env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`${command} ${args.join(' ')} exited ${code ?? 'unknown'}`)));
  });
}

function readSmoke(extra) {
  const child = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/smoke-deployment.mjs'], {
    cwd: root, env: { ...process.env, BRICKBILL_SMOKE_URL: smokeUrl, BRICKBILL_SMOKE_TOKEN: token, ...extra },
    encoding: 'utf8', timeout: 120_000, windowsHide: true,
  });
  if (child.status !== 0) throw new Error(child.stderr.trim() || child.stdout.trim() || `Smoke exited ${child.status}`);
  return JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1));
}

async function captureComposeLogs() {
  const result = spawnSync('docker', ['compose', 'logs', '--no-color'], { cwd: root, encoding: 'utf8', windowsHide: true });
  await writeFile(resolve(outputDirectory, 'compose.log'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`, 'utf8');
}

await mkdir(outputDirectory, { recursive: true });
let primaryError;
try {
  await run('docker', ['compose', 'up', '--build', '--detach', '--wait', '--wait-timeout', '300']);
  const first = readSmoke({ BRICKBILL_SMOKE_CREATE_DEMO: '1', BRICKBILL_SMOKE_PROJECT: 'dalipu-demo' });
  if (!first.generationId || !/^[0-9a-f]{64}$/i.test(first.sha256)) throw new Error('部署烟测没有返回完整生成快照');
  await writeFile(resolve(outputDirectory, 'compose-before-restart.json'), `${JSON.stringify(first, null, 2)}\n`);

  await run('docker', ['compose', 'restart', 'reporting-api']);
  await run('docker', ['compose', 'up', '--detach', '--wait', '--wait-timeout', '120']);
  const after = readSmoke({ BRICKBILL_SMOKE_GENERATION_ID: first.generationId, BRICKBILL_SMOKE_CREATE_DEMO: '0' });
  if (after.sha256 !== first.sha256 || after.pageCount !== first.pageCount)
    throw new Error(`服务重启后快照不一致：before=${first.sha256}/${first.pageCount}, after=${after.sha256}/${after.pageCount}`);
  await writeFile(resolve(outputDirectory, 'compose-after-restart.json'), `${JSON.stringify(after, null, 2)}\n`);
  await writeFile(resolve(outputDirectory, 'compose-smoke-result.json'), `${JSON.stringify({ status: 'passed', generationId: first.generationId,
    pageCount: first.pageCount, sha256: first.sha256, restartSnapshotReused: true }, null, 2)}\n`);
  process.stdout.write(`Docker Compose smoke passed: ${first.pageCount} page(s), SHA-256 ${first.sha256}\n`);
} catch (error) {
  primaryError = error;
} finally {
  await captureComposeLogs();
  const down = spawnSync('docker', ['compose', 'down', '--volumes', '--remove-orphans'], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (down.status !== 0 && !primaryError) primaryError = new Error(`docker compose down exited ${down.status ?? 'unknown'}`);
}
if (primaryError) throw primaryError;
