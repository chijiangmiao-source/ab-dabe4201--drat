// 生产构建：语法检查全部 ESM 源文件并装配 dist/（零打包器，浏览器原生 ESM）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');

fs.rmSync(dist, { recursive: true, force: true });

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// 1) 语法检查：服务端、库、worker、前端脚本全部必须通过解析。
const targets = ['server.js', 'lib', 'public'];
for (const t of targets) {
  const abs = path.join(root, t);
  const stat = fs.statSync(abs);
  const files = stat.isDirectory()
    ? fs.readdirSync(abs).filter((f) => f.endsWith('.js')).map((f) => path.join(abs, f))
    : [abs];
  for (const f of files) execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
}

// 2) 装配产物：public/ 置于根，lib/ 供 Web Worker 以 ./lib/*.js 引入。
copyDir(path.join(root, 'public'), dist);
copyDir(path.join(root, 'lib'), path.join(dist, 'lib'));

// 3) 版本戳，便于核对上线产物。
fs.writeFileSync(
  path.join(dist, 'build-info.json'),
  JSON.stringify({ builtAt: new Date().toISOString(), node: process.version }) + '\n'
);

console.log('[build] dist/ assembled and syntax-checked');
