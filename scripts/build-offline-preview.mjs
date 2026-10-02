// This builds ONLY the optional HTML-grid preview, not the Vue/Univer application.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const names = ['model', 'fields', 'blocks', 'operations', 'demo'];
const modules = names.map(name => {
  const text = fs.readFileSync(path.join(root, `src/domain/${name}.ts`), 'utf8');
  const { outputText, diagnostics } = ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, strict: true },
    fileName: `${name}.ts`, reportDiagnostics: true,
  });
  if (diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) throw new Error(`Cannot transpile ${name}`);
  return `${JSON.stringify(name)}: function(module, exports, require) {\n${outputText}\n}`;
}).join(',\n');
const runtime = `(function(){'use strict';\nconst modules={${modules}};\nconst cache=Object.create(null);\nfunction load(id){id=id.replace(/^\\.\\//,'').replace(/\\.ts$/,'');if(cache[id])return cache[id].exports;if(!modules[id])throw new Error('Unknown module '+id);const m={exports:{}};cache[id]=m;modules[id](m,m.exports,load);return m.exports;}\nconst model=load('model'),ops=load('operations'),blocks=load('blocks'),demo=load('demo');\n${fs.readFileSync(path.join(root,'preview/app.js'),'utf8')}\n})();`;
let html = fs.readFileSync(path.join(root, 'preview/shell.html'), 'utf8');
html = html.replace('/*__INLINE_CSS__*/', fs.readFileSync(path.join(root, 'preview/style.css'), 'utf8'));
html = html.replace('/*__INLINE_SCRIPT__*/', () => runtime.replace(/<\/script/gi, '<\\/script'));
fs.writeFileSync(path.join(root, 'preview/index.html'), html);
console.log(`Generated preview/index.html (${Buffer.byteLength(html)} bytes). No remote scripts or fonts.`);
