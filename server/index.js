// 深空推进器联锁规程审查台 —— HTTP 服务（零依赖）。
// 路由：GET /health 健康路径；POST /api/verify 复核；GET /api/examples 验收场景；其余为 dist/ 静态资源。
import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { verifyProof } from './checker.js';
import { SCENARIOS } from '../scripts/scenarios.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist');
const MAX_BODY = 8 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function createApp() {
  return http.createServer((req, res) => {
    handler(req, res).catch(() => sendJson(res, 500, { error: 'internal error' }));
  });
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      service: 'deepspace-interlock-drat-review',
      time: new Date().toISOString(),
    });
  }

  if (url.pathname === '/api/examples' && req.method === 'GET') {
    return sendJson(res, 200, {
      examples: SCENARIOS.map(({ id, title, cnf, drat }) => ({ id, title, cnf, drat })),
    });
  }

  if (url.pathname === '/api/verify' && req.method === 'POST') {
    const body = await readBody(req, MAX_BODY);
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { status: 'error', message: '请求体须为 JSON：{cnf, drat}' });
    }
    return sendJson(res, 200, verifyProof(payload?.cnf, payload?.drat));
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  return serveStatic(url.pathname, res);
}

async function serveStatic(pathname, res) {
  const rel = (pathname === '/' ? '/index.html' : pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(DIST, rel));
  if (!file.startsWith(DIST + path.sep)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'not found', hint: '静态产物缺失时请执行 npm run build' });
  }
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || 8080);
  createApp().listen(port, () => {
    console.log(`[web] 深空推进器联锁规程审查台已启动: http://localhost:${port} (健康路径 /health)`);
  });
}
