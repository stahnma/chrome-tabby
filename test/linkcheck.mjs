import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { globSync } from 'node:fs';

const root = process.cwd();
let bad = 0;

// 1. every relative import resolves
const files = globSync('{src,test}/**/*.js', { cwd: root });
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const target = resolve(dirname(f), m[1]);
    if (!existsSync(target)) { console.log(`MISSING import  ${f} -> ${m[1]}`); bad++; }
  }
}

// 2. manifest entry points exist
const mf = JSON.parse(readFileSync('manifest.json', 'utf8'));
for (const p of [mf.background?.service_worker, mf.action?.default_popup, mf.options_ui?.page].filter(Boolean)) {
  if (!existsSync(p)) { console.log(`MISSING manifest path  ${p}`); bad++; }
}

// 3. html asset references exist
for (const html of globSync('src/**/*.html', { cwd: root })) {
  const src = readFileSync(html, 'utf8');
  for (const m of src.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (/^https?:/.test(m[1])) continue;
    const target = resolve(dirname(html), m[1]);
    if (!existsSync(target)) { console.log(`MISSING asset  ${html} -> ${m[1]}`); bad++; }
  }
}

// 4b. no inline event handlers (MV3 CSP kills them silently)
for (const html of globSync('src/**/*.html', { cwd: root })) {
  const src = readFileSync(html, 'utf8');
  if (/\son[a-z]+\s*=\s*"/i.test(src)) { console.log(`INLINE HANDLER  ${html}`); bad++; }
}

// 5. the purity rule: these must never reference chrome.* in CODE (comments may discuss it)
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
for (const f of ['src/core/decide.js','src/core/evidence.js','src/core/questions.js','src/core/url.js','src/transport/backoff.js']) {
  if (/\bchrome\./.test(stripComments(readFileSync(f, 'utf8')))) { console.log(`IMPURE  ${f} references chrome.*`); bad++; }
}

// 6. replaceChildren() takes varargs, so passing it an array silently stringifies to
//    "[object HTMLDivElement],...". Everything goes through setChildren() instead.
for (const f of globSync('src/ui/*.js', { cwd: root })) {
  if (f.endsWith('msg.js')) continue;
  if (/\.replaceChildren\(/.test(readFileSync(f, 'utf8'))) {
    console.log(`RAW replaceChildren  ${f} -- use setChildren() from msg.js`); bad++;
  }
}

// 7. every message type the UI sends has a handler
const bg = readFileSync('src/background.js', 'utf8');
const handlers = new Set([...bg.matchAll(/^\s{2}(\w+):\s*async/gm)].map(m => m[1]));
for (const f of globSync('src/ui/*.js', { cwd: root })) {
  for (const m of readFileSync(f, 'utf8').matchAll(/send\(\s*'(\w+)'/g)) {
    if (!handlers.has(m[1])) { console.log(`NO HANDLER  ${f} sends '${m[1]}'`); bad++; }
  }
}

console.log(bad === 0 ? `\nclean — ${files.length} modules, ${handlers.size} message handlers` : `\n${bad} problem(s)`);
process.exit(bad ? 1 : 0);
