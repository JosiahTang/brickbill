import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 6)) {
  console.error('Node.js 22.6+ is required by this project. Current: ' + process.version);
  process.exit(1);
}
function npm(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
}
try {
  if (!existsSync(path.join(root, 'node_modules/vite/package.json'))) {
    console.log('First run: installing dependencies. Internet access to npm is required.');
    const code = await npm(existsSync('package-lock.json') ? ['ci'] : ['install']);
    if (code !== 0) {
      console.error('Dependency installation failed. Check network / npm settings.');
      console.error('For a dependency-free interaction preview, open preview/index.html.');
      process.exit(code);
    }
  }
  console.log('Starting the full Vue / Univer app at http://127.0.0.1:5173');
  console.log('Press Ctrl+C to stop. This command starts a local server; it does not publish a Site.');
  process.exitCode = await npm(['run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173', '--strictPort', '--open']);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
