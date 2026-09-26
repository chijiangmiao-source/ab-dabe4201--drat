// 复核核心单元测试：RUP 冲突链、空悬/非空悬 RAT、删除语义、混合非法输入、边界规则。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyProof } from '../server/checker.js';
import { SCENARIOS } from '../scripts/scenarios.mjs';

const byId = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));

test('RUP 冲突链：逐步记录单位传播链，活动集导出空子句后裁决不可满足', () => {
  const r = verifyProof(byId.rup.cnf, byId.rup.drat);
  assert.equal(r.status, 'unsat');
  assert.equal(r.steps.length, 2);

  const [s1, s2] = r.steps;
  assert.equal(s1.rule, 'RUP');
  assert.equal(s1.id, 4);
  assert.deepEqual(s1.rup.assumptions, [1]);
  assert.deepEqual(s1.rup.chain, [{ clauseId: 2, forced: 2 }]);
  assert.equal(s1.rup.conflict, 3);

  assert.deepEqual(s2.clause, []);
  assert.equal(s2.rule, 'RUP');
  assert.deepEqual(s2.rup.chain, [
    { clauseId: 3, forced: -2 },
    { clauseId: 4, forced: -1 },
  ]);
  assert.equal(s2.rup.conflict, 1);
});

test('无反向文字子句的 RAT：空悬成立，但不得裁决不可满足', () => {
  const r = verifyProof(byId.rat.cnf, byId.rat.drat);
  assert.equal(r.status, 'incomplete');
  const s = r.steps[0];
  assert.equal(s.rule, 'RAT');
  assert.equal(s.rat.pivot, 2);
  assert.equal(s.rat.vacuous, true);
  assert.deepEqual(s.rat.checks, []);
  assert.equal(s.rup.ok, false); // RUP 不成立才落入 RAT
});

test('非空悬 RAT：逐条核对全部反向文字子句的归结式', () => {
  const cnf = ['p cnf 3 2', '1 2 0', '-1 2 0'].join('\n');
  const r = verifyProof(cnf, '1 3 0');
  const s = r.steps[0];
  assert.equal(s.rule, 'RAT');
  assert.equal(s.rat.vacuous, false);
  assert.equal(s.rat.checks.length, 1);
  const chk = s.rat.checks[0];
  assert.equal(chk.clauseId, 2);
  assert.deepEqual(chk.resolvent, [3, 2]);
  assert.equal(chk.ok, true);
  assert.deepEqual(chk.rup.chain, [{ clauseId: 1, forced: 1 }]);
  assert.equal(chk.rup.conflict, 2);
});

test('删除后空子句失败：报告首个失败步骤与当时有效约束摘要', () => {
  const r = verifyProof(byId.del.cnf, byId.del.drat);
  assert.equal(r.status, 'step_failed');
  assert.equal(r.failedStep, 2);
  assert.equal(r.steps[0].rule, 'DELETE');
  assert.equal(r.steps[0].deletedId, 1);
  assert.equal(r.steps[1].ok, false);
  assert.equal(r.steps[1].rule, null);
  assert.equal(r.summary.activeCount, 2);
  assert.equal(r.summary.deletedCount, 1);
  assert.deepEqual(r.summary.active.map((c) => c.id), [2, 3]);
});

test('删除立即生效：已删除子句不得继续作为后续推导依据', () => {
  const r = verifyProof(byId.del.cnf, ['d 1 2 0', '-1 0'].join('\n'));
  assert.equal(r.steps[1].rule, 'RUP');
  // 若已删除的 c1 仍可用，链中会强制出现 c1；正确链只经由 c2、c3。
  assert.deepEqual(r.steps[1].rup.chain, [{ clauseId: 2, forced: 2 }]);
  assert.equal(r.steps[1].rup.conflict, 3);
});

test('混合非法输入：重复/互补/越界/截断/无目标删除等合并定位，且不带结论', () => {
  const r = verifyProof(byId.bad.cnf, byId.bad.drat);
  assert.equal(r.status, 'invalid_input');
  assert.ok(!('steps' in r), '非法输入不得携带逐步结论');

  const kinds = new Set(r.errors.map((e) => e.kind));
  for (const k of byId.bad.expect.kinds) {
    assert.ok(kinds.has(k), `缺少错误类别 ${k}`);
  }

  const at = (kind, source) => r.errors.find((e) => e.kind === kind && e.source === source);
  assert.equal(at('duplicate_literal', 'cnf').line, 2);
  assert.equal(at('complementary_literal', 'cnf').line, 3);
  assert.equal(at('out_of_bounds', 'cnf').line, 4);
  assert.equal(at('truncated', 'cnf').line, 5);
  assert.equal(at('clause_count_mismatch', 'cnf').line, 5);
  assert.equal(at('bad_token', 'drat').line, 1);
  assert.equal(at('empty_clause', 'drat').line, 2);
  assert.equal(at('delete_without_target', 'drat').line, 3);
  assert.ok(r.errors.every((e) => e.message.length > 0));
});

test('空子句仅可作为最终矛盾：初始约束与非末尾空子句均被拒绝', () => {
  const inCnf = verifyProof(['p cnf 1 1', '0'].join('\n'), '');
  assert.equal(inCnf.status, 'invalid_input');
  assert.ok(inCnf.errors.some((e) => e.kind === 'empty_clause' && e.source === 'cnf'));

  const midProof = verifyProof(byId.rup.cnf, ['0', '-1 0'].join('\n'));
  assert.equal(midProof.status, 'invalid_input');
  assert.ok(midProof.errors.some((e) => e.kind === 'empty_clause' && e.source === 'drat'));
});

test('变量须为正整数文字且子句以零结束：非法记号与截断被拒绝', () => {
  const r = verifyProof(['p cnf 2 1', '1 x 0'].join('\n'), '1 2');
  assert.equal(r.status, 'invalid_input');
  assert.ok(r.errors.some((e) => e.kind === 'bad_token'));
  assert.ok(r.errors.some((e) => e.kind === 'truncated' && e.source === 'drat'));
});

test('受限 DIMACS 必须含合法 p cnf 头部', () => {
  assert.ok(verifyProof('1 0', '').errors.some((e) => e.kind === 'missing_header'));
  assert.ok(verifyProof('p cnf x 1\n1 0', '').errors.some((e) => e.kind === 'bad_header'));
});

test('无证明步骤时不得裁决不可满足', () => {
  const r = verifyProof(byId.rup.cnf, '');
  assert.equal(r.status, 'incomplete');
  assert.equal(r.summary.activeCount, 3);
});
