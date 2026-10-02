// Small local preview server, using only Node's standard library.
// Not a production-facing HTTP server. Always binds to loopback.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
  return args[i + 1];
}
const selected = option('--root', 'dist');
if (!['dist', 'preview'].includes(selected)) throw new Error('--root must be dist or preview');
const root = path.join(project, selected);
if (!fs.existsSync(path.join(root, 'index.html'))) {
  console.error(`${selected}/index.html does not exist. For dist run npm run build first.`);
  process.exit(1);
}
const port = Number(option('--port', '4173'));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const reply = (code, text) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(text); };
  if (!['GET', 'HEAD'].includes(req.method)) { reply(405, 'Method not allowed'); return; }
  let filename;
  try {
    const pathname = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (pathname.includes('\0') || pathname.includes('\\')) { reply(400, 'Bad path'); return; }
    filename = path.resolve(root, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname));
    if (!filename.startsWith(root + path.sep)) { reply(403, 'Forbidden'); return; }
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) { reply(404, 'Not found'); return; }
    const real = fs.realpathSync(filename);
    if (!real.startsWith(fs.realpathSync(root) + path.sep)) { reply(403, 'Forbidden'); return; }
  } catch { reply(400, 'Bad path'); return; }
  const size = fs.statSync(filename).size;
  res.writeHead(200, { 'Content-Type': mime[path.extname(filename)] ?? 'application/octet-stream',
    'Content-Length': size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer' });
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = fs.createReadStream(filename);
  stream.on('error', () => res.destroy()); stream.pipe(res);
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(`Local preview only: http://127.0.0.1:${port} (${selected})`);
});
process.on('SIGINT', () => server.close());
process.on('SIGTERM', () => server.close());
