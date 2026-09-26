// 验收场景单一数据源：页面示例、单元测试与 HTTP 冒烟共同引用。
export const SCENARIOS = [
  {
    id: 'rup',
    title: 'RUP 冲突链（裁决不可满足）',
    cnf: [
      'c 互斥阀位 / 点火许可 / 故障隔离约束',
      'p cnf 2 3',
      '1 2 0',
      '-1 2 0',
      '-2 0',
    ].join('\n'),
    drat: ['-1 0', '0'].join('\n'),
    expect: { status: 'unsat' },
  },
  {
    id: 'rat',
    title: '无反向文字子句的 RAT（空悬成立）',
    cnf: ['p cnf 2 1', '1 0'].join('\n'),
    drat: ['2 0'].join('\n'),
    expect: { status: 'incomplete' },
  },
  {
    id: 'del',
    title: '删除后空子句失败',
    cnf: ['p cnf 2 3', '1 2 0', '-1 2 0', '-2 0'].join('\n'),
    drat: ['d 1 2 0', '0'].join('\n'),
    expect: { status: 'step_failed', failedStep: 2 },
  },
  {
    id: 'bad',
    title: '混合非法输入（合并定位）',
    cnf: ['p cnf 3 4', '1 1 0', '2 -2 0', '5 0', '3'].join('\n'),
    drat: ['1 2 x 0', '0', 'd 7 8 0', '1 0'].join('\n'),
    expect: {
      status: 'invalid_input',
      kinds: [
        'duplicate_literal',
        'complementary_literal',
        'out_of_bounds',
        'truncated',
        'clause_count_mismatch',
        'bad_token',
        'empty_clause',
        'delete_without_target',
      ],
    },
  },
];
