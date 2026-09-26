// DRAT 逐步复核引擎。
// 不变量：任何判定都只依据“当前活动子句集”。
//  - 加子句：先在当前集上验证 RUP（反设全部文字后单位传播至冲突），
//            RUP 不成立再以首文字为枢轴验证 RAT；通过后才入集。
//  - 删子句：立即从活动集移除，后续步骤不得再使用；无活动匹配即失败。
//  - 终局：只有活动集存在空子句（且必须是最后一条记录）才裁决 UNSAT。
//
// 性能：单位传播维护“0 级单位闭包”，增量扩展（新增单位）、失效重建
// （删除后）；每次 RUP/RAT 查询在决策层上做轨迹推进并回滚，长回放不退化。

let SEQ = 0;

export class ClauseSet {
  constructor() {
    this.clauses = new Map(); // id -> clause
    this.occ = new Map(); // 文字 -> Set<id>，仅活动子句
    this.units = new Map(); // 单位文字 -> Set<id>，仅活动单位子句
    this.all = []; // 含已删除，按入集顺序
  }

  addClause(lits, origin, ref) {
    const id = origin === 'cnf' ? `C${ref}` : `A${ref}`;
    const clause = {
      id,
      lits: [...lits],
      origin, // 'cnf' | 'add'
      ref,
      deleted: false,
      seq: ++SEQ,
    };
    this.clauses.set(id, clause);
    this.all.push(clause);
    for (const lit of lits) {
      let s = this.occ.get(lit);
      if (!s) this.occ.set(lit, (s = new Set()));
      s.add(id);
    }
    if (lits.length === 1) {
      let u = this.units.get(lits[0]);
      if (!u) this.units.set(lits[0], (u = new Set()));
      u.add(id);
    }
    return clause;
  }

  deleteClause(id) {
    const c = this.clauses.get(id);
    if (!c) return null;
    for (const lit of c.lits) this.occ.get(lit)?.delete(id);
    if (c.lits.length === 1) {
      const u = this.units.get(c.lits[0]);
      u?.delete(id);
      if (u && u.size === 0) this.units.delete(c.lits[0]);
    }
    this.clauses.delete(id);
    c.deleted = true;
    return c;
  }

  /** 按规范文字集合（排序后键）在活动集中查找精确匹配，最早入集者优先。 */
  findByLits(lits) {
    const key = clauseKey(lits);
    let hit = null;
    for (const id of this.clauses.keys()) {
      const c = this.clauses.get(id);
      if (clauseKey(c.lits) === key) {
        if (!hit || c.seq < hit.seq) hit = c;
      }
    }
    return hit;
  }

  findDeletedByLits(lits) {
    const key = clauseKey(lits);
    return this.all.filter((c) => c.deleted && clauseKey(c.lits) === key);
  }

  activeList() {
    return this.all.filter((c) => !c.deleted);
  }

  hasEmpty() {
    return this.activeList().some((c) => c.lits.length === 0);
  }

  emptyClause() {
    return this.activeList().find((c) => c.lits.length === 0) ?? null;
  }
}

export function clauseKey(lits) {
  return [...lits].sort((a, b) => a - b).join(',');
}

function isTautology(lits) {
  const seen = new Set();
  for (const lit of lits) {
    if (seen.has(-lit)) return true;
    seen.add(lit);
  }
  return false;
}

function dedup(lits) {
  return [...new Set(lits)];
}

/**
 * 增量单位传播器。
 * 0 级：由活动单位子句强制的文字闭包；新增单位时增量扩展，
 *       删除子句后标记失效并在下次查询时惰性重建。
 * 决策层：RUP/RAT 反设文字压入新层，传播结束后回滚到 0 级标记。
 */
class Propagator {
  constructor(set) {
    this.set = set;
    this.dirty = true;
    this.assign = new Map(); // var -> {lit, val, reason}
    this.trail = [];
    this.queue = [];
    this.level0 = 0;
    this.level0Conflict = null; // 活动集自身的单位闭包已冲突时的冲突子句 id
  }

  invalidate() {
    this.dirty = true;
  }

  ensureBase() {
    if (!this.dirty) return;
    this.assign.clear();
    this.trail = [];
    this.queue = [];
    this.level0Conflict = null;

    for (const [lit, ids] of this.set.units) {
      const rep = ids.values().next().value;
      if (!this.enqueue(lit, { kind: 'clause', id: rep })) {
        this.level0Conflict = rep;
        break;
      }
    }
    if (!this.level0Conflict) {
      const cid = this.drain();
      if (cid) this.level0Conflict = cid;
    }
    this.level0 = this.trail.length;
    this.queue = [];
    this.dirty = false;
  }

  /** 新增活动单位子句后，增量扩展 0 级闭包（比整体重建廉价）。 */
  noteUnitAdded(lit, id) {
    if (this.dirty) return; // 下次查询时统一重建
    if (this.level0Conflict) return;
    if (!this.enqueue(lit, { kind: 'clause', id })) {
      this.level0Conflict = id;
      return;
    }
    const cid = this.drain();
    if (cid) this.level0Conflict = cid;
    this.level0 = this.trail.length;
    this.queue = [];
  }

  /** 入队一个文字；与既有赋值互补时返回 false 并给出冲突原因 id。 */
  enqueue(lit, reason) {
    const v = Math.abs(lit);
    const val = lit > 0;
    const old = this.assign.get(v);
    if (old) return old.val === val;
    const rec = { lit, val, reason };
    this.assign.set(v, rec);
    this.trail.push(rec);
    this.queue.push(rec);
    return true;
  }

  /** 传播队列直到无新单位或冲突；冲突时返回冲突子句 id。 */
  drain() {
    while (this.queue.length > 0) {
      const trueLit = this.queue.shift().lit;
      const watchers = this.set.occ.get(-trueLit);
      if (!watchers) continue;
      for (const cid of [...watchers]) {
        const c = this.set.clauses.get(cid);
        if (!c) continue;
        let unassigned = 0;
        let unitLit = 0;
        let satisfied = false;
        for (const lit of c.lits) {
          const a = this.assign.get(Math.abs(lit));
          if (!a) {
            unassigned++;
            unitLit = lit;
          } else if (a.val === (lit > 0)) {
            satisfied = true;
            break;
          }
        }
        if (satisfied) continue;
        if (unassigned === 0) return cid;
        if (unassigned === 1) {
          if (!this.enqueue(unitLit, { kind: 'clause', id: cid })) return cid;
        }
      }
    }
    return null;
  }

  rollback(mark) {
    while (this.trail.length > mark) {
      const rec = this.trail.pop();
      this.assign.delete(Math.abs(rec.lit));
    }
    this.queue = [];
  }

  /** 在新决策层反设 assumps 并传播；用完必须 release(mark)。 */
  assume(assumps) {
    this.ensureBase();
    const mark = this.trail.length;
    if (this.level0Conflict) {
      return { status: 'conflict', conflictId: this.level0Conflict, mark };
    }
    for (const lit of assumps) {
      if (!this.enqueue(lit, { kind: 'assump' })) {
        // 与 0 级闭包（或同层先前反设）互补：用既有赋值的原因子句作为冲突点。
        const prev = this.assign.get(Math.abs(lit));
        const cid = prev?.reason?.kind === 'clause' ? prev.reason.id : null;
        return { status: 'conflict', conflictId: cid, mark };
      }
    }
    const cid = this.drain();
    if (cid) return { status: 'conflict', conflictId: cid, mark };
    return { status: 'open', conflictId: null, mark };
  }

  /** 从冲突子句沿单位原因反向收集冲突链（须在回滚前调用）。 */
  buildChain(conflictId) {
    const chain = [];
    const seen = new Set();
    const queue = [];
    const push = (id, role) => {
      if (id == null || seen.has(id)) return;
      seen.add(id);
      const c = this.set.clauses.get(id);
      if (!c) return;
      chain.push({ id, lits: [...c.lits], role });
      queue.push(c);
    };
    push(conflictId, 'conflict');
    while (queue.length > 0) {
      const c = queue.shift();
      for (const lit of c.lits) {
        const a = this.assign.get(Math.abs(lit));
        if (a && a.reason.kind === 'clause' && a.reason.id !== c.id) {
          push(a.reason.id, 'propagation');
        }
      }
    }
    // 仅保留与本次冲突链相关的传播：每个链子句实际传播出的文字。
    const propagations = [];
    for (const c of chain) {
      if (c.role === 'conflict') continue;
      const propagated = c.lits.find((lit) => {
        const a = this.assign.get(Math.abs(lit));
        return a?.reason?.kind === 'clause' && a.reason.id === c.id;
      });
      if (propagated != null) propagations.push({ lit: propagated, by: c.id });
    }
    return {
      chain,
      assumptions: this.trail
        .filter((t) => t.reason.kind === 'assump')
        .map((t) => t.lit),
      propagations,
    };
  }

  /** 传播停止时的状态摘要（不做全量轨迹拷贝，保持长回放线性）。 */
  stalled(nvars, mark) {
    const decided = this.assign.size;
    const last = [];
    for (let i = this.trail.length - 1; i >= mark && last.length < 8; i--) {
      const t = this.trail[i];
      if (t.reason.kind === 'clause') {
        last.push({ lit: t.lit, by: t.reason.id });
      }
    }
    last.reverse();
    return {
      decidedVars: decided,
      levelTrail: this.trail.length - mark,
      unassignedVars: nvars != null ? Math.max(0, nvars - decided) : null,
      lastPropagations: last,
    };
  }
}

/** RUP：反设 lits 全部为假，活动集单位传播必须导出冲突。 */
function checkRUP(prop, nvars, lits) {
  const assumps = lits.map((l) => -l);
  const up = prop.assume(assumps);
  if (up.status === 'conflict') {
    const detail = prop.buildChain(up.conflictId);
    prop.rollback(up.mark);
    return { holds: true, ...detail };
  }
  const stalled = prop.stalled(nvars, up.mark);
  prop.rollback(up.mark);
  return { holds: false, stalled };
}

/**
 * RAT：以 pivot 为枢轴，活动集中每个含 ¬pivot 的子句都须与新子句
 * 消解出重言式，或其消解式在活动集上满足 RUP。
 */
function checkRAT(prop, nvars, lits, pivot) {
  const opposite = prop.set.occ.get(-pivot);
  const checks = [];
  let count = 0;
  if (opposite) {
    for (const cid of [...opposite]) {
      const c = prop.set.clauses.get(cid);
      if (!c) continue;
      count++;
      const resolvent = dedup([
        ...c.lits.filter((l) => l !== -pivot),
        ...lits.filter((l) => l !== pivot),
      ]);
      if (isTautology(resolvent)) {
        checks.push({ id: cid, lits: [...c.lits], resolvent, tautology: true });
        continue;
      }
      const rup = checkRUP(prop, nvars, resolvent);
      if (!rup.holds) {
        return {
          holds: false,
          pivot,
          oppositeCount: count,
          checks,
          failingOpposite: {
            id: cid,
            lits: [...c.lits],
            resolvent,
            stalled: rup.stalled,
          },
        };
      }
      checks.push({
        id: cid,
        lits: [...c.lits],
        resolvent,
        tautology: false,
        chain: rup.chain,
        assumptions: rup.assumptions,
        propagations: rup.propagations,
      });
    }
  }
  return { holds: true, pivot, oppositeCount: count, checks };
}

function activeSummary(set) {
  return set.activeList().map((c) => ({ id: c.id, lits: [...c.lits] }));
}

/**
 * 顺序回放整条证明。遇到第一个失败步骤即停止。
 * 返回结构同时服务 HTTP API 与页面渲染。
 */
export async function reviewProof(cnf, drat, hooks = {}) {
  const set = new ClauseSet();
  cnf.clauses.forEach((cl, i) => set.addClause(cl.lits, 'cnf', i + 1));
  const prop = new Propagator(set);
  const nvars = cnf.header?.nvars ?? null;

  const steps = [];
  const totalRecords = drat.records.length;

  // 长回放保活：每完成一步回调一次，调用方可让出事件循环并汇报进度。
  const onStep = hooks.onStep ?? null;
  const yieldEvery = Number.isFinite(hooks.yieldEvery) ? hooks.yieldEvery : 0;
  let processed = 0;
  const tick = async () => {
    processed++;
    if (onStep && (yieldEvery <= 0 || processed % yieldEvery === 0)) {
      await onStep({ processed, total: totalRecords });
    }
  };

  const fail = (index, record, code, message, detail = {}) => ({
    verdict: 'FAILED_STEP',
    failedStep: index,
    code,
    message,
    steps,
    activeAtFailure: activeSummary(set),
    failedRecord: {
      index,
      line: record.line,
      del: record.del,
      lits: [...record.lits],
    },
    ...detail,
  });

  for (const record of drat.records) {
    await tick();
    const index = record.index;
    const isLast = index === totalRecords;

    if (record.del) {
      const hit = set.findByLits(record.lits);
      if (!hit) {
        const ghosts = set.findDeletedByLits(record.lits).map((c) => c.id);
        return fail(
          index,
          record,
          'DELETION_NO_TARGET',
          ghosts.length
            ? `删除目标在活动集中不存在：该子句此前已被删除（${ghosts.join('、')}），删除必须指向当前活动子句`
            : '删除目标在活动集中不存在（无目标删除）：没有任何活动子句与其文字完全一致',
          { previouslyDeleted: ghosts }
        );
      }
      const removed = set.deleteClause(hit.id);
      prop.invalidate(); // 删除立即影响后续依据
      steps.push({
        index,
        line: record.line,
        rule: 'DELETE',
        target: [...record.lits],
        removedId: removed.id,
        activeCountAfter: set.clauses.size,
      });
      continue;
    }

    // 添加记录
    if (record.lits.length === 0) {
      if (!isLast) {
        return fail(
          index,
          record,
          'EMPTY_CLAUSE_NOT_FINAL',
          `空子句（最终矛盾）只能作为最后一条记录出现，第 ${index} 条之后仍有 ${totalRecords - index} 条记录`
        );
      }
      const rup = checkRUP(prop, nvars, []);
      if (!rup.holds) {
        return fail(
          index,
          record,
          'EMPTY_CLAUSE_UNJUSTIFIED',
          '空子句不满足 RUP：当前活动集经单位传播不能直接导出矛盾，且空子句无枢轴无法走 RAT',
          { stalled: rup.stalled }
        );
      }
      set.addClause([], 'add', index);
      steps.push({
        index,
        line: record.line,
        rule: 'RUP',
        addedId: `A${index}`,
        lits: [],
        chain: rup.chain,
        assumptions: [],
        propagations: rup.propagations,
        activeCountAfter: set.clauses.size,
      });
      continue;
    }

    const rup = checkRUP(prop, nvars, record.lits);
    if (rup.holds) {
      const added = set.addClause(record.lits, 'add', index);
      if (record.lits.length === 1) prop.noteUnitAdded(record.lits[0], added.id);
      steps.push({
        index,
        line: record.line,
        rule: 'RUP',
        addedId: added.id,
        lits: [...record.lits],
        chain: rup.chain,
        assumptions: rup.assumptions,
        propagations: rup.propagations,
        activeCountAfter: set.clauses.size,
      });
      continue;
    }

    const pivot = record.lits[0];
    const rat = checkRAT(prop, nvars, record.lits, pivot);
    if (!rat.holds) {
      return fail(
        index,
        record,
        'ADD_UNJUSTIFIED',
        `添加子句既不满足 RUP（单位传播未达冲突），也不满足以首文字 ${pivot} 为枢轴的 RAT（存在反向文字子句消解失败）`,
        {
          rupStalled: rup.stalled,
          ratFailure: rat.failingOpposite,
          pivot,
        }
      );
    }

    const added = set.addClause(record.lits, 'add', index);
    if (record.lits.length === 1) prop.noteUnitAdded(record.lits[0], added.id);
    steps.push({
      index,
      line: record.line,
      rule: 'RAT',
      addedId: added.id,
      lits: [...record.lits],
      pivot,
      oppositeCount: rat.oppositeCount,
      ratChecks: rat.checks,
      activeCountAfter: set.clauses.size,
    });
  }

  const empty = set.emptyClause();
  if (!empty) {
    return {
      verdict: 'INCOMPLETE',
      message:
        '全部记录回放完毕且各步均成立，但活动子句集中没有空子句：不能裁决不可满足，证明缺少最终矛盾',
      steps,
      finalActive: activeSummary(set),
    };
  }

  return {
    verdict: 'UNSAT',
    message: '不可满足：最后一条添加的空子句已在当前活动集上经 RUP 导出矛盾',
    steps,
    emptyClauseId: empty.id,
    finalActive: activeSummary(set),
  };
}
