#!/usr/bin/env node
/**
 * Controlli statici del progetto, senza dipendenze. Uso: node tests/static-check.mjs
 * Esce con codice 1 se trova anche un solo problema.
 *
 *  a. ogni file del precache di sw.js esiste
 *  b. ogni import relativo in js/ punta a un file esistente
 *  c. le icone del manifest esistono (e i PNG hanno le dimensioni dichiarate)
 *  d. nessuna richiesta a CDN non ammesse (cdn.jsdelivr.net solo in js/config.js)
 *  e. nessuna emoji in js/, css/ e index.html
 *  f. le risorse locali di index.html (stili, script, manifest, icone) esistono
 *  g. la versione è la stessa in package.json, js/config.js e sw.js
 *  h. ogni modulo di js/ è nell'elenco del precache
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const exists = (p) => fs.existsSync(p) && fs.statSync(p).isFile();
const read = (p) => fs.readFileSync(p, 'utf-8');

function walk(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, out);
    else if (exts.includes(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

const jsFiles = walk(path.join(ROOT, 'js'), ['.js', '.mjs']).sort();
const cssFiles = walk(path.join(ROOT, 'css'), ['.css']).sort();
const indexPath = path.join(ROOT, 'index.html');
const sourceFiles = [...jsFiles, ...cssFiles, ...(exists(indexPath) ? [indexPath] : [])];

/** Toglie i commenti JS lasciando intatte le stringhe (così gli URL con // non vengono tagliati). */
function stripJsComments(code) {
  return code.replace(
    /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match, str) => str || ''
  );
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

const results = [];
function check(id, title, run) {
  let problems = [];
  let info = '';
  try {
    const out = run();
    problems = out.problems;
    info = out.info || '';
  } catch (err) {
    problems = [`il controllo non è riuscito: ${err.message}`];
  }
  results.push({ id, title, problems, info });
}

// a. precache di sw.js
check('a', 'Precache del service worker', () => {
  const sw = read(path.join(ROOT, 'sw.js'));
  const block = sw.match(/const PRECACHE = \[([\s\S]*?)\];/);
  if (!block) return { problems: ['non trovo l\'elenco PRECACHE in sw.js'] };
  const entries = [...block[1].matchAll(/'(\.\/[^']*)'/g)].map((m) => m[1]);
  const missing = entries.filter((e) => !exists(path.join(ROOT, e === './' ? 'index.html' : e)));
  return {
    info: `${entries.length} voci, ${entries.length - missing.length} presenti`,
    problems: missing.map((m) => `manca ${m}`)
  };
});

// b. import relativi
check('b', 'Import relativi in js/', () => {
  const problems = [];
  let total = 0;
  const patterns = [
    /\b(?:import|export)\s+(?:[^'"`;]*?\sfrom\s*)?(['"])([^'"\n]+)\1/g,
    /\bimport\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)/g
  ];
  for (const file of jsFiles) {
    const raw = read(file);
    const code = stripJsComments(raw);
    for (const re of patterns) {
      for (const m of code.matchAll(re)) {
        const spec = m[2];
        if (/^https?:/i.test(spec)) continue; // le richieste remote le guarda il controllo d
        total += 1;
        const where = `${rel(file)}:${lineOf(code, m.index)}`;
        if (!/^\.{1,2}\//.test(spec)) {
          problems.push(`${where} importa '${spec}': senza ./ non si risolve nel browser`);
          continue;
        }
        const target = path.resolve(path.dirname(file), spec.split(/[?#]/)[0]);
        if (!exists(target)) problems.push(`${where} importa '${spec}', che non esiste`);
      }
    }
  }
  return { info: `${total} import in ${jsFiles.length} file`, problems };
});

// c. icone del manifest
function pngSize(file) {
  const buf = fs.readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(signature)) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

check('c', 'Icone del manifest', () => {
  const problems = [];
  const manifestPath = path.join(ROOT, 'manifest.webmanifest');
  if (!exists(manifestPath)) return { problems: ['manca manifest.webmanifest'] };
  const manifest = JSON.parse(read(manifestPath));
  const icons = [...(manifest.icons || [])];
  for (const s of manifest.shortcuts || []) icons.push(...(s.icons || []));
  for (const icon of icons) {
    const file = path.resolve(ROOT, icon.src);
    if (!exists(file)) {
      problems.push(`manca ${icon.src}`);
      continue;
    }
    if (icon.type === 'image/png' && /^\d+x\d+$/.test(icon.sizes || '')) {
      const size = pngSize(file);
      const [w, h] = icon.sizes.split('x').map(Number);
      if (!size) problems.push(`${icon.src} non è un PNG valido`);
      else if (size.w !== w || size.h !== h) problems.push(`${icon.src} dichiara ${icon.sizes} ma è ${size.w}x${size.h}`);
    }
  }
  if (!(manifest.icons || []).some((i) => /maskable/.test(i.purpose || ''))) {
    problems.push('nel manifest manca un\'icona con purpose maskable');
  }
  const startFile = path.resolve(ROOT, (manifest.start_url || '').split(/[?#]/)[0]);
  if (!exists(startFile)) problems.push(`start_url non esiste: ${manifest.start_url}`);
  for (const s of manifest.shortcuts || []) {
    const target = path.resolve(ROOT, (s.url || '').split(/[?#]/)[0]);
    if (!exists(target)) problems.push(`la scorciatoia "${s.name}" punta a un file che non esiste: ${s.url}`);
  }
  return { info: `${icons.length} icone, ${(manifest.shortcuts || []).length} scorciatoie`, problems };
});

// d. CDN
check('d', 'Nessuna richiesta a CDN non ammesse', () => {
  const problems = [];
  const cdnHost =
    /(?:https?:)?\/\/((?:[\w-]+\.)*(?:cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|ajax\.googleapis\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|code\.jquery\.com|[\w-]*bootstrapcdn\.com|esm\.sh|esm\.run|cdn\.skypack\.dev|cdn\.tailwindcss\.com|[\w-]*fontawesome\.com|polyfill\.io|cdn\.[\w.-]+|[\w-]+\.cdn\.[\w.-]+))/gi;
  const allowedJsdelivr = path.join(ROOT, 'js', 'config.js');
  for (const file of sourceFiles) {
    let text = read(file);
    // La Content-Security-Policy di index.html nomina i domini ammessi: non è una richiesta.
    if (file === indexPath) text = text.replace(/<meta[^>]*Content-Security-Policy[^>]*>/gi, '');
    for (const m of text.matchAll(cdnHost)) {
      const host = m[1].toLowerCase();
      if (host === 'cdn.jsdelivr.net' && file === allowedJsdelivr) continue;
      problems.push(`${rel(file)}:${lineOf(text, m.index)} usa ${host}`);
    }
    if (file.endsWith('.css')) {
      for (const m of text.matchAll(/@import\s+(?:url\()?\s*['"]?(https?:)?\/\/[^'")\s]+/gi)) {
        problems.push(`${rel(file)}:${lineOf(text, m.index)} importa uno stile remoto`);
      }
    }
  }
  if (exists(indexPath)) {
    const html = read(indexPath);
    for (const m of html.matchAll(/<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)\s*=\s*["'](https?:)?\/\/[^"']+/gi)) {
      problems.push(`index.html:${lineOf(html, m.index)} carica una risorsa remota: ${m[0].replace(/\s+/g, ' ').slice(0, 80)}`);
    }
  }
  return { info: `${sourceFiles.length} file controllati`, problems };
});

// e. emoji
const EMOJI = new RegExp(
  [
    '[\\u{1F000}-\\u{1FAFF}]', // pittogrammi, trasporti, bandiere, simboli supplementari
    '[\\u{2600}-\\u{27BF}]', // simboli vari e dingbat
    '[\\u{2B05}-\\u{2B07}\\u{2B1B}\\u{2B1C}\\u{2B50}\\u{2B55}]',
    '[\\u{231A}\\u{231B}\\u{2328}\\u{23CF}\\u{23E9}-\\u{23F3}\\u{23F8}-\\u{23FA}]',
    '[\\u{25AA}\\u{25AB}\\u{25B6}\\u{25C0}\\u{25FB}-\\u{25FE}]',
    '[\\u{2934}\\u{2935}\\u{3030}\\u{303D}\\u{3297}\\u{3299}]',
    '[\\u{FE0F}\\u{20E3}]' // selettore emoji e tasto con riquadro
  ].join('|'),
  'gu'
);

check('e', 'Nessuna emoji (le icone sono SVG)', () => {
  const problems = [];
  for (const file of sourceFiles) {
    const text = read(file);
    for (const m of text.matchAll(EMOJI)) {
      const cp = m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
      problems.push(`${rel(file)}:${lineOf(text, m.index)} contiene U+${cp}`);
    }
  }
  return { info: `${sourceFiles.length} file controllati`, problems };
});

// f. risorse locali di index.html
check('f', 'Risorse locali di index.html', () => {
  if (!exists(indexPath)) return { problems: ['manca index.html'] };
  const html = read(indexPath);
  const refs = [];
  for (const tag of html.matchAll(/<(link|script|img)\b([^>]*)>/gi)) {
    const attrs = tag[2];
    const kind = tag[1].toLowerCase();
    const url = (attrs.match(/\b(?:href|src)\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!url || /^(?:[a-z][a-z0-9+.-]*:|\/\/|data:|#)/i.test(url)) continue; // remote: lo guarda il controllo d
    if (kind === 'link' && !/\brel\s*=\s*["'](?:stylesheet|manifest|icon|apple-touch-icon)["']/i.test(attrs)) continue;
    refs.push({ url, line: lineOf(html, tag.index) });
  }
  const problems = refs
    .filter((r) => !exists(path.resolve(ROOT, r.url.split(/[?#]/)[0])))
    .map((r) => `index.html:${r.line} punta a ${r.url}, che non esiste`);
  return { info: `${refs.length} riferimenti`, problems };
});

// g. versione
check('g', 'Versione coerente', () => {
  const problems = [];
  const versions = {};
  versions['package.json'] = JSON.parse(read(path.join(ROOT, 'package.json'))).version;
  const config = path.join(ROOT, 'js', 'config.js');
  if (exists(config)) versions['js/config.js'] = (read(config).match(/\bversion:\s*'([^']+)'/) || [])[1];
  versions['sw.js'] = (read(path.join(ROOT, 'sw.js')).match(/const VERSION = '([^']+)'/) || [])[1];
  for (const [file, v] of Object.entries(versions)) if (!v) problems.push(`non trovo la versione in ${file}`);
  if (new Set(Object.values(versions)).size > 1) {
    problems.push(`versioni diverse: ${Object.entries(versions).map(([f, v]) => `${f} ${v}`).join(', ')}`);
  }
  return { info: Object.entries(versions).map(([f, v]) => `${f} ${v}`).join(', '), problems };
});

// h. ogni modulo di js/ è nel precache (altrimenti il primo avvio senza rete non lo trova)
check('h', 'Moduli di js/ presenti nel precache', () => {
  const sw = read(path.join(ROOT, 'sw.js'));
  const block = sw.match(/const PRECACHE = \[([\s\S]*?)\];/);
  if (!block) return { problems: ['non trovo l\'elenco PRECACHE in sw.js'] };
  const listed = new Set([...block[1].matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]));
  const problems = jsFiles
    .map(rel)
    .filter((f) => !listed.has(f))
    .map((f) => `${f} non è nel precache di sw.js`);
  return { info: `${jsFiles.length} moduli`, problems };
});

// Riepilogo
let failed = 0;
console.log('Controlli statici di Fishing Intelligence\n');
for (const r of results) {
  const state = r.problems.length === 0 ? 'ok     ' : 'ERRORE ';
  console.log(`[${state}] ${r.id}) ${r.title}${r.info ? ` (${r.info})` : ''}`);
  for (const p of r.problems) console.log(`           - ${p}`);
  if (r.problems.length) failed += 1;
}
const totalProblems = results.reduce((n, r) => n + r.problems.length, 0);
console.log(
  failed === 0
    ? `\nTutto in ordine: ${results.length} controlli superati.`
    : `\n${failed} controlli su ${results.length} non superati, ${totalProblems} problemi in tutto.`
);
process.exitCode = failed === 0 ? 0 : 1;
