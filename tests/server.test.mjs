// HTTP 层测试：健康路径、复核 API、示例 API。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { SCENARIOS } from '../scripts/scenarios.mjs';

async function withServer(fn) {
  const server = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

test('健康路径 /health 可访问', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/health`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.status, 'ok');
  });
});

test('复核 API：RUP 场景返回不可满足裁决', async () => {
  await withServer(async (base) => {
    const s = SCENARIOS.find((x) => x.id === 'rup');
    const r = await fetch(`${base}/api/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cnf: s.cnf, drat: s.drat }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.status, 'unsat');
    assert.equal(j.steps[0].rule, 'RUP');
  });
});

test('复核 API：非法 JSON 请求体返回 400', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/api/verify`, { method: 'POST', body: 'not-json' });
    assert.equal(r.status, 400);
  });
});

test('示例 API 提供四个验收场景', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/api/examples`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.examples.length, 4);
    assert.deepEqual(j.examples.map((e) => e.id), ['rup', 'rat', 'del', 'bad']);
  });
});
