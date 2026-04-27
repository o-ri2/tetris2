import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 5500);
const ROOT = __dirname;
const SAVE_DIR = path.join(ROOT, 'save_png');

function contentTypeByExt(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.json') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, { ...headers });
  res.end(body);
}

async function ensureSaveDir() {
  await fsp.mkdir(SAVE_DIR, { recursive: true });
}

function safeFilename(name) {
  const base = String(name || '').trim();
  if (!base) return null;
  // 폴더 탈출 방지: 경로 구분자 제거 + 간단 허용문자만
  const cleaned = base
    .replaceAll('\\', '_')
    .replaceAll('/', '_')
    .replaceAll('\0', '')
    .replace(/[^\w.\-()+@ ]+/g, '_')
    .slice(0, 160);
  if (!cleaned.toLowerCase().endsWith('.png')) return `${cleaned}.png`;
  return cleaned;
}

async function handleSavePng(req, res) {
  await ensureSaveDir();

  const filenameHeader = req.headers['x-filename'];
  const filename = safeFilename(filenameHeader) || `stack_${Date.now()}.png`;

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    chunks.push(chunk);
    total += chunk.length;
    // 과도한 업로드 방지(대략 50MB)
    if (total > 50 * 1024 * 1024) {
      return send(res, 413, 'payload too large');
    }
  }

  const buf = Buffer.concat(chunks);
  if (buf.length < 8) return send(res, 400, 'invalid png');

  const outPath = path.join(SAVE_DIR, filename);
  await fsp.writeFile(outPath, buf);

  const payload = JSON.stringify({
    ok: true,
    filename,
    savedTo: path.relative(ROOT, outPath)
  });
  return send(res, 200, payload, { 'Content-Type': 'application/json; charset=utf-8' });
}

async function handleList(req, res) {
  await ensureSaveDir();
  const names = await fsp.readdir(SAVE_DIR);
  const payload = JSON.stringify({ ok: true, files: names.sort() });
  return send(res, 200, payload, { 'Content-Type': 'application/json; charset=utf-8' });
}

function sanitizePath(urlPath) {
  const raw = decodeURIComponent(urlPath.split('?')[0] || '/');
  const normalized = path.posix.normalize(raw);
  if (normalized.includes('..')) return null;
  return normalized;
}

async function serveStatic(req, res) {
  const urlPath = sanitizePath(req.url || '/');
  if (!urlPath) return send(res, 400, 'bad request');

  let rel = urlPath === '/' ? '/capture.html' : urlPath;
  const fsPath = path.join(ROOT, rel);

  try {
    const st = await fsp.stat(fsPath);
    if (!st.isFile()) return send(res, 404, 'not found');
    const data = await fsp.readFile(fsPath);
    return send(res, 200, data, { 'Content-Type': contentTypeByExt(fsPath) });
  } catch {
    return send(res, 404, 'not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url && req.url.startsWith('/api/save-png')) {
      return await handleSavePng(req, res);
    }
    if (req.method === 'GET' && req.url && req.url.startsWith('/api/list')) {
      return await handleList(req, res);
    }
    return await serveStatic(req, res);
  } catch (e) {
    return send(res, 500, String(e?.message || e || 'server error'));
  }
});

server.listen(PORT, () => {
  console.log(`capture server: http://localhost:${PORT}`);
  console.log(`saving to: ${SAVE_DIR}`);
});

