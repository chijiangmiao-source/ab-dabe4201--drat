// 生产构建：校验前端 JS 语法，压缩 CSS/HTML，产物带内容哈希，输出至 dist/。
// 零依赖实现，保证离线 / 受限网络环境下 Docker 构建可复现。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 8);

const minifyCss = (css) =>
  css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}:;,>])\s*/g, '$1')
    .trim();

const minifyHtml = (html) =>
  html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim();

async function main() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  // 1) 前端 JS 语法校验（生产门禁），随后原样发布。
  const jsPath = path.join(SRC, 'main.js');
  execFileSync(process.execPath, ['--check', jsPath], { stdio: 'inherit' });
  const js = await readFile(jsPath, 'utf8');

  // 2) CSS 压缩。
  const css = minifyCss(await readFile(path.join(SRC, 'style.css'), 'utf8'));

  // 3) 内容哈希产物名 + HTML 引用改写与压缩。
  const jsName = `main.${hash(js)}.js`;
  const cssName = `style.${hash(css)}.css`;
  const htmlRaw = await readFile(path.join(SRC, 'index.html'), 'utf8');
  const html = minifyHtml(
    htmlRaw.replace('/style.css', `/${cssName}`).replace('/main.js', `/${jsName}`),
  );

  await writeFile(path.join(DIST, jsName), js);
  await writeFile(path.join(DIST, cssName), css);
  await writeFile(path.join(DIST, 'index.html'), html);

  console.log(`[build] dist/index.html (${html.length} B)`);
  console.log(`[build] dist/${jsName} (${js.length} B)`);
  console.log(`[build] dist/${cssName} (${css.length} B)`);
  console.log('[build] 生产构建完成');
}

main().catch((err) => {
  console.error('[build] 构建失败:', err.message);
  process.exit(1);
});
