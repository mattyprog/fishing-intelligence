/**
 * Fishing Intelligence · server statico di sviluppo, senza dipendenze.
 * Uso: node server.js   (porta da PORT, default 8080; indirizzo da HOST, default 127.0.0.1)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

// Cartelle che non sono parte dell'app: non si servono mai.
const BLOCKED_DIRS = new Set(['_v1', 'tests', 'docs', 'node_modules', 'supabase']);

const BASE_HEADERS = {
  'Cache-Control': 'no-cache',
  'X-Content-Type-Options': 'nosniff'
};

function send(res, status, text, extra = {}) {
  const body = Buffer.from(`${text}\n`, 'utf-8');
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    ...extra
  });
  res.end(body);
}

/** Vero se il percorso (già dentro ROOT) punta a un file nascosto o a una cartella esclusa. */
function isBlocked(relative) {
  const parts = relative.split(/[\\/]+/).filter(Boolean);
  if (parts.some((p) => p.startsWith('.'))) return true;
  // Windows ignora maiuscole e punti o spazi finali: "_V1." è la stessa cartella di "_v1".
  const first = (parts[0] || '').replace(/[. ]+$/, '').toLowerCase();
  return BLOCKED_DIRS.has(first);
}

/** Percorso URL decodificato -> percorso assoluto dentro ROOT, oppure un codice di rifiuto. */
function resolveSafe(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return { status: 400, text: 'Richiesta non valida' };
  }
  if (decoded.includes('\0')) return { status: 400, text: 'Richiesta non valida' };
  // I due punti servono solo per unità e flussi alternativi di Windows: qui non servono mai.
  if (decoded.includes(':')) return { status: 403, text: 'Accesso negato' };

  const wanted = decoded.replace(/^\/+/, '') || 'index.html';
  const candidate = path.resolve(ROOT, wanted);
  const relative = path.relative(ROOT, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { status: 403, text: 'Accesso negato' };
  }
  if (isBlocked(relative)) return { status: 404, text: 'Non trovato' };
  return { file: candidate };
}

async function findFile(candidate) {
  let target = candidate;
  let stat = await fs.promises.stat(target);
  if (stat.isDirectory()) {
    target = path.join(target, 'index.html');
    stat = await fs.promises.stat(target);
  }
  if (!stat.isFile()) return null;
  // Percorso reale: copre i link simbolici e i nomi corti di Windows (SUPABA~1).
  const real = await fs.promises.realpath(target);
  const relative = path.relative(ROOT, real);
  if (relative.startsWith('..') || path.isAbsolute(relative) || isBlocked(relative)) return null;
  return { file: real, size: stat.size };
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Metodo non consentito', { Allow: 'GET, HEAD' });
    return;
  }

  const rawPath = (req.url || '').split(/[?#]/)[0];
  if (!rawPath.startsWith('/')) {
    send(res, 400, 'Richiesta non valida');
    return;
  }

  const resolved = resolveSafe(rawPath);
  if (!resolved.file) {
    send(res, resolved.status, resolved.text);
    return;
  }

  let found;
  try {
    found = await findFile(resolved.file);
  } catch {
    found = null;
  }
  if (!found) {
    send(res, 404, 'Non trovato');
    return;
  }

  const type = MIME[path.extname(found.file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': type, 'Content-Length': found.size });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(found.file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`La porta ${PORT} è già occupata. Prova con: PORT=8081 node server.js`);
  } else {
    console.error(`Il server non parte: ${err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Fishing Intelligence in ascolto su http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}`);
});
