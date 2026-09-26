// 深空推进器联锁规程 —— DRAT 不可满足证明复核核心。
// 纯函数、零依赖：解析受限 DIMACS CNF 与按序 DRAT 加/删记录，
// 以随步骤变化的活动子句集为依据逐步复核 RUP / RAT / 删除。

const TOKEN_RE = /^[+-]?\d+$/;

/**
 * 复核入口。
 * @param {string} cnfText 受限 DIMACS CNF（必须含 p cnf 头部）
 * @param {string} dratText 按序 DRAT 记录（每行一条：[d] 文字… 0）
 * @returns 复核结果（status: unsat | incomplete | step_failed | invalid_input）
 */
export function verifyProof(cnfText, dratText) {
  const errors = [];
  const cnf = parseCnf(String(cnfText ?? ''), errors);
  const { steps } = parseDrat(String(dratText ?? ''), errors, cnf.nvars);
  structuralCheck(cnf, steps, errors);

  if (errors.length > 0) {
    const order = { cnf: 0, drat: 1 };
    errors.sort((a, b) => order[a.source] - order[b.source] || a.line - b.line);
    // 非法输入：只返回合并定位后的错误清单，不携带任何结论。
    return { status: 'invalid_input', errors };
  }
  return runVerification(cnf, steps);
}

/* ---------------- 受限 DIMACS CNF 解析 ---------------- */

function parseCnf(text, errors) {
  const push = (line, kind, message) => errors.push({ source: 'cnf', line, kind, message });
  const lines = text.split(/\r?\n/);
  let nvars = null;
  let nclauses = null;
  let headerSeen = false;
  let headerErrPushed = false;
  const clauses = [];
  let pending = [];
  let pendingLine = 0;
  let lastContentLine = 0;

  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    const t = raw.trim();
    if (t === '' || t.startsWith('c')) return;
    if (t.startsWith('p')) {
      if (headerSeen) {
        push(lineNo, 'bad_header', '重复的 p cnf 头部');
        return;
      }
      const m = t.match(/^p\s+cnf\s+(\d+)\s+(\d+)$/);
      if (!m) {
        push(lineNo, 'bad_header', '头部格式非法，应为：p cnf <变量数> <子句数>');
      } else {
        nvars = Number(m[1]);
        nclauses = Number(m[2]);
      }
      headerSeen = true;
      lastContentLine = lineNo;
      return;
    }
    if (!headerSeen && !headerErrPushed) {
      push(lineNo, 'missing_header', '缺少 p cnf 头部（受限 DIMACS 必须声明变量数与子句数）');
      headerErrPushed = true;
    }
    for (const tok of t.split(/\s+/)) {
      if (!TOKEN_RE.test(tok)) {
        push(lineNo, 'bad_token', `非法记号 "${tok}"：文字须为非零整数，变量须为正整数`);
        continue;
      }
      const lit = Number.parseInt(tok, 10);
      if (lit === 0) {
        finalizeCnfClause(clauses, pending, pendingLine, push);
        pending = [];
      } else {
        if (pending.length === 0) pendingLine = lineNo;
        if (nvars !== null && Math.abs(lit) > nvars) {
          push(lineNo, 'out_of_bounds', `文字 ${lit} 越界：变量须在 1..${nvars} 之内`);
        }
        pending.push(lit);
      }
    }
    lastContentLine = lineNo;
  });

  if (!headerSeen && !headerErrPushed) {
    push(1, 'missing_header', '缺少 p cnf 头部（受限 DIMACS 必须声明变量数与子句数）');
  }
  if (pending.length > 0) {
    push(lastContentLine || 1, 'truncated', `子句截断：始于第 ${pendingLine} 行的子句缺少结尾 0`);
  }
  if (headerSeen && nclauses !== null && clauses.length !== nclauses) {
    push(lastContentLine || 1, 'clause_count_mismatch', `实际子句数 ${clauses.length} 与头部声明的 ${nclauses} 不符`);
  }
  return { nvars, nclauses, clauses };
}

function finalizeCnfClause(clauses, lits, line, push) {
  if (lits.length === 0) {
    push(line, 'empty_clause', '空子句仅可作为最终矛盾（初始约束中不允许出现空子句）');
    return;
  }
  checkLiteralSanity(lits, line, push);
  clauses.push({ line, lits: [...lits] });
}

/** 重复文字与互补文字检查（同一子句内）。 */
function checkLiteralSanity(lits, line, push) {
  const seen = new Set();
  const dupReported = new Set();
  const compReported = new Set();
  for (const lit of lits) {
    if (seen.has(lit) && !dupReported.has(lit)) {
      push(line, 'duplicate_literal', `重复文字：${lit}`);
      dupReported.add(lit);
    }
    if (seen.has(-lit) && !compReported.has(Math.abs(lit))) {
      push(line, 'complementary_literal', `互补文字：${lit} 与 ${-lit} 同时出现`);
      compReported.add(Math.abs(lit));
    }
    seen.add(lit);
  }
}

/* ---------------- DRAT 记录解析（按行、按序） ---------------- */

function parseDrat(text, errors, nvars) {
  const push = (line, kind, message) => errors.push({ source: 'drat', line, kind, message });
  const steps = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    const t = raw.trim();
    if (t === '' || t.startsWith('c')) return;
    const tokens = t.split(/\s+/);
    let del = false;
    let i = 0;
    if (tokens[0] === 'd') {
      del = true;
      i = 1;
    }
    const lits = [];
    let terminated = false;
    let extra = false;
    for (; i < tokens.length; i++) {
      const tok = tokens[i];
      if (terminated) {
        extra = true;
        break;
      }
      if (!TOKEN_RE.test(tok)) {
        push(lineNo, 'bad_token', `非法记号 "${tok}"：文字须为非零整数，变量须为正整数`);
        continue;
      }
      const lit = Number.parseInt(tok, 10);
      if (lit === 0) {
        terminated = true;
        continue;
      }
      if (nvars !== null && Math.abs(lit) > nvars) {
        push(lineNo, 'out_of_bounds', `文字 ${lit} 越界：变量须在 1..${nvars} 之内`);
      }
      lits.push(lit);
    }
    if (extra) push(lineNo, 'tokens_after_zero', '结束符 0 之后存在多余记号');
    if (!terminated) push(lineNo, 'truncated', '记录截断：缺少结尾 0');
    checkLiteralSanity(lits, lineNo, push);
    const empty = lits.length === 0;
    if (empty && del) {
      push(lineNo, 'empty_clause', '空子句仅可作为最终矛盾（不能作为删除目标）');
    }
    steps.push({ line: lineNo, del, lits, empty });
  });

  // 空子句仅可作为最终矛盾：新增空子句必须是最后一步。
  steps.forEach((s, i) => {
    if (s.empty && !s.del && i !== steps.length - 1) {
      push(s.line, 'empty_clause', '空子句仅可作为最终矛盾（空子句新增必须是最后一步）');
    }
  });
  return { steps };
}

/* -------- 结构性预检：无目标删除（与语法错误合并定位） -------- */

function structuralCheck(cnf, steps, errors) {
  const counts = new Map();
  const bump = (k, d) => counts.set(k, (counts.get(k) || 0) + d);
  for (const c of cnf.clauses) bump(keyOf(c.lits), 1);
  for (const s of steps) {
    const k = keyOf(s.lits);
    if (s.del) {
      if (s.empty) continue; // 已在解析期标记
      if ((counts.get(k) || 0) > 0) {
        bump(k, -1);
      } else {
        errors.push({
          source: 'drat',
          line: s.line,
          kind: 'delete_without_target',
          message: `无目标删除：子句 [${s.lits.join(' ')}] 不在当前活动约束中`,
        });
      }
    } else {
      bump(k, 1);
    }
  }
}

/* ---------------- 逐步复核（活动子句集随步骤变化） ---------------- */

function runVerification(cnf, steps) {
  const active = new Map(); // id -> {id, lits}
  cnf.clauses.forEach((c, i) => active.set(i + 1, { id: i + 1, lits: c.lits }));
  let nextId = cnf.clauses.length + 1;
  let deletedCount = 0;
  let emptyDerived = false;
  const results = [];

  const finish = (status, extra = {}) => ({
    status,
    steps: results,
    summary: summarize(active, cnf.nvars, deletedCount),
    stats: { cnfClauses: cnf.clauses.length, steps: steps.length },
    ...extra,
  });

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const index = i + 1;

    if (s.del) {
      // 删除立即生效；目标存在性已由结构性预检保证。
      const target = findActive(active, s.lits);
      active.delete(target.id);
      deletedCount++;
      results.push({ index, line: s.line, type: 'delete', clause: s.lits, ok: true, rule: 'DELETE', deletedId: target.id });
      continue;
    }

    // 新增：先 RUP，失败后以首文字为指定枢轴尝试 RAT。
    const rup = rupCheck([...active.values()], s.lits);
    if (rup.ok) {
      const id = nextId++;
      active.set(id, { id, lits: s.lits });
      if (s.lits.length === 0) emptyDerived = true;
      results.push({ index, line: s.line, type: 'add', clause: s.lits, ok: true, rule: 'RUP', id, rup });
      continue;
    }

    const rat = s.lits.length > 0 ? ratCheck([...active.values()], s.lits) : null;
    if (rat && rat.ok) {
      const id = nextId++;
      active.set(id, { id, lits: s.lits });
      results.push({ index, line: s.line, type: 'add', clause: s.lits, ok: true, rule: 'RAT', id, rup, rat });
      continue;
    }

    results.push({
      index, line: s.line, type: 'add', clause: s.lits, ok: false, rule: null, rup, rat,
      reason: 'RUP 单位传播未导出冲突，且 RAT 检验未通过',
    });
    // 首个失败步骤：附当时有效约束摘要。
    return finish('step_failed', { failedStep: index });
  }

  // 只有活动集得到空子句才能裁决不可满足。
  if (emptyDerived) return finish('unsat');
  return finish('incomplete');
}

/**
 * RUP：在当前活动集上加入待证子句全部文字的否定作为假设，
 * 单位传播若导出冲突则成立。返回假设、冲突子句编号链与冲突子句号。
 */
function rupCheck(clauseArr, lits) {
  const assign = new Map(); // var -> bool（该变量被赋的真值）
  const assumptions = lits.map((l) => -l);
  for (const a of assumptions) assign.set(Math.abs(a), a > 0);
  const chain = [];

  let changed = true;
  while (changed) {
    changed = false;
    for (const c of clauseArr) {
      let satisfied = false;
      let unassigned = 0;
      let lastLit = 0;
      for (const lit of c.lits) {
        const v = Math.abs(lit);
        if (!assign.has(v)) {
          unassigned++;
          lastLit = lit;
        } else if (assign.get(v) === (lit > 0)) {
          satisfied = true;
          break;
        }
      }
      if (satisfied) continue;
      if (unassigned === 0) {
        return { ok: true, assumptions, chain, conflict: c.id };
      }
      if (unassigned === 1) {
        assign.set(Math.abs(lastLit), lastLit > 0);
        chain.push({ clauseId: c.id, forced: lastLit });
        changed = true;
      }
    }
  }
  return { ok: false, assumptions, chain, conflict: null };
}

/**
 * RAT：以首文字为指定枢轴 pivot，逐条核对当前活动集中
 * 所有含 ¬pivot 的反向文字子句：归结式必须均为 RUP（重言式平凡成立）。
 * 无反向文字子句时空悬成立。
 */
function ratCheck(clauseArr, lits) {
  const pivot = lits[0];
  const opposing = clauseArr.filter((c) => c.lits.includes(-pivot));
  const checks = [];
  let ok = true;
  for (const d of opposing) {
    const seen = new Set();
    const resolvent = [];
    for (const l of [...lits, ...d.lits]) {
      if (l === pivot || l === -pivot) continue;
      if (!seen.has(l)) {
        seen.add(l);
        resolvent.push(l);
      }
    }
    const tautological = resolvent.some((l) => seen.has(-l));
    if (tautological) {
      checks.push({ clauseId: d.id, resolvent, tautological: true, ok: true, rup: null });
      continue;
    }
    const r = rupCheck(clauseArr, resolvent);
    checks.push({ clauseId: d.id, resolvent, tautological: false, ok: r.ok, rup: r });
    if (!r.ok) ok = false;
  }
  return { ok, pivot, vacuous: opposing.length === 0, checks };
}

/* ---------------- 工具 ---------------- */

function keyOf(lits) {
  return [...lits].sort((a, b) => a - b).join(',');
}

function findActive(active, lits) {
  const k = keyOf(lits);
  for (const c of active.values()) {
    if (keyOf(c.lits) === k) return c;
  }
  return null;
}

function summarize(active, nvars, deletedCount) {
  return {
    vars: nvars,
    activeCount: active.size,
    deletedCount,
    active: [...active.values()].map((c) => ({ id: c.id, lits: c.lits })),
  };
}
