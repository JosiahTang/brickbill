// Test-only process boundary: the real ci-compose-smoke entry, streams and evidence run unchanged.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const scenario = process.env.BRICKBILL_TEST_COMPOSE_SCENARIO;
const logPath = process.env.BRICKBILL_TEST_COMMAND_LOG;
const downProjects = new Set();
const cleanupFails = ['main-and-cleanup-failure', 'cleanup-only-failure'].includes(scenario);
const record = (method, command, args) => appendFileSync(logPath, `${JSON.stringify({ method, command, args })}\n`);
const result = (stdout = '', status = 0, stderr = '') => ({ status, stdout, stderr });

childProcess.spawnSync = (command, args) => {
  record('spawnSync', command, args);
  if (command === process.execPath) {
    if (['ENOENT', 'EPERM', 'ETIMEDOUT'].includes(scenario))
      return { status: null, error: Object.assign(new Error(`smoke spawn ${scenario}`), { code: scenario }) };
    if (scenario === 'nonzero') return result('', 9, 'synthetic smoke refused request');
    if (scenario === 'empty') return result('');
    if (scenario === 'invalid-json') return result('progress\nnot-json\n');
    return result(`${JSON.stringify({ projectId: 'dalipu-demo', generationId: 't42-generation', pageCount: 2,
      sha256: 'a'.repeat(64), dependencySha256: 'b'.repeat(64), dependencyCount: 2 })}\n`);
  }
  if (command !== 'docker') throw new Error(`unexpected command ${command}`);
  if (args[0] === 'compose') {
    const project = args[2];
    if (args[3] === 'port') return result('127.0.0.1:32001\n');
    if (args[3] === 'images') return result('sha256:synthetic-api\n');
    if (args[3] === 'logs') return cleanupFails && project.startsWith('brickbill-restore-')
      ? result('', 1, 'synthetic restore logs denied') : result('synthetic compose log\n');
    if (args[3] === 'down') {
      if (cleanupFails && project.startsWith('brickbill-restore-')) return result('', 2, 'synthetic down failed');
      downProjects.add(project); return result();
    }
  }
  if (args[0] === 'container' && args[1] === 'inspect')
    return cleanupFails && args[2].endsWith('-restore')
      ? result('', 1, 'Cannot connect to the Docker daemon: synthetic helper cleanup failure')
      : result('', 1, `Error: No such container: ${args[2]}`);
  if (args[0] === 'volume' && args[1] === 'ls') {
    const filter = args.find(value => value.startsWith('label=com.docker.compose.project='));
    return result(`${filter.split('=').at(-1)}_reporting-data\n`);
  }
  if (args[0] === 'volume' && args[1] === 'inspect') {
    const project = args[2].replace(/_reporting-data$/, '');
    return downProjects.has(project) ? result('[]', 1, `Error response from daemon: get ${args[2]}: no such volume`)
      : result(JSON.stringify([{ Labels: { 'com.docker.compose.project': project, 'com.docker.compose.volume': 'reporting-data' } }]));
  }
  if (args[0] === 'image' && args[1] === 'inspect')
    return cleanupFails && args[2].endsWith('-api:local')
      ? result('', 1, 'Cannot connect to the Docker daemon: synthetic image cleanup failure') : result('[{}]');
  if (['image', 'volume', 'container'].includes(args[0]) && args[1] === 'rm') return result();
  throw new Error(`unexpected Docker sync command ${JSON.stringify(args)}`);
};

childProcess.spawn = (command, args) => {
  record('spawn', command, args);
  if (command !== 'docker') throw new Error(`unexpected command ${command}`);
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => { child.emit('close', null); return true; };
  if (args[0] === 'run' && args.includes('--interactive')) {
    child.stdin.on('data', () => {});
    child.stdin.once('finish', () => {
      child.stderr.end('EMPTY_TARGET_VERIFIED\n'); child.stdout.end(); child.emit('close', 0);
    });
  } else {
    setImmediate(() => {
      child.stdout.end(args[0] === 'run' ? Buffer.from('T42 synthetic archive stream') : undefined);
      child.stderr.end();
      child.emit('close', scenario === 'main-and-cleanup-failure' && args.includes('--build') ? 7 : 0);
    });
  }
  return child;
};
syncBuiltinESMExports();
