// 内置复核场景：页面一键载入，测试与 HTTP 冒烟共用同一事实来源。

export const SCENARIOS = {
  rup_unsat: {
    id: 'rup_unsat',
    title: '① RUP 冲突链 → UNSAT（互斥阀位 + 故障隔离）',
    description:
      '步骤1 反设阀位许可为假：C1 单位传播出点火许可 2，与 C2 冲突；加入单位 1 后，C3/C4 单位传播出互补隔离信号 3 与 -3，空矛盾成立。',
    cnf: `c 推进器联锁约束（受限 DIMACS）
c  1: 阀位许可   2: 点火许可   3: 故障隔离
p cnf 3 4
1 2 0
1 -2 0
-1 3 0
-1 -3 0
`,
    drat: `c 步骤1：反设 -1，C1 传播出 2，与 C2 冲突
1 0
c 最终矛盾：单位 1 迫使 C3 出 3、C4 出 -3
0
`,
    expect: { verdict: 'UNSAT' },
  },
  rat_vacuous: {
    id: 'rat_vacuous',
    title: '② 无反向文字子句的 RAT（枢轴条件空成立）',
    description:
      '活动集中没有任何子句包含枢轴的否定，RAT 对零个反向子句空成立；回放结束但无空矛盾，裁决 INCOMPLETE。',
    cnf: `p cnf 2 1
1 0
`,
    drat: `2 0
`,
    expect: { verdict: 'INCOMPLETE', firstRule: 'RAT', oppositeCount: 0 },
  },
  delete_then_empty_fail: {
    id: 'delete_then_empty_fail',
    title: '③ 删除全部依据后空矛盾失败',
    description:
      '四条删除记录立即生效，随后添加空子句时活动集已空，单位传播无冲突，裁决首个失败步骤。',
    cnf: `p cnf 2 4
1 2 0
-1 2 0
1 -2 0
-1 -2 0
`,
    drat: `d 1 2 0
d -1 2 0
d 1 -2 0
d -1 -2 0
0
`,
    expect: { verdict: 'FAILED_STEP', code: 'EMPTY_CLAUSE_UNJUSTIFIED' },
  },
  mixed_illegal: {
    id: 'mixed_illegal',
    title: '④ 混合非法输入（合并定位，不出旧结论）',
    description:
      '越界、重复文字、互补文字、截断、结束符后多余记号散布在 CNF 与 DRAT 中，须一次性全部定位。',
    cnf: `p cnf 2 4
1 2 0
3 0
1 1 0
2 -2 0
-1 2`,
    drat: `9 0
1 1 0
1 0 2
d 3`,
    expect: {
      verdict: 'INPUT_ERROR',
      codes: [
        'VARIABLE_OUT_OF_RANGE',
        'DUPLICATE_LITERAL',
        'COMPLEMENTARY_LITERALS',
        'TRUNCATED_CLAUSE',
        'TOKENS_AFTER_TERMINATOR',
        'TRUNCATED_RECORD',
      ],
    },
  },
  ghost_delete: {
    id: 'ghost_delete',
    title: '⑤ 重复删除（已删子句不得继续作为目标）',
    description: '同一子句删除两次，第二次为无目标删除并指出此前删除痕迹。',
    cnf: `p cnf 1 1
1 0
`,
    drat: `d 1 0
d 1 0
`,
    expect: { verdict: 'FAILED_STEP', code: 'DELETION_NO_TARGET' },
  },
};

export function listScenarios() {
  return Object.values(SCENARIOS).map((s) => ({
    id: s.id,
    title: s.title,
    description: s.description,
  }));
}

export function getScenario(id) {
  return SCENARIOS[id] ?? null;
}
