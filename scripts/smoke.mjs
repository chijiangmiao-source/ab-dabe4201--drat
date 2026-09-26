// HTTP 冒烟验收：健康路径 + 四个证明场景（RUP 冲突链 / 空悬 RAT / 删除后空子句失败 / 混合非法输入）。
// 用法：node scripts/smoke.mjs            —— 自动拉起本地服务（随机端口环境变量 SMOKE_PORT，默认 8123）
//       SMOKE_BASE_URL=http://web:8080 node scripts/smoke.mjs —— 直接打已运行的服务（Compose 验收）
import { spawn } from 'node:child_process';
import { SCENARIOS } from './scenarios.mjs';

const failures = [];
let serverProc = null;
let base = process.env.SMOKE_BASE_URL || null;

if (!base) {
  const port = Number(process.env.SMOKE_PORT || 8123);
  serverProc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  serverProc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  process.on('exit', () => serverProc && serverProc.kill());
  base = `http://127.0.0.1:${port}`;
}

function check(name, cond, detail = '') {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    console.error(`FAIL ${name}${detail ? ` —— ${detail}` : ''}`);
    failures.push(name);
  }
}

async function waitForHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.status === 200) return true;
    } catch { /* 尚未就绪 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function postVerify(body) {
  const r = await fetch(`${base}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function main() {
  console.log(`[smoke] 目标服务: ${base}`);

  check('health:就绪', await waitForHealth(), '服务在 15s 内未就绪');

  const health = await fetch(`${base}/health`).then((r) => r.json());
  check('health:status=ok', health.status === 'ok', JSON.stringify(health));

  const home = await fetch(`${base}/`);
  const homeText = await home.text();
  check('static:首页可访问', home.status === 200 && homeText.includes('审查台'), `HTTP ${home.status}`);

  const byId = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));

  // 场景 1：RUP 冲突链 → 裁决不可满足
  {
    const j = await postVerify(byId.rup);
    check('scenario:rup 状态为 unsat', j.status === 'unsat', `实际 ${j.status}`);
    const s1 = j.steps?.[0];
    const last = j.steps?.[j.steps.length - 1];
    check(
      'scenario:rup 冲突子句编号链',
      s1?.rule === 'RUP' && Array.isArray(s1.rup.chain) && s1.rup.chain.length > 0 &&
        typeof s1.rup.conflict === 'number',
      JSON.stringify(s1?.rup ?? null),
    );
    check('scenario:rup 末步为空子句', Array.isArray(last?.clause) && last.clause.length === 0);
  }

  // 场景 2：无反向文字子句的 RAT（空悬成立）
  {
    const j = await postVerify(byId.rat);
    const s = j.steps?.[0];
    check('scenario:rat 状态为 incomplete', j.status === 'incomplete', `实际 ${j.status}`);
    check(
      'scenario:rat 空悬 RAT',
      s?.rule === 'RAT' && s.rat?.vacuous === true && s.rat?.checks?.length === 0,
      JSON.stringify(s?.rat ?? null),
    );
  }

  // 场景 3：删除后空子句失败 → 首个失败步骤 + 当时有效约束摘要
  {
    const j = await postVerify(byId.del);
    check('scenario:del 状态为 step_failed', j.status === 'step_failed', `实际 ${j.status}`);
    check(
      'scenario:del 失败步骤与摘要',
      j.failedStep === 2 && j.steps?.[0]?.rule === 'DELETE' &&
        j.summary?.activeCount === 2 && j.summary?.deletedCount === 1,
      `failedStep=${j.failedStep} active=${j.summary?.activeCount}`,
    );
  }

  // 场景 4：混合非法输入 → 合并定位全部错误类别
  {
    const j = await postVerify(byId.bad);
    check('scenario:bad 状态为 invalid_input', j.status === 'invalid_input', `实际 ${j.status}`);
    const kinds = new Set((j.errors || []).map((e) => e.kind));
    const missing = byId.bad.expect.kinds.filter((k) => !kinds.has(k));
    check('scenario:bad 错误类别合并定位', missing.length === 0, `缺少 ${missing.join(',')}`);
    check('scenario:bad 不带结论', !('steps' in j), '非法输入不应携带逐步结论');
  }

  if (serverProc) serverProc.kill();
  if (failures.length > 0) {
    console.error(`\n[smoke] ${failures.length} 项检查失败`);
    process.exit(1);
  }
  console.log('\n[smoke] 全部 HTTP 冒烟检查通过');
  process.exit(0);
}

main().catch((err) => {
  if (serverProc) serverProc.kill();
  console.error('[smoke] 执行异常:', err);
  process.exit(1);
});
