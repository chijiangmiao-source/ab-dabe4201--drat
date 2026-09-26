// HTTP 冒烟：启动生产服务，逐个打内置证明场景与额外边界载荷，
// 校验健康路径、RUP 冲突链、空反向 RAT、删除后空矛盾失败、混合非法输入。
// 任一断言失败即以非零退出码结束（供 compose verify 服务裁决）。
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { SCENARIOS } from '../lib/scenarios.js';

const BASE = process.env.SMOKE_BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8099}`;
let failures = 0;

function ok(cond, msg) {
  if (cond) {
    console.log(`  PASS  ${msg}`);
  } else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}

async function req(method, path, body) {
  const res = await fetch(new URL(path, BASE), {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function waitHealthy(proc, deadlineMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (proc && proc.exitCode != null) throw new Error(`server exited early (${proc.exitCode})`);
    try {
      const r = await req('GET', '/healthz');
      if (r.status === 200 && r.json.status === 'ok') return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not become healthy in time');
}

async function main() {
  const useExternal = Boolean(process.env.SMOKE_BASE);
  let proc = null;
  if (!useExternal) {
    proc = spawn(process.execPath, ['server.js'], {
      env: { ...process.env, PORT: String(process.env.PORT ?? 8099), HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
    proc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  }

  try {
    await waitHealthy(proc);

    console.log('[smoke] 健康路径与首页');
    let r = await req('GET', '/healthz');
    ok(r.status === 200 && r.json.status === 'ok', 'GET /healthz 返回 200 ok');

    const indexRes = await fetch(new URL('/', BASE));
    const indexHtml = await indexRes.text();
    ok(indexRes.status === 200 && indexHtml.includes('DRAT'), 'GET / 返回复核页面');

    console.log('[smoke] 场景① RUP 冲突链 → UNSAT');
    r = await req('POST', '/api/review', { cnf: SCENARIOS.rup_unsat.cnf, drat: SCENARIOS.rup_unsat.drat });
    const s1 = r.json;
    ok(s1.verdict === 'UNSAT', '裁决 UNSAT');
    const rupSteps = s1.steps.filter((x) => x.rule === 'RUP');
    ok(rupSteps.length === 2, `共 2 个 RUP 步骤（实际 ${rupSteps.length}）`);
    const first = s1.steps[0];
    ok(
      first.chain?.length >= 2 && first.chain.some((c) => c.role === 'conflict'),
      '首个 RUP 步骤给出冲突子句编号链且含冲突子句'
    );
    const emptyStep = s1.steps.at(-1);
    ok(emptyStep.lits.length === 0 && emptyStep.chain.some((c) => c.id === 'A1'), '空矛盾步骤链使用了先前添加的单位子句 A1');
    ok(s1.finalActive.some((c) => c.lits.length === 0), '最终活动集包含空子句');

    console.log('[smoke] 场景② 无反向文字子句的 RAT');
    r = await req('POST', '/api/review', { cnf: SCENARIOS.rat_vacuous.cnf, drat: SCENARIOS.rat_vacuous.drat });
    const s2 = r.json;
    ok(s2.verdict === 'INCOMPLETE', '无空矛盾时裁决 INCOMPLETE 而非 UNSAT');
    ok(s2.steps[0].rule === 'RAT', '添加以 RAT 成立');
    ok(s2.steps[0].oppositeCount === 0, '反向文字子句数量为 0（空成立）');

    console.log('[smoke] 场景②b 存在反向子句但消解为重言式的 RAT');
    r = await req('POST', '/api/review', {
      cnf: 'p cnf 3 1\n-1 2 3 0\n',
      drat: '1 -2 0\n',
    });
    const s2b = r.json;
    ok(s2b.verdict === 'INCOMPLETE', '回放成立但无空矛盾 → INCOMPLETE');
    ok(s2b.steps[0].rule === 'RAT', '以 RAT 成立（RUP 不成立时）');
    ok(s2b.steps[0].oppositeCount === 1, '核对到 1 个含反向文字的活动子句');
    ok(s2b.steps[0].ratChecks[0].tautology === true, '该反向子句与新子句的消解式是重言式');

    console.log('[smoke] 场景③ 删除全部依据后空矛盾失败');
    r = await req('POST', '/api/review', {
      cnf: SCENARIOS.delete_then_empty_fail.cnf,
      drat: SCENARIOS.delete_then_empty_fail.drat,
    });
    const s3 = r.json;
    ok(s3.verdict === 'FAILED_STEP', '裁决 FAILED_STEP');
    ok(s3.failedStep === 5, `首个失败步骤为第 5 条（实际 ${s3.failedStep}）`);
    ok(s3.code === 'EMPTY_CLAUSE_UNJUSTIFIED', '失败码 EMPTY_CLAUSE_UNJUSTIFIED');
    ok(Array.isArray(s3.activeAtFailure) && s3.activeAtFailure.length === 0, '失败时活动约束摘要为空（删除已立即生效）');

    console.log('[smoke] 场景④ 混合非法输入合并定位');
    r = await req('POST', '/api/review', {
      cnf: SCENARIOS.mixed_illegal.cnf,
      drat: SCENARIOS.mixed_illegal.drat,
    });
    const s4 = r.json;
    ok(s4.verdict === 'INPUT_ERROR', '裁决 INPUT_ERROR，不回放、不出 UNSAT');
    const codes = new Set(s4.inputErrors.map((e) => e.code));
    for (const want of SCENARIOS.mixed_illegal.expect.codes) {
      ok(codes.has(want), `定位到 ${want}`);
    }
    const trunc = s4.inputErrors.find((e) => e.code === 'TRUNCATED_RECORD');
    ok(trunc && trunc.locations[0]?.line === 4, '截断记录定位到 DRAT 第 4 行（d 3 缺少 0）');
    ok(s4.inputErrors.length >= 7, `多处问题合并报告（实际 ${s4.inputErrors.length} 处）`);

    console.log('[smoke] 场景⑤ 无目标/重复删除');
    r = await req('POST', '/api/review', { cnf: SCENARIOS.ghost_delete.cnf, drat: SCENARIOS.ghost_delete.drat });
    const s5 = r.json;
    ok(s5.verdict === 'FAILED_STEP' && s5.code === 'DELETION_NO_TARGET', '重复删除判为无目标删除');
    ok((s5.previouslyDeleted ?? []).length === 1, '指出目标此前已删除的子句编号');

    console.log('[smoke] 额外：空请求体被拒绝');
    r = await req('POST', '/api/review', { cnf: '', drat: '' });
    ok(r.status === 400, '空载荷返回 400');
  } finally {
    if (proc) {
      proc.kill('SIGTERM');
      await once(proc, 'exit').catch(() => {});
    }
  }

  if (failures > 0) {
    console.error(`[smoke] ${failures} 项断言失败`);
    process.exit(1);
  }
  console.log('[smoke] 全部 HTTP 冒烟断言通过');
}

main().catch((err) => {
  console.error('[smoke] 致命错误:', err);
  process.exit(1);
});
