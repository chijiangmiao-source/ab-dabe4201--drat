import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCNF, parseDRAT } from '../lib/parser.js';
import { review } from '../lib/review.js';

const reviewSync = (cnf, drat) => review(cnf, drat);

test('CNF：正整数变量、跨行子句、题头计数', () => {
  const r = parseCNF('p cnf 2 2\n1 2\n0\n-1 -2 0\n');
  assert.equal(r.errors.length, 0);
  assert.deepEqual(r.clauses.map((c) => c.lits), [[1, 2], [-1, -2]]);
});

test('CNF：空子句直接出现是非法的（仅最终矛盾允许）', () => {
  const r = parseCNF('p cnf 1 1\n0\n');
  assert.ok(r.errors.some((e) => e.code === 'EMPTY_CLAUSE_FORBIDDEN'));
});

test('CNF：截断、越界、重复、互补在同一份输入中合并定位', () => {
  const text = 'p cnf 2 4\n3 0\n1 1 0\n1 -1 0\n2 0\n-1 2';
  const r = parseCNF(text);
  const codes = r.errors.map((e) => e.code);
  assert.ok(codes.includes('VARIABLE_OUT_OF_RANGE'));
  assert.ok(codes.includes('DUPLICATE_LITERAL'));
  assert.ok(codes.includes('COMPLEMENTARY_LITERALS'));
  assert.ok(codes.includes('TRUNCATED_CLAUSE'));
  // 合法子句仍被解析，错误不吞掉其他位置信息
  const trunc = r.errors.find((e) => e.code === 'TRUNCATED_CLAUSE');
  assert.equal(trunc.locs[0].line, 6);
});

test('DRAT：结束符后多余记号、删除截断、删除空目标、重复互补', () => {
  const r = parseDRAT('1 0 2\nd 3\n1 1 0\n1 -1 0\nd 0\n', 3);
  const codes = r.errors.map((e) => e.code);
  assert.ok(codes.includes('TOKENS_AFTER_TERMINATOR'));
  assert.ok(codes.includes('TRUNCATED_RECORD'));
  assert.ok(codes.includes('DELETE_EMPTY_CLAUSE'));
  assert.ok(codes.filter((c) => c === 'DUPLICATE_LITERAL').length >= 1);
  assert.ok(codes.includes('COMPLEMENTARY_LITERALS'));
});

test('DRAT：越界变量相对于题头被标记', () => {
  const r = parseDRAT('4 0\n', 3);
  assert.ok(r.errors.some((e) => e.code === 'VARIABLE_OUT_OF_RANGE'));
});

test('RUP：单位传播冲突链与 UNSAT 终局', async () => {
  const cnf = 'p cnf 3 4\n1 2 0\n1 -2 0\n-1 3 0\n-1 -3 0\n';
  const drat = '1 0\n0\n';
  const r = await review(cnf, drat);
  assert.equal(r.verdict, 'UNSAT');
  assert.equal(r.steps.length, 2);
  assert.deepEqual(r.steps[0].assumptions, [-1]);
  const chainIds = r.steps[0].chain.map((c) => c.id);
  // 冲突链必须引用 CNF 原始子句编号，且反设 -1 时由 C1 传播出 2、与 C2 冲突
  assert.ok(chainIds.some((id) => id.startsWith('C')));
  assert.ok(chainIds.includes('C1') && chainIds.includes('C2'));
  // 空矛盾步骤必须使用此前添加的单位子句 A1
  const last = r.steps[1];
  assert.deepEqual(last.lits, []);
  const lastChainIds = last.chain.map((c) => c.id);
  assert.ok(lastChainIds.includes('A1'));
});

test('RAT：无反向文字子句时空成立', async () => {
  const r = await review('p cnf 2 1\n1 0\n', '2 0\n');
  assert.equal(r.verdict, 'INCOMPLETE');
  assert.equal(r.steps[0].rule, 'RAT');
  assert.equal(r.steps[0].oppositeCount, 0);
  assert.equal(r.steps[0].ratChecks.length, 0);
});

test('RAT：反向子句消解为重言式时成立并逐子句核对', async () => {
  const r = await review('p cnf 3 1\n-1 2 3 0\n', '1 -2 0\n');
  assert.equal(r.verdict, 'INCOMPLETE');
  assert.equal(r.steps[0].rule, 'RAT');
  assert.equal(r.steps[0].oppositeCount, 1);
  assert.equal(r.steps[0].ratChecks[0].tautology, true);
  assert.deepEqual([...r.steps[0].ratChecks[0].resolvent].sort((a, b) => a - b), [-2, 2, 3]);
});

test('RAT：反向子句消解式不可达冲突时失败', async () => {
  // 新子句 (1)，反向子句 (-1 2)；消解式 (2) 在活动集上不是 RUP。
  const r = await review('p cnf 2 1\n-1 2 0\n', '1 0\n');
  assert.equal(r.verdict, 'FAILED_STEP');
  assert.equal(r.code, 'ADD_UNJUSTIFIED');
  assert.equal(r.failedStep, 1);
  assert.equal(r.ratFailure.resolvent[0], 2);
});

test('删除：立即从活动集移除，之后不得再用', async () => {
  const cnf = 'p cnf 2 4\n1 2 0\n-1 2 0\n1 -2 0\n-1 -2 0\n';
  const drat = 'd 1 2 0\nd -1 2 0\nd 1 -2 0\nd -1 -2 0\n0\n';
  const r = await review(cnf, drat);
  assert.equal(r.verdict, 'FAILED_STEP');
  assert.equal(r.code, 'EMPTY_CLAUSE_UNJUSTIFIED');
  assert.equal(r.failedStep, 5);
  assert.deepEqual(r.activeAtFailure, []);
});

test('删除：无目标删除与重复删除定位', async () => {
  const r = await review('p cnf 1 1\n1 0\n', 'd 1 0\nd 1 0\n');
  assert.equal(r.verdict, 'FAILED_STEP');
  assert.equal(r.code, 'DELETION_NO_TARGET');
  assert.equal(r.failedStep, 2);
  assert.deepEqual(r.previouslyDeleted, ['C1']);
});

test('删除：从未存在的子句是无目标删除', async () => {
  // 变量须在题头范围内（越界属于语法错误，另有测试覆盖）
  const r = await review('p cnf 1 1\n1 0\n', 'd -1 0\n');
  assert.equal(r.code, 'DELETION_NO_TARGET');
  assert.deepEqual(r.previouslyDeleted, []);
});

test('空矛盾只能作为最后一步', async () => {
  const cnf = 'p cnf 1 2\n1 0\n-1 0\n';
  const r = await review(cnf, '0\n1 0\n');
  assert.equal(r.verdict, 'FAILED_STEP');
  assert.equal(r.code, 'EMPTY_CLAUSE_NOT_FINAL');
});

test('全部步骤成立但无空矛盾 → INCOMPLETE，绝不裁决 UNSAT', async () => {
  const r = await review('p cnf 1 1\n1 0\n', '1 0\n');
  // (1) 已在活动集中：添加重复子句本身 RUP 成立（反设 -1 立即与单位冲突），
  // 但没有空矛盾。
  assert.equal(r.verdict, 'INCOMPLETE');
});

test('输入非法时不回放且不产出旧结论', async () => {
  const r = await review('p cnf 1 1\n2 0\n', '0\n');
  assert.equal(r.verdict, 'INPUT_ERROR');
  assert.ok(!('steps' in r));
});

test('长回放回调：每步汇报进度', async () => {
  const cnf = 'p cnf 1 1\n1 0\n';
  const drat = '1 0\n1 0\n1 0\n';
  const ticks = [];
  await review(cnf, drat, { yieldEvery: 1, onStep: async (p) => ticks.push(p.processed) });
  assert.deepEqual(ticks, [1, 2, 3]);
});

test('非整数记号与 -0 被拒绝', () => {
  const r = parseDRAT('x 0\n-0 0\n', 2);
  assert.ok(r.errors.length >= 2);
  assert.ok(r.errors.every((e) => e.code === 'BAD_INTEGER'));
});
