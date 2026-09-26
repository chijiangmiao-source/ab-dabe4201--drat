// 零依赖 HTTP 服务：健康检查、复核 API、静态产物（dist/）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { review } from './lib/review.js';
import { listScenarios, getScenario } from './lib/scenarios.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, 'dist');
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(DIST, pathname));
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      'content-length': buf.length,
    });
    res.end(buf);
  });
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('payload too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return sendJson(res, 200, { status: 'ok', service: 'drat-interlock-review' });
  }

  if (req.method === 'GET' && url.pathname === '/api/scenarios') {
    return sendJson(res, 200, { scenarios: listScenarios() });
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/scenarios/')) {
    const id = url.pathname.slice('/api/scenarios/'.length);
    const s = getScenario(id);
    if (!s) return sendJson(res, 404, { error: 'unknown scenario' });
    return sendJson(res, 200, {
      id: s.id,
      title: s.title,
      description: s.description,
      cnf: s.cnf,
      drat: s.drat,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/review') {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, { error: `请求体无效：${err.message}` });
    }
    const cnfText = typeof body.cnf === 'string' ? body.cnf : '';
    const dratText = typeof body.drat === 'string' ? body.drat : '';
    if (cnfText.trim() === '' && dratText.trim() === '') {
      return sendJson(res, 400, { error: 'CNF 与 DRAT 均为空，没有可复核内容' });
    }
    try {
      const result = await review(cnfText, dratText);
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 500, { error: `复核内部错误：${err.message}` });
    }
  }

  if (req.method === 'GET') return serveStatic(req, res);

  res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('method not allowed');
});

server.listen(PORT, HOST, () => {
  console.log(`[drat-review] listening on http://${HOST}:${PORT}`);
});
